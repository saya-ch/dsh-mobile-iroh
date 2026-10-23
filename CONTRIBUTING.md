# Development and validation

Read [AGENTS.md](AGENTS.md), keep source work in this independent repository, and leave DSH Core and the main DSH Mobile checkout unchanged. Use owned isolated profiles for automated tests; changing a user's installed profile or restarting their Desktop requires explicit authorization. Preserve pairings, contribution history and imported licenses.

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

The installable companion and its independent App have separate release paths. Do not push, tag, publish npm/APK, change the main plugin or promote a signer/download descriptor unless that action is explicitly authorized. Integration into the main DSH Mobile project additionally requires the acceptance gates in [INTEGRATION_SEAM](docs/INTEGRATION_SEAM.md); publishing this independent alpha does not complete that integration.

### Installed companion acceptance

The package's [bundle patch](cordis.patch.yml) adds only `dsh-mobile-iroh`. It depends on the current profile's enabled main Mobile plugin for the frontend, without overriding its directory picker, remote channel or extension service. Use `dsh-mobile 0.6.16` for the current candidate. Native Host executables are selected from the package's hash-pinned manifest; the profile supplies the declared DSH/Cordis peers.

Build with `npm run build:client` before packing. The Client export must resolve to the generated `lib/client.js` factory, not the ESM source. With the isolated public runtime configured, run `node plugin/smoke-client-registry.mjs <installed-package-directory>` against the actual installed tarball to verify DSH's selected export and executable startup batch. Run `node plugin/smoke-managed-ui.mjs` for the automatic-Host management form; wire tests in `plugin/desktop-wire.test.mjs` cover official Desktop's streamed forwarding separately from ordinary browser POSTs.

For official Desktop acceptance, install the tested tarball through its supported plugin manager in an owned Desktop profile, restart normally if requested, and open **Settings → General → DSH Mobile iroh → Open manager**. Verify the loaded package/client bytes and native child ownership, then pair the independent App. Do not substitute a separate `dsh web` instance for this Desktop check or modify an unrelated profile. Record actual phone resources/API and network observations; a visible QR, local `ready` state or successful install alone is insufficient. No model request is required for this transport acceptance.

### Authorized release paths

Tag pushes do not publish anything. The [release workflow](.github/workflows/release.yml) runs only when explicitly dispatched against an existing version tag; it rechecks that exact source and retains the repository, version and signer gates:

```powershell
gh workflow run release.yml --repo saya-ch/dsh-mobile-iroh --ref npm-v0.1.0-alpha.1
gh workflow run release.yml --repo saya-ch/dsh-mobile-iroh --ref android-v0.1.0-alpha.1
```

The npm workflow requires this repository's own publishing authorization (`DSH_IROH_NPM_TOKEN` or a configured trusted publisher). Local `npm login` does not authorize GitHub Actions. When publishing locally, download the successful exact-candidate CI tarball, verify its SHA256, complete installed Desktop acceptance and publish that unchanged file with `npm publish <tested-tarball> --tag alpha --access public --ignore-scripts`. Run `node scripts/verify-published-npm.mjs <absolute-tested-tarball> <version>` afterward. For an independently accepted signed APK, create the matching `android-v...` GitHub Release and upload the same verified APK, checksum and notices; do not rebuild it between acceptance and upload. Keep product-alpha releases marked prerelease and do not deliberately promote subsequent alpha versions to `latest`.

The first `0.1.0-alpha.1` publication received both `alpha` and `latest` despite `--tag alpha`; the authenticated attempt to remove `latest` returned 400. This matches [npm's reported first-publication behavior](https://github.com/npm/cli/issues/8490). For this existing bootstrap only, the verifier accepts explicit `--allow-initial-latest` after checking the fixed first version, original alpha publish configuration, sole maintainer, limited version/tag set and unchanged artifact integrity. It reports the public aliases instead of claiming `latest` is absent. Default verification remains strict; later versions cannot use this exception. Do not create a fake stable release, unpublish the tested version or repeatedly request authentication to conceal the registry behavior.

Keep the independent Android keystore and its recovery backup outside the repository. [signing.json](apps/mobile/signing.json) pins its public certificate; it contains no signing secret. GitHub uses only `DSH_IROH_ANDROID_KEYSTORE_BASE64`, `DSH_IROH_ANDROID_KEYSTORE_PASSWORD`, `DSH_IROH_ANDROID_KEY_ALIAS` and `DSH_IROH_ANDROID_KEY_PASSWORD`. Never reuse the original DSH Mobile key, replace a lost signer silently, or uninstall a user's existing app to hide a signature mismatch. Verify each downloaded published APK with `apksigner verify --verbose --print-certs` and [the independent signer gate](scripts/verify-android-release.mjs).
