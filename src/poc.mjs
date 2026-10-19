import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { URL } from 'node:url';

const identityBytes = (publicKey) => publicKey.export({ type: 'spki', format: 'der' });

/** A local-only stand-in for the identity material an iroh endpoint exposes. */
export class EndpointIdentity {
  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.endpointId = createHash('sha256').update(identityBytes(publicKey)).digest('hex');
  }

  signRequest(request) {
    const body = canonicalRequest(request);
    return sign(null, Buffer.from(body), this.privateKey).toString('base64url');
  }
}

export const canonicalRequest = ({ endpointId, nonce, path }) =>
  JSON.stringify({ endpointId, nonce, path });

/**
 * Maps an authenticated endpoint identity to an explicitly allowed loopback URL.
 * This is deliberately a local gateway: it has no relay, discovery, or NAT logic.
 */
export class LocalGateway {
  #identities = new Map();
  #routes = new Map();

  register(identity, target) {
    const url = new URL(target);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      throw new Error('only HTTP loopback targets are allowed');
    }
    this.#identities.set(identity.endpointId, identity.publicKey);
    this.#routes.set(identity.endpointId, `${url.origin}`);
  }

  async forward({ endpointId, nonce, path, signature }) {
    const publicKey = this.#identities.get(endpointId);
    const origin = this.#routes.get(endpointId);
    if (!publicKey || !origin) throw new Error('unknown endpoint identity');
    if (!verify(null, Buffer.from(canonicalRequest({ endpointId, nonce, path })), publicKey, Buffer.from(signature, 'base64url'))) {
      throw new Error('invalid endpoint signature');
    }
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('://') || path.includes('\\')) throw new Error('invalid local path');
    const destination = new URL(path, origin);
    if (destination.origin !== origin) throw new Error('invalid local path');
    const response = await fetch(destination);
    return { status: response.status, body: await response.text() };
  }
}
