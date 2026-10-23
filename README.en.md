<p align="center">
  <img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile-iroh/main/assets/brand/repository-hero.png" alt="DSH Mobile iroh: encrypted direct or relay access to DSH" width="100%">
</p>

<h1 align="center">DSH Mobile iroh</h1>

<p align="center">Keep using DeepSeek Harness on your computer through an encrypted direct or relayed phone connection.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-mobile-iroh"><img src="https://img.shields.io/npm/v/dsh-mobile-iroh/alpha?label=npm%20alpha&color=CB3837" alt="npm test version"></a>
  <a href="https://github.com/saya-ch/dsh-mobile-iroh/actions/workflows/ci.yml"><img src="https://github.com/saya-ch/dsh-mobile-iroh/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/saya-ch/dsh-mobile-iroh/releases"><img src="https://img.shields.io/badge/Android-10%2B-3DDC84?logo=android&logoColor=white" alt="Android 10+"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0F172A" alt="MIT"></a>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#pairing-and-connecting">Pairing</a> ·
  <a href="#device-management">Devices</a> ·
  <a href="#relationship-to-dsh-mobile">DSH Mobile</a> ·
  <a href="#security-and-connection-experience">Security</a> ·
  <a href="#compatibility">Compatibility</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="README.md">简体中文</a>
</p>

> DSH Mobile iroh is an independent experimental project related to [DSH Mobile](https://github.com/saya-ch/dsh-mobile), not an official DeepSeek product.
>
> **Current version: 0.1.0-alpha.1 (testing channel).** The computer plugin uses npm's `alpha` channel; Android uses an independently release-signed build. This initial version remains experimental.
> npm also attached `latest` to this first publication, so an untagged install currently selects the alpha too. This does not make it stable. Install `dsh-mobile-iroh@alpha` explicitly.
>
> The plugin and App have independent version numbers and releases. This separate App does not replace the original DSH Mobile or automatically migrate its paired devices.

<p align="center">
  <a href="https://github.com/saya-ch/dsh-mobile-iroh/releases/download/android-v0.1.0-alpha.1/dsh-mobile-iroh-android-v0.1.0-alpha.1.apk"><img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile-iroh/main/assets/brand/app-icon-rounded.svg" alt="DSH Mobile iroh Android app icon" width="72" height="72"></a><br>
  <a href="https://github.com/saya-ch/dsh-mobile-iroh/releases/download/android-v0.1.0-alpha.1/dsh-mobile-iroh-android-v0.1.0-alpha.1.apk"><strong>Download Android App 0.1.0-alpha.1</strong></a><br>
  <sub><a href="https://github.com/saya-ch/dsh-mobile-iroh/releases/tag/android-v0.1.0-alpha.1">Release notes and checksums</a></sub>
</p>

The project reuses DSH Mobile's mobile interface and pairing experience, with iroh carrying the connection between phone and computer: it attempts a direct connection and uses an available relay when direct connectivity is unavailable. You do not need to prepare a public domain, port forwarding, or another HTTPS tunnel first. DSH must still be running on the computer, and both networks must permit access to the required discovery and relay services.

Sessions, workspaces and tools still come from DSH on the computer. This project does not modify DSH Core or run a separate agent on the phone.

## Features

- **Use the DSH already running on your computer:** access its workspaces, sessions and plugin pages without copying session data.
- **Less tunnel configuration:** discover the computer and establish an encrypted connection through iroh without first setting up cpolar, cloudflared or a self-hosted reverse proxy.
- **Familiar mobile experience:** retain the touch interface, device list, startup preferences, web settings and native Back behavior.
- **QR pairing:** the App checks the computer identity and private certificate before saving device credentials.
- **Multiple computers:** assign local names, connect to the most recently used computer, pair again or remove a local record.
- **Cancellable connection recovery:** connection and reconnection have a cancel action and an overall time budget; recovery tries to preserve the current page and unsent draft.
- **Computer-side management:** open the manager from DSH General settings to start/stop connections, generate QR codes, view transport peers and revoke authorization.

## Quick start

### 1. Prepare your computer and phone

- Run official DSH Desktop or DSH Web on the computer, with **dsh-mobile 0.6.16** installed and enabled.
- This test version supports **Windows x64 and Linux x64 (glibc)** on the computer. The npm package includes the native transport executable; users do not need Rust. Alpine/musl builds are not included.
- Use **Android 10 or later**. The current APK includes arm64-v8a and x86_64; 32-bit devices are not supported.

The main Mobile plugin supplies the mobile frontend. You do not need to enable its LAN or remote channel separately for iroh. iroh has independent startup preferences, certificates and pairing records.

### 2. Install the computer plugin

**Official DSH Desktop:** install and enable `dsh-mobile-iroh@alpha` in plugin management, then open **Settings → General → DSH Mobile iroh → Open manager**.

**DSH Web:** use the current DSH CLI to install into the web profile:

```powershell
dsh plugin --profile web add dsh-mobile@0.6.16 dsh-mobile-iroh@alpha
```

Restart DSH normally if the installer requests it, then open the manager from General settings. Official Desktop manages its own profile; do not use the `--profile web` command to modify Desktop.

The manager connects to the current DSH automatically; there is no need to copy a DSH login token. Click **Start**, then generate a pairing QR code. Management listens only on the computer's loopback address, not on a public management endpoint.

### 3. Install the separate Android App

Download the release-signed APK using the link above or this repository's [Releases](https://github.com/saya-ch/dsh-mobile-iroh/releases). Install **DSH Mobile iroh**, not a replacement for the original DSH Mobile.

Local Debug and release packages have different signers and cannot directly overwrite one another. Future release upgrades must retain the release signer. Do not clear the original DSH Mobile's data to resolve a signing conflict.

## Pairing and connecting

1. Open the iroh manager on the computer, start the connection and generate a QR code.
2. In the separate App, choose **iroh connection (experimental) → Scan to pair**. You can also paste the full pairing information.
3. Name the computer after pairing, then enter DSH.
4. Open that computer from the paired-device list next time. Scanning again is unnecessary while its identity, certificate and authorization remain valid.

QR codes contain one-time credentials. Use them only between trusted computers and phones. Do not post an active QR, full pairing text or management login link in an issue.

iroh discovers the peer through a persistent computer identity, so an address change does not necessarily require pairing again. Network blocks, computer sleep or temporarily unavailable public services can still cause connection failures. Cancel and retry later; network failure is not reported as device removal.

## Device management

The **Paired devices** page lists saved computers. Tap an entry to connect; long-press or use its more button to rename, pair again or delete the local record. Names affect only this App.

Device-list settings offer two startup behaviors:

- **Open DSH directly:** try the most recently used computer, including when multiple computers are saved.
- **Show device list:** choose a computer whenever the App opens.

Inside DSH, use the web page's **Settings → General → Switch computer** to return to the list. Deleting a local record does not stop DSH on the computer or affect another phone.

After an online device is revoked on the computer, the App retains its entry and displays **Removed on computer**, with options to pair again or delete the local record. If only iroh transport authorization is revoked while the device is offline, its next connection may receive only a generic failure. This differs from Mobile Gateway device-token revocation; ordinary disconnection is not misreported as revocation.

## Relationship to DSH Mobile

| | DSH Mobile | DSH Mobile iroh |
| --- | --- | --- |
| Phone-to-computer connection | LAN or remote HTTPS entry | iroh direct/relay transport with internal HTTPS Gateway verification |
| Phone client | Android App or mobile browser | Separate Android App with native iroh transport |
| Mobile frontend | Supplied by the main Mobile plugin | Reuses the enabled main Mobile frontend |
| Pairing and state | Managed by the main plugin and original App | Stored separately; no automatic migration |
| Current role | Actively maintained main project | Independent testing path; future integration will be evaluated separately |

Ordinary DSH pages and loaded plugins still come from the current computer. The main Mobile custom-extension directory, running extension services and third-party WebSocket allow rules do not automatically synchronize to the independent Gateway. Not every community-plugin combination is promised to work without configuration. [Independent management and extensions](operator/README.md)

## Security and connection experience

iroh transport and Gateway authorization work at separate layers. In addition to the end-to-end encrypted connection, the App verifies the HTTPS hostname derived from the full computer identity and its pinned CA. Web requests remain subject to device sessions, Origin, CSRF and WebSocket path rules.

The App encrypts Mobile credentials with Android Keystore. Its long-term iroh identity key is stored in the backup-disabled, app-private directory and is not currently wrapped by hardware Keystore. A paired device can operate the computer's DSH and must be treated as fully trusted. Revoke the appropriate authorization if a phone is lost. [Security details](SECURITY.md)

A successful direct connection typically avoids a relay hop, but not every NAT, firewall or carrier permits it. Network policies can also affect public discovery and relay services. The manager reporting that the local service has started does not by itself establish public-network phone reachability.

## Compatibility

Current acceptance uses **official DSH Desktop / DSH 0.2.1-rc.2** and **dsh-mobile 0.6.16**. This initial version uses numeric-loopback HTTP for the DSH upstream inside the computer; phone-to-computer traffic remains encrypted. Arbitrary public URLs are not supported as forwarding targets.

The initial version has recovery limits: after a computer-side plugin hot update, the open page's module list may need a reload. An expired web session after extended use may also require reopening the computer from the device list. Neither requires pairing again. Save any draft before reopening.

Some real pairing, page-loading, reconnection and revocation checks have completed on an Android 16 phone using a cellular network. This does not cover every network, phone or third-party plugin. See [VERIFICATION](VERIFICATION.md) for recorded results and remaining work.

## Contributing

Clear reproduction steps, versions and network details are welcome, as are small, focused improvements. Hide QR codes, tokens, cookies, private keys and private session content when reporting a problem.

[Development and validation](CONTRIBUTING.md) · [Android builds](apps/mobile/README.md) · [Architecture](docs/ARCHITECTURE.md) · [Implementation progress](docs/IMPLEMENTATION_PLAN.md) · [Changelog](CHANGELOG.md)

The Rust baseline references [zexadev/dsh-tether](https://github.com/zexadev/dsh-tether); the mobile experience and code baseline come from [DSH Mobile](https://github.com/saya-ch/dsh-mobile); transport uses [iroh](https://github.com/n0-computer/iroh). Thanks to these open-source projects. Attribution and licenses are retained in [NOTICE](NOTICE), the [original MIT license](LICENSE.dsh-tether) and the [DSH Mobile Apache-2.0 license](LICENSE.dsh-mobile). Original code in this repository is available under [MIT](LICENSE); no upstream endorsement is implied.
