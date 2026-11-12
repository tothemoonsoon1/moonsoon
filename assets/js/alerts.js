/* Trait Alerts for the Mad Lads gallery.
 *
 * Deliberately a separate file rather than another block inside madlads.html:
 * one syntax error in that page's inline <script> kills the whole gallery, and
 * this module is the part most likely to change. If this file fails to parse,
 * madlads.html keeps working and only the Alerts tab stays empty.
 *
 * The page calls MLAlerts.init(ctx) once its data has loaded and hands over the
 * collection it already holds in memory, so nothing is fetched twice.
 *
 * How a hit happens: every POLL_MS we ask the proxy for the newest "list"
 * activities, keep the ones we have not seen, look each mint up in the
 * collection we were given, and test it against the saved rules. Traits and
 * ranks never leave the browser — only the listing feed comes over the network.
 */
(function () {
  'use strict';

  var STORE_KEY = 'moonsoon_ml_alerts';
  var POLL_MS = 45000;
  var FEED_MAX = 40;
  var API = '/api/me/collections/mad_lads/';

  var ctx = null;          // handed over by madlads.html
  var rules = [];          // saved alert rules
  var draft = null;        // the rule being built
  var feed = [];           // recent hits, newest first
  var seen = {};           // listing signatures already processed
  var primed = false;      // first poll only fills `seen`, it does not alert
  var floorRaw = null;     // collection floor in SOL, before fees
  var timer = null;
  var pollState = { status: 'idle', at: null, error: null };

  // ---- storage -------------------------------------------------------------
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Object.prototype.toString.call(parsed) === '[object Array]' ? parsed : [];
    } catch (e) { return []; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(rules)); } catch (e) { /* private window */ }
  }

  function newDraft() {
    return { traits: [], tiers: [], mode: 'any', capPct: 25, capAbs: null, cat: 0 };
  }

  // ---- helpers -------------------------------------------------------------
  function esc(s) { return ctx.esc(s); }
  function withFee(p) { return Math.round(p * ctx.PRICE_FEE * 100) / 100; }
  function floorWithFee() { return floorRaw == null ? null : withFee(floorRaw); }

  // The cap the user picks is a percentage over the floor, so it has to be
  // recomputed as the floor moves rather than frozen when the rule was saved.
  function capFor(rule) {
    if (rule.capAbs != null) return rule.capAbs;
    if (rule.capPct == null) return null;
    var f = floorWithFee();
    return f == null ? null : Math.round(f * (1 + rule.capPct / 100) * 100) / 100;
  }

  function traitLabel(t) {
    return ctx.KEYS[t.k] + ': ' + (t.v < 0 ? 'None' : ctx.VALUES[t.k][t.v]);
  }

  function ruleTitle(rule) {
    var parts = rule.traits.map(traitLabel);
    if (rule.tiers.length) parts.push(rule.tiers.map(tierLabel).join(' / '));
    return parts.length ? parts.join(rule.mode === 'all' ? ' + ' : ' · ') : 'Any Mad Lad';
  }

  function tierLabel(id) {
    for (var i = 0; i < ctx.TIERS.length; i++) if (ctx.TIERS[i].id === id) return ctx.TIERS[i].label;
    return id;
  }

  function ruleSub(rule) {
    var bits = [];
    if (rule.traits.length) {
      bits.push(rule.mode === 'all' ? 'all ' + rule.traits.length + ' traits' : 'any of ' + rule.traits.length);
    }
    if (rule.tiers.length) bits.push('rank ' + rule.tiers.map(tierLabel).join('/'));
    var cap = capFor(rule);
    bits.push(cap == null ? 'any price' : 'up to ' + cap.toFixed(2) + ' SOL');
    return bits.join(' · ');
  }

  // ---- matching ------------------------------------------------------------
  function matches(rule, lad, priceWithFee) {
    if (rule.tiers.length && rule.tiers.indexOf(lad.tier.id) === -1) return false;

    if (rule.traits.length) {
      var hits = 0;
      for (var i = 0; i < rule.traits.length; i++) {
        if (lad.t[rule.traits[i].k] === rule.traits[i].v) hits++;
      }
      if (rule.mode === 'all' ? hits !== rule.traits.length : hits === 0) return false;
    } else if (!rule.tiers.length) {
      return false; // an empty rule would match the whole collection
    }

    var cap = capFor(rule);
    if (cap != null && priceWithFee > cap) return false;
    return true;
  }

  // ---- polling -------------------------------------------------------------
  function fetchJson(url) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function refreshFloor() {
    return fetchJson(API + 'stats').then(function (s) {
      if (s && typeof s.floorPrice === 'number') floorRaw = s.floorPrice / 1e9;
    }).catch(function () { /* a stale floor is better than a broken tab */ });
  }

  function poll() {
    if (!activeRules().length) { pollState.status = 'idle'; render(); return Promise.resolve(); }
    pollState.status = 'checking';
    renderStatus();

    return refreshFloor()
      .then(function () { return fetchJson(API + 'activities?type=list&offset=0&limit=100'); })
      .then(function (list) {
        pollState.status = 'ok';
        pollState.at = Date.now();
        pollState.error = null;
        if (Object.prototype.toString.call(list) !== '[object Array]') return;

        var fresh = [];
        for (var i = 0; i < list.length; i++) {
          var a = list[i];
          if (!a || a.type !== 'list' || !a.signature || seen[a.signature]) continue;
          seen[a.signature] = 1;
          fresh.push(a);
        }
        // The first poll only learns what is already listed. Without this the
        // tab would fire a hundred notifications the moment it is opened.
        if (!primed) { primed = true; render(); return; }

        fresh.sort(function (x, y) { return (x.blockTime || 0) - (y.blockTime || 0); });
        for (var j = 0; j < fresh.length; j++) consider(fresh[j]);
        render();
      })
      .catch(function (err) {
        pollState.status = 'error';
        pollState.error = String(err && err.message || err);
        renderStatus();
      });
  }

  function consider(act) {
    var lad = ctx.byMint(act.tokenMint);
    if (!lad || typeof act.price !== 'number') return;
    var price = withFee(act.price);

    var matched = [];
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].enabled && matches(rules[i], lad, price)) matched.push(rules[i]);
    }
    if (!matched.length) return;

    for (var j = 0; j < matched.length; j++) matched[j].hits = (matched[j].hits || 0) + 1;
    save();

    var f = floorWithFee();
    var hit = {
      num: lad.num,
      price: price,
      overFloor: f ? Math.round((price / f - 1) * 100) : null,
      rank: lad.rank,
      tier: lad.tier,
      rule: ruleTitle(matched[0]),
      at: (act.blockTime ? act.blockTime * 1000 : Date.now())
    };
    feed.unshift(hit);
    if (feed.length > FEED_MAX) feed.length = FEED_MAX;
    notify(hit);
  }

  function notify(hit) {
    try {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      var over = hit.overFloor == null ? '' : ' — ' + (hit.overFloor >= 0 ? '+' : '') + hit.overFloor + '% over floor';
      var n = new Notification('Mad Lad #' + hit.num + ' listed', {
        body: hit.price.toFixed(2) + ' SOL' + over + ' · rank #' + hit.rank + ' · ' + hit.tier.label,
        icon: ctx.thumb(hit.num, 96),
        tag: 'ml-alert-' + hit.num
      });
      n.onclick = function () { window.focus(); window.open(meUrl(hit.num), '_blank', 'noopener'); };
    } catch (e) { /* notifications unavailable: the in-page feed still shows it */ }
  }

  function meUrl(num) {
    var lad = ctx.byNum(num);
    return lad && lad.mint ? 'https://magiceden.io/item-details/' + lad.mint : 'https://magiceden.io/marketplace/mad_lads';
  }

  function activeRules() { return rules.filter(function (r) { return r.enabled; }); }

  function syncTimer() {
    if (activeRules().length && !timer) {
      timer = setInterval(poll, POLL_MS);
      poll();
    } else if (!activeRules().length && timer) {
      clearInterval(timer);
      timer = null;
      pollState.status = 'idle';
    }
  }

  // ---- rendering -----------------------------------------------------------
  function render() {
    if (!ctx) return;
    renderPicker();
    renderRail();
    renderRules();
    renderFeed();
    renderStatus();
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
    vals.sort(function (a, b) { return ctx.COUNTS[ki][a] - ctx.COUNTS[ki][b]; });

    var rows = vals.map(function (v) {
      var vi = v - 1, n = ctx.COUNTS[ki][v];
      var on = draft.traits.some(function (t) { return t.k === ki && t.v === vi; });
      var name = vi < 0 ? 'None' : ctx.VALUES[ki][vi];
      return '<button class="tp-row al-row' + (on ? ' active' : '') + '" data-name="' + esc(String(name).toLowerCase()) + '"' +
        ' onclick="MLAlerts.toggleTrait(' + ki + ',' + vi + ')">' +
        '<img src="' + ctx.thumb(ctx.SAMPLE[ki][v], 96) + '" data-num="' + ctx.SAMPLE[ki][v] + '" onerror="thumbFallback(this)" alt="" loading="lazy" width="40" height="40">' +
        '<span style="min-width:0"><div class="tp-name">' + esc(name) + '</div>' +
        '<div class="tp-sub">' + (n / total * 100).toFixed(2) + '% of the collection</div></span>' +
        '<span class="tp-num">' + n + '</span></button>';
    }).join('');

    var search = vals.length > 10
      ? '<input class="ctl-input al-find" type="text" placeholder="Search ' + esc(String(ctx.KEYS[ki]).toLowerCase()) + '" oninput="MLAlerts.find(this)" autocomplete="off" spellcheck="false" aria-label="Search ' + esc(ctx.KEYS[ki]) + '">'
      : '';

    el.innerHTML = '<div class="al-cats">' + cats + '</div>' + search + '<div class="al-rows">' + rows + '</div>';
  }

  function renderRail() {
    var el = document.getElementById('al-rail');
    if (!el) return;
    var f = floorWithFee();

    var chips = draft.traits.length
      ? draft.traits.map(function (t, i) {
          return '<div class="al-chip"><span class="al-chip-k">' + esc(ctx.KEYS[t.k]) + '</span>' +
            esc(t.v < 0 ? 'None' : ctx.VALUES[t.k][t.v]) +
            '<button class="al-x" onclick="MLAlerts.dropTrait(' + i + ')" aria-label="Remove">&times;</button></div>';
        }).join('')
      : '<div class="al-empty">No traits picked. A rank on its own works too.</div>';

    var tiers = ctx.TIERS.map(function (t) {
      var on = draft.tiers.indexOf(t.id) !== -1;
      return '<button class="al-pill' + (on ? ' on' : '') + '" onclick="MLAlerts.toggleTier(\'' + t.id + '\')">' + esc(t.label) + '</button>';
    }).join('');

    var caps = [null, 10, 25, 50].map(function (p) {
      var on = draft.capAbs == null && draft.capPct === p;
      return '<button class="al-pill' + (on ? ' on' : '') + '" onclick="MLAlerts.setCap(' + (p === null ? 'null' : p) + ')">' +
        (p === null ? 'Any' : '+' + p + '%') + '</button>';
    }).join('');

    var capNow = capFor(draft);
    var hint = capNow == null
      ? 'Pings on any listing that matches.'
      : 'Pings on listings up to <b>' + capNow.toFixed(2) + ' SOL</b>, fees included.';
    if (f == null) hint = 'Floor not loaded yet — the cap will follow it once it is.';

    var ready = draft.traits.length > 0 || draft.tiers.length > 0;

    el.innerHTML =
      '<div class="al-rail-row"><h4>Match</h4>' +
        '<div class="al-seg">' +
          '<button class="' + (draft.mode === 'any' ? 'on' : '') + '" onclick="MLAlerts.setMode(\'any\')">Any</button>' +
          '<button class="' + (draft.mode === 'all' ? 'on' : '') + '" onclick="MLAlerts.setMode(\'all\')">All</button>' +
        '</div></div>' +
      '<h4>Traits</h4><div class="al-chips">' + chips + '</div>' +
      '<h4>Rarity rank</h4><div class="al-pills">' + tiers + '</div>' +
      '<div class="al-rail-row"><h4>Price cap</h4>' +
        '<span class="al-floor">floor ' + (f == null ? '—' : f.toFixed(2)) + ' SOL</span></div>' +
      '<div class="al-pills">' + caps + '</div>' +
      '<p class="al-hint">' + hint + '</p>' +
      '<button class="btn al-save"' + (ready ? '' : ' disabled') + ' onclick="MLAlerts.saveDraft()">Turn on alert</button>' +
      '<p class="al-foot">Rules stay in this browser. Pings arrive while this tab is open.</p>';
  }

  function renderRules() {
    var el = document.getElementById('al-rules');
    if (!el) return;
    if (!rules.length) {
      el.innerHTML = '<div class="al-empty-box">No alerts yet. Pick a trait or a rank on the left, then turn it on.</div>';
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
          '<button class="al-mini" onclick="MLAlerts.removeRule(' + i + ')" aria-label="Delete alert">Delete</button>' +
        '</div></div>';
    }).join('');
  }

  function renderFeed() {
    var el = document.getElementById('al-feed');
    if (!el) return;
    if (!feed.length) {
      el.innerHTML = '<div class="al-empty-box">Nothing yet. Matching listings will appear here as they happen.</div>';
      return;
    }
    el.innerHTML = feed.map(function (h) {
      var over = h.overFloor == null ? '' : '<span class="al-over' + (h.overFloor <= 0 ? ' under' : '') + '">' +
        (h.overFloor >= 0 ? '+' : '') + h.overFloor + '%</span>';
      return '<a class="al-hit" href="' + esc(meUrl(h.num)) + '" target="_blank" rel="noopener noreferrer">' +
        '<img src="' + ctx.thumb(h.num, 96) + '" data-num="' + h.num + '" onerror="thumbFallback(this)" alt="" loading="lazy" width="44" height="44">' +
        '<span style="min-width:0"><div class="al-hit-t">Mad Lad #' + h.num + '</div>' +
        '<div class="al-hit-s">' + esc(h.rule) + '</div></span>' +
        '<span class="al-hit-p">' + h.price.toFixed(2) + ' SOL ' + over + '</span></a>';
    }).join('');
  }

  function renderStatus() {
    var el = document.getElementById('al-status');
    if (!el) return;
    var n = activeRules().length;
    var txt, cls;
    if (!n) { txt = 'No active alerts'; cls = 'off'; }
    else if (pollState.status === 'error') { txt = 'Connection problem — retrying'; cls = 'bad'; }
    else if (pollState.status === 'checking') { txt = 'Checking listings…'; cls = 'on'; }
    else if (pollState.at) {
      var secs = Math.round((Date.now() - pollState.at) / 1000);
      txt = 'Watching ' + n + (n === 1 ? ' alert' : ' alerts') + ' · checked ' + (secs < 60 ? secs + 's' : Math.round(secs / 60) + 'm') + ' ago';
      cls = 'on';
    } else { txt = 'Watching ' + n + (n === 1 ? ' alert' : ' alerts'); cls = 'on'; }

    var perm = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
    var ask = (n && perm === 'default')
      ? '<button class="al-mini" onclick="MLAlerts.askPermission()">Enable notifications</button>'
      : '';
    var warn = (n && perm === 'denied')
      ? '<span class="al-tag warn">Notifications blocked — hits still show below</span>'
      : '';

    el.innerHTML = '<span class="al-dot ' + cls + '"></span><span class="al-status-t">' + esc(txt) + '</span>' + ask + warn;
  }

  // ---- public actions ------------------------------------------------------
  var api = {
    init: function (context) {
      ctx = context;
      rules = load();
      draft = newDraft();
      render();
      // The price cap is a percentage over the floor, so the builder needs the
      // floor even before the first rule exists.
      refreshFloor().then(render);
      syncTimer();
      // Keeps "checked 40s ago" honest without polling any harder.
      setInterval(renderStatus, 10000);
    },
    onShow: function () { render(); if (activeRules().length && !primed) poll(); },
    setCat: function (i) { draft.cat = i; renderPicker(); },
    find: function (input) {
      var q = input.value.trim().toLowerCase();
      var rows = input.parentNode.querySelectorAll('.al-row');
      for (var i = 0; i < rows.length; i++) {
        rows[i].style.display = (!q || rows[i].getAttribute('data-name').indexOf(q) !== -1) ? '' : 'none';
      }
    },
    toggleTrait: function (k, v) {
      var at = -1;
      for (var i = 0; i < draft.traits.length; i++) if (draft.traits[i].k === k && draft.traits[i].v === v) at = i;
      if (at === -1) draft.traits.push({ k: k, v: v }); else draft.traits.splice(at, 1);
      renderPicker(); renderRail();
    },
    dropTrait: function (i) { draft.traits.splice(i, 1); renderPicker(); renderRail(); },
    toggleTier: function (id) {
      var at = draft.tiers.indexOf(id);
      if (at === -1) draft.tiers.push(id); else draft.tiers.splice(at, 1);
      renderRail();
    },
    setMode: function (m) { draft.mode = m; renderRail(); },
    setCap: function (p) { draft.capAbs = null; draft.capPct = p; renderRail(); },
    saveDraft: function () {
      if (!draft.traits.length && !draft.tiers.length) return;
      rules.unshift({
        traits: draft.traits.slice(), tiers: draft.tiers.slice(), mode: draft.mode,
        capPct: draft.capPct, capAbs: draft.capAbs, enabled: true, hits: 0, created: Date.now()
      });
      save();
      draft = newDraft();
      api.askPermission();
      render();
      syncTimer();
    },
    toggleRule: function (i) {
      if (!rules[i]) return;
      rules[i].enabled = !rules[i].enabled;
      save(); render(); syncTimer();
    },
    removeRule: function (i) {
      if (!rules[i]) return;
      rules.splice(i, 1);
      save(); render(); syncTimer();
    },
    askPermission: function () {
      try {
        if (typeof Notification === 'undefined' || Notification.permission !== 'default') { renderStatus(); return; }
        var p = Notification.requestPermission();
        if (p && p.then) p.then(function () { renderStatus(); });
      } catch (e) { /* older browsers throw on the promise form */ }
    }
  };

  window.MLAlerts = api;
})();
