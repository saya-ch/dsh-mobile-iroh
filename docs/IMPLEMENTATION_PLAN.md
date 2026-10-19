# Implementation plan

## Current status

The repository has a local signed-envelope PoC and a smoke harness that can
invoke a separately downloaded `dsh-tether` sidecar. That smoke has passed once
and has also been blocked by unavailable iroh addressing discovery. It is not
production transport evidence.

## Delivery stages

### Stage 1: protocol foundation

- Freeze a versioned control envelope and canonical JSON test vectors.
- Bound message size, fields, identifiers, routes, and nonce lifetime.
- Add replay-window, malformed-message, and unknown-version tests.
- Keep the protocol independent from DSH Session events.

### Stage 2: host transport

- Implement a first-party Rust sidecar with persistent endpoint identity.
- Add pairing, peer registry, revocation, stream limits, timeouts, and cleanup.
- Forward only to a plugin-owned loopback gateway target.
- Test HTTP and WebSocket byte preservation and adversarial request headers.

### Stage 3: plugin adapter

- Add an optional iroh remote provider without changing existing providers.
- Reuse the DSH Mobile gateway for authentication and WebSocket policy.
- Add packed-plugin, sidecar lifecycle, recovery, and configuration tests.

### Stage 4: Android transport

- Add a transport abstraction beneath the existing WebView and device store.
- The shared Rust `android-transport` crate now owns endpoint setup, versioned
  pairing, and the loopback byte proxy; JNI/Android packaging is still pending.
- Keep pairing, device names, cancellation, Back behavior, scaling, files,
  camera, notifications, and localization consistent with DSH Mobile.
- Add the native bridge only after the authenticated Rust transport is wired to
  the WebView origin and its lifecycle is covered on a real device.

### Stage 5: network and release validation

- Repeat direct and relay tests across controlled networks.
- Verify disconnect, reconnect, revocation, expiry, rotation, and multi-device
  behavior on physical Android hardware.
- Run plugin and APK release gates independently, including licenses, hashes,
  signer evidence, and public-artifact verification.

## Non-goals

This project will not patch DSH Core, replace the DSH Web frontend, duplicate
the DSH agent loop, or silently enable iroh for existing DSH Mobile users.
