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
npm install --prefix $irohIntegrationRuntime --no-save --ignore-scripts @deepseek-ai/dsh@0.2.1-rc.2 dsh-mobile@0.6.16 playwright@1.63.0
$env:DSH_MOBILE_MODULE = Join-Path $irohIntegrationRuntime 'node_modules/dsh-mobile/lib/index.mjs'
$env:DSH_IROH_DSH_BIN = Join-Path $irohIntegrationRuntime 'node_modules/@deepseek-ai/dsh/lib/bin.js'
& (Join-Path $irohIntegrationRuntime 'node_modules/.bin/playwright.cmd') install chromium --only-shell
npm run smoke:gateway
```

On POSIX, use the corresponding Playwright executable without `.cmd`. Install Chromium's OS dependencies where required.

The fixture starts a real public Mobile Gateway and the actual Android transport crate through [transport-sim](test-support/transport-sim/src/main.rs). Same-machine acceptance uses `::1` for the host and `127.0.0.1` for the phone, both on the logical port, preserving the existing Gateway port validation. It exercises native pairing, authenticated HTTP, CSRF/Host/Origin rejection, wrong CA/name, WSS frames/route rejection, revocation, Java CONNECT and Chromium `.localhost`/Cookie behavior.

The owned Chromium context allows only the generated fixture certificate's SPKI. It maps only that fixture's generated hostname to the phone's IPv4 bridge and checks the actual remote socket, so the same-PC host's IPv6 listener cannot satisfy the browser assertion directly. Separate Node/Java checks validate the CA and hostname normally; no production verifier, system resolver or trust store is changed. This Gateway probe is not a real DSH frontend/Activity or public-network result. Earlier unpinned Chromium routing established Origin/Cookie behavior, not its QUIC path; see [the correction](VERIFICATION.md#browser-transport-path-correction).

`--tcp-only` retains a controlled TCP carrier for diagnosis; it is not QUIC evidence. The first-party smoke uses explicit loopback EndpointAddr; the external reference smoke is separate and never substitutes for current-source validation.

### Full DSH frontend

With both absolute artifact paths set, `npm run smoke:dsh-frontend` starts a fresh supported `dsh web` profile and installs the exact public Mobile version through `dsh plugin`. The profile, copied package store, npm configuration, workspaces, sessions and credentials belong to the fixture. Its ordinary Mobile listener stays disabled; the independent iroh Gateway is the phone entry. No user profile, API key, model request or upstream source edit is involved.

The browser is routed only to the fixture phone bridge, with its remote address asserted. The check opens a real Workspace and Session, selects an owned model, verifies module exclusions/dependencies and authenticated extension routes, extracts an exported ZIP, and enters an unsent draft. An explicit non-secret dummy credential enables the owned catalog; its provider points only to a loopback request-counting/rejecting sink, and both prompt and upstream model-request counters must stay zero. It stops and restarts the actual Android transport crate through transport-sim, requiring the live old mux to close, a different real mux and a new Workspace baseline while the document, editor and draft remain. It then checks revoked-device rejection. The ZIP assertion uses the authenticated export API; an empty Session intentionally hides the native header menu, so this is not UI-menu acceptance. Known initial DSH dialogs are dismissed through their normal actions; arbitrary dialogs are not hidden. All process closes are awaited before removing links and owned files; an unconfirmed process close retains the root for diagnosis. This remains desktop Chromium and local direct QUIC, not Android Activity or real NAT/relay acceptance.

## Android

Follow [the app guide](apps/mobile/README.md). Native builds require an explicit NDK and inspect ELF architecture, JNI exports, 16 KB LOAD/RELRO and APK ZIP alignment. JVM tests do not establish Android runtime initialization, keyboard, cancellation, Back or sleep/network-switch behavior on a device.

The independent release signer uses only `DSH_IROH_ANDROID_KEYSTORE_FILE`, `DSH_IROH_ANDROID_KEYSTORE_PASSWORD`, `DSH_IROH_ANDROID_KEY_ALIAS` and `DSH_IROH_ANDROID_KEY_PASSWORD`. Do not pass the production DSH Mobile signer to an experimental build. Without all four values the Release APK remains unsigned; do not distribute it as a signed release.

ADB work identifies serial/package/signer/WebView first, preserves the production App, never clears data to bypass a signer mismatch and only touches explicitly owned test records. No device is currently required for ordinary source checks; missing device evidence must remain visible.

## Host startup preferences

The trusted in-process owner can use [NativePreferenceStore](integration/native-preference-store.mjs) with [HostSession](integration/host-session.mjs). Both receive the absolute first-party executable and an explicitly owned private data directory. The native commands operate only on fixed `operator-state.json` and its separate lease; they do not expose arbitrary file access or acquire the active sidecar's `host.lock`.

```javascript
const store = new NativePreferenceStore({ executable, dataDirectory })
const session = createHostSession({
  mobile, executable, dataDirectory, store, tls,
  upstreamOrigin, upstreamAuthenticatedUrl,
})
try {
  await session.restore()
  // A trusted operator may explicitly call start(), stop() or openPairing().
} finally {
  await session.close()
  await store.close()
}
```

`restore()` honors the saved boolean; an absent preference is disabled. `start()` explicitly enables, `stop()` saves disabled, and `close()` retains the preference. Invalid versions/fields, corrupt files, unsafe permissions or links fail closed without repair. The store remains a separate owner: if closing the session fails, retain both owners and retry cleanup before removing their files. A cancelled save can have reached its atomic commit before acknowledgement; it is not rollback. Do not replay it automatically: an explicit restore can reread the durable outcome.

`smoke:host-session` exercises the real native store with fresh Host owners, including disabled restore, while retaining identity, CA and Origin. Its explicit fixture TLS remains separate from the managed-TLS smoke; neither establishes physical Android/public-network acceptance.

## Managed TLS and operator

[NativeTlsManager](integration/native-tls-manager.mjs) prepares fixed private CA/leaf files through the first-party executable. Pass `tlsManager` instead of `tls` to `createHostSession`; exactly one mode is required. A managed implementation must implement `withPrepared` and `withRenewed` callbacks, holding its native writer lease through Gateway start or `refreshProvidedTls()`. `prepare()`/`renew()` alone are not sufficient to prevent another local writer replacing files before activation.

```powershell
npm run smoke:managed-tls
npm run smoke:operator-ui
npm run smoke:operator-runtime
npm run operator -- --mobile-module C:/absolute/runtime/node_modules/dsh-mobile/lib/index.mjs --executable C:/absolute/dsh-mobile-iroh-host.exe
```

The TLS smoke exercises the actual public Gateway through QUIC, CA/name rejection, existing Cookie/WSS preservation across leaf refresh and explicit recovery after rejected material. The UI smoke uses an injected controlled owner for interaction/layout checks. `smoke:operator-runtime` separately composes the real CLI bootstrap, browser console, native configuration/preference/TLS, Host, actual Android transport crate and public DSH frontend. It verifies an unused old Gateway pairing token is invalidated when the QR is cancelled, a new QR works, TLS refresh preserves a live mux, and a fresh owner retains the non-secret port but not authorization. These remain host-driven, not physical Android, results. [Operator documentation](operator/README.md) describes authenticated local startup and cleanup.

[createExtensionHost](integration/extension-host.mjs) uses the public Mobile service and Cordis Context resolved from the same installed artifact. Providers are explicit; `localDirectory` never defaults to a production profile or guessed directory. Close Gateway consumers before the extension host; failed `stopLocal()` retains the Context for retry.

## Dependency and artifact checks

`npm run check:licenses` runs locked/offline Cargo metadata and writes a conservative source-dependency/license inventory under ignored `artifacts/security/`. It follows all resolved edges, including build/target-only packages; it is not an APK/host binary SBOM, SPDX-expression interpretation or distribution approval. Review full notice obligations and Maven/Node artifacts separately before distribution. Preserve the RustSec scan's database revision, exact lock hash, command and nonzero warnings; never add ignores merely to obtain a green report.

## Integration and publication

[CI](.github/workflows/ci.yml) defines Windows/Linux and native Android jobs. A workflow file is not a passing run. Keep source checks, built artifacts, local QUIC, Android/JNI, physical devices and public topology distinct.

This repository is unpublished. Do not push, tag, publish npm/APK, change the main plugin or promote a signer/download descriptor unless that action is explicitly authorized. Production integration additionally requires the acceptance gates in [INTEGRATION_SEAM](docs/INTEGRATION_SEAM.md).
