# Independent iroh verification

This record belongs to the separate `dsh-mobile-iroh` experiment. It is not a
release record for `dsh-mobile`, does not change `deepseek-harness`, and does
not claim that #235 is production-ready in either project.

## Reference artifact

- Project: [`zexadev/dsh-tether`](https://github.com/zexadev/dsh-tether)
- Source revision inspected: `e1ffab8013f29d39321332be45b2c25d1ffcdaa4`
- Release asset: `dsh-tether-host-win32-x64-0.1.22.tgz`
- Rust sidecar package: `dsh-tether-host-win32-x64@0.1.22`
- Extracted executable SHA-256: `F45304EF7932EB55318F33BEA0F98BB03B0A2014FFF4261BCA891D65F69E1C1F`
- Declared iroh dependency: `1.0.0`; the published lockfile resolved the
  reference build to `iroh 1.0.3`.

The reference sidecar is used only to compare behavior. The repository now has
an adapted first-party Cargo workspace under `host/` and `tether-core/`.

## Host-side smoke sequence

`npm run smoke:iroh` starts the released Windows sidecar twice in isolation: one `host` process and one `phone-sim` process. It then checks all of the following before reporting `passed`:

1. the host emits an endpoint identity and a pairing window;
2. the phone stand-in completes the real iroh pairing handshake;
3. a proxy stream reaches a local HTTP server and returns the expected body;
4. an approval request travels to the phone stand-in and an `allowed-once` decision returns to the host.

The script uses temporary data directories and removes them after the run. It does not contact DSH, send a model request, or alter any installed profile.

## Results on 2026-10-19

- Local identity/mapping cases: included in the passing `npm test` suite.
- Local HTTP demo: `npm run demo` — passed.
- Current JavaScript protocol and gateway adapter tests: `npm test` — 9 passed, 0 failed.
- Android baseline unit tests: `:app:testDebugUnitTest` — passed after adapting source-path fixtures to the independent package name.
- First-party Rust workspace: `cargo fmt --all -- --check`, `cargo check --workspace`, and `cargo test --workspace` — passed.
- First-party host release build: `cargo build --release -p dsh-mobile-iroh-host` — passed; `--help` and `id` smoke — passed.
- First-party real iroh smoke: classified `blocked`, not `passed`, because this network could not resolve iroh DNS/PKARR addressing (`No addressing information available`, DNS/TLS discovery failure).

## Acceptance boundary

The earlier successful run of the published reference sidecar demonstrates that
the intended host-side sequence can execute when iroh discovery is available.
The current first-party build is now compiled and unit-tested, but the blocked
network smoke means this environment does **not** provide repeatable transport
evidence. There is still no validation of a public NAT topology, relay
confidentiality under hostile conditions, Android iroh integration, DSH Web
integration, or production authorization policy. Those remain separate gates
before considering an implementation for #235.
