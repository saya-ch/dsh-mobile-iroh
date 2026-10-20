# Implementation milestones

This plan tracks the independent implementation. It does not authorize publication or edits to DSH Core/main DSH Mobile.

## Completed foundations

1. First-party host/control protocol: strict version, fields and bounds; PairOk/HelloOk only after authorized readiness; remove the unrelated approval protocol and global Cookie injection.
2. Host authorization/lifecycle: durable peer roster, explicit re-pair, revocation, same-peer generation replacement, process/profile ownership and bounded stream cleanup.
3. Private state: Unix modes and Windows creation-time DACL, same-handle validation, protected lock, fail-closed corrupt state and atomic private writes.
4. Independent provider/controller and Gateway factory using public DSH Mobile exports.
5. Real local QUIC smoke, plus TLS/Mobile Gateway/Java/Chromium acceptance through the actual Android transport crate.
6. Native Android packaging, JNI initialization, request cancellation/ownership, CONNECT and full identity-derived Origin.
7. App QR pairing, naming, encrypted credential records, saved-device recovery and current-session revocation handling; separate experimental package and signer configuration.
8. Combined source, Rust, JVM and native-build receipts; real Linux execution, QR capacity checks and an unfiltered RustSec snapshot report with its maintenance warning retained.

## Active acceptance work

- Run physical native-enabled App pairing, saved-device recovery, cancel/switch and revocation checks when hardware is available.
- Keep unverified deployment/ABI/signing conditions explicit rather than treating a lower-layer test as product acceptance.

## Required before production integration

- Physical Android: new pairing, restart, multi-device switching, revoke/expiry, foreground/background, sleep and network change, file selection/download, camera, notifications and system Back.
- Controlled real networks: direct/NAT and relay; actual DNS/discovery failure, disconnect/recovery and rate/resource limits.
- Reviewed main-plugin provider seam and Android transport metadata migration; leave existing providers/records unchanged.
- Exact-candidate Windows/Linux/Android CI, supply-chain/license inventory, artifact hashes and stable signer decision.
- Explicit human authorization before main integration, push or publication.

See [integration boundaries](INTEGRATION_SEAM.md) and [verification receipts](../VERIFICATION.md). A lower-layer success does not complete a later gate.
