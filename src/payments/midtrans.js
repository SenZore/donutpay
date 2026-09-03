// Midtrans payment provider (Core API QRIS charge)
const SNAP_BASES = { sandbox: 'https://api.sandbox.midtrans.com', live: 'https://api.midtrans.com' }

async function call(env, method, endpoint, body) {
  const base = SNAP_BASES[env.PAYMENT_MODE === 'live' ? 'live' : 'sandbox']
  const auth = Buffer.from(env.MIDTRANS_SERVER_KEY + ':').toString('base64')
  const res = await fetch(`${base}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  let data
  try { data = await res.json() } catch { throw Object.assign(new Error(`Midtrans HTTP ${res.status}`), { status: res.status }) }
  if (!res.ok) throw Object.assign(new Error(data.error_messages?.join(', ') || data.status_message || `Midtrans HTTP ${res.status}`), { status: res.status })
  return data
}

module.exports = {
  name: 'midtrans',
  async createQris(env, orderId, amount) {
    const d = await call(env, 'POST', '/v2/charge', {
      payment_type: 'qris',
      transaction_details: { order_id: orderId, gross_amount: amount },
    })
    // Core API QRIS returns actions; the qr-string action contains the EMV payload
    const qrAction = (d.actions || []).find(a => a.name === 'generate-qr-code') || {}
    return {
      qr: qrAction.url || d.qr_string,
      total: amount,
      expiredAt: null,
    }
  },
  async checkStatus(env, orderId) {
    const d = await call(env, 'GET', `/v2/${encodeURIComponent(orderId)}/status`)
    const ts = d.transaction_status
    const status =
      ts === 'settlement' || ts === 'capture' ? 'completed' :
      ts === 'cancel' || ts === 'deny' ? 'canceled' :
      ts === 'expire' ? 'expired' : 'pending'
    return { status, method: d.payment_type }
  },
  async cancel(env, orderId) {
    await call(env, 'POST', `/v2/${encodeURIComponent(orderId)}/cancel`)
  },
  async simulate() {
    throw Object.assign(new Error('simulasi midtrans: pakai dashboard sandbox.midtrans.com'), { status: 400 })
  },
}
