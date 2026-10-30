# Agent maintenance

`dsh-mobile-iroh` retains the standalone transport prototype and published
Host artifacts still consumed by DSH Mobile. Integrated Host, shared transport
core and Android implementation have lived in `dsh-mobile` since 0.7.0. Read
the [current repository role](README.en.md#current-role) before choosing where
work belongs; do not describe integration as pending or retire artifacts that
the main component catalog still references.

Do not modify `C:\develop\dsh-mobile` or `C:\develop\deepseek-harness` while
working here. Read those repositories to compare contracts; their source and
bundled frontend artifacts remain read-only. Change an installed profile only
for explicitly authorized installation or upgrade work, after preserving its
configuration and completing the application's normal shutdown.

Do not claim production support from a local PoC, one successful network run,
an external sidecar, or a unit test. Separate protocol tests, host loopback
tests, packed WebView tests, Android device tests, and real network topology
tests in reports and release notes.

Keep the DSH Mobile user experience familiar: reuse its device, pairing,
credential, WebView, cancellation, and accessibility behavior where the
transport permits. Do not copy DSH session or agent-loop logic into this
repository. The iroh layer is a transport and authorization carrier only.

Every transport message must be versioned, bounded, authenticated, replay
protected, and rejected closed on unknown fields or routes. Every child
process, native bridge, relay stream, and temporary credential has an explicit
owner and cleanup path.

Preserve upstream copyright and license notices when reusing reference code.
Do not publish npm packages, APKs, sidecars, or release tags until the exact
candidate has passed its relevant gates and the evidence is recorded.

Use full EndpointIds for HTTPS authority and storage identity. Keep a stable
explicit local port; do not silently choose another Origin after a bind failure.
The sidecar proxies opaque TLS, so it cannot infer Mobile device IDs. Keep
transport revocation, Mobile-token revocation and network failure distinct.

Private-state operations must validate existing ownership and permissions without
repairing them. Never chmod an existing user home/development directory, inherit
a broad Windows DACL for new secrets, follow untrusted links or regenerate an
unreadable identity. Tests use only owned private directories and clean them up.

Preserve source-owned request generations across JNI, Activity and subprocess
cleanup. A cancelled request must not revive a WebView or close its successor.
Test actual Android transport code through transport-sim, but label that as a
host-driven test, not a physical-device or Android-runtime result.
