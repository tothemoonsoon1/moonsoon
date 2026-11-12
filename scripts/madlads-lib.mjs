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
    added += n;
  }
  return { years: salesYearsOnDisk(), added };
}
