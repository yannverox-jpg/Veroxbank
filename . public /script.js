// ------------------------------
// Lyra Banque Panel Script
// ------------------------------

// Auto-refresh wallet every 13 minutes
const REFRESH_INTERVAL = 13 * 60 * 1000; // 13 minutes

const balanceSpan = document.getElementById('balance');
const withdrawForm = document.getElementById('withdrawForm');
const withdrawResult = document.getElementById('withdrawResult');

// Fetch wallet balance
async function fetchBalance() {
  try {
    const res = await fetch('/api/balance');
    if (!res.ok) throw new Error('Failed to fetch balance');
    const data = await res.json();
    balanceSpan.innerText = data.balance ?? '0';
  } catch (err) {
    console.error(err);
    balanceSpan.innerText = 'Error';
  }
}

// Call immediately and set interval
fetchBalance();
setInterval(fetchBalance, REFRESH_INTERVAL);

// Handle withdrawal form submit
withdrawForm.addEventListener('submit', async function(e) {
  e.preventDefault();
  withdrawResult.innerText = '';
  
  const amount = document.getElementById('amount').value.trim();
  const phone = document.getElementById('phone').value.trim();
  const operator = document.getElementById('operator').value;

  if (!amount || !phone) {
    withdrawResult.innerText = 'Amount and phone are required';
    withdrawResult.className = 'error';
    return;
  }

  withdrawResult.innerText = 'Processing...';

  try {
    const res = await fetch(`/api/retrait/${operator}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, phone })
    });

    const data = await res.json();

    if (!res.ok) {
      withdrawResult.innerText = data.message || 'Withdrawal failed';
      withdrawResult.className = 'error';
    } else {
      withdrawResult.innerText = '✅ Withdrawal successful';
      withdrawResult.className = 'success';
      balanceSpan.innerText = data.balance ?? balanceSpan.innerText;
    }

  } catch (err) {
    console.error(err);
    withdrawResult.innerText = 'Network or server error';
    withdrawResult.className = 'error';
  }
});
