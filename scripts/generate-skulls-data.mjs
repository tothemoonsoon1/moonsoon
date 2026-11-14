#!/usr/bin/env node
/**
 * Updates skulls-data.json from on-chain data (Helius) + Magic Eden.
 * Run with a Helius key in HELIUS_API_KEY, either locally:
 *
 *   HELIUS_API_KEY=xxxxxxxx node scripts/generate-skulls-data.mjs
 *
 * or via the scheduled GitHub Actions workflow
 * (.github/workflows/update-skulls.yml), which reads the key from a repo
 * secret and never prints or commits it.
 *
 * History: this used Helius first, then Tensor's undocumented GraphQL
 * endpoint (July–October 2026), which started answering every scripted
 * request with 403 {"code":"TURNSTILE_REQUIRED"} — a Cloudflare bot check
 * only a real browser passes. Back to Helius, but incrementally:
 *
 *  - The 99 Skulls and everything already known about them (sales history,
 *    owner, listing, image) come from the committed skulls-data.json. Only
 *    transactions newer than each Skull's `syncedAt` are fetched, so a
 *    normal night costs one Helius call per Skull instead of re-reading
 *    every Skull's full history — the full re-read is what used to burn
 *    through Helius credits.
 *  - A Skull with no new transactions has, by definition, the same owner and
 *    listing as before (listing, delisting, selling and transferring are all
 *    on-chain transactions touching the mint), so nothing else is called.
 *  - Any failure for a Skull keeps its previous entry untouched (and its old
 *    `syncedAt`, so the next run retries the same window). The old Helius
 *    version wrote empty "never traded" entries whenever Magic Eden 429'd,
 *    which is how Skulls went missing from the gallery.
 *
 * Output: skulls-data.json in the repo root — safe to commit, contains no
 * API key, only public NFT data (owner, trades, prices, listings).
 */

import fs from 'node:fs';

const HELIUS_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_KEY) {
  console.error('Missing HELIUS_API_KEY env var. Usage: HELIUS_API_KEY=xxx node scripts/generate-skulls-data.mjs');
  process.exit(1);
}

const DATA_FILE = new URL('../skulls-data.json', import.meta.url);
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const HELIUS_TXS = (mint) => `https://api-mainnet.helius-rpc.com/v0/addresses/${mint}/transactions?api-key=${HELIUS_KEY}`;
const ME_BASE = 'https://api-mainnet.magiceden.dev/v2';
const LAMPORTS_PER_SOL = 1_000_000_000;

// Both Magic Eden and Tensor list the seller's raw ask and add their 2%
// taker fee + Mad Lads' enforced 4.2% royalty on top at checkout (verified:
// a raw ask of 83.69 SOL for #1792 showed as 88.8788 SOL on Tensor —
// 83.69 * 1.062). listPrice is the real total a buyer pays.
const BUYER_TOTAL_MULTIPLIER = 1 + 0.02 + 0.042;

// Re-read a day before the last sync so a transaction Helius indexed late
// isn't skipped. Anything seen twice is de-duplicated (see addSales).
const SYNC_OVERLAP_MS = 24 * 60 * 60 * 1000;

const TX_PAGE_LIMIT = 100;
const TX_MAX_PAGES = 10;

// Wallet -> X handle tags (owner-tags.json, hand-maintained). Looked up by the
// CURRENT owner on every run, so a tag automatically follows a Skull to its
// new owner (or disappears) when it's sold — no manual re-tagging needed.
function loadOwnerTags() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../owner-tags.json', import.meta.url), 'utf8')).wallets || {};
  } catch (e) {
    console.warn(`Could not read owner-tags.json, continuing without tags: ${e.message}`);
    return {};
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Fetches with retry+backoff on 429/5xx and on transport errors (DNS, reset,
// timeout — those make fetch() reject instead of returning a bad status).
// Real 4xx come back to the caller. Labels never include the URL, which
// carries the API key.
async function fetchWithRetry(url, label, init = undefined, attempts = 6) {
  let lastStatus = null;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      lastStatus = res.status;
      if (res.status !== 429 && res.status < 500) return res;
    } catch (e) {
      lastErr = e;
    }
    await sleep(500 * Math.pow(2, i)); // 500ms … 16s
  }
  throw new Error(
    `${label} failed after ${attempts} attempts, last status ${lastStatus}${lastErr ? `, last error: ${lastErr.message}` : ''}`
  );
}

// Newest-first transactions touching the mint, back to `sinceMs`. Throws on
// anything but a clean answer, so the caller keeps the Skull's old entry.
async function heliusTransactionsSince(mint, sinceMs) {
  const all = [];
  let before = null;
  for (let page = 0; page < TX_MAX_PAGES; page++) {
    const url = `${HELIUS_TXS(mint)}&limit=${TX_PAGE_LIMIT}${before ? `&before=${before}` : ''}`;
    const res = await fetchWithRetry(url, `Helius transactions for ${mint}`);
    // Helius answers 404, not [], when an address has no transactions.
    if (res.status === 404) break;
    if (!res.ok) throw new Error(`Helius transactions for ${mint}: HTTP ${res.status}, body: ${(await res.text()).slice(0, 300)}`);
    const txs = await res.json();
    if (!Array.isArray(txs)) throw new Error(`Helius transactions for ${mint}: unexpected body ${JSON.stringify(txs).slice(0, 300)}`);
    for (const tx of txs) {
      if ((tx.timestamp ?? 0) * 1000 < sinceMs) return all;
      all.push(tx);
    }
    if (txs.length < TX_PAGE_LIMIT) break;
    before = txs[txs.length - 1].signature;
    await sleep(300);
  }
  return all;
}

// Tensor migrated programs over time (dev.tensor.trade/docs/program-changes)
// and Helius's NFT_SALE classifier doesn't reliably tag trades through the
// newer ones — #1792 has 4 real sales but only 1 came back as NFT_SALE. So a
// tx that touches a Tensor program and moves both the NFT and real SOL is
// treated as a sale too.
const TENSOR_PROGRAM_IDS = new Set([
  'TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN', // legacy TSWAP (shared escrow)
  'TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg', // AMM (pools)
  'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp', // Marketplace (listings/bids)
]);

// Tensor's shared-escrow deposit/withdraw also moves the NFT plus ~0.003 SOL
// of rent and fees. A real sale moves the price, orders of magnitude more.
const MIN_SALE_LAMPORTS = 20_000_000; // 0.02 SOL

function touchesTensor(tx) {
  for (const ix of tx.instructions || []) {
    if (TENSOR_PROGRAM_IDS.has(ix.programId)) return true;
    for (const inner of ix.innerInstructions || []) if (TENSOR_PROGRAM_IDS.has(inner.programId)) return true;
  }
  return false;
}

function nftMoved(tx, mint) {
  return (tx.tokenTransfers || []).some((tt) => tt.mint === mint);
}

function largestNativeTransfer(tx) {
  const amounts = (tx.nativeTransfers || []).map((nt) => nt.amount).filter((a) => typeof a === 'number' && a > 0);
  return amounts.length ? Math.max(...amounts) : 0;
}

function solFromDescription(description) {
  const match = String(description || '').match(/for ([\d.]+) SOL/);
  return match ? parseFloat(match[1]) : null;
}

// Mad Lads' 4.2% royalty is enforced on every sale and paid from the same
// account that pays the seller, so the sale price is the transfer that comes
// with a sibling transfer of 4.2% of it. Needed for Magic Eden bid-accepts,
// which Helius leaves as UNKNOWN with no price: #1792's 49 SOL sale paid
// exactly 49 to the seller, 2.058 royalty and 0.98 Magic Eden fee.
const ROYALTY_RATE = 0.042;
function priceFromRoyalty(tx) {
  const transfers = (tx.nativeTransfers || []).filter((t) => t.amount > MIN_SALE_LAMPORTS);
  const candidates = transfers.filter((t) =>
    (tx.nativeTransfers || []).some(
      (u) => u !== t && u.fromUserAccount === t.fromUserAccount && Math.abs(u.amount - ROYALTY_RATE * t.amount) <= 0.001 * t.amount
    )
  );
  return candidates.length ? Math.max(...candidates.map((t) => t.amount)) : null;
}

function isSale(tx, mint) {
  if (!nftMoved(tx, mint)) return false;
  if (tx.source === 'MAGIC_EDEN' && tx.type !== 'NFT_SALE') return priceFromRoyalty(tx) != null;
  // Helius's own NFT_SALE carries the price itself. A Magic Eden bid-accept
  // pays out of the bid escrow, so it can have no large native transfer at
  // all (#1792's 49 SOL sale in May 2026 was missed by requiring one).
  if (tx.type === 'NFT_SALE') {
    const lamports = tx.events?.nft?.amount;
    const sol = typeof lamports === 'number' ? lamports / LAMPORTS_PER_SOL : solFromDescription(tx.description);
    return sol != null && sol * LAMPORTS_PER_SOL > MIN_SALE_LAMPORTS;
  }
  return touchesTensor(tx) && largestNativeTransfer(tx) > MIN_SALE_LAMPORTS;
}

// Same shape the gallery already reads: { timestamp (ms), priceSol, source }.
// skulls.html shows anything not starting with MAGICEDEN as Tensor.
function saleFromTx(tx) {
  const lamports = tx.events?.nft?.amount;
  const priceSol =
    (typeof lamports === 'number' && lamports > 0 ? lamports / LAMPORTS_PER_SOL : null) ??
    solFromDescription(tx.description) ??
    (priceFromRoyalty(tx) ?? largestNativeTransfer(tx)) / LAMPORTS_PER_SOL;
  return {
    timestamp: (tx.timestamp ?? 0) * 1000,
    priceSol: +priceSol.toFixed(3),
    source: tx.source === 'MAGIC_EDEN' ? 'MAGICEDEN_V2' : touchesTensor(tx) ? 'TENSOR' : tx.source || null,
  };
}

// Older entries came from Tensor (millisecond timestamps, no signatures), so
// a sale already on file is recognised by time (Helius has whole seconds)
// and price rather than by signature.
function addSales(existing, found) {
  const sales = [...existing];
  for (const s of found) {
    const dup = sales.some((e) => Math.abs(e.timestamp - s.timestamp) < 2000 && Math.abs(e.priceSol - s.priceSol) < 0.01);
    if (!dup) sales.push(s);
  }
  return sales.sort((a, b) => b.timestamp - a.timestamp);
}

// What the newest transactions say about the listing: true/false, or null
// when nothing listing-related happened in the window.
// Tensor Marketplace (TCOMP) listings. Listing a Mad Lad there moves the NFT
// into a Tensor-owned escrow account, and Helius does not always tag the
// transaction NFT_LISTING — #831's listing (16 Oct 2026, 836.99 SOL) came
// through as a plain transfer, so the Skull showed as unlisted and "owned" by
// the escrow account. Reading the instruction itself is unambiguous: Anchor
// discriminator (first 8 bytes) + the ask in lamports (next 8, little-endian).
const TCOMP_PROGRAM_ID = 'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp';
const TCOMP_LIST_DISCRIMINATORS = new Set([
  '066eff121024081e', // list_legacy
  'ad4ca77d76470199', // list_core
  '36aec14311298426', // list
  '41b3da1996736fab', // list_compressed
  '09755de6dd04c7d4', // list_t22
  '17ca668affbe27c4', // list_wns
]);
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str) {
  let n = 0n;
  for (const ch of str) {
    const v = BASE58.indexOf(ch);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let zeros = 0;
  for (const ch of str) {
    if (ch !== '1') break;
    zeros++;
  }
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(n === 0n ? '' : hex, 'hex')]);
}

// { rawAsk, seller } when the tx lists this mint on Tensor, else null.
function tensorListing(tx, mint) {
  const all = [];
  for (const ix of tx.instructions || []) {
    all.push(ix);
    for (const inner of ix.innerInstructions || []) all.push(inner);
  }
  for (const ix of all) {
    if (ix.programId !== TCOMP_PROGRAM_ID || typeof ix.data !== 'string') continue;
    const data = base58Decode(ix.data);
    if (!data || data.length < 16 || !TCOMP_LIST_DISCRIMINATORS.has(data.subarray(0, 8).toString('hex'))) continue;
    const transfer = (tx.tokenTransfers || []).find((tt) => tt.mint === mint);
    return {
      rawAsk: Number(data.readBigUInt64LE(8)) / LAMPORTS_PER_SOL,
      seller: transfer?.fromUserAccount || (ix.accounts || [])[0] || null,
    };
  }
  return null;
}

function listingFromTxs(txs, mint) {
  for (const tx of txs) {
    // newest first
    const tensor = tensorListing(tx, mint);
    if (tensor) return { listed: true, rawAsk: tensor.rawAsk, seller: tensor.seller, market: 'tensor' };
    if (tx.type === 'NFT_LISTING') return { listed: true, rawAsk: solFromDescription(tx.description), market: /TENSOR/.test(tx.source || '') ? 'tensor' : 'me' };
    if (tx.type === 'NFT_CANCEL_LISTING' || isSale(tx, mint) || nftMoved(tx, mint)) return { listed: false, rawAsk: null };
  }
  return null;
}

// Magic Eden resolves a listed Skull back to its real owner (on-chain the
// token sits with the marketplace) and knows its own listings. Optional:
// returns null on any failure and the caller falls back.
async function meToken(mint) {
  try {
    const res = await fetchWithRetry(`${ME_BASE}/tokens/${mint}`, `Magic Eden token ${mint}`);
    if (!res.ok) {
      console.warn(`\nMagic Eden token ${mint}: HTTP ${res.status}`);
      return null;
    }
    const t = await res.json();
    return { owner: t.owner || null, listed: t.listStatus === 'listed', rawAsk: typeof t.price === 'number' ? t.price : null };
  } catch (e) {
    console.warn(`\n${e.message}`);
    return null;
  }
}

async function dasOwner(mint) {
  const res = await fetchWithRetry(HELIUS_RPC, `Helius getAsset ${mint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'skulls', method: 'getAsset', params: { id: mint } }),
  });
  const json = await res.json();
  return json.result?.ownership?.owner || null;
}

function withOwnerTag(entry, ownerTags) {
  const tag = entry.owner ? ownerTags[entry.owner] : null;
  return {
    ...entry,
    twitter: tag?.twitter || null,
    label: tag?.label || null,
    tagText: tag?.tag || null,
    tagColor: tag?.tagColor || null,
    tagOnly: !!tag?.tagOnly,
    twitterUrl: tag?.twitterUrl || (tag?.twitter ? `https://x.com/${tag.twitter}` : null),
  };
}

// Cheap "did anything happen?" check, so the script can run hourly on the free
// Helius plan. Reading a Skull's parsed history costs 100 credits (Enhanced
// Transactions); asking the RPC for its newest signature costs 1. Selling,
// listing, delisting and transferring all touch the mint, so a Skull whose
// newest successful signature is older than its last sync has nothing new and
// is skipped. Returns true when the Skull needs the full (100-credit) read —
// including whenever this check itself fails, so an error never hides a sale.
const QUICK_CHECK_MARGIN_MS = 5 * 60 * 1000;
const FULL_SYNC = process.env.FULL_SYNC === '1';

async function hasNewActivity(mint, syncedAt) {
  try {
    const res = await fetchWithRetry(HELIUS_RPC, `Helius getSignaturesForAddress ${mint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'skulls', method: 'getSignaturesForAddress', params: [mint, { limit: 10 }] }),
    }, 3);
    const json = await res.json();
    if (!res.ok || !Array.isArray(json.result)) return true;
    const newest = json.result.find((sig) => !sig.err && sig.blockTime);
    if (!newest) return json.result.length > 0; // only failed/untimed txs: be safe
    return newest.blockTime * 1000 > syncedAt - QUICK_CHECK_MARGIN_MS;
  } catch (e) {
    return true;
  }
}

async function updateSkull(prev, defaultSyncedAt, startedAt) {
  const mint = prev.mint;
  const syncedAt = prev.syncedAt ?? defaultSyncedAt;
  const txs = await heliusTransactionsSince(mint, syncedAt - SYNC_OVERLAP_MS);

  const sales = addSales(prev.sales || [], txs.filter((tx) => isSale(tx, mint)).map(saleFromTx));
  let { owner, listed, listPrice, listMarket } = prev;

  const moved = txs.some((tx) => nftMoved(tx, mint));
  const fromTxs = listingFromTxs(txs, mint);
  if (fromTxs || moved) {
    const me = await meToken(mint);
    const asks = [];
    if (fromTxs?.listed && fromTxs.rawAsk != null) asks.push({ ask: fromTxs.rawAsk, market: fromTxs.market || null });
    if (me?.listed && me.rawAsk != null) asks.push({ ask: me.rawAsk, market: 'me' });
    if (fromTxs) {
      listed = asks.length > 0 || !!me?.listed || fromTxs.listed;
      const best = asks.reduce((a, b) => (!a || b.ask < a.ask ? b : a), null);
      listPrice = best ? +(best.ask * BUYER_TOTAL_MULTIPLIER).toFixed(4) : listed ? listPrice : null;
      listMarket = best ? best.market : listed ? (listMarket || (me?.listed ? 'me' : fromTxs.market || null)) : null;
    }
    // A Tensor listing parks the NFT in escrow, which Magic Eden and DAS both
    // report as the "owner" — the seller named in the listing is the real one.
    if (fromTxs?.seller) owner = fromTxs.seller;
    else if (me?.owner) owner = me.owner;
    else if (moved && !listed) owner = (await dasOwner(mint)) || owner;
    // A listed Skull's on-chain holder is the marketplace, so without Magic
    // Eden the previous owner is the better guess.
  }
  // Listed before listMarket existed: ask Magic Eden once. Listed there → 'me';
  // listed but not on Magic Eden → it can only be Tensor.
  if (listed && !listMarket) {
    const me = await meToken(mint);
    if (me) listMarket = me.listed ? 'me' : 'tensor';
  }

  return {
    ...prev,
    owner,
    trades: sales.length,
    lastSalePrice: sales.find((s) => s.priceSol != null)?.priceSol ?? null,
    sales,
    neverTraded: sales.length === 0,
    listed: !!listed,
    listPrice: listed ? listPrice : null,
    // 'me' | 'tensor' | null. Skulls listed before this field existed get it on
    // their next listing change; until then the page shows no marketplace.
    listMarket: listed ? (listMarket || null) : null,
    syncedAt: startedAt,
    newTxs: txs.length,
  };
}

// Mad Lads #1792, verified against tensor.trade: 2023 ME buy-now 324.69 SOL,
// 2026 ME bid-accept 49, 2026 Tensor buy-now 47.07, 2026 ME buy-now 37.6.
// DEBUG_ONLY_TARGET=1 re-reads its whole history and prints what the
// classifier finds next to what's on file, without writing anything.
const DEBUG_MINT = 'HmfpmjsYGnBfY6qpSHZbU28aiWYP34t5VB78HQLougtx';
const DEBUG_ONLY_TARGET = process.env.DEBUG_ONLY_TARGET === '1';

async function main() {
  const startedAt = Date.now();
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const skulls = data.skulls || [];
  if (skulls.length !== 99) throw new Error(`skulls-data.json has ${skulls.length} Skulls, expected 99 — refusing to continue.`);
  const defaultSyncedAt = Date.parse(data.generatedAt);
  const ownerTags = loadOwnerTags();

  if (DEBUG_ONLY_TARGET) {
    const prev = skulls.find((s) => s.mint === DEBUG_MINT);
    const fresh = await updateSkull({ ...prev, sales: [], syncedAt: 0 }, 0, startedAt);
    console.log(`DEBUG ${DEBUG_MINT}: ${fresh.newTxs} txs in full history`);
    console.log('Sales found now:', JSON.stringify(fresh.sales, null, 1));
    console.log('Sales on file:  ', JSON.stringify(prev.sales, null, 1));
    // Anything on-chain around each sale on file, to see how Helius described it.
    const all = await heliusTransactionsSince(DEBUG_MINT, 0);
    for (const s of prev.sales) {
      for (const tx of all.filter((t) => Math.abs(t.timestamp * 1000 - s.timestamp) < 120_000)) {
        console.log(
          `  near ${s.priceSol} SOL sale: type=${tx.type} source=${tx.source} nftMoved=${nftMoved(tx, DEBUG_MINT)} ` +
            `maxNative=${largestNativeTransfer(tx) / LAMPORTS_PER_SOL} eventAmount=${tx.events?.nft?.amount} desc=${JSON.stringify(tx.description)}`
        );
      }
    }
    console.log(`Owner now ${fresh.owner}, on file ${prev.owner}; listed now ${fresh.listed} (${fresh.listPrice}), on file ${prev.listed} (${prev.listPrice})`);
    const incremental = await updateSkull(prev, defaultSyncedAt, startedAt);
    console.log(`Incremental run since ${data.generatedAt}: ${incremental.newTxs} new txs, trades ${prev.trades} -> ${incremental.trades}`);
    console.log('Not writing skulls-data.json (debug run).');
    return;
  }

  const results = [];
  let failed = 0;
  let changed = 0;
  let skipped = 0;
  for (const [i, prev] of skulls.entries()) {
    let next;
    try {
      // Hourly runs only pay for the full read when the 1-credit check sees
      // something new. The daily FULL_SYNC run reads every Skull regardless,
      // as a safety net for anything the quick check could miss.
      if (!FULL_SYNC && !(await hasNewActivity(prev.mint, prev.syncedAt ?? defaultSyncedAt))) {
        skipped++;
        results.push(withOwnerTag(prev, ownerTags));
        process.stdout.write(`\r[${i + 1}/${skulls.length}] done...`);
        await sleep(100);
        continue;
      }
      next = await updateSkull(prev, defaultSyncedAt, startedAt);
      if (next.newTxs > 0) changed++;
    } catch (e) {
      failed++;
      console.warn(`\nKeeping previous data for #${prev.num} (${prev.mint}): ${e.message}`);
      next = prev;
    }
    const { newTxs, ...entry } = next;
    results.push(withOwnerTag(entry, ownerTags));
    process.stdout.write(`\r[${i + 1}/${skulls.length}] done...`);
    await sleep(250);
  }

  console.log(`\n${FULL_SYNC ? 'Full sync' : 'Quick sync'}: ${skipped} Skulls skipped (no new activity), ${changed} had new transactions, ${failed} failed and kept their previous data.`);
  // Every Skull failing means the source itself is broken (bad key, API
  // gone) — fail loudly so the workflow goes red instead of quietly freezing.
  if (failed === skulls.length) throw new Error('Every Skull failed to update — check HELIUS_API_KEY and the Helius API.');

  results.sort((a, b) => (a.num ?? 0) - (b.num ?? 0));

  // Every commit to main is a Netlify production deploy, which costs credits.
  // Only rewrite the file when something visible changed; leaving syncedAt
  // behind on quiet nights is free, since the next run's Helius call still
  // stops at the first already-known transaction.
  //
  // Exception: a quick sync that paid for full reads must save the new
  // syncedAt even when nothing visible changed. Bids placed on individual
  // Skulls are on-chain transactions that touch the mint without changing
  // anything we show; if syncedAt stayed behind, every later hourly run would
  // see the same bids as "new" and pay 100 credits per Skull again.
  const visible = (list) => JSON.stringify(list.map(({ syncedAt, ...rest }) => rest));
  const nothingVisible = visible(results) === visible([...skulls].sort((a, b) => (a.num ?? 0) - (b.num ?? 0)));
  const fullReads = skulls.length - skipped - failed;
  if (nothingVisible && (FULL_SYNC || fullReads === 0)) {
    console.log('Nothing changed — leaving skulls-data.json as it is.');
    return;
  }
  if (nothingVisible) console.log(`Nothing visible changed, but ${fullReads} Skulls were re-read — saving their sync time so the next quick sync skips them.`);

  fs.writeFileSync(DATA_FILE, JSON.stringify({ generatedAt: new Date(startedAt).toISOString(), skulls: results }, null, 2));
  console.log('Wrote skulls-data.json — safe to commit (no API key inside).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
