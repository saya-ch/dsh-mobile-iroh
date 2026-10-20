# Changelog

## Unreleased — independent experiment

Nothing in this section has been published as an npm package, APK or GitHub Release.

### Transport and host

- Add a first-party iroh host with one-time pairing, persisted identity and paired peers, reconnect, listing and targeted revocation.
- Preserve HTTPS/WSS bytes through an explicitly selected loopback backend. Bound control messages, connections, proxy streams and handshake deadlines; retire owned connections when the operator or parent exits.
- Add strict stdio supervision and a trusted in-process host operator for Gateway startup, combined pairing descriptors, peer management and explicit recovery.
- Protect Windows state at creation with a private DACL, validate existing state without changing ACLs, reject reparse paths and prevent replacement of an active profile lock. Use descriptor-relative private storage on Unix without chmod of existing user directories.

### Android

- Connect the independent WebView app to the real JNI transport, with a fixed peer-derived HTTPS Origin, pinned CA/hostname verification, restricted CONNECT for Java HTTPS and persistent device records.
- Reuse the device list, naming, startup preference and cancellable connection flow. Retain existing HTTPS pairings and keep stale requests from taking ownership of a newer connection.
- Build arm64-v8a and x86_64 native libraries; check JNI exports, R8 output, ELF and APK alignment. Keep the app package, data and signing separate from production DSH Mobile.

### Validation and integration preparation

- Add real local QUIC, public Mobile Gateway, HTTP/WSS, TLS negative cases, Java HTTPS and Chromium Origin/Cookie checks without model requests or production-profile changes.
- Add an optional public-discovery probe, Windows/Linux CI definitions and native Android build jobs. Public CI and physical-device acceptance remain separate from local results.
- Document the provider registration, Android ABI/signing and unified revocation work needed before any future main-repository integration.
- Move the early non-iroh identity-envelope demo into `experiments/identity`; retain reference-sidecar checks separately from first-party evidence and preserve imported licenses.

Executed results and remaining acceptance work live in [VERIFICATION](VERIFICATION.md), not in this change list.
