// Panel front script: fetch balance, submit withdraw, show history, ping 13min

const balanceEl = document.getElementById('balance');
const withdrawForm = document.getElementById('withdrawForm');
const withdrawResult = document.getElementById('withdrawResult');
const historyEl = document.getElementById('history');

async function apiGet(path){
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('API error: ' + res.status);
  return res.json();
}

async function apiPost(path, body){
  const res = await fetch(path, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    credentials: 'same-origin',
    body: JSON.stringify(body)
  });
  const j = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(j.message || 'API post failed');
  return j;
}

async function fetchBalance(){
  try {
    const j = await apiGet('/api/balance');
    balanceEl.innerText = (j.balance ?? j) + ' ' + (j.currency || '');
  } catch (err) {
    console.error(err);
    balanceEl.innerText = 'Erreur';
  }
}

async function fetchHistory(){
  try {
    const j = await apiGet('/api/history');
    historyEl.innerHTML = '';
    (j || []).forEach(item=>{
      const li = document.createElement('li');
      li.innerText = `${item.date || ''} — ${item.operator || ''} — ${item.amount || ''} — ${item.status || ''}`;
      historyEl.appendChild(li);
    });
  } catch(e){
    console.warn('history fetch failed', e);
  }
}

withdrawForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  withdrawResult.innerText = 'Processing...';
  const amount = document.getElementById('amount').value;
  const phone = document.getElementById('phone').value;
  const operator = document.getElementById('operator').value;
  try {
    const j = await apiPost(`/api/retrait/${operator}`, { amount, phone });
    withdrawResult.innerText = 'Succès: ' + (j.message || 'ok');
    fetchBalance();
    fetchHistory();
  } catch (err) {
    withdrawResult.innerText = 'Erreur: ' + (err.message || err);
  }
});

// initial load + ping every 13 minutes
window.addEventListener('load', ()=>{
  fetchBalance();
  fetchHistory();
  setInterval(()=>{ fetchBalance(); fetchHistory(); }, 13*60*1000);
});
