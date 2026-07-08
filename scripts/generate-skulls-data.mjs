#!/usr/bin/env node
/**
 * Generates skulls-data.json from real on-chain + marketplace data.
 * Run with a Helius key in HELIUS_API_KEY, either locally:
 *
 *   HELIUS_API_KEY=xxxxxxxx node scripts/generate-skulls-data.mjs
 *
 * or via the scheduled GitHub Actions workflow (.github/workflows/update-skulls.yml),
 * which reads the key from a repo secret and never prints or commits it.
 *
 * Output: skulls-data.json in the repo root — safe to commit, contains
 * no API key, only public NFT data (owner, trades, prices, listings).
 */

const HELIUS_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_KEY) {
  console.error('Missing HELIUS_API_KEY env var. Usage: HELIUS_API_KEY=xxx node scripts/generate-skulls-data.mjs');
  process.exit(1);
}

const MAD_LADS_COLLECTION = 'J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w';
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const ME_BASE = 'https://api-mainnet.magiceden.dev/v2';

async function heliusRpc(method, params) {
  const res = await fetch(HELIUS_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'skulls', method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Helius ${method} error: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function fetchAllCollectionAssets() {
  let page = 1;
  const all = [];
  while (true) {
    const result = await heliusRpc('getAssetsByGroup', {
      groupKey: 'collection',
      groupValue: MAD_LADS_COLLECTION,
      page,
      limit: 1000,
    });
    all.push(...result.items);
    if (result.items.length < 1000) break;
    page++;
  }
  return all;
}

function skullTraitInfo(asset) {
  const attrs = asset.content?.metadata?.attributes || [];
  return attrs.find((a) => String(a.value).toLowerCase() === 'skull') || null;
}

function extractNumber(asset) {
  const name = asset.content?.metadata?.name || '';
  const match = name.match(/#(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Fetches with retry+backoff on 429/5xx. Logs (and eventually throws) real
// failures instead of letting callers silently treat them as "no data".
async function fetchWithRetry(url, label, attempts = 4) {
  let lastStatus = null;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url);
    if (res.ok) return res;
    lastStatus = res.status;
    if (res.status !== 429 && res.status < 500) return res; // real 4xx, don't retry
    await sleep(400 * Math.pow(2, i)); // 400ms, 800ms, 1600ms, 3200ms
  }
  throw new Error(`${label} failed after ${attempts} attempts, last status ${lastStatus}`);
}

// sns-api.bonfida.com/owners/{owner}/domains currently 500s on every request
// (confirmed across 99/99 lookups in a real run) — looks dead/moved. Disabled
// until we find a working reverse-lookup source; owners fall back to the raw
// wallet address (shortened) in skulls.html.
async function reverseSolDomain() {
  return null;
}

let meDebugLogged = 0;
let salesDebugLogged = 0;

// Only used for listing status/price/image now — trade history comes from
// Helius (see heliusNftSales) since ME's own activities endpoint only
// returns marketplace-local events (bid/cancelBid), missing actual sales.
async function meListingData(mint) {
  const listingRes = await fetchWithRetry(`${ME_BASE}/tokens/${mint}`, `ME listing for ${mint}`);
  if (!listingRes.ok) console.warn(`\nME listing for ${mint} returned ${listingRes.status}`);
  const listing = listingRes.ok ? await listingRes.json() : null;

  if (meDebugLogged < 3) {
    meDebugLogged++;
    console.log(`\n[debug-me] ${mint} listStatus=${listing?.listStatus} price=${listing?.price}`);
  }

  return {
    listed: listing?.listStatus === 'listed',
    listPrice: listing?.price ?? null,
    image: listing?.image ?? null,
    // ME resolves listed items back to the actual seller. Helius's DAS
    // ownership.owner instead reports the on-chain token account holder,
    // which for a listed item is the marketplace's escrow/vault PDA — not
    // the human owner. Prefer ME's when we have it.
    owner: listing?.owner ?? null,
  };
}

const LAMPORTS_PER_SOL = 1_000_000_000;

// Helius Enhanced Transactions (v0, deprecated but still live on free tier;
// the newer getTransactionsForAddress RPC method needs a paid plan).
// Returns on-chain NFT_SALE events for this mint across ALL marketplaces
// (Magic Eden, Tensor, OTC, etc.) — not just Magic Eden's own activity feed.
// Parses "...for 37.6 SOL on MAGIC_EDEN." out of Helius's human-readable
// description — more robust than relying on an exact events.nft.amount shape
// we haven't fully confirmed, and works even if that field is ever renamed.
function parseSolPriceFromDescription(description) {
  const match = String(description || '').match(/for ([\d.]+) SOL/);
  return match ? parseFloat(match[1]) : null;
}

const HELIUS_TX_PAGE_LIMIT = 100;
const HELIUS_TX_MAX_PAGES = 10; // safety cap: 1000 events per mint is plenty

// Fetches every page of v0/addresses/{mint}/transactions, optionally
// filtered by `type`. Shared paging logic for both heliusNftSales (type
// restricted to NFT_SALE) and tensorProgramSales (unfiltered, since Tensor
// AMM/Marketplace pool trades aren't always tagged NFT_SALE by Helius).
async function heliusAddressTransactions(mint, { type, label } = {}) {
  const allTxs = [];
  let before = null;

  for (let page = 0; page < HELIUS_TX_MAX_PAGES; page++) {
    const url =
      `https://api-mainnet.helius-rpc.com/v0/addresses/${mint}/transactions` +
      `?api-key=${HELIUS_KEY}&limit=${HELIUS_TX_PAGE_LIMIT}` +
      (type ? `&type=${type}` : '') +
      (before ? `&before=${before}` : '');
    const res = await fetchWithRetry(url, `${label} for ${mint} (page ${page})`);

    // Helius returns 404 (not an empty array) when an address has zero
    // matching transactions — normal "never sold" case, not a real failure.
    if (res.status === 404) break;
    if (!res.ok) {
      console.warn(`\n${label} for ${mint} returned ${res.status}`);
      break;
    }

    const pageTxs = await res.json();
    if (!Array.isArray(pageTxs) || pageTxs.length === 0) break;
    allTxs.push(...pageTxs);
    if (pageTxs.length < HELIUS_TX_PAGE_LIMIT) break; // last page
    before = pageTxs[pageTxs.length - 1]?.signature;
    if (!before) break;
  }

  return allTxs;
}

function saleFromTx(tx) {
  const lamports = tx?.events?.nft?.amount;
  const priceSol =
    typeof lamports === 'number'
      ? +(lamports / LAMPORTS_PER_SOL).toFixed(3)
      : parseSolPriceFromDescription(tx?.description);
  return { signature: tx.signature, timestamp: tx.timestamp ?? 0, priceSol };
}

// Trade history straight from Helius's own NFT_SALE classification — catches
// Magic Eden and any marketplace Helius tags correctly.
async function heliusNftSales(mint) {
  const allTxs = await heliusAddressTransactions(mint, { type: 'NFT_SALE', label: 'Helius NFT_SALE' });

  if (salesDebugLogged < 3) {
    salesDebugLogged++;
    console.log(`\n[debug-sales] ${mint} pages fetched, total raw=${allTxs.length} raw=${JSON.stringify(allTxs)}`);
  }

  return allTxs.filter((t) => t.type === 'NFT_SALE').map(saleFromTx);
}

// Tensor migrated its on-chain program over time (see
// https://dev.tensor.trade/docs/program-changes): the legacy TSWAP program
// only handles shared-escrow now, while pool trades and marketplace
// listings/bids moved to two newer programs. Helius's NFT_SALE classifier
// doesn't reliably tag trades routed through these — e.g. Mad Lads #1792
// shows 4 sales on tensor.trade but only 1 came back as NFT_SALE from
// Helius. So instead of trusting Helius's `type` field, we pull ALL
// transactions touching the mint and self-classify: any tx that (a) touches
// a known Tensor program and (b) actually moves both the NFT and SOL is a
// sale, regardless of what Helius labeled it.
const TENSOR_PROGRAM_IDS = new Set([
  'TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN', // legacy TSWAP (shared escrow only, going forward)
  'TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg', // AMM (liquidity pools)
  'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp', // Marketplace (listings/bids) + Escrow
]);

let tensorDebugLogged = 0;

function txProgramIds(tx) {
  const ids = new Set();
  for (const ix of tx.instructions || []) {
    if (ix.programId) ids.add(ix.programId);
    for (const inner of ix.innerInstructions || []) {
      if (inner.programId) ids.add(inner.programId);
    }
  }
  return ids;
}

async function tensorProgramSales(mint) {
  const allTxs = await heliusAddressTransactions(mint, { label: 'Helius all-txs (Tensor scan)' });

  const tensorTxs = allTxs.filter((t) => {
    const ids = txProgramIds(t);
    for (const id of ids) if (TENSOR_PROGRAM_IDS.has(id)) return true;
    return false;
  });

  if (tensorDebugLogged < 3) {
    tensorDebugLogged++;
    console.log(`\n[debug-tensor] ${mint} tensor-program txs=${tensorTxs.length} raw=${JSON.stringify(tensorTxs)}`);
  }

  // A sale actually moves the NFT (tokenTransfers) and SOL (nativeTransfers)
  // in the same transaction — excludes listings, delistings, and bid
  // placement/cancellation, which touch a Tensor program but move neither.
  const sales = tensorTxs.filter((t) => {
    const nftMoved = (t.tokenTransfers || []).some((tt) => tt.mint === mint);
    const solMoved = (t.nativeTransfers || []).some((nt) => nt.amount > 0);
    return nftMoved && solMoved;
  });

  return sales.map(saleFromTx);
}

// Combines sales from both sources, de-duplicating by transaction signature
// so a trade Helius *and* our Tensor scan both catch doesn't get double-counted.
function mergeSales(saleArrays) {
  const bySignature = new Map();
  for (const sale of saleArrays.flat()) {
    if (sale.signature) bySignature.set(sale.signature, sale);
  }
  const sales = [...bySignature.values()].sort((a, b) => b.timestamp - a.timestamp);
  return { trades: sales.length, lastSalePrice: sales[0]?.priceSol ?? null };
}

const CONCURRENCY = 2;

// Runs `worker` over `items` with at most CONCURRENCY in flight at once.
async function mapWithConcurrency(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
      done++;
      process.stdout.write(`\r[${done}/${items.length}] done...`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, runner));
  return results;
}

async function main() {
  console.log('Fetching Mad Lads collection assets from Helius...');
  const assets = await fetchAllCollectionAssets();
  console.log(`Fetched ${assets.length} assets. Filtering for "Skull" trait...`);

  const skullAssets = assets.filter(skullTraitInfo);
  console.log(`Found ${skullAssets.length} Skulls.`);
  if (skullAssets.length !== 99) {
    console.warn(`Warning: expected 99 Skulls, found ${skullAssets.length}. Check trait filter logic.`);
  }

  const results = await mapWithConcurrency(skullAssets, async (asset) => {
    const mint = asset.id;
    const heliusOwner = asset.ownership?.owner || null;
    const num = extractNumber(asset);

    let listing = { listed: false, listPrice: null, image: null, owner: null };
    try {
      listing = await meListingData(mint);
    } catch (e) {
      console.warn(`\nMagic Eden fetch failed for ${mint}: ${e.message}`);
    }

    // Helius's token-account owner is the marketplace escrow PDA for listed
    // items — use ME's resolved seller when we have it.
    const owner = listing.owner || heliusOwner;

    let heliusSales = [];
    try {
      heliusSales = await heliusNftSales(mint);
    } catch (e) {
      console.warn(`\nHelius sales fetch failed for ${mint}: ${e.message}`);
    }

    let tensorSales = [];
    try {
      tensorSales = await tensorProgramSales(mint);
    } catch (e) {
      console.warn(`\nTensor program scan failed for ${mint}: ${e.message}`);
    }

    const sales = mergeSales([heliusSales, tensorSales]);

    let domain = null;
    try {
      domain = owner ? await reverseSolDomain(owner) : null;
    } catch (e) {
      console.warn(`\nSNS lookup failed for ${owner}: ${e.message}`);
    }

    await sleep(400); // stagger requests to stay under rate limits (now 3 fetches/mint)

    return {
      num,
      mint,
      owner: domain || owner,
      isDomain: !!domain,
      trades: sales.trades,
      lastSalePrice: sales.lastSalePrice,
      neverTraded: sales.trades === 0,
      listed: listing.listed,
      listPrice: listing.listPrice,
      image: listing.image,
      meUrl: `https://magiceden.io/item-details/${mint}`,
    };
  });

  console.log('\nDone. Writing skulls-data.json...');
  results.sort((a, b) => (a.num ?? 0) - (b.num ?? 0));

  const fs = await import('node:fs');
  fs.writeFileSync(
    new URL('../skulls-data.json', import.meta.url),
    JSON.stringify({ generatedAt: new Date().toISOString(), skulls: results }, null, 2)
  );
  console.log('Wrote skulls-data.json — safe to commit (no API key inside).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
