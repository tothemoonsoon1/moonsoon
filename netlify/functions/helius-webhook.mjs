// Receives Helius "enhanced" webhook events for Mad Lads (NFT_SALE) and keeps
// them in Netlify Blobs. Test stage: it stores every event and counts them, so
// we can see how many events (= Helius credits, 1 per event) a day costs.
//
//   POST /.netlify/functions/helius-webhook        Helius delivers an array of transactions
//   GET  /.netlify/functions/helius-webhook        counts per day and type, newest sales
//
// If the env var HELIUS_WEBHOOK_AUTH is set, POSTs must carry it in the
// Authorization header (Helius sends the webhook's authHeader there).
import { getStore } from '@netlify/blobs';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export default async (req) => {
  const store = getStore('helius-madlads');

  if (req.method === 'GET') {
    const stats = (await store.get('stats', { type: 'json' })) || { days: {}, total: 0 };
    const recent = (await store.get('recent', { type: 'json' })) || [];
    return json({ ...stats, recent: recent.slice(0, 30) });
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const auth = process.env.HELIUS_WEBHOOK_AUTH;
  if (auth && req.headers.get('authorization') !== auth) return json({ error: 'unauthorized' }, 401);

  let events;
  try { events = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!Array.isArray(events)) events = [events];

  const day = new Date().toISOString().slice(0, 10);
  const stats = (await store.get('stats', { type: 'json' })) || { days: {}, total: 0 };
  const d = stats.days[day] || (stats.days[day] = { events: 0, types: {}, sources: {} });
  const recent = (await store.get('recent', { type: 'json' })) || [];

  for (const e of events) {
    stats.total++; d.events++;
    const type = e?.type || 'UNKNOWN', source = e?.source || 'UNKNOWN';
    d.types[type] = (d.types[type] || 0) + 1;
    d.sources[source] = (d.sources[source] || 0) + 1;
    const nft = e?.events?.nft;
    recent.unshift({
      sig: e?.signature, t: e?.timestamp, type, source,
      sol: nft?.amount != null ? nft.amount / 1e9 : null,
      buyer: nft?.buyer || null, seller: nft?.seller || null,
      mint: nft?.nfts?.[0]?.mint || null,
    });
  }
  stats.last = new Date().toISOString();
  await store.setJSON('stats', stats);
  await store.setJSON('recent', recent.slice(0, 500));
  return json({ ok: true, received: events.length });
};
