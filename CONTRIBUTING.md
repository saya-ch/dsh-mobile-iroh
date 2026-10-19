# Contributing to DSH Mobile iroh

This repository is an independent transport companion. Keep changes scoped to
iroh transport, the host sidecar, the Android transport seam, and the DSH Web
carrier. Do not modify DSH Core or the main `dsh-mobile` repository from this
checkout.

## Local checks

```powershell
npm test
npm run demo
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
Set-Location apps/mobile/android
./gradlew.bat :app:testDebugUnitTest --no-daemon
```

The iroh smoke command needs a working DNS/relay path. A `blocked` result is
environment evidence, not a successful transport result.

## Evidence rules

Report protocol tests, host loopback tests, packed plugin tests, Android unit
tests, real-device tests, and public network tests separately. Do not promote a
passing lower-level check into a production support claim.

Preserve upstream copyright notices when adapting reference code. Do not add
credentials, private keys, pairing codes, model data, or generated build
outputs to the repository.
