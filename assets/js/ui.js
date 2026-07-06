/* ============================================================
   ui.js — drawer, bottom sheet, dApp category filter
   tothemoonsoon.xyz
   ============================================================ */

/* ---- Drawer (mobile nav) ---- */
function openDrawer()  { document.getElementById('drawer').classList.add('open');    document.getElementById('drawer-backdrop').classList.add('open'); document.getElementById('drawer-backdrop').removeAttribute('aria-hidden'); }
function closeDrawer() { document.getElementById('drawer').classList.remove('open'); document.getElementById('drawer-backdrop').classList.remove('open'); document.getElementById('drawer-backdrop').setAttribute('aria-hidden', 'true'); }

/* ---- Bottom sheet (mobile news) ---- */
function openBS()  { document.getElementById('bs-panel').classList.add('open');    document.getElementById('bs-backdrop').classList.add('open'); document.getElementById('bs-backdrop').removeAttribute('aria-hidden'); }
function closeBS() { document.getElementById('bs-panel').classList.remove('open'); document.getElementById('bs-backdrop').classList.remove('open'); document.getElementById('bs-backdrop').setAttribute('aria-hidden', 'true'); }

/* ---- dApp category filter ---- */
function setDappCat(cat, btn) {
  document.querySelectorAll('.ftab').forEach(function(t) { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  btn.classList.add('active');
  btn.setAttribute('aria-selected', 'true');
  document.querySelectorAll('.fentry').forEach(function(el) { el.classList.toggle('on', el.dataset.cat === cat); });
}

/* ---- Resize cleanup ---- */
window.addEventListener('resize', function() {
  if (window.innerWidth > 1200) closeBS();
  if (window.innerWidth > 768)  closeDrawer();
});

/* ---- Init on load ---- */
window.addEventListener('load', function() {
  initQR();
  render();
  fetchPrices();
  calcUpdate();
  setDappCat('wallets', document.querySelector('.ftab'));
});
