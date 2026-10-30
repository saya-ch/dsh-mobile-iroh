<p align="center">
  <img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile-iroh/main/assets/brand/repository-hero.png" alt="DSH Mobile iroh: encrypted direct or relay access to DSH" width="100%">
</p>

<h1 align="center">DSH Mobile iroh</h1>

<p align="center">An iroh transport-component distribution and standalone prototype for DSH Mobile.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-mobile-iroh"><img src="https://img.shields.io/npm/v/dsh-mobile-iroh/alpha?label=npm%20component&color=CB3837" alt="npm experimental component version"></a>
  <a href="https://github.com/saya-ch/dsh-mobile-iroh/actions/workflows/ci.yml"><img src="https://github.com/saya-ch/dsh-mobile-iroh/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0F172A" alt="MIT"></a>
</p>

<p align="center">
  <a href="#current-role">Current role</a> ·
  <a href="#use-iroh-in-the-main-project">Use in DSH Mobile</a> ·
  <a href="#the-main-projects-component-dependency">Component dependency</a> ·
  <a href="#standalone-prototype">Standalone prototype</a> ·
  <a href="#development-and-licenses">Development and licenses</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="README.md">简体中文</a>
</p>

> **iroh is integrated into the [main DSH Mobile project](https://github.com/saya-ch/dsh-mobile).** Since main-plugin and App version 0.7.0, everyday use should follow the main plugin and its **full Android App with iroh**. You do not need this repository's separate plugin or App.
>
> This repository is not merely an archive: the main plugin still uses the published `dsh-mobile-iroh@0.1.0-alpha.1` package as its computer-side transport-component source. The original standalone prototype, downloads and verification records remain available too. This is a community project, not an official DeepSeek product.

## Current role

This project began as an independent test of direct/relayed iroh access to DSH, with a separate plugin and Android App. After integration, the user entry point and integrated implementation moved to the main repository. This repository remains a **source of currently consumed component releases, a standalone prototype and a design reference**.

| Area | Current location |
| --- | --- |
| Everyday installation, mobile UI, device management and integration issues | [Main DSH Mobile repository](https://github.com/saya-ch/dsh-mobile) |
| Integrated Host, shared transport core and native Android implementation | The main repository's [native/iroh-host](https://github.com/saya-ch/dsh-mobile/tree/main/native/iroh-host), [native/iroh-core](https://github.com/saya-ch/dsh-mobile/tree/main/native/iroh-core) and [apps/mobile](https://github.com/saya-ch/dsh-mobile/tree/main/apps/mobile) |
| Windows/Linux computer-side components currently downloaded by the main plugin | This repository's published npm `0.1.0-alpha.1` package, selected by the main component catalog's version and checksums |
| Standalone plugin/App, prototype design and historical verification | This repository's source, documentation and [Releases](https://github.com/saya-ch/dsh-mobile-iroh/releases) |

Integration does not mean the release dependency has disappeared, nor that this repository's standalone App updates alongside the main App. The two Apps have separate package identities, signers and pairing data; **automatic migration is not implemented**.

## Use iroh in the main project

1. Install and enable [dsh-mobile](https://github.com/saya-ch/dsh-mobile/blob/main/README.en.md#quick-start) in DSH on the computer.
2. Install the main project's **full Android App with iroh**. Its compatibility APK and mobile browsers do not provide native iroh transport.
3. On the computer, open **Mobile access → Remote access → iroh (experimental)**. Choose **Install official component**, then enable the connection and generate a pairing QR code.
4. Scan it using the main App's iroh pairing entry. Use its paired-device list for subsequent connections.

Follow the main repository's [iroh guide](https://github.com/saya-ch/dsh-mobile/blob/main/docs/IROH.en.md) for current steps, supported platforms and troubleshooting. Records from the standalone App do not automatically appear in the main App: scan a new QR when switching, keep the old records until the new connection works, then remove them yourself if desired.

iroh attempts an encrypted direct connection and uses an available relay when needed, without requiring a public domain or port forwarding first. DSH must remain running, and the networks must permit access to the required services. A local started state does not establish public-network phone reachability.

## The main project's component dependency

This is not an ordinary npm runtime dependency requiring both plugins to be enabled. The main plugin's component manager selects and verifies a native executable instead of requiring users to activate the standalone `dsh-mobile-iroh` plugin.

- An explicit **Install official component** action downloads the platform binary from a fixed-version npm CDN URL, checks its byte length and SHA-256, then installs it in the main plugin's private component directory. Enabling the channel alone does not download it.
- An already installed standalone companion package can supply a verified copy without another download.
- The current selected version is **`dsh-mobile-iroh@0.1.0-alpha.1`**, not whatever npm `alpha` or `latest` happens to select. The main [component catalog](https://github.com/saya-ch/dsh-mobile/blob/main/src/iroh-component.ts) owns exact URLs, platforms, sizes and checksums.

| Platform | File in the pinned component package |
| --- | --- |
| Windows x64 | `native/dsh-mobile-iroh-host-win32-x64.exe` |
| Linux x64 (glibc) | `native/dsh-mobile-iroh-host-linux-x64` |

These releases still have consumers and must not be removed or replaced merely because the code was integrated. A future distribution-source migration must first update the main catalog and pass the relevant acceptance checks. This README change does not alter downloads, versions or verification policy.

## Standalone prototype

Standalone `0.1.0-alpha.1` remains available for existing deployments, experiments and development reference. **It is not the recommended installation path for new users.** Its baseline below is not the current main project's minimum version or compatibility scope.

<details>
<summary>Standalone prototype downloads, installation and verification baseline</summary>

<p align="center">
  <a href="https://github.com/saya-ch/dsh-mobile-iroh/releases/download/android-v0.1.0-alpha.1/dsh-mobile-iroh-android-v0.1.0-alpha.1.apk"><img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile-iroh/main/assets/brand/app-icon-rounded.svg" alt="Standalone DSH Mobile iroh prototype app icon" width="72" height="72"></a><br>
  <a href="https://github.com/saya-ch/dsh-mobile-iroh/releases/download/android-v0.1.0-alpha.1/dsh-mobile-iroh-android-v0.1.0-alpha.1.apk"><strong>Download standalone prototype App 0.1.0-alpha.1</strong></a><br>
  <sub><a href="https://github.com/saya-ch/dsh-mobile-iroh/releases/tag/android-v0.1.0-alpha.1">Initial release notes and checksums</a></sub>
</p>

- Prototype verification baseline: **official DSH Desktop / DSH 0.2.1-rc.2 + dsh-mobile 0.6.16**.
- Computer targets are Windows x64 and Linux x64 (glibc). The npm package includes the native transport executable; users do not need Rust. Alpine/musl builds are not included.
- The standalone APK supports Android 10+ with arm64-v8a and x86_64, not 32-bit devices. Its release signer differs from the main App's; the packages must not overwrite each other.

In that prototype environment, official Desktop can install `dsh-mobile-iroh@0.1.0-alpha.1` through plugin management. DSH Web can pin the initial combination:

```powershell
dsh plugin --profile web add dsh-mobile@0.6.16 dsh-mobile-iroh@0.1.0-alpha.1
```

This is a **historical prototype installation command**, not an instruction to downgrade the main project or modify Desktop's profile. npm `alpha` and `latest` currently both select the initial alpha; neither establishes a standalone stable release.

Restart normally if requested, open **Settings → General → DSH Mobile iroh → Open manager**, start the connection and generate a QR, then scan with the standalone App. The main Mobile plugin supplies the frontend. The prototype keeps its own enabled state, certificates and pairing records; it does not need the main plugin's LAN or HTTPS remote channel enabled separately.

The prototype retains a device list, naming, startup preferences and cancellable connections. Transport-peer authorization and Mobile device-token revocation are separate layers; ordinary disconnection is not revocation. Its Gateway does not automatically synchronize the main plugin's extension directory, running extension services or third-party WebSocket allow rules. This does not establish compatibility with every plugin combination.

Some pairing, page-loading, reconnection and revocation checks completed on an Android 16 phone using a cellular network. They do not cover every network or current DSH version. Hot-update and long-session recovery limits remain documented in [VERIFICATION](VERIFICATION.md); they were not retested by this documentation change.

[Prototype management and extensions](operator/README.md) · [Standalone App manual](apps/mobile/README.md) · [Prototype architecture](docs/ARCHITECTURE.md) · [Prototype integration design reference](docs/INTEGRATION_SEAM.md)

</details>

## Development and licenses

Use [dsh-mobile](https://github.com/saya-ch/dsh-mobile) for everyday features and main-project integration changes. Report standalone-prototype, component-distribution or historical-reproduction issues here. Name the plugin/App combination, versions, platform and network conditions; hide active QR codes, tokens, cookies, private keys and private conversations.

Transport encryption does not replace Gateway authorization. The App must still verify the full computer identity's HTTPS hostname and pinned CA, while the Gateway retains device sessions, Origin, CSRF and WebSocket path checks. [SECURITY](SECURITY.md) describes the standalone prototype's state and permissions; the main repository owns integrated-product instructions.

[Development and validation](CONTRIBUTING.md) · [Historical implementation record](docs/IMPLEMENTATION_PLAN.md) · [Changelog](CHANGELOG.md)

The Rust baseline references [zexadev/dsh-tether](https://github.com/zexadev/dsh-tether); the mobile experience and code baseline come from [DSH Mobile](https://github.com/saya-ch/dsh-mobile); transport uses [iroh](https://github.com/n0-computer/iroh). Attribution and licenses remain in [NOTICE](NOTICE), the [original MIT license](LICENSE.dsh-tether) and the [DSH Mobile Apache-2.0 license](LICENSE.dsh-mobile). Original code in this repository is available under [MIT](LICENSE); no upstream endorsement is implied.
