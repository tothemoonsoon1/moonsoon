/* ============================================================
   ui.js — drawer, bottom sheet, dApp category filter
   tothemoonsoon.xyz
   ============================================================ */

/* ---- Drawer (mobile nav) ---- */
function openDrawer()  { document.getElementById('drawer').classList.add('open');    document.getElementById('drawer-backdrop').classList.add('open'); }
function closeDrawer() { document.getElementById('drawer').classList.remove('open'); document.getElementById('drawer-backdrop').classList.remove('open'); }

/* ---- Bottom sheet (mobile news) ---- */
function openBS()  { document.getElementById('bs-panel').classList.add('open');    document.getElementById('bs-backdrop').classList.add('open'); }
function closeBS() { document.getElementById('bs-panel').classList.remove('open'); document.getElementById('bs-backdrop').classList.remove('open'); }

/* ---- dApp category filter ---- */
function setDappCat(cat, btn) {
  document.querySelectorAll('.ftab').forEach(function(t) { t.classList.remove('active'); });
  btn.classList.add('active');
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
