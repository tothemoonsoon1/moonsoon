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
import { ROOT, readJson, writeJson, mergeSales } from './madlads-lib.mjs';

const KEY = process.env.HELIUS_API_KEY;
if (!KEY) { console.error('Missing HELIUS_API_KEY'); process.exit(1); }
const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const BUDGET = Number(process.env.BUDGET || 12000);      // credits per run
const PER_LAD_CAP = Number(process.env.PER_LAD_CAP || 700);
const PER_ACCOUNT_CAP = 250;                              // transactions read on one token account before giving up
const TIME_LIMIT_MS = Number(process.env.TIME_LIMIT_MIN || 300) * 60000;
const CHECK = process.env.CHECK === '1';
const FEE = 0.02 + 0.042; // marketplace fee + Mad Lads royalty

const MARKETS = {
  M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K: 0,
  M3mxk5W2tt27WGT7THox7PmgRDp4m6NEhL5xvxrBfS1: 0,
  mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc: 0,
  TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN: 1,
  TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp: 1,
  TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg: 1,
  TB1Dqt8JeKQh7RLDzfYDJsq8KS4fS2yt87avRjyRxMv: 1,
  hadeK9DLv9eA7ya5KCTqSvSvRZeJC3JgD5a9Y3CNbvu: 2,
  CJsLwbP1iu5DuUikHEJnLfANgKy6stB2uFgvBBHoyxwz: 2, // Solanart
  '1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix': 0,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let credits = 0;
const startedAt = Date.now();

async function rpc(method, params) {
  for (let i = 0; i < 9; i++) {
    let res;
    try {
      res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'bf', method, params }) });
    } catch { await sleep(Math.min(30000, 1000 * 2 ** i)); continue; }
    if (res.ok) {
      const j = await res.json();
      credits++;
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return j.result;
    }
    if (res.status !== 429 && res.status < 500) throw new Error(`${method} HTTP ${res.status}`);
    await sleep(Math.min(30000, 1000 * 2 ** i));
  }
  throw new Error(`${method} retries exhausted`);
}
const getTx = (sig) => rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]);

const keysOf = (tx) => tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));

// Did this transaction put the NFT into `acct`? If so, where did it come from.
function incoming(tx, mint, acct) {
  const m = tx?.meta;
  if (!m || m.err) return null;
  const keys = keysOf(tx);
  const bal = (list, addr) => { const b = (list || []).find((x) => x.mint === mint && keys[x.accountIndex] === addr); return b ? Number(b.uiTokenAmount.amount) : 0; };
  if (!(bal(m.preTokenBalances, acct) === 0 && bal(m.postTokenBalances, acct) > 0)) return null;
  const src = (m.preTokenBalances || []).find((x) => x.mint === mint && Number(x.uiTokenAmount.amount) > 0 && keys[x.accountIndex] !== acct);
  const dst = (m.postTokenBalances || []).find((x) => x.mint === mint && keys[x.accountIndex] === acct);
  return { srcAcct: src ? keys[src.accountIndex] : null, from: src?.owner || null, to: dst?.owner || null };
}

// Is this move a sale, and for how much?
// Prices follow the Skulls page: the listing or offer price, before fees.
//  - Buyer took a listing (buyer signs): the seller receives the ask.
//  - Seller accepted an offer (seller signs): the seller receives the offer
//    minus the 6.2% fee + royalty.
// The seller is read from who received the SOL, which also works when the
// NFT was listed from an escrow account or several NFTs sold in one go.
function saleOf(tx, mint, move) {
  const m = tx.meta;
  const keys = keysOf(tx);
  let market = null;
  for (const k of keys) if (MARKETS[k] != null) { market = market == null ? MARKETS[k] : Math.min(market, MARKETS[k]); }
  const delta = (i) => (m.postBalances[i] - m.preBalances[i]) / 1e9;
  const signer = keys[0];
  const fee = m.fee / 1e9;
  const gainOf = (addr) => { const i = keys.indexOf(addr); if (i < 0) return 0; return delta(i) + (i === 0 ? fee : 0); };

  // The seller is whoever received the most SOL. The account the NFT left is
  // only trusted when it received a comparable amount: for escrowed listings
  // it is a marketplace account that merely collects a ~1% fee.
  let seller = null, gain = 0;
  for (let i = 0; i < keys.length; i++) {
    const d = delta(i) + (i === 0 ? fee : 0);
    if (d > gain && keys[i] !== move.to) { gain = d; seller = keys[i]; }
  }
  const fromGain = gainOf(move.from);
  if (fromGain > 0.3 && fromGain >= gain * 0.5) { seller = move.from; gain = fromGain; }
  if (!(gain > 0.3)) return null;
  // The largest payment out of any one account (buyer, bid escrow or pool).
  let paid = 0;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === seller) continue;
    const d = -(delta(i) + (i === 0 ? fee : 0));
    if (d > paid) paid = d;
  }
  if (market == null) {
    // No marketplace involved (an OTC deal): only count it when the new owner clearly paid.
    if (!(-gainOf(move.to) > 0.3)) return null;
    market = 2;
  }
  // Several NFTs for one payment (a sweep or a bundle deal): split it evenly.
  const moved = new Set();
  for (const b of m.postTokenBalances || []) {
    if (b.uiTokenAmount.decimals !== 0 || b.uiTokenAmount.amount !== '1' || b.owner !== move.to) continue;
    const pre = (m.preTokenBalances || []).find((x) => x.accountIndex === b.accountIndex);
    if (!pre || pre.uiTokenAmount.amount === '0') moved.add(b.mint);
  }
  const bundle = market === 2 && moved.size > 1 ? moved.size : 1;
  // Seller accepted an offer: the offer is what left the bidder's account.
  const acceptedOffer = signer === seller;
  const price = (acceptedOffer && paid > gain ? paid : gain) / bundle;
  return { t: tx.blockTime, mint, p: price, m: market, sig: tx.transaction.signatures[0], b: move.to, s: seller, dbg: `gain ${gain.toFixed(2)} paid ${paid.toFixed(2)} ${acceptedOffer ? 'offer' : 'listing'} x${bundle}` };
}

// Walks one Lad back to its mint. cursor = { acct, before } to resume.
async function walk(mint, cursor, cap) {
  const start = credits;
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
        if (credits - start >= cap) return { sales, status: 'partial', cursor: { acct, before } };
      }
      if (sigs.length < 100) { ended = true; break; }
      page = sigs[sigs.length - 1].signature;
    }
    if (!found) return { sales, status: 'skip', why: ended ? 'trail ends before the mint' : `busy account ${acct}` };
    if (found.srcAcct) {
      const sale = saleOf(found.tx, mint, found);
      if (sale) sales.push(sale);
    } else {
      return { sales, status: 'done' }; // reached the mint
    }
    acct = found.srcAcct; before = found.sig;
    if (credits - start >= cap) return { sales, status: 'partial', cursor: { acct, before } };
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

let pending = [];
let processed = 0;
const flush = () => {
  if (pending.length) { const r = mergeSales(pending, numByMint); state.sales += r.added; pending = []; }
  state.updatedAt = new Date().toISOString();
  writeJson('madlads-backfill.json', state);
  const data = readJson('madlads-data.json');
  if (data) { data.salesYears = fs.readdirSync(ROOT).map((f) => /^madlads-sales-(\d{4})\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort(); writeJson('madlads-data.json', data); }
};

try {
  while (state.next < lads.length && credits < BUDGET && Date.now() - startedAt < TIME_LIMIT_MS) {
    const lad = lads[state.next];
    const resume = state.partial && state.partial.num === lad.num ? state.partial : null;
    const spentBefore = resume?.spent || 0;
    const before = credits;
    const r = await walk(lad.mint, resume, Math.max(50, PER_LAD_CAP - spentBefore));
    pending.push(...r.sales);
    if (r.status === 'partial' && spentBefore + (credits - before) < PER_LAD_CAP * 3) {
      state.partial = { num: lad.num, ...r.cursor, spent: spentBefore + (credits - before) };
      flush();
      continue;
    }
    if (r.status !== 'done') state.skipped[lad.num] = r.why || 'history too long';
    state.partial = null;
    state.next++;
    processed++;
    if (processed % 20 === 0) { flush(); console.log(`  #${lad.num} · ${processed} Lads · ${credits} credits`); }
  }
} catch (e) {
  console.error(`stopped on error, progress is saved: ${e.message}`);
}
state.credits += credits;
flush();
console.log(`backfill: ${processed} Lads this run (${state.next}/${lads.length} total), ${state.sales} sales added so far, ${Object.keys(state.skipped).length} skipped, ${credits} credits this run, ${state.credits} in total`);
