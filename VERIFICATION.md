# Independent iroh verification

This record belongs to the separate `dsh-mobile-iroh-poc` experiment. It is not a release record for `dsh-mobile`, does not change `deepseek-harness`, and does not claim that #235 is implemented in either project.

## Artifact under test

- Project: [`zexadev/dsh-tether`](https://github.com/zexadev/dsh-tether)
- Source revision inspected: `e1ffab8013f29d39321332be45b2c25d1ffcdaa4`
- Release asset: `dsh-tether-host-win32-x64-0.1.22.tgz`
- Rust sidecar package: `dsh-tether-host-win32-x64@0.1.22`
- Extracted executable SHA-256: `F45304EF7932EB55318F33BEA0F98BB03B0A2014FFF4261BCA891D65F69E1C1F`
- Declared iroh dependency: `1.0.0`; the published lockfile resolves `iroh` and its main support crates to `1.0.3`.

## Host-side smoke sequence

`npm run smoke:iroh` starts the released Windows sidecar twice in isolation: one `host` process and one `phone-sim` process. It then checks all of the following before reporting `passed`:

1. the host emits an endpoint identity and a pairing window;
2. the phone stand-in completes the real iroh pairing handshake;
3. a proxy stream reaches a local HTTP server and returns the expected body;
4. an approval request travels to the phone stand-in and an `allowed-once` decision returns to the host.

The script uses temporary data directories and removes them after the run. It does not contact DSH, send a model request, or alter any installed profile.

## Results on 2026-10-19

- Local identity/mapping PoC: `npm test` — 2 passed, 0 failed.
- Local HTTP demo: `npm run demo` — passed.
- Real released sidecar smoke: one run passed pairing, proxy, and approval round trip.
- Two subsequent runs were classified `blocked`, not `passed`, because the iroh endpoint could not obtain addressing information (`No addressing information available`; DNS/relay discovery failed). This is an environment/network observation, not evidence that the transport is reliably available.

## Acceptance boundary

The successful run demonstrates that the published sidecar can execute the intended host-side sequence when iroh discovery is available. The repeated blocked runs mean this environment does **not** provide repeatable transport evidence. There is still no validation of a public NAT topology, relay confidentiality under hostile conditions, Android integration, DSH Web integration, or production authorization policy. Those remain separate gates before considering an implementation for #235.
