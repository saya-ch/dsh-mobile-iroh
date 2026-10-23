# Local operator interface

`createOperatorServer()` in `server.mjs` serves the independent Host operator interface on a random IPv4 loopback port. It does not own or discover a DSH profile, modify the main Mobile plugin, open the user's browser, or own the supplied Host owner. Close the HTTP server first, then close the Host owner and its dependencies.

The launcher receives `{ origin, launchUrl, close }`. The one-time `launchUrl` carries a 256-bit token only in its fragment; the page removes the fragment before exchanging it for an HttpOnly, SameSite=Strict, short-lived operator cookie. A session-specific CSRF header accompanies every authenticated operation. The random cookie name is different for each server because HTTP cookies are not port-scoped. The default launch lifetime is one minute and the default operator session lifetime is fifteen minutes. Neither credential is a phone-pairing token.

All management requests are version-1, exact-route JSON POSTs with the exact loopback Host and Origin. Unknown fields, unsupported versions, duplicate headers/members, cross-origin/preflight requests, oversized bodies, upgrades and unrecognized paths fail closed. The service does not enable CORS. A compromised current-user process remains a trusted OS principal; local HTTP does not protect against it. There is no TLS or Secure-cookie claim for this loopback management listener.

## Injected owner

The production adapter is `createOperatorOwner()` in `integration/operator-owner.mjs`. It combines the real native configuration/preference/TLS owners, an optional public Mobile extension service and `HostSession`. Construction is inert. `initialize()` loads only non-secret settings and enabled intent; the owner requires a new authorized URL for each process before it can start or restore transport. `close()` drains retained read operations, closes the Host consumer before extensions/TLS/stores, and retains a failed owner for an explicit retry. Cancelling a read-only HTTP observer does not stop an already-connected phone.

The supplied owner implements `status`, `configure`, `start`, `stop`, `reconnect`, `openPairing`, `listPeers`, `forgetPeer`, and `renewTls`. Optional `cancelPairing` withdraws or rotates remote pairing windows without removing existing peers. Every asynchronous method receives `{ signal }`; methods with a value receive `(value, { signal })`. The owner must honor cancellation, prevent late startup, serialize its durable state, and retain ownership until cleanup is confirmed. The HTTP service times out its response and aborts the signal; it does not claim to undo a committed operation. No mutation is automatically retried.

`status()` returns safe metadata: `{ enabled, state, configured?, endpointId?, origin?, localPort?, localOnly?, errorCode?, tls?: { state, notAfter?, renewable } }`. Transport states are `off`, `starting`, `connecting`, `ready`, `error`, `stopping`, and `unconfigured`; TLS states are `missing`, `valid`, `expiring`, `expired`, and `error`. `notAfter` is an epoch-millisecond number. Unknown owner properties, including upstream URLs, private keys and backend targets, are never projected to the browser.

`configure()` receives exactly `{ version: 1, upstreamAuthenticatedUrl, localPort, localOnly }`. The authorized upstream URL must use HTTP(S), an explicit `127.0.0.1` or `[::1]` address and a nonempty `token` parameter. It cannot contain URL user information or a fragment. The owner keeps this authorized URL only in process memory; the browser clears its password field after submission or page hiding. Transport must be stopped before configuration is changed.

`openPairing()` returns `{ descriptor: { expiresAt }, qrPayload }`, with expiry in epoch milliseconds and the same ten-minute/2,200-byte bounds as the versioned pairing-descriptor module. Inject `renderQr(payload)` using the maintained `qrcode` package, for example `qrcode.toBuffer(payload, { type: 'png', errorCorrectionLevel: 'M' })`. The HTTP service accepts a PNG Buffer/Uint8Array or PNG data URL, never SVG/HTML. The normal response contains only the QR image and expiry; only an explicit authenticated copy operation returns the pairing payload. Pairing material is memory-only, never logged, and removed at expiry. The page removes the image on expiry, hiding, navigation, cancellation, stop or logout; copied content and already-scanned descriptors are not claimed revoked merely because the image disappeared.

`listPeers()` and `forgetPeer(id)` return `{ id, name, paired_at, online }[]`; `id` is a full lowercase 64-hex EndpointId and `paired_at` is the native `unix:<seconds>` string. The interface confirms revocation and explicitly distinguishes transport-peer removal from Mobile-device token revocation.

## Command-line use

Run the independent interface with explicit public-artifact and native-binary paths:

```powershell
npm run operator -- --mobile-module C:/path/to/runtime/node_modules/dsh-mobile/lib/index.mjs --executable C:/path/to/dsh-mobile-iroh-host.exe
```

The default private state directory is `homedir()/.dsh-mobile-iroh`, not the current source directory or a DSH profile. Use `--data-dir ABS` for a deliberately separate identity/state directory. Existing unreadable or unsafe state fails closed without repair. `--extensions-dir ABS` opts into the public Mobile local-extension loader at exactly that directory; providers run with the current user's authority and are not a sandbox. Without that flag the real extension service is empty and scans no directory.

An explicit CLI run opens the generated local interface in the system browser. Add `--no-open` to leave the real browser untouched; this mode requires interactive terminal stdout. Only trusted interactive stdout receives the one-time fragment link. Redirected output never includes the fragment or a QR; do not pipe or record an interactive terminal containing the link. `Ctrl-C`/`SIGTERM` closes the HTTP server before its runtime owner. If actual cleanup fails, the owner is retained and another explicit signal retries; it is not reported as a clean shutdown.

Copy the local DSH Web authorized URL into the password field, choose the stable phone logical port, save, then start. Leave local testing disabled for public discovery/relay composition. `localOnly: true` selects the minimal explicitly addressed local test setup with no public discovery or relay; it is not a general public-network direct-only policy. Non-secret `{ version, upstreamOrigin, localPort, localOnly }` is stored in fixed native `operator-config.json`; the full token-bearing URL is never written there. A fresh process restores the chosen port/mode but requires the authorized URL again. Stop transport before changing configuration so existing phone connections are not interrupted implicitly.

## Verification

Run `node --test operator/server.test.mjs` for loopback/Host/Origin/CSRF, short-lived credentials, strict parsing, sensitive-output projection, pairing expiry, owner-error redaction, deadline, disconnect and priority-stop checks.

Set `DSH_MOBILE_MODULE` to an isolated public Mobile runtime module whose dependencies include `playwright` and `qrcode`, then run `node operator/smoke-ui.mjs`. It opens the real static assets in an owned headless Chromium context against a private injected owner. The probe covers form errors, secret-field clearing, generation/copy/expiry, real page-close cancellation, peer confirmation/Escape/focus, three languages, 375px light/dark layout, landscape large text and reduced motion. Screenshots contain no active QR and are saved under ignored `artifacts/operator-ui`. This injected-owner UI probe does not establish real Gateway, public-network, Android Activity or physical-device behavior; those require separate integration checks.

`node operator/smoke-runtime.mjs`, with both explicit `DSH_MOBILE_MODULE` and `DSH_IROH_DSH_BIN`, uses the actual CLI bootstrap/owner, real native stores/TLS, public Gateway/DSH, operator controls and the actual Android transport crate through `transport-sim`. Its fresh profile, browser, model-prompt block and private state belong only to the fixture. It separately checks cancellation of an unconsumed Gateway pairing token while an already-paired transport peer stays connected. This remains host-driven local QUIC and desktop Chromium, not physical Android or public-network evidence. A test script being present does not establish that its latest candidate has passed; use the recorded execution receipt.
