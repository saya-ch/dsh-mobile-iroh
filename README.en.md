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
- Android JNI, cancellation ownership, a raw TLS listener and a strict HTTPS CONNECT bridge. Integrated pairing/device UI remains subject to its recorded validation.
- Real local QUIC plus HTTP, WSS, TLS rejection, Java HTTPS and Chromium Origin checks.

[VERIFICATION](VERIFICATION.md) distinguishes these results from physical Android, public NAT/relay, formal signing and production support.

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

The [Android app](apps/mobile/README.md) uses the separate ID `io.github.sayach.dshmobileiroh`. Native builds explicitly opt in with `-PirohNative=true` and currently contain arm64-v8a/x86_64 only; this is not an all-device replacement for the production app.

The computer side currently exposes an in-process operator API and isolated acceptance scripts. A developer must wire it and provide TLS material; an ordinary-user desktop pairing GUI and automatic certificate setup are not implemented.

## Limits and attribution

No npm package, APK or Release is published. The main DSH Mobile provider list is closed; future integration needs the explicit seams in [the integration plan](docs/INTEGRATION_SEAM.md), not an unreviewed patch.

Rust reference work from [zexadev/dsh-tether](https://github.com/zexadev/dsh-tether) retains its MIT notice. The Android baseline from [saya-ch/dsh-mobile](https://github.com/saya-ch/dsh-mobile) retains Apache-2.0. See [NOTICE](NOTICE), [reference license](LICENSE.dsh-tether), [Android baseline license](LICENSE.dsh-mobile) and [root MIT license](LICENSE). No endorsement is implied.

The historical signed-envelope HTTP experiment lives in [experiments/identity](experiments/identity/README.md), not the real QUIC implementation. `smoke:reference` exercises an external reference artifact and is not first-party acceptance.
