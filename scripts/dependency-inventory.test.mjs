import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectInventory } from './dependency-inventory.mjs'

const package_ = (id, name, source, license = 'MIT') => ({ id, name, version: '1.0.0', source, license, license_file: null, repository: null, manifest_path: 'C:/private-test/Cargo.toml' })

test('source license inventory follows all edges, handles cycles and omits local paths', () => {
  const report = collectInventory({
    packages: [package_('app', 'app', null), package_('dep', 'dep', 'registry+public', null), package_('build', 'build', 'registry+public'), package_('unused', 'unused', null)],
    resolve: { nodes: [{ id: 'app', dependencies: ['dep', 'build'] }, { id: 'dep', dependencies: ['app'] }, { id: 'build', dependencies: [] }] },
  }, ['app'])
  assert.deepEqual(report.map(item => item.name), ['app', 'build', 'dep'])
  assert.equal(report.at(-1).licenseExpression, null)
  assert.equal(JSON.stringify(report).includes('private-test'), false)
})

test('source license inventory refuses missing roots or incomplete resolved nodes', () => {
  assert.throws(() => collectInventory({ packages: [], resolve: { nodes: [] } }, ['missing']), /root_not_unique/)
  assert.throws(() => collectInventory({ packages: [package_('app', 'app', null)], resolve: { nodes: [] } }, ['app']), /incomplete_dependency_graph/)
})
