/* ============================================================
   prices.js — live SOL / SKR price fetch from CoinGecko
   tothemoonsoon.xyz
   Uses sessionStorage to cache prices for 5 minutes
   ============================================================ */

var PRICES_CACHE_KEY = 'tm_prices';
var PRICES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function applyPrices(d) {
  if (d.solana) {
    document.getElementById('sol-price').textContent = '$' + d.solana.usd.toFixed(2);
    var sc = d.solana.usd_24h_change;
    var el = document.getElementById('sol-change');
    el.textContent = (sc >= 0 ? '+' : '') + sc.toFixed(2) + '% 24h';
    el.className = 'stat-card-sub ' + (sc >= 0 ? 'pos' : 'neg');
  }
  if (d.seeker) {
    var sp = d.seeker.usd;
    document.getElementById('skr-price').textContent = '$' + (sp < 0.01 ? sp.toFixed(5) : sp.toFixed(4));
    var sk  = d.seeker.usd_24h_change;
    var el2 = document.getElementById('skr-change');
    el2.textContent = (sk >= 0 ? '+' : '') + sk.toFixed(2) + '% 24h';
    el2.className = 'stat-card-sub ' + (sk >= 0 ? 'pos' : 'neg');
  }
}

function fetchPrices() {
  try {
    var cached = sessionStorage.getItem(PRICES_CACHE_KEY);
    if (cached) {
      var obj = JSON.parse(cached);
      if (Date.now() - obj.ts < PRICES_CACHE_TTL) {
        applyPrices(obj.data);
        return;
      }
    }
  } catch(e) {}

  fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana,seeker&vs_currencies=usd&include_24hr_change=true')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      applyPrices(d);
      try {
        sessionStorage.setItem(PRICES_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: d }));
      } catch(e) {}
    })
    .catch(function() {});
}
