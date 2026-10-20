# Independent iroh verification

This records the local independent candidate, not a DSH Mobile release. The main plugin, DSH Core, installed profiles and production App data are outside this test setup. Nothing here establishes production readiness or authorizes publication.

## Executed local checks

| Layer | Result | What was actually exercised |
| --- | --- | --- |
| JavaScript | `npm test`: 79 passed, no skipped tests | Supervisors, operator ownership, descriptor parsing, Gateway helper, build checks and bounded fixture waits; five cases belong to the separate historical identity experiment |
| Rust on Windows | `cargo test --workspace --locked`: 50 passed | Android transport 19, core 11, host 15 and real subprocesses 5 |
| Rust on Linux | Cross-built x86_64 musl executables run in existing WSL: 50 passed | Android transport 19, Unix core 12, host 15 and real subprocesses 4; real Linux syscalls, not a Windows cfg-only build |
| Rust quality | `cargo fmt --all -- --check` and workspace Clippy with `-D warnings` | Current production and test targets; no broad lint suppression |
| First-party transport | `npm run smoke:iroh`: passed | Fresh pair, persisted peer reconnect, raw HTTP/binary/Cookie/Origin/WebSocket bytes, unknown peer rejection, revoke and owned cleanup |
| Public Mobile Gateway | `npm run smoke:gateway`: passed | The actual Android Rust crate through transport-sim; TLS CA/name positive and negative cases, native pair, authenticated HTTP, Host/Origin/CSRF rejection, WSS upgrade/echo/path rejection and device revocation |
| Java HTTPS | Included in the Gateway smoke: passed | Standard JDK 17 HttpsURLConnection through the native CONNECT listener, default hostname checks and an explicit correct/wrong CA; no DNS override |
| Chromium | Included in the Gateway smoke: passed | Native `.localhost` resolution, logical HTTPS document and host-scoped Cookie; only the owned fixture certificate's SPKI is allowed |
| Host operator | `npm run smoke:host-session`: passed | Fresh combined descriptor encoded as byte-mode/M QR (version 25), maximum-byte capacity gate, transport pair, Mobile native pair, authenticated HTTPS, peer list/forget and explicit stop/restart through an injected preference store |
| Documentation | Relative-link check: 15 Markdown files | Repository-relative targets; external URLs and anchors are not checked |
| CI configuration | YAML parsed; Windows/Linux and Android jobs prepared | No remote job has run for this candidate |

All transport/Gateway/operator checks use owned temporary private profiles and record zero model requests. The upstream HTTP service in Gateway/operator acceptance is an isolated fixture, **not** a complete running DSH frontend. No normal DSH profile or real conversation is opened.

The operator smoke's preference store is an injected in-memory test store. It verifies calls and explicit recovery, not durable preferences after a fresh OS process. Host peer/identity persistence is separately exercised by Rust and first-party transport tests.

### Linux execution

The host cross-build uses Rust 1.99.1, the x86_64-unknown-linux-musl target and the official Zig 0.15.2 Windows toolchain. The downloaded archive SHA-256 was verified as `3a0ed1e8799a2f8ce2a6e6290a9ff22e6906f8227865911fb7ddedc3cc14cb0c`.

The existing `docker-desktop` WSL distribution runs the owned test executables through [the bounded runner](scripts/run-linux-test.mjs). Docker Desktop/daemon and existing containers are not started or changed. The runner's ELF header check is an architecture check, not a complete executable-security verifier. Tests run under that WSL environment's root UID; this is not a second-user login test, a macOS result or an Android filesystem result.

The Unix group-writable-ancestor regression was first executed against the vulnerable GID-0 allowance and failed. After removing that allowance, the complete Linux suite passed. Existing HOME/development directories are not chmodded, and broad old credentials are rejected without repair.

## Android build and runtime evidence

The native-enabled independent app has QR pairing, naming, saved iroh records, cold-start recovery, cancellation, switching and current-session revocation handling wired to JNI. Product version is `0.1.0-alpha.1`; the Gateway compatibility marker `0.6.5` names the imported API baseline, not a production release.

- JDK 17 / SDK 36 / NDK 25.2.9519653.
- Native libraries: arm64-v8a and x86_64 only. No 32-bit Android claim.
- JVM unit tests: 57 suites / 355 tests, zero failures/errors/skips. Debug and unsigned R8 Release APKs built successfully from the final native source.
- Native verification checks architecture, 16 KB ELF LOAD/RELRO, all four JNI exports, one library per selected APK ABI and 16 KB APK ZIP alignment.
- Release DEX inspection checks that the four native methods survive shrinking and that the connect path actually invokes JNI.
- Application-source `lintDebug` was actually rerun: zero errors and 65 inherited warnings. Test-source lint tasks were explicitly excluded as shown in the CI/app guide; JVM tests still compiled and ran independently. The initial local Windows SDK-path escaping error was corrected in ignored `local.properties`; no production-source lint check was disabled or baseline added to hide it.
- Independent signing variables use `DSH_IROH_ANDROID_*`, not the production App's `DSH_ANDROID_*` variables.

No ADB device was available at the last check, so there is **no physical Android acceptance** for JNI initialization, the actual Activity/WebView, QR scanning, cancellation, Back, files, notifications, sleep or network changes. No App was installed, uninstalled or cleared. Desktop Chromium and the host transport driver do not fill this gap.

The generated APK/native hashes and dependency scan are local candidate receipts under ignored `artifacts/`; they are not download descriptors, signing evidence or public release assets.

| Final artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Debug APK | 64,138,443 | `1be278a1a3390903874d974343e92e5eca1c1cbe8d5928c18989d1e188df0624` |
| Unsigned R8 Release APK | 30,281,589 | `c1f0ae11201f9a62317fe91881375f6924392bb7cf98468dc9837a9d291c4b56` |
| arm64-v8a native library | 13,386,848 | `7453e0ad6329ebb4a6ddd359e4f3c5f9fa41d0a20d8e5349297d20667e35cc4f` |
| x86_64 native library | 14,662,496 | `59cf666ac6cd7dc5cd6c50bf9fb63c2ffa973dfe456adcf91609fa9001ddd64c` |

Both APKs contain the expected ABI entries exactly once, and their embedded native bytes match the verified generated libraries. Debug signing is not production signing; the Release APK is unsigned.

## Dependency scan

An isolated cargo-audit 0.22.2 installation scanned the unchanged lockfile against official RustSec snapshot `b19b2c83c2493961ccb12f9fc4699a00fb2c6c44` (2026-10-20, 1345 advisories). The inventory contains 397 lock records: 393 registry packages and four workspace packages. No advisory ignore, target filter or hidden audit configuration was used.

It matched zero known vulnerabilities and one unmaintained warning, `paste 1.0.15` / RUSTSEC-2024-0436, through the Linux/Android netlink → netwatch → iroh dependency path. With `--deny warnings`, the tool exited 1; this is not an all-green audit. No fix command or unreviewed dependency fork was applied. The full local report, raw output, tool hash and database snapshot remain under `artifacts/security/`. This inventory is not a license-compliance audit, complete APK binary SBOM or guarantee of no vulnerabilities.

## Public discovery observation

The latest optional first-party `smoke:public-discovery` run completed with EndpointId-only addressing and an observed relay path. It used two processes on one Windows PC, with no explicit peer IP/relay hint; owned cleanup completed and model requests stayed at zero. The short successful probes are not cross-network NAT, sustained relay availability, cellular connectivity, bandwidth or sleep/reconnect evidence. A later failure must be recorded as a new result, not hidden by these successes.

The public probe has a total work budget and fails if its own cleanup fails. It is not a dependency of deterministic local transport tests.

## Authorization and security limits

- Windows tests inspect real private DACLs, owner checks, reparse rejection and a restricted-token AccessCheck. They are not another user's interactive login or protection against a compromised current user, Administrator or SYSTEM.
- Unix same-FD/private-mode tests are real Linux evidence; macOS and Android filesystem behavior still require their own runtime checks.
- Gateway device-token revocation and iroh peer revocation are different layers. An authenticated online transport revocation is recognized; after an offline transport-only removal, a later Hello may still yield only a generic failure. No network failure is relabelled as “removed”.
- The long-term Android iroh key is currently an app-private native file, not hardware-backed Keystore-wrapped state. Normal Mobile credentials retain Keystore encryption.
- TLS material is supplied by a trusted host operator. Automatic CA provisioning/renewal and production certificate recovery are not implemented by the factory.
- No final signing, public CI, cross-network device test, published sidecar package or main-plugin provider registration has been accepted.

## Historical reference, not current evidence

The earlier comparison used `zexadev/dsh-tether` source `e1ffab8013f29d39321332be45b2c25d1ffcdaa4` and Windows reference sidecar 0.1.22 (executable SHA-256 `F45304EF7932EB55318F33BEA0F98BB03B0A2014FFF4261BCA891D65F69E1C1F`). Its approval/decision messages are not part of this repository's current protocol. The old HTTP identity demo is kept under [experiments/identity](experiments/identity/README.md).

The earlier first-party public-discovery attempt was blocked by addressing failure. That historical result does not invalidate the later local-only tests, and the later one-off public success does not establish reliable deployment. Use [the implementation plan](docs/IMPLEMENTATION_PLAN.md) and [integration design](docs/INTEGRATION_SEAM.md) for remaining gates.
