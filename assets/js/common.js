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

// Nav dropdowns: mark the section you're on, and close after a click on the same page.
(function(){
  function mark(){
    var subs = document.querySelectorAll('.nav-sub');
    for(var i = 0; i < subs.length; i++){
      var links = subs[i].querySelectorAll('a'), hashes = [];
      for(var j = 0; j < links.length; j++) hashes.push(links[j].hash);
      var here = hashes.indexOf(location.hash) !== -1 ? location.hash : hashes[0];
      for(var k = 0; k < links.length; k++){
        var on = links[k].pathname === location.pathname && links[k].hash === here;
        links[k].classList.toggle('current', on);
        if(on) links[k].setAttribute('aria-current', 'location'); else links[k].removeAttribute('aria-current');
      }
    }
  }
  function init(){
    mark();
    var items = document.querySelectorAll('.nav-item');
    for(var i = 0; i < items.length; i++){
      items[i].addEventListener('click', function(e){
        if(e.target.closest('.nav-sub a')){ this.classList.add('closed'); if(document.activeElement) document.activeElement.blur(); }
      });
      items[i].addEventListener('mouseleave', function(){ this.classList.remove('closed'); });
    }
  }
  window.addEventListener('hashchange', mark);
  // Pages rewrite the hash with replaceState when switching views; catch that too.
  var rs = history.replaceState;
  history.replaceState = function(){ var r = rs.apply(history, arguments); mark(); return r; };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
