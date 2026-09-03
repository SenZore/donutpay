const $ = id => document.getElementById(id)
let token = localStorage.getItem('dp_admin_token') || null
let refreshTimer = null

// Never trust data going into innerHTML — order.user, order.id, and log
// messages can contain attacker-controlled text (e.g. webhook order_id).
const esc = s => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]))

const headers = () => ({ 'Content-Type': 'application/json', 'x-admin-token': token })

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } })
  if (r.status === 401 && !url.includes('/login')) { logout(); throw new Error('session habis') }
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}

const idr = n => 'Rp' + Math.round(n).toLocaleString('id-ID')
const fmtStock = m => m >= 1000 ? (m / 1000).toFixed(2) + 'B' : Math.round(m) + 'M'

function show(view) {
  $('loginview').classList.toggle('hidden', view !== 'login')
  $('dashview').classList.toggle('hidden', view !== 'dash')
}

async function login() {
  $('lmsg').textContent = ''
  try {
    const r = await fetch('/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: $('luser').value.trim(), pass: $('lpass').value })
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'gagal')
    token = d.token
    localStorage.setItem('dp_admin_token', token)
    boot()
  } catch (e) { $('lmsg').textContent = e.message }
}

function logout() {
  fetch('/admin/logout', { headers: headers() }).catch(() => {})
  token = null
  localStorage.removeItem('dp_admin_token')
  clearInterval(refreshTimer)
  show('login')
}

async function loadOverview() {
  const d = await api('/admin/overview')
  $('provbadge').textContent = `${d.provider} · ${d.mode}`
  $('botbadge').textContent = d.bot_online ? 'bot online' : 'bot offline'
  $('botbadge').className = 'badge ' + (d.bot_online ? 'on' : 'off')
  const cards = [
    ['Pending', d.pending], ['Paid (antre)', d.paid], ['Delivered', d.delivered],
    ['Batal/Expired', d.canceled], ['Queue Bot', d.queue],
    ['Stok Bot', d.stock == null ? '—' : (d.stock.error ? '⚠ ' + d.stock.error : fmtStock(d.stock.millions) + ' donut')],
  ]
  $('statsrow').innerHTML = cards.map(([k, v]) =>
    `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')
  $('srate').value = d.rate
  $('sstock').checked = d.show_stock
}

async function loadOrders() {
  const rows = await api('/admin/orders')
  $('orderrows').innerHTML = rows.map(o => `<tr>
    <td style="font-family:monospace;font-size:11px">${esc(o.id)}</td>
    <td>${esc(o.user)}</td><td>${esc(o.amt)}M</td><td>${o.amount ? idr(o.amount) : '—'}</td>
    <td><span class="st ${esc(o.status)}">${esc(o.status)}</span></td>
    <td class="muted">${new Date(o.ts).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}</td>
    <td>${o.status === 'paid' ? `<button class="btn ghost sm" onclick="requeue('${esc(o.id)}')">requeue</button>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="7" class="muted" style="padding:16px">Belum ada order.</td></tr>'
}

async function loadLogs() {
  const rows = await api('/admin/logs')
  $('logbox').innerHTML = rows.map(l =>
    `<div class="${esc(l.level)}">[${new Date(l.ts).toLocaleTimeString('id-ID')}] ${esc(l.level)}: ${esc(l.msg)}</div>`).join('')
  $('logbox').scrollTop = $('logbox').scrollHeight
}

async function refresh() {
  try {
    await loadOverview()
    const active = document.querySelector('.tab.active').dataset.tab
    if (active === 'orders') await loadOrders()
    if (active === 'logs') await loadLogs()
  } catch (e) { console.warn(e.message) }
}

function boot() {
  show('dash')
  refresh()
  clearInterval(refreshTimer)
  refreshTimer = setInterval(refresh, 5000)
}

window.requeue = async id => {
  try { await api('/admin/requeue', { method: 'POST', body: JSON.stringify({ id }) }); refresh() }
  catch (e) { alert(e.message) }
}

window.dl = async kind => {
  try {
    const r = await fetch(`/admin/${kind}.csv`, { headers: headers() })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const blob = await r.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${kind}.csv`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) { alert(e.message) }
}

$('loginbtn').onclick = login
$('lpass').addEventListener('keydown', e => { if (e.key === 'Enter') login() })
$('logoutbtn').onclick = logout

document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'))
  t.classList.add('active')
  for (const name of ['orders', 'manual', 'logs', 'settings'])
    $('tab-' + name).classList.toggle('hidden', name !== t.dataset.tab)
  refresh()
})

$('mcreate').onclick = async () => {
  $('mcreate').disabled = true
  $('mmsg').className = 'msg'
  try {
    const d = await api('/admin/order', { method: 'POST', body: JSON.stringify({ user: $('muser').value.trim(), amt: Number($('mamt').value) }) })
    $('mmsg').className = 'msg ok'
    $('mmsg').textContent = `Order ${d.id} dibuat, donut dikirim ke queue.`
    refresh()
  } catch (e) {
    $('mmsg').className = 'msg err'
    $('mmsg').textContent = e.message
  }
  $('mcreate').disabled = false
}

$('ssave').onclick = async () => {
  try {
    await api('/admin/settings', { method: 'POST', body: JSON.stringify({ rate: Number($('srate').value), show_stock: $('sstock').checked }) })
    $('smsg').className = 'msg ok'
    $('smsg').textContent = 'Tersimpan.'
  } catch (e) {
    $('smsg').className = 'msg err'
    $('smsg').textContent = e.message
  }
}

// auto-login kalau token masih valid
if (token) {
  api('/admin/overview').then(boot).catch(() => { token = null; show('login') })
} else {
  show('login')
}
