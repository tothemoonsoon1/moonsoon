// On-chain sale detection for Mad Lads, shared by the backfill
// (backfill-madlads-sales.mjs) and the 3-hourly snapshot
// (generate-madlads-data.mjs). Pure functions over getTransaction (jsonParsed)
// results, plus lastSale(), which reads the transaction that put a Lad into its
// current holder's token account.

export const MARKETS = {
  M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K: 0,
  M3mxk5W2tt27WGT7THox7PmgRDp4m6NEhL5xvxrBfS1: 0,
  mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc: 0,
  TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN: 1,
  TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp: 1,
  TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg: 1,
  TB1Dqt8JeKQh7RLDzfYDJsq8KS4fS2yt87avRjyRxMv: 1,
  hadeK9DLv9eA7ya5KCTqSvSvRZeJC3JgD5a9Y3CNbvu: 2,
  CJsLwbP1iu5DuUikHEJnLfANgKy6stB2uFgvBBHoyxwz: 2, // Solanart
  '8guzmt92HbM7yQ69UJg564hRRX6N4nCdxWE5L6ENrA8P': 4, // Foxy (Famous Fox Federation)
  '1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix': 0,
};

export const keysOf = (tx) => tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));

// Did this transaction put the NFT into `acct`? If so, where did it come from.
export function incoming(tx, mint, acct) {
  const m = tx?.meta;
  if (!m || m.err) return null;
  const keys = keysOf(tx);
  const bal = (list, addr) => { const b = (list || []).find((x) => x.mint === mint && keys[x.accountIndex] === addr); return b ? Number(b.uiTokenAmount.amount) : 0; };
  if (!(bal(m.preTokenBalances, acct) === 0 && bal(m.postTokenBalances, acct) > 0)) return null;
  const src = (m.preTokenBalances || []).find((x) => x.mint === mint && Number(x.uiTokenAmount.amount) > 0 && keys[x.accountIndex] !== acct);
  const dst = (m.postTokenBalances || []).find((x) => x.mint === mint && keys[x.accountIndex] === acct);
  return { srcAcct: src ? keys[src.accountIndex] : null, from: src?.owner || null, to: dst?.owner || null };
}

// Balance of the NFT in `acct` after this transaction (null = not mentioned).
export function balanceAfter(tx, mint, acct) {
  const m = tx?.meta;
  if (!m) return null;
  const keys = keysOf(tx);
  const find = (list) => (list || []).find((x) => x.mint === mint && keys[x.accountIndex] === acct);
  const post = find(m.postTokenBalances), pre = find(m.preTokenBalances);
  if (!post && !pre) return null;
  return post ? Number(post.uiTokenAmount.amount) : 0;
}

// Is this move a sale, and for how much?
// Prices follow the Skulls page: the listing or offer price, before fees.
//  - Buyer took a listing (buyer signs): the seller receives the ask.
//  - Seller accepted an offer (seller signs): the seller receives the offer
//    minus the 6.2% fee + royalty.
// The seller is read from who received the SOL, which also works when the
// NFT was listed from an escrow account or several NFTs sold in one go.
export function saleOf(tx, mint, move) {
  const m = tx.meta;
  const keys = keysOf(tx);
  let market = null;
  for (const k of keys) if (MARKETS[k] != null) { market = market == null ? MARKETS[k] : Math.min(market, MARKETS[k]); }
  const delta = (i) => (m.postBalances[i] - m.preBalances[i]) / 1e9;
  const signer = keys[0];
  const fee = m.fee / 1e9;
  const gainOf = (addr) => { const i = keys.indexOf(addr); if (i < 0) return 0; return delta(i) + (i === 0 ? fee : 0); };

  // The seller is whoever received the most SOL. The account the NFT left is
  // only trusted when it received a comparable amount: for escrowed listings
  // it is a marketplace account that merely collects a ~1% fee.
  let seller = null, gain = 0;
  for (let i = 0; i < keys.length; i++) {
    const d = delta(i) + (i === 0 ? fee : 0);
    if (d > gain && keys[i] !== move.to) { gain = d; seller = keys[i]; }
  }
  const fromGain = gainOf(move.from);
  if (fromGain > 0.3 && fromGain >= gain * 0.5) { seller = move.from; gain = fromGain; }
  if (!(gain > 0.3)) return null;
  // The largest payment out of any one account (buyer, bid escrow or pool).
  let paid = 0;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === seller) continue;
    const d = -(delta(i) + (i === 0 ? fee : 0));
    if (d > paid) paid = d;
  }
  if (market == null) {
    // No marketplace involved (an OTC deal): only count it when the new owner clearly paid.
    if (!(-gainOf(move.to) > 0.3)) return null;
    market = 2;
  }
  // Several NFTs for one payment (a sweep or a bundle deal): split it evenly.
  const moved = new Set();
  for (const b of m.postTokenBalances || []) {
    if (b.uiTokenAmount.decimals !== 0 || b.uiTokenAmount.amount !== '1' || b.owner !== move.to) continue;
    const pre = (m.preTokenBalances || []).find((x) => x.accountIndex === b.accountIndex);
    if (!pre || pre.uiTokenAmount.amount === '0') moved.add(b.mint);
  }
  const bundle = market === 2 && moved.size > 1 ? moved.size : 1;
  // Seller accepted an offer: the offer is what left the bidder's account.
  const acceptedOffer = signer === seller;
  const price = (acceptedOffer && paid > gain ? paid : gain) / bundle;
  return { t: tx.blockTime, mint, p: price, m: market, sig: tx.transaction.signatures[0], b: move.to, s: seller, dbg: `gain ${gain.toFixed(2)} paid ${paid.toFixed(2)} ${acceptedOffer ? 'offer' : 'listing'} x${bundle}` };
}


// The newest transaction that moved `mint` into its current holder's token
// account, read as a sale (or null: a transfer, a loan, or nothing found).
// rpc(method, params) is the caller's own client. About 3-12 credits.
export async function lastSale(rpc, mint) {
  const largest = await rpc('getTokenLargestAccounts', [mint]);
  const acct = largest?.value?.find((a) => Number(a.amount) > 0)?.address;
  if (!acct) return null;
  const sigs = await rpc('getSignaturesForAddress', [acct, { limit: 10 }]);
  for (const s of sigs || []) {
    if (s.err) continue;
    const tx = await rpc('getTransaction', [s.signature, { maxSupportedTransactionVersion: 1, encoding: 'jsonParsed' }]);
    const inc = tx && incoming(tx, mint, acct);
    if (!inc) continue;
    return inc.srcAcct ? saleOf(tx, mint, { ...inc, sig: s.signature }) : null;
  }
  return null;
}
