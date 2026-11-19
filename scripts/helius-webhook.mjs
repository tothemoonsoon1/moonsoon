// Manage the Mad Lads sales webhook on Helius (see .github/workflows/helius-webhook.yml).
// Prints a short Markdown summary; never prints the API key.
import { readFileSync } from 'node:fs';

const KEY = process.env.HELIUS_API_KEY;
if (!KEY) { console.log('Missing HELIUS_API_KEY'); process.exit(1); }
const API = 'https://api-mainnet.helius-rpc.com/v0/webhooks';
const q = `api-key=${KEY}`;
const action = process.env.ACTION || 'list';

async function call(method, path = '', body) {
  const res = await fetch(`${API}${path}?${q}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) { console.log(`**${method} failed: HTTP ${res.status}**\n\n\`\`\`\n${typeof data === 'string' ? data.slice(0, 500) : JSON.stringify(data).slice(0, 500)}\n\`\`\``); process.exit(1); }
  return data;
}
const brief = (w) => `- \`${w.webhookID}\` → ${w.webhookURL} · ${w.webhookType} · types ${JSON.stringify(w.transactionTypes)} · ${w.accountAddresses?.length ?? '?'} addresses`;

if (action === 'list') {
  const list = await call('GET');
  console.log(`### Helius webhooks (${list.length})\n\n${list.map(brief).join('\n') || 'none'}`);
} else if (action === 'create') {
  const mints = JSON.parse(readFileSync(new URL('../madlads-static.json', import.meta.url))).lads.map((r) => r[1]);
  const existing = await call('GET');
  if (existing.some((w) => w.webhookURL === process.env.URL)) { console.log(`Already exists for ${process.env.URL}:\n\n${existing.filter((w) => w.webhookURL === process.env.URL).map(brief).join('\n')}`); process.exit(0); }
  const w = await call('POST', '', { webhookURL: process.env.URL, transactionTypes: ['NFT_SALE'], accountAddresses: mints, webhookType: 'enhanced' });
  console.log(`### Created\n\n${brief(w)}`);
} else if (action === 'delete') {
  if (!process.env.ID) { console.log('Missing id'); process.exit(1); }
  await call('DELETE', `/${process.env.ID}`);
  console.log(`### Deleted \`${process.env.ID}\``);
} else if (action === 'types') {
  // Change which transaction types the webhook sends (keeps URL and addresses).
  // Costs 100 credits.
  if (!process.env.ID) { console.log('Missing id'); process.exit(1); }
  const types = (process.env.TYPES || 'NFT_SALE').split(',').map((t) => t.trim()).filter(Boolean);
  const w = await call('GET', `/${process.env.ID}`);
  const updated = await call('PUT', `/${process.env.ID}`, { webhookURL: w.webhookURL, transactionTypes: types, accountAddresses: w.accountAddresses, webhookType: w.webhookType, ...(w.authHeader ? { authHeader: w.authHeader } : {}) });
  console.log(`### Updated\n\n${brief(updated)}`);
} else if (action === 'inspect') {
  // How Helius classifies the newest transactions of some Lads (type, source),
  // to see what a Tensor sale looks like. ~100 credits per Lad.
  const mints = (process.env.MINTS || '').split(',').map((m) => m.trim()).filter(Boolean).slice(0, 10);
  const seen = {};
  for (const mint of mints) {
    const res = await fetch(`https://api-mainnet.helius-rpc.com/v0/addresses/${mint}/transactions?${q}&limit=10`);
    if (!res.ok) { console.log(`- ${mint}: HTTP ${res.status}`); continue; }
    const txs = await res.json();
    console.log(`\n#### ${mint}`);
    for (const t of txs) {
      const k = `${t.type} / ${t.source}`;
      seen[k] = (seen[k] || 0) + 1;
      const sol = t.events?.nft?.amount ? ` · ${(t.events.nft.amount / 1e9).toFixed(2)} SOL` : '';
      console.log(`- ${new Date(t.timestamp * 1000).toISOString().slice(0, 16)} · **${t.type}** · ${t.source}${sol} · ${(t.description || '').slice(0, 90)} · \`${t.signature.slice(0, 12)}\``);
    }
  }
  console.log(`\n### Types seen\n${Object.entries(seen).map(([k, n]) => `- ${k}: ${n}`).join('\n')}`);
} else { console.log(`Unknown action ${action}`); process.exit(1); }
