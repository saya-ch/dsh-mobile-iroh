import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDshWebProfile, dshFixtureEnvironment, redactDshOutput, startDshWeb } from './dsh-web-fixture.mjs'

test('DSH child environment isolates profiles, credentials and global Node options', () => {
  const root = resolve('owned-fixture')
  const env = dshFixtureEnvironment(root, { PATH: 'tools', DSH_HOME: 'real-home', DEEPSEEK_API_KEY: 'secret',
    PRIVATE_TOKEN: 'secret', NODE_OPTIONS: '--inspect', HTTPS_PROXY: 'real-proxy' })
  assert.equal(env.PATH, 'tools')
  assert.equal(env.DSH_HOME, join(root, 'dsh-home'))
  assert.equal(env.PRIVATE_TOKEN, undefined)
  assert.equal(env.NPM_CONFIG_USERCONFIG, join(root, 'fixture.npmrc'))
  assert.equal(env.XDG_CONFIG_HOME, join(root, 'config'))
  for (const name of ['DEEPSEEK_API_KEY', 'NODE_OPTIONS', 'HTTPS_PROXY']) assert.equal(env[name], '')
  assert.equal(redactDshOutput('http://127.0.0.1/?token=secret&key=pair'), 'http://127.0.0.1/?token=<redacted>&key=<redacted>')
  assert.equal(redactDshOutput('{"sessionToken":"secret","csrfToken":"csrf"}'), '{"sessionToken":"<redacted>","csrfToken":"<redacted>"}')
})

async function mobileArtifact(root, version = '0.6.13') {
  const artifact = join(root, 'artifact')
  await mkdir(join(artifact, 'lib'), { recursive: true })
  await writeFile(join(artifact, 'package.json'), JSON.stringify({ name: 'dsh-mobile', version }))
  return join(artifact, 'lib', 'index.mjs')
}

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.kill = () => true
  return child
}

test('public Mobile installation uses an owned complete profile and a copied private package store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iroh-dsh-profile-'))
  try {
    const module = await mobileArtifact(root)
    const installed = join(root, 'dsh-home', 'profiles', 'web', 'node_modules', 'dsh-mobile')
    const declaredModels = [{ id: 'owned-model', name: 'Owned model', contextWindow: 128000, inputModalities: ['text'] }]
    const pending = createDshWebProfile({ root, dshBin: resolve('dsh-bin.js'), mobileModule: module,
      extraPatches: [{ id: 'llm-deepseek', config: { models: declaredModels } }], spawnImpl: (_command, argv, options) => {
      assert.deepEqual(argv.slice(1), ['plugin', '--profile', 'web', 'add', 'dsh-mobile@0.6.13', '--ignore-scripts'])
      assert.equal(options.cwd, join(root, 'dsh-home', 'profiles', 'web'))
      assert.equal(options.env.DSH_AGENTS_HOME, join(root, 'agents'))
      assert.equal(options.env.DEEPSEEK_API_KEY, '')
      const child = fakeChild()
      setImmediate(async () => {
        await mkdir(installed, { recursive: true })
        await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'dsh-mobile', version: '0.6.13' }))
        const manifestFile = join(options.cwd, 'package.json')
        const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
        assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
        manifest.dependencies['dsh-mobile'] = '0.6.13'; manifest.dsh.profile.bundles.push('dsh-mobile')
        await writeFile(manifestFile, JSON.stringify(manifest))
        child.emit('close', 0, null)
      })
      return child
    } })
    const profile = await pending
    assert.equal(profile.mobileVersion, '0.6.13')
    assert.deepEqual(profile.installation, { code: 0, signal: null })
    const workspaceSettings = await readFile(join(profile.profile, 'pnpm-workspace.yaml'), 'utf8')
    assert(workspaceSettings.includes(`storeDir: ${JSON.stringify(join(root, 'package-store'))}`))
    assert.match(workspaceSettings, /packageImportMethod: copy/u)
    const [{ config }, modelPatch] = JSON.parse(await readFile(join(profile.profile, 'cordis.patch.yml'), 'utf8'))
    assert.deepEqual(modelPatch, { id: 'llm-deepseek', config: { models: declaredModels } })
    assert.equal(config.initiallyEnabled, false)
    assert.equal(config.listenHost, '127.0.0.1')
    assert.equal(config.listenPort, 0)
    assert.deepEqual(config.tls, { mode: 'disabled' })
    for (const key of ['setupFile', 'stateFile', 'controlFile', 'customCssFile', 'customScriptFile']) {
      assert(config[key].startsWith(join(profile.home, 'mobile-access')))
    }
    const setup = JSON.parse(await readFile(config.setupFile, 'utf8'))
    assert.deepEqual(setup, { version: 1, listenHost: '127.0.0.1', listenPort: 0, allowedCidrs: ['127.0.0.0/8'], tls: { mode: 'disabled' } })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Mobile installation rejects an unversioned artifact before launching DSH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iroh-dsh-version-'))
  try {
    const module = await mobileArtifact(root, 'latest')
    await assert.rejects(createDshWebProfile({ root, dshBin: resolve('dsh-bin.js'), mobileModule: module,
      spawnImpl: () => { throw new Error('must not spawn') } }), /exact dsh-mobile version/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Mobile installation reports nonzero child close without accepting a partial profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iroh-dsh-nonzero-'))
  try {
    const module = await mobileArtifact(root)
    await assert.rejects(createDshWebProfile({ root, dshBin: resolve('dsh-bin.js'), mobileModule: module,
      spawnImpl: () => {
        const child = fakeChild()
        setImmediate(() => { child.stderr.write('{"token":"secret"}'); child.emit('close', 17, null) })
        return child
      } }), error => {
      assert.match(error.message, /installation failed \(\{"code":17,"signal":null\}\)/u)
      assert(!error.message.includes('secret'))
      return true
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Mobile installation timeout waits for actual child close and retains bounded diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iroh-dsh-install-failed-'))
  try {
    const module = await mobileArtifact(root)
    const child = fakeChild()
    let killed
    const termination = new Promise(resolveNext => { killed = resolveNext })
    child.kill = () => { killed(); return true }
    let settled = false
    const pending = createDshWebProfile({ root, dshBin: resolve('dsh-bin.js'), mobileModule: module, installTimeoutMs: 10,
      spawnImpl: () => { setImmediate(() => child.stderr.write('http://127.0.0.1/?token=secret')); return child } })
      .then(() => { settled = true; throw new Error('unexpected installation') }, error => { settled = true; return error })
    await termination
    assert.equal(settled, false)
    child.emit('close', 1, null)
    const error = await pending
    assert.match(error.message, /installation timed out/u)
    assert(!error.message.includes('secret'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('supported CLI launch consumes fragmented readiness and awaits child close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iroh-dsh-launch-'))
  try {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough()
    const kills = []
    child.kill = signal => { kills.push(signal); if (signal === 'SIGKILL') child.emit('close', null, signal); return true }
    let argv
    const pending = startDshWeb({ root, dshBin: resolve('dsh-bin.js'), spawnImpl: (_command, args, options) => {
      argv = args; assert.equal(options.cwd, root)
      setImmediate(() => { child.stdout.write('dsh web: http://127.0.0.1:1234/?tok'); child.stdout.write('en=secret\n') })
      return child
    } })
    const owner = await pending
    assert.deepEqual(argv.slice(1), ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'])
    assert.equal(owner.origin, 'http://127.0.0.1:1234')
    assert(!owner.logs().includes('secret'))
    let settled = false
    const closing = owner.close().then(result => { settled = true; return result })
    await new Promise(resolveNext => setImmediate(resolveNext))
    assert.equal(settled, false)
    assert.deepEqual(kills, ['SIGTERM'])
    child.emit('close', 0, null)
    assert.deepEqual(await closing, { code: 0, signal: null, forced: false })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('startup failure is not returned before the failed child actually closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iroh-dsh-failed-'))
  try {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
    let reportError
    const errorRaised = new Promise(resolveNext => { reportError = resolveNext })
    let settled = false
    const pending = startDshWeb({ root, dshBin: resolve('dsh-bin.js'), spawnImpl: () => {
      setImmediate(() => { child.emit('error', new Error('sensitive-path')); reportError() })
      return child
    } }).then(() => { settled = true; throw new Error('unexpected readiness') }, error => { settled = true; return error })
    await errorRaised
    await new Promise(resolveNext => setImmediate(resolveNext))
    assert.equal(settled, false)
    child.emit('close', -1, null)
    const error = await pending
    assert.match(error.message, /Isolated DSH process failed/u)
    assert(!error.message.includes('sensitive-path'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a process that never closes marks its fixture root for preservation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iroh-dsh-no-close-'))
  try {
    await assert.rejects(startDshWeb({ root, dshBin: resolve('dsh-bin.js'), startupTimeoutMs: 5, shutdownTimeoutMs: 5,
      spawnImpl: () => fakeChild() }), error => {
      assert.equal(error.preserveFixtureRoot, true)
      assert.match(error.message, /preserve its root/u)
      return true
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})
