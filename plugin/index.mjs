import { createPluginRuntime } from './runtime.mjs'
import { assertLaunchRequest,readLaunchRequest,LAUNCH_PATH } from './security.mjs'

export const name = 'dsh-mobile-iroh'
export const inject = ['webServer','connection','mobileAccess']

/** Install a companion route without registering another Mobile or directory-picker service. */
export async function apply(ctx,config) {
  const runtime = createPluginRuntime({ webServer:ctx.webServer,connection:ctx.connection,dataDirectory:config?.dataDirectory })
  return mountPlugin(ctx,runtime)
}

/** Own the single route and await its runtime before Cordis reports disposal. */
export async function mountPlugin(ctx,runtime) {
  await ctx.effect(() => {
    let closing = false
    const requests = new Set(),aborts = new Set()
    const unregister = ctx.webServer.register({ kind:'exact',path:LAUNCH_PATH,handler:(request,response) => {
      const abort = new AbortController(); aborts.add(abort)
      const signal = AbortSignal.any([abort.signal,AbortSignal.timeout(30_000)])
      const disconnected = () => { if (!response.writableEnded) abort.abort() }
      response.once('close',disconnected)
      const task = (async () => {
        try {
          if (closing) throw Object.assign(new Error('closed'),{ code:'iroh_operation_cancelled' })
          assertLaunchRequest(request,runtime.origin,ctx.connection)
          await readLaunchRequest(request,{ signal })
          await runtime.launch({ signal })
          if (!response.destroyed) { response.writeHead(200,{ 'Content-Type':'application/json','Cache-Control':'no-store' }); response.end('{"version":1,"opened":true}') }
        } catch (error) {
          if (!response.destroyed && !response.headersSent) {
            const status = error?.code === 'iroh_admin_rejected' ? 403 : error?.code === 'iroh_invalid_request' ? 400 : error?.code === 'iroh_launch_busy' ? 409 : 503
            response.writeHead(status,{ 'Content-Type':'application/json','Cache-Control':'no-store' }); response.end('{"version":1,"error":"iroh_open_failed"}')
          }
        } finally { response.removeListener('close',disconnected); aborts.delete(abort) }
      })()
      requests.add(task); void task.then(() => requests.delete(task),() => requests.delete(task))
      return task
    } })
    void runtime.initialize().catch(() => { if (!closing) ctx.logger('dsh-mobile-iroh').warn('iroh_initialization_failed: open the local manager to retry') })
    return async () => {
      closing = true; unregister()
      for (const abort of aborts) abort.abort()
      const shuttingDown = runtime.close()
      const settled = await Promise.allSettled([...requests,shuttingDown])
      const failures = settled.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length) throw new AggregateError(failures,'iroh_cleanup_failed')
    }
  },'dsh-mobile-iroh: independent authenticated operator and transport')
}
