//! Bounded transport messages and private endpoint identity persistence.

pub mod i18n;

#[cfg(unix)]
mod unix_private;
#[cfg(windows)]
mod windows_private;

use anyhow::{bail, Context as _, Result};
use iroh::SecretKey;
use serde::{Deserialize, Serialize};
#[cfg(not(unix))]
use std::io::{ErrorKind, Write as _};
use std::path::Path;
#[cfg(not(unix))]
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _};

pub const ALPN: &[u8] = b"dsh-mobile-iroh/0";
pub const MAX_LINE: usize = 64 * 1024;
pub const MAX_UNPAIRED_LINE: usize = 512;
pub const WIRE_VERSION: u8 = 1;
pub const PAIR_NO_WINDOW: &str = "no-window";
pub const PAIR_EXPIRED: &str = "expired";
pub const PAIR_TOO_MANY_ATTEMPTS: &str = "too-many-attempts";
pub const PAIR_BAD_CODE: &str = "bad-code";

/// QUIC authenticates peers and prevents network replay; this protocol only
/// establishes authorization and discriminates raw proxy streams.
#[derive(Debug, PartialEq, Eq)]
pub enum Wire {
    Hello { name: String },
    Pair { code: String, name: String },
    Proxy,
    PairOk,
    HelloOk,
    PairFail { reason: String },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Message {
    version: u8,
    #[serde(rename = "type")]
    kind: String,
    #[serde(
        default,
        deserialize_with = "present_text",
        skip_serializing_if = "Option::is_none"
    )]
    name: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_text",
        skip_serializing_if = "Option::is_none"
    )]
    code: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_text",
        skip_serializing_if = "Option::is_none"
    )]
    reason: Option<String>,
}

fn present_text<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

/// Validate names before storing or displaying them.
pub fn validate_device_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name != name.trim()
        || name.chars().count() > 64
        || name.chars().any(char::is_control)
    {
        bail!("device name requires 1..64 trimmed characters without controls");
    }
    Ok(())
}

/// Encode through the same validation used by the receiver.
pub fn encode_wire(message: &Wire) -> Result<String> {
    let (kind, name, code, reason) = match message {
        Wire::Hello { name } => ("hello", Some(name.clone()), None, None),
        Wire::Pair { code, name } => ("pair", Some(name.clone()), Some(code.clone()), None),
        Wire::Proxy => ("proxy", None, None, None),
        Wire::PairOk => ("pair-ok", None, None, None),
        Wire::HelloOk => ("hello-ok", None, None, None),
        Wire::PairFail { reason } => ("pair-fail", None, None, Some(reason.clone())),
    };
    let line = serde_json::to_string(&Message {
        version: WIRE_VERSION,
        kind: kind.into(),
        name,
        code,
        reason,
    })?;
    decode_wire(&line)?;
    Ok(line)
}

/// Reject unknown versions, duplicate/unknown fields and invalid values.
pub fn decode_wire(line: &str) -> Result<Wire> {
    if line.len() > MAX_LINE {
        bail!("wire message exceeds byte limit");
    }
    let m: Message = serde_json::from_str(line).context("invalid wire message")?;
    if m.version != WIRE_VERSION {
        bail!("unsupported wire version");
    }
    match (m.kind.as_str(), m.name, m.code, m.reason) {
        ("hello", Some(name), None, None) => {
            validate_device_name(&name)?;
            Ok(Wire::Hello { name })
        }
        ("pair", Some(name), Some(code), None) => {
            validate_device_name(&name)?;
            if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
                bail!("pairing code requires six ASCII digits");
            }
            Ok(Wire::Pair { code, name })
        }
        ("proxy", None, None, None) => Ok(Wire::Proxy),
        ("pair-ok", None, None, None) => Ok(Wire::PairOk),
        ("hello-ok", None, None, None) => Ok(Wire::HelloOk),
        ("pair-fail", None, None, Some(reason))
            if [
                PAIR_NO_WINDOW,
                PAIR_EXPIRED,
                PAIR_TOO_MANY_ATTEMPTS,
                PAIR_BAD_CODE,
            ]
            .contains(&reason.as_str()) =>
        {
            Ok(Wire::PairFail { reason })
        }
        _ => bail!("unsupported wire fields or message kind"),
    }
}

/// Render only the finite pairing failure codes.
pub fn pair_fail_text(code: &str) -> String {
    match code {
        PAIR_NO_WINDOW => i18n::t("主机未开启配对窗口", "the host has no pairing window open"),
        PAIR_EXPIRED => i18n::t("配对窗口已过期", "the pairing window has expired"),
        PAIR_TOO_MANY_ATTEMPTS => i18n::t("配对尝试次数超限", "too many pairing attempts"),
        PAIR_BAD_CODE => i18n::t("配对码不正确", "the pairing code is incorrect"),
        _ => i18n::t("配对失败", "pairing failed"),
    }
    .to_string()
}

#[cfg(windows)]
fn restrict(path: &Path, mode: u32) -> Result<()> {
    if mode == 0o700 {
        windows_private::ensure_directory(path)?;
    } else {
        windows_private::verify_file(path)?;
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn restrict(_path: &Path, _mode: u32) -> Result<()> {
    bail!("private storage is unsupported on this platform")
}

#[cfg(windows)]
fn private_dir(dir: &Path) -> Result<()> {
    windows_private::ensure_directory(dir).context("private Windows data directory is not secure")
}

#[cfg(unix)]
fn private_dir(dir: &Path) -> Result<()> {
    unix_private::ensure_directory(dir).context("private POSIX directory owner/mode is unsafe")
}
#[cfg(not(any(unix, windows)))]
fn private_dir(_dir: &Path) -> Result<()> {
    bail!("private storage is unsupported on this platform")
}

/// Create a new private profile directory, or verify an existing one without
/// resetting its Windows ACL. Writable ancestors and reparse points fail closed.
pub fn create_private_directory(dir: &Path) -> Result<()> {
    private_dir(dir)
}

/// Read bounded private state. On Windows, DACL/owner and ancestor checks occur
/// before bytes are read through the same non-reparse file handle.
pub fn read_private_file(path: &Path, maximum: usize) -> std::io::Result<Vec<u8>> {
    #[cfg(windows)]
    {
        windows_private::read_file(path, maximum)
    }
    #[cfg(unix)]
    {
        unix_private::read_file(path, maximum)
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "unsupported private storage platform",
        ))
    }
}

/// Open a verified nontruncating profile lock. Windows denies delete sharing
/// so its pathname cannot be removed or renamed while a host owns the handle.
pub fn open_private_lock_file(path: &Path) -> Result<std::fs::File> {
    private_dir(path.parent().unwrap_or_else(|| Path::new(".")))?;
    #[cfg(windows)]
    {
        Ok(windows_private::open_lock_file(path)?)
    }
    #[cfg(unix)]
    {
        Ok(unix_private::open_lock_file(path)?)
    }
    #[cfg(not(any(unix, windows)))]
    {
        bail!("unsupported private storage platform")
    }
}

#[cfg(windows)]
fn open_private_new(path: &Path) -> std::io::Result<std::fs::File> {
    windows_private::create_file(path)
}

#[cfg(not(any(windows, unix)))]
fn open_private_new(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Replace private state using an exclusive same-directory temporary file.
/// Unix permissions and Windows protected DACLs are supplied at creation.
#[cfg(not(unix))]
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    private_dir(dir)?;
    #[cfg(windows)]
    match windows_private::verify_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("existing Windows private state is not secure"),
    }
    let temp = dir.join(format!(
        ".iroh-{}-{}.tmp",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    replace_private_with_temp(path, bytes, &temp)
}

#[cfg(not(unix))]
fn replace_private_with_temp(path: &Path, bytes: &[u8], temp: &Path) -> Result<()> {
    let mut owned_temp = false;
    let result = (|| -> Result<()> {
        let mut file = open_private_new(temp).context("cannot create private temporary file")?;
        owned_temp = true;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(temp, path).context("cannot replace private state")?;
        restrict(path, 0o600)?;
        #[cfg(unix)]
        std::fs::File::open(path.parent().unwrap_or_else(|| Path::new(".")))?.sync_all()?;
        Ok(())
    })();
    if result.is_err() && owned_temp {
        let _ = std::fs::remove_file(temp);
    }
    result
}

/// Create an identity only for an absent file. Read, permission and corruption
/// errors preserve the existing file and fail explicitly.
#[cfg(not(unix))]
pub fn load_or_create_secret(path: &Path) -> Result<SecretKey> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != 32 =>
        {
            bail!("identity key must be a regular 32-byte file, not a symbolic link");
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("cannot inspect identity key"),
    }
    match read_private_file(path, 32) {
        Ok(bytes) => {
            let arr: [u8; 32] = bytes
                .try_into()
                .map_err(|_| anyhow::anyhow!("identity key must contain exactly 32 bytes"))?;
            if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
                bail!("identity key must not be a symbolic link");
            }
            restrict(path, 0o600)?;
            Ok(SecretKey::from_bytes(&arr))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            private_dir(path.parent().unwrap_or_else(|| Path::new(".")))?;
            let key = SecretKey::generate();
            match open_private_new(path) {
                Ok(mut file) => {
                    file.write_all(&key.to_bytes())?;
                    file.sync_all()?;
                    Ok(key)
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    load_or_create_secret(path)
                }
                Err(error) => Err(error).context("cannot create identity key"),
            }
        }
        Err(error) => Err(error).context("cannot read identity key"),
    }
}

/// Write private state relative to a verified POSIX parent descriptor.
#[cfg(unix)]
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    unix_private::write_file(path, bytes).context("cannot atomically write private POSIX state")
}

#[cfg(all(unix, test))]
fn replace_private_with_temp(path: &Path, bytes: &[u8], temp: &Path) -> Result<()> {
    if path.parent() != temp.parent() {
        bail!("private temporary must share its target parent");
    }
    unix_private::replace_with_name(
        path,
        bytes,
        temp.file_name().context("temporary requires basename")?,
    )
    .context("cannot replace private POSIX state")
}

/// Load only a verified private POSIX identity, creating one only when absent.
#[cfg(unix)]
pub fn load_or_create_secret(path: &Path) -> Result<SecretKey> {
    unix_private::load_secret(path).context("cannot load private POSIX identity")
}

/// Read one newline-terminated UTF-8 message without buffering past its bound
/// or consuming following proxy bytes. The caller supplies its deadline.
pub async fn read_line_bounded<R: AsyncRead + Unpin>(
    recv: &mut R,
    maximum: usize,
) -> Result<String> {
    let mut bytes = Vec::with_capacity(maximum.min(1024));
    let mut byte = [0u8; 1];
    loop {
        if recv.read(&mut byte).await? == 0 {
            bail!("control stream closed before newline");
        }
        if byte[0] == b'\n' {
            return String::from_utf8(bytes).context("control message is not UTF-8");
        }
        if bytes.len() == maximum {
            bail!("control message exceeds byte limit");
        }
        bytes.push(byte[0]);
    }
}

/// Write one bounded line without accepting embedded line delimiters.
pub async fn write_line<W: AsyncWrite + Unpin>(send: &mut W, line: &str) -> Result<()> {
    if line.len() > MAX_LINE || line.contains(['\r', '\n']) {
        bail!("invalid outgoing control line");
    }
    send.write_all(line.as_bytes()).await?;
    send.write_all(b"\n").await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_directory(label: &str) -> std::path::PathBuf {
        #[cfg(windows)]
        let parent = std::path::PathBuf::from(std::env::var_os("USERPROFILE").unwrap());
        #[cfg(not(windows))]
        let parent = std::env::temp_dir();
        let dir = parent.join(format!(".iroh-core-test-{}-{label}", std::process::id()));
        create_private_directory(&dir).unwrap();
        dir
    }
    #[test]
    fn all_messages_round_trip() {
        for m in [
            Wire::Hello {
                name: "手机".into(),
            },
            Wire::Pair {
                code: "123456".into(),
                name: "phone".into(),
            },
            Wire::Proxy,
            Wire::PairOk,
            Wire::HelloOk,
            Wire::PairFail {
                reason: PAIR_BAD_CODE.into(),
            },
        ] {
            assert_eq!(decode_wire(&encode_wire(&m).unwrap()).unwrap(), m);
        }
    }
    #[test]
    fn unsafe_messages_fail_closed() {
        for line in [
            r#"{"type":"hello","name":"phone"}"#,
            r#"{"version":2,"type":"hello","name":"phone"}"#,
            r#"{"version":1,"type":"hello","name":"phone","unknown":1}"#,
            r#"{"version":1,"version":1,"type":"proxy"}"#,
            r#"{"version":1,"type":"proxy","name":"phone"}"#,
            r#"{"version":1,"type":"hello","name":" phone "}"#,
            r#"{"version":1,"type":"hello","name":"a\nb"}"#,
            r#"{"version":1,"type":"pair","name":"phone","code":"１２３４５６"}"#,
            r#"{"version":1,"type":"pair-fail","reason":"anything"}"#,
            r#"{"version":1,"type":"decision","id":"x","outcome":"allowed-once"}"#,
        ] {
            assert!(decode_wire(line).is_err(), "accepted {line}");
        }
        assert!(encode_wire(&Wire::Hello {
            name: "a".repeat(65)
        })
        .is_err());
        assert!(decode_wire(&" ".repeat(MAX_LINE + 1)).is_err());
        assert!(decode_wire(r#"{"version":1,"type":"hello-ok","name":null}"#).is_err());
    }
    #[test]
    fn corrupt_identity_is_not_replaced() {
        let dir = test_directory("corrupt");
        let path = dir.join("identity.key");
        std::fs::write(&path, b"broken").unwrap();
        assert!(load_or_create_secret(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"broken");
        assert!(load_or_create_secret(&dir).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn private_state_and_identity_survive_reloads() {
        let dir = test_directory("stable");
        let path = dir.join("identity.key");
        let first = load_or_create_secret(&path).unwrap();
        assert_eq!(
            load_or_create_secret(&path).unwrap().to_bytes(),
            first.to_bytes()
        );
        let state = dir.join("paired.json");
        write_private(&state, b"old").unwrap();
        write_private(&state, b"new").unwrap();
        assert_eq!(std::fs::read(&state).unwrap(), b"new");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&state).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn colliding_temporary_file_is_neither_truncated_nor_deleted() {
        let dir = test_directory("collision");
        let target = dir.join("paired.json");
        let temp = dir.join("collision.tmp");
        write_private(&target, b"old").unwrap();
        write_private(&temp, b"owned-by-another-writer").unwrap();
        assert!(replace_private_with_temp(&target, b"new", &temp).is_err());
        assert_eq!(read_private_file(&target, 64).unwrap(), b"old");
        assert_eq!(
            read_private_file(&temp, 64).unwrap(),
            b"owned-by-another-writer"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn dangling_identity_symlink_is_rejected_without_recreation() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!("iroh-key-link-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("identity.key");
        let missing = dir.join("missing");
        symlink(&missing, &path).unwrap();
        assert!(load_or_create_secret(&path).is_err());
        assert!(!missing.exists());
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
