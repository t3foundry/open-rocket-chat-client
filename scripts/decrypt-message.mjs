#!/usr/bin/env node
// Decrypt a `tasra-encrypt/v2` record end-to-end: get a credential from the
// gateway, authorize via the verifier agent, unwrap the BLS KEM and AES-GCM
// decrypt the plaintext.
//
// Usage:
//   node scripts/decrypt-message.mjs [path]
//   node scripts/decrypt-message.mjs scripts/encrypted-message.json
//
// The gateway must be running on `GATEWAY_URL` (default http://localhost:4000).
// Admin credentials come from `E2E_ADMIN_USERNAME` / `E2E_ADMIN_PASSWORD`
// (default admin / admin-password-123).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, '..', 'apps', 'web');

// --- Resolve the Tasra SDK from apps/web (its dependency, not the root's) ---
const requireFromWeb = createRequire(join(webRoot, 'package.json'));
const { resolveApplicationManifest, createLocalWallet, createIdentity, credentialAuthorization, createTasra } =
  await import(requireFromWeb.resolve('@t3foundry/tasra-sdk/app'));

// --- Configuration ---
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:4000';
const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'admin-password-123';
const RECORD_PATH = process.argv[2] ?? join(__dirname, 'encrypted-message.json');

// --- Read the encrypted record ---
let record;
try {
  record = JSON.parse(readFileSync(RECORD_PATH, 'utf8'));
} catch {
  console.error('cannot read record:', RECORD_PATH);
  process.exit(1);
}
console.log('slot:', record.manifest.slotId);
console.log('record:', record.manifest.recordId);
console.log('schema:', record.manifest.schema);
console.log();

// --- Resolve deployment ---
const manifest = JSON.parse(readFileSync(join(webRoot, 'src/features/tasra/network.json'), 'utf8'));
const { deployment, verifierAgentUrl } = resolveApplicationManifest(manifest, {
  coordinator: 'lowest-operator-id',
});
console.log('chainId:', deployment.chainId);
console.log('keyRegistry:', deployment.addresses.KeyRegistry);
console.log('verifierAgent:', verifierAgentUrl);

if (!verifierAgentUrl) {
  console.error('network manifest advertises no verifier-agent service');
  process.exit(1);
}

// --- Creator key ---
// A fresh key is generated each run — the verifier no longer checks the creator
// identity for these operations, so any valid signer is accepted.
const signer = createLocalWallet(deployment).signer;
console.log('signer:', signer.address);
console.log();

// --- Sign in to the gateway ---
console.log('signing in to gateway...');
const signInRes = await fetch(`${GATEWAY_URL}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
});
if (!signInRes.ok) {
  console.error('sign-in failed:', signInRes.status, await signInRes.text());
  process.exit(1);
}
const sessionCookie = signInRes.headers.getSetCookie?.()?.[0]?.split(';')[0];
if (!sessionCookie) {
  console.error('no session cookie in response');
  process.exit(1);
}
const session = (await signInRes.json());
console.log('signed in as:', session.current?.userId, 'on', session.current?.serverId);
console.log();

// --- Create identity ---
const identity = createIdentity();
console.log('holder DID:', identity.did);
console.log();

// --- Get credential from gateway ---
console.log('requesting credential...');
const credRes = await fetch(`${GATEWAY_URL}/api/v1/tasra/credentials/document-reader`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    cookie: sessionCookie,
  },
  body: JSON.stringify({ slotId: record.manifest.slotId, did: identity.did }),
});
if (!credRes.ok) {
  console.error('credential request failed:', credRes.status, await credRes.text());
  process.exit(1);
}
const credBody = await credRes.json();
console.log('credential issuer:', credBody.issuer);
console.log('credential vct:', credBody.vct);
console.log('credential expires:', credBody.expiresAt);
console.log();

// --- Build authorizer ---
const authorize = credentialAuthorization({
  verifierAgentUrl,
  signer,
  identity,
  credentials: [credBody.credential],
  description: 'E2E test: decrypt encrypted message',
});

// --- Open BLS slot ---
const app = createTasra({ deployment });
console.log('opening BLS slot...');
const slot = await app.slots.bls(record.manifest.slotId);
console.log('slot ready');
console.log();

// --- Parse envelope ---
// `slot.decrypt` expects `Ciphertext` which has `aad` and `kemCt`.
// The envelope's `encryptedAesKey` is the serialised KEM blob. We parse it with
// the SDK's `fromBytes` and a local base64 decoder.
const { fromBytes } = await import(requireFromWeb.resolve('@t3foundry/tasra-sdk'));

/** Standard base64 decode. */
const unb64 = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

const envelope = fromBytes(unb64(record.envelope.encryptedAesKey));
console.log('envelope epoch:', envelope.epoch);
console.log('envelope identity:', new TextDecoder().decode(envelope.identity));

// Check envelope identity matches the manifest documentSha256.
const identityText = new TextDecoder().decode(envelope.identity);
if (identityText !== record.manifest.documentSha256) {
  console.error(
    'envelope identity mismatch:',
    identityText,
    '!==',
    record.manifest.documentSha256,
  );
  process.exit(1);
}
console.log('envelope identity matches manifest ✓');
console.log();

// --- BLS decrypt ---
console.log('decrypting via BLS committee...');
const { plaintext: dataKey } = await slot.decrypt(envelope.identity, envelope.ciphertext, {
  authorize,
  requireReceipts: true,
});
console.log('BLS decrypt succeeded ✓');
console.log();

// --- AES-GCM decrypt ---
const aesCiphertext = unb64(record.envelope.aesCiphertext);
const iv = aesCiphertext.subarray(0, 12);
const ciphertext = aesCiphertext.subarray(12);

const SCHEMA = 'tasra-encrypt/v2';
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const toHex = (bytes) => {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
};

const aad = await sha256(new TextEncoder().encode(`${SCHEMA}:${record.manifest.recordId}`));
const aesKey = await crypto.subtle.importKey('raw', dataKey, { name: 'AES-GCM' }, false, ['decrypt']);
const plainBytes = new Uint8Array(
  await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, ciphertext),
);

// --- Verify document hash ---
const computedHash = toHex(await sha256(plainBytes));
if (computedHash !== record.manifest.documentSha256) {
  console.error('document hash mismatch:', computedHash, '!==', record.manifest.documentSha256);
  dataKey.fill(0);
  process.exit(1);
}
console.log('document hash matches ✓');

// --- Output ---
const text = new TextDecoder().decode(plainBytes);
dataKey.fill(0);

console.log();
console.log('=== DECRYPTED MESSAGE ===');
console.log(text);
console.log('=== END ===');