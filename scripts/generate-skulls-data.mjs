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

async function reverseSolDomain(owner) {
  try {
    const res = await fetch(`https://sns-api.bonfida.com/owners/${owner}/domains`);
    if (!res.ok) return null;
    const json = await res.json();
    const domains = json?.result || [];
    return domains.length ? `${domains[0]}.sol` : null;
  } catch {
    return null;
  }
}

async function meTokenData(mint) {
  const [listingRes, activityRes] = await Promise.all([
    fetch(`${ME_BASE}/tokens/${mint}`),
    fetch(`${ME_BASE}/tokens/${mint}/activities`),
  ]);
  const listing = listingRes.ok ? await listingRes.json() : null;
  const activities = activityRes.ok ? await activityRes.json() : [];
  const sales = (activities || []).filter((a) => a.type === 'buyNow' || a.type === 'sale' || a.type === 'acceptBid');
  const trades = sales.length;
  const lastSale = sales.length ? sales[0] : null;
  return {
    listed: !!listing?.price,
    listPrice: listing?.price ?? null,
    trades,
    lastSalePrice: lastSale ? lastSale.price : null,
  };
}

const CONCURRENCY = 8;

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
    const owner = asset.ownership?.owner || null;
    const num = extractNumber(asset);

    let market = { listed: false, listPrice: null, trades: 0, lastSalePrice: null };
    try {
      market = await meTokenData(mint);
    } catch (e) {
      console.warn(`\nMagic Eden fetch failed for ${mint}: ${e.message}`);
    }

    const domain = owner ? await reverseSolDomain(owner) : null;

    return {
      num,
      mint,
      owner: domain || owner,
      isDomain: !!domain,
      trades: market.trades,
      lastSalePrice: market.lastSalePrice,
      neverTraded: market.trades === 0,
      listed: market.listed,
      listPrice: market.listPrice,
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
