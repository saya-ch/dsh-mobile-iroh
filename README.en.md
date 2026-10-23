# DSH Mobile iroh

An independent iroh transport companion that preserves the DSH Mobile pairing, device-management and WebView experience.

[简体中文](README.md) · [Development](CONTRIBUTING.md) · [Verification](VERIFICATION.md) · [Security](SECURITY.md) · [Integration plan](docs/INTEGRATION_SEAM.md)

> **Experimental and unpublished.** This project does not replace the existing DSH Mobile app, migrate its data, modify DSH Core or silently enable a new provider.

## Architecture

The phone forwards HTTPS/WSS bytes over authenticated iroh QUIC to a computer-side, loopback-only Mobile Gateway. TLS terminates at that gateway. Device tokens, Session Cookies, exact Host/Origin, CSRF and WebSocket route policy stay with DSH Mobile; the sidecar neither injects a DSH launch Cookie nor rewrites frontend bundles.

A full EndpointId becomes two DNS-safe labels in `https://<first32>.<last32>.iroh.localhost:25443`. Different computers keep distinct browser storage identities. The configured local port is stable; collision is a visible error, not an implicit random-Origin migration.

## Implemented layers

- First-party Rust host: durable identity/pairing, peer roster, revocation, reconnect replacement and raw TCP/TLS proxying to an explicit loopback socket.
- Versioned, bounded messages; connection/stream budgets; fail-closed state; owned shutdown.
- Private Unix state and Windows creation-time DACLs, existing-file checks, reparse rejection and a deletion-protected active profile lock.
- Public Mobile Gateway factory and an independent provider lifecycle, without changing the main plugin.
- Persistent native CA/leaf provisioning, exact EndpointId hostname certificates and scheduled leaf renewal through the public Gateway TLS-refresh method.
- A loopback-only browser operator console for configuration, start/stop/reconnect, QR pairing, transport peers and certificate status, protected by a single-use login, session and CSRF checks.
- An optional independent extension host for explicit providers or a selected local extension directory, not automatic replication of a DSH profile.
- Native private storage for the Host startup preference; explicit restore preserves a disabled choice instead of enabling a gateway merely because the owner was reconstructed.
- Android JNI, cancellation ownership, a raw TLS listener and a strict HTTPS CONNECT bridge. Integrated pairing/device UI remains subject to its recorded validation.
- Real local QUIC plus HTTP, WSS, TLS rejection, Java HTTPS and Chromium Origin checks.

[VERIFICATION](VERIFICATION.md) distinguishes these results from physical Android, public NAT/relay, formal signing and production support.

An Android 16 phone on a cellular network has completed pairing, real DSH page loading, saved-device reconnection, cancellation and online revocation checks. Failure recovery remains under development; there is no production App release or main-plugin integration.

## Development

```powershell
npm test
npm run check:docs
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build --locked -p dsh-mobile-iroh-host -p dsh-mobile-iroh-transport-sim
npm run smoke:iroh
```

Set `DSH_MOBILE_MODULE` to an isolated installed public Mobile module's absolute `lib/index.mjs` path before `npm run smoke:gateway`. That check uses the actual Android transport crate through a host test driver, a pinned CA, Chromium and standard Java HTTPS; it does not execute an Android Activity. Setup is documented in [CONTRIBUTING](CONTRIBUTING.md).

`npm run smoke:dsh-frontend` additionally requires `DSH_IROH_DSH_BIN`, the absolute isolated DSH CLI entry. It loads the real frontend and checks model selection, module rules, authenticated extensions, ZIP export and retained Session/draft across transport restart without model requests. See [its scope](CONTRIBUTING.md#full-dsh-frontend).

## Computer operator console

After building the sidecar, select an explicit public Mobile module:

```powershell
npm run operator -- --mobile-module C:/path/to/runtime/node_modules/dsh-mobile/lib/index.mjs --executable C:/path/to/dsh-mobile-iroh-host.exe
```

The console listens only on `127.0.0.1`; it is not a public admin endpoint. Enter the current loopback DSH authorization URL, start the host, and generate a QR. The full authorization URL remains in process memory and must be supplied again after restarting the operator. Non-secret origin, stable local port and local-only testing preference persist separately. Never post the console's login fragment or pairing QR in an issue.

State defaults to `.dsh-mobile-iroh` under the user home; `--data-dir` selects another private directory. `--no-open` prints the single-use login URL only to an interactive terminal. Ctrl-C closes owned runtime resources without deleting pairings; closing the browser tab does not stop a connected phone. See [operator details](operator/README.md).

Extensions require an explicit provider or `--extensions-dir`. The console does not copy installed extensions from a normal DSH profile or supply its in-process Core services. Extensions needing those services require explicit adaptation; this is not an all-plugin compatibility promise.

The [Android app](apps/mobile/README.md) uses the separate ID `io.github.sayach.dshmobileiroh`. Native builds explicitly opt in with `-PirohNative=true` and currently contain arm64-v8a/x86_64 only; this is not an all-device replacement for the production app.

The embedded operator API uses the native preference store and `restore()` to honor the saved choice across Host owners. `start()` explicitly enables, `stop()` durably disables, and `close()` unloads without deleting identity or pairings. The console never auto-starts without current authorization. See [operator wiring](CONTRIBUTING.md#host-startup-preferences).

## Limits and attribution

No npm package, APK or Release is published. The main DSH Mobile provider list is closed; future integration needs the explicit seams in [the integration plan](docs/INTEGRATION_SEAM.md), not an unreviewed patch.

Rust reference work from [zexadev/dsh-tether](https://github.com/zexadev/dsh-tether) retains its MIT notice. The Android baseline from [saya-ch/dsh-mobile](https://github.com/saya-ch/dsh-mobile) retains Apache-2.0. See [NOTICE](NOTICE), [reference license](LICENSE.dsh-tether), [Android baseline license](LICENSE.dsh-mobile) and [root MIT license](LICENSE). No endorsement is implied.

The historical signed-envelope HTTP experiment lives in [experiments/identity](experiments/identity/README.md), not the real QUIC implementation. `smoke:reference` exercises an external reference artifact and is not first-party acceptance.
