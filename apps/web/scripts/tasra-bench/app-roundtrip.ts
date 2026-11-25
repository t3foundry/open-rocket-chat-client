// The web client's real message path, end to end, from Node:
//   sealMessage (crypto.ts)  →  JSON record, as posted to the chat server  →  decryptMessage (crypto.ts)
// with the data key unwrapped by the channel's decrypt session (channel-unwrap.ts), exactly as the
// timeline does: one presentation opens the session, later messages use its grant, and messages that
// arrive together share one keeper request.
//
//   node scripts/tasra-bench/app-roundtrip.ts [count=50] [concurrency=64]
//
// `concurrency` is how many messages are being decrypted at once. 64 is the client's own limit
// (auto-decrypt.ts): a page of history, sent as one batch per keeper. 1 measures live messages, each
// its own keeper request. Configuration: see common.ts.
import { createChannelUnwrapper } from '../../src/features/tasra/channel-unwrap.ts';
import { decryptMessage, sealMessage } from '../../src/features/tasra/crypto.ts';
import type { EncryptedRecord } from '../../src/features/tasra/detect.ts';
import { channelUnwrapDeps, chainId, deployment, ms, publicSlot, slot, summarize } from './common.ts';

const count = Number(process.argv[2] ?? 50);
const concurrency = Number(process.argv[3] ?? 64);
if (!Number.isInteger(count) || count < 1 || !Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error('usage: app-roundtrip.ts [count>=1] [concurrency>=1]');
}

// The per-phase timing callback: every phase the channel unwrapper reports, by name.
const phases = new Map<string, number[]>();
const unwrapper = createChannelUnwrapper(
  channelUnwrapDeps((phase, elapsed) => {
    const list = phases.get(phase) ?? [];
    list.push(elapsed);
    phases.set(phase, list);
  }),
);

// crypto.ts logs a timing line per step; keep the bench output to its own summary.
const log = console.log;
console.log = () => undefined;

const keyRegistry: string = deployment.addresses.KeyRegistry ?? '';
if (!keyRegistry) throw new Error('the network description names no KeyRegistry');
const target = await publicSlot();

const seal: number[] = [];
const open: number[] = [];
const total: number[] = [];
let firstMs = 0;
let failures = 0;

/** The failure and its causes, outermost first. */
const causeChain = (error: unknown): string => {
  const reasons: string[] = [];
  for (let e: unknown = error; e instanceof Error && reasons.length < 6; e = e.cause) {
    reasons.push(`${e.name}: ${e.message.slice(0, 300)}`);
  }
  return reasons.length > 0 ? reasons.join(' <- ') : String(error);
};

async function one(i: number): Promise<void> {
  const text = `message ${i}: ${'lorem ipsum '.repeat(8)}`;
  const start = performance.now();
  try {
    let step = performance.now();
    const record = await sealMessage(text, target, crypto.randomUUID(), 1, { chainId, keyRegistry });
    // The record travels as the message text.
    const wire = JSON.stringify(record);
    seal.push(ms(step));

    step = performance.now();
    const received = JSON.parse(wire) as EncryptedRecord;
    const plain = await decryptMessage(received, slot, { unwrapDataKey: unwrapper.unwrap });
    if (plain !== text) throw new Error('roundtrip mismatch');
    if (i === 0) firstMs = ms(start);
    else {
      open.push(ms(step));
      total.push(ms(start));
    }
  } catch (error) {
    failures++;
    log(`  #${i} FAILED after ${ms(start)} ms: ${causeChain(error)}`);
  }
}

const wall = performance.now();
try {
  await one(0); // opens the channel session
  const rest = performance.now();
  let next = 1;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < count) await one(next++);
    }),
  );
  const restSecs = ms(rest) / 1000;
  log(
    `\napp roundtrip: ${total.length + (firstMs ? 1 : 0)} ok, ${failures} failed, ${concurrency} in flight, ` +
      `wall ${(ms(wall) / 1000).toFixed(1)} s, ${(total.length / restSecs).toFixed(2)} msg/s after the first`,
  );
} finally {
  // Revokes the session at the verifiers.
  unwrapper.dispose();
}

console.log = log;
log(`first message (opens session)      ${firstMs.toFixed(0)} ms`);
summarize('seal + serialize', seal);
summarize('parse + decryptMessage', open);
summarize('roundtrip total', total);
for (const [phase, samples] of phases) summarize(`  phase ${phase}`, samples);
// Give the revoke a moment to reach the agent before the process ends.
await new Promise((resolve) => setTimeout(resolve, 500));
process.exit(failures ? 1 : 0);
