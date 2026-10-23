# Future DSH Mobile integration

The independent repository owns implementation and acceptance until integration is deliberately authorized. No main-repository code or installed DSH frontend is changed by this work.

## Transport model

1. The host creates a dedicated HTTPS Mobile Gateway with its own persisted CA/device state and an identity-derived DNS SAN.
2. The sidecar accepts only paired iroh EndpointIds and proxies raw bytes to that one loopback socket.
3. Android binds a stable local TCP port. Chromium resolves the full host identity under `.iroh.localhost`; TLS terminates on the computer, not on the phone.
4. Native Java HTTPS uses a separate strict local CONNECT listener to avoid platform DNS differences. Its target must equal the selected peer authority.
5. Existing device-token, Session Cookie, CSRF and WSS route authorization remain with Mobile Gateway.

Neither sidecar may inject a DSH launch Cookie, rewrite frontend constants, expose arbitrary target addresses or treat a loopback URL as the trusted webpage Origin.

## Main-plugin seam

The existing main-plugin RemoteProvider is a closed union and its controller table is not a dynamic third-party registry. A future integration needs an explicitly reviewed provider declaration, configuration, status/admin handling and lifecycle registration. The independent [IrohRemoteController](../src/iroh-remote-controller.mjs), [host operator API](../integration/host-session.mjs) and [Gateway factory](../integration/mobile-gateway-factory.mjs) are the parts to connect; they are not already registered in the main plugin.

The independent Host persists its enabled preference through [NativePreferenceStore](../integration/native-preference-store.mjs), non-secret configuration through [NativeConfigStore](../integration/native-config-store.mjs), and TLS through [NativeTlsManager](../integration/native-tls-manager.mjs). Their fixed native state has separate leases from the running transport. `restore()` honors the saved choice without enabling an off gateway; `start()` is explicit enable, `stop()` is durable disable, and `close()` retains the preference. The independent [operator](../operator/README.md) composes these owners; main-plugin settings registration remains separate integration work.

The Gateway factory uses public exports. It must preserve required/dependency module rules, shared upstream authentication ownership, per-device HTTP authorization and existing provider behavior. Its fixed logical authority port currently also determines the backend listener port; do not bypass parseGatewayConfig to change that invariant.

## Android seam

Keep the existing package, Keystore, paired records, startup preference, page identity, cancellation and signer during a separately reviewed main-App integration. New transport metadata must be optional/versioned; HTTPS/LAN/remote records must remain readable without migration guesses.

A saved iroh record needs its full peer identity, stable logical Origin/port and normal Mobile credential. Neither short pairing code nor the whole QR is a persistent credential. Cancel before replacing a transport; a late result must not restore an old page or close the new computer. A network error is not device revocation.

The independently signed alpha package `io.github.sayach.dshmobileiroh` is separate from the main App. No automatic cross-package data transfer is implemented; its signer and release tags remain independent.

## QR and trusted operator

[Descriptor v1](../integration/pairing-descriptor.mjs) contains exactly the version/type, full endpoint identity, logical HTTPS Origin and local port, short iroh code, one-time Gateway token, public CA, CA fingerprint and expiry. It is short-lived, limited to 2200 UTF-8 bytes and validated before use. The operator smoke encodes both the actual descriptor and the byte limit as real byte-mode/M-correction QR symbols. Scanning is the user's out-of-band trust action; a self-signed certificate is not independent evidence that an untrusted QR belongs to the intended computer.

Only a trusted host operator may open a pairing window. The embedded API is in-process; the independent browser console adds a numeric-loopback-only, single-use-login/session/CSRF-protected adapter. The installed companion reuses the current Desktop/Web connection service to authenticate a local launch action and keeps upstream authorization in memory. This existing companion is distinct from a future provider merged into the main Mobile plugin. Cancelling a displayed QR replaces both one-time windows without returning their replacements; already paired phones remain connected.

## TLS and extension owners

Managed TLS uses a persistent native CA, a 90-day exact-name leaf and renewal before 30 days remain. The native writer lease spans file preparation and the public Gateway `refreshProvidedTls()` call. A failed refresh preserves the previous active secure context and reports an error; a cancelled atomic write is not described as rollback. Corrupt or unknown material is not regenerated automatically. No system trust store changes are needed.

The optional [extension host](../integration/extension-host.mjs) creates a public Mobile service in its own Cordis Context. Explicit providers and an explicit local extension directory are supported, including the public worker mode. It does not mirror a normal DSH profile or supply that process's Core services. Main-plugin integration must use the existing public service owner when appropriate, preserve its lifecycle and avoid double registration. Gateway consumers close before extension effects are disposed.

## Remaining security/product decisions

- Transport-peer revocation and Mobile device-token revocation are separate authorization layers. Their cross-layer association and unified desktop management need an explicit public interface; opaque TLS proxying cannot infer a Mobile device ID from encrypted bytes.
- Direct/relay deployment defaults and diagnostics require real topology evidence.
- A non-empty independent extension manifest and authenticated routes are tested; this does not establish compatibility with every extension or a replacement for a live DSH Context.
- Android long-term endpoint identity is currently app-private state; hardware-backed Keystore wrapping is a separate hardening decision, not an already implemented guarantee.
- Preserve imported Apache-2.0/MIT notices and validate final native dependencies/signing before binary distribution.

Do not merge around an absent seam by modifying DSH Core, rewriting a bundle, trusting forwarded identity headers or silently changing user Origin/storage.
