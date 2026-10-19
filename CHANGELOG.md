# Changelog

## Unreleased

- Renamed the project to `dsh-mobile-iroh` and created an independent public
  repository.
- Added the versioned JavaScript control-protocol foundation and replay-window
  tests.
- Added an adapted Rust host-side iroh baseline with pairing, peer registry,
  loopback proxying, and stdio control messages.
- Added the DSH Mobile Android WebView baseline under an independent package
  ID, plus a transport injection seam that keeps HTTPS as the default.
- Added loopback gateway and sidecar-controller validation fixtures.

The iroh Android transport, DSH Mobile plugin adapter, real-device validation,
and production release artifacts are still in development.
