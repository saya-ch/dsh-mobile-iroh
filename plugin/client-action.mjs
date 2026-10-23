/** Local Desktop/Web visibility; phone gateways never receive the management action. */
export function isLocalManager(location,document) {
  if (document.querySelector('meta[name="dsh-mobile-gateway"][content="authenticated"]')) return false
  return location.protocol === 'dsh-app:' && location.hostname === 'app'
    || ['http:','https:'].includes(location.protocol) && ['127.0.0.1','localhost','[::1]'].includes(location.hostname)
}

/** One bounded user action; disposal prevents stale feedback and duplicate launches. */
export function createLaunchAction({ send,onChange,timeoutMs = 30_000 }) {
  let active,closed = false
  return Object.freeze({
    async run() {
      if (active || closed) return
      const abort = new AbortController(); active = abort
      const timer = setTimeout(() => abort.abort(),timeoutMs)
      onChange('busy')
      try {
        await send(abort.signal)
        if (!closed) onChange(abort.signal.aborted ? 'error' : 'opened')
      } catch { if (!closed) onChange('error') }
      finally { clearTimeout(timer); if (active === abort) active = undefined }
    },
    close() { closed = true; active?.abort() },
  })
}
