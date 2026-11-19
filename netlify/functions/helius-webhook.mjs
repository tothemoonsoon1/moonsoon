// Receives Helius "enhanced" webhook events for Mad Lads and keeps them in
// Netlify Blobs. Test stage: it records every delivered event (each one costs
// 1 Helius credit) and picks out the ones that are sales.
//
// Each event is written under its own key, so events that arrive at the same
// time cannot overwrite each other (an earlier version kept one shared
// counter and lost some):
//   ev/<day>/<type>/<source>/<signature>   every event; the key alone is the count
//   sale/<unix time>/<signature>           sales only, with price, buyer, seller, mint
//
// Helius types Magic Eden sales as NFT_SALE, but Tensor sales come through as
// UNKNOWN (source TENSOR), together with loans and bids. A transaction counts
// as a sale here when a Mad Lad moved to a new wallet and that wallet paid SOL.
//
//   POST /.netlify/functions/helius-webhook        Helius delivers an array of transactions
//   GET  /.netlify/functions/helius-webhook        counts per day, type and source, recent sales
//
// If the env var HELIUS_WEBHOOK_AUTH is set, POSTs must carry it in the
// Authorization header (Helius sends the webhook's authHeader there).
import { getStore } from '@netlify/blobs';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const safe = (s) => String(s || 'UNKNOWN').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40);

// A Lad moved to a wallet that paid for it → { mint, buyer, seller, sol }.
function saleOf(e) {
  const moved = (e.tokenTransfers || []).filter((t) => Number(t.tokenAmount) === 1 && t.fromUserAccount && t.toUserAccount && t.fromUserAccount !== t.toUserAccount);
  for (const t of moved) {
    const buyer = t.toUserAccount, seller = t.fromUserAccount;
    const paid = (e.nativeTransfers || []).filter((n) => n.fromUserAccount === buyer).reduce((s, n) => s + n.amount, 0) / 1e9;
    const got = (e.nativeTransfers || []).filter((n) => n.toUserAccount === seller).reduce((s, n) => s + n.amount, 0) / 1e9;
    if (paid > 0.3 || got > 0.3) return { mint: t.mint, buyer, seller, sol: +(got > 0.3 ? got : paid).toFixed(4) };
  }
  // Helius' own parse, when it has one (Magic Eden NFT_SALE).
  const nft = e.events?.nft;
  if (nft?.amount > 0.3e9 && nft.buyer) return { mint: nft.nfts?.[0]?.mint || null, buyer: nft.buyer, seller: nft.seller || null, sol: +(nft.amount / 1e9).toFixed(4) };
  return null;
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
  const store = getStore('helius-madlads-v2');

  if (req.method === 'GET') {
    const days = {};
    for (const key of await listAll(store, 'ev/')) {
      const [, day, type, source] = key.split('/');
      const d = days[day] || (days[day] = { events: 0, types: {}, sources: {} });
      d.events++;
      d.types[type] = (d.types[type] || 0) + 1;
      d.sources[source] = (d.sources[source] || 0) + 1;
    }
    const saleKeys = (await listAll(store, 'sale/')).sort().reverse().slice(0, 40);
    const sales = await Promise.all(saleKeys.map((k) => store.get(k, { type: 'json' })));
    const total = Object.values(days).reduce((s, d) => s + d.events, 0);
    return json({ total, days, sales });
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const auth = process.env.HELIUS_WEBHOOK_AUTH;
  if (auth && req.headers.get('authorization') !== auth) return json({ error: 'unauthorized' }, 401);

  let events;
  try { events = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!Array.isArray(events)) events = [events];

  const day = new Date().toISOString().slice(0, 10);
  let sales = 0;
  await Promise.all(events.map(async (e) => {
    const sig = e?.signature; if (!sig) return;
    const type = safe(e.type), source = safe(e.source);
    await store.set(`ev/${day}/${type}/${source}/${sig}`, '1');
    const s = saleOf(e);
    if (s) {
      sales++;
      await store.setJSON(`sale/${String(e.timestamp || 0).padStart(11, '0')}/${sig}`, { sig, t: e.timestamp, type, source, ...s });
    }
  }));
  return json({ ok: true, received: events.length, sales });
};
