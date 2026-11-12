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
 *
 * A failed source keeps the previous file's values for that part, it never
 * writes an emptier file.
 */
import fs from 'node:fs';

const KEY = process.env.HELIUS_API_KEY;
if (!KEY) { console.error('Missing HELIUS_API_KEY'); process.exit(1); }
const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const ME = 'https://api-mainnet.magiceden.dev/v2/collections/mad_lads';
const COLLECTION = 'J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w';
const ROOT = new URL('../', import.meta.url);
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

const readJson = (name) => { try { return JSON.parse(fs.readFileSync(new URL(name, ROOT), 'utf8')); } catch { return null; } };
const writeJson = (name, data) => fs.writeFileSync(new URL(name, ROOT), JSON.stringify(data) + '\n');

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

// Sales files: { w: [wallets], s: [[time, num, price, market, sig, buyerIdx, sellerIdx]] }
// market: 0 Magic Eden, 1 Tensor, 2 other.
function mergeSales(found, numByMint) {
  const byYear = new Map();
  for (const s of found) {
    const num = numByMint.get(s.mint);
    if (num == null) continue;
    const y = new Date(s.t * 1000).getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push({ ...s, num });
  }
  const years = new Set((readJson('madlads-data.json')?.salesYears) || []);
  let added = 0;
  for (const [y, list] of byYear) {
    const file = `madlads-sales-${y}.json`;
    const prev = readJson(file) || { w: [], s: [] };
    const wIdx = new Map(prev.w.map((w, i) => [w, i]));
    const idx = (w) => { if (!w) return -1; if (!wIdx.has(w)) { wIdx.set(w, prev.w.length); prev.w.push(w); } return wIdx.get(w); };
    const seen = new Set(prev.s.map((r) => r[4]));
    for (const s of list) {
      if (seen.has(s.sig)) continue;
      seen.add(s.sig);
      prev.s.push([s.t, s.num, Math.round(s.p * 1000) / 1000, s.m, s.sig, idx(s.b), idx(s.s)]);
      added++;
    }
    prev.s.sort((a, b) => a[0] - b[0]);
    writeJson(file, prev);
    years.add(y);
  }
  return { years: [...years].sort(), added };
}

// ---------- main ----------
const startedAt = Date.now();
const prevData = readJson('madlads-data.json');
const lads = await snapshot();
if (lads.length < 9000) throw new Error(`Snapshot returned only ${lads.length} Lads, keeping the previous files`);
console.log(`snapshot: ${lads.length} Lads`);

// Static file: mint + traits. Rewritten only when the set of Lads changes.
const prevStatic = readJson('madlads-static.json');
if (!prevStatic || prevStatic.lads.length !== lads.length) {
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
  writeJson('madlads-static.json', { keys, values, lads: rows });
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
    n++;
  }
  console.log(`holder moves since last snapshot: ${n}`);
}
moves = moves.slice(-MOVES_MAX);

// Sales.
let salesYears = prevData?.salesYears || [];
try {
  const found = await meSales();
  const r = mergeSales(found, numByMint);
  salesYears = r.years;
  console.log(`Magic Eden sales read: ${found.length}, new: ${r.added}`);
} catch (e) { console.warn(`Magic Eden sales failed, keeping previous: ${e.message}`); }

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
const sizes = fs.readdirSync(ROOT).filter((f) => f.startsWith('madlads-')).map((f) => `${f} ${(fs.statSync(new URL(f, ROOT)).size / 1024).toFixed(0)}KB`);
console.log(`done: ${owners.length} holders, ${Object.keys(listed).length} listed, ~${credits} Helius credits, ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
console.log(sizes.join(' | '));
