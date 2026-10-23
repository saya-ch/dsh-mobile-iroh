# DSH Mobile iroh Android App

[返回项目说明](../../README.md) · [English](README.md) · [验证记录](../../VERIFICATION.md)

沿用 DSH Mobile 的设备列表、命名、启动偏好、配对、WebView、取消、返回键、缩放、文件选择、拍照、通知和多语言体验。包名为 `io.github.sayach.dshmobileiroh`，不会覆盖正式 App，也不自动迁移其数据。

## 安装与连接

发行产物公开并核验后，从本仓库的 [Releases](https://github.com/saya-ch/dsh-mobile-iroh/releases) 下载正式签名 APK。候选产物状态和实际验收范围见 [VERIFICATION](../../VERIFICATION.md)。正式签名用于识别发行来源；产品版本 `0.1.0-alpha.1` 仍是实验版本，不等于稳定版。

在电脑当前 DSH profile 安装并启用 `dsh-mobile 0.6.16` 与独立 companion 插件。在官方 Desktop 或 DSH Web 中打开 **设置 → 通用设置 → DSH Mobile iroh → 打开管理**，点击 **启动** 并生成二维码。管理页自动连接当前 DSH，无需复制登录 Token，也不要求另外开启主 Mobile 的远程通道。App 中选择 **iroh 连接（实验）**，扫描或粘贴可信配对信息，给电脑命名后进入 DSH。

正式签名包与本地 Debug 包使用这个独立包名，但签名不同，不能相互覆盖。不要通过卸载已有 App 或清除配对数据绕过签名差异。后续发行版必须沿用 [signing.json](signing.json) 固定的独立发布签名，不复用原 DSH Mobile 的签名。

## 当前实现

启用原生传输的构建提供 iroh 实验入口。扫描或粘贴受信电脑端生成的短期二维码描述符，连接、命名后进入 DSH；保存的记录在下次启动时先恢复 iroh，再续期正常的 Gateway 凭据。独立的[电脑管理页](../../operator/README.md) 组合原生 Host／Gateway owner、配置私有证书并生成短期配对二维码。安装式 companion 通过公开注入服务接入当前 DSH，独立 CLI 则需要明确配置；两者都不扫描或复制其他 profile 的凭据和扩展。

WebView 访问由完整 EndpointId 派生的 HTTPS 域名。Rust 持有固定本地端口，把 TLS 原始字节经 QUIC 送给电脑网关；Java 认证和下载经严格限定目标的本地 CONNECT 代理，继续校验证书 CA 和主机名，不依赖普通 DNS 回退。

取消、切换电脑、删除和 Activity 销毁会使旧请求失效，迟到结果不能重新打开旧页面或关掉新连接。明确的在线撤销与普通网络失败分开处理。App 已退出后，电脑端仅撤销 iroh peer 的情况，目前下一次连接仍可能只得到通用失败；不声称它必定显示“电脑端已移除”。Gateway 的 `device_revoked` 是另一层结果。

Gateway Token 和 CA 沿用 Keystore 加密；iroh 长期身份目前是 App 私有目录中的 native 文件，尚未做硬件 Keystore 包裹。短配对码和完整二维码不保存为设备凭据。

保留原页面的连接恢复成功后，会重新监测新传输的前台状态。多次重试共享原连接的总等待时间，旧队列中的检查不能影响后继连接。二维码预校验使用兼容 Android 的非回溯重复，保留严格字段、转义校验和 2200 字节上限。JVM 回归与已完成的部分 Activity/WebView 真机检查分别记录在 [VERIFICATION](../../VERIFICATION.md)。

## 构建

需要 JDK 17、Android SDK 36、支持 16 KB ZIP 对齐检查的已安装 Build Tools，以及明确选择的 NDK；本机验证的是 NDK `25.2.9519653` 与 Build Tools `35.0.0`，CI 配置安装 `36.0.0`。检查 APK 时应传入实际已安装的 Build Tools 目录。SDK 路径保存在本机，不提交 `local.properties`。

```powershell
Set-Location apps/mobile/android
./gradlew.bat --no-daemon -PirohNative=true -PirohNdk=C:/develop/Android/Sdk/ndk/25.2.9519653 lintDebug testDebugUnitTest assembleDebug assembleRelease -x lintAnalyzeDebugUnitTest -x lintAnalyzeDebugAndroidTest
```

不带 `-PirohNative=true` 的包只有原 HTTPS 基线，不含可用 iroh 入口。Debug APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。未配置发布签名时，R8 Release 产物为 `android/app/build/outputs/apk/release/app-release-unsigned.apk`，只用于构建检查；完整配置独立签名后才会生成 `android/app/build/outputs/apk/release/app-release.apk`，仍需完成发行校验。

上述命令与本轮实测和 CI 一致：Android Lint 检查应用源码、Manifest 与资源，不包括测试源码分析；JVM 测试仍独立编译和执行。目前没有 instrumentation 测试源集，不能把这个结果描述成全部源码 lint 通过。

当前原生包仅支持 **arm64-v8a、x86_64，最低 Android 10/API 29**。32 位设备尚未覆盖；将来并入主 App 时必须另审 ABI 和签名，不可直接替换所有用户。完整 JNI、ELF 16 KB 和 APK ZIP 检查命令见 [英文构建说明](README.md)。

### 发布签名

通过进程环境提供四项独立签名输入：`DSH_IROH_ANDROID_KEYSTORE_FILE`、`DSH_IROH_ANDROID_KEYSTORE_PASSWORD`、`DSH_IROH_ANDROID_KEY_ALIAS`、`DSH_IROH_ANDROID_KEY_PASSWORD`。密钥库及恢复备份必须保存在仓库外；四项未全部提供时，`assembleRelease` 只生成未签名产物，构建成功不代表正式签名成功。

对待发布的实际 APK 执行 `apksigner verify --verbose --print-certs`，核对包名和版本，再将校验报告交给 [verify-android-release.mjs](../../scripts/verify-android-release.mjs)，与 [signing.json](signing.json) 的公钥指纹比较。也要检查该签名 APK 内的原生库和 ZIP 对齐。发布必须上传同一份已验收的字节、校验和及许可说明；独立 npm／Android 发布路径见 [CONTRIBUTING](../../CONTRIBUTING.md#authorized-release-paths)。

## 真机验收

识别设备、包名、签名和 WebView 后再安装，不卸载正式 App、不清配对、不绕过签名差异。只操作明确的隔离测试配对。

需要覆盖扫码、冷启动、取消、连接中切设备、返回、文件选择／下载、重连时页面状态、在线撤销、离线撤销恢复、重启、休眠和切网，并分别验证真实直连与 relay／移动网络。桌面传输驱动、JVM 和打包检查都不替代这些证据。

独立产品版本为 `0.1.0-alpha.1`；`MOBILE_COMPATIBILITY_VERSION=0.6.5` 是继承的网关 API 基线，不是第二个产品版本。
