# DSH Mobile iroh Android App

[返回项目 README](../../README.md)

这个 Android App 以 DSH Mobile 的 WebView 体验为基线：已配对设备管理、局域网和远程配对、取消连接、系统返回键、页面缩放、文件选择、拍照、通知、多语言和无障碍行为都会尽量保持一致，再接入 iroh 传输。

应用包名是 `io.github.sayach.dshmobileiroh`，与正式 DSH Mobile App 独立，不会替换或迁移正式 App 的数据。

## 当前状态

当前已经导入并构建独立的 WebView 壳和 HTTPS 传输基线。原生 iroh 传输尚未接入 WebView，因此当前调试包不能视为可用的 iroh 客户端，也不是正式 DSH Mobile 发布包。

## 构建基线 App

需要 Android SDK 36 和 JDK 17。仓库不提交 `local.properties`，请在本机写入 Android SDK 路径。

```powershell
Set-Location apps/mobile/android
./gradlew.bat :app:testDebugUnitTest :app:assembleDebug
```

调试 APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。它使用独立的 application ID，不可作为正式签名或生产设备证据。

## 计划中的传输接入

iroh 客户端会放在传输抽象之后。WebView 继续只访问受限的本地 Origin，原生层负责 Endpoint 身份、配对、QUIC 流、撤销和清理。页面不会获得私钥或任意原生命令权限。
