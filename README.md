<p align="center">
  <img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile-iroh/main/assets/brand/repository-hero.png" alt="DSH Mobile iroh：加密直连或中继访问 DSH" width="100%">
</p>

<h1 align="center">DSH Mobile iroh</h1>

<p align="center">DSH Mobile 的 iroh 传输组件发行源与独立原型。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-mobile-iroh"><img src="https://img.shields.io/npm/v/dsh-mobile-iroh/alpha?label=npm%20component&color=CB3837" alt="npm 实验性组件版本"></a>
  <a href="https://github.com/saya-ch/dsh-mobile-iroh/actions/workflows/ci.yml"><img src="https://github.com/saya-ch/dsh-mobile-iroh/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0F172A" alt="MIT"></a>
</p>

<p align="center">
  <a href="#当前定位">当前定位</a> ·
  <a href="#在主项目中使用">在主项目中使用</a> ·
  <a href="#主仓库的组件依赖">组件依赖</a> ·
  <a href="#独立原型">独立原型</a> ·
  <a href="#开发与许可">开发与许可</a> ·
  <a href="CHANGELOG.md">更新记录</a> ·
  <a href="README.en.md">English</a>
</p>

> **iroh 已整合进 [DSH Mobile 主项目](https://github.com/saya-ch/dsh-mobile)。** 从主插件与 App 0.7.0 起，日常使用请选择主项目的插件和 Android **完整版（含 iroh）**，不需要另装本仓的独立插件或 App。
>
> 本仓并非仅供存档：主插件目前仍使用这里已发布的 `dsh-mobile-iroh@0.1.0-alpha.1` 作为电脑端传输组件来源。原有独立原型、安装包和验证记录同时保留。项目是社区项目，不是 DeepSeek 官方产品。

## 当前定位

本项目最初用于独立验证 iroh 直连／中继访问 DSH，并提供一套独立插件和 Android App。集成完成后，用户入口和集成实现已转到主仓；这里继续承担**现用组件发行源、独立原型和设计参考**的角色。

| 内容 | 当前入口 |
| --- | --- |
| 日常安装、移动界面、设备管理与集成问题 | [DSH Mobile 主仓库](https://github.com/saya-ch/dsh-mobile) |
| 集成后的 Host、共享传输 core 与 Android 原生代码 | 主仓的 [native/iroh-host](https://github.com/saya-ch/dsh-mobile/tree/main/native/iroh-host)、[native/iroh-core](https://github.com/saya-ch/dsh-mobile/tree/main/native/iroh-core) 和 [apps/mobile](https://github.com/saya-ch/dsh-mobile/tree/main/apps/mobile) |
| 主插件当前下载的 Windows／Linux 电脑端组件 | 本仓已发布的 npm `0.1.0-alpha.1` 包，按主仓目录固定版本与校验值 |
| 独立插件、独立 App、原型设计与历史验证 | 本仓源码、文档与 [Releases](https://github.com/saya-ch/dsh-mobile-iroh/releases) |

因此，“已经整合”不等于“已经消除发行依赖”，也不表示本仓独立 App 会跟随主 App 同步更新。两套 App 的包名、签名和配对数据各自独立，**没有自动迁移功能**。

## 在主项目中使用

1. 在电脑的 DSH 中安装并启用 [dsh-mobile](https://github.com/saya-ch/dsh-mobile#快速开始)。
2. 安装主项目的 Android **完整版（含 iroh）**。兼容版 APK 和手机浏览器不提供原生 iroh 传输。
3. 在电脑端打开 **移动访问 → 远程访问 → iroh（实验性）**，先点 **安装官方组件**，再启用连接并生成配对二维码。
4. 用主 App 的 iroh 配对入口扫码；以后从已配对设备列表连接。

具体步骤、支持平台及排障以主仓的 [iroh 使用说明](https://github.com/saya-ch/dsh-mobile/blob/main/docs/IROH.md) 为准。原独立 App 的记录不会自动出现在主 App 中；改用主 App 时需要重新扫码，请先保留旧记录，确认新连接可用后再自行整理。

iroh 尝试加密直连，不能直连时使用可用中继，无需先准备公网域名或端口映射。电脑仍需运行 DSH，网络也必须允许访问所需服务；本地显示已启动不等于手机已经公网可达。

## 主仓库的组件依赖

主仓对本仓的使用不是普通的 npm 运行时包依赖：主插件不会要求用户同时启用独立 `dsh-mobile-iroh` 插件，而是由组件管理器选择并验证原生可执行文件。

- 用户明确点击 **安装官方组件** 后，管理器从固定版本的 npm CDN 地址下载对应二进制，检查字节数与 SHA-256，再放入主插件的私有组件目录；仅启用通道不会自动下载。
- 若本机已有独立配套包，管理器也可以复用其经过校验的副本，不要求再次下载。
- 当前使用的版本是 **`dsh-mobile-iroh@0.1.0-alpha.1`**，不是自动跟随 npm `alpha` 或 `latest`。准确的下载地址、平台、大小与校验值由主仓的 [组件目录](https://github.com/saya-ch/dsh-mobile/blob/main/src/iroh-component.ts) 管理。

| 平台 | 固定组件包中的文件 |
| --- | --- |
| Windows x64 | `native/dsh-mobile-iroh-host-win32-x64.exe` |
| Linux x64（glibc） | `native/dsh-mobile-iroh-host-linux-x64` |

这些发行产物仍有消费者，不能因为代码已经整合就下架或替换。今后迁移组件发行源，需要先在主仓更新目录并完成相应验收；README 更新本身不改变现有下载、版本或校验策略。

## 独立原型

独立版 `0.1.0-alpha.1` 保留给旧部署、复现实验与开发参考，**不是新用户的推荐安装路线**。下列基线属于独立原型，不代表当前主项目的最低版本或兼容范围。

<details>
<summary>独立原型的下载、安装与验证基线</summary>

<p align="center">
  <a href="https://github.com/saya-ch/dsh-mobile-iroh/releases/download/android-v0.1.0-alpha.1/dsh-mobile-iroh-android-v0.1.0-alpha.1.apk"><img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile-iroh/main/assets/brand/app-icon-rounded.svg" alt="独立 DSH Mobile iroh 原型应用图标" width="72" height="72"></a><br>
  <a href="https://github.com/saya-ch/dsh-mobile-iroh/releases/download/android-v0.1.0-alpha.1/dsh-mobile-iroh-android-v0.1.0-alpha.1.apk"><strong>下载独立原型 App 0.1.0-alpha.1</strong></a><br>
  <sub><a href="https://github.com/saya-ch/dsh-mobile-iroh/releases/tag/android-v0.1.0-alpha.1">初版说明与校验文件</a></sub>
</p>

- 原型验证基线：**官方 DSH Desktop／DSH 0.2.1-rc.2 + dsh-mobile 0.6.16**。
- 电脑端为 Windows x64 或 Linux x64（glibc）；npm 包包含原生传输程序，不需要用户安装 Rust，不含 Alpine／musl 构建。
- 独立 APK 支持 Android 10+，包含 arm64-v8a、x86_64，不支持 32 位设备。其正式签名与主 App 不同，不应相互覆盖。

在上述原型环境中，官方 Desktop 可通过插件管理安装 `dsh-mobile-iroh@0.1.0-alpha.1`；DSH Web 可固定初版组合：

```powershell
dsh plugin --profile web add dsh-mobile@0.6.16 dsh-mobile-iroh@0.1.0-alpha.1
```

这是**历史原型安装命令**，不要用它降级正在使用的主项目或修改 Desktop 的 profile。npm 的 `alpha` 与 `latest` 当前都指向初版 alpha，不代表存在独立稳定版。

按安装提示正常重启后，从 **设置 → 通用设置 → DSH Mobile iroh → 打开管理** 启动连接、生成二维码，再用独立 App 扫码。主 Mobile 插件负责提供移动前端，原型使用独立的启停状态、证书和配对记录，不需要另开主插件的局域网或 HTTPS 远程通道。

原型保留多设备列表、命名、启动偏好和可取消连接。传输授权撤销与 Mobile 设备 Token 撤销不是同一层，普通断网不应被当作撤销。独立网关不自动同步主插件的扩展目录、运行中扩展服务或第三方 WebSocket 放行配置，不能据此承诺所有插件组合兼容。

初版已有部分 Android 16 移动网络配对、页面加载、重连与撤销实测，但不覆盖所有网络或当前 DSH 版本。热更新和长时间会话的恢复边界保留在 [VERIFICATION](VERIFICATION.md)，不是本次文档更新重新完成的测试。

[原型管理与扩展](operator/README.md) · [独立 App 手册](apps/mobile/README.zh-CN.md) · [原型架构](docs/ARCHITECTURE.md) · [原型集成设计参考](docs/INTEGRATION_SEAM.md)

</details>

## 开发与许可

面向主项目的日常功能与集成改进，请到 [dsh-mobile](https://github.com/saya-ch/dsh-mobile)。本仓的独立原型、组件发行或历史复现问题可在这里反馈；请写明使用哪套插件和 App，以及版本、平台、网络条件，不要贴有效二维码、Token、Cookie、私钥或私人会话。

iroh 传输加密不替代网关授权。App 仍须检查完整电脑身份对应的 HTTPS 主机名和固定 CA，网关保留设备会话、Origin、CSRF 与 WebSocket 路径限制。独立原型的状态与权限说明见 [SECURITY](SECURITY.md)，主项目使用说明以主仓为准。

[开发与验证](CONTRIBUTING.md) · [历史实施记录](docs/IMPLEMENTATION_PLAN.md) · [更新记录](CHANGELOG.md)

Rust 基线参考 [zexadev/dsh-tether](https://github.com/zexadev/dsh-tether)，移动体验与代码基线来自 [DSH Mobile](https://github.com/saya-ch/dsh-mobile)，传输依赖 [iroh](https://github.com/n0-computer/iroh)。贡献与许可保留在 [NOTICE](NOTICE)、[原始 MIT 许可](LICENSE.dsh-tether) 和 [DSH Mobile Apache-2.0 许可](LICENSE.dsh-mobile) 中。本仓原创代码按 [MIT](LICENSE) 提供，不代表上游背书。
