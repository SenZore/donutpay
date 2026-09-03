const $ = id => document.getElementById(id)
let rate = 450, current = null, pollTimer = null

async function api(url, opts) {
  const r = await fetch(url, opts)
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}

function show(step) { for (const s of ['step1','step2','step3']) $(s).classList.toggle('hidden', s !== step) }

const idr = n => 'Rp' + Math.round(n).toLocaleString('id-ID')

function updateTotal() {
  const amt = Number($('amt').value)
  $('total').textContent = amt >= 1 ? idr(amt * rate) : '—'
}

async function init() {
  try {
    const cfg = await api('/api/config')
    rate = cfg.rate
    if (cfg.stock != null) {
      $('stockval').textContent = cfg.stock >= 1000 ? (cfg.stock/1000).toFixed(1) + 'B donut' : cfg.stock.toFixed(0) + 'M donut'
      $('stockchip').classList.remove('hidden')
    }
  } catch { /* config gagal gak nge-blok UI */ }
  updateTotal()
}

$('amt').addEventListener('input', updateTotal)
$('user').addEventListener('keydown', e => { if (e.key === 'Enter') $('buy').click() })
$('amt').addEventListener('keydown', e => { if (e.key === 'Enter') $('buy').click() })

$('buy').onclick = async () => {
  $('buy').disabled = true
  $('msg1').textContent = ''
  try {
    const o = await api('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: $('user').value.trim(), amt: Number($('amt').value) })
    })
    current = o
    $('qrinfo').textContent = `${o.user} — ${o.amt}M donut — ${idr(o.amount)}`
    $('qrimg').src = `/api/order/${o.id}/qr.png?t=${Date.now()}`
    show('step2')
    startPoll(o)
  } catch (e) {
    $('msg1').textContent = e.message
  }
  $('buy').disabled = false
}

function startPoll(o) {
  clearInterval(pollTimer)
  const deadline = o.expired_at || Date.now() + 15 * 60 * 1000
  pollTimer = setInterval(async () => {
    const left = deadline - Date.now()
    if (left <= 0) {
      clearInterval(pollTimer)
      $('statustxt').textContent = 'Order kadaluarsa'
      $('countdown').textContent = ''
      return
    }
    const m = Math.floor(left / 60000), s = Math.floor(left % 60000 / 1000)
    $('countdown').textContent = `sisa waktu ${m}:${String(s).padStart(2,'0')}`
    try {
      const st = await api(`/api/order/${o.id}/status`)
      if (st.status === 'paid' || st.status === 'delivered') {
        clearInterval(pollTimer)
        $('doneinfo').textContent = `${o.amt}M donut sedang dikirim ke ${o.user}. Cek in-game sebentar lagi.`
        show('step3')
      } else if (st.status === 'canceled' || st.status === 'expired') {
        clearInterval(pollTimer)
        $('statustxt').textContent = 'Order dibatalkan'
      }
    } catch { /* retry next tick */ }
  }, 3000)
}

$('cancel').onclick = async () => {
  if (!current) return
  try {
    await api(`/api/order/${current.id}/cancel`, { method: 'POST' })
    clearInterval(pollTimer)
    show('step1')
  } catch (e) {
    $('msg2').textContent = e.message
  }
}

$('again').onclick = () => { current = null; show('step1'); updateTotal() }

init()
