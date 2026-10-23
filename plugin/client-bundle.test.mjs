import test from 'node:test'
import assert from 'node:assert/strict'
import { checkClientBundle } from './check-client-bundle.mjs'

const prefix = 'window.__ModuleLoader__.load({id:"dsh-mobile-iroh",factory:require=>{'
test('client artifact gate executes registration and rejects raw ESM or missing/wrong loader ids',() => {
  assert.equal(checkClientBundle(prefix+'require("react");return {apply(){},inject:["slots"]}}});').registration,'pass')
  for (const source of ['export function apply(){}',prefix+'return {apply(){},inject:["slots"]}}});',prefix+'require("node:fs");return {apply(){},inject:["slots"]}}});',prefix.replace('dsh-mobile-iroh','other')+'require("react");return {apply(){},inject:["slots"]}}});']) assert.throws(() => checkClientBundle(source))
})
