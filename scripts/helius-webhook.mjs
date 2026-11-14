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
} else { console.log(`Unknown action ${action}`); process.exit(1); }
