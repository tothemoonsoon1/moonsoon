#!/usr/bin/env node
/**
 * SPIKE (read-only, writes nothing to the repo): measures what a full
 * Mad Lads (10k) data pipeline would cost before building it.
 *
 *  1. Holder snapshot of the whole collection via DAS getAssetsByGroup.
 *  2. Sales backfill cost on a sample of mints using plain RPC
 *     (getSignaturesForAddress + getTransaction, ~1 credit each), with a
 *     home-made sale parser checked against skulls-data.json (known sales).
 *  3. One enhanced transaction (same shape as a Helius webhook payload) for a
 *     known Tensor sale and a known Magic Eden sale.
 *
 * Prints a report to stdout and $GITHUB_STEP_SUMMARY. Run via
 * .github/workflows/spike-madlads.yml (uses the HELIUS_API_KEY secret).
 */
import fs from 'node:fs';

const KEY = process.env.HELIUS_API_KEY;
if (!KEY) { console.error('Missing HELIUS_API_KEY'); process.exit(1); }
const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const ENHANCED = `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${KEY}`;
const COLLECTION = 'J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w'; // Mad Lads collection
const SAMPLE_RANDOM = Number(process.env.SAMPLE_RANDOM || 50);
const SAMPLE_SKULLS = Number(process.env.SAMPLE_SKULLS || 30);
const LAMPORTS = 1e9;

const credits = { das: 0, sigs: 0, tx: 0, enhanced: 0 };
const out = [];
const log = (s = '') => { console.log(s); out.push(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, bucket) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'spike', method, params }),
    });
    if (res.ok) {
      const j = await res.json();
      credits[bucket]++;
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return j.result;
    }
    if (res.status !== 429 && res.status < 500) throw new Error(`${method} HTTP ${res.status}`);
    await sleep(500 * 2 ** i);
  }
  throw new Error(`${method} retries exhausted`);
}

// ---------- 1. Holder snapshot ----------
async function snapshot() {
  const t0 = Date.now();
  const assets = [];
  for (let page = 1; page < 30; page++) {
    const r = await rpc('getAssetsByGroup', { groupKey: 'collection', groupValue: COLLECTION, page, limit: 1000 }, 'das');
    assets.push(...r.items);
    if (r.items.length < 1000) break;
  }
  const owners = new Map();
  for (const a of assets) {
    if (a.burnt) continue;
    const o = a.ownership?.owner;
    owners.set(o, (owners.get(o) || 0) + 1);
  }
  const counts = [...owners.values()];
  const bucket = (lo, hi) => counts.filter((c) => c >= lo && c <= hi).length;
  const top = [...owners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const slim = assets.map((a) => ({ id: a.id, n: a.content?.metadata?.name, o: a.ownership?.owner, img: a.content?.links?.image, cdn: a.content?.files?.[0]?.cdn_uri }));
  log('## 1. Holder snapshot (getAssetsByGroup)');
  log(`- assets: ${assets.length}, pages: ${credits.das}, time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`- unique owners: ${owners.size}`);
  log(`- holders 1: ${bucket(1, 1)}, 2–4: ${bucket(2, 4)}, 5–19: ${bucket(5, 19)}, 20+: ${bucket(20, 1e9)}`);
  log(`- top 10: ${top.map(([o, c]) => `${o.slice(0, 4)}…${o.slice(-4)}=${c}`).join(', ')}`);
  log(`- slim owner file size (raw JSON): ${(JSON.stringify(slim.map((s) => [s.n, s.o])).length / 1024).toFixed(0)} KB`);
  log(`- example image: ${slim[0]?.img} | cdn: ${slim[0]?.cdn}`);
  return assets;
}

// ---------- 2. Backfill cost + parser ----------
async function allSignatures(mint) {
  const sigs = [];
  let before;
  for (;;) {
    const r = await rpc('getSignaturesForAddress', [mint, { limit: 1000, ...(before ? { before } : {}) }], 'sigs');
    sigs.push(...r.filter((s) => !s.err));
    if (r.length < 1000) break;
    before = r[r.length - 1].signature;
  }
  return sigs;
}

// A sale = the NFT changes owner AND the new owner's wallet pays SOL
// (> 0.5 SOL). Price = SOL paid by the buyer minus network fee if they
// signed. Marketplace = program ids present.
const MARKETS = {
  M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K: 'MagicEden',
  M3mxk5W2tt27WGT7THox7PmgRDp4m6NEhL5xvxrBfS1: 'MagicEden',
  TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN: 'Tensor',
  TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp: 'Tensor',
  TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg: 'Tensor',
  hadeK9DLv9eA7ya5KCTqSvSvRZeJC3JgD5a9Y3CNbvu: 'Hadeswap',
};
function parseSale(tx, mint) {
  const m = tx?.meta;
  if (!m) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const pre = (m.preTokenBalances || []).find((b) => b.mint === mint && Number(b.uiTokenAmount.amount) > 0);
  const post = (m.postTokenBalances || []).find((b) => b.mint === mint && Number(b.uiTokenAmount.amount) > 0);
  const from = pre?.owner, to = post?.owner;
  if (!from || !to || from === to) return null;
  const programs = new Set(keys.filter((k) => MARKETS[k]).map((k) => MARKETS[k]));
  const i = keys.indexOf(to);
  if (i < 0) return { kind: 'transfer', from, to };
  let paid = (m.preBalances[i] - m.postBalances[i]) / LAMPORTS;
  if (i === 0) paid -= m.fee / LAMPORTS;
  // Accepted-bid sales: buyer's SOL was in an escrow, seller signs. Fall back
  // to the seller's gain.
  if (paid < 0.5) {
    const s = keys.indexOf(from);
    if (s >= 0) {
      let gain = (m.postBalances[s] - m.preBalances[s]) / LAMPORTS;
      if (s === 0) gain += m.fee / LAMPORTS;
      if (gain > 0.5) return { kind: 'sale', price: +(gain / (1 - 0.042 - 0.02)).toFixed(2), approx: 'seller-side', market: [...programs].join('+') || '?', from, to };
    }
    return programs.size ? { kind: 'sale?', market: [...programs].join('+'), from, to } : { kind: 'transfer', from, to };
  }
  return { kind: 'sale', price: +paid.toFixed(2), market: [...programs].join('+') || '?', from, to };
}

async function backfillSample(assets) {
  const known = JSON.parse(fs.readFileSync(new URL('../skulls-data.json', import.meta.url), 'utf8')).skulls;
  const skullSample = known.filter((s) => s.sales?.length).slice(0, SAMPLE_SKULLS);
  const pool = assets.filter((a) => !a.burnt);
  const randomSample = [];
  for (let i = 0; i < SAMPLE_RANDOM; i++) randomSample.push(pool[Math.floor(Math.random() * pool.length)].id);

  const t0 = Date.now();
  let totalSigs = 0, sales = 0, unsure = 0;
  const marketCount = {};
  // Random mints: count signatures only (cost model) + parse all their txs.
  for (const mint of randomSample) {
    const sigs = await allSignatures(mint);
    totalSigs += sigs.length;
    for (const s of sigs) {
      const tx = await rpc('getTransaction', [s.signature, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }], 'tx');
      const p = parseSale(tx, mint);
      if (p?.kind === 'sale') { sales++; marketCount[p.market] = (marketCount[p.market] || 0) + 1; }
      if (p?.kind === 'sale?') unsure++;
    }
  }
  const avgSigs = totalSigs / randomSample.length;
  log('');
  log('## 2. Backfill cost (plain RPC)');
  log(`- random sample: ${randomSample.length} mints, ${totalSigs} txs (avg ${avgSigs.toFixed(1)}/mint), ${sales} sales, ${unsure} unclear, time ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  log(`- sales by market: ${JSON.stringify(marketCount)}`);
  const est = Math.round(10000 * (avgSigs + 1));
  log(`- **estimated full backfill: ~${est.toLocaleString('en')} credits** (1 sig page + 1 getTransaction per tx, × 10k mints)`);

  // Skull mints: compare parser with known sales from skulls-data.json.
  let match = 0, missed = 0, extra = 0, priceOff = 0;
  const notes = [];
  for (const sk of skullSample) {
    const sigs = await allSignatures(sk.mint);
    const found = [];
    for (const s of sigs) {
      const tx = await rpc('getTransaction', [s.signature, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }], 'tx');
      const p = parseSale(tx, sk.mint);
      if (p?.kind === 'sale') found.push({ ...p, ts: tx.blockTime * 1000 });
    }
    for (const k of sk.sales) {
      const f = found.find((x) => Math.abs(x.ts - k.timestamp) < 120000);
      if (!f) { missed++; if (notes.length < 8) notes.push(`missed #${sk.num} ${new Date(k.timestamp).toISOString().slice(0, 10)} ${k.priceSol} ${k.source}`); continue; }
      match++;
      if (Math.abs(f.price - k.priceSol) / k.priceSol > 0.03) { priceOff++; if (notes.length < 8) notes.push(`price #${sk.num}: parser ${f.price} vs known ${k.priceSol} (${f.market}${f.approx ? ', ' + f.approx : ''})`); }
    }
    extra += found.filter((f) => !sk.sales.some((k) => Math.abs(f.ts - k.timestamp) < 120000)).length;
  }
  log('');
  log(`## 2b. Parser vs known Skull sales (${skullSample.length} Skulls)`);
  log(`- matched ${match}, missed ${missed}, extra (parser-only) ${extra}, price off >3%: ${priceOff}`);
  for (const n of notes) log(`  - ${n}`);
}

// ---------- 3. Webhook payload shape ----------
async function webhookShape() {
  const known = JSON.parse(fs.readFileSync(new URL('../skulls-data.json', import.meta.url), 'utf8')).skulls;
  const sk = known.find((s) => s.num === 1792) || known.find((s) => s.sales?.length > 1);
  const sigs = await rpc('getSignaturesForAddress', [sk.mint, { limit: 50 }], 'sigs');
  const res = await fetch(ENHANCED, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transactions: sigs.map((s) => s.signature).slice(0, 50) }) });
  credits.enhanced++;
  const txs = await res.json();
  log('');
  log(`## 3. Enhanced tx shape (= webhook payload), Skull #${sk.num}`);
  const types = {};
  for (const t of txs) types[`${t.type}/${t.source}`] = (types[`${t.type}/${t.source}`] || 0) + 1;
  log(`- types: ${JSON.stringify(types)}`);
  const sale = txs.find((t) => t.type === 'NFT_SALE');
  if (sale) log('- NFT_SALE event: `' + JSON.stringify(sale.events?.nft ? { ...sale.events.nft, nfts: sale.events.nft.nfts?.length } : sale.description) + '`');
}

const t0 = Date.now();
const assets = await snapshot();
await backfillSample(assets);
await webhookShape();
log('');
log(`## Credits used (approx): DAS ${credits.das}×10, sigs ${credits.sigs}, getTransaction ${credits.tx}, enhanced ${credits.enhanced}×100 → ~${(credits.das * 10 + credits.sigs + credits.tx + credits.enhanced * 100).toLocaleString('en')} — total time ${((Date.now() - t0) / 60000).toFixed(1)} min`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join('\n') + '\n');
