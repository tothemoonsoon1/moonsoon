/* tothemoonsoon shared helpers, used by all five pages (loaded before each page's inline script).
   Cached for a year (netlify.toml): bump ?v= in the five <script> tags after every edit. */
function escAttr(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
var esc = escAttr;

function toggleTheme(){
  var isLight = document.documentElement.getAttribute('data-theme')==='light';
  document.documentElement.setAttribute('data-theme', isLight?'dark':'light');
  try{ localStorage.setItem('moonsoon_theme', isLight?'dark':'light'); }catch(e){}
  var tc=document.querySelector('meta[name="theme-color"]'); if(tc){ tc.setAttribute('content', isLight?'#0b0d12':'#f5f6f8'); }
}

function timeAgo(ts){
  var m = Math.floor((Date.now() - ts) / 60000);
  if(m < 60) return Math.max(m,1)+'m';
  var h = Math.floor(m/60); if(h < 24) return h+'h';
  var d = Math.floor(h/24); if(d < 30) return d+'d';
  var mo = Math.floor(d/30); if(mo < 12) return mo+'mo';
  return Math.floor(d/365)+'y';
}

// Trait panel search: hide rows whose data-name doesn't contain the query.
function tpFind(input){
  var q = input.value.trim().toLowerCase();
  var rows = input.parentNode.querySelectorAll('.tp-row');
  for(var i = 0; i < rows.length; i++) rows[i].style.display = !q || rows[i].getAttribute('data-name').indexOf(q) !== -1 ? '' : 'none';
}
