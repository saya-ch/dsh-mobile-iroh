//! 审批遥控线协议与连接基元:host(电脑侧 sidecar)、手机 App、phone-sim 共用。
//! 协议:一连接一条控制 bi 流,JSON-lines;首行 Hello(已配对)或 Pair(配对)。

pub mod i18n;
use i18n::t;

use std::io::Write as _;
use std::path::Path;

use anyhow::{bail, Context as _, Result};
use iroh::endpoint::{RecvStream, SendStream};
use iroh::SecretKey;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt as _};

pub const ALPN: &[u8] = b"dsh-mobile-iroh/0";
/// 控制流单行上限;审批 reason 是模型生成的自然语言,给足余量
pub const MAX_LINE: usize = 64 * 1024;
/// 未配对连接首行上限:只够一条 pair 消息,不给未授权方喂大负载的机会
pub const MAX_UNPAIRED_LINE: usize = 512;
pub const WIRE_VERSION: u8 = 1;

/// 线协议(iroh 控制流,双向)
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Wire {
    // 手机 → host(连接首条控制流的首行,二选一)
    Hello {
        name: String,
    },
    Pair {
        code: String,
        name: String,
    },
    // 手机 → host(后续代理流的首行;此行之后整条流是原始 TCP 字节)
    Proxy,
    // host → 手机(配对应答)
    PairOk,
    /// reason 是下面那几个原因码,不是人话:这句要显示在手机上,得由手机按自己的语言渲染
    PairFail {
        reason: String,
    },
    // host → 手机
    Approval {
        id: String,
        tool_name: String,
        reason: String,
    },
    ApprovalCancel {
        id: String,
    },
    // 手机 → host
    Decision {
        id: String,
        outcome: String,
    },
}

/// Encode one versioned control message for an authenticated iroh stream.
pub fn encode_wire(message: &Wire) -> Result<String> {
    let mut value = serde_json::to_value(message)?;
    let object = value
        .as_object_mut()
        .context("wire message must serialize as an object")?;
    object.insert("version".into(), Value::from(WIRE_VERSION));
    Ok(serde_json::to_string(&value)?)
}

/// Decode one versioned control message and reject an unknown wire version.
pub fn decode_wire(line: &str) -> Result<Wire> {
    let mut value: Value = serde_json::from_str(line).context("wire message is not valid JSON")?;
    let object = value
        .as_object_mut()
        .context("wire message must be an object")?;
    let version = object
        .remove("version")
        .and_then(|value| value.as_u64())
        .context("wire message has no version")?;
    if version != u64::from(WIRE_VERSION) {
        bail!("unsupported wire version {version}");
    }
    Ok(serde_json::from_value(value).context("wire message has an unsupported format")?)
}

/// 配对失败的原因码。线上只传码,两侧各自渲染。
pub const PAIR_NO_WINDOW: &str = "no-window";
pub const PAIR_EXPIRED: &str = "expired";
pub const PAIR_TOO_MANY_ATTEMPTS: &str = "too-many-attempts";
pub const PAIR_BAD_CODE: &str = "bad-code";

/// 原因码译成当前语言的人话。认不出的码原样带出:0.1.16 及更早的 host 发的就是中文句子,
/// 那种情况下把它原样显示出来,总好过吞掉或者显示一个码。
pub fn pair_fail_text(code: &str) -> String {
    match code {
        PAIR_NO_WINDOW => t(
            "主机上没有开着的配对窗口",
            "the computer has no pairing window open",
        )
        .to_string(),
        PAIR_EXPIRED => t("配对窗口已过期", "the pairing window has expired").to_string(),
        PAIR_TOO_MANY_ATTEMPTS => t(
            "配对码试错次数超限,窗口已关",
            "too many wrong codes; the window is closed",
        )
        .to_string(),
        PAIR_BAD_CODE => t("配对码不正确", "that pairing code is wrong").to_string(),
        other => other.to_string(),
    }
}

/// 把既有文件/目录的权限收到仅属主可读写(目录再加可进入)。
/// Windows 没有 POSIX 权限位,是空操作。
#[cfg(unix)]
fn restrict(path: &Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(mode);
    std::fs::set_permissions(path, perms).with_context(|| {
        format!(
            "{}{}",
            t("收紧权限失败: ", "cannot tighten the permissions of "),
            path.display()
        )
    })
}
#[cfg(not(unix))]
fn restrict(_path: &Path, _mode: u32) -> Result<()> {
    Ok(())
}

/// 建一个仅属主可进入的目录。
fn create_private_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| {
        format!(
            "{}{}",
            t("创建目录失败: ", "cannot create the directory "),
            dir.display()
        )
    })?;
    restrict(dir, 0o700)
}

/// 原子地写一个只有属主读得到的文件。
///
/// 两件事必须同时成立:
///
/// 一、权限。std::fs::write 按 0o666 & ~umask 建文件,通常落到 0o644,同机器上
/// 任何用户都读得到。而这里写的恰好是长期凭证——身份私钥、配对白名单——
/// 读到即可冒充,不需要能执行代码。
///
/// 二、原子性。就地截断再写,写到一半掉电或被杀就留下一个半截文件;对
/// identity.key 而言那等于主机身份丢失,所有已配对的手机都要重新配对。
/// 故先写同目录的临时文件再 rename——同一文件系统上 rename 是原子的,
/// 目标要么是旧内容要么是新内容,不会是半截。
///
/// OpenOptions 的 mode() 只在「新建」时生效。临时文件总是新建,拿得到 0o600;
/// 但 rename 之后仍显式 restrict 一次,好把老版本留下的宽权限一并收紧。
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    create_private_dir(dir)?;

    // 临时文件必须与目标同目录:跨文件系统 rename 不是原子操作,还可能直接失败。
    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("write")
    ));

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(&tmp)
        .with_context(|| format!("{}{}", t("写入失败: ", "cannot write "), tmp.display()))?;
    let written = file
        .write_all(bytes)
        // 落盘后再 rename,否则崩溃时可能 rename 了一个内容还没落地的文件
        .and_then(|()| file.sync_all());
    drop(file);
    if let Err(e) = written {
        std::fs::remove_file(&tmp).ok();
        return Err(e)
            .with_context(|| format!("{}{}", t("写入失败: ", "cannot write "), tmp.display()));
    }

    if let Err(e) = std::fs::rename(&tmp, path) {
        std::fs::remove_file(&tmp).ok();
        return Err(e)
            .with_context(|| format!("{}{}", t("替换失败: ", "cannot replace "), path.display()));
    }
    restrict(path, 0o600)
}

pub fn load_or_create_secret(path: &Path) -> Result<SecretKey> {
    if let Ok(bytes) = std::fs::read(path) {
        let arr: [u8; 32] = bytes.as_slice().try_into().with_context(|| {
            format!(
                "{}{}",
                t(
                    "身份密钥文件损坏(长度不是 32 字节): ",
                    "the identity key file is damaged (not 32 bytes): "
                ),
                path.display()
            )
        })?;
        // 旧版本以 0o644 写下的密钥仍在用户磁盘上;每次加载顺手收紧,
        // 否则升级了也修不好已经泄露面的那些机器。
        restrict(path, 0o600)?;
        return Ok(SecretKey::from_bytes(&arr));
    }
    let key = SecretKey::generate();
    write_private(path, &key.to_bytes()).with_context(|| {
        format!(
            "{}{}",
            t("保存身份密钥失败: ", "cannot save the identity key to "),
            path.display()
        )
    })?;
    Ok(key)
}

/// 有界读一行:未配对方用小上限,防喂大负载
pub async fn read_line_bounded(recv: &mut RecvStream, max: usize) -> Result<String> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let Some(n) = recv.read(&mut byte).await? else {
            bail!(
                "{}",
                t(
                    "对端在行结束前关闭了流",
                    "the other side closed the stream mid-line"
                )
            );
        };
        if n == 0 {
            continue;
        }
        if byte[0] == b'\n' {
            return Ok(String::from_utf8(buf)
                .context(t("控制流不是 UTF-8", "the control stream is not UTF-8"))?);
        }
        buf.push(byte[0]);
        if buf.len() > max {
            bail!(
                "{}{max}{}",
                t(
                    "控制流单行超限(",
                    "a control-stream line is over the limit ("
                ),
                t(" 字节)", " bytes)")
            );
        }
    }
}

pub async fn write_line(send: &mut SendStream, line: &str) -> Result<()> {
    send.write_all(line.as_bytes()).await?;
    send.write_all(b"\n").await?;
    Ok(())
}

// 权限位只在 unix 上存在;Windows 下这些断言无意义,整块不编译。
#[cfg(all(test, unix))]
mod private_file_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    fn mode_of(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    /// 每个用例一个独立目录,避免并行跑测试时互相干扰。
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-mobile-iroh-test-{}-{}",
            std::process::id(),
            name
        ));
        std::fs::remove_dir_all(&dir).ok();
        dir
    }

    #[test]
    fn 新建的私密文件与其目录只有属主可访问() {
        let dir = scratch("fresh");
        let path = dir.join("identity.key");
        write_private(&path, b"secret").unwrap();
        assert_eq!(mode_of(&path), 0o600, "文件权限应为 0600");
        assert_eq!(mode_of(&dir), 0o700, "目录权限应为 0700");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 重写会收紧旧版本留下的宽权限文件() {
        let dir = scratch("rewrite");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("paired.json");
        // 模拟旧版本 std::fs::write 的产物
        std::fs::write(&path, b"old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(mode_of(&path), 0o644, "前置条件:先是宽权限");

        write_private(&path, b"new").unwrap();
        assert_eq!(mode_of(&path), 0o600, "重写后应被收紧");
        assert_eq!(std::fs::read(&path).unwrap(), b"new", "内容应已更新");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 写入完成后不留临时文件() {
        let dir = scratch("atomic");
        let path = dir.join("identity.key");
        write_private(&path, b"one").unwrap();
        write_private(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不应残留临时文件: {leftovers:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 加载既有密钥时会顺手收紧权限() {
        let dir = scratch("load");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("identity.key");
        let key = SecretKey::generate();
        std::fs::write(&path, key.to_bytes()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        // 升级后的第一次启动:不重新生成密钥,但要把权限修好
        let loaded = load_or_create_secret(&path).unwrap();
        assert_eq!(loaded.to_bytes(), key.to_bytes(), "身份不能变");
        assert_eq!(mode_of(&path), 0o600, "既有密钥应被收紧");
        std::fs::remove_dir_all(&dir).ok();
    }
}

/// dsh 0.1.2-alpha 起浏览器界面要求认证 cookie。插件在电脑侧完成 token→cookie
/// 兑换后把材料下发到这里,代理流逐请求注入;没收到材料(旧版 dsh)则原样透传。
pub struct ProxyAuth {
    /// `name=value`,不含属性段
    pub cookie: String,
    /// dsh web 的规范 authority;cookie 签名绑定它,Host/Origin 都要改写成它
    pub authority: String,
}

/// 逐字节读完一个 HTTP/1.1 请求头(含结尾空行)。逐字节与 read_line_bounded
/// 同理:不越读,头之后的字节(请求体)原样留在流里交给后面的裸转发。
pub async fn read_request_head<R: AsyncRead + Unpin>(recv: &mut R) -> Result<String> {
    const MAX_HEAD: usize = 64 * 1024;
    let mut head = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        // tokio 语义:读到 0 字节即对端关闭
        if recv.read(&mut byte).await? == 0 {
            bail!(
                "{}",
                t(
                    "对端在请求头结束前关闭了流",
                    "the other side closed the stream before the request head ended"
                )
            );
        }
        head.push(byte[0]);
        if head.len() > MAX_HEAD {
            bail!(
                "{}{MAX_HEAD}{}",
                t("请求头超限(", "the request head is over the limit ("),
                t(" 字节)", " bytes)")
            );
        }
    }
    String::from_utf8(head).context(t("请求头不是 UTF-8", "the request head is not UTF-8"))
}

/// 改写一个请求头:Host/Origin 指到 dsh 真实 authority、注入认证 cookie、
/// 非升级请求强制 Connection: close。
///
/// close 是「逐请求注入」的实现前提:keep-alive 连接上后续请求同样要注入,
/// 那要求按 Content-Length/chunked 给请求体分帧;强制一连接一请求后,浏览器
/// 每个请求都另开连接,每条都从头经过这里,分帧逻辑整个省掉。WebSocket 升级
/// 例外:保留原 Connection/Upgrade 头,升级后整条流裸转发。
///
/// Origin 只在本来就是回环时才改写——它与 Host 的差异纯粹是代理搬家造成的;
/// 非回环的 Origin(手机浏览器里的恶意页面打手机本地端口)原样放行,让 dsh
/// 自己的跨站栅栏照旧拒绝。
pub fn rewrite_request_head(head: &str, auth: &ProxyAuth) -> String {
    let head = head.strip_suffix("\r\n\r\n").unwrap_or(head);
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let headers: Vec<&str> = lines.collect();
    let upgrade = headers.iter().any(|l| header_value(l, "upgrade").is_some());
    let mut out = String::with_capacity(head.len() + 128);
    out.push_str(request_line);
    out.push_str("\r\n");
    for line in &headers {
        if header_value(line, "host").is_some() {
            out.push_str("host: ");
            out.push_str(&auth.authority);
        } else if let Some(origin) = header_value(line, "origin") {
            out.push_str("origin: ");
            match rewrite_origin(origin, &auth.authority) {
                Some(rewritten) => out.push_str(&rewritten),
                None => out.push_str(origin),
            }
        } else if !upgrade
            && (header_value(line, "connection").is_some()
                || header_value(line, "proxy-connection").is_some())
        {
            continue;
        } else {
            out.push_str(line);
        }
        out.push_str("\r\n");
    }
    out.push_str("cookie: ");
    out.push_str(&auth.cookie);
    out.push_str("\r\n");
    if !upgrade {
        out.push_str("connection: close\r\n");
    }
    out.push_str("\r\n");
    out
}

/// line 形如 `Name: value`;名字命中(大小写不敏感)返回去掉首尾空白的值
fn header_value<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let (key, value) = line.split_once(':')?;
    key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
}

/// `http://<回环>[:port]` → `http://<authority>`;其余不动
pub fn rewrite_origin(origin: &str, authority: &str) -> Option<String> {
    let rest = origin.strip_prefix("http://")?;
    let host = rest.split('/').next().unwrap_or(rest);
    let hostname = match host.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => host.split(':').next().unwrap_or(host),
    };
    is_loopback(hostname).then(|| format!("http://{authority}"))
}

/// 回环判据与 dsh 一致:localhost、IPv6 回环、整个 127/8
pub fn is_loopback(hostname: &str) -> bool {
    if hostname == "localhost" || hostname == "::1" {
        return true;
    }
    let parts: Vec<&str> = hostname.split('.').collect();
    parts.len() == 4
        && parts[0] == "127"
        && parts.iter().all(|p| {
            (1..=3).contains(&p.len())
                && p.bytes().all(|b| b.is_ascii_digit())
                && p.parse::<u32>().is_ok_and(|n| n <= 255)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth() -> ProxyAuth {
        ProxyAuth {
            cookie: "dsh-auth-abc=v1.xyz".into(),
            authority: "127.0.0.1:18000".into(),
        }
    }

    #[test]
    fn 普通请求改写host_注入cookie_强制close() {
        let head = "GET /api/x HTTP/1.1\r\nHost: 127.0.0.1:39411\r\nConnection: keep-alive\r\nAccept: */*\r\n\r\n";
        let out = rewrite_request_head(head, &auth());
        assert!(out.starts_with("GET /api/x HTTP/1.1\r\n"));
        assert!(out.contains("host: 127.0.0.1:18000\r\n"), "{out}");
        assert!(out.contains("cookie: dsh-auth-abc=v1.xyz\r\n"), "{out}");
        assert!(out.contains("connection: close\r\n"), "{out}");
        assert!(!out.contains("keep-alive"), "原 Connection 应被移除: {out}");
        assert!(out.contains("Accept: */*\r\n"), "无关头原样保留: {out}");
        assert!(out.ends_with("\r\n\r\n"));
        assert!(!out.contains("Host: 127.0.0.1:39411"), "{out}");
    }

    #[test]
    fn 升级请求保留connection与upgrade头_不加close() {
        let head = "GET /stream HTTP/1.1\r\nHost: 127.0.0.1:39411\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: http://127.0.0.1:39411\r\n\r\n";
        let out = rewrite_request_head(head, &auth());
        assert!(out.contains("Connection: Upgrade\r\n"), "{out}");
        assert!(out.contains("Upgrade: websocket\r\n"), "{out}");
        assert!(!out.contains("connection: close"), "{out}");
        assert!(out.contains("cookie: dsh-auth-abc=v1.xyz\r\n"), "{out}");
        assert!(out.contains("origin: http://127.0.0.1:18000\r\n"), "{out}");
    }

    #[test]
    fn 回环origin改写_非回环origin原样留给dsh栅栏拒绝() {
        assert_eq!(
            rewrite_origin("http://127.0.0.1:39411", "127.0.0.1:18000").as_deref(),
            Some("http://127.0.0.1:18000")
        );
        assert_eq!(
            rewrite_origin("http://localhost:8080", "127.0.0.1:18000").as_deref(),
            Some("http://127.0.0.1:18000")
        );
        assert_eq!(
            rewrite_origin("http://[::1]:8080", "127.0.0.1:18000").as_deref(),
            Some("http://127.0.0.1:18000")
        );
        assert_eq!(
            rewrite_origin("http://evil.example", "127.0.0.1:18000"),
            None
        );
        assert_eq!(
            rewrite_origin("https://127.0.0.1:39411", "127.0.0.1:18000"),
            None
        );
        assert_eq!(rewrite_origin("null", "127.0.0.1:18000"), None);
    }

    #[test]
    fn 回环判定的边界值() {
        assert!(is_loopback("127.0.0.1"));
        assert!(is_loopback("127.255.255.255"));
        assert!(is_loopback("localhost"));
        assert!(is_loopback("::1"));
        // 128/8 不是回环;256 越界;127.1 缩写不按四段判
        assert!(!is_loopback("128.0.0.1"));
        assert!(!is_loopback("127.0.0.256"));
        assert!(!is_loopback("127.1"));
        assert!(!is_loopback("evil.com"));
        assert!(!is_loopback(""));
    }

    #[test]
    fn 手机自带cookie头原样保留_注入的另起一行() {
        let head = "GET / HTTP/1.1\r\nHost: 127.0.0.1:39411\r\nCookie: stale=1\r\n\r\n";
        let out = rewrite_request_head(head, &auth());
        assert!(out.contains("Cookie: stale=1\r\n"), "{out}");
        assert!(out.contains("cookie: dsh-auth-abc=v1.xyz\r\n"), "{out}");
    }

    #[test]
    fn wire_messages_are_versioned_and_unknown_versions_fail() {
        let encoded = encode_wire(&Wire::Hello {
            name: "phone".into(),
        })
        .unwrap();
        assert!(encoded.contains("\"version\":1"), "{encoded}");
        assert!(matches!(decode_wire(&encoded).unwrap(), Wire::Hello { name } if name == "phone"));
        assert!(decode_wire(&encoded.replace("\"version\":1", "\"version\":2")).is_err());
        assert!(decode_wire(r#"{"version":1,"type":"unknown"}"#).is_err());
    }
}
