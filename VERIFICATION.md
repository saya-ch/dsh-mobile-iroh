# Independent iroh verification

This records the independent iroh implementation and its release checks. The main DSH Mobile source and DSH Core remain separate. Installed-package, official Desktop, physical Android and public-artifact outcomes are recorded individually.

## Installed companion and signed App — 2026-10-23

The first alpha distribution uses `dsh-mobile-iroh@0.1.0-alpha.1` on npm's `alpha` channel and the independently signed Android package `io.github.sayach.dshmobileiroh`, version `0.1.0-alpha.1`, build 1. Release signing is distinct from a stable-product claim. The independent certificate SHA-256 is pinned in `apps/mobile/signing.json`; the main Mobile signer was not used.

The actual installed official Desktop executable was version **0.2.1-rc.2**. Its own bundled `dsh` CLI installed the candidate tarball into a private, separately initialized Desktop home; the same executable ran with an isolated Electron user-data directory. This was the official Desktop application, not another Web process labelled as Desktop. The profile enabled Mobile **0.6.16** and the independent companion.

- The real plugin detail page reported one running companion component. General settings mounted its actual client bundle and launch action.
- The first real launch returned 403: Desktop forwards `Request.body` as a stream with `duplex: 'half'`, yielding chunked encoding without Content-Length. A real Node HTTP regression failed before the fix and passed after accepting only unambiguous chunked framing while retaining authentication and the decoded 64-byte budget.
- The corrected installed tarball opened the system browser through the real settings action. The manager automatically bound the current Host; no DSH login Token was copied into it. Starting it launched the packaged, checksum-verified native Host.
- The release-signed APK contains both native ABIs and the original native/Maven notices. The signer gate and APK alignment check passed; the installed package is non-debuggable and has no WebView debugging socket. The old independent Debug App was replaced with the user's explicit authorization; the original Mobile packages were retained.
- The release App was observed paired to this Desktop on the phone's active cellular NR network. It displayed the real DSH preview and credential-onboarding dialogs, then the composer. The manual pairing interaction was not recorded, so this is not a claim of automated physical-camera acceptance.
- An owned Workspace created through the Desktop API appeared on the phone. A second Workspace created while the phone drawer stayed open appeared without phone navigation or reload; the unsent `Iroh signed release QA` draft remained present. No model request was submitted.
- Disabling the actual installed companion through Desktop stopped its native process and put the phone into recovery. Re-enabling it restored the persisted enabled choice and started a new native process; the phone kept its draft. The waiting UI later disappeared, but its connection banner still showed an outage and a new Workspace had not arrived. That observation alone does not establish recovered traffic; the recovery follow-up is recorded separately.
- A same-signer diagnostic upgrade preserved the paired record and enabled network observation. Two further actual Desktop disable/re-enable cycles changed the session Cookie, kept both Session and CSRF aliases consistent, restored `/api/remote.mux` with status 101 and authenticated APIs with status 200, and delivered a newly created Workspace to the phone. The document marker and unsent draft survived, with no outage banner. The earlier failed recovery remains an unclassified observation, not erased by these successes.
- A separate full-Gateway-rebuild regression uses the public DSH and Mobile artifacts over real local QUIC. With the same persisted computer and phone identities, old Cookies return 401; the original long-term device Token renews successfully; new Cookies access protected APIs. Old document views correctly return 409, while a fresh document receives a new view and a real graph with status 200. This is a host-driven protocol result, not a physical-device result. The initial App does not promise seamless graph-view or expired-session renewal; the README describes reopening the computer without re-pairing.
- Initial onboarding UIA dumps temporarily lacked readable text despite normal screenshots and clicks. A later raw dump contained 37 nodes, two WebViews and virtual buttons/text/editor; no persistent accessibility suppression was established. Full TalkBack testing remains separate.

The earlier local install tarball hash was `1760af3e683a2e5981993f653b72d2ff9f113a806cef763006d7ecc694577675`; the locally tested signed APK hash was `f2d580edad1b2d39ad6f655f69ccc06840c1f4f837a8abd9ca79df994956546c`. Final public assets are verified separately and must not inherit these hashes after a rebuild.

The preceding `2753a2e` candidate passed all six remote Windows/Linux/Android, tarball and installed-runtime jobs in CI run `39920003905`. Its predecessor's two frontend smokes failed because pnpm was missing from PATH; the fix installs the locally verified pnpm version. The later Desktop framing correction requires its own candidate run before release.

The final local follow-up has 221 passing Node tests and one Windows symlink-privilege skip with the native adapters enabled. Android has 60 JVM suites and 392 passing tests, with no failures, errors or skips; application Lint also passed. The Cookie owner serializes complete alias batches and accepted revocation cleanup by host across Activity replacement. Platform rejection never reports successful installation, and a saved pairing remains available if its Cookie write fails. Initial wiring tests still expected inline deletion strings; they were updated to check delegation to the tested deletion queue instead.

## Physical-device development check — 2026-10-23

An independent debug-signed `io.github.sayach.dshmobileiroh` App was installed on a PJW110 running Android 16/API 36, arm64-v8a with 4 KB pages and WebView 153.0.8010.36. The production Mobile apps and their data were not replaced, uninstalled or cleared. The phone's active network was cellular NR; the Windows Host used the existing network configuration. An isolated DSH 0.2.1-rc.2 / Mobile 0.6.16 profile supplied the real page without model credentials or model requests.

| Device check | Observed result |
| --- | --- |
| Pairing parser | The first on-device attempt crashed during ICU regex initialization: the literal closing JSON brace was not escaped. Escaping both braces removes that crash; the real host-generated P-256 CA descriptor then pairs successfully. JVM regex success alone had missed this Android defect. |
| Test input integrity | Unpaced ADB key injection dropped characters and produced an invalid descriptor. Paced input delivered all 996 characters and succeeded; this was a test-input failure, not evidence for weakening certificate or JSON validation. Camera scanning was not exercised. |
| Public discovery | The read-only lookup driver found one usable DNS record and one signature-verified pkarr record for the active Host, each with a relay address. This is a separate Windows observation, not a trace of the phone's selected path. |
| Real page | The phone paired, named and saved the computer, then loaded the actual DSH WebView. JavaScript, CSS and authenticated model-catalog, settings, workspace and Session API requests returned 200; cached extension manifests also returned 304. This was not only a health probe. |
| Recovery | After an isolated Host restart, the same document marker and unsent draft survived eventual reconnection. Review found carrier failures restarting the overall budget. The fixed final APK retained the document/draft while the Host remained offline: waiting was present at the 26-second sample and absent at the 69-second sample. Virtual-clock tests separately enforce the exact 60-second deadline. |
| Saved credentials | A full restart of only the independent App reconnected with the saved pairing and recovered the unsent draft. No new pairing was needed. |
| Cancellation and Back | Stopping automatic recovery removed the waiting UI; after the Host restarted the peer remained offline until reopening the App. System Back exited the otherwise idle DSH page. |
| Online revocation | Removing exactly the owned online transport peer returned the App to its device list, retained the name and displayed the computer-removed state. The Host peer list became empty. |
| Repair and cleanup | Re-pairing that Host restored the original named record without a duplicate. The web General settings switch-computer action opened the native list. Deleting only that temporary record returned to the connection chooser. |

These checks do not establish forced-relay versus direct-path selection, sustained throughput, all mobile networks, sleep/network changes, multiple-computer switching, camera/file/notification parity or production signing. The experimental branch can be shared for development; it is not a release or permission to integrate into the main plugin. Final build, cleanup and remote-CI outcomes are recorded separately from these observations.

### Development snapshot checks

- Node: 179 tests passed, no skips, with the real native adapters enabled.
- Windows Rust: 82 tests passed; workspace formatting and all-target Clippy with warnings denied passed. The new lookup driver contributes five tests. Linux results below belong to the preceding baseline, not a rerun of this driver change.
- Android: 59 JVM suites / 378 tests passed, with no failures, errors or skips. The recovery regression failed before the fix. Native-enabled Debug and unsigned R8 Release builds passed; application Lint reported zero errors and 66 warnings, with test-source Lint excluded.
- Both Android native ABIs were rebuilt and verified. The Debug APK passed ABI/ELF/ZIP checks and retained the same debug signer. It was installed over the diagnostic build without clearing data; temporary pairing diagnostics are absent from the final source.
- Debug APK SHA-256: `686c4052d2acd7a0d1fb9ca36972d319cc062fcef051b91ba0c8969321ff26fd`. Unsigned Release APK SHA-256: `bc304cd8c90d0f05902437c288aa47f6f326080f1481ba7f022adc3fb3b71530`.
- Relative documentation links passed for 16 Markdown files. External URLs/anchors were not checked. No exact-snapshot remote CI result is claimed here.
- The lookup driver adds direct dependency edges only; the lock SHA-256 is `3e2524088718a22b626efbdb09a70a61a2ed6064781f6d055de0e5ee196e191a`. The earlier security scan below is attached to its own lock hash, not relabelled as a new scan.

## Pre-device local baseline — 2026-10-23

This earlier local candidate added the authenticated browser operator and real runtime owner, native non-secret configuration, automatic private CA/leaf provisioning and renewal, and an optional independent public extension service. It was unpublished and unintegrated into the main plugin. ADB was excluded from that stage; the subsequent physical-device work is recorded above.

That baseline's public-artifact acceptance used DSH **0.2.1-rc.2**, Mobile **0.6.16** and Playwright **1.63.0**. The original two bounded dependency-install failures remain recorded; a subsequent separate runtime was successfully installed from the verified public artifact without changing global npm/TLS/proxy policy.

| Layer | Pre-device observed result |
| --- | --- |
| Real DSH frontend | Exact phone IPv4 socket asserted; real model catalog and selection succeed, per-device module save/read/reset and required/dependency exclusions verified, authenticated non-empty extension manifest/action/route tested; missing CSRF rejected. |
| Session export | Authenticated ZIP API output actually extracted; matching Session header/id and selected-model event, no submitted user message. Not the blank Session's intentionally hidden header-menu UI. |
| Recovery | Old live Workspace mux closes when the actual Android transport driver stops; a different mux/new Workspace baseline appears after restart, with the same document/editor/unsent draft. Revocation rejects authenticated HTTP with 401. |
| Managed TLS | Actual public Gateway over local QUIC: CA/name positive/negative checks, fresh leaf on a new handshake, unchanged CA/instance, existing Cookie and open WSS survive renewal; rejected refresh retains old live context and explicit recovery succeeds. Native hold/abort/EOF/timeout tests wait for actual close. |
| Operator | Real loopback GUI → bootstrap/owner → native config/preference/TLS → Host/Gateway → actual Android transport crate → real DSH page tested. Old unused Gateway token rejected after QR cancellation, fresh QR succeeds, TLS refresh preserves the mux, peer revoke/stop and fresh-owner configuration retention checked. The final new-lock/new-binary rerun passed with unchanged source/artifact fingerprints. |
| Extension scope | Explicit providers and explicitly selected local extensions; public in-process and worker modes run. No automatic mirroring of a normal profile or promise of live Core services/all-plugin compatibility. |
| Model calls | Prompt and owned upstream model-sink counters stay zero; only a declared non-secret dummy credential enables the owned catalog. |

### Pre-device local gates

| Gate | Result for that baseline |
| --- | --- |
| Node | `npm test`: **179 passed**, zero failures/skips, including real native adapters. |
| Windows Rust | **80 passed** across Android transport 20, core 12, host 34, process 7, TLS process 4 and driver 3; workspace format and all-target Clippy `-D warnings` pass. The final cross-runner helper was rechecked with all four Windows TLS process tests. |
| Actual Linux | **79 passed** in existing WSL: Android 20, core 12, host 34, process 6, TLS process 4, driver 3; zero failures/ignored. First-run embedded Windows-path failure was fixed in the test helper, not the product. |
| Optimized Windows Host | Release build plus native TLS prepare/id/renew, fixed configuration/preference and strict stdio readiness/shutdown pass; zero model requests. This extra CLI smoke is not an optimized-host full-frontend run. |
| Android JVM | **58 suites / 371 tests**, zero failures/errors/skips, actually rerun. |
| Native Android | Debug and unsigned R8 Release built with all 98 selected Gradle tasks executed; app Lint **0 errors / 66 warnings**, test-source Lint explicitly excluded. |
| Packaged native code | Both APKs contain the expected two ABI libraries, identical to verified generated bytes; four JNI exports and ELF/ZIP 16 KB alignment pass. Release DEX retains all four native declarations and an actual `IrohNative.nativeConnect` invoke instruction. Debug signer checked; Release confirmed unsigned. |
| Current public runtime | Gateway/Java/Chromium, durable HostSession, managed TLS, real DSH frontend and real operator runtime all pass after the trust-dependency update. DSH 0.2.1-rc.2 / Mobile 0.6.16; zero model requests. |
| Documentation / CI definition | Relative links in 16 Markdown files pass; workflow YAML parses. No exact-candidate remote CI has been run. |
| Cleanup | Final frontend/operator receipts confirm actual close and owned-root cleanup; final process scan finds no host/driver instances. Normal user profiles were not changed. Windows DSH fixtures use recorded forced tree shutdown, not a graceful-exit claim. |

The baseline's source fingerprint and result index are retained under ignored `artifacts/20261022-progress/FINAL-LOCAL-CANDIDATE.json`. They do not cover the later Android parser/recovery fixes or lookup driver. Raw passing, failing and blocked receipts remain under `artifacts/20261022-progress/`, `artifacts/operator-real-ui/`, `artifacts/20261023-linux/`, `artifacts/20261023-relay/`, `artifacts/20261023-revocation/` and `artifacts/security/`.

| Pre-device artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Native-enabled Debug APK | 37,551,488 | `afc8f633adc495837374c39cfc7142ffd371a61404f27b1d404aba2270f2720c` |
| Unsigned R8 Release APK | 30,320,085 | `3075f69f0d20db3d9710a1020d5ad7b037bbd0553e5545ddd0f7f0f0595c96a0` |
| Packaged arm64-v8a library | 13,390,456 | `dcfdf59d820d1d306024689f180715ed664c68451de0256754763e8fa1a3a925` |
| Packaged x86_64 library | 14,700,992 | `6952e802e1b579ce8702e4c2bf4cee5c7a8868b495f27ffb944efd9ca2ade9d9` |

### Defects found during acceptance

A real transport cleanup race was reproduced deterministically: after receiving authenticated `ApplicationClosed(1, "revoked")`, the proxy owner called local close and replaced that reason with `LocallyClosed`. The fix preserves an already-recorded remote terminal reason; a true control-EOF-first test still produces `Disconnected`, not a false revocation. The same strict assertion fails before the fix and passes after the real owner has finished.

Other fixed paths include an identity command recreating a missing key before TLS could reject it; failed Gateway startup losing retryable cleanup ownership; reuse of a failed extension owner; and rejection of native-valid 64-scalar peer names by the operator projection. A read-only control timeout now leaves the phone data path alive but gates later control operations until explicit reconnect, preventing late uncorrelated replies from driving a mutation. Independent static review of the frozen changed paths leaves no substantiated unresolved P0/P1/P2; this is not a guarantee that the whole program is bug-free.

The earlier unclassified Mobile 0.6.13 model-catalog 401 remains historical. The new stage-labelled 0.6.16 run records successful pre-revocation selection and places its sole catalog 401 after deliberate revocation; the final archive run has no browser HTTP failures. The initial export-menu fixture error was corrected without sending a model request or changing DSH product behavior.

### Network observations

The bounded pre-security-update probes use actual Android transport code and owned processes on one Windows PC. Default EndpointId-only public discovery failed because official pkarr/DNS lookup could not obtain addresses. A separate `--relay-only` run removed IP transports and achieved authenticated **relay** pairing plus matching HTTP bytes, but same-identity reconnect then failed in official DNS/pkarr discovery. The final new-lock `--relay-only` probe also exits 2/blocked at address discovery, with no addressing information and both child processes actually closed. The whole public reconnect gate remains **blocked**, not passed. No production resolver, DNS, global proxy, trust store or fallback route was changed.

Controlled local direct tests passed same-identity reconnect, malformed EndpointId rejection before state creation, an unpublished valid peer's bounded native connect timeout, stdin setup cancellation and parent readiness timeout, with the healthy connection still forwarding after each failure. All owned processes/roots closed and model requests remained zero. These observations are not cross-NAT, cellular, sustained relay or physical Android evidence. New-lock observations, if executed, remain separate receipts rather than retroactively changing the old runs.

### Dependency review

The refreshed official RustSec snapshot `640bf5a9f06e66d8721e8772766531fe77c8630d` identified three certificate-trust advisories in the previous lock. After targeted updates to rustls-webpki 0.103.16, webpki-roots 1.0.10 and webpki-root-certs 1.0.10, the exact-lock rescan finds zero matched vulnerabilities. It retains the `paste 1.0.15` unmaintained warning; `--deny warnings` exits 1. Both raw scans are retained under ignored `artifacts/security/`; no warning/advisory was hidden. The license inventory covers **412 packages**, with no missing declarations; it is a conservative Cargo source superset, not legal approval or a complete APK/Maven/Node binary SBOM. Exact lock SHA-256 is `4ec953f1bc4af53a516cf3bb4313e5a5f6dc1df9525a46982fb6d4644f99397b`.

The older counts, hashes and limitations below belong to earlier source stages. They are not current candidate totals and do not override newer implemented/validated TLS, extension or operator behavior.

## Historical local follow-up — 2026-10-22, before managed TLS/operator

These checks cover uncommitted work on `codex/iroh-integration-preflight`, based on `1dfa7a8`; they are not a tag, public CI result or signed release. The main DSH Mobile checkout, DSH Core, installed profiles and production App were not changed.

| Layer | Actual result | Scope |
| --- | --- | --- |
| JavaScript | 107 passed, zero failures/skips | Includes real native preference adapter execution with the selected built host; strict store/cancellation, Host restore, owned profile launch and safe projected-link cleanup |
| Windows Rust | 57 passed | Android transport 19, core 11, host 20 and subprocesses 7; formatting and workspace Clippy with `-D warnings` also passed |
| Linux runtime | 57 passed in the existing WSL distribution | Actual cross-built musl executables: Android transport 19, Unix core 12, host 20 and subprocesses 6, including preference permissions/symlink/lease checks. Not Ubuntu CI or an Android runtime. |
| Android JVM | 58 suites / 371 tests, zero failures/errors/skips | Executable foreground monitor ownership, retained-page recovery wiring and strict certificate-bearing QR parsing included |
| Native-enabled Android | Debug and unsigned R8 Release builds passed | App-source `lintDebug` completed with zero errors and 66 warnings; test-source lint remained explicitly excluded. Native methods/ELF verification and APK ABI/16 KB ZIP checks passed. |
| First-party transport | `smoke:iroh` passed | Real local QUIC, persistent peer reconnect, raw bytes, WSS and revocation; zero model requests |
| Host operator | `smoke:host-session` passed | Real native durable preference across Host owners, disabled restore without auto-start, retained endpoint/Origin, pairing and peer revocation; zero model requests |
| Corrected Gateway browser | Passed with DSH Mobile 0.6.13 | Exact fixture hostname maps to the phone's IPv4 bridge, actual document remote IP checked; Node CA/name, Java CONNECT and WSS/auth/revocation checks retained. See the path correction below. |
| Real DSH frontend | Passed with DSH 0.2.1-rc.2 and Mobile 0.6.13 | Exact public plugin installation in an owned profile; real Workspace/Session, controlled phone-driver stop, old mux close, new baseline, identical document/editor/draft and revoked-device 401; zero model requests |

At this historical stage, the first two real-frontend 0.6.16 dependency preparations each exceeded their 180-second installation budget. Both npm processes actually closed after termination; no 0.6.16 product smoke had run yet. The later separate runtime and current acceptance above supersede that missing-version evidence. Raw receipts remain under ignored `artifacts/20261022-progress/`, alongside initial onboarding and IPv6-bypass failures. Windows DSH fixture shutdown records explicit tree termination, not a graceful-exit claim.

The historical 0.6.13 frontend fixture observed `/mobile-access/extensions/manifest` returning `404`, before the independent extension host was attached. That run did not verify extension parity; the current non-empty-service tests above supply separate evidence. Browser certificate exceptions remain restricted to the generated SPKI, with ordinary CA/name enforcement in separate Node/Java checks. No system trust store, production resolver or upstream bundle was rewritten.

That historical 0.6.13 run retained an unclassified browser `401` for `/api/session/modelCatalog`. Its collector lacked stage labels, so that receipt still cannot place the response before or after deliberate revocation or establish model selection. New 0.6.16 stage-labelled model-selection results are separate evidence; they do not rewrite the old receipt.

After the final corrected frontend and Gateway runs, the fixture-process scan found no matching owned processes, frontend roots or Gateway roots. Android driver exits were 0; Windows DSH tree shutdown was explicitly forced with exit 1. These are cleanup observations for the isolated runs, not a claim of graceful Desktop shutdown or changes to normal user processes.

Initial Linux cross-build attempts exposed local toolchain configuration errors: cc-rs passed a Rust target spelling unsupported by Zig, an archiver was missing, Rust and Zig supplied duplicate startup objects, and a relative runner resolved under the member crate. The final per-command configuration selected the canonical C target, existing LLVM archiver, `link-self-contained=no` and an absolute runner. The final actual Linux tests passed without product changes or advisory suppression. The host musl build warns that the Android crate's `cdylib` output is unsupported on that target; this is not the Android native-library build.

The first APK inspection named an unavailable local Build Tools `36.0.0` directory and failed before inspection; the installed `35.0.0` tool then performed the actual ABI/ZIP-alignment verification. The native libraries were separately rebuilt/verified with the selected NDK, and their bytes remain identical to the earlier artifact rows below.

| New local artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Native-enabled Debug APK | 64,138,443 | `f8cad1c50ccff0e8d1c55ae29f00a755d7fc3939f24c43ed1ec868e5782df611` |
| Unsigned R8 Release APK | 30,281,589 | `3d1dc41908ca2faaf95563ca9c73cb4358c6135aa42223da2aef3c46cf071acc` |

The old valid certificate-bearing descriptor test was separately reproduced with `StackOverflowError` before replacing the ambiguous repeated regex tokens with possessive repetitions. The same valid case, escaped/duplicate/unknown fields and full 2200-byte boundary now pass without changing the byte limit, JVM stack or certificate policy. Retained-page recovery now restarts the status monitor; the new monitor's queued-callback, foreground, replacement and terminal-state cases run on the JVM, not a device.

At that earlier check ADB reported no device, and no independent App was installed or cleared. Physical WebView/JNI, sleep/network switching, cross-network NAT/relay, stable signing and remote CI remain separate gates. Automatic certificates and explicit extensions have since received the current non-device checks above; neither means all-extension parity or physical-device acceptance. The maintenance warning remains visible.

## Browser transport-path correction

The earlier same-PC Chromium check placed the host Gateway on `::1` and the phone bridge on `127.0.0.1` at the same logical port. Native `.localhost` resolution can select the host's IPv6 listener directly. Its successful document/Origin/Cookie assertions therefore did not establish that those browser requests traversed QUIC. The separately addressed Node HTTP/WSS and Java CONNECT checks retain their own evidence; they do not repair this browser-path gap.

The new full-DSH fixture explicitly maps only its generated endpoint hostname to the phone's IPv4 bridge and checks the document's remote socket address. Transport acceptance additionally requires stopping the phone driver to close the real DSH mux, followed by a new Workspace baseline after restart while retaining the same document/editor/draft. These are isolated same-PC fixture routes, not production DNS changes or physical Android evidence. Execution results are recorded separately below when completed.

## Earlier independent candidate checks

The following receipts belong to source `1dfa7a8` and its implementation baseline. They are retained as historical evidence, not counts or artifact hashes for the current working tree.

| Layer | Result | What was actually exercised |
| --- | --- | --- |
| JavaScript | `npm test`: 79 passed, no skipped tests | Supervisors, operator ownership, descriptor parsing, Gateway helper, build checks and bounded fixture waits; five cases belong to the separate historical identity experiment |
| Rust on Windows | `cargo test --workspace --locked`: 50 passed | Android transport 19, core 11, host 15 and real subprocesses 5 |
| Rust on Linux | Cross-built x86_64 musl executables run in existing WSL: 50 passed | Android transport 19, Unix core 12, host 15 and real subprocesses 4; real Linux syscalls, not a Windows cfg-only build |
| Rust quality | `cargo fmt --all -- --check` and workspace Clippy with `-D warnings` | Current production and test targets; no broad lint suppression |
| First-party transport | `npm run smoke:iroh`: passed | Fresh pair, persisted peer reconnect, raw HTTP/binary/Cookie/Origin/WebSocket bytes, unknown peer rejection, revoke and owned cleanup |
| Public Mobile Gateway | `npm run smoke:gateway`: passed | The actual Android Rust crate through transport-sim; TLS CA/name positive and negative cases, native pair, authenticated HTTP, Host/Origin/CSRF rejection, WSS upgrade/echo/path rejection and device revocation |
| Java HTTPS | Included in the Gateway smoke: passed | Standard JDK 17 HttpsURLConnection through the native CONNECT listener, default hostname checks and an explicit correct/wrong CA; no DNS override |
| Earlier Chromium check | Document/Origin/Cookie assertions passed; QUIC path was not established | Native `.localhost` resolution could select the host IPv6 listener directly; only the owned fixture certificate's SPKI was allowed. See the path correction above. |
| Host operator | `npm run smoke:host-session`: passed | Fresh combined descriptor encoded as byte-mode/M QR (version 25), maximum-byte capacity gate, transport pair, Mobile native pair, authenticated HTTPS, peer list/forget and explicit stop/restart through an injected preference store |
| Documentation | Relative-link check: 15 Markdown files | Repository-relative targets; external URLs and anchors are not checked |
| CI configuration | YAML parsed; Windows/Linux and Android jobs prepared | No remote job has run for this candidate |

All transport/Gateway/operator checks use owned temporary private profiles and record zero model requests. The upstream HTTP service in Gateway/operator acceptance is an isolated fixture, **not** a complete running DSH frontend. No normal DSH profile or real conversation is opened.

The operator smoke's preference store is an injected in-memory test store. It verifies calls and explicit recovery, not durable preferences after a fresh OS process. Host peer/identity persistence is separately exercised by Rust and first-party transport tests.

### Linux execution

The host cross-build uses Rust 1.99.1, the x86_64-unknown-linux-musl target and the official Zig 0.15.2 Windows toolchain. The downloaded archive SHA-256 was verified as `3a0ed1e8799a2f8ce2a6e6290a9ff22e6906f8227865911fb7ddedc3cc14cb0c`.

The existing `docker-desktop` WSL distribution runs the owned test executables through [the bounded runner](scripts/run-linux-test.mjs). Docker Desktop/daemon and existing containers are not started or changed. The runner's ELF header check is an architecture check, not a complete executable-security verifier. Tests run under that WSL environment's root UID; this is not a second-user login test, a macOS result or an Android filesystem result.

The Unix group-writable-ancestor regression was first executed against the vulnerable GID-0 allowance and failed. After removing that allowance, the complete Linux suite passed. Existing HOME/development directories are not chmodded, and broad old credentials are rejected without repair.

## Historical Android build and runtime evidence

The native-enabled independent app has QR pairing, naming, saved iroh records, cold-start recovery, cancellation, switching and current-session revocation handling wired to JNI. Product version is `0.1.0-alpha.1`; the Gateway compatibility marker `0.6.5` names the imported API baseline, not a production release.

- JDK 17 / SDK 36 / NDK 25.2.9519653.
- Native libraries: arm64-v8a and x86_64 only. No 32-bit Android claim.
- JVM unit tests: 57 suites / 355 tests, zero failures/errors/skips. Debug and unsigned R8 Release APKs built successfully from the final native source.
- Native verification checks architecture, 16 KB ELF LOAD/RELRO, all four JNI exports, one library per selected APK ABI and 16 KB APK ZIP alignment.
- Release DEX inspection checks that the four native methods survive shrinking and that the connect path actually invokes JNI.
- Application-source `lintDebug` was actually rerun: zero errors and 65 inherited warnings. Test-source lint tasks were explicitly excluded as shown in the CI/app guide; JVM tests still compiled and ran independently. The initial local Windows SDK-path escaping error was corrected in ignored `local.properties`; no production-source lint check was disabled or baseline added to hide it.
- Independent signing variables use `DSH_IROH_ANDROID_*`, not the production App's `DSH_ANDROID_*` variables.

No ADB device was available at that earlier check. Those builds did not establish physical Android acceptance or install/clear any App. The later device observations at the top of this document supersede that availability statement without validating every remaining scenario.

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
- Earlier fixtures supplied TLS explicitly. The current managed implementation provisions/renews private CA/leaf material through the native lease; corrupt state and CA expiry require explicit operator action instead of automatic identity/root replacement.
- No production signing, published sidecar package or main-plugin provider registration has been accepted. The limited cellular-device observations above do not establish the complete deployment matrix; remote CI is recorded separately when run.

## Historical reference, not current evidence

The earlier comparison used `zexadev/dsh-tether` source `e1ffab8013f29d39321332be45b2c25d1ffcdaa4` and Windows reference sidecar 0.1.22 (executable SHA-256 `F45304EF7932EB55318F33BEA0F98BB03B0A2014FFF4261BCA891D65F69E1C1F`). Its approval/decision messages are not part of this repository's current protocol. The old HTTP identity demo is kept under [experiments/identity](experiments/identity/README.md).

The earlier first-party public-discovery attempt was blocked by addressing failure. That historical result does not invalidate the later local-only tests, and the later one-off public success does not establish reliable deployment. Use [the implementation plan](docs/IMPLEMENTATION_PLAN.md) and [integration design](docs/INTEGRATION_SEAM.md) for remaining gates.
