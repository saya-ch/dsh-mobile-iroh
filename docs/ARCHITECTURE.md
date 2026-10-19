# DSH Mobile iroh architecture

## Summary

This project is an independent transport companion for DSH Mobile. It is
intended to carry the existing DSH Web experience over an end-to-end encrypted
iroh/QUIC connection without changing DSH Core or reimplementing DSH sessions.

The current branch contains the protocol foundation and an isolated host-side
validation harness. The production host sidecar, Android transport, and DSH
Mobile adapter are not complete yet.

## Transport model

```text
DSH WebView
    │ HTTP / WebSocket
Android localhost transport adapter
    │ bounded byte streams
iroh endpoint (QUIC, endpoint identity, pairing authorization)
    │ direct path or encrypted relay path
Host iroh sidecar
    │ explicit loopback target only
dsh-mobile HTTPS gateway
    │ authenticated HTTP / WebSocket proxy
DSH Web server
```

The iroh layer does not own DSH sessions, model requests, approvals, files, or
WebView UI. It carries authenticated byte streams to the existing gateway. The
gateway remains responsible for Origin, session, CSRF, WebSocket, request-size,
and upstream policy.

## Components

### Control protocol

The control protocol is a versioned, bounded message envelope. It covers
endpoint hello, pairing, stream open/close, approval forwarding, and decisions.
Unknown protocol versions, message types, fields, routes, and oversized input
fail closed. Nonces and request identifiers are scoped to a peer session and
must not be accepted twice.

### Host sidecar

The host sidecar owns the iroh endpoint identity, pairing window, peer registry,
QUIC streams, and process-level cleanup. It accepts one explicit loopback
gateway target from its parent plugin. It never accepts a client-supplied
arbitrary host or filesystem path.

The plugin communicates with the sidecar through a bounded JSON-lines control
channel. Sidecar lifecycle events are observable, localized, and safe to retry.

### DSH Mobile adapter

The eventual adapter will add an optional iroh transport provider to the DSH
Mobile plugin. It will reuse the existing gateway and device authorization
seam instead of creating a second DSH authentication system. Enabling iroh
must not change LAN, Cloudflare, cpolar, FRP, Tailscale, or self-hosted origin
behavior.

### Android transport

The Android client will preserve the existing DSH Mobile device list, pairing,
WebView, cancellation, back navigation, page scaling, file selection, and
accessibility behavior. iroh will be hidden behind a transport abstraction.

The first Android vertical slice should use a local transport adapter between
the WebView and the native iroh client. The WebView must continue to observe a
strict local origin and must never receive endpoint private keys or unrestricted
native commands.

## Security requirements

- Pairing is one-time, short-lived, rate-limited, and bound to a device record.
- Endpoint identity and paired-device state are stored in private, atomic,
  crash-safe locations.
- Revocation removes host authorization and terminates active streams; deleting
  a local Android row alone is not revocation.
- The sidecar accepts only an explicitly validated loopback gateway target.
- HTTP and WebSocket forwarding preserves the gateway's authentication and
  request policy; raw iroh reachability is not DSH authorization.
- Relay use must be observable as direct or relay without claiming privacy
  properties that have not been tested.
- Logs never contain pairing codes, private keys, cookies, device tokens, or
  model content.

## Evidence gates

The project uses separate evidence for protocol vectors, host loopback and
WebSocket forwarding, packed plugin operation, Android instrumentation and
real-device flows, and public network topologies. A passing lower-level gate
does not promote a higher-level claim.

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the staged delivery
and release criteria.
