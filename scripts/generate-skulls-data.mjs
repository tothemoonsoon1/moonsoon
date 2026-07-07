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

let debugLogged = 0;

async function meTokenData(mint) {
  const listingRes = await fetchWithRetry(`${ME_BASE}/tokens/${mint}`, `ME listing for ${mint}`);
  const activityRes = await fetchWithRetry(
    `${ME_BASE}/tokens/${mint}/activities?offset=0&limit=100`,
    `ME activities for ${mint}`
  );

  if (!listingRes.ok) console.warn(`\nME listing for ${mint} returned ${listingRes.status}`);
  if (!activityRes.ok) console.warn(`\nME activities for ${mint} returned ${activityRes.status}`);

  const listing = listingRes.ok ? await listingRes.json() : null;
  const activities = activityRes.ok ? await activityRes.json() : [];

  if (debugLogged < 5) {
    debugLogged++;
    const types = [...new Set((activities || []).map((a) => a.type))];
    console.log(
      `\n[debug] ${mint} listStatus=${listing?.listStatus} price=${listing?.price} activities.length=${(activities || []).length} types=${JSON.stringify(types)}`
    );
  }

  const sales = (activities || []).filter((a) => a.type === 'buyNow' || a.type === 'sale' || a.type === 'acceptBid');
  const trades = sales.length;
  const lastSale = sales.length ? sales[0] : null;
  return {
    listed: listing?.listStatus === 'listed',
    listPrice: listing?.price ?? null,
    trades,
    lastSalePrice: lastSale ? lastSale.price : null,
  };
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
    const owner = asset.ownership?.owner || null;
    const num = extractNumber(asset);

    let market = { listed: false, listPrice: null, trades: 0, lastSalePrice: null };
    try {
      market = await meTokenData(mint);
    } catch (e) {
      console.warn(`\nMagic Eden fetch failed for ${mint}: ${e.message}`);
    }

    let domain = null;
    try {
      domain = owner ? await reverseSolDomain(owner) : null;
    } catch (e) {
      console.warn(`\nSNS lookup failed for ${owner}: ${e.message}`);
    }

    await sleep(250); // stagger requests to stay under ME rate limits

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
