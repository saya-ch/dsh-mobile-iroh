# Changelog

## 0.1.0-alpha.1 — 2026-10-23

Initial independent testing release. The npm companion uses the `alpha` channel; Android has its own release-signed package and release tag.

### Desktop companion and distribution

- Install an independent DSH bundle with a General settings action that opens the local iroh manager. Bind authorization to the current Desktop/Web process without requiring a copied login Token or registering another Mobile service.
- Accept the official Desktop's authenticated chunked JSON request while retaining strict framing, a 64-byte decoded body limit, loopback admission and request authorization.
- Reissue short-lived management links, replace expired management sessions and preserve the standalone CLI mode.
- Build the browser client in DSH's supported module format, verify it through the public ClientModuleRegistry and test actual installed tarballs.
- Bundle checksum-verified Windows/Linux x64 Host executables, preserve Linux execution permissions, and include original third-party notices.
- Establish an independent Android release signer, verify APK identity/ABIs/alignment, and include native and Maven dependency notices before signing.

### Transport and host

- Add a first-party iroh host with one-time pairing, persisted identity and paired peers, reconnect, listing and targeted revocation.
- Preserve HTTPS/WSS bytes through an explicitly selected loopback backend. Bound control messages, connections, proxy streams and handshake deadlines; retire owned connections when the operator or parent exits.
- Add strict stdio supervision and a trusted in-process host operator for Gateway startup, combined pairing descriptors, peer management and explicit recovery.
- Persist the Host enabled preference through fixed, versioned native private storage and a separate operation lease. Add explicit restore across Host owners; an off preference stays off, and interrupted saves are not silently replayed.
- Add an authenticated loopback browser console and real runtime owner for configuration, start/stop/reconnect, short-lived QR pairing, transport peers and TLS status. Persist non-secret configuration separately; keep upstream authorization only in process memory.
- Provision a persistent native CA and exact EndpointId leaf, recover only validated interrupted transactions, and retain the native writer lease through public Gateway activation/refresh. Renew without dropping active HTTP sessions or WSS; retain the prior live context and explicit retry on failure.
- Attach an optional public Mobile extension service with explicit providers/local directory and ordered disposal; do not implicitly import a normal DSH profile or claim all-extension compatibility.
- Protect Windows state at creation with a private DACL, validate existing state without changing ACLs, reject reparse paths and prevent replacement of an active profile lock. Use descriptor-relative private storage on Unix without chmod of existing user directories.
- Reject hard-linked private Windows files/leases and retain failed Gateway-start cleanup ownership for explicit retry.
- Guard every host CLI identity-loading entry under the TLS lease so missing or mismatched identities associated with existing CA state cannot be silently regenerated. Preserve an active phone data path after a read-only control timeout; require explicit reconnect before further control commands.

### Android

- Connect the independent WebView app to the real JNI transport, with a fixed peer-derived HTTPS Origin, pinned CA/hostname verification, restricted CONNECT for Java HTTPS and persistent device records.
- Reuse the device list, naming, startup preference and cancellable connection flow. Retain existing HTTPS pairings and keep stale requests from taking ownership of a newer connection.
- Build arm64-v8a and x86_64 native libraries; check JNI exports, R8 output, ELF and APK alignment. Keep the app package, data and signing separate from production DSH Mobile.
- Restart transport monitoring after retained-page recovery, withdraw stale queued checks and preserve the distinction between revocation and network failure.
- Preserve an authenticated remote revocation reason after the actual proxy owner finishes; do not overwrite it with a cleanup-local close. A control EOF received first still remains an ordinary disconnection.
- Avoid recursive regex backtracking while validating certificate-bearing QR descriptors. Retain JSON syntax, duplicate/unknown-field, identity, CA and byte-budget rejection.
- Escape literal JSON braces for Android's ICU regex engine so descriptor validation does not crash during initialization.
- Keep one overall connection deadline across carrier retries, and require both restore-generation and connection ownership before processing a late result.
- Serialize complete Session/CSRF Cookie batches by computer host across Activity replacement; withdraw stale UI completions and queue revocation cleanup after earlier writes. Report rejected platform writes instead of entering a partially authenticated page.

### Validation and integration preparation

- Add real local QUIC, public Mobile Gateway, HTTP/WSS, TLS negative cases, Java HTTPS and Chromium Origin/Cookie checks without model requests or production-profile changes.
- Add a real DSH-profile/frontend regression with public plugin installation, owned Workspace/Session, an unsent draft, observed mux disconnect/reconnect and device revocation. Pin the same-PC browser fixture to its phone bridge instead of letting IPv6 resolve directly to the host Gateway; do not treat the earlier browser-path check as QUIC evidence.
- Exercise complete Host/Gateway recreation with persisted identities and device credentials, expired ephemeral Cookies, fresh authentication and the rejection of stale document views.
- Exercise public Mobile 0.6.16 with actual model selection, module dependency rules, non-empty authenticated extensions and extracted Session ZIP contents while asserting zero model requests. Keep UI-layout fixtures and real runtime acceptance separate.
- Add an optional public-discovery probe, Windows/Linux CI definitions and native Android build jobs. Public CI and physical-device acceptance remain separate from local results.
- Add a bounded read-only lookup driver that separates DNS results from signature-verified pkarr records without logging identities, pairing secrets or raw network errors.
- Document the provider registration, Android ABI/signing and unified revocation work needed before any future main-repository integration.
- Update the three certificate-trust dependencies covered by RUSTSEC-2026-0381/0382/0383; retain the separate upstream `paste` maintenance warning and exact scan receipts. Add a conservative source-license inventory without presenting it as binary-distribution approval.
- Move the early non-iroh identity-envelope demo into `experiments/identity`; retain reference-sidecar checks separately from first-party evidence and preserve imported licenses.

Executed results and remaining acceptance work live in [VERIFICATION](VERIFICATION.md), not in this change list.
