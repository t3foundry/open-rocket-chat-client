// The real web client in Chromium, against a running stack (web dev server, gateway, Rocket.Chat, Tasra network):
//   A. live, one profile: send messages one at a time; time from Enter until the client has decrypted the
//      record that came back.
//   B. history, fresh profile: open the channel; time until every message of the page is decrypted, and how
//      many keeper requests that took.
//   C. two profiles at once: both read the channel while one of them sends; time from Enter in the sender
//      until the OTHER profile shows the decrypted text. A reader holds nothing of the slot's owner, so any
//      number of profiles read side by side, each on a session of its own.
//
//   node scripts/tasra-bench/browser.mjs [count=20]
//
// Env: E2E_WEB_URL (default http://localhost:5173), E2E_ROOM (default tasra-secure),
//      E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD (the sender),
//      E2E_READER_USERNAME / E2E_READER_PASSWORD (phase C's second profile; default: the sender's account),
//      E2E_IGNORE_HTTPS_ERRORS=1 for a private-CA verifier agent, E2E_SCREENSHOT=<path> on failure.
/* global console, performance, process */
import { chromium } from '@playwright/test';

const count = Number(process.argv[2] ?? 20);
const web = process.env.E2E_WEB_URL ?? 'http://localhost:5173';
const room = process.env.E2E_ROOM ?? 'tasra-secure';
const run = `bench-${Date.now().toString(36)}`;
const sender = {
  username: process.env.E2E_ADMIN_USERNAME ?? 'admin',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'admin-password-123',
};
const reader = {
  username: process.env.E2E_READER_USERNAME ?? sender.username,
  password: process.env.E2E_READER_PASSWORD ?? sender.password,
};

const summarize = (label, samples) => {
  if (!samples.length) return;
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  console.log(
    `${label.padEnd(38)} n=${sorted.length}  min ${sorted[0].toFixed(0)}  p50 ${at(0.5).toFixed(0)}  ` +
      `mean ${mean.toFixed(0)}  p95 ${at(0.95).toFixed(0)}  max ${sorted[sorted.length - 1].toFixed(0)}  (ms)`,
  );
};

const browser = await chromium.launch();
/** Every profile opened, newest last, for the failure report. */
const profiles = [];

/**
 * A fresh profile, signed in as `account`, with the channel open. Collects page errors and the client's
 * timing lines: `decrypted` counts messages (one "TOTAL decrypt" line each), `phases` the channel
 * unwrapper's own phases (`session-open`, `session-decrypt`, `session-decrypt-batch(N)`).
 */
async function open(label, account = sender) {
  const context = await browser.newContext({ ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === '1' });
  const page = await context.newPage();
  const profile = { label, context, page, problems: [], phases: new Map(), decrypted: 0 };
  profiles.push(profile);
  page.on('console', (message) => {
    const text = message.text();
    const phase = /\[tasra:timing\]\s+└ ([a-z-]+(?:\(\d+\))?): ([0-9.]+)ms/.exec(text);
    if (phase) profile.phases.set(phase[1], [...(profile.phases.get(phase[1]) ?? []), Number(phase[2])]);
    else if (/\[tasra:timing\] TOTAL decrypt:/.test(text)) profile.decrypted++;
    else if (/\[tasra:timing\]/.test(text)) return;
    else if (message.type() === 'error' || /decrypt|tasra/i.test(text)) profile.problems.push(`${message.type()}: ${text.slice(0, 400)}`);
  });
  page.on('pageerror', (error) => profile.problems.push(`pageerror: ${error.message.slice(0, 400)}`));
  page.on('requestfailed', (request) =>
    profile.problems.push(`request failed: ${request.method()} ${request.url().slice(0, 120)} ${request.failure()?.errorText}`),
  );

  await page.goto(web);
  // The form re-renders once its server list arrives, which drops anything typed before that.
  await page.waitForLoadState('networkidle');
  const username = page.getByLabel('Username or email');
  for (let attempt = 0; attempt < 5 && (await username.inputValue()) === ''; attempt++) {
    await username.fill(account.username);
    await page.waitForTimeout(200);
  }
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const rooms = page.getByRole('navigation', { name: 'Rooms' });
  await rooms.waitFor();
  await rooms.getByRole('button', { name: room }).first().click();
  await page.getByRole('heading', { level: 1 }).waitFor();
  return profile;
}

const failuresOf = (profile) => profile.problems.filter((problem) => problem.includes('decrypt failed'));
/** Keeper requests a profile has made: one per single decrypt and one per batch. */
const requestsOf = (profile) =>
  [...profile.phases].filter(([phase]) => phase.startsWith('session-decrypt')).reduce((sum, [, samples]) => sum + samples.length, 0);

/** Wait until the profile has stopped decrypting (its existing history is done). Returns when it last progressed. */
async function settled(profile, quietMs = 3000) {
  let last = performance.now();
  for (let seen = -1; ; ) {
    const now = profile.decrypted + failuresOf(profile).length;
    if (now !== seen) {
      seen = now;
      last = performance.now();
    } else if (performance.now() - last >= quietMs) return last;
    await profile.page.waitForTimeout(100);
  }
}

const report = (profile) => {
  for (const [phase, samples] of profile.phases) summarize(`  ${profile.label} phase ${phase}`, samples);
  const failures = failuresOf(profile);
  if (failures.length) {
    console.log(`  ${profile.label} failures:\n   ${[...new Set(failures.map((p) => p.split('\n')[0]))].slice(0, 6).join('\n   ')}`);
  }
};

let failed = false;
try {
  // A. live, in ONE profile. The sender shows its own text at once but still decrypts the record that
  // comes back, so the measure is Enter -> that decrypt finishing (the client's own timing line).
  const live = await open('live');
  await settled(live);
  const composer = live.page.getByPlaceholder(`Message ${room}`);
  const first = [];
  const later = [];
  for (let i = 0; i < count; i++) {
    const before = live.decrypted;
    const errorsBefore = failuresOf(live).length;
    await composer.fill(`${run} message ${i}`);
    const start = performance.now();
    await composer.press('Enter');
    while (live.decrypted === before) {
      if (failuresOf(live).length > errorsBefore) throw new Error(`message ${i} failed to decrypt`);
      if (performance.now() - start > 60_000) throw new Error(`message ${i} was not decrypted within 60 s`);
      await live.page.waitForTimeout(5);
    }
    (i === 0 ? first : later).push(performance.now() - start);
  }
  console.log(`\nA. live, one profile: ${count} sent and decrypted`);
  summarize('first message', first);
  summarize('later messages, send to decrypted', later);
  report(live);
  await live.context.close();

  // B. history, fresh profile: the timeline loads its newest page and decrypts it as a few keeper batches.
  const history = await open('history');
  const opened = performance.now();
  const last = await settled(history, 10_000);
  const shown = await history.page.getByText(new RegExp(`^${run} message \\d+$`)).count();
  console.log(
    `\nB. history, fresh profile: ${history.decrypted} decrypted, ${failuresOf(history).length} failed, ` +
      `${shown} of this run's messages shown, ${requestsOf(history)} keeper requests, ` +
      `${((last - opened) / 1000).toFixed(1)} s after the channel opened`,
  );
  report(history);
  if (failuresOf(history).length) failed = true;
  await history.context.close();

  // C. two profiles read the same channel at the same time while one of them sends. Each has its own
  // signing key, credential and session: neither needs anything the other (or the slot's owner) holds.
  // One after the other: Rocket.Chat rate-limits simultaneous logins from one address.
  const alice = await open('sender');
  const bob = await open('reader', reader);
  await Promise.all([settled(alice), settled(bob)]);
  const sendBox = alice.page.getByPlaceholder(`Message ${room}`);
  const sendToRead = [];
  const senderOwn = [];
  for (let i = 0; i < count; i++) {
    const text = `${run} shared ${i}`;
    const senderBefore = alice.decrypted;
    const readerErrors = failuresOf(bob).length;
    await sendBox.fill(text);
    const start = performance.now();
    await sendBox.press('Enter');
    // The reader shows the text only once it has decrypted the record.
    const arrival = bob.page.getByText(text, { exact: true }).first();
    let arrived = false;
    await Promise.race([
      arrival.waitFor({ timeout: 60_000 }).finally(() => (arrived = true)),
      (async () => {
        while (!arrived && failuresOf(bob).length === readerErrors) await bob.page.waitForTimeout(50);
        if (!arrived) throw new Error(`shared message ${i} failed to decrypt in the reader profile`);
      })(),
    ]);
    if (!arrived) await arrival.waitFor({ timeout: 60_000 });
    sendToRead.push(performance.now() - start);
    // The sender's own decrypt of the record that came back, for comparison.
    const deadline = performance.now() + 60_000;
    while (alice.decrypted === senderBefore && performance.now() < deadline) await alice.page.waitForTimeout(5);
    if (alice.decrypted !== senderBefore) senderOwn.push(performance.now() - start);
  }
  console.log(`\nC. two profiles at once: ${count} sent by one, read by the other`);
  summarize('send to read in the other profile', sendToRead);
  summarize('send to decrypted in the sender', senderOwn);
  report(alice);
  report(bob);
  if (failuresOf(alice).length || failuresOf(bob).length) failed = true;
  await Promise.all([alice.context.close(), bob.context.close()]);
} catch (error) {
  failed = true;
  console.log(`FAILED: ${error.message.slice(0, 600)}`);
  const current = profiles.at(-1);
  for (const profile of profiles.slice(-2)) {
    console.log(`  ${profile.label} page output:\n   ${[...new Set(profile.problems)].slice(-25).join('\n   ')}`);
  }
  if (current && process.env.E2E_SCREENSHOT) {
    await current.page.screenshot({ path: process.env.E2E_SCREENSHOT }).catch(() => undefined);
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
