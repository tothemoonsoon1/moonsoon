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
