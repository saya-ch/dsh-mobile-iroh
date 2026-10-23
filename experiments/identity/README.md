# Historical identity experiment

These JavaScript files predate the first-party Rust transport. They demonstrate
signed envelopes, a local HTTP mapping and a bounded in-memory replay window.
They do not implement iroh, durable pairing, NAT traversal or the production
message formats. `npm run demo` runs only this historical HTTP demonstration.

The actual QUIC protocol is in [tether-core](../../tether-core/src/lib.rs),
and the parent-to-sidecar protocol is documented in [host](../../host/README.md).
First-party acceptance uses `npm run smoke:iroh` and `npm run smoke:gateway`.
