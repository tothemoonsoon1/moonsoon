// One-off check: what does the OpenSea API report as Mad Lads sales, and how
// does it compare with our own files? Run by .github/workflows/opensea-check.yml.
// Prints a Markdown summary; never prints the API key.
import { readFileSync } from 'node:fs';

const KEY = process.env.OPENSEA_API_KEY;
if (!KEY) { console.log('Missing OPENSEA_API_KEY'); process.exit(1); }
const DAYS = Number(process.env.DAYS || 3);
const after = Math.floor(Date.now() / 1000) - DAYS * 86400;

const events = [];
let next = null, first = null;
for (let page = 0; page < 20; page++) {
  const url = new URL('https://api.opensea.io/api/v2/events/collection/mad-lads');
  url.searchParams.set('event_type', 'sale');
  url.searchParams.set('after', String(after));
  url.searchParams.set('limit', '50');
  if (next) url.searchParams.set('next', next);
  const res = await fetch(url, { headers: { 'x-api-key': KEY, accept: 'application/json' } });
  if (!res.ok) { console.log(`**HTTP ${res.status}**\n\n\`\`\`\n${(await res.text()).slice(0, 600)}\n\`\`\``); process.exit(1); }
  const j = await res.json();
  if (!first && j.asset_events?.length) first = j.asset_events[0];
  events.push(...(j.asset_events || []));
  next = j.next;
  if (!next) break;
}

console.log(`### OpenSea API: ${events.length} Mad Lads sales in the last ${DAYS} days\n`);
if (first) console.log(`First event, raw (shape check):\n\n\`\`\`json\n${JSON.stringify(first, null, 1).slice(0, 2500)}\n\`\`\`\n`);

// Which fields might name the marketplace?
const keyCounts = {};
for (const e of events) for (const k of ['protocol_address', 'marketplace', 'order_source', 'source', 'chain']) {
  if (e[k] != null) { const v = `${k}=${typeof e[k] === 'object' ? JSON.stringify(e[k]).slice(0, 60) : e[k]}`; keyCounts[v] = (keyCounts[v] || 0) + 1; }
}
console.log(`Marketplace-like fields:\n${Object.entries(keyCounts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${n} × ${k}`).join('\n') || '- none found'}\n`);

// Compare with our sales file by transaction signature.
const year = new Date().getUTCFullYear();
const ours = JSON.parse(readFileSync(new URL(`../madlads-sales-${year}.json`, import.meta.url)));
const ourSigs = new Map(ours.s.filter((r) => r[0] >= after).map((r) => [r[4], r]));
const osSigs = new Set(events.map((e) => e.transaction).filter(Boolean));
const onlyOS = events.filter((e) => e.transaction && !ourSigs.has(e.transaction));
const onlyOurs = [...ourSigs.values()].filter((r) => !osSigs.has(r[4]));
const MK = ['Magic Eden', 'Tensor', 'other'];
console.log(`### Compared with madlads-sales-${year}.json (same ${DAYS} days)\n`);
console.log(`- ours: ${ourSigs.size} · OpenSea: ${events.length} · in both: ${[...osSigs].filter((s) => ourSigs.has(s)).length}`);
console.log(`- only in OpenSea (we miss): ${onlyOS.length}`);
for (const e of onlyOS.slice(0, 15)) console.log(`  - ${new Date((e.event_timestamp || e.closing_date) * 1000).toISOString().slice(0, 16)} · ${e.nft?.name || e.nft?.identifier} · ${e.payment ? (Number(e.payment.quantity) / 10 ** (e.payment.decimals ?? 9)).toFixed(3) + ' ' + e.payment.symbol : '?'} · \`${String(e.transaction).slice(0, 14)}\``);
console.log(`- only in ours (OpenSea misses): ${onlyOurs.length}`);
const byMk = onlyOurs.reduce((o, r) => { o[MK[r[3]]] = (o[MK[r[3]]] || 0) + 1; return o; }, {});
console.log(`  by marketplace: ${JSON.stringify(byMk)}`);

// ---- Listings (shape and count) ----
const listings = [];
let lnext = null;
for (let page = 0; page < 30; page++) {
  const url = new URL('https://api.opensea.io/api/v2/listings/collection/mad-lads/all');
  url.searchParams.set('limit', '100');
  if (lnext) url.searchParams.set('next', lnext);
  const res = await fetch(url, { headers: { 'x-api-key': KEY, accept: 'application/json' } });
  if (!res.ok) { console.log(`listings HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`); break; }
  const j = await res.json();
  listings.push(...(j.listings || []));
  lnext = j.next;
  if (!lnext) break;
}
console.log(`\n### OpenSea listings: ${listings.length}\n`);
if (listings[0]) console.log(`First listing, raw:\n\n\`\`\`json\n${JSON.stringify(listings[0], null, 1).slice(0, 3000)}\n\`\`\``);

// ---- Listings vs ours (madlads-data.json: listed[num] = [buyer total, market]) ----
const stat = JSON.parse(readFileSync(new URL('../madlads-static.json', import.meta.url)));
const numOf = new Map(stat.lads.map((r) => [r[1], r[0]]));
const data = JSON.parse(readFileSync(new URL('../madlads-data.json', import.meta.url)));
let both = 0, onlyOnOS = 0; const ratios = [];
const makers = new Set();
for (const l of listings) {
  const num = numOf.get(l.asset?.identifier); if (num == null) continue;
  const p = Number(l.price?.current?.value) / 1e9;
  const ours = data.listed[num];
  if (ours) { both++; ratios.push(+(p / ours[0]).toFixed(4)); } else { onlyOnOS++; makers.add(l.svm_order?.maker); }
}
ratios.sort((a, b) => a - b);
console.log(`\n### OpenSea listings vs ours: ${listings.length} OS · ${Object.keys(data.listed).length} ours (ME+Tensor) · same Lad in both: ${both} · only on OpenSea: ${onlyOnOS}`);
console.log(`price OS / ours for Lads in both (ours = buyer total): min ${ratios[0]} · median ${ratios[ratios.length >> 1]} · max ${ratios[ratios.length - 1]}`);
console.log(`types: ${JSON.stringify(listings.reduce((o, l) => { o[l.type] = (o[l.type] || 0) + 1; return o; }, {}))}`);

// ---- Skulls: OpenSea sales of Skull-type Lads vs skulls-data.json ----
const skulls = JSON.parse(readFileSync(new URL('../skulls-data.json', import.meta.url))).skulls;
const skullMints = new Set(skulls.map((s) => s.mint));
const osSkull = [];
let snext = null;
const since = Math.floor(Date.now() / 1000) - Number(process.env.SKULL_DAYS || 85) * 86400;
for (let page = 0; page < 200; page++) {
  const url = new URL('https://api.opensea.io/api/v2/events/collection/mad-lads');
  url.searchParams.set('event_type', 'sale'); url.searchParams.set('after', String(since)); url.searchParams.set('limit', '50');
  if (snext) url.searchParams.set('next', snext);
  const res = await fetch(url, { headers: { 'x-api-key': KEY, accept: 'application/json' } });
  if (!res.ok) break;
  const j = await res.json();
  for (const e of j.asset_events || []) if (skullMints.has(e.nft?.identifier)) osSkull.push(e);
  snext = j.next; if (!snext) break;
}
const ourSkullTimes = skulls.flatMap((s) => (s.sales || []).map((x) => ({ mint: s.mint, t: Math.round(x.timestamp / 1000) })));
const missing = osSkull.filter((e) => !ourSkullTimes.some((x) => x.mint === e.nft.identifier && Math.abs(x.t - e.event_timestamp) < 180));
console.log(`\n### Skulls: OpenSea has ${osSkull.length} Skull sales in the last ${process.env.SKULL_DAYS || 85} days; missing in skulls-data.json: ${missing.length}`);
for (const e of missing) console.log(`- ${new Date(e.event_timestamp * 1000).toISOString().slice(0, 16)} · ${e.nft.name} · ${(Number(e.payment.quantity) / 1e9).toFixed(2)} SOL · \`${e.transaction.slice(0, 14)}\``);
