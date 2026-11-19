// Live Mad Lads sales from a Helius "enhanced" webhook (type NFT_SALE).
//
// Helius only types Magic Eden sales as NFT_SALE; Tensor and other
// marketplaces come through as UNKNOWN together with bids and loans, which
// would cost too much to receive (tested 19.11.2026: ~160k credits a month).
// Those sales are picked up by the 3-hourly snapshot from the chain instead
// (scripts/generate-madlads-data.mjs). This function makes Magic Eden sales
// show up on the page within seconds.
//
//   POST  Helius delivers an array of transactions. Each sale is checked
//         against the chain (public RPC) before it is stored, so a forged
//         POST cannot put a fake sale on the page.
//   GET   sales of the last 3 days: { sales: [[t, num, price, market, sig, buyer, seller], ...] }
//         Cached on Netlify's CDN for a minute, so page views do not each
//         run the function.
//   GET ?stats=1   delivered events per day / type / source (= Helius credits)
//
// Storage (Netlify Blobs, one key per item so concurrent deliveries cannot
// overwrite each other):
//   ev/<day>/<type>/<source>/<signature>     every delivered event
//   sale/<unix time, 11 digits>/<signature>  verified sales
//
// If HELIUS_WEBHOOK_AUTH is set, POSTs must also carry it in Authorization.
import { getStore } from '@netlify/blobs';

const STORE = 'helius-madlads-v2';
const KEEP_S = 3 * 86400;
const RPC = 'https://api.mainnet-beta.solana.com';
const MARKET = { MAGIC_EDEN: 0, TENSOR: 1 };

const json = (body, status = 200, cdn = false) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'public, max-age=0, must-revalidate',
    ...(cdn ? { 'netlify-cdn-cache-control': 'public, s-maxage=60, stale-while-revalidate=120' } : { 'netlify-cdn-cache-control': 'no-store' }),
  },
});
const safe = (s) => String(s || 'UNKNOWN').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40);

// mint -> Lad number, built once per cold start from the site's own files
// (same order in both: madlads-mints.json and madlads-traits.json).
let numOf = null;
async function numByMint(origin) {
  if (numOf) return numOf;
  const [mints, traits] = await Promise.all([
    fetch(origin + '/madlads-mints.json').then((r) => r.json()),
    fetch(origin + '/madlads-traits.json').then((r) => r.json()),
  ]);
  const m = new Map();
  mints.forEach((mint, i) => { const row = traits.lads[i]; if (row) m.set(mint, row[0]); });
  return (numOf = m);
}

function saleOf(e) {
  const nft = e.events?.nft;
  if (!(nft?.amount > 0.3e9) || !nft.buyer) return null;
  return { mint: nft.nfts?.[0]?.mint || null, buyer: nft.buyer, seller: nft.seller || null, sol: +(nft.amount / 1e9).toFixed(4) };
}

// Did this transaction succeed and leave the Lad with the buyer?
async function onChain(sig, mint, buyer) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed', commitment: 'confirmed' }] }) });
    if (r.status === 429 || r.status >= 500) { await new Promise((ok) => setTimeout(ok, 800 * (i + 1))); continue; }
    const tx = (await r.json()).result;
    if (!tx) { await new Promise((ok) => setTimeout(ok, 1500)); continue; } // not visible to this RPC node yet
    if (tx.meta?.err) return false;
    return (tx.meta?.postTokenBalances || []).some((b) => b.mint === mint && b.owner === buyer && b.uiTokenAmount?.amount === '1');
  }
  return null; // could not check
}

async function listAll(store, prefix) {
  const keys = [];
  let cursor;
  do {
    const r = await store.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...r.blobs.map((b) => b.key));
    cursor = r.cursor;
  } while (cursor);
  return keys;
}

export default async (req) => {
  const store = getStore(STORE);
  const url = new URL(req.url);

  if (req.method === 'GET') {
    if (url.searchParams.get('stats')) {
      const days = {};
      for (const key of await listAll(store, 'ev/')) {
        const [, day, type, source] = key.split('/');
        const d = days[day] || (days[day] = { events: 0, types: {}, sources: {} });
        d.events++;
        d.types[type] = (d.types[type] || 0) + 1;
        d.sources[source] = (d.sources[source] || 0) + 1;
      }
      return json({ total: Object.values(days).reduce((s, d) => s + d.events, 0), days });
    }
    const since = Math.floor(Date.now() / 1000) - KEEP_S;
    const keys = (await listAll(store, 'sale/')).filter((k) => Number(k.split('/')[1]) >= since).sort().slice(-200);
    const rows = (await Promise.all(keys.map((k) => store.get(k, { type: 'json' })))).filter((s) => s && s.ok && s.num != null);
    return json({ sales: rows.map((s) => [s.t, s.num, s.sol, s.m, s.sig, s.buyer, s.seller]) }, 200, true);
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const auth = process.env.HELIUS_WEBHOOK_AUTH;
  if (auth && req.headers.get('authorization') !== auth) return json({ error: 'unauthorized' }, 401);

  let events;
  try { events = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!Array.isArray(events)) events = [events];
  events = events.slice(0, 100);

  const day = new Date().toISOString().slice(0, 10);
  let stored = 0;
  const nums = await numByMint(url.origin).catch(() => null);
  await Promise.all(events.map(async (e) => {
    const sig = e?.signature; if (!sig || !/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(sig)) return;
    await store.set(`ev/${day}/${safe(e.type)}/${safe(e.source)}/${sig}`, '1');
    const s = saleOf(e);
    const num = s && nums ? nums.get(s.mint) : null;
    if (!s || num == null) return;
    const ok = await onChain(sig, s.mint, s.buyer).catch(() => null);
    if (ok !== true) return; // unverified: the snapshot will still find a real sale
    await store.setJSON(`sale/${String(e.timestamp || 0).padStart(11, '0')}/${sig}`, { ok: true, t: e.timestamp, num, sol: s.sol, m: MARKET[e.source] ?? 2, sig, buyer: s.buyer, seller: s.seller });
    stored++;
  }));
  return json({ ok: true, received: events.length, stored });
};
