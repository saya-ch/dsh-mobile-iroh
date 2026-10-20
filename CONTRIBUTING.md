# Development and validation

Read [AGENTS.md](AGENTS.md), keep work in this independent repository, and leave DSH Core, the main DSH Mobile checkout and installed profiles unchanged. Preserve pairings, contribution history and imported licenses.

## Source checks

Use the Node engine range in [package.json](package.json). Current local Rust verification uses 1.99.1; Cargo.lock selects the exact transport dependencies. Do not update dependencies merely to get a failing test to pass.

```powershell
npm test
npm run check:docs
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build --locked -p dsh-mobile-iroh-host -p dsh-mobile-iroh-transport-sim
npm run smoke:iroh
```

Tests cover JavaScript controllers, QR descriptors, the build verifier, Rust control/authorization/resource ownership and process exit. Windows tests create only explicitly owned home-directory children through the private-state constructor; broad Temp/AppData ACLs are not exceptions. Never reset an existing user directory's ACL or replace an unreadable identity with a new one.

## Real Gateway and browser checks

Install an isolated runtime; these are dependency files, not a normal DSH profile. No model or user conversation is used.

```powershell
$irohIntegrationRuntime = Join-Path $env:TEMP ('iroh-gateway-runtime-' + [Guid]::NewGuid().ToString('N'))
npm install --prefix $irohIntegrationRuntime --no-save --ignore-scripts @deepseek-ai/dsh@0.2.1-rc.2 dsh-mobile@0.6.13 playwright@1.63.0
$env:DSH_MOBILE_MODULE = Join-Path $irohIntegrationRuntime 'node_modules/dsh-mobile/lib/index.mjs'
& (Join-Path $irohIntegrationRuntime 'node_modules/.bin/playwright.cmd') install chromium --only-shell
npm run smoke:gateway
```

On POSIX, use the corresponding Playwright executable without `.cmd`. Install Chromium's OS dependencies where required.

The fixture starts a real public Mobile Gateway and the actual Android transport crate through [transport-sim](test-support/transport-sim/src/main.rs). Same-machine acceptance uses `::1` for the host and `127.0.0.1` for the phone, both on the logical port, preserving the existing Gateway port validation. It exercises native pairing, authenticated HTTP, CSRF/Host/Origin rejection, wrong CA/name, WSS frames/route rejection, revocation, Java CONNECT and Chromium `.localhost`/Cookie behavior.

The owned Chromium context allows only the generated fixture certificate's SPKI. Separate Node/Java checks validate the CA and hostname normally; no production verifier or system trust store is changed. This is not a real DSH frontend/Activity or public-network result.

`--tcp-only` retains a controlled TCP carrier for diagnosis; it is not QUIC evidence. The first-party smoke uses explicit loopback EndpointAddr; the external reference smoke is separate and never substitutes for current-source validation.

## Android

Follow [the app guide](apps/mobile/README.md). Native builds require an explicit NDK and inspect ELF architecture, JNI exports, 16 KB LOAD/RELRO and APK ZIP alignment. JVM tests do not establish Android runtime initialization, keyboard, cancellation, Back or sleep/network-switch behavior on a device.

The independent release signer uses only `DSH_IROH_ANDROID_KEYSTORE_FILE`, `DSH_IROH_ANDROID_KEYSTORE_PASSWORD`, `DSH_IROH_ANDROID_KEY_ALIAS` and `DSH_IROH_ANDROID_KEY_PASSWORD`. Do not pass the production DSH Mobile signer to an experimental build. Without all four values the Release APK remains unsigned; do not distribute it as a signed release.

ADB work identifies serial/package/signer/WebView first, preserves the production App, never clears data to bypass a signer mismatch and only touches explicitly owned test records. No device is currently required for ordinary source checks; missing device evidence must remain visible.

## Integration and publication

[CI](.github/workflows/ci.yml) defines Windows/Linux and native Android jobs. A workflow file is not a passing run. Keep source checks, built artifacts, local QUIC, Android/JNI, physical devices and public topology distinct.

This repository is unpublished. Do not push, tag, publish npm/APK, change the main plugin or promote a signer/download descriptor unless that action is explicitly authorized. Production integration additionally requires the acceptance gates in [INTEGRATION_SEAM](docs/INTEGRATION_SEAM.md).
