// Shared by generate-madlads-data.mjs and backfill-madlads-sales.mjs.
import fs from 'node:fs';

export const ROOT = new URL('../', import.meta.url);
export const readJson = (name) => { try { return JSON.parse(fs.readFileSync(new URL(name, ROOT), 'utf8')); } catch { return null; } };
export const writeJson = (name, data) => fs.writeFileSync(new URL(name, ROOT), JSON.stringify(data) + '\n');

export function salesYearsOnDisk() {
  return fs.readdirSync(ROOT).map((f) => /^madlads-sales-(\d{4})\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort();
}

// Sales files, one per year: { w: [wallets], s: [[time, num, price, market, sig, buyerIdx, sellerIdx]] }
// market: 0 Magic Eden, 1 Tensor, 2 other. A sale is identified by its
// transaction signature, so the same sale from two sources is stored once.
// found: [{ t (seconds), mint, p, m, sig, b, s }]
export function mergeSales(found, numByMint) {
  const byYear = new Map();
  for (const s of found) {
    const num = numByMint.get(s.mint);
    if (num == null) continue;
    const y = new Date(s.t * 1000).getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push({ ...s, num });
  }
  let added = 0;
  for (const [y, list] of byYear) {
    const file = `madlads-sales-${y}.json`;
    const prev = readJson(file) || { w: [], s: [] };
    const wIdx = new Map(prev.w.map((w, i) => [w, i]));
    const idx = (w) => { if (!w) return -1; if (!wIdx.has(w)) { wIdx.set(w, prev.w.length); prev.w.push(w); } return wIdx.get(w); };
    const seen = new Set(prev.s.map((r) => r[4]));
    let n = 0;
    for (const s of list) {
      if (seen.has(s.sig)) continue;
      seen.add(s.sig);
      prev.s.push([s.t, s.num, Math.round(s.p * 1000) / 1000, s.m, s.sig, idx(s.b), idx(s.s)]);
      n++;
    }
    if (!n) continue;
    prev.s.sort((a, b) => a[0] - b[0]);
    writeJson(file, prev);
    writePageSales(y, prev);
    added += n;
  }
  return { years: salesYearsOnDisk(), added };
}

// ---- Page-facing copies ----
// The page never needs a sale's signature, and draws the grid without the mint
// addresses. Those two are more than half of the bytes (they do not compress),
// so the page loads these lighter copies instead of the files above:
//   madlads-sales-YEAR.min.json  { w, s: [[time, num, price, market, buyerIdx, sellerIdx]] }
//   madlads-traits.json          madlads-static.json without the mint column
//   madlads-mints.json           [mint, ...] in the same order, fetched when a Lad is opened
// They are rebuilt from the full files, never edited on their own.
const writeIfChanged = (name, data) => {
  const next = JSON.stringify(data) + '\n';
  let prev = null;
  try { prev = fs.readFileSync(new URL(name, ROOT), 'utf8'); } catch { /* new file */ }
  if (prev !== next) fs.writeFileSync(new URL(name, ROOT), next);
};
export function writePageSales(year, full) {
  writeIfChanged(`madlads-sales-${year}.min.json`, { w: full.w, s: full.s.map((r) => [r[0], r[1], r[2], r[3], r[5], r[6]]) });
}
export function writePageFiles() {
  for (const y of salesYearsOnDisk()) { const full = readJson(`madlads-sales-${y}.json`); if (full) writePageSales(y, full); }
  const stat = readJson('madlads-static.json');
  if (!stat) return;
  writeIfChanged('madlads-traits.json', { keys: stat.keys, values: stat.values, lads: stat.lads.map((r) => [r[0], ...r.slice(2)]), ...(stat.rank ? { rank: stat.rank } : {}) });
  writeIfChanged('madlads-mints.json', stat.lads.map((r) => r[1]));
}
