<p align="center">
  <img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile-iroh/main/apps/mobile/android/app/src/main/res/drawable-nodpi/ic_launcher_whale.png" alt="DSH Mobile iroh" width="88" height="88">
</p>

<h1 align="center">DSH Mobile iroh</h1>

<p align="center">让手机通过加密直连或中继，继续使用电脑上的 DeepSeek Harness。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-mobile-iroh"><img src="https://img.shields.io/npm/v/dsh-mobile-iroh/alpha?label=npm%20alpha&color=CB3837" alt="npm 测试版本"></a>
  <a href="https://github.com/saya-ch/dsh-mobile-iroh/actions/workflows/ci.yml"><img src="https://github.com/saya-ch/dsh-mobile-iroh/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/saya-ch/dsh-mobile-iroh/releases"><img src="https://img.shields.io/badge/Android-10%2B-3DDC84?logo=android&logoColor=white" alt="Android 10+"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0F172A" alt="MIT"></a>
</p>

<p align="center">
  <a href="#能做什么">能做什么</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#配对与连接">配对与连接</a> ·
  <a href="#设备管理">设备管理</a> ·
  <a href="#与-dsh-mobile-的关系">与 DSH Mobile 的关系</a> ·
  <a href="#安全与连接体验">安全</a> ·
  <a href="#兼容性">兼容性</a> ·
  <a href="CHANGELOG.md">更新记录</a> ·
  <a href="README.en.md">English</a>
</p>

> DSH Mobile iroh 是 [DSH Mobile](https://github.com/saya-ch/dsh-mobile) 的独立实验项目，不是 DeepSeek 官方产品。
>
> **当前版本：0.1.0-alpha.1（测试通道）。** 电脑端使用 npm `alpha` 通道，Android App 提供独立正式签名的 Release 构建；初版仍处于测试阶段。
> npm 首次发布额外附带了 `latest` 标签，因此不带标签安装目前也会取到 alpha，并不代表已有稳定版。请显式安装 `dsh-mobile-iroh@alpha`。
>
> 插件与 App 独立编号、独立发布。独立 App 不覆盖原 DSH Mobile，也不会自动迁移原 App 的配对数据。

<p align="center">
  <a href="https://github.com/saya-ch/dsh-mobile-iroh/releases/download/android-v0.1.0-alpha.1/dsh-mobile-iroh-android-v0.1.0-alpha.1.apk"><strong>下载 Android App 0.1.0-alpha.1</strong></a><br>
  <sub><a href="https://github.com/saya-ch/dsh-mobile-iroh/releases/tag/android-v0.1.0-alpha.1">版本说明与校验文件</a></sub>
</p>

它复用 DSH Mobile 的移动页面和配对体验，将手机到电脑之间的连接交给 iroh：尝试建立直接连接，无法直连时使用可用的中继。你不必先准备公网域名、端口映射或另一套 HTTPS 隧道；电脑仍需运行 DSH，双方网络也必须能访问所需的发现与中继服务。

会话、工作区和工具仍由电脑上的 DSH 提供。项目不修改 DSH Core，也不会在手机上另起一套智能体。

## 能做什么

- **远程使用当前电脑上的 DSH**：连接已有的工作区、会话和插件页面，不复制一套会话数据。
- **减少通道配置**：通过 iroh 发现电脑并建立加密连接，无需先配置 cpolar、cloudflared 或自建反向代理。
- **熟悉的移动体验**：保留触屏页面、设备列表、启动偏好、网页设置和原生返回操作。
- **扫码配对**：App 核对电脑身份和私有证书，再保存设备凭据。
- **管理多台电脑**：自定义名称、连接最近使用的电脑、重新配对或删除本地记录。
- **可取消的连接恢复**：连接与重连都有取消入口和总等待时间，恢复时尽量保留当前页面与未发送草稿。
- **电脑端管理**：从 DSH 通用设置打开管理页，启停连接、生成二维码、查看传输设备并撤销授权。

## 快速开始

### 1. 准备电脑与手机

- 电脑使用官方 DSH Desktop 或 DSH Web，并安装、启用 **dsh-mobile 0.6.16**。
- 本测试版电脑端支持 **Windows x64、Linux x64（glibc）**，npm 包内附原生传输程序，不需要用户安装 Rust；不包含 Alpine／musl 构建。
- 手机使用 **Android 10 及以上**，当前 APK 包含 arm64-v8a、x86_64；32 位设备暂不支持。

主 Mobile 插件负责提供移动前端，不要求你为 iroh 另开它的局域网或远程通道。iroh 使用独立的启停状态、证书和配对记录。

### 2. 安装电脑端插件

**官方 DSH Desktop**：在插件管理中安装并启用 `dsh-mobile-iroh@alpha`，再进入 **设置 → 通用设置 → DSH Mobile iroh → 打开管理**。

**DSH Web**：使用当前 DSH 的 CLI 安装到 web profile：

```powershell
dsh plugin --profile web add dsh-mobile@0.6.16 dsh-mobile-iroh@alpha
```

按安装提示正常重启 DSH，再从通用设置打开管理。Desktop 的 profile 由官方应用管理，不要套用 `--profile web` 的命令修改 Desktop。

管理页会连接当前 DSH，无需复制 DSH 登录 Token。点击 **启动** 后生成配对二维码。管理页只监听电脑的回环地址，不作为公网管理入口。

### 3. 安装独立 Android App

从上方入口或本仓库 [Releases](https://github.com/saya-ch/dsh-mobile-iroh/releases) 下载正式签名 APK。请安装 **DSH Mobile iroh**，不要拿它覆盖原 DSH Mobile。

本地 Debug 包与正式包签名不同，不能直接相互覆盖。以后正式版升级应使用相同发布签名；不要通过清除原 DSH Mobile 数据来处理签名冲突。

## 配对与连接

1. 在电脑上打开 iroh 管理页，启动连接并生成二维码。
2. 在独立 App 中选择 **iroh 连接（实验）→ 扫码配对**；也可以粘贴完整配对信息。
3. 配对成功后给电脑命名，进入 DSH。
4. 以后从已配对设备中打开这台电脑；身份、证书和授权仍有效时，不需要重复扫码。

二维码包含一次性凭据，请只在可信电脑和手机之间使用，不要把有效二维码、完整配对文本或管理页登录链接贴到 issue。

iroh 使用持久电脑身份发现对端，地址变化不必等同于重新配对。但网络阻断、电脑休眠或公共服务暂时不可达仍会让连接失败；可取消并稍后重试，不会因此把设备当作已删除。

## 设备管理

**已配对设备**页面集中显示保存的电脑。点击条目连接，长按或点击更多按钮可编辑名称、重新配对或删除本地记录；名称只影响本 App。

设备列表的设置提供两种启动行为：

- **直接进入 DSH**：尝试连接最近使用的电脑；即使保存了多台电脑，也按这一选择执行。
- **显示设备列表**：每次打开 App 先选择电脑。

进入 DSH 后，可在网页的 **设置 → 通用设置 → 切换电脑** 返回列表。删除本地记录不会关闭电脑端 DSH，也不影响其他手机。

电脑端撤销在线设备后，App 会保留条目并显示 **电脑端已移除**，可以重新配对或删除本地记录。离线时仅撤销 iroh 传输授权，下次连接可能只能得到通用失败；它与 Mobile Gateway 的设备 Token 撤销是不同层级，不会把普通断网误报为撤销。

## 与 DSH Mobile 的关系

| | DSH Mobile | DSH Mobile iroh |
| --- | --- | --- |
| 手机到电脑的连接 | 局域网或 HTTPS 远程入口 | iroh 直连／中继，内部保留 HTTPS 网关校验 |
| 手机客户端 | Android App 或手机浏览器 | 带原生 iroh 传输的独立 Android App |
| 移动前端 | 主 Mobile 插件提供 | 复用已启用的主 Mobile 前端 |
| 配对和状态 | 主插件与原 App 管理 | 独立保存，不自动迁移 |
| 当前定位 | 持续维护的主项目 | 独立测试路线，未来是否并入另行评估 |

普通 DSH 页面和已加载插件仍来自当前电脑。主 Mobile 的自定义扩展目录、已运行的扩展服务及第三方 WebSocket 放行配置不会自动同步到独立网关；不承诺所有社区插件无需配置即可使用。[独立管理与扩展说明](operator/README.md)

## 安全与连接体验

iroh 传输与网关授权分层工作。端到端加密连接之外，App 仍校验完整电脑身份对应的 HTTPS 主机名和固定 CA，网页请求仍受设备会话、Origin、CSRF 和 WebSocket 路径规则约束。

App 的 Mobile 凭据使用 Android Keystore 加密。iroh 长期身份密钥保存在禁用备份的 App 私有目录中，目前不是硬件 Keystore 包装。配对设备可以操作电脑上的 DSH，应视为完全受信任；手机遗失时应撤销相应授权。[安全说明](SECURITY.md)

成功直连通常少一层中继，但并非所有 NAT、防火墙或运营商都允许；公共发现与中继也可能受网络策略影响。管理页显示本地服务已启动，不等于已经证明手机公网可达。

## 兼容性

当前验收以 **官方 DSH Desktop / DSH 0.2.1-rc.2**、**dsh-mobile 0.6.16** 为基础。初版使用数值回环 HTTP 作为电脑内的 DSH 上游，手机到电脑之间仍是加密传输；不支持把任意公网 URL 当作转发目标。

初版仍有恢复边界：电脑端插件热更新后，已打开页面的模块列表可能需要重新加载；长时间使用导致网页会话过期时，也可能需要从设备列表重新进入。两者都不要求重新配对。正在编辑时请先保存草稿，再重新进入。

已经完成 Android 16 移动网络下的部分真实配对、页面加载、重连和撤销检查，不等于覆盖所有网络、手机或第三方插件。具体结果与待补项见 [VERIFICATION](VERIFICATION.md)。

## 参与开发

欢迎提供清楚的复现步骤、版本和网络条件，或提交小而明确的改进。反馈时请隐藏二维码、Token、Cookie、私钥和私人会话内容。

[开发与验证](CONTRIBUTING.md) · [Android 构建](apps/mobile/README.zh-CN.md) · [架构](docs/ARCHITECTURE.md) · [实施进度](docs/IMPLEMENTATION_PLAN.md) · [更新记录](CHANGELOG.md)

Rust 基线参考 [zexadev/dsh-tether](https://github.com/zexadev/dsh-tether)，移动体验与代码基线来自 [DSH Mobile](https://github.com/saya-ch/dsh-mobile)，传输依赖 [iroh](https://github.com/n0-computer/iroh)。感谢这些开源项目；贡献与许可保留在 [NOTICE](NOTICE)、[原始 MIT 许可](LICENSE.dsh-tether) 和 [DSH Mobile Apache-2.0 许可](LICENSE.dsh-mobile) 中。本仓原创代码按 [MIT](LICENSE) 提供，不代表上游背书。
