import { isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * Own an optional public Mobile extension service in its own Cordis Context.
 * Providers run with the current user's authority, not in a security sandbox.
 * Close every Gateway consumer before closing this owner; no service is attached
 * when the caller omits the owner from createIrohGatewayFactory.
 */
export async function createExtensionHost({ mobile, modulePath, Context, providers = [], localDirectory, hostExecution } = {}) {
  if (Context === undefined && isAbsolute(modulePath ?? '')) {
    const cordis = await import(pathToFileURL(createRequire(modulePath).resolve('@deepseek-ai/cordis')).href)
    Context = cordis.Context
  }
  if (typeof mobile?.createMobileAccessService !== 'function' || typeof Context !== 'function'
    || !Array.isArray(providers) || providers.some(provider => typeof provider !== 'function')
    || localDirectory !== undefined && !isAbsolute(localDirectory)) throw new Error('Invalid public Mobile extension host options')
  if (hostExecution !== undefined && localDirectory === undefined) throw new Error('Local host execution requires an explicit extension directory')
  const context = new Context()
  let service, closing = false, closed = false, closeTask
  const close = () => {
    if (closed) return Promise.resolve()
    closeTask ??= (async () => {
      closing = true
      await service?.stopLocal()
      await context.fiber.dispose()
      closed = true
    })().finally(() => { closeTask = undefined })
    return closeTask
  }
  const registerExtension = definition => {
    if (closing) throw new Error('Mobile extension host is closing')
    let disposer
    context.effect(() => { disposer = service.registerExtension(definition); return disposer })
    return disposer
  }
  const owner = Object.freeze({ get service() { return service }, registerExtension, status: () => service.status(), close })
  try {
    service = mobile.createMobileAccessService(context)
    for (const provider of providers) {
      const dispose = await provider(Object.freeze({ context, service, registerExtension }))
      if (dispose !== undefined) {
        if (typeof dispose !== 'function') throw new Error('Mobile extension provider must return a disposer or undefined')
        context.effect(() => dispose)
      }
    }
    if (localDirectory !== undefined) await service.startLocal(localDirectory, context, { hostExecution })
    return owner
  } catch (error) {
    try { await close() } catch (cleanupError) {
      const failure = new AggregateError([error, cleanupError], 'Mobile extension host startup and cleanup failed; retain the owner for cleanup retry')
      failure.extensionHost = owner
      failure.preserveFixtureRoot = true
      throw failure
    }
    throw error
  }
}
