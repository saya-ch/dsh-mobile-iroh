# Security

This is an unpublished experiment. Report suspected security defects privately through the repository's GitHub security channel when available; do not post keys, QR descriptors, device tokens or user conversations in public issues.

## Trust and authorization

- iroh authenticates transport endpoints and encrypts QUIC. A short, one-time code admits a peer during a bounded pairing window; a public EndpointId alone grants nothing.
- HTTPS remains end to end between the phone and the dedicated Mobile Gateway. Its CA/name pin, device tokens, sessions, exact Host/Origin, CSRF and WebSocket route policy remain active.
- The sidecar forwards only to one operator-configured loopback socket. It does not inject DSH credentials, choose a peer-supplied target, parse/rewrite TLS payloads or patch DSH source.
- The native CONNECT bridge accepts only the selected peer's exact logical authority, has bounded headers/time/streams and does not enable Android cleartext browsing.
- Unknown protocol fields/versions, invalid names/routes and corrupt or unreadable durable state fail closed. Old state is not replaced with a new identity to hide a read failure.

## Private state

Unix state uses private modes. Windows creates directories/files with protected owner/SYSTEM/Administrators DACLs before writing secrets, verifies existing owners/ACLs on non-reparse handles and rejects unsafe ancestors. It does not broadly repair a user's existing directory.

The active Windows profile lock cannot be deleted/renamed while held. Private regular-file reads and leases reject hard links as well as reparse paths. POSIX locks are advisory: private directory ownership is still required, and malicious actions by the current user are not excluded by flock.

Tests verify the Windows kernel ACL and a restricted token, not a second user's interactive login. Administrators, SYSTEM and a compromised current-user process remain trusted OS principals. Use a new private state directory when an old directory is unsafe; never grant Everyone access as a workaround.

Android state stays inside its independent app sandbox. Mobile credentials use the existing Keystore-backed store; the iroh endpoint key is currently app-private native state, not claimed hardware-backed. Backup/data extraction is disabled.

## Pairing and revocation

The descriptor is sensitive even though its CA is public. Its two short-lived pairing secrets must not appear in issue logs, device names, analytics or model prompts. Never retain the whole QR as a device record.

Transport-peer revocation closes that iroh connection. Mobile device revocation invalidates HTTP sessions and WSS. A future unified management interface must bind these layers explicitly; do not assume their IDs are interchangeable. Only an authenticated host revocation reason may produce “removed”; timeout/unreachable remains a network state.

## Operator and certificates

The independent browser console binds numeric IPv4 loopback only. Its one-use launch fragment expires, becomes an HttpOnly/SameSite session with CSRF protection, and is omitted from redirected CLI output. Exact Host/Origin, bounded flat JSON, duplicate fields/headers and unsupported routes are checked. Local users/processes able to read the launch URL or the browser session remain trusted; this is not multi-user administrative isolation.

The full DSH authorized URL remains in process memory. Only its non-secret Origin, stable local port and local-only option are written to fixed native configuration. A fresh process never silently discovers a production profile or resumes using an old authorization URL. Closing the console page cancels a displayed QR but does not stop existing phones. Transport-peer management is labelled separately from Mobile device-token management.

The native TLS owner creates its CA and leaf inside private state. It validates keys, signatures, exact SAN, expiry, permissions and the atomic recovery journal; corrupt/unknown state fails closed rather than receiving a new CA. A bounded writer lease remains held through Gateway activation/refresh. Renewal uses the public Mobile refresh method and leaves the previous live context intact on failure. It does not install a system CA, replace user certificates or send private TLS keys through control output.

Optional local extensions execute trusted user code in their explicitly selected mode. The operator does not scan a normal profile automatically, and running an extension in a worker does not by itself establish an OS sandbox or safety for hostile code.

## Acceptance limits

The refreshed cargo-audit 0.22.2 scan uses official RustSec snapshot `640bf5a9f06e66d8721e8772766531fe77c8630d`. It first identified three certificate-trust advisories in the older lockfile. The candidate now resolves `rustls-webpki 0.103.16`, `webpki-roots 1.0.10` and `webpki-root-certs 1.0.10`, matching the published fixes for [RUSTSEC-2026-0382](https://rustsec.org/advisories/RUSTSEC-2026-0382.html), [0381](https://rustsec.org/advisories/RUSTSEC-2026-0381.html) and [0383](https://rustsec.org/advisories/RUSTSEC-2026-0383.html). The rescan matches zero known vulnerabilities and retains one unmaintained warning: `paste 1.0.15` / RUSTSEC-2024-0436 through netlink/netwatch/iroh. With `--deny warnings` it still exits 1, not green. No advisory ignore, target filter or unreviewed dependency fork was added. This snapshot result is not an absence-of-vulnerabilities guarantee.

Local QUIC/TLS, automatic-renewal tests, build/JVM and restricted-token evidence do not establish cross-network NAT/relay reliability, physical Android behavior, formal signing or absence of vulnerabilities. [VERIFICATION](VERIFICATION.md) records actual checks. Production integration/publication remains gated by [the integration plan](docs/INTEGRATION_SEAM.md).
