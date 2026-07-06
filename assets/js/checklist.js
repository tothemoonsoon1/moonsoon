/* ============================================================
   checklist.js — task state, render, counter, reset, QR
   tothemoonsoon.xyz
   ============================================================ */

var WALLET = 'C5maywT6FNqLZVi9m94yKc1RCstd18gYs6Cv1bzFPyD3';

var TASKS = [
  't-diag','t-wallet','t-genesis',
  't-stake','t-defi','t-nft',
  't-dstore','t-seedv','t-variety','t-notif',
  't-download1','t-download2','t-download3',
  't-engage','t-review','t-skrstake'
];

var state = { tasks: {}, swaps: 0, streak: 0 };

/* ---- Interactions ---- */

function toggleTask(id) {
  state.tasks[id] = !state.tasks[id];
  var el = document.getElementById(id);
  if (el) {
    el.classList.toggle('done', !!state.tasks[id]);
    el.setAttribute('aria-checked', state.tasks[id] ? 'true' : 'false');
    var cb = el.querySelector('.checkbox');
    var ci = el.querySelector('.ci');
    if (cb && ci) {
      if (state.tasks[id]) {
        cb.style.background  = 'linear-gradient(135deg,#9945FF,#14F195)';
        cb.style.borderColor = 'transparent';
        ci.style.display     = 'block';
      } else {
        cb.style.background  = '';
        cb.style.borderColor = '';
        ci.style.display     = 'none';
      }
    }
  }
  render();
}

function adjustCounter(delta) { state.swaps = Math.min(50, Math.max(0, state.swaps + delta)); render(); }
function toggleSection(id) {
  var body = document.getElementById(id + '-body');
  var chev = document.getElementById(id + '-chev');
  var head = body.previousElementSibling;
  body.classList.toggle('open');
  chev.classList.toggle('open');
  if (head) head.setAttribute('aria-expanded', body.classList.contains('open') ? 'true' : 'false');
}

function resetAll() {
  state.tasks = {}; state.swaps = 0;
  TASKS.forEach(function(id) {
    var el = document.getElementById(id); if (!el) return;
    el.classList.remove('done');
    el.setAttribute('aria-checked', 'false');
    var cb = el.querySelector('.checkbox'); var ci = el.querySelector('.ci');
    if (cb) { cb.style.background = ''; cb.style.borderColor = ''; }
    if (ci) { ci.style.display = 'none'; }
  });
  render();
}

function copyWallet() {
  navigator.clipboard.writeText(WALLET).then(function() {
    var btn = document.getElementById('copy-btn');
    if (btn) { btn.textContent = 'OK'; setTimeout(function() { btn.innerHTML = '&#10697;'; }, 2000); }
  });
}

/* ---- Render ---- */

function render() {
  TASKS.forEach(function(id) { var el = document.getElementById(id); if (el) el.classList.toggle('done', !!state.tasks[id]); });

  var swaps = state.swaps;
  document.getElementById('swaps-val').textContent   = swaps;
  document.getElementById('swaps-label').textContent = swaps + ' / 50';
  document.getElementById('swaps-fill').style.width  = Math.min(100, (swaps / 50) * 100) + '%';
  document.getElementById('swaps-fill').parentElement.setAttribute('aria-valuenow', swaps);

  var sections = {
    setup:   { tasks: ['t-diag','t-wallet','t-genesis'], total: 3 },
    onchain: { tasks: ['t-stake','t-defi','t-nft'], total: 4, counter: true },
    phone:   { tasks: ['t-dstore','t-seedv','t-variety','t-notif'], total: 4 },
    dapps:   { tasks: ['t-download1','t-download2','t-download3','t-engage','t-review'], total: 5 },
    staking: { tasks: ['t-skrstake'], total: 1 }
  };
  Object.keys(sections).forEach(function(sec) {
    var cfg  = sections[sec];
    var done = cfg.tasks.filter(function(t) { return state.tasks[t]; }).length;
    if (cfg.counter && swaps >= 50) done++;
    var badge = document.getElementById(sec + '-prog');
    if (badge) badge.textContent = done + '/' + cfg.total;
  });

  var dailyTasks = ['t-stake','t-defi','t-nft','t-dstore','t-seedv','t-variety','t-notif','t-download1','t-download2','t-download3','t-engage','t-review','t-skrstake'];
  var totalTasks   = dailyTasks.length + 1;
  var swapProgress = Math.min(1, swaps / 50);
  var doneTasks    = dailyTasks.filter(function(t) { return state.tasks[t]; }).length + swapProgress;
  var pct          = Math.round((doneTasks / totalTasks) * 100);

  document.getElementById('overall-pct').textContent = pct + '%';
  var bar = document.getElementById('main-bar');
  bar.style.width = pct + '%';
  bar.parentElement.setAttribute('aria-valuenow', pct);
  document.getElementById('tasks-done').textContent  = Math.floor(doneTasks);
  document.getElementById('tasks-total').textContent = totalTasks;
  document.getElementById('streak-val').textContent  = state.streak || 0;

  var onchainDone = ['t-stake','t-defi','t-nft'].filter(function(t) { return state.tasks[t]; }).length;
  var swapLevel   = swaps >= 50 ? 2 : swaps >= 20 ? 1 : 0;
  var level       = Math.min(5, swapLevel + onchainDone);

  document.getElementById('chain-level').textContent = 'Lv ' + level;
  document.getElementById('level-txt').textContent   = 'Level ' + level + ' / 5 (estimated)';
  for (var i = 1; i <= 5; i++) { document.getElementById('pip' + i).classList.toggle('on', i <= level); }
}

/* ---- QR code ---- */

function initQR() {
  if (typeof QRCode === 'undefined') return;
  var c1 = document.getElementById('qr-container');
  if (c1) new QRCode(c1, { text: 'solana:' + WALLET, width: 100, height: 100, colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
  var c2 = document.getElementById('qr-mobile');
  if (c2) new QRCode(c2, { text: 'solana:' + WALLET, width: 90,  height: 90,  colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
}
