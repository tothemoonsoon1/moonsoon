#!/usr/bin/env node
/**
 * Builds the data behind /madlads (all ~10k Mad Lads) from a handful of
 * collection-wide calls, so a full refresh costs ~200 Helius credits:
 *
 *  - Owners + traits: DAS getAssetsByGroup, 1,000 Lads per call (10 calls).
 *  - Escrowed Lads: an "owner" that is a program account (a Tensor listing,
 *    a loan, ...) is looked up with getMultipleAccounts (100 per call); a
 *    Tensor listing gives back the real seller and the ask.
 *  - Magic Eden listings and recent Magic Eden sales: Magic Eden's public API
 *    (no key, no Helius credits).
 *
 * Never read per-Lad transaction history here: a Lad has ~6,000 transactions
 * (bids, pool updates), which is what the per-Skull script can afford for 99
 * NFTs and this one cannot for 10,000.
 *
 * Output (repo root, all public data, no keys):
 *   madlads-static.json      mint + traits per Lad. Never changes after mint.
 *   madlads-data.json        owners, listings, escrow info, holder moves.
 *   madlads-sales-YYYY.json  sales per year, merged by signature.
 *   madlads-traits.json, madlads-mints.json, madlads-sales-YYYY.min.json
 *                            lighter copies of the above that the page loads (see madlads-lib.mjs).
 *
 * A failed source keeps the previous file's values for that part, it never
 * writes an emptier file.
 */
import fs from 'node:fs';
import { ROOT, readJson, writeJson, mergeSales, salesYearsOnDisk, writePageFiles } from './madlads-lib.mjs';
import { lastSale } from './madlads-chain.mjs';

const KEY = process.env.HELIUS_API_KEY;
if (!KEY) { console.error('Missing HELIUS_API_KEY'); process.exit(1); }
const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const ME = 'https://api-mainnet.magiceden.dev/v2/collections/mad_lads';
const COLLECTION = 'J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w';
const FEE = 1 + 0.02 + 0.042; // marketplace fee + Mad Lads royalty, added on top of the ask
const MOVES_KEEP_MS = 45 * 86400000;
const MOVES_MAX = 4000;

const TRAIT_KEYS = ['Type', 'Gender', 'Expression', 'Eyes', 'Clothing', 'Hat', 'Hair', 'Hand', 'Glove', 'Smoke', 'Background'];
const PROGRAMS = {
  TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp: 'Tensor listing',
  TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN: 'Tensor pool',
  TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg: 'Tensor pool',
  TB1Dqt8JeKQh7RLDzfYDJsq8KS4fS2yt87avRjyRxMv: 'Tensor bid',
  mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc: 'Magic Eden pool',
  M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K: 'Magic Eden',
  '1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix': 'Magic Eden escrow',
  SHARKobtfF1bHhxD2eqftjHBdVSCbKo9JtgK71FhELP: 'Sharky loan',
  JCFRaPv7852ESRwJJGRy2mysUMydXZgVVhrMLmExvmVp: 'Citrus loan',
  '4tdmkuY6EStxbS6Y8s5ueznL3VPMSugrvQuDeAHGZhSt': 'Rain loan',
};
const SYSTEM = '11111111111111111111111111111111';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let credits = 0;

async function rpc(method, params, cost = 1) {
  for (let i = 0; i < 8; i++) {
    let res;
    try {
      res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'madlads', method, params }) });
    } catch { await sleep(1000 * 2 ** i); continue; }
    if (res.ok) {
      const j = await res.json();
      credits += cost;
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return j.result;
    }
    if (res.status !== 429 && res.status < 500) throw new Error(`${method} HTTP ${res.status}`);
    await sleep(Math.min(30000, 1000 * 2 ** i));
  }
  throw new Error(`${method} retries exhausted`);
}

async function meGet(path) {
  for (let i = 0; i < 7; i++) {
    let res;
    try { res = await fetch(ME + path, { headers: { Accept: 'application/json' } }); } catch { await sleep(1000 * 2 ** i); continue; }
    if (res.ok) return res.json();
    if (res.status !== 429 && res.status < 500) throw new Error(`Magic Eden ${path} HTTP ${res.status}`);
    await sleep(Math.min(20000, 1000 * 2 ** i));
  }
  throw new Error(`Magic Eden ${path} retries exhausted`);
}


// ---------- base58 (for reading Tensor list-state accounts) ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}

// ---------- 1. Collection snapshot ----------
async function snapshot() {
  const assets = [];
  for (let page = 1; page < 40; page++) {
    const r = await rpc('getAssetsByGroup', { groupKey: 'collection', groupValue: COLLECTION, page, limit: 1000 }, 10);
    assets.push(...r.items);
    if (r.items.length < 1000) break;
  }
  const lads = [];
  for (const a of assets) {
    if (a.burnt) continue;
    const m = /#(\d+)\s*$/.exec(a.content?.metadata?.name || '');
    if (!m || !a.ownership?.owner) continue;
    const attrs = {};
    for (const t of a.content?.metadata?.attributes || []) attrs[t.trait_type] = String(t.value);
    lads.push({ num: Number(m[1]), mint: a.id, owner: a.ownership.owner, delegated: !!a.ownership.delegated, frozen: !!a.ownership.frozen, attrs });
  }
  lads.sort((a, b) => a.num - b.num);
  return lads;
}

// ---------- 2. Which "owners" are program accounts (escrows)? ----------
async function classifyOwners(owners) {
  const info = new Map();
  for (let i = 0; i < owners.length; i += 100) {
    const chunk = owners.slice(i, i + 100);
    const r = await rpc('getMultipleAccounts', [chunk, { encoding: 'base64' }]);
    r.value.forEach((acc, k) => {
      if (!acc || acc.owner === SYSTEM) return; // a normal wallet
      info.set(chunk[k], { program: acc.owner, data: Buffer.from(acc.data[0], 'base64') });
    });
  }
  return info;
}

// Tensor (TCOMP) ListState: 8 discriminator, 1 version, 1 bump, 32 owner,
// 32 asset id, 8 amount (lamports).
function tensorListState(buf, mint) {
  if (buf.length < 82) return null;
  const seller = b58encode(buf.subarray(10, 42));
  const asset = b58encode(buf.subarray(42, 74));
  if (asset !== mint) return null;
  return { seller, ask: Number(buf.readBigUInt64LE(74)) / 1e9 };
}

// ---------- 3. Magic Eden listings ----------
async function meListings() {
  const out = new Map();
  for (let offset = 0; offset < 5000; ) {
    const page = await meGet(`/listings?offset=${offset}&limit=100`);
    if (!Array.isArray(page) || !page.length) break;
    for (const l of page) if (l.tokenMint && l.price > 0) out.set(l.tokenMint, { seller: l.seller, ask: l.price });
    offset += page.length;
    await sleep(600);
  }
  return out;
}

// ---------- 4. Recent Magic Eden sales (their API keeps ~3 months) ----------
async function meSales() {
  const out = [];
  for (let offset = 0; offset < 20000; offset += 500) {
    const page = await meGet(`/activities?offset=${offset}&limit=500&type=buyNow`);
    if (!Array.isArray(page) || !page.length) break;
    for (const a of page) {
      if (a.type !== 'buyNow' || !a.tokenMint || !(a.price > 0)) continue;
      out.push({ t: a.blockTime, mint: a.tokenMint, p: a.price, m: 0, sig: a.signature, b: a.buyer, s: a.seller });
    }
    if (page.length < 500) break;
    await sleep(600);
  }
  return out;
}

// ---------- main ----------
const startedAt = Date.now();
const prevData = readJson('madlads-data.json');
const lads = await snapshot();
if (lads.length < 9000) throw new Error(`Snapshot returned only ${lads.length} Lads, keeping the previous files`);
console.log(`snapshot: ${lads.length} Lads`);

// Static file: mint + traits. Rewritten only when the set of Lads changes.
// Rarity ranks from HowRare (the ranking Magic Eden shows), one free call.
// Ranks never change, so they are fetched only when the static file is rebuilt.
async function howRareRanks() {
  try {
    const res = await fetch('https://api.howrare.is/v0.1/collections/madlads/only_rarity');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = (await res.json())?.result?.data?.items || [];
    return new Map(items.map((x) => [x.mint, x.rank]));
  } catch (e) { console.warn(`HowRare ranks unavailable: ${e.message}`); return new Map(); }
}

const prevStatic = readJson('madlads-static.json');
if (!prevStatic || prevStatic.lads.length !== lads.length || !prevStatic.rank) {
  const keys = TRAIT_KEYS.filter((k) => lads.some((l) => l.attrs[k]));
  for (const l of lads) for (const k of Object.keys(l.attrs)) if (!keys.includes(k)) keys.push(k);
  const values = keys.map(() => []);
  const vIdx = keys.map(() => new Map());
  const rows = lads.map((l) => [l.num, l.mint, ...keys.map((k, i) => {
    const v = l.attrs[k];
    if (v == null || v === '') return -1;
    if (!vIdx[i].has(v)) { vIdx[i].set(v, values[i].length); values[i].push(v); }
    return vIdx[i].get(v);
  })]);
  const hr = await howRareRanks();
  const rank = hr.size ? lads.map((l) => hr.get(l.mint) || 0) : (prevStatic?.rank && prevStatic.lads.length === lads.length ? prevStatic.rank : null);
  writeJson('madlads-static.json', { keys, values, lads: rows, ...(rank ? { rank } : {}) });
  console.log(`static: wrote ${rows.length} Lads, traits ${keys.join(', ')}`);
}

// Magic Eden listings (keep yesterday's on failure).
let meListed = null;
try { meListed = await meListings(); console.log(`Magic Eden listings: ${meListed.size}`); }
catch (e) { console.warn(`Magic Eden listings failed, keeping previous: ${e.message}`); }

// Escrows.
const uniqueOwners = [...new Set(lads.map((l) => l.owner))];
const programAccounts = await classifyOwners(uniqueOwners);
const escrowStats = {};
const tensorListed = new Map();
for (const l of lads) {
  const acc = programAccounts.get(l.owner);
  if (!acc) continue;
  const name = PROGRAMS[acc.program] || acc.program;
  escrowStats[name] = (escrowStats[name] || 0) + 1;
  // Listed on Magic Eden from its escrow: the seller is still the holder.
  const me = meListed?.get(l.mint);
  if (me?.seller) { l.owner = me.seller; l.escrow = null; continue; }
  if (acc.program === 'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp') {
    const ls = tensorListState(acc.data, l.mint);
    if (ls) { tensorListed.set(l.mint, ls); l.owner = ls.seller; l.escrow = null; continue; }
  }
  l.escrow = name;
}
console.log('program-owned holders:', JSON.stringify(escrowStats), `| Tensor listings read: ${tensorListed.size}`);

const numByMint = new Map(lads.map((l) => [l.mint, l.num]));
const listed = {};
if (meListed) {
  for (const [mint, l] of meListed) { const n = numByMint.get(mint); if (n != null) listed[n] = [Math.round(l.ask * FEE * 1000) / 1000, 0]; }
} else if (prevData?.listed) {
  for (const [n, v] of Object.entries(prevData.listed)) if (v[1] === 0) listed[n] = v;
}
for (const [mint, l] of tensorListed) {
  const n = numByMint.get(mint);
  const total = Math.round(l.ask * FEE * 1000) / 1000;
  if (!listed[n] || total < listed[n][0]) listed[n] = [total, 1];
}

// Owners, as an index into a wallet list.
const owners = [];
const oIdx = new Map();
const ownerOf = lads.map((l) => { if (!oIdx.has(l.owner)) { oIdx.set(l.owner, owners.length); owners.push(l.owner); } return oIdx.get(l.owner); });
const escrow = {};
for (const l of lads) if (l.escrow) escrow[oIdx.get(l.owner)] = l.escrow;

// Holder moves: who gained or lost which Lad since the previous snapshot.
let moves = (prevData?.moves || []).filter((m) => startedAt - m[0] * 1000 < MOVES_KEEP_MS);
const newMoves = [];
if (prevData?.nums && prevData.ownerOf) {
  const prevOwner = new Map(prevData.nums.map((n, i) => [n, prevData.owners[prevData.ownerOf[i]]]));
  const prevEscrow = new Set(Object.keys(prevData.escrow || {}).map((i) => prevData.owners[i]));
  const now = Math.floor(startedAt / 1000);
  let n = 0;
  for (const l of lads) {
    const before = prevOwner.get(l.num);
    if (!before || before === l.owner) continue;
    if (prevEscrow.has(before) || l.escrow) continue; // into or out of an escrow is not a change of holder
    moves.push([now, l.num, before, l.owner]);
    newMoves.push(l);
    n++;
  }
  console.log(`holder moves since last snapshot: ${n}`);
}
moves = moves.slice(-MOVES_MAX);

// Sales.
let salesYears = salesYearsOnDisk();
try {
  const found = await meSales();
  const r = mergeSales(found, numByMint);
  salesYears = r.years;
  console.log(`Magic Eden sales read: ${found.length}, new: ${r.added}`);
} catch (e) { console.warn(`Magic Eden sales failed, keeping previous: ${e.message}`); }

// Every sale on every marketplace, from the OpenSea API (it indexes Magic
// Eden, Tensor, OpenSea and the rest; tested 20.11.2026: all of ours plus 25
// more in 3 days). OpenSea prices include the 6.2% fee + royalty; the files
// keep raw prices, so they are divided back. OpenSea does not say which
// marketplace a sale was on: Helius' parsed transactions do (source, or the
// program called). Market codes: 0 Magic Eden, 1 Tensor, 2 other, 3 OpenSea, 4 Foxy.
const OS_KEY = process.env.OPENSEA_API_KEY;
const FEE_MULT = 1.062;
const PROGRAM_MARKET = {
  M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K: 0, M3mxk5W2tt27WGT7THox7PmgRDp4m6NEhL5xvxrBfS1: 0, mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc: 0,
  TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp: 1, TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN: 1, TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg: 1,
  '8guzmt92HbM7yQ69UJg564hRRX6N4nCdxWE5L6ENrA8P': 4,
};
const SOURCE_MARKET = { MAGIC_EDEN: 0, TENSOR: 1, OPENSEA: 3, FOXY: 4 };
async function openseaSales(sinceSec) {
  const out = [];
  let next = null;
  for (let page = 0; page < 40; page++) {
    const url = new URL('https://api.opensea.io/api/v2/events/collection/mad-lads');
    url.searchParams.set('event_type', 'sale');
    url.searchParams.set('after', String(sinceSec));
    url.searchParams.set('limit', '50');
    if (next) url.searchParams.set('next', next);
    const res = await fetch(url, { headers: { 'x-api-key': OS_KEY, accept: 'application/json' } });
    if (!res.ok) throw new Error(`OpenSea HTTP ${res.status}`);
    const j = await res.json();
    for (const e of j.asset_events || []) {
      if (e.chain !== 'solana' || !e.transaction || !e.nft?.identifier || !e.payment) continue;
      const total = Number(e.payment.quantity) / 10 ** (e.payment.decimals ?? 9);
      if (!(total > 0.3)) continue;
      out.push({ t: e.event_timestamp || e.closing_date, mint: e.nft.identifier, p: total / FEE_MULT, m: null, sig: e.transaction, b: e.buyer || null, s: e.seller || null });
    }
    next = j.next;
    if (!next) break;
    await sleep(300);
  }
  return out;
}
async function marketsOf(sigs) {
  const result = new Map(), unknown = {};
  for (let i = 0; i < sigs.length; i += 100) {
    const res = await fetch(`https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transactions: sigs.slice(i, i + 100) }) });
    credits += 100;
    if (!res.ok) throw new Error(`Helius parse HTTP ${res.status}`);
    for (const t of await res.json()) {
      let m = SOURCE_MARKET[t.source];
      if (m == null) {
        const progs = (t.instructions || []).map((x) => x.programId);
        m = progs.map((p) => PROGRAM_MARKET[p]).find((x) => x != null);
        if (m == null) { for (const pr of progs) if (!/^(ComputeBudget|11111111|Token|ATokenGP|metaq|auth9SigN)/.test(pr)) unknown[pr] = (unknown[pr] || 0) + 1; m = 2; }
      }
      result.set(t.signature, m);
    }
  }
  return { result, unknown };
}
let osOk = false;
if (OS_KEY) {
  try {
    const since = prevData?.generatedAt ? Date.parse(prevData.generatedAt) / 1000 - 86400 : startedAt / 1000 - 3 * 86400;
    const os = await openseaSales(Math.floor(since));
    // Signatures we already have, in this year's and last year's files.
    const known = new Map();
    for (const y of [new Date(startedAt).getUTCFullYear(), new Date(since * 1000).getUTCFullYear()]) {
      const f = readJson(`madlads-sales-${y}.json`);
      for (const r of f?.s || []) known.set(r[4], r[3]);
    }
    const fresh = os.filter((s) => !known.has(s.sig));
    const before = credits;
    const { result, unknown } = fresh.length ? await marketsOf(fresh.map((s) => s.sig)) : { result: new Map(), unknown: {} };
    for (const s of fresh) s.m = result.get(s.sig) ?? 2;
    const r = mergeSales(fresh, numByMint);
    salesYears = r.years;
    osOk = true;
    const byMkt = fresh.reduce((o, s) => { o[s.m] = (o[s.m] || 0) + 1; return o; }, {});
    console.log(`OpenSea sales read: ${os.length}, not in our files: ${fresh.length} ${JSON.stringify(byMkt)} (0 ME, 1 Tensor, 2 other, 3 OpenSea, 4 Foxy), new: ${r.added}, ${credits - before} credits`);
    if (Object.keys(unknown).length) console.log(`  unknown programs (marked other): ${JSON.stringify(unknown)}`);
  } catch (e) { console.warn(`OpenSea sales failed, falling back to the on-chain check: ${e.message}`); }
} else console.log('OPENSEA_API_KEY not set: skipping OpenSea sales');

// Sales the Magic Eden API does not list (Tensor, other marketplaces, OTC):
// for each Lad that changed holder since the last snapshot and has no Magic
// Eden sale in that window, read the transaction that moved it and check
// whether the new holder paid. Transfers and loans come out as null.
// A few credits per Lad; capped so a busy day cannot run away.
const CHAIN_MAX = 80;
if (!osOk) try {
  const since = prevData?.generatedAt ? Date.parse(prevData.generatedAt) / 1000 - 3600 : startedAt / 1000 - 86400;
  const meSold = new Set();
  for (const y of [new Date(startedAt).getUTCFullYear(), new Date(since * 1000).getUTCFullYear()]) {
    const f = readJson(`madlads-sales-${y}.json`);
    for (const r of f?.s || []) if (r[0] >= since && r[3] === 0) meSold.add(r[1]);
  }
  const todo = newMoves.filter((l) => !meSold.has(l.num)).slice(0, CHAIN_MAX);
  const before = credits, found = [];
  for (const l of todo) {
    try {
      const sale = await lastSale(rpc, l.mint);
      if (sale && sale.t >= since) { delete sale.dbg; found.push(sale); }
    } catch (e) { console.warn(`  #${l.num}: ${e.message}`); }
  }
  const r = mergeSales(found, numByMint);
  salesYears = r.years;
  const byMkt = found.reduce((o, s) => { o[s.m] = (o[s.m] || 0) + 1; return o; }, {});
  console.log(`on-chain check: ${todo.length} moved Lads without a Magic Eden sale, ${found.length} were sales ${JSON.stringify(byMkt)} (0 ME, 1 Tensor, 2 OTC/other), new: ${r.added}, ${credits - before} credits`);
} catch (e) { console.warn(`On-chain sale check failed: ${e.message}`); }

let tags = {};
try { tags = JSON.parse(fs.readFileSync(new URL('owner-tags.json', ROOT), 'utf8')).wallets || {}; } catch { /* optional */ }
const usedTags = {};
for (const w of owners) if (tags[w]) usedTags[w] = tags[w];

writeJson('madlads-data.json', {
  generatedAt: new Date(startedAt).toISOString(),
  nums: lads.map((l) => l.num),
  owners,
  ownerOf,
  escrow,
  listed,
  tags: usedTags,
  moves,
  salesYears,
});
// Lighter copies the page loads (no mints, no signatures); see madlads-lib.mjs.
writePageFiles();
const sizes = fs.readdirSync(ROOT).filter((f) => f.startsWith('madlads-')).map((f) => `${f} ${(fs.statSync(new URL(f, ROOT)).size / 1024).toFixed(0)}KB`);
console.log(`done: ${owners.length} holders, ${Object.keys(listed).length} listed, ~${credits} Helius credits, ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
console.log(sizes.join(' | '));
