#!/usr/bin/env node
/**
 * Adds older Mad Lads sales (every marketplace) a few Lads per night, within
 * a fixed Helius credit budget, until the whole collection is covered.
 *
 * Reading a Lad's own transaction list is hopeless: ~6,000 transactions each,
 * nearly all of them bids that never move the NFT. Instead this follows the
 * NFT's chain of custody backwards:
 *
 *   the token account holding the Lad now -> the transaction that put it
 *   there -> the token account it came from -> ... -> the mint.
 *
 * Bids never touch a holder's token account, so each hop costs a handful of
 * plain RPC calls (1 credit each). A typical Lad costs 30-110 credits for its
 * entire history.
 *
 * Lads are processed in number order and each one is walked to its mint, so
 * "Lad #N and below have full history" is always true (minus `skipped`).
 * State lives in madlads-backfill.json; a run that stops (budget, timeout,
 * error) resumes from the same place.
 *
 *   HELIUS_API_KEY=... BUDGET=12000 node scripts/backfill-madlads-sales.mjs
 *   CHECK=1 ...   read-only accuracy check against skulls-data.json
 */
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ROOT, readJson, writeJson, mergeSales } from './madlads-lib.mjs';
import { MARKETS, keysOf, incoming, balanceAfter, saleOf } from './madlads-chain.mjs';

const KEY = process.env.HELIUS_API_KEY;
if (!KEY) { console.error('Missing HELIUS_API_KEY'); process.exit(1); }
const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const BUDGET = Number(process.env.BUDGET || 200000);     // credits per run
const PER_LAD_CAP = Number(process.env.PER_LAD_CAP || 700);
const PER_ACCOUNT_CAP = 60;                               // transactions read one by one on a token account before switching to a search
const TIME_LIMIT_MS = Number(process.env.TIME_LIMIT_MIN || 320) * 60000;
// Several Lads are walked at once so the request rate, not the round-trip
// latency, is what limits the run. RPS stays under the Helius plan's limit
// (9 of the free plan's 10); WORKERS only has to be large enough to keep
// that rate saturated.
// Stage 1 walks each Lad back only as far as this many days and keeps a
// cursor at that point (madlads-backfill-deep.json), so stage 2 can carry on
// to the mint later without paying for the newer hops again. 0 = to the mint.
const CUTOFF_DAYS = Number(process.env.CUTOFF_DAYS ?? 365);
// Stage 2: once stage 1 has covered every Lad, carry each cursor in
// madlads-backfill-deep.json on to the mint (~60 credits a Lad). Off unless
// STAGE2=1, so the owner decides when to spend those credits.
const STAGE2 = process.env.STAGE2 === '1';
const WORKERS = Number(process.env.WORKERS || 3);
const RPS = Number(process.env.RPS || 9);
const CHECK = process.env.CHECK === '1';
const FEE = 0.02 + 0.042; // marketplace fee + Mad Lads royalty


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Credits spent by the walk a request belongs to: with several workers the
// global counter is everyone's, so the per-Lad cap needs its own tally.
const walkCredits = new AsyncLocalStorage();
let credits = 0;
const startedAt = Date.now();

// One shared slot queue for every worker: each request takes the next free
// 1/RPS slot, so the whole process never exceeds the plan's request rate.
let nextSlot = 0;
async function gate() {
  const now = Date.now();
  nextSlot = Math.max(now, nextSlot) + 1000 / RPS;
  const wait = nextSlot - 1000 / RPS - now;
  if (wait > 0) await sleep(wait);
}

async function rpc(method, params) {
  for (let i = 0; i < 9; i++) {
    let res;
    await gate();
    try {
      res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'bf', method, params }) });
    } catch { await sleep(Math.min(30000, 1000 * 2 ** i)); continue; }
    if (res.ok) {
      const j = await res.json();
      credits++;
      const own = walkCredits.getStore();
      if (own) own.n++;
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return j.result;
    }
    if (res.status !== 429 && res.status < 500) throw new Error(`${method} HTTP ${res.status}`);
    await sleep(Math.min(30000, 1000 * 2 ** i));
  }
  throw new Error(`${method} retries exhausted`);
}
const getTx = (sig) => rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 1, encoding: 'jsonParsed' }]);


// A token account with hundreds of transactions (a wallet that relists all
// the time) is too expensive to read one by one. Its balance over time is a
// step: empty, then holding the Lad. Jump back in growing steps until a
// transaction that left it empty, then bisect to the one that filled it.
// A list-and-delist round trip inside the gap is skipped, which loses no
// sale; a sale and re-buy into the very same account would be missed.
async function findIncomingFast(mint, acct, startBefore) {
  const sigs = [];
  let page = startBefore;
  for (let i = 0; i < 60; i++) {
    const r = await rpc('getSignaturesForAddress', [acct, { limit: 1000, ...(page ? { before: page } : {}) }]);
    sigs.push(...r.filter((x) => !x.err).map((x) => x.signature));
    if (r.length < 1000) break;
    page = r[r.length - 1].signature;
  }
  if (!sigs.length) return null;
  const cache = new Map();
  const txAt = async (i) => { if (!cache.has(i)) cache.set(i, await getTx(sigs[i])); return cache.get(i); };
  const emptyAt = async (i) => balanceAfter(await txAt(i), mint, acct) === 0;
  let lo = 0, hi = null; // lo: holding after sigs[lo] (or unknown); hi: empty after sigs[hi]
  for (let step = 1; step < sigs.length; step *= 2) {
    if (await emptyAt(step)) { hi = step; break; }
    lo = step;
  }
  if (hi == null) {
    if (await emptyAt(sigs.length - 1)) hi = sigs.length - 1; else lo = sigs.length - 1;
  }
  while (hi != null && hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (await emptyAt(mid)) hi = mid; else lo = mid;
  }
  // The filling transaction is sigs[lo], give or take one the balance check could not read.
  for (const i of [lo, lo - 1, lo + 1, lo - 2, lo + 2]) {
    if (i < 0 || i >= sigs.length) continue;
    const tx = await txAt(i);
    const inc = tx && incoming(tx, mint, acct);
    if (inc) return { ...inc, sig: sigs[i], tx };
  }
  return null;
}

// Walks one Lad back to its mint. cursor = { acct, before } to resume.
// Returns `spent`: the credits this walk alone used.
async function walk(mint, cursor, cap, cutoff = 0) {
  const own = { n: 0 };
  const r = await walkCredits.run(own, () => walkInner(mint, cursor, cap, cutoff));
  return { ...r, spent: own.n };
}
async function walkInner(mint, cursor, cap, cutoff) {
  const own = walkCredits.getStore();
  let acct = cursor?.acct, before = cursor?.before;
  if (!acct) {
    const largest = await rpc('getTokenLargestAccounts', [mint]);
    acct = largest.value.find((a) => Number(a.amount) > 0)?.address;
    if (!acct) return { sales: [], status: 'skip', why: 'no holder account' };
  }
  const sales = [];
  for (let hop = 0; hop < 400; hop++) {
    let found = null, scanned = 0, page = before, ended = false;
    scan: for (;;) {
      const sigs = await rpc('getSignaturesForAddress', [acct, { limit: 100, ...(page ? { before: page } : {}) }]);
      for (const s of sigs) {
        if (s.err) continue;
        const tx = await getTx(s.signature);
        scanned++;
        const inc = tx && incoming(tx, mint, acct);
        if (inc) { found = { ...inc, sig: s.signature, tx }; break scan; }
        if (scanned >= PER_ACCOUNT_CAP) break scan;
        if (own.n >= cap) return { sales, status: 'partial', cursor: { acct, before } };
      }
      if (sigs.length < 100) { ended = true; break; }
      page = sigs[sigs.length - 1].signature;
    }
    if (!found && !ended) found = await findIncomingFast(mint, acct, before);
    if (!found) return { sales, status: 'skip', why: ended ? 'trail ends before the mint' : `busy account ${acct}` };
    if (found.srcAcct) {
      const sale = saleOf(found.tx, mint, found);
      if (sale) sales.push(sale);
    } else {
      return { sales, status: 'done' }; // reached the mint
    }
    acct = found.srcAcct; before = found.sig;
    // Everything older than the cut-off waits for stage 2.
    if (cutoff && found.tx.blockTime < cutoff) return { sales, status: 'cutoff', cursor: { acct, before } };
    if (own.n >= cap) return { sales, status: 'partial', cursor: { acct, before } };
  }
  return { sales, status: 'skip', why: 'too many hops' };
}

// ---------- accuracy check against the Skulls page data ----------
if (CHECK) {
  const known = readJson('skulls-data.json').skulls.filter((s) => s.sales?.length).sort((a, b) => b.sales.length - a.sales.length).slice(0, Number(process.env.CHECK_N || 25));
  let match = 0, missed = 0, extra = 0, off = 0, mkt = 0;
  const ratios = [];
  for (const sk of known) {
    const r = await walk(sk.mint, null, 1500);
    const found = r.sales.map((s) => ({ ...s, ts: s.t * 1000 }));
    for (const k of sk.sales) {
      const f = found.find((x) => Math.abs(x.ts - k.timestamp) < 120000);
      if (!f) { missed++; console.log(`  missed #${sk.num} ${new Date(k.timestamp).toISOString().slice(0, 10)} ${k.priceSol} ${k.source}`); continue; }
      match++;
      const ratio = f.p / k.priceSol; ratios.push(ratio);
      if (Math.abs(ratio - 1) > 0.03) { off++; console.log(`  price #${sk.num} ${new Date(k.timestamp).toISOString().slice(0, 10)}: ${f.p.toFixed(2)} vs known ${k.priceSol} (${k.source}) [${f.dbg}] ${f.sig.slice(0, 12)}`); }
      const knownMkt = k.source.startsWith('MAGICEDEN') ? 0 : 1;
      if (f.m !== knownMkt) mkt++;
    }
    for (const f of found) if (!sk.sales.some((k) => Math.abs(f.ts - k.timestamp) < 120000)) { extra++; console.log(`  extra #${sk.num} ${new Date(f.ts).toISOString().slice(0, 10)} ${f.p.toFixed(2)} SOL market ${f.m} [${f.dbg}] ${f.sig.slice(0, 16)}`); }
    console.log(`#${sk.num}: ${r.status}${r.why ? ' (' + r.why + ')' : ''}, found ${found.length}, known ${sk.sales.length}`);
  }
  ratios.sort((a, b) => a - b);
  console.log(`CHECK: matched ${match}, missed ${missed}, extra ${extra}, price off >3%: ${off}, marketplace differs: ${mkt}, median price ratio ${ratios[ratios.length >> 1]?.toFixed(3)}, credits ${credits}`);
  process.exit(0);
}

// ---------- nightly run ----------
const stat = readJson('madlads-static.json');
if (!stat) { console.error('madlads-static.json missing: run generate-madlads-data.mjs first'); process.exit(1); }
const lads = stat.lads.map((r) => ({ num: r[0], mint: r[1] }));
const numByMint = new Map(lads.map((l) => [l.mint, l.num]));
const state = readJson('madlads-backfill.json') || { next: 0, total: lads.length, skipped: {}, partial: null, sales: 0, credits: 0 };
state.total = lads.length;
// Lads skipped by an earlier version for a busy account get one more try.
if (state.v !== 2) {
  state.retry = Object.keys(state.skipped).filter((n) => /^busy account/.test(state.skipped[n])).map(Number);
  state.v = 2;
}
state.retry = state.retry || [];
// Lads skipped on a request error (e.g. a newer transaction version) get another try.
for (const n of Object.keys(state.skipped)) if (/^error:/.test(state.skipped[n]) && !state.retry.includes(Number(n))) state.retry.push(Number(n));
const ladByNum = new Map(lads.map((l) => [l.num, l]));

let pending = [];
let processed = 0;
const flush = () => {
  if (pending.length) { const r = mergeSales(pending, numByMint); state.sales += r.added; pending = []; }
  state.updatedAt = new Date().toISOString();
  state.deep = Object.keys(deep).length;
  writeJson('madlads-backfill.json', state);
  if (deepDirty) {
    const lines = Object.keys(deep).map(Number).sort((a, b) => a - b).map((n) => `${JSON.stringify(String(n))}:${JSON.stringify(deep[n])}`);
    fs.writeFileSync(new URL('madlads-backfill-deep.json', ROOT), `{\n${lines.join(',\n')}\n}\n`);
    deepDirty = false;
  }
  const data = readJson('madlads-data.json');
  if (data) { data.salesYears = fs.readdirSync(ROOT).map((f) => /^madlads-sales-(\d{4})\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort(); writeJson('madlads-data.json', data); }
};

// A partial Lad from an older single-threaded run.
state.partials = state.partials || {};
// The cut-off is fixed when stage 1 starts so it does not drift each day.
// Lads before `fullNext` were walked to the mint before stage 1 began.
if (CUTOFF_DAYS > 0 && !state.cutoff && !state.stage2Done) { state.cutoff = Math.floor(Date.now() / 1000) - CUTOFF_DAYS * 86400; state.fullNext = state.next; }
if (CUTOFF_DAYS === 0) { delete state.cutoff; }
const cutoff = state.cutoff || 0;
const deep = readJson('madlads-backfill-deep.json') || {};
let deepDirty = false;
if (state.partial) { state.partials[state.partial.num] = { acct: state.partial.acct, before: state.partial.before, spent: state.partial.spent || 0 }; }
delete state.partial;

// Work is handed out in number order, but finishes out of order with several
// workers, so `next` only moves across the finished run of indexes at the
// front. "Lad #N and below have full history" therefore stays true, and a run
// that stops mid-flight resumes every unfinished Lad, not just the lowest.
const retryQueue = [...state.retry];
// Stage 2 queue: Lads stopped at the cut-off, lowest number first. Taken only
// after stage 1 has nothing left, so the two never compete for the budget.
const deepQueue = STAGE2 ? Object.keys(deep).map(Number).sort((a, b) => a - b) : [];
let scanIdx = state.next;
const doneIdx = new Set();
const outOfBudget = () => credits >= BUDGET || Date.now() - startedAt >= TIME_LIMIT_MS;

function nextJob() {
  if (outOfBudget()) return null;
  while (retryQueue.length) {
    const num = retryQueue.shift();
    const lad = ladByNum.get(num);
    if (lad) return { lad, idx: null };
  }
  while (scanIdx < lads.length) {
    const idx = scanIdx++;
    if (lads[idx]) return { lad: lads[idx], idx };
  }
  while (deepQueue.length) {
    const num = deepQueue.shift();
    const lad = ladByNum.get(num);
    if (lad && deep[num]) return { lad, idx: null, deep: true };
  }
  return null;
}

const advance = () => { while (doneIdx.has(state.next)) { doneIdx.delete(state.next); state.next++; } };

async function finishedLad(lad, idx, r, spent, isDeep) {
  if (isDeep) {
    // Stage 2: the Lad keeps its deep entry until the walk ends, so a partial
    // walk is picked up again next run (resuming from `partials`).
    if (r.status === 'partial' && spent < PER_LAD_CAP * 3) { state.partials[lad.num] = { ...r.cursor, spent }; return; }
    delete deep[lad.num]; deepDirty = true;
    delete state.partials[lad.num];
    if (r.status === 'done') delete state.skipped[lad.num];
    else state.skipped[lad.num] = r.why || 'history too long';
    processed++;
    if (processed % 20 === 0) { flush(); console.log(`  stage 2 #${lad.num} · ${processed} Lads · ${credits} credits · ${Object.keys(deep).length} left`); }
    return;
  }
  if (r.status === 'partial' && spent < PER_LAD_CAP * 3) {
    // Out of budget mid-walk: keep the cursor and leave the Lad unfinished so
    // the next run picks it up again. `next` must not move past it.
    state.partials[lad.num] = { ...r.cursor, spent };
    if (idx === null && !state.retry.includes(lad.num)) state.retry.push(lad.num);
    return;
  }
  if (r.status === 'cutoff') { deep[lad.num] = [r.cursor.acct, r.cursor.before]; deepDirty = true; }
  else if (deep[lad.num]) { delete deep[lad.num]; deepDirty = true; }
  if (r.status === 'done' || r.status === 'cutoff') delete state.skipped[lad.num];
  else state.skipped[lad.num] = r.why || 'history too long';
  delete state.partials[lad.num];
  if (idx === null) state.retry = state.retry.filter((n) => n !== lad.num);
  else { doneIdx.add(idx); advance(); }
  processed++;
  if (processed % 20 === 0) { flush(); console.log(`  #${lad.num} · ${processed} Lads · ${credits} credits · next ${state.next}/${lads.length}`); }
}

async function worker() {
  for (;;) {
    const job = nextJob();
    if (!job) return;
    const { lad, idx } = job;
    const resume = state.partials[lad.num] || (job.deep ? { acct: deep[lad.num][0], before: deep[lad.num][1] } : null);
    const spentBefore = resume?.spent || 0;
    let r;
    try {
      r = await walk(lad.mint, resume, Math.max(50, PER_LAD_CAP - spentBefore), job.deep ? 0 : cutoff);
    } catch (e) {
      console.error(`  #${lad.num} failed, skipped: ${e.message}`);
      r = { sales: [], status: 'skip', why: `error: ${e.message}`, spent: 0 };
    }
    pending.push(...r.sales);
    await finishedLad(lad, idx, r, spentBefore + (r.spent || 0), job.deep);
  }
}

await Promise.all(Array.from({ length: Math.max(1, WORKERS) }, worker));

state.credits += credits;
// Stage 2 finished: every Lad now has its history to the mint, so the page
// stops describing a cut-off.
if (STAGE2 && state.next >= lads.length && !Object.keys(deep).length && state.cutoff) {
  delete state.cutoff; state.fullNext = lads.length; state.stage2Done = true; deepDirty = true;
  console.log('stage 2 complete: full history for the whole collection');
}
flush();
const remaining = lads.length - state.next;
console.log(`backfill${STAGE2 ? ' (stage 2 on)' : ''}: ${Object.keys(deep).length} Lads waiting for stage 2; ${processed} Lads this run (${state.next}/${lads.length} total, ${remaining} to go), ${state.sales} sales added so far, ${Object.keys(state.skipped).length} skipped, ${credits} credits this run, ${state.credits} in total`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `remaining=${remaining}\n`);
