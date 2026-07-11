#!/usr/bin/env node
/**
 * Generates skulls-data.json from real on-chain + marketplace data.
 * Run locally:
 *
 *   node scripts/generate-skulls-data.mjs
 *
 * or via the scheduled GitHub Actions workflow
 * (.github/workflows/update-skulls.yml).
 *
 * Everything — the 99-mint collection listing, per-mint trade history,
 * listing price, owner, and image — comes from graphql.tensor.trade, the
 * same undocumented GraphQL endpoint tensor.trade's own frontend calls (no
 * API key required, discovered via its validation-error messages since
 * introspection is disabled in production). No Helius key needed at all.
 * Tensor's indexer aggregates sales across ALL marketplaces (Magic Eden,
 * Tensor) with proper classification (buy-now vs bid-accept), which is both
 * more accurate and free compared to parsing raw Solana transactions
 * ourselves through a paid RPC provider.
 *
 * Known risk: this is not an officially published API, so it could change
 * or start blocking scripted traffic without notice — if this stops
 * working, the previous Helius-RPC-based approach is in git history (see
 * the commit that introduced this file). It has also been observed
 * silently returning partial/incomplete results on rare occasions (retried
 * against in tensorMintData below), and occasional transient
 * search_phase_execution_exception errors (retried in tensorGraphql).
 *
 * Output: skulls-data.json in the repo root — safe to commit, contains no
 * API key, only public NFT data (owner, trades, prices, listings).
 */

const MAD_LADS_COLLECTION_SLUG = 'bd366797-5599-417a-be03-1e43a7e3fb90';
const TENSOR_GRAPHQL = 'https://graphql.tensor.trade/graphql';

// Wallet -> X handle tags (owner-tags.json, hand-maintained). Looked up by the
// CURRENT owner on every run, so a tag automatically follows a Skull to its
// new owner (or disappears) when it's sold — no manual re-tagging needed.
async function loadOwnerTags() {
  const fs = await import('node:fs');
  try {
    const raw = fs.readFileSync(new URL('../owner-tags.json', import.meta.url), 'utf8');
    return JSON.parse(raw).wallets || {};
  } catch (e) {
    console.warn(`Could not read owner-tags.json, continuing without tags: ${e.message}`);
    return {};
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Fetches with retry+backoff on 429/5xx. Logs (and eventually throws) real
// failures instead of letting callers silently treat them as "no data".
// Transport-level failures (DNS, connection reset, timeout) make fetch()
// itself reject rather than resolve with a non-ok response — a full 99-skull
// run hit 7 of these ("fetch failed") and, uncaught, they skipped retry
// entirely and produced empty (owner: null, trades: 0) entries. Catch and
// retry those the same as a 5xx.
async function fetchWithRetry(url, label, attempts = 6, init = undefined) {
  let lastStatus = null;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      lastStatus = res.status;
      if (res.status !== 429 && res.status < 500) return res; // real 4xx, don't retry
    } catch (e) {
      lastErr = e;
    }
    await sleep(500 * Math.pow(2, i)); // 500ms, 1s, 2s, 4s, 8s, 16s
  }
  throw new Error(
    `${label} failed after ${attempts} attempts, last status ${lastStatus}${lastErr ? `, last error: ${lastErr.message}` : ''}`
  );
}

// sns-api.bonfida.com/owners/{owner}/domains currently 500s on every request
// (confirmed across 99/99 lookups in a real run) — looks dead/moved. Disabled
// until we find a working reverse-lookup source; owners fall back to the raw
// wallet address (shortened) in skulls.html.
async function reverseSolDomain() {
  return null;
}

const LAMPORTS_PER_SOL = 1_000_000_000;

// Headers matter here — without an Origin/Referer matching tensor.trade the
// endpoint 403s (confirmed while probing it).
const TENSOR_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  Origin: 'https://www.tensor.trade',
  Referer: 'https://www.tensor.trade/',
  'Content-Type': 'application/json',
};

// GraphQL errors (e.g. their search cluster's transient
// "search_phase_execution_exception") come back as HTTP 200 with an
// `errors` array — fetchWithRetry only looks at HTTP status, so those never
// get retried there. Retry them here too, separately from transport-level
// failures.
async function tensorGraphql(query, variables, label, attempts = 4) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(500 * Math.pow(2, i));
    const res = await fetchWithRetry(TENSOR_GRAPHQL, label, 6, {
      method: 'POST',
      headers: TENSOR_HEADERS,
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (!json.errors) return json.data;
    lastErr = json.errors;
  }
  throw new Error(`Tensor GraphQL ${label} error after ${attempts} attempts: ${JSON.stringify(lastErr)}`);
}

// One request gets mint metadata (name/image/owner/current listing) plus the
// first page (up to 88) of the mint's full transaction history, newest
// first. Field names below were reverse-engineered from GraphQL validation
// error messages (introspection is disabled in prod) — see the header
// comment for the risk tradeoff.
const MINT_AND_TXS_QUERY = `
  query MintAndTxs($mint: String!) {
    mint(mint: $mint) {
      name
      imageUri
      owner
      activeListings { tx { txType grossAmount txAt } }
    }
    mintTransactions(mint: $mint) {
      page { hasMore endCursor { txAt txKey } }
      txs { tx { txType grossAmount txAt source } }
    }
  }
`;

const MORE_TXS_QUERY = `
  query MoreTxs($mint: String!, $cursor: TransactionsCursorInput!) {
    mintTransactions(mint: $mint, cursor: $cursor) {
      page { hasMore endCursor { txAt txKey } }
      txs { tx { txType grossAmount txAt source } }
    }
  }
`;

// Enumerates the whole ~9970-mint collection (250/page) to find the 99 with
// a "Skull" trait value — same client-side filter the old Helius DAS-based
// version used, just against a different source of the same public
// metadata. Runs once per script invocation, not once per mint.
const COLLECTION_MINTS_QUERY = `
  query CollectionMints($slug: String!, $cursor: String) {
    collectionMintsV2(slug: $slug, sortBy: LastSaleDesc, cursor: $cursor) {
      page { hasMore endCursor }
      mints { mint { onchainId name attributes { trait_type value } } }
    }
  }
`;

async function fetchAllCollectionMints() {
  const all = [];
  let cursor = null;
  while (true) {
    const data = await tensorGraphql(COLLECTION_MINTS_QUERY, { slug: MAD_LADS_COLLECTION_SLUG, cursor }, 'collection mints page');
    all.push(...data.collectionMintsV2.mints.map((m) => m.mint));
    if (!data.collectionMintsV2.page.hasMore) break;
    cursor = data.collectionMintsV2.page.endCursor;
    await sleep(150);
  }
  return all;
}

function skullTraitInfo(mint) {
  const attrs = mint.attributes || [];
  return attrs.find((a) => String(a.value).toLowerCase() === 'skull') || null;
}

function extractNumber(mint) {
  const match = (mint.name || '').match(/#(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

const TX_PAGE_MAX = 20; // 20 * 88 ~= 1760 tx safety cap per mint

// Sale-representing txType values seen so far: SALE_BUY_NOW (instant buy),
// SALE_ACCEPT_BID (seller accepts a standing bid). Matched by prefix so any
// other SALE_* variant Tensor adds later is still caught.
function isSaleTx(tx) {
  return typeof tx.txType === 'string' && tx.txType.startsWith('SALE_');
}

// Single, un-retried fetch of a mint's full tx history + listing state.
async function tensorMintDataOnce(mint) {
  let data = await tensorGraphql(MINT_AND_TXS_QUERY, { mint }, `mint+txs for ${mint}`);
  const allTxs = data.mintTransactions.txs.map((t) => t.tx);
  let page = data.mintTransactions.page;

  for (let i = 0; i < TX_PAGE_MAX && page.hasMore; i++) {
    await sleep(200);
    const more = await tensorGraphql(
      MORE_TXS_QUERY,
      { mint, cursor: { txAt: page.endCursor.txAt, txKey: page.endCursor.txKey } },
      `more txs for ${mint} (page ${i + 2})`
    );
    allTxs.push(...more.mintTransactions.txs.map((t) => t.tx));
    page = more.mintTransactions.page;
  }

  const sales = allTxs
    .filter(isSaleTx)
    .map((tx) => ({ timestamp: tx.txAt, priceSol: +(Number(tx.grossAmount) / LAMPORTS_PER_SOL).toFixed(3) }))
    .sort((a, b) => b.timestamp - a.timestamp);

  // A mint can carry more than one active LIST entry (relisted, or listed via
  // more than one front-end pointing at the same underlying listing) — take
  // the cheapest raw ask.
  const listings = (data.mint.activeListings || [])
    .map((l) => l.tx)
    .filter((tx) => tx.txType === 'LIST')
    .map((tx) => Number(tx.grossAmount) / LAMPORTS_PER_SOL);
  const rawAskPrice = listings.length ? Math.min(...listings) : null;

  return {
    name: data.mint.name,
    image: data.mint.imageUri,
    owner: data.mint.owner,
    trades: sales.length,
    lastSalePrice: sales[0]?.priceSol ?? null,
    listed: rawAskPrice != null,
    rawAskPrice,
    totalTxs: allTxs.length,
  };
}

const STABILITY_MAX_ATTEMPTS = 4;

// This undocumented endpoint has been observed silently returning a partial
// transaction list (no error, no hasMore flag, just fewer rows than a repeat
// query for the identical mint) — verified on Mad Lads #1792: one fetch
// reported trades=1/57 total txs, the very next one 4/92. Re-fetch until two
// consecutive attempts agree on trade count, and keep the one with the most
// total txs seen if we run out of attempts, rather than silently shipping a
// possibly-truncated result the way the raw endpoint would.
//
// The same endpoint has also been observed returning a stale/wrong `owner`
// for a mint on an isolated fetch (Mad Lads #3306: one fetch returned a
// wallet that never appears anywhere in the mint's own — empty — trade
// history, while every other fetch and tensor.trade's own live page agreed
// on a different owner). Trade-count stability alone doesn't catch this
// since owner and trades come from the same response but can independently
// glitch. Track owner across attempts too and go with whichever owner value
// a majority of attempts agree on, rather than trusting a single response.
async function tensorMintData(mint) {
  let best = null;
  let prevTrades = null;
  let stableTrades = null;
  const ownerVotes = new Map();
  for (let attempt = 0; attempt < STABILITY_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(400);
    const result = await tensorMintDataOnce(mint);
    if (!best || result.totalTxs > best.totalTxs) best = result;
    if (result.owner) ownerVotes.set(result.owner, (ownerVotes.get(result.owner) || 0) + 1);
    if (stableTrades === null && prevTrades !== null && result.trades === prevTrades) stableTrades = result.trades;
    prevTrades = result.trades;
    if (stableTrades !== null && ownerVotes.size === 1) break;
  }
  if (stableTrades === null) {
    console.warn(`\nTensor trade count for ${mint} never stabilized after ${STABILITY_MAX_ATTEMPTS} attempts — using the most complete fetch (${best.totalTxs} txs).`);
  }
  let ownerConsensus = best.owner;
  if (ownerVotes.size > 1) {
    const sorted = [...ownerVotes.entries()].sort((a, b) => b[1] - a[1]);
    ownerConsensus = sorted[0][0];
    console.warn(`\nTensor owner for ${mint} disagreed across attempts (${JSON.stringify(Object.fromEntries(ownerVotes))}) — using majority-agreed owner ${ownerConsensus}.`);
  }
  return { ...best, owner: ownerConsensus };
}

const CONCURRENCY = 1;

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

// Mint used to sanity-check this pipeline (Mad Lads #1792): 4 real sales —
// 2023 Magic Eden buy-now 324.69 SOL, 2026 Magic Eden bid-accept 49 SOL,
// 2026 Tensor buy-now 47.07 SOL, 2026 Magic Eden buy-now 37.6 SOL — verified
// against tensor.trade's own Sale History chart and Activity tab. Set
// DEBUG_ONLY_TARGET=1 to re-verify without a full 99-skull run.
const DEBUG_MINT = 'HmfpmjsYGnBfY6qpSHZbU28aiWYP34t5VB78HQLougtx';
const DEBUG_ONLY_TARGET = process.env.DEBUG_ONLY_TARGET === '1';

async function main() {
  const ownerTags = await loadOwnerTags();
  console.log('Fetching Mad Lads collection mints from Tensor...');
  const mints = await fetchAllCollectionMints();
  console.log(`Fetched ${mints.length} mints. Filtering for "Skull" trait...`);

  let skullAssets = mints.filter(skullTraitInfo);
  console.log(`Found ${skullAssets.length} Skulls.`);
  if (skullAssets.length !== 99) {
    console.warn(`Warning: expected 99 Skulls, found ${skullAssets.length}. Check trait filter logic.`);
  }

  if (DEBUG_ONLY_TARGET) {
    skullAssets = skullAssets.filter((a) => a.onchainId === DEBUG_MINT);
    console.log(`DEBUG_ONLY_TARGET set — restricting run to ${DEBUG_MINT} only, will NOT write skulls-data.json.`);
  }

  const results = await mapWithConcurrency(skullAssets, async (asset) => {
    const mint = asset.onchainId;
    const num = extractNumber(asset);

    let t = {
      name: null,
      image: null,
      owner: null,
      trades: 0,
      lastSalePrice: null,
      listed: false,
      rawAskPrice: null,
    };
    try {
      t = await tensorMintData(mint);
    } catch (e) {
      console.warn(`\nTensor fetch failed for ${mint}: ${e.message}`);
    }

    const owner = t.owner;

    // Both Magic Eden and Tensor list the seller's raw ask and add their 2%
    // taker fee + Mad Lads' enforced 4.2% royalty on top at checkout
    // (confirmed against both marketplaces' fee docs, and cross-checked
    // live: a raw ask of 83.69 SOL for #1792 became Tensor's displayed
    // "88.8788 SOL" buy-now total — 83.69 * 1.062 = 88.8787..., an exact
    // match). Show the real total a buyer pays, not the raw ask.
    const MARKETPLACE_FEE_RATE = 0.02;
    const MAD_LADS_ROYALTY_RATE = 0.042;
    const listPrice =
      t.rawAskPrice == null ? null : +(t.rawAskPrice * (1 + MARKETPLACE_FEE_RATE + MAD_LADS_ROYALTY_RATE)).toFixed(4);

    let domain = null;
    try {
      domain = owner ? await reverseSolDomain(owner) : null;
    } catch (e) {
      console.warn(`\nSNS lookup failed for ${owner}: ${e.message}`);
    }

    await sleep(300); // stagger requests to stay well under Tensor's unofficial rate limits

    const tag = owner ? ownerTags[owner] : null;
    return {
      num,
      mint,
      owner: domain || owner,
      isDomain: !!domain,
      twitter: tag?.twitter || null,
      label: tag?.label || null,
      tagText: tag?.tag || null,
      tagColor: tag?.tagColor || null,
      tagOnly: !!tag?.tagOnly,
      twitterUrl: tag?.twitterUrl || (tag?.twitter ? `https://x.com/${tag.twitter}` : null),
      trades: t.trades,
      lastSalePrice: t.lastSalePrice,
      neverTraded: t.trades === 0,
      listed: t.listed,
      listPrice,
      image: t.image,
      meUrl: `https://magiceden.io/item-details/${mint}`,
    };
  });

  if (DEBUG_ONLY_TARGET) {
    console.log(`\nDEBUG_ONLY_TARGET result: ${JSON.stringify(results, null, 2)}`);
    console.log('Not writing skulls-data.json (debug run).');
    return;
  }

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
