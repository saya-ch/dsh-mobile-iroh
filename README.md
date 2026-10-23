# DSH Mobile iroh

通过 iroh 连接电脑上的 DeepSeek Harness，沿用 DSH Mobile 的配对、设备列表和 WebView 体验。

[English](README.en.md) · [开发与测试](CONTRIBUTING.md) · [验证记录](VERIFICATION.md) · [安全说明](SECURITY.md) · [并入方案](docs/INTEGRATION_SEAM.md)

> **独立实验项目，尚未发布。** 不替换现有 DSH Mobile，不修改 DSH 核心，不自动迁移现有 App 数据。代码实现、本地传输验证、Android 构建、真机和公网网络验收是不同阶段。

## 这是什么

iroh 提供端到端加密的 QUIC 连接，尝试直连，并可使用 relay。这里保留 DSH Mobile 的 HTTPS 网关：手机的 TLS 字节经 iroh 原样送到电脑，身份认证、Session Cookie、CSRF 和 WebSocket 路径控制仍由网关负责。它不是另一套 DSH 会话或 Agent 实现。

```text
Android / WebView
    │ HTTPS / WSS，证书绑定电脑身份
手机本机传输桥
    │ iroh QUIC：配对端点、原始字节
电脑 sidecar
    │ 仅指定回环目标
DSH Mobile HTTPS Gateway → DSH Web
```

本机网页地址由完整 EndpointId 派生，例如 `https://<前32位>.<后32位>.iroh.localhost:25443`。完整身份用于隔离电脑的 Cookie 和网页存储，不用短哈希端口猜测设备身份。端口被占用时明确失败，不随机换 Origin。

## 已有实现

| 部分 | 当前内容 |
| --- | --- |
| 电脑传输 | 第一方 Rust sidecar；一次性配对、持久身份、设备列表、撤销、同设备重连和受控原始 TCP/TLS 转发；原生私有状态保存启用偏好，显式恢复保留关闭选择 |
| 协议与资源 | 版本与字段校验、长度／连接／流配额、截止时间、父进程与控制流退出后的回收 |
| 主机私有状态 | Unix 私有权限；Windows 创建时私有 DACL、旧状态核验、reparse 拒绝及不可删除的活动 profile 锁 |
| 网关接线 | 使用 DSH Mobile 公开导出的网关，不注入 DSH launch Cookie，不改写上游前端包；可显式接入独立扩展服务 |
| 证书 | 原生私有状态保存 CA，为完整 EndpointId 签发证书；叶证书可自动续期，通过公开接口刷新，不重启网关 |
| 电脑管理 | 本机浏览器管理页：配置、启动／停止／重连、二维码、传输设备及证书状态；单次登录入口、会话与 CSRF 校验 |
| Android | 独立包名、JNI、可取消连接、配对／命名／保存／恢复、设备列表、原始 TLS 与严格 CONNECT 桥；真机验收另列 |
| 本地验收 | 真实 QUIC、HTTP、WSS、TLS 正反例、Java HTTPS、Chromium Origin 与设备撤销 |

具体执行记录和未覆盖范围见 [VERIFICATION](VERIFICATION.md)。本地直连通过不代表公网 NAT、公共 relay、手机睡眠切网或正式签名已经验收。

已在 Android 16 真机的移动网络上完成首次配对、真实 DSH 页面加载、保存设备后的重连、取消与在线撤销检查；仍在完善失败恢复，尚未发布正式 App，也未并入 DSH Mobile。

## 开发运行

需要 Node.js、Rust，以及构建 Android 时的 JDK 17、Android SDK 36 和明确选择的 NDK。不要将身份私钥放在共享目录；Windows 默认状态目录为用户主目录下的 `.dsh-mobile-iroh`，开发仓库仍可放在 `C:/develop`。

```powershell
npm test
npm run check:docs
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build --locked -p dsh-mobile-iroh-host -p dsh-mobile-iroh-transport-sim
npm run smoke:iroh
```

`smoke:iroh` 使用本仓编译的 sidecar 和显式回环地址，不依赖公共发现服务。它检查首次配对、持久重连、HTTP 字节、多个 Cookie、WebSocket、未知设备和撤销，并清理自己的资料目录。

完整 HTTPS 网关验收还需要一个隔离安装的公开 DSH Mobile 模块、Playwright Chromium 和 JDK。设置 `DSH_MOBILE_MODULE` 为该模块的绝对 `lib/index.mjs` 路径，再运行：

```powershell
npm run smoke:gateway
```

这会执行实际 Android 传输 crate 的主机测试驱动，不是 Android 真机。安装与参数见 [CONTRIBUTING](CONTRIBUTING.md)。

完整前端验收使用 `npm run smoke:dsh-frontend`，还需将 `DSH_IROH_DSH_BIN` 设为隔离安装的 DSH CLI 入口绝对路径。它加载真实 DSH 页面，检查模型选择、模块规则、扩展认证、日志 ZIP 和传输重启后的会话／草稿保持，不发送模型请求。[运行范围](CONTRIBUTING.md#full-dsh-frontend)

## 电脑管理页

编译 sidecar 后，使用显式指定的公开 Mobile 模块运行：

```powershell
npm run operator -- --mobile-module C:/path/to/runtime/node_modules/dsh-mobile/lib/index.mjs --executable C:/path/to/dsh-mobile-iroh-host.exe
```

管理页只监听本机 `127.0.0.1`，不会成为公网管理入口。填入当前 DSH 的回环授权地址后，点击启动并生成二维码；完整授权地址只保存在当前进程内存中，重新启动管理进程后需重新提供。自定义端口、回环 Origin 和仅本机测试选项单独持久保存。不要将带登录片段的管理页地址或配对二维码贴进 issue。

默认资料目录是用户主目录下的 `.dsh-mobile-iroh`，可用 `--data-dir` 指定独立私有目录。`--no-open` 仅在交互终端输出一次性登录地址；Ctrl-C 关闭本管理进程及其拥有的连接，不删除配对。关闭浏览器标签页不会停止手机连接。[操作与安全细节](operator/README.md)

扩展需通过明确的 provider 或 `--extensions-dir` 指定的本地目录接入；不会自动复制普通 DSH profile 中已安装的扩展。依赖 DSH 进程内服务的扩展仍需显式适配，不承诺所有第三方插件自动兼容。

## Android App

独立包名是 `io.github.sayach.dshmobileiroh`，不会覆盖 `io.github.sayach.dshmobile`。使用 `-PirohNative=true` 构建包含原生传输的版本；未启用时保留原 HTTPS 基线，不假装含有 iroh。当前原生包仅含 arm64-v8a、x86_64，不是主 App 的全设备替换包。

[Android 构建、ABI 与验收说明](apps/mobile/README.md)

嵌入式 operator API 可在新实例中调用 `restore()` 按上次选择恢复；它不同于显式开启的 `start()`。停止会保存关闭选择，卸载只关闭资源，不删除身份或配对；管理页不会在缺少当前授权地址时自动启动。[接线说明](CONTRIBUTING.md#host-startup-preferences)

## 边界

- 没有向 npm、APK 或 GitHub Release 发布本项目；不要将本地 Debug 包当正式版本。
- 不修改 DSH Core、DSH Mobile 主仓或用户正在使用的 profile。
- 不通过正则改写 DSH 前端包，不把所有第三方插件兼容性交给传输层。
- 公网发现、relay 和真实移动网络仍需独立验收；网络阻断必须报告，不能用回环通过替代。
- 主仓当前 provider 是封闭集合。未来并入需要审查明确的 provider 与 Android 接线，不是现在就修改主仓。

## 致谢与许可

Rust 基线参考 [zexadev/dsh-tether](https://github.com/zexadev/dsh-tether)，Android 体验和代码基线来自 [saya-ch/dsh-mobile](https://github.com/saya-ch/dsh-mobile)。它们的贡献与许可保留在 [NOTICE](NOTICE)、[原始 MIT 许可](LICENSE.dsh-tether) 和 [DSH Mobile Apache-2.0 许可](LICENSE.dsh-mobile) 中；其余本仓原创代码按 [MIT](LICENSE) 提供，不代表上游背书。

早期非 iroh 的签名信封实验移入 [experiments/identity](experiments/identity/README.md)。外部参考 sidecar 的检查是 `npm run smoke:reference`，不算本仓第一方实现的验收。
