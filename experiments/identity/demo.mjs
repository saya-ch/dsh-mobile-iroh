// This HTTP/identity demonstration does not start an iroh endpoint.
import { EndpointIdentity, LocalGateway } from './poc.mjs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const target = createServer((request, response) => response.end(`local gateway reached ${request.url}`));
await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
const port = target.address().port;
const identity = new EndpointIdentity();
const gateway = new LocalGateway();
gateway.register(identity, `http://127.0.0.1:${port}`);
const request = { endpointId: identity.endpointId, nonce: randomUUID(), path: '/demo' };
const result = await gateway.forward({ ...request, signature: identity.signRequest(request) });
console.log(JSON.stringify({ endpointId: identity.endpointId, mappedTarget: `127.0.0.1:${port}`, result }, null, 2));
await new Promise((resolve) => target.close(resolve));
