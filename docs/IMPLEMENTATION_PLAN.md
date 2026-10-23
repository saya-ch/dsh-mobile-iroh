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
9. Native durable Host startup preference with explicit restore, cancellation-aware subprocess ownership and new-owner recovery without enabling an off gateway.
10. Retained-page Android transport monitoring and bounded non-backtracking QR prevalidation, with executable JVM regressions.
11. Real isolated DSH frontend acceptance with public plugin installation, same-PC carrier-path enforcement, Workspace/Session, retained unsent draft, actual mux recovery and revoked-device rejection. Version-specific receipts and remaining feature parity are recorded in VERIFICATION.
12. Native private CA/leaf provisioning and journaled recovery; writer lease through public Gateway activation/renewal, with active sessions and WSS retained across refresh.
13. Independent authenticated loopback operator console and runtime/CLI composition; non-secret configuration persistence, memory-only authorization, QR cancellation, transport peers and certificate status.
14. Optional public extension service, explicit provider/local directory, in-process and worker execution, authenticated routes and dependency/module rules; no automatic normal-profile mirroring.
15. Current public Mobile 0.6.16 frontend model selection, actual ZIP content, per-device module rules and real runtime/operator checks with zero model requests.
16. Pre-device local Node 179, Windows Rust 80, actual Linux 79 and Android JVM 371 checks; native Debug/unsigned R8 Release and optimized Windows Host built. Security trust dependencies updated and 412-package license declarations inventoried, without hiding the remaining maintenance warning.
17. Android 16 cellular pairing, real DSH resource/API loading, saved-device reconnect, cancellation, system Back and targeted online revocation observed in an isolated physical-device setup. This exposed an Android ICU parser crash and a recovery-budget issue; final checks and remaining coverage are tracked in VERIFICATION.
18. Installable companion bundle with a public General settings entry, current-Host authorization, strict streamed Desktop launch requests, independent operator ownership and no duplicate Mobile service registration.
19. Versioned Windows/Linux native package inventory, exact tarball checks and real installed-package smoke; independently pinned Android release signer and complete native/Maven distribution notices.

## Active acceptance work

- Complete final-package recovery-budget checks and the remaining physical native-enabled App scenarios; retain the already observed checks separately.
- Keep unverified deployment/ABI/signing conditions explicit rather than treating a lower-layer test as product acceptance.
- Keep source/build receipts, original failures and bounded public-network observations alongside the final release checks; Windows/Linux/Android CI and official Desktop installation are recorded for each candidate.
- Public EndpointId discovery and relay reconnect remain topology-dependent; a forced-relay initial success and a later discovery failure are separate results, not an overall reliability pass.

## Required before production integration

- Physical Android: new pairing, restart, multi-device switching, revoke/expiry, foreground/background, sleep and network change, file selection/download, camera, notifications and system Back.
- Controlled real networks: direct/NAT and relay; actual DNS/discovery failure, disconnect/recovery and rate/resource limits.
- Reviewed main-plugin provider seam and Android transport metadata migration; leave existing providers/records unchanged.
- Exact-candidate Windows/Linux/Android CI, supply-chain/license inventory, artifact hashes and stable signer decision.
- Explicit human authorization before main integration, push or publication.

See [integration boundaries](INTEGRATION_SEAM.md) and [verification receipts](../VERIFICATION.md). A lower-layer success does not complete a later gate.
