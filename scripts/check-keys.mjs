#!/usr/bin/env node
// Derive the EVM address from a private key to verify the gateway's
// TASRA_CREATOR_SEED matches the client's VITE_CREATOR_KEY.
//
// Usage: node scripts/check-keys.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, '..', 'apps', 'web');
const gatewayRoot = resolve(__dirname, '..', '..', 'open-rocket-chat-gateway', 'apps', 'gateway');

const requireFromWeb = createRequire(join(webRoot, 'package.json'));
const { resolveApplicationManifest, createLocalWallet } = await import(
  requireFromWeb.resolve('@t3foundry/tasra-sdk/app')
);

const manifest = JSON.parse(readFileSync(join(webRoot, 'src/features/tasra/network.json'), 'utf8'));
const { deployment } = resolveApplicationManifest(manifest, { coordinator: 'lowest-operator-id' });

function deriveAddress(envVar, path, label) {
  const key = process.env[envVar] ?? readEnv(path, envVar);
  if (!key) {
    console.log(`${label}: NOT SET`);
    return;
  }
  try {
    const wallet = createLocalWallet(deployment, { privateKey: key });
    console.log(`${label}: ${wallet.address}`);
  } catch (e) {
    console.log(`${label}: INVALID (${e.message})`);
  }
}

console.log('=== Key Address Check ===\n');

// Client's key (from env or .env)
deriveAddress('VITE_CREATOR_KEY', join(webRoot, '.env'), 'VITE_CREATOR_KEY (client)');
deriveAddress('VITE_CREATOR_KEY', join(webRoot, '.env.local'), 'VITE_CREATOR_KEY (.env.local)');

// Gateway's key
const gwEnv = join(gatewayRoot, '.env');
try {
  const exists = readFileSync(gwEnv, 'utf8');
  console.log(`\nGateway .env: ${gwEnv} (found)`);
} catch {
  console.log(`\nGateway .env: ${gwEnv} (NOT FOUND)`);
}
deriveAddress('TASRA_CREATOR_SEED', gwEnv, 'TASRA_CREATOR_SEED (gateway)');

console.log('\n=== Instructions ===');
console.log('Both keys MUST derive the same EVM address.');
console.log('If they differ, copy the correct key to TASRA_CREATOR_SEED in the gateway .env');
console.log('and restart the gateway (the env change needs a restart to take effect).');

function readEnv(filePath, key) {
  try {
    const text = readFileSync(filePath, 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && match[1] === key) return match[2].trim();
    }
  } catch {
    /* missing file is fine */
  }
  return undefined;
}