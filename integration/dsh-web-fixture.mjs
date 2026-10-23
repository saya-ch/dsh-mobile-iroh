/** Own a supported DSH CLI web profile without inheriting user credentials or profiles. */
/*
 * Profile composition adapts dsh-mobile/scripts/mobile-boot-fixture.mjs and
 * packed-profile.mjs. Copyright 2026 Guangqi Zhang.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License. Modified for the independent iroh fixture.
 */
import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

/** Remove launch and pairing credentials from bounded process diagnostics. */
export function redactDshOutput(value) {
  return String(value)
    .replace(/([?&#](?:token|key)=)[^\s&#]+/giu, '$1<redacted>')
    .replace(/("(?:token|key|sessionToken|csrfToken|deviceToken)"\s*:\s*")[^"]*/giu, '$1<redacted>')
    .slice(-12000)
}

/** Construct a minimal child environment, never copying arbitrary service credentials. */
export function dshFixtureEnvironment(root, source = process.env) {
  if (!isAbsolute(root)) throw new Error('DSH fixture root must be absolute')
  const environment = {}
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL']) {
    if (source[name] !== undefined) environment[name] = source[name]
  }
  return {
    ...environment, DSH_HOME: join(root, 'dsh-home'), DSH_AGENTS_HOME: join(root, 'agents'),
    DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: '', NODE_OPTIONS: '', NODE_PATH: '',
    TSX_TSCONFIG_PATH: '', NPM_CONFIG_USERCONFIG: join(root, 'fixture.npmrc'),
    npm_config_userconfig: join(root, 'fixture.npmrc'), XDG_CONFIG_HOME: join(root, 'config'),
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  }
}

function validateLaunch({ dshBin, root, timeoutMs, shutdownTimeoutMs }) {
  if (!isAbsolute(dshBin ?? '') || !isAbsolute(root ?? '')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1) throw new Error('Invalid isolated DSH launch options')
}

async function validateRoot(root) {
  const metadata = await lstat(root)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('DSH fixture root must be an owned real directory')
}

/** Terminate a fixture process tree, including pnpm children, before awaiting its close. */
async function terminateTree(child, signal, timeoutMs) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) { child.kill(signal); return }
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
    return
  }
  const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'], env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
  })
  let operationError, timedOut = false, deadline, finalGuard
  try {
    await new Promise((resolve, reject) => {
      killer.once('error', error => { operationError = error })
      killer.once('close', () => resolve())
      deadline = setTimeout(() => {
        timedOut = true; killer.kill('SIGKILL')
        finalGuard = setTimeout(() => reject(new Error('Isolated DSH termination helper did not close; preserve its root')), timeoutMs)
      }, timeoutMs)
    })
    if (operationError || timedOut) throw new Error('Isolated DSH termination helper failed; preserve its root')
  } finally { clearTimeout(deadline); clearTimeout(finalGuard) }
}

/** Capture bounded diagnostics and expose actual child-close, never only an exit signal. */
function ownDshChild({ dshBin, root, args, cwd = root, shutdownTimeoutMs, spawnImpl }) {
  const child = spawnImpl(process.execPath, [dshBin, ...args], {
    cwd, env: dshFixtureEnvironment(root), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    detached: process.platform !== 'win32',
  })
  let output = '', exited = false, closeTask, processFailure
  const listeners = new Set()
  const publish = () => { for (const listener of listeners) listener() }
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    exited = true; resolve({ code, signal }); publish()
  }))
  child.once('error', () => { processFailure = 'Isolated DSH process failed'; publish() })
  for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
    stream.setEncoding('utf8').on('data', chunk => { output = `${output}${chunk}`.slice(-24000); publish() })
    stream.on('error', () => { processFailure = `Isolated DSH ${name} failed`; publish() })
  }
  const logs = () => redactDshOutput(output)
  const close = () => {
    closeTask ??= (async () => {
      if (exited) return { ...(await closed), forced: false }
      let forced = process.platform === 'win32' && Number.isSafeInteger(child.pid), watchdog, finalGuard
      const failure = new Promise((_resolve, reject) => {
        watchdog = setTimeout(() => {
          if (exited) return
          forced = true
          if (process.platform !== 'win32' || !Number.isSafeInteger(child.pid)) {
            void terminateTree(child, 'SIGKILL', shutdownTimeoutMs).catch(reject)
          }
          finalGuard = setTimeout(() => reject(new Error('Isolated DSH process did not close; preserve its root')), shutdownTimeoutMs)
        }, shutdownTimeoutMs)
      })
      void failure.catch(() => {})
      try {
        await terminateTree(child, 'SIGTERM', shutdownTimeoutMs)
        return { ...(await Promise.race([closed, failure])), forced }
      } finally { clearTimeout(watchdog); clearTimeout(finalGuard) }
    })()
    return closeTask
  }
  const waitFor = async (accept, timeoutMs, timeoutMessage) => {
    let deadline, inspect
    try {
      return await new Promise((resolve, reject) => {
        inspect = () => {
          if (processFailure) { reject(new Error(`${processFailure}\n${logs()}`)); return }
          try {
            const value = accept(output, exited)
            if (value !== undefined) resolve(value)
          } catch (error) { reject(new Error(`${error.message}\n${logs()}`)) }
        }
        listeners.add(inspect)
        deadline = setTimeout(() => reject(new Error(`${timeoutMessage}\n${logs()}`)), timeoutMs)
        inspect()
      })
    } catch (error) {
      try { await close() } catch (cleanup) {
        const failure = new AggregateError([error, cleanup], 'Isolated DSH command and cleanup failed; preserve its root')
        failure.preserveFixtureRoot = true
        throw failure
      }
      throw error
    } finally { clearTimeout(deadline); listeners.delete(inspect) }
  }
  return { child, closed, close, waitFor, logs }
}

/**
 * Install the exact public Mobile artifact through DSH's supported plugin command.
 * The fresh profile and pnpm store are owned by root; no sibling checkout is read.
 */
export async function createDshWebProfile({ dshBin, mobileModule, root, extraPatches = [], installTimeoutMs = 180000, shutdownTimeoutMs = 12000, spawnImpl = spawn }) {
  validateLaunch({ dshBin, root, timeoutMs: installTimeoutMs, shutdownTimeoutMs })
  if (!isAbsolute(mobileModule ?? '')) throw new Error('Mobile artifact module must be absolute')
  await validateRoot(root)
  const manifest = JSON.parse(await readFile(join(dirname(mobileModule), '..', 'package.json'), 'utf8'))
  if (manifest.name !== 'dsh-mobile' || !/^\d+\.\d+\.\d+(?:-[a-z\d]+(?:[.-][a-z\d]+)*)?$/iu.test(manifest.version ?? '')) {
    throw new Error('Mobile artifact must declare an exact dsh-mobile version')
  }
  const home = join(root, 'dsh-home'), profile = join(home, 'profiles', 'web'), state = join(home, 'mobile-access')
  await mkdir(profile, { recursive: true })
  await mkdir(state)
  await mkdir(join(root, 'agents'))
  await writeFile(join(root, 'fixture.npmrc'), '', { flag: 'wx' })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2) + '\n', { flag: 'wx' })
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
    + `storeDir: ${JSON.stringify(join(root, 'package-store'))}\npackageImportMethod: copy\n`, { flag: 'wx' })
  const localSettings = { listenHost: '127.0.0.1', listenPort: 0, allowedCidrs: ['127.0.0.0/8'], tls: { mode: 'disabled' } }
  await writeFile(join(state, 'setup.json'), JSON.stringify({ version: 1, ...localSettings }) + '\n', { flag: 'wx' })
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ id: 'mobile-access', config: {
    setupFile: join(state, 'setup.json'), stateFile: join(state, 'devices.json'), controlFile: join(state, 'control.json'),
    customCssFile: join(state, 'mobile.css'), customScriptFile: join(state, 'mobile.js'), initiallyEnabled: false, ...localSettings,
  } }, ...extraPatches]) + '\n', { flag: 'wx' })
  const owner = ownDshChild({ dshBin, root, cwd: profile,
    args: ['plugin', '--profile', 'web', 'add', `dsh-mobile@${manifest.version}`, '--ignore-scripts'], shutdownTimeoutMs, spawnImpl })
  const result = await owner.waitFor((_output, exited) => exited ? owner.closed : undefined, installTimeoutMs, 'Isolated Mobile plugin installation timed out')
  if (result.code !== 0 || result.signal !== null) throw new Error(`Isolated Mobile plugin installation failed (${JSON.stringify(result)})\n${owner.logs()}`)
  const installed = await realpath(join(profile, 'node_modules', 'dsh-mobile'))
  const installedRelative = relative(await realpath(root), installed)
  if (isAbsolute(installedRelative) || installedRelative === '..' || installedRelative.startsWith(`..${sep}`)) throw new Error('Installed Mobile package escaped its owned profile')
  const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  const installedProfile = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  if (installedManifest.name !== manifest.name || installedManifest.version !== manifest.version
    || !installedProfile.dsh?.profile?.bundles?.includes('dsh-mobile')) throw new Error('Installed Mobile bundle does not match the requested public artifact')
  return Object.freeze({ home, profile, mobileVersion: installedManifest.version, installation: result, logs: owner.logs })
}

/**
 * Launch only `dsh web`. The caller owns the existing isolated root and must
 * await close before removing it. A startup failure also drains the child.
 */
export async function startDshWeb({ dshBin, root, startupTimeoutMs = 90000, shutdownTimeoutMs = 12000, spawnImpl = spawn }) {
  validateLaunch({ dshBin, root, timeoutMs: startupTimeoutMs, shutdownTimeoutMs })
  await validateRoot(root)
  await mkdir(join(root, 'dsh-home'), { recursive: true })
  const owner = ownDshChild({ dshBin, root, args: ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'], shutdownTimeoutMs, spawnImpl })
  const authenticatedUrl = await owner.waitFor((output, exited) => {
    if (exited) throw new Error('Isolated DSH exited before readiness')
    const value = /dsh web: (http:\/\/[^\s]+)\r?\n/u.exec(output)?.[1]
    if (value === undefined) return
    try {
      const url = new URL(value)
      if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || !url.searchParams.get('token')) throw new Error('unexpected address')
      return url.href
    } catch { throw new Error('Isolated DSH reported an invalid launch address') }
  }, startupTimeoutMs, 'Isolated DSH startup timed out')
  return Object.freeze({ authenticatedUrl, origin: new URL(authenticatedUrl).origin, ...owner })
}
