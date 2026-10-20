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

The active Windows profile lock cannot be deleted/renamed while held. POSIX locks are advisory: private directory ownership is still required, and malicious actions by the current user are not excluded by flock.

Tests verify the Windows kernel ACL and a restricted token, not a second user's interactive login. Administrators, SYSTEM and a compromised current-user process remain trusted OS principals. Use a new private state directory when an old directory is unsafe; never grant Everyone access as a workaround.

Android state stays inside its independent app sandbox. Mobile credentials use the existing Keystore-backed store; the iroh endpoint key is currently app-private native state, not claimed hardware-backed. Backup/data extraction is disabled.

## Pairing and revocation

The descriptor is sensitive even though its CA is public. Its two short-lived pairing secrets must not appear in issue logs, device names, analytics or model prompts. Never retain the whole QR as a device record.

Transport-peer revocation closes that iroh connection. Mobile device revocation invalidates HTTP sessions and WSS. A future unified management interface must bind these layers explicitly; do not assume their IDs are interchangeable. Only an authenticated host revocation reason may produce “removed”; timeout/unreachable remains a network state.

## Acceptance limits

The local cargo-audit 0.22.2 scan against RustSec snapshot `b19b2c83c2493961ccb12f9fc4699a00fb2c6c44` reported zero matched vulnerabilities and one unmaintained-dependency warning: `paste 1.0.15`, RUSTSEC-2024-0436, reached through Linux/Android netlink/netwatch/iroh dependencies. The audit used `--deny warnings` and exited 1; it was not an all-green audit. The warning has no advisory-listed fixed version and remains an upstream maintenance item, not a hidden ignore or an unreviewed local dependency replacement. This snapshot result is not an absence-of-vulnerabilities guarantee.

Local QUIC/TLS, build/JVM and restricted-token evidence do not establish public NAT/relay reliability, physical Android behavior, automatic certificate renewal, formal signing or absence of vulnerabilities. [VERIFICATION](VERIFICATION.md) records actual checks. Production integration/publication remains gated by [the integration plan](docs/INTEGRATION_SEAM.md).
