import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EndpointIdentity, LocalGateway } from './poc.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test('identity-authenticated local mapping forwards only to its registered loopback service', async () => {
  const target = createServer((request, response) => { response.end(request.url === '/health' ? 'ok' : 'unexpected'); });
  const port = await listen(target);
  const identity = new EndpointIdentity();
  const gateway = new LocalGateway();
  gateway.register(identity, `http://127.0.0.1:${port}`);
  const nonce = 'test-nonce';
  const path = '/health';
  const result = await gateway.forward({ endpointId: identity.endpointId, nonce, path, signature: identity.signRequest({ endpointId: identity.endpointId, nonce, path }) });
  assert.deepEqual(result, { status: 200, body: 'ok' });
  await assert.rejects(() => gateway.forward({ endpointId: identity.endpointId, nonce, path, signature: identity.signRequest({ endpointId: identity.endpointId, nonce: 'wrong', path }) }), /invalid endpoint signature/);
  const traversalPath = '//example.com/escape';
  await assert.rejects(() => gateway.forward({ endpointId: identity.endpointId, nonce, path: traversalPath, signature: identity.signRequest({ endpointId: identity.endpointId, nonce, path: traversalPath }) }), /invalid local path/);
  await close(target);
});

test('gateway rejects non-loopback registration', () => {
  const gateway = new LocalGateway();
  assert.throws(() => gateway.register(new EndpointIdentity(), 'http://example.com'), /loopback/);
});
