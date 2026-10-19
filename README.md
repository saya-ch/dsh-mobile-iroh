# DSH Mobile iroh

An independent, experimental transport companion for DSH Mobile. The project
uses iroh's end-to-end encrypted QUIC transport to connect a phone-side client
to a computer running DeepSeek Harness while preserving the DSH Web experience.

The repository is being built in stages. The current main branch contains the
host-side concept-validation foundation and an independent Android WebView
baseline. The production plugin, native Android iroh transport, and release
artifacts are not claimed complete yet.

The Android baseline lives in [`apps/mobile`](apps/mobile/README.md). Its
package ID is separate from DSH Mobile so it can be installed for development
without replacing the existing app.

This is an independent host-side experiment inspired by the public [`zexadev/dsh-tether`](https://github.com/zexadev/dsh-tether) project. It is intentionally outside the main `dsh-mobile` repository and DeepSeek Harness: it contains no production plugin, bundled mobile client, model integration, credentials, or upstream source changes.

## What this proves

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

- This is identity and mapping validation, not iroh. It does not implement iroh transports, endpoint discovery, hole punching, NAT traversal, relay fallback, encryption framing, pairing UX, persistence, or mobile packaging.
- The optional `smoke:iroh` check uses the separately downloaded, published `zexadev/dsh-tether` sidecar; it does not add that implementation to this PoC or to `dsh-mobile`.
- All traffic stays on `127.0.0.1`; a passing test does not demonstrate cross-network connectivity, relay confidentiality, or production authorization.
- The gateway uses an in-memory allow-list and a simple signed request. A production design needs authenticated pairing, replay protection with durable nonce handling, least-privilege route policy, TLS/session encryption, rate limits, audit logging, and careful process isolation.
- `localhost` is accepted as a loopback spelling for this local experiment; production code should resolve and enforce addresses explicitly to avoid DNS rebinding concerns.
- No claim is made about `zexadev/dsh-tether` implementation correctness or upstream endorsement; its README was used only to identify the endpoint/pairing and local-gateway problem framing.
