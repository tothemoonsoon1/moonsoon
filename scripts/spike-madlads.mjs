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
  for (let i = 0; i < 9; i++) {
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
    await sleep(Math.min(30000, 1000 * 2 ** i));
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

async function pmap(items, n, fn) {
  const res = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); } }));
  return res;
}
const getTx = (sig) => rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }], 'tx');
const DEADLINE = Date.now() + 40 * 60000;
const MAX_TX_PER_MINT = 150;

async function backfillSample(assets) {
  const known = JSON.parse(fs.readFileSync(new URL('../skulls-data.json', import.meta.url), 'utf8')).skulls;
  const skullSample = known.filter((s) => s.sales?.length).slice(0, SAMPLE_SKULLS);
  const pool = assets.filter((a) => !a.burnt);
  const randomSample = Array.from({ length: SAMPLE_RANDOM }, () => pool[Math.floor(Math.random() * pool.length)].id);

  // 2a. Signature counts only (1 credit per 1000 sigs) -> cost model.
  const t0 = Date.now();
  const sigLists = await pmap(randomSample, 2, (m) => allSignatures(m).catch(() => []));
  const counts = sigLists.map((l) => l.length).sort((a, b) => a - b);
  const total = counts.reduce((a, b) => a + b, 0);
  const avg = total / counts.length;
  log('');
  log('## 2. Backfill cost (plain RPC)');
  log(`- ${counts.length} random mints: ${total} txs, avg ${avg.toFixed(0)}/mint, median ${counts[counts.length >> 1]}, max ${counts[counts.length - 1]} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  log(`- **getTransaction for every tx × 10k mints ≈ ${Math.round(10000 * avg).toLocaleString('en')} credits**`);

  // What are these txs? Parse up to MAX_TX_PER_MINT per mint for the first 10 mints.
  const kinds = {}; const marketCount = {}; let parsed = 0, sales = 0;
  for (const list of sigLists.slice(0, 10)) {
    if (Date.now() > DEADLINE) break;
    const txs = await pmap(list.slice(0, MAX_TX_PER_MINT), 3, (s) => getTx(s.signature).catch(() => null));
    for (const tx of txs) {
      if (!tx) continue; parsed++;
      const progs = [...new Set(tx.transaction.message.instructions.map((ix) => ix.programId))].map((p) => MARKETS[p] || p.slice(0, 6)).join('+');
      kinds[progs] = (kinds[progs] || 0) + 1;
    }
    const mint = randomSample[sigLists.indexOf(list)];
    for (const tx of txs) { const p = parseSale(tx, mint); if (p?.kind === 'sale') { sales++; marketCount[p.market] = (marketCount[p.market] || 0) + 1; } }
    console.log(`  progress: parsed ${parsed}`);
  }
  const topKinds = Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 8);
  log(`- parsed ${parsed} txs of 10 mints: ${sales} sales, by market ${JSON.stringify(marketCount)}`);
  log(`- most common top-level programs: ${topKinds.map(([k, v]) => `${k}=${v}`).join(', ')}`);

  // 2b. Parser vs known Skull sales (only mints with <= 300 txs, to stay in budget).
  let match = 0, missed = 0, extra = 0, priceOff = 0, checked = 0;
  const notes = [];
  for (const sk of skullSample) {
    if (Date.now() > DEADLINE) break;
    const sigs = await allSignatures(sk.mint);
    if (sigs.length > 300) continue;
    checked++;
    const txs = await pmap(sigs, 3, (s) => getTx(s.signature).catch(() => null));
    const found = [];
    for (const tx of txs) { const p = parseSale(tx, sk.mint); if (p?.kind === 'sale') found.push({ ...p, ts: tx.blockTime * 1000 }); }
    for (const k of sk.sales) {
      const f = found.find((x) => Math.abs(x.ts - k.timestamp) < 120000);
      if (!f) { missed++; if (notes.length < 10) notes.push(`missed #${sk.num} ${new Date(k.timestamp).toISOString().slice(0, 10)} ${k.priceSol} ${k.source}`); continue; }
      match++;
      const ratio = f.price / k.priceSol;
      if (Math.abs(ratio - 1) > 0.03) { priceOff++; if (notes.length < 10) notes.push(`price #${sk.num}: parser ${f.price} vs known ${k.priceSol}, ratio ${ratio.toFixed(3)} (${f.market}${f.approx ? ', ' + f.approx : ''})`); }
    }
    extra += found.filter((f) => !sk.sales.some((k) => Math.abs(f.ts - k.timestamp) < 120000)).length;
    console.log(`  skulls checked: ${checked}`);
  }
  log('');
  log(`## 2b. Parser vs known Skull sales (${checked} Skulls with <=300 txs)`);
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

// ---------- 4. Owner-chain walk (cheap backfill) ----------
// Follow the token account that holds the NFT now, back through every
// account that held it before. Bids/offers never touch the holder's token
// account, so only real moves (sales, transfers, escrow listings) are read.
const keysOf = (tx) => tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
function incoming(tx, mint, acct) {
  const m = tx?.meta; if (!m) return null;
  const keys = keysOf(tx);
  const bal = (list, addr) => { const b = (list || []).find((x) => x.mint === mint && keys[x.accountIndex] === addr); return b ? Number(b.uiTokenAmount.amount) : 0; };
  if (!(bal(m.preTokenBalances, acct) === 0 && bal(m.postTokenBalances, acct) > 0)) return null;
  const src = (m.preTokenBalances || []).find((x) => x.mint === mint && Number(x.uiTokenAmount.amount) > 0 && keys[x.accountIndex] !== acct);
  const dst = (m.postTokenBalances || []).find((x) => x.mint === mint && keys[x.accountIndex] === acct);
  return { srcAcct: src ? keys[src.accountIndex] : null, from: src?.owner || null, to: dst?.owner };
}
async function walkMint(mint, budget = 3000) {
  const start = credits.sigs + credits.tx;
  const largest = await rpc('getTokenLargestAccounts', [mint], 'sigs');
  let acct = largest.value.find((a) => a.uiAmount > 0)?.address;
  let before;
  const moves = [];
  let hops = 0;
  while (acct && hops < 100 && credits.sigs + credits.tx - start < budget) {
    hops++;
    let found = null, cursor = before;
    outer: for (;;) {
      const sigs = await rpc('getSignaturesForAddress', [acct, { limit: 100, ...(cursor ? { before: cursor } : {}) }], 'sigs');
      for (const s of sigs) {
        if (s.err) continue;
        const tx = await getTx(s.signature);
        const inc = incoming(tx, mint, acct);
        if (inc) { found = { ...inc, sig: s.signature, ts: tx.blockTime * 1000, sale: parseSale(tx, mint) }; break outer; }
        if (credits.sigs + credits.tx - start > budget) break outer;
      }
      if (sigs.length < 100) break;
      cursor = sigs[sigs.length - 1].signature;
    }
    if (!found) break;
    moves.push(found);
    if (!found.srcAcct) break; // mint
    acct = found.srcAcct; before = found.sig;
  }
  return { moves, cost: credits.sigs + credits.tx - start, hops, complete: !!moves.length && !moves[moves.length - 1].srcAcct };
}
async function chainSpike(assets) {
  const known = JSON.parse(fs.readFileSync(new URL('../skulls-data.json', import.meta.url), 'utf8')).skulls;
  const skulls = known.filter((s) => s.sales?.length).sort((a, b) => b.sales.length - a.sales.length).slice(0, 20);
  const pool = assets.filter((a) => !a.burnt);
  const randoms = Array.from({ length: 10 }, () => pool[Math.floor(Math.random() * pool.length)].id);
  log('');
  log('## 4. Owner-chain walk');
  let match = 0, missed = 0, extra = 0, priceOff = 0; const ratios = []; const notes = []; const costs = [];
  for (const sk of skulls) {
    if (Date.now() > DEADLINE) break;
    const r = await walkMint(sk.mint).catch((e) => ({ err: e.message }));
    if (r.err) { notes.push(`#${sk.num} error ${r.err}`); continue; }
    costs.push(r.cost);
    const sales = r.moves.filter((m) => m.sale?.kind === 'sale');
    for (const k of sk.sales) {
      const f = sales.find((x) => Math.abs(x.ts - k.timestamp) < 120000);
      if (!f) { missed++; if (notes.length < 12) notes.push(`missed #${sk.num} ${new Date(k.timestamp).toISOString().slice(0, 10)} ${k.priceSol} ${k.source}`); continue; }
      match++; const ratio = f.sale.price / k.priceSol; ratios.push(ratio);
      if (Math.abs(ratio - 1) > 0.08) { priceOff++; if (notes.length < 12) notes.push(`price #${sk.num}: ${f.sale.price} vs ${k.priceSol} (${f.sale.market})`); }
    }
    extra += sales.filter((f) => !sk.sales.some((k) => Math.abs(f.ts - k.timestamp) < 120000)).length;
    console.log(`  #${sk.num}: hops ${r.hops}, moves ${r.moves.length}, sales ${sales.length}/${sk.sales.length} known, cost ${r.cost}, complete ${r.complete}`);
  }
  log(`- Skulls (20 most traded): matched ${match}, missed ${missed}, extra ${extra}, price off >8%: ${priceOff}`);
  ratios.sort((a, b) => a - b);
  if (ratios.length) log(`- price ratio parser/known: median ${ratios[ratios.length >> 1].toFixed(3)}`);
  for (const n of notes) log(`  - ${n}`);
  const rc = [];
  for (const m of randoms) {
    if (Date.now() > DEADLINE) break;
    const r = await walkMint(m).catch(() => null);
    if (!r) continue;
    rc.push(r.cost);
    console.log(`  random ${m.slice(0, 6)}: hops ${r.hops}, moves ${r.moves.length}, sales ${r.moves.filter((x) => x.sale?.kind === 'sale').length}, cost ${r.cost}, complete ${r.complete}`);
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  log(`- cost per mint: Skulls avg ${avg(costs).toFixed(0)}, random avg ${avg(rc).toFixed(0)} (max ${Math.max(0, ...rc)})`);
  log(`- **estimated full backfill ≈ ${Math.round(10000 * avg(rc)).toLocaleString('en')} credits**`);
}

const t0 = Date.now();
const assets = await snapshot();
await chainSpike(assets);
log('');
log(`## Credits used (approx): DAS ${credits.das}×10, sigs ${credits.sigs}, getTransaction ${credits.tx}, enhanced ${credits.enhanced}×100 → ~${(credits.das * 10 + credits.sigs + credits.tx + credits.enhanced * 100).toLocaleString('en')} — total time ${((Date.now() - t0) / 60000).toFixed(1)} min`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join('\n') + '\n');
