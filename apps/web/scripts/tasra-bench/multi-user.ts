// Several readers in one channel, each its own process with its own credential and session,
// running the web client's real message path (crypto.ts + channel-unwrap.ts), as separate browsers
// would. Driven by multi-user.sh.
//
//   node scripts/tasra-bench/multi-user.ts seal <count> <out.jsonl>
//       One sender: seal <count> messages for the channel and write them one per line.
//
//   node scripts/tasra-bench/multi-user.ts user <in.jsonl> <history> <startAtMs> <intervalMs> <label>
//       One reader: on joining, decrypt the first <history> messages together (a page of history),
//       then decrypt each later message when it "arrives": message i at startAt + i * interval, the
//       same instant for every reader. Prints one JSON line with its timings.
//
// Configuration: see common.ts (each reader has its own SD_JWT_FILE, HOLDER_KEY_FILE and STORE_DIR).
import fs from 'node:fs';
import { createChannelUnwrapper } from '../../src/features/tasra/channel-unwrap.ts';
import { decryptMessage, sealMessage } from '../../src/features/tasra/crypto.ts';
import type { EncryptedRecord } from '../../src/features/tasra/detect.ts';
import { channelUnwrapDeps, chainId, deployment, ms, publicSlot, slot } from './common.ts';

const [mode, ...args] = process.argv.slice(2);
const log = console.log;
// crypto.ts logs a timing line per step; keep the output to the summaries.
console.log = () => undefined;

const text = (i: number): string => `message ${i}: ${'lorem ipsum '.repeat(8)}`;
const sleepUntil = (at: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, at - Date.now())));

async function seal(count: number, out: string): Promise<void> {
  const keyRegistry: string = deployment.addresses.KeyRegistry ?? '';
  if (!keyRegistry) throw new Error('the network description names no KeyRegistry');
  const target = await publicSlot();
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify(await sealMessage(text(i), target, crypto.randomUUID(), 1, { chainId, keyRegistry })));
  }
  fs.writeFileSync(out, `${lines.join('\n')}\n`);
  log(`sealed ${count} messages`);
}

async function user(file: string, history: number, startAt: number, interval: number, label: string): Promise<void> {
  const records = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EncryptedRecord);
  const unwrapper = createChannelUnwrapper(channelUnwrapDeps());
  const live: number[] = [];
  const failures: string[] = [];
  let joinMs = 0;
  let historyMs = 0;

  const read = async (i: number): Promise<void> => {
    const plain = await decryptMessage(records[i]!, slot, { unwrapDataKey: unwrapper.unwrap });
    if (plain !== text(i)) throw new Error('wrong plaintext');
  };

  try {
    // Joining: the first message opens the session (credential presentation), the rest of the
    // history page is decrypted together.
    let from = performance.now();
    try {
      await read(0);
    } catch (error) {
      failures.push(`join: ${String(error).slice(0, 200)}`);
    }
    joinMs = ms(from);
    from = performance.now();
    const page = await Promise.allSettled(Array.from({ length: Math.max(0, history - 1) }, (_, k) => read(k + 1)));
    for (const [k, r] of page.entries()) if (r.status === 'rejected') failures.push(`history ${k + 1}: ${String(r.reason).slice(0, 200)}`);
    historyMs = ms(from);

    // Live: every reader gets message i at the same instant.
    const pending: Promise<void>[] = [];
    for (let i = history; i < records.length; i++) {
      await sleepUntil(startAt + (i - history) * interval);
      const arrived = performance.now();
      pending.push(
        read(i).then(
          () => void live.push(ms(arrived)),
          (error: unknown) => void failures.push(`live ${i}: ${String(error).slice(0, 200)}`),
        ),
      );
    }
    await Promise.all(pending);
  } finally {
    unwrapper.dispose();
  }
  log(JSON.stringify({ label, joinMs, history, historyMs, live, failures }));
  await new Promise((resolve) => setTimeout(resolve, 500));
}

if (mode === 'seal') await seal(Number(args[0]), args[1]!);
else if (mode === 'user') await user(args[0]!, Number(args[1]), Number(args[2]), Number(args[3]), args[4] ?? 'user');
else throw new Error('usage: multi-user.ts seal <count> <out> | user <in> <history> <startAtMs> <intervalMs> <label>');
process.exit(0);
