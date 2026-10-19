# DSH Mobile iroh

An independent, experimental transport companion for DSH Mobile. The project
uses iroh's end-to-end encrypted QUIC transport to connect a phone-side client
to a computer running DeepSeek Harness while preserving the DSH Web experience.

The repository is being built in stages. The current main branch contains the
host-side concept-validation foundation, an imported Rust sidecar baseline, and
an independent Android WebView baseline. The production plugin, native Android
iroh transport, and release artifacts are not claimed complete yet.

The Android baseline lives in [`apps/mobile`](apps/mobile/README.md). Its
package ID is separate from DSH Mobile so it can be installed for development
without replacing the existing app.

Implementation rules and local checks are in
[`CONTRIBUTING.md`](CONTRIBUTING.md); current work is tracked in
[`CHANGELOG.md`](CHANGELOG.md).

This is an independent host-side experiment inspired by the public [`zexadev/dsh-tether`](https://github.com/zexadev/dsh-tether) project. It is intentionally outside the main `dsh-mobile` repository and DeepSeek Harness: it contains no production plugin, bundled mobile client, model integration, credentials, or upstream source changes.

## Rust host-side baseline

`Cargo.toml`, `host/`, and `tether-core/` form an independent Cargo workspace.
The baseline carries the reference host's endpoint identity persistence,
one-time pairing window, paired-peer registry, approval stdio JSON-lines
protocol, and explicitly configured loopback proxy stream. It is renamed to
`dsh-mobile-iroh-host` / `dsh-mobile-iroh-core` and uses the
`dsh-mobile-iroh/0` ALPN so it does not silently identify itself as the
reference project's protocol.

This is source-level import and adaptation evidence only. The current Windows
workspace now passes `cargo check --workspace`, `cargo test --workspace`, and
`cargo fmt --all -- --check`. Those checks do not establish production
readiness, Android integration, public-network behavior, or release-artifact
support.

The imported portions remain covered by the MIT license and are attributed in
[`NOTICE`](NOTICE). The adaptation is not an upstream endorsement.

The shared Rust `android-transport` crate now owns the endpoint, versioned
pairing handshake, and loopback byte proxy. JNI/Android packaging and WebView
integration are still separate gates.

## What the JavaScript PoC proves

The PoC creates an Ed25519 endpoint identity, derives a stable endpoint identifier from its public key, signs a request envelope, verifies that signature at a local gateway, and forwards the request only to an explicitly registered HTTP loopback target. `npm test` also proves that a modified nonce is rejected and that non-loopback targets cannot be registered.

Run it from this directory:

```powershell
npm test
npm run demo
npm run smoke:iroh
```

The demo output includes the generated endpoint id, the loopback mapping, and the local response. The key pair is generated in memory and discarded on exit.

`smoke:iroh` is a separate host-side check for the published `dsh-tether` Windows sidecar. It starts an isolated host and `phone-sim`, performs real iroh pairing, proxies one request to a loopback HTTP server, and completes one approval round trip. Set `TETHER_HOST_BIN` to another `tether-host` binary when testing a different build. A result of `blocked` means iroh could not obtain endpoint addressing or relay discovery in the current network; it is not a passing transport result and must not be reported as successful connectivity.

## Security and acceptance limits

- The JavaScript PoC is identity and mapping validation, not iroh. The Rust
  sidecar baseline includes the host-side iroh implementation, but it has not
  been compiled or exercised in this environment and does not establish
  endpoint discovery, hole punching, NAT traversal, relay fallback, pairing UX,
  Android packaging, or production authorization.
- The optional `smoke:iroh` check uses the separately downloaded, published `zexadev/dsh-tether` sidecar; it does not add that implementation to this PoC or to `dsh-mobile`.
- All traffic stays on `127.0.0.1`; a passing test does not demonstrate cross-network connectivity, relay confidentiality, or production authorization.
- The gateway uses an in-memory allow-list and a simple signed request. A production design needs authenticated pairing, replay protection with durable nonce handling, least-privilege route policy, TLS/session encryption, rate limits, audit logging, and careful process isolation.
- `localhost` is accepted as a loopback spelling for this local experiment; production code should resolve and enforce addresses explicitly to avoid DNS rebinding concerns.
- No claim is made about `zexadev/dsh-tether` implementation correctness or upstream endorsement; its README was used only to identify the endpoint/pairing and local-gateway problem framing.
