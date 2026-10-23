/** Opt-in public addressing; forced-relay success is not cross-network NAT evidence. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSidecarFixtureRoot, firstPartyExecutable, resolveSidecarIdentity, startPhone, waitForSidecarEvent } from '../src/first-party-fixture.mjs'
import { SidecarController } from '../src/sidecar-controller.mjs'

/** Track actual close from spawn time, including children exiting before cleanup. */
export function createPublicProcessOwner({ spawnImpl = spawn, diagnosticLimit = 8192 } = {}) {
  const records = [], diagnostics = new Map()
  let closing = false
  return {
    records, diagnostics,
    launch(label, file, args, options, onStderr) {
      if (closing) throw new Error('public probe process owner is closing')
      const child = spawnImpl(file, args, options)
      const record = { label, child, closed: false }
      record.done = new Promise(resolveClose => child.once('close', (code, signal) => {
        record.closed = true; record.result = { code, signal }; resolveClose(record.result)
      }))
      records.push(record)
      child.stderr.on('data', bytes => {
        const retained = Buffer.concat([diagnostics.get(label) ?? Buffer.alloc(0), bytes])
        diagnostics.set(label, retained.subarray(Math.max(0, retained.length - diagnosticLimit)))
        onStderr?.(child, bytes)
      })
      child.stderr.on('error', () => {})
      child.once('error', () => {})
      return child
    },
    cancel() { closing = true; for (const { child, closed } of records) if (!closed) child.kill() },
    async drain(timeoutMs = 2000) {
      closing = true
      const errors = []
      await Promise.all(records.map(async record => {
        if (record.closed) { await record.done; return }
        let timer
        try {
          record.child.kill('SIGKILL')
          const closed = await Promise.race([record.done.then(() => true), new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), timeoutMs) })])
          if (!closed) errors.push(`owned_${record.label}_did_not_close`)
        } catch { errors.push(`owned_${record.label}_termination_failed`) }
        finally { clearTimeout(timer) }
      }))
      return errors
    },
    exits() { return records.map(({ label, closed, result }) => ({ label, closed, ...(result ?? {}) })) },
  }
}

/** Expiration aborts work, prevents new children and drains the losing promise. */
export async function runWithPublicBudget(work, { timeoutMs, drainTimeoutMs = 5000, cancel }) {
  const controller = new AbortController()
  let timer, expired = false
  const check = () => { if (expired) throw new Error('public discovery work budget exceeded') }
  const task = Promise.resolve().then(() => work({ signal: controller.signal, check }))
  const settled = task.then(() => true, () => true)
  try {
    return await Promise.race([task, new Promise((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; controller.abort(); reject(new Error('public discovery work budget exceeded')) }, timeoutMs)
    })])
  } catch (error) {
    if (expired) {
      let cancelError, deadline
      try { await cancel() } catch (failure) { cancelError = failure }
      let workDrained
      try { workDrained = await Promise.race([settled, new Promise(resolveWait => { deadline = setTimeout(() => resolveWait(false), drainTimeoutMs) })]) }
      finally { clearTimeout(deadline) }
      const failure = cancelError ? new AggregateError([error, cancelError], 'public probe expiration and cancellation failed') : error
      failure.publicBudgetExpired = true; failure.workDrained = workDrained
      throw failure
    }
    throw error
  } finally { clearTimeout(timer) }
}

/** Remove private state only after work and every owner confirm termination. */
export async function cleanupPublicProbe({ workDrained = true, closeOwners, processes, closeUpstream, owned, drainTimeoutMs = 2000 }) {
  const cleanupErrors = []
  if (!workDrained) cleanupErrors.push('public_work_did_not_drain')
  for (const close of closeOwners) { try { await close() } catch { cleanupErrors.push('owned_controller_cleanup_failed') } }
  cleanupErrors.push(...await processes.drain(drainTimeoutMs))
  try { await closeUpstream() } catch { cleanupErrors.push('upstream_cleanup_failed') }
  if (cleanupErrors.length === 0) { try { await owned.cleanup() } catch { cleanupErrors.push('private_state_cleanup_failed') } }
  return { cleanupComplete: cleanupErrors.length === 0, cleanupErrors,
    ...(cleanupErrors.length ? { preservedFixtureRoot: owned.directory } : {}) }
}

/** One bounded public probe; relay-only disables every phone IP transport. */
export async function runPublicDiscovery({ relayOnly = false, localOnly = false } = {}) {
  if (relayOnly && localOnly) throw new Error('local-only and relay-only probes are mutually exclusive')
  const owned = await createSidecarFixtureRoot(localOnly ? 'controlled-setup' : relayOnly ? 'forced-relay' : 'public-discovery')
  const processes = createPublicProcessOwner(), sockets = new Set()
  const executable = fileURLToPath(new URL(`../target/debug/dsh-mobile-iroh-transport-sim${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url))
  let host, phone, upstream, pairingCode, result, selectedPath, exitCode = 0, workDrained = true, phase = 'host-setup'
  const checks = []
  const safeDiagnostic = bytes => {
    let value = bytes.toString('utf8').replaceAll(owned.directory, '<private-state>')
    if (pairingCode !== undefined) value = value.replaceAll(pairingCode, '<pairing-code>')
    return value.replace(/\b[A-Za-z0-9_-]{43,}\b/gu, '<identity-or-secret>').replace(/\b[0-9]{6}\b/gu, '<six-digits>')
  }
  const launchPhone = (label, options, { connectTimeoutMs = 18000, cancelOnSetup = false } = {}) => {
    let setupSeen = false, setupDiagnostic = ''
    const task = startPhone({ executable, peerAddresses: [], localOnly: false, gracefulStdin: true,
      readyTimeoutMs: connectTimeoutMs + 4000, stopTimeoutMs: 1500,
      spawnImpl: (file, args, spawned) => processes.launch(label, file,
        [...args, ...(relayOnly ? ['--relay-only'] : []), '--connect-timeout-ms', String(connectTimeoutMs)], spawned,
        cancelOnSetup ? (child, bytes) => {
          setupDiagnostic = `${setupDiagnostic}${bytes.toString('utf8')}`.slice(-512)
          if (!setupSeen && setupDiagnostic.includes('transport-sim: connection setup started')) { setupSeen = true; child.stdin.end() }
        } : undefined), ...options })
    return { task, setupSeen: () => setupSeen }
  }
  try {
    result = await runWithPublicBudget(async control => {
      upstream = createServer((_request, response) => response.end('public-addressing-smoke'))
      upstream.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)) })
      await new Promise((resolveListen, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolveListen) })
      control.check()
      host = new SidecarController({ executable: firstPartyExecutable, dataDir: join(owned.directory, 'host'),
        proxyTarget: `http://127.0.0.1:${upstream.address().port}`, spawnImpl: (file, args, options) => processes.launch('host', file, args, options),
        readyTimeoutMs: 12000, stopTimeoutMs: 1500 })
      const ready = await host.start({ pair: true, localOnly })
      control.check()
      const pairing = await waitForSidecarEvent(host, event => event.type === 'pairing', { timeoutMs: 3000 })
      pairingCode = pairing.code
      control.check()
      phase = localOnly ? 'controlled-local-connection' : relayOnly ? 'endpoint-id-only-forced-relay' : 'default-address-discovery'
      const phoneData = join(owned.directory, 'phone'), proxyListen = localOnly ? '127.0.0.1:25447' : relayOnly ? '127.0.0.1:25446' : '127.0.0.1:25445'
      const healthyAddressing = localOnly ? { localOnly: true, peerAddresses: ready.direct_addresses } : {}
      phone = await launchPhone('phone', { dataDir: phoneData, endpointId: ready.endpoint_id, code: pairing.code, proxyListen, ...healthyAddressing }).task
      const forward = async () => {
        control.check()
        const response = await fetch(`${phone.localAddress}/probe`, { signal: AbortSignal.any([control.signal, AbortSignal.timeout(3000)]) })
        assert.equal(response.status, 200); assert.equal(await response.text(), 'public-addressing-smoke')
      }
      phase = 'http-forwarding'
      await forward()
      const path = await waitForSidecarEvent(host, event => event.type === 'peer-path', { timeoutMs: 2000 })
      selectedPath = path.kind
      if (relayOnly) assert.equal(path.kind, 'relay', 'Forced relay probe selected a direct path')
      if (localOnly) assert.equal(path.kind, 'direct')
      checks.push(localOnly ? 'explicit loopback pairing and exact HTTP bytes through actual Android transport crate' : 'EndpointId-only public lookup, pairing and exact HTTP bytes through actual Android transport crate')
      if (relayOnly || localOnly) {
        if (relayOnly) checks.push('N0 preset plus clear_ip_transports; host reports authenticated peer-path relay')
        phase = 'same-identity-reconnect'
        const eventFloor = host.events.length
        const closed = await phone.stop()
        assert.deepEqual(closed, { exitCode: 0, signal: null })
        control.check()
        phone = await launchPhone('phone-reconnect', { dataDir: phoneData, endpointId: ready.endpoint_id, proxyListen, ...healthyAddressing }).task
        await forward()
        const observed = { get events() { return host.events.slice(eventFloor) }, onEvent: listener => host.onEvent(listener) }
        const reconnected = await waitForSidecarEvent(observed, event => event.type === 'peer-path', { timeoutMs: 2000 })
        assert.equal(reconnected.kind, path.kind); assert.equal(reconnected.peer, path.peer)
        checks.push(`graceful close and same phone identity/port reconnect without another pairing code, observed ${path.kind}`)
        phase = 'bad-endpoint-id-isolation'
        const malformed = processes.launch('bad-endpoint-id', executable, ['phone-sim', '--data-dir', join(owned.directory, 'malformed'), '--peer', 'not-an-endpoint', '--relay-only'],
          { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
        const malformedRecord = processes.records.find(record => record.child === malformed)
        assert.deepEqual(await malformedRecord.done, { code: 2, signal: null })
        await assert.rejects(access(join(owned.directory, 'malformed')), { code: 'ENOENT' })
        await forward()
        checks.push('malformed EndpointId rejected before private-state creation; active paired transport remains usable')
        control.check()
        const unknown = await resolveSidecarIdentity({ executable: firstPartyExecutable, dataDir: join(owned.directory, 'unpublished'),
          spawnImpl: (file, args, options) => processes.launch('unpublished-id', file, args, options) })
        phase = 'unpublished-endpoint-isolation'
        await assert.rejects(launchPhone('unpublished-peer', { dataDir: join(owned.directory, 'unknown-phone'), endpointId: unknown, proxyListen }, { connectTimeoutMs: 1200 }).task)
        await forward()
        checks.push('unpublished valid EndpointId fails without proxy readiness and does not revoke or close the active transport')
        phase = 'setup-cancellation-isolation'
        const cancelled = launchPhone('setup-cancel', { dataDir: join(owned.directory, 'cancel-phone'), endpointId: unknown, proxyListen }, { cancelOnSetup: true })
        await assert.rejects(cancelled.task)
        assert.equal(cancelled.setupSeen(), true)
        assert.deepEqual(processes.records.find(record => record.label === 'setup-cancel').result, { code: 0, signal: null })
        await forward()
        checks.push('stdin cancellation during native connection setup confirms exit 0 without closing the active paired transport')
        phase = 'readiness-timeout-isolation'
        await assert.rejects(launchPhone('readiness-timeout', { dataDir: join(owned.directory, 'timeout-phone'), endpointId: unknown, proxyListen,
          readyTimeoutMs: 25 }).task, /phone proxy-ready timeout/u)
        assert.equal(processes.records.find(record => record.label === 'readiness-timeout').closed, true)
        await forward()
        checks.push('parent readiness timeout drains the actual process close; active paired transport still forwards afterwards')
      }
      control.check()
      return { status: 'passed', topology: 'two processes on one PC', addressing: localOnly ? 'explicit loopback fixture' : 'iroh N0 defaults, EndpointId only', explicitPeerAddresses: localOnly,
        relayOnly, actualAndroidTransportCrate: true, selectedPath: path.kind, checks, crossNetworkNat: false, physicalAndroid: false, modelRequests: 0 }
    }, { timeoutMs: localOnly ? 30000 : relayOnly ? 75000 : 35000, cancel: () => processes.cancel() })
  } catch (error) {
    workDrained = error.workDrained !== false
    const networkPhase = !localOnly && error.name !== 'AssertionError' && ['default-address-discovery', 'endpoint-id-only-forced-relay', 'http-forwarding', 'same-identity-reconnect'].includes(phase)
    exitCode = error.publicBudgetExpired || networkPhase ? 2 : 1
    result = { status: exitCode === 2 ? 'blocked' : 'failed', reason: error.publicBudgetExpired ? 'overall_public_discovery_budget_exceeded' : networkPhase ? 'public_addressing_or_transport_unavailable' : 'public_probe_assertion_failed',
      phase, checks, relayOnly, selectedPath: selectedPath ?? 'unobserved', initialRelayVerified: relayOnly && selectedPath === 'relay',
      topology: 'two processes on one PC', explicitPeerAddresses: localOnly, crossNetworkNat: false, physicalAndroid: false, modelRequests: 0 }
  } finally {
    const cleanup = await cleanupPublicProbe({ workDrained, closeOwners: [() => phone?.stop(), () => host?.stop()], processes, owned,
      closeUpstream: async () => { for (const socket of sockets) socket.destroy(); if (upstream?.listening) await new Promise((resolveClose, reject) => upstream.close(error => error ? reject(error) : resolveClose())) } })
    if (!cleanup.cleanupComplete) exitCode = 1
    result = { ...result, ...cleanup, ...(!cleanup.cleanupComplete ? { status: 'failed' } : {}), exits: processes.exits(),
      diagnostics: Object.fromEntries([...processes.diagnostics].map(([label, bytes]) => [label, safeDiagnostic(bytes)])) }
  }
  return { result, exitCode }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { result, exitCode } = await runPublicDiscovery({ relayOnly: process.argv.includes('--relay-only'), localOnly: process.argv.includes('--local-only') })
  console.log(JSON.stringify(result))
  process.exitCode = exitCode
}
