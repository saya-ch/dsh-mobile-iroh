# DSH Mobile iroh architecture

This independent repository implements an authenticated byte carrier and Android integration for the existing DSH Mobile Gateway. It does not implement DSH sessions, model requests, files or agent execution.

## Data path

```text
Android WebView / Java HTTPS
    │ full EndpointId-derived HTTPS authority; selected Gateway CA
Raw TCP listener / exact-authority CONNECT listener
    │ opaque TLS bytes
Authenticated iroh QUIC connection
    │ direct path or relay, subject to observed network reachability
Host sidecar
    │ one explicit loopback TCP target
DSH Mobile HTTPS Gateway
    │ existing device/session/CSRF/WebSocket policy
DSH Web backend
```

TLS terminates at the computer Gateway. A raw transport connection is not Mobile authorization. The phone stores no Gateway TLS private key, and the sidecar has no DSH launch-cookie injection operation.

The full EndpointId is encoded as two DNS labels under `.iroh.localhost`. A stable, explicit local port preserves Origin and browser storage; a bind conflict fails visibly instead of silently changing the page identity. Native Java uses a restricted CONNECT listener because its DNS behavior need not match Chromium's localhost handling.

## Components and ownership

| Component | Owns | Does not own |
| --- | --- | --- |
| Rust host | Endpoint key, pairing window, peer roster, one target, connections and streams | DSH API/session semantics or frontend rewriting |
| Android Rust/JNI | Phone endpoint, current request generation, raw/CONNECT listeners and shutdown lease | Gateway credentials or WebView navigation policy |
| Android Activity/controller | Descriptor validation, device records, Keystore credentials, current page and cancellation | Arbitrary native commands or hidden background connections to every listed device |
| JS sidecar supervisor | Child process, bounded stdio, readiness, stop and failure cleanup | Unauthenticated admin HTTP or model-visible pairing tools |
| Trusted host session | Identity resolution, Gateway/controller composition, serialized operator commands and injected preferences | Discovering a user's production profile or changing main-plugin providers |
| Independent operator | Loopback-only authenticated console, native non-secret settings, current-process upstream authorization and ordered close | An Internet-facing admin service, secret persistence or implicit profile discovery |
| Installed companion | Authenticated local launch route, General settings entry, packaged native resolver and an operator bound to the current DSH | A second `mobileAccess` service, another DSH process or automatic sharing of main-plugin extension resources |
| Native TLS manager | Persistent CA, exact-name leaf, atomic recovery journal and a writer lease held through Gateway activation | Installing a system CA or replacing corrupt credentials |
| Optional extension host | Public Mobile service in its own Cordis Context, explicit providers/local directory and ordered disposal | Automatic access to another DSH process's live services or all installed extensions |
| Mobile Gateway | Device tokens, sessions, CA-backed HTTPS, Host/Origin, CSRF and WSS route policy | iroh peer identity or automatic transport/device-ID association |

No mutable request owner may be replaced by a late result. Same-peer reconnect generations and Android cancellations retain ownership until their listeners/tasks have actually stopped.

## Protocols

[Host protocol documentation](../host/README.md) and the shared Rust decoder define the actual wire messages. Version 1 accepts Pair/Hello and their explicit success/failure replies; each proxy stream starts with its bounded versioned discriminator. It does not forward standalone approvals or decisions. QUIC authenticates the peer and protects the transport; the early signed-envelope demo in `experiments/identity` is not used here.

The trusted parent speaks strict, bounded JSON-lines stdio. Pairing codes appear only in the owning operator's intentional private response. Logs and ordinary status omit codes, tokens, cookies, TLS keys and payload bytes. A write/revoke failure or uncertain operator timeout is not automatically retried as if it had failed before execution.

## Storage

Host identities and peer lists fail closed when corrupt, unreadable or unsafe. Windows uses creation-time private DACLs and verified non-reparse handles. Unix uses private owner/mode checks and descriptor-relative operations without changing existing directory permissions. The parent owns a profile lock and may not run another host against its live profile.

Android keeps its own app sandbox. Normal Gateway credentials use Keystore encryption; the iroh identity is currently an app-private native file. Imported production-App data is not automatically moved into the experimental package.

Fixed native operator files separately store enabled intent and non-secret upstream Origin/local port. The authorization URL never enters those files. Managed TLS keeps a persistent CA and exact-name leaf in private state; a journal validates interrupted known transactions without regenerating corrupt state. The TLS writer lease remains held through public Gateway start/refresh, excluding a second native writer while files are activated. Refresh failure leaves the old live secure context and sessions intact; explicit retry rereads durable state.

The independent console owns its HTTP server, not the user's DSH process. A single-use fragment becomes a bounded HttpOnly/SameSite session plus CSRF secret; numeric loopback, Host, Origin and body validation remain mandatory. Hiding the browser cancels its displayed pairing window without stopping existing phones. Terminal shutdown closes Gateway consumers before extension services and native stores; failed cleanup retains an owner for retry.

## Integration and acceptance

Main DSH Mobile currently has a closed provider set. [The integration design](INTEGRATION_SEAM.md) identifies the changes that require a separate main-repository review: provider registration, lifecycle/admin UI, device-revocation association, Android metadata, ABI support and signing. The independent operator API and factory do not mean these changes are already integrated.

The companion installs as its own bundle entry. Its public settings action opens a numeric-loopback operator after authenticating with the current DSH connection service. The main Mobile service is only an availability dependency for the mobile frontend; the operator owns a separate extension Context. A single disposer stops route admission, drains admitted work, then closes its operator and transport owners. Native Windows/Linux files are bundled and checked against a versioned size/SHA-256 manifest before execution.

[VERIFICATION](../VERIFICATION.md) records executed gates and their limits. Local QUIC, a real public Gateway package, desktop Chromium, Java HTTPS, JVM tests, Android compilation and physical-device/network tests are different evidence. CI definitions are not passing remote CI runs.
