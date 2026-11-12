/* Trait Alerts for the Mad Lads gallery.
 *
 * Deliberately a separate file rather than another block inside madlads.html:
 * one syntax error in that page's inline <script> kills the whole gallery, and
 * this module is the part most likely to change. If this file fails to parse,
 * madlads.html keeps working and only the Alerts tab stays empty.
 *
 * The page calls MLAlerts.init(ctx) once its data has loaded and hands over the
 * collection it already holds in memory, so traits and ranks are matched here
 * and only market data comes over the network.
 *
 * Two things are fetched, both through the same-origin proxy:
 *   - every open listing, which gives a live floor for the collection AND for
 *     each individual trait (the whole point: "alert me when a Galaxy Tuxedo
 *     goes below what Galaxy Tuxedos usually sell for")
 *   - the newest "list" activities, which is what actually fires an alert
 *
 * Prices: the activity feed and the listings endpoint both report the seller's
 * ask, so everything gets PRICE_FEE applied once, on the way in. From there on
 * every number in this file already includes fees, like the rest of the site.
 */
(function () {
  'use strict';

  var STORE_KEY = 'moonsoon_ml_alerts';
  var POLL_MS = 45000;        // how often new listings are checked
  var MARKET_MS = 300000;     // how often trait floors are recomputed (far steadier)
  var FEED_MAX = 40;
  var API = '/api/me/collections/mad_lads/';
  var LIST_PAGE = 100;
  var LIST_MAX_PAGES = 6; // ~600 listings; the collection sits far below this

  var ctx = null;
  var rules = [];
  var draft = null;
  var feed = [];
  var seen = {};
  var lastPing = {};       // mint -> cheapest price we have already pinged
  var primed = false;
  var timer = null;
  var visible = false;     // is the Alerts tab on screen
  var marketPending = false;

  var floor = null;        // collection floor, fees included
  var traitFloor = [];     // traitFloor[categoryIndex][valueIndex+1] = floor
  var traitListed = [];    // same shape, how many are listed
  var marketAt = null;     // when the listings snapshot was taken
  var pollState = { status: 'idle', at: null, error: null };
  var pickerCat = null;   // category currently drawn, so a poll need not rebuild it

  // ---- storage -------------------------------------------------------------
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (Object.prototype.toString.call(parsed) !== '[object Array]') return [];
      return parsed.map(migrate);
    } catch (e) { return []; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(rules)); } catch (e) { /* private window */ }
  }
  // Rules saved before the cap gained a basis carried capPct/capAbs instead.
  function migrate(r) {
    if (r && !r.cap) {
      r.cap = r.capAbs != null ? { basis: 'fixed', abs: r.capAbs }
        : r.capPct != null ? { basis: 'floor', pct: r.capPct }
        : { basis: 'any' };
      delete r.capPct; delete r.capAbs;
    }
    return r;
  }

  function newDraft() {
    return { traits: [], tiers: [], mode: 'any', cap: { basis: 'trait', pct: 0 }, cat: 0, custom: '' };
  }

  // ---- helpers -------------------------------------------------------------
  function esc(s) { return ctx.esc(s); }
  function withFee(p) { return Math.round(p * ctx.PRICE_FEE * 100) / 100; }
  function sol(n) { return (Math.round(n * 100) / 100).toFixed(2); }

  function traitLabel(t) {
    return ctx.KEYS[t.k] + ': ' + (t.v < 0 ? 'None' : ctx.VALUES[t.k][t.v]);
  }
  function tierLabel(id) {
    for (var i = 0; i < ctx.TIERS.length; i++) if (ctx.TIERS[i].id === id) return ctx.TIERS[i].label;
    return id;
  }
  function floorOf(k, v) {
    var row = traitFloor[k];
    return row ? row[v + 1] : null;
  }
  function listedOf(k, v) {
    var row = traitListed[k];
    return row ? (row[v + 1] || 0) : 0;
  }

  // The threshold a listing has to come in under. For a trait-based cap this is
  // the floor of the matched traits, so the rule tracks that trait's own market
  // rather than the collection's. With several traits matched, the lowest one
  // wins: the stricter reading, which keeps the alert quiet.
  function thresholdFor(rule, matchedTraits) {
    var cap = rule.cap || { basis: 'any' };
    if (cap.basis === 'any') return null;
    if (cap.basis === 'fixed') return cap.abs != null ? cap.abs : null;
    if (cap.basis === 'floor') return floor == null ? null : Math.round(floor * (1 + cap.pct / 100) * 100) / 100;

    // basis 'trait'
    var base = null;
    var list = matchedTraits && matchedTraits.length ? matchedTraits : rule.traits;
    for (var i = 0; i < list.length; i++) {
      var f = floorOf(list[i].k, list[i].v);
      if (f != null && (base == null || f < base)) base = f;
    }
    // Nothing of that trait is listed, so any listing is a first. Let it through.
    if (base == null) return null;
    return Math.round(base * (1 + cap.pct / 100) * 100) / 100;
  }

  function capWord(cap) {
    if (!cap || cap.basis === 'any') return 'any price';
    if (cap.basis === 'fixed') return 'under ' + sol(cap.abs) + ' SOL';
    var where = cap.basis === 'trait' ? 'trait floor' : 'floor';
    if (cap.pct === 0) return 'at or below ' + where;
    return (cap.pct > 0 ? '+' : '') + cap.pct + '% vs ' + where;
  }

  function ruleTitle(rule) {
    var parts = rule.traits.map(traitLabel);
    if (rule.tiers.length) parts.push(rule.tiers.map(tierLabel).join(' / '));
    return parts.length ? parts.join(rule.mode === 'all' ? ' + ' : ' · ') : 'Any Mad Lad';
  }

  function ruleSub(rule) {
    var bits = [];
    if (rule.traits.length) {
      bits.push(rule.mode === 'all' ? 'all ' + rule.traits.length + ' traits' : 'any of ' + rule.traits.length);
    }
    if (rule.tiers.length) bits.push('rank ' + rule.tiers.map(tierLabel).join('/'));
    bits.push(capWord(rule.cap));
    // A fixed price already states the number; a floor-relative one does not.
    var basis = rule.cap && rule.cap.basis;
    if (basis === 'trait' || basis === 'floor') {
      var t = thresholdFor(rule, null);
      bits.push(t == null ? 'none listed yet' : 'now ' + sol(t) + ' SOL');
    }
    return bits.join(' · ');
  }

  // ---- matching ------------------------------------------------------------
  function matchedTraitsFor(rule, lad) {
    var out = [];
    for (var i = 0; i < rule.traits.length; i++) {
      if (lad.t[rule.traits[i].k] === rule.traits[i].v) out.push(rule.traits[i]);
    }
    return out;
  }

  function matches(rule, lad, price) {
    if (rule.tiers.length && rule.tiers.indexOf(lad.tier.id) === -1) return false;

    var hit = [];
    if (rule.traits.length) {
      hit = matchedTraitsFor(rule, lad);
      if (rule.mode === 'all' ? hit.length !== rule.traits.length : hit.length === 0) return false;
    } else if (!rule.tiers.length) {
      return false; // an empty rule would match the whole collection
    }

    var t = thresholdFor(rule, hit);
    return t == null || price <= t;
  }

  // ---- network -------------------------------------------------------------
  function fetchJson(url) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // Every open listing, joined against the collection we already hold, gives a
  // live floor per trait. One daily snapshot could not: a trait floor moves the
  // moment someone lists or sells, which is exactly what this tab watches for.
  function loadMarket() {
    var all = [];
    function page(n) {
      if (n >= LIST_MAX_PAGES) return Promise.resolve();
      return fetchJson(API + 'listings?offset=' + (n * LIST_PAGE) + '&limit=' + LIST_PAGE).then(function (rows) {
        if (Object.prototype.toString.call(rows) !== '[object Array]' || !rows.length) return;
        all = all.concat(rows);
        if (rows.length === LIST_PAGE) return page(n + 1);
      });
    }
    return page(0).then(function () {
      if (!all.length) return;
      var tf = ctx.KEYS.map(function (k, i) { return new Array(ctx.VALUES[i].length + 1); });
      var tl = ctx.KEYS.map(function (k, i) {
        var a = new Array(ctx.VALUES[i].length + 1);
        for (var j = 0; j < a.length; j++) a[j] = 0;
        return a;
      });
      var low = null;
      for (var i = 0; i < all.length; i++) {
        var row = all[i];
        if (!row || typeof row.price !== 'number') continue;
        var lad = ctx.byMint(row.tokenMint);
        if (!lad) continue;
        var p = withFee(row.price);
        if (low == null || p < low) low = p;
        for (var k = 0; k < ctx.KEYS.length; k++) {
          var v = lad.t[k] + 1;
          tl[k][v]++;
          if (tf[k][v] == null || p < tf[k][v]) tf[k][v] = p;
        }
      }
      traitFloor = tf; traitListed = tl; floor = low; marketAt = Date.now();
    });
  }

  function poll() {
    pollState.status = 'checking';
    renderStatus();
    // Trait floors move far more slowly than listings appear, and refreshing
    // them costs two calls against the one an activity check costs. So the
    // market is reloaded every MARKET_MS, not on every poll.
    var stale = marketAt == null || (Date.now() - marketAt) > MARKET_MS;
    return (stale ? loadMarket() : Promise.resolve())
      .then(function () {
        if (!activeRules().length) { pollState.status = 'idle'; render(); return; }
        return fetchJson(API + 'activities?offset=0&limit=100').then(onActivities);
      })
      .then(function () {
        if (pollState.status !== 'idle') { pollState.status = 'ok'; pollState.at = Date.now(); pollState.error = null; }
        render();
      })
      .catch(function (err) {
        pollState.status = 'error';
        pollState.error = String((err && err.message) || err);
        renderStatus();
      });
  }

  // Fetched unfiltered on purpose. Magic Eden's ?type=list filter answers from
  // a stale index: measured against the live feed it was returning listings
  // nine hours old while unfiltered showed the same collection's listings from
  // seconds ago. So we take the mixed feed and pick the listings out here.
  // 100 mixed entries cover about 8 minutes of this collection's activity,
  // roughly ten times the poll interval, so nothing falls through the gap.
  function onActivities(list) {
    if (Object.prototype.toString.call(list) !== '[object Array]') return;
    var fresh = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || a.type !== 'list' || !a.signature || seen[a.signature]) continue;
      seen[a.signature] = 1;
      fresh.push(a);
    }
    // The first pass only learns what is already listed. Without it the tab
    // would fire a hundred notifications the moment it is opened.
    if (!primed) {
      primed = true;
      // Remember what each mint is already listed at, so the first event after
      // priming is judged against a real price rather than treated as new.
      for (var s0 = 0; s0 < list.length; s0++) {
        var a0 = list[s0];
        if (a0 && a0.type === 'list' && a0.tokenMint && typeof a0.price === 'number') {
          var p0 = withFee(a0.price);
          if (lastPing[a0.tokenMint] == null || p0 < lastPing[a0.tokenMint]) lastPing[a0.tokenMint] = p0;
        }
      }
      return;
    }
    fresh.sort(function (x, y) { return (x.blockTime || 0) - (y.blockTime || 0); });
    for (var j = 0; j < fresh.length; j++) consider(fresh[j]);
  }

  function consider(act) {
    var lad = ctx.byMint(act.tokenMint);
    if (!lad || typeof act.price !== 'number') return;
    var price = withFee(act.price);

    // Most "list" events are one bot re-listing the same few Lads every half
    // minute, each time a hair dearer: 28 listings in an eight-minute window
    // came from three mints. Pinging each one would bury any real listing, so
    // a mint only pings again when it comes back meaningfully cheaper.
    var before = lastPing[act.tokenMint];
    if (before != null && price >= before * 0.99) return;

    var matched = [];
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].enabled && matches(rules[i], lad, price)) matched.push(rules[i]);
    }
    if (!matched.length) return;
    lastPing[act.tokenMint] = price;

    for (var j = 0; j < matched.length; j++) matched[j].hits = (matched[j].hits || 0) + 1;
    save();

    var basis = matched[0].cap && matched[0].cap.basis;
    var ref = (basis === 'trait' || basis === 'floor')
      ? thresholdFor(matched[0], matchedTraitsFor(matched[0], lad))
      : null;
    var hit = {
      num: lad.num,
      price: price,
      under: ref == null ? null : Math.round((1 - price / ref) * 100),
      rank: lad.rank,
      tier: lad.tier,
      rule: ruleTitle(matched[0]),
      at: act.blockTime ? act.blockTime * 1000 : Date.now()
    };
    feed.unshift(hit);
    if (feed.length > FEED_MAX) feed.length = FEED_MAX;
    notify(hit);
  }

  function notify(hit) {
    try {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      var cut = hit.under == null ? '' : (hit.under > 0 ? ' — ' + hit.under + '% under your threshold' : '');
      var n = new Notification('Mad Lad #' + hit.num + ' listed', {
        body: sol(hit.price) + ' SOL' + cut + ' · rank #' + hit.rank + ' · ' + hit.tier.label,
        icon: ctx.thumb(hit.num, 96),
        tag: 'ml-alert-' + hit.num
      });
      n.onclick = function () { window.focus(); window.open(meUrl(hit.num), '_blank', 'noopener'); };
    } catch (e) { /* the in-page feed still shows it */ }
  }

  function meUrl(num) {
    var lad = ctx.byNum(num);
    return lad && lad.mint ? 'https://magiceden.io/item-details/' + lad.mint : 'https://magiceden.io/marketplace/mad_lads';
  }

  function activeRules() { return rules.filter(function (r) { return r.enabled; }); }

  // Nothing is fetched for a visitor who never opens this tab and has no rules.
  // Polling on every gallery page load would have cost three proxy calls every
  // 45 seconds per visitor, forever, for people not using alerts at all.
  function needsPolling() { return activeRules().length > 0 || visible; }

  function syncTimer() {
    if (needsPolling() && !timer) {
      timer = setInterval(poll, POLL_MS);
      poll();
    } else if (!needsPolling() && timer) {
      clearInterval(timer);
      timer = null;
      pollState.status = 'idle';
      renderStatus();
    }
  }

  // ---- rendering -----------------------------------------------------------
  function render() {
    if (!ctx) return;
    // A poll every 45s must not rebuild the grid: that would restart every
    // thumbnail download and flash the page while someone is picking traits.
    if (pickerCat === draft.cat) refreshTileNumbers(); else renderPicker();
    renderRail(); renderRules(); renderFeed(); renderStatus();
  }

  function refreshTileNumbers() {
    var tiles = document.querySelectorAll('#al-picker .al-tile');
    if (!tiles.length) { renderPicker(); return; }
    for (var i = 0; i < tiles.length; i++) {
      var vi = parseInt(tiles[i].getAttribute('data-vi'), 10);
      var m = tiles[i].querySelector('.al-tile-m');
      if (!m) continue;
      var f = floorOf(draft.cat, vi), lc = listedOf(draft.cat, vi);
      m.innerHTML = '<b>' + (f == null ? '\u2014' : sol(f)) + '</b><span>' + (lc ? lc + ' listed' : 'none listed') + '</span>';
    }
  }

  function renderPicker() {
    var el = document.getElementById('al-picker');
    if (!el) return;
    var total = ctx.LADS.length;

    var cats = ctx.KEYS.map(function (k, ki) {
      var picked = draft.traits.filter(function (t) { return t.k === ki; }).length;
      return '<button class="al-cat' + (ki === draft.cat ? ' active' : '') + '" onclick="MLAlerts.setCat(' + ki + ')">' +
        esc(k) + (picked ? '<span class="al-cat-n">' + picked + '</span>' : '') + '</button>';
    }).join('');

    var ki = draft.cat;
    var vals = [];
    for (var v = 0; v <= ctx.VALUES[ki].length; v++) if (ctx.COUNTS[ki][v]) vals.push(v);

    // Listed first, cheapest first. A trait with nothing listed can never fire
    // an alert, so putting the one-of-ones on top (rarest first) buried every
    // trait anyone can actually buy.
    vals.sort(function (a, b) {
      var la = listedOf(ki, a - 1), lb = listedOf(ki, b - 1);
      if (!la !== !lb) return la ? -1 : 1;
      var fa = floorOf(ki, a - 1), fb = floorOf(ki, b - 1);
      if (fa != null && fb != null && fa !== fb) return fa - fb;
      return ctx.COUNTS[ki][a] - ctx.COUNTS[ki][b];
    });

    var tiles = vals.map(function (v) {
      var vi = v - 1, n = ctx.COUNTS[ki][v];
      var on = draft.traits.some(function (t) { return t.k === ki && t.v === vi; });
      var name = vi < 0 ? 'None' : ctx.VALUES[ki][vi];
      var f = floorOf(ki, vi), lc = listedOf(ki, vi);
      return '<button class="al-tile' + (on ? ' on' : '') + '" data-name="' + esc(String(name).toLowerCase()) + '"' +
        ' data-vi="' + vi + '" onclick="MLAlerts.toggleTrait(' + ki + ',' + vi + ')" aria-pressed="' + on + '">' +
        (on ? '<span class="al-check" aria-hidden="true">&#10003;</span>' : '') +
        '<img class="al-tile-img" src="' + ctx.thumb(ctx.SAMPLE[ki][v], 160) + '" data-num="' + ctx.SAMPLE[ki][v] + '" onerror="thumbFallback(this)" alt="" loading="lazy" width="120" height="120">' +
        '<span class="al-tile-n">' + esc(name) + '</span>' +
        '<span class="al-tile-m"><b>' + (f == null ? '—' : sol(f)) + '</b>' +
        '<span>' + (lc ? lc + ' listed' : 'none listed') + '</span></span>' +
        '<span class="al-tile-r">' + (n / total * 100).toFixed(2) + '%</span>' +
        '</button>';
    }).join('');

    var search = vals.length > 12
      ? '<input class="ctl-input al-find" type="text" placeholder="Search ' + esc(String(ctx.KEYS[ki]).toLowerCase()) + '" oninput="MLAlerts.find(this)" autocomplete="off" spellcheck="false" aria-label="Search ' + esc(ctx.KEYS[ki]) + '">'
      : '';

    pickerCat = ki;
    el.innerHTML = '<div class="al-cats">' + cats + '</div>' + search +
      '<div class="al-legend">Floor and listed count are live. Sorted by cheapest listed first.</div>' +
      '<div class="al-tiles">' + tiles + '</div>';
  }

  // Repaint selection in place. Rebuilding the picker's innerHTML on every
  // click restarted every thumbnail download, so the grid flashed each time a
  // trait was picked.
  function paintTiles() {
    var tiles = document.querySelectorAll('#al-picker .al-tile');
    for (var i = 0; i < tiles.length; i++) {
      var vi = parseInt(tiles[i].getAttribute('data-vi'), 10);
      var on = draft.traits.some(function (t) { return t.k === draft.cat && t.v === vi; });
      tiles[i].className = 'al-tile' + (on ? ' on' : '');
      tiles[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      var mark = tiles[i].querySelector('.al-check');
      if (on && !mark) {
        var span = document.createElement('span');
        span.className = 'al-check';
        span.setAttribute('aria-hidden', 'true');
        span.innerHTML = '&#10003;';
        tiles[i].insertBefore(span, tiles[i].firstChild);
      } else if (!on && mark) {
        mark.parentNode.removeChild(mark);
      }
    }
    paintCats();
  }

  function paintCats() {
    var el = document.querySelector('#al-picker .al-cats');
    if (!el) return;
    el.innerHTML = ctx.KEYS.map(function (k, ki) {
      var picked = draft.traits.filter(function (t) { return t.k === ki; }).length;
      return '<button class="al-cat' + (ki === draft.cat ? ' active' : '') + '" onclick="MLAlerts.setCat(' + ki + ')">' +
        esc(k) + (picked ? '<span class="al-cat-n">' + picked + '</span>' : '') + '</button>';
    }).join('');
  }

  function renderRail() {
    var el = document.getElementById('al-rail');
    if (!el) return;
    var cap = draft.cap;

    var chips = draft.traits.length
      ? draft.traits.map(function (t, i) {
          var f = floorOf(t.k, t.v);
          return '<div class="al-chip"><span style="min-width:0"><span class="al-chip-k">' + esc(ctx.KEYS[t.k]) + '</span>' +
            '<span class="al-chip-v">' + esc(t.v < 0 ? 'None' : ctx.VALUES[t.k][t.v]) + '</span></span>' +
            '<span class="al-chip-f">' + (f == null ? 'none listed' : sol(f) + ' SOL') + '</span>' +
            '<button class="al-x" onclick="MLAlerts.dropTrait(' + i + ')" aria-label="Remove">&times;</button></div>';
        }).join('')
      : '<div class="al-empty">No traits picked. A rank on its own works too.</div>';

    var tiers = ctx.TIERS.map(function (t) {
      var on = draft.tiers.indexOf(t.id) !== -1;
      return '<button class="al-pill' + (on ? ' on' : '') + '" onclick="MLAlerts.toggleTier(\'' + t.id + '\')">' + esc(t.label) + '</button>';
    }).join('');

    var bases = [
      ['trait', 'Trait floor'],
      ['floor', 'Collection floor'],
      ['fixed', 'Fixed price']
    ].map(function (b) {
      return '<button class="al-basis' + (cap.basis === b[0] ? ' on' : '') + '" onclick="MLAlerts.setBasis(\'' + b[0] + '\')">' + b[1] + '</button>';
    }).join('');

    var body;
    if (cap.basis === 'fixed') {
      body = '<div class="al-custom"><input class="ctl-input" id="al-abs" type="number" min="0" step="0.1" inputmode="decimal"' +
        ' value="' + (cap.abs != null ? cap.abs : '') + '" placeholder="e.g. 12.5" oninput="MLAlerts.setAbs(this.value)" aria-label="Maximum price in SOL">' +
        '<span class="al-unit">SOL</span></div>';
    } else {
      var steps = cap.basis === 'trait' ? [-20, -10, 0, 10] : [0, 10, 25, 50];
      body = '<div class="al-pills">' + steps.map(function (p) {
        var on = cap.pct === p;
        return '<button class="al-pill' + (on ? ' on' : '') + '" onclick="MLAlerts.setPct(' + p + ')">' +
          (p === 0 ? 'At floor' : (p > 0 ? '+' : '') + p + '%') + '</button>';
      }).join('') +
      '<button class="al-pill' + (isCustomPct(cap) ? ' on' : '') + '" onclick="MLAlerts.setPct(\'custom\')">Custom</button></div>' +
      (isCustomPct(cap) || draft.custom === 'pct'
        ? '<div class="al-custom"><input class="ctl-input" id="al-pct" type="number" step="1" inputmode="numeric" value="' + (cap.pct != null ? cap.pct : '') + '" placeholder="e.g. -15" oninput="MLAlerts.setPct(this.value)" aria-label="Percent against floor"><span class="al-unit">%</span></div>'
        : '');
    }

    var t = thresholdFor(draft, null);
    var hint;
    if (cap.basis === 'any') hint = 'Pings on any matching listing.';
    else if (cap.basis === 'trait' && !draft.traits.length) hint = 'Pick a trait and this follows that trait&rsquo;s own floor.';
    else if (t == null) hint = 'Nothing of this is listed right now, so the first listing pings whatever the price.';
    else hint = 'Pings under <b>' + sol(t) + ' SOL</b>, fees included.';

    var ready = draft.traits.length > 0 || draft.tiers.length > 0;
    var fl = floor == null ? '—' : sol(floor);

    el.innerHTML =
      '<div class="al-rail-row"><h4>Match</h4>' +
        '<div class="al-seg">' +
          '<button class="' + (draft.mode === 'any' ? 'on' : '') + '" onclick="MLAlerts.setMode(\'any\')">Any</button>' +
          '<button class="' + (draft.mode === 'all' ? 'on' : '') + '" onclick="MLAlerts.setMode(\'all\')">All</button>' +
        '</div></div>' +
      '<h4>Traits</h4><div class="al-chips">' + chips + '</div>' +
      '<h4>Rarity rank</h4><div class="al-pills">' + tiers + '</div>' +
      '<div class="al-rail-row"><h4>Alert when price is</h4>' +
        '<span class="al-floor">floor ' + fl + '</span></div>' +
      '<div class="al-bases">' + bases + '</div>' + body +
      '<p class="al-hint">' + hint + '</p>' +
      '<button class="btn al-save"' + (ready ? '' : ' disabled') + ' onclick="MLAlerts.saveDraft()">Turn on alert</button>' +
      '<p class="al-foot">Rules stay in this browser. Pings arrive while this tab is open.</p>';
  }

  function isCustomPct(cap) {
    if (cap.basis === 'fixed' || cap.basis === 'any' || cap.pct == null) return false;
    var preset = cap.basis === 'trait' ? [-20, -10, 0, 10] : [0, 10, 25, 50];
    return preset.indexOf(cap.pct) === -1;
  }

  function renderRules() {
    var el = document.getElementById('al-rules');
    if (!el) return;
    if (!rules.length) {
      el.innerHTML = '<div class="al-empty-box">No alerts yet. Pick a trait or a rank above, then turn it on.</div>';
      return;
    }
    el.innerHTML = rules.map(function (r, i) {
      var noisy = (r.hits || 0) > 25;
      return '<div class="al-rule">' +
        '<span class="al-stripe' + (r.enabled ? (noisy ? ' warn' : '') : ' off') + '"></span>' +
        '<div style="min-width:0"><div class="al-rule-t">' + esc(ruleTitle(r)) + '</div>' +
        '<div class="al-rule-s">' + esc(ruleSub(r)) + '</div></div>' +
        '<div class="al-rule-r">' +
          (noisy ? '<span class="al-tag warn">Narrow it</span>' : '') +
          '<span class="al-tag' + ((r.hits || 0) ? ' hit' : '') + '">' + (r.hits || 0) + ' hits</span>' +
          '<button class="al-mini" onclick="MLAlerts.toggleRule(' + i + ')">' + (r.enabled ? 'Pause' : 'Resume') + '</button>' +
          '<button class="al-mini" onclick="MLAlerts.removeRule(' + i + ')">Delete</button>' +
        '</div></div>';
    }).join('');
  }

  function renderFeed() {
    var el = document.getElementById('al-feed');
    if (!el) return;
    if (!feed.length) {
      el.innerHTML = '<div class="al-empty-box">Nothing yet. Matching listings appear here as they happen.</div>';
      return;
    }
    el.innerHTML = feed.map(function (h) {
      var cut = (h.under == null || h.under <= 0) ? '' : '<span class="al-under">' + h.under + '% under</span>';
      return '<a class="al-hit" href="' + esc(meUrl(h.num)) + '" target="_blank" rel="noopener noreferrer">' +
        '<img src="' + ctx.thumb(h.num, 96) + '" data-num="' + h.num + '" onerror="thumbFallback(this)" alt="" loading="lazy" width="44" height="44">' +
        '<span style="min-width:0"><div class="al-hit-t">Mad Lad #' + h.num + '</div>' +
        '<div class="al-hit-s">' + esc(h.rule) + '</div></span>' +
        '<span class="al-hit-p">' + sol(h.price) + ' SOL ' + cut + '</span></a>';
    }).join('');
  }

  function renderStatus() {
    var el = document.getElementById('al-status');
    if (!el) return;
    var n = activeRules().length;
    var txt, cls;
    if (pollState.status === 'error') { txt = 'Connection problem — retrying'; cls = 'bad'; }
    else if (pollState.status === 'checking') { txt = 'Checking the market…'; cls = 'on'; }
    else if (!n) { txt = marketAt ? 'Market loaded · no active alerts' : 'No active alerts'; cls = 'off'; }
    else if (pollState.at) {
      var secs = Math.round((Date.now() - pollState.at) / 1000);
      txt = 'Watching ' + n + (n === 1 ? ' alert' : ' alerts') + ' · checked ' +
        (secs < 60 ? secs + 's' : Math.round(secs / 60) + 'm') + ' ago';
      cls = 'on';
    } else { txt = 'Watching ' + n + (n === 1 ? ' alert' : ' alerts'); cls = 'on'; }

    var perm = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
    var ask = (n && perm === 'default') ? '<button class="al-mini" onclick="MLAlerts.askPermission()">Enable notifications</button>' : '';
    var warn = (n && perm === 'denied') ? '<span class="al-tag warn">Notifications blocked — hits still show below</span>' : '';
    el.innerHTML = '<span class="al-dot ' + cls + '"></span><span class="al-status-t">' + esc(txt) + '</span>' + ask + warn;
  }

  // ---- public actions ------------------------------------------------------
  var api = {
    init: function (context) {
      ctx = context;
      rules = load();
      draft = newDraft();
      render();
      syncTimer();   // fetches only if rules are already armed
      setInterval(renderStatus, 10000);
    },
    setVisible: function (on) {
      visible = !!on;
      if (on) render();
      syncTimer();
    },
    onShow: function () { api.setVisible(true); },
    setCat: function (i) { draft.cat = i; renderPicker(); },
    find: function (input) {
      var q = input.value.trim().toLowerCase();
      var tiles = document.querySelectorAll('#al-picker .al-tile');
      for (var i = 0; i < tiles.length; i++) {
        tiles[i].style.display = (!q || tiles[i].getAttribute('data-name').indexOf(q) !== -1) ? '' : 'none';
      }
    },
    toggleTrait: function (k, v) {
      var at = -1;
      for (var i = 0; i < draft.traits.length; i++) if (draft.traits[i].k === k && draft.traits[i].v === v) at = i;
      if (at === -1) draft.traits.push({ k: k, v: v }); else draft.traits.splice(at, 1);
      paintTiles(); renderRail();
    },
    dropTrait: function (i) { draft.traits.splice(i, 1); paintTiles(); renderRail(); },
    toggleTier: function (id) {
      var at = draft.tiers.indexOf(id);
      if (at === -1) draft.tiers.push(id); else draft.tiers.splice(at, 1);
      renderRail();
    },
    setMode: function (m) { draft.mode = m; renderRail(); },
    setBasis: function (b) {
      draft.custom = '';
      draft.cap = b === 'fixed' ? { basis: 'fixed', abs: draft.cap.abs != null ? draft.cap.abs : null }
        : { basis: b, pct: b === 'trait' ? 0 : 25 };
      renderRail();
    },
    setPct: function (p) {
      if (p === 'custom') { draft.custom = 'pct'; renderRail(); var i = document.getElementById('al-pct'); if (i) i.focus(); return; }
      var n = typeof p === 'number' ? p : parseFloat(p);
      draft.cap.pct = isNaN(n) ? null : n;
      if (typeof p !== 'number') { renderHintOnly(); return; } // typing: do not steal focus
      draft.custom = '';
      renderRail();
    },
    setAbs: function (v) {
      var n = parseFloat(v);
      draft.cap.abs = isNaN(n) ? null : n;
      renderHintOnly();
    },
    saveDraft: function () {
      if (!draft.traits.length && !draft.tiers.length) return;
      var cap = draft.cap;
      if (cap.basis === 'fixed' && cap.abs == null) return;
      if (cap.basis !== 'fixed' && cap.pct == null) return;
      rules.unshift({
        traits: draft.traits.slice(), tiers: draft.tiers.slice(), mode: draft.mode,
        cap: { basis: cap.basis, pct: cap.pct, abs: cap.abs },
        enabled: true, hits: 0, created: Date.now()
      });
      save();
      draft = newDraft();
      api.askPermission();
      render();
      syncTimer();
    },
    toggleRule: function (i) { if (rules[i]) { rules[i].enabled = !rules[i].enabled; save(); render(); syncTimer(); } },
    removeRule: function (i) { if (rules[i]) { rules.splice(i, 1); save(); render(); syncTimer(); } },
    askPermission: function () {
      try {
        if (typeof Notification === 'undefined' || Notification.permission !== 'default') { renderStatus(); return; }
        var p = Notification.requestPermission();
        if (p && p.then) p.then(function () { renderStatus(); });
      } catch (e) { /* older browsers throw on the promise form */ }
    }
  };

  // Updating only the hint keeps the number input from losing focus mid-typing.
  function renderHintOnly() {
    var el = document.querySelector('#al-rail .al-hint');
    var btn = document.querySelector('#al-rail .al-save');
    if (!el) return;
    var cap = draft.cap, t = thresholdFor(draft, null);
    if (cap.basis === 'trait' && !draft.traits.length) el.innerHTML = 'Pick a trait and this follows that trait&rsquo;s own floor.';
    else if (t == null) el.innerHTML = 'Nothing of this is listed right now, so the first listing pings whatever the price.';
    else el.innerHTML = 'Pings under <b>' + sol(t) + ' SOL</b>, fees included.';
    if (btn) {
      var ok = (draft.traits.length > 0 || draft.tiers.length > 0) &&
        (cap.basis === 'fixed' ? cap.abs != null : cap.pct != null);
      if (ok) btn.removeAttribute('disabled'); else btn.setAttribute('disabled', '');
    }
  }

  window.MLAlerts = api;
})();
