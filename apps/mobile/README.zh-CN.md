# DSH Mobile iroh Android App

[返回项目说明](../../README.md) · [English](README.md) · [验证记录](../../VERIFICATION.md)

沿用 DSH Mobile 的设备列表、命名、启动偏好、配对、WebView、取消、返回键、缩放、文件选择、拍照、通知和多语言体验。包名为 `io.github.sayach.dshmobileiroh`，不会覆盖正式 App，也不自动迁移其数据。

## 当前实现

启用原生传输的构建提供 iroh 实验入口。扫描或粘贴受信电脑端生成的短期二维码描述符，连接、命名后进入 DSH；保存的记录在下次启动时先恢复 iroh，再续期正常的 Gateway 凭据。独立的[电脑管理页](../../operator/README.md) 组合原生 Host／Gateway owner、配置私有证书并生成短期配对二维码；不会自动发现或改动正常 DSH profile。

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

不带 `-PirohNative=true` 的包只有原 HTTPS 基线，不含可用 iroh 入口。Debug APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`；R8 Release 产物是未签名 APK，只用于构建检查，不能当正式发行包。

上述命令与本轮实测和 CI 一致：Android Lint 检查应用源码、Manifest 与资源，不包括测试源码分析；JVM 测试仍独立编译和执行。目前没有 instrumentation 测试源集，不能把这个结果描述成全部源码 lint 通过。

当前原生包仅支持 **arm64-v8a、x86_64，最低 Android 10/API 29**。32 位设备尚未覆盖；将来并入主 App 时必须另审 ABI 和签名，不可直接替换所有用户。完整 JNI、ELF 16 KB 和 APK ZIP 检查命令见 [英文构建说明](README.md)。

## 真机验收

识别设备、包名、签名和 WebView 后再安装，不卸载正式 App、不清配对、不绕过签名差异。只操作明确的隔离测试配对。

需要覆盖扫码、冷启动、取消、连接中切设备、返回、文件选择／下载、重连时页面状态、在线撤销、离线撤销恢复、重启、休眠和切网，并分别验证真实直连与 relay／移动网络。桌面传输驱动、JVM 和打包检查都不替代这些证据。

独立产品版本为 `0.1.0-alpha.1`；`MOBILE_COMPATIBILITY_VERSION=0.6.5` 是继承的网关 API 基线，不是第二个产品版本。
