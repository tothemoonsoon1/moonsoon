/* ============================================================
   calculator.js — SKR staking compound calculator + Chart.js
   tothemoonsoon.xyz
   ============================================================ */

var stakingChart = null;

function fmtS(n) { if (n >= 1e6) return (n/1e6).toFixed(2)+'M'; if (n >= 1e3) return (n/1e3).toFixed(2)+'K'; return n.toFixed(2); }
function fmtU(n) { if (n >= 1e6) return '$'+(n/1e6).toFixed(2)+'M'; if (n >= 1e3) return '$'+(n/1e3).toFixed(2)+'K'; return '$'+n.toFixed(2); }

function compoundBal(principal, days) {
  var apy     = parseFloat(document.getElementById('c-apy').value) || 19.5;
  var ppy     = 8760 / 48; // periods per year (48h unstaking cycle)
  var periods = Math.floor(days * (ppy / 365));
  return principal * Math.pow(1 + (apy / 100) / ppy, periods);
}

function calcUpdate() {
  var amount = parseFloat(document.getElementById('c-amount').value) || 1000;
  var price  = parseFloat(document.getElementById('c-price').value)  || 0.021;

  document.getElementById('c-slider').value       = Math.min(amount, 1000000);
  document.getElementById('c-price-slider').value = Math.min(price, 1);

  var b30 = compoundBal(amount, 30);
  var b6m = compoundBal(amount, 182);
  var b1y = compoundBal(amount, 365);

  document.getElementById('c-30d').textContent     = '+' + fmtS(b30 - amount) + ' SKR';
  document.getElementById('c-30d-usd').textContent = fmtU((b30 - amount) * price) + ' earned';
  document.getElementById('c-6m').textContent      = '+' + fmtS(b6m - amount) + ' SKR';
  document.getElementById('c-6m-usd').textContent  = fmtU((b6m - amount) * price) + ' earned';
  document.getElementById('c-1y').textContent      = '+' + fmtS(b1y - amount) + ' SKR';
  document.getElementById('c-1y-usd').textContent  = fmtU((b1y - amount) * price) + ' earned';

  var labels = [], data = [];
  for (var d = 0; d <= 365; d += 14) { labels.push(d === 0 ? 'Now' : 'D'+d); data.push(parseFloat(compoundBal(amount, d).toFixed(2))); }

  if (stakingChart) {
    stakingChart.data.labels = labels;
    stakingChart.data.datasets[0].data = data;
    stakingChart.update();
  } else {
    var ctx = document.getElementById('c-chart').getContext('2d');
    stakingChart = new Chart(ctx, {
      type: 'line',
      data: { labels: labels, datasets: [{ data: data, borderColor: '#9945FF', backgroundColor: 'rgba(153,69,255,0.08)', borderWidth: 2, fill: true, tension: 0.4, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: '#14F195' }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(10,10,20,0.9)', borderColor: 'rgba(153,69,255,0.3)', borderWidth: 1,
            titleColor: 'rgba(255,255,255,0.5)', bodyColor: '#14F195',
            callbacks: { label: function(ctx) { var p = parseFloat(document.getElementById('c-price').value)||0.021; return fmtS(ctx.raw)+' SKR ('+fmtU(ctx.raw*p)+')'; } }
          }
        },
        scales: {
          x: { ticks: { color: 'rgba(255,255,255,0.3)', font: { size: 9 }, maxTicksLimit: 7 }, grid: { color: 'rgba(255,255,255,0.04)' } },
          y: { ticks: { color: 'rgba(255,255,255,0.3)', font: { size: 9 }, callback: function(v) { return fmtS(v); } }, grid: { color: 'rgba(255,255,255,0.04)' } }
        }
      }
    });
  }

  var periods = [{label:'1 week',days:7},{label:'1 month',days:30},{label:'3 months',days:90},{label:'6 months',days:182},{label:'1 year',days:365}];
  var html = '';
  periods.forEach(function(p) {
    var bal = compoundBal(amount, p.days); var earned = bal - amount;
    html += '<div class="breakdown-row"><span style="font-size:12px;color:rgba(255,255,255,0.6);">After '+p.label+'</span><div style="text-align:right;"><div style="font-size:12px;font-weight:600;color:#14F195;">+'+fmtS(earned)+' SKR</div><div style="font-size:10px;color:var(--muted);margin-top:1px;">'+fmtU(earned*price)+' &bull; Total: '+fmtS(bal)+' SKR</div></div></div>';
  });
  document.getElementById('c-breakdown').innerHTML = html;
}
