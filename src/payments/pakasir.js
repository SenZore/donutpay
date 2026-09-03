// Pakasir payment provider (https://pakasir.com)
const BASE = 'https://app.pakasir.com/api'

async function call(env, method, endpoint, body) {
  const res = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project: env.PAKASIR_SLUG,
      api_key: env.PAKASIR_API_KEY,
      ...body,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  let data
  try { data = await res.json() } catch { throw Object.assign(new Error(`Pakasir HTTP ${res.status}`), { status: res.status }) }
  if (!res.ok) throw Object.assign(new Error(data.message || `Pakasir HTTP ${res.status}`), { status: res.status })
  return data
}

module.exports = {
  name: 'pakasir',
  async createQris(env, orderId, amount) {
    const d = await call(env, 'POST', '/transactioncreate/qris', {
      order_id: orderId,
      amount,
      expired: 15, // minutes
    })
    return {
      qr: d.transaction?.payment_number,
      total: d.transaction?.total_payment ?? amount,
      expiredAt: d.transaction?.expired_at ? Date.parse(d.transaction.expired_at) : null,
    }
  },
  // { status: 'pending'|'completed'|'canceled'|'expired', method }
  async checkStatus(env, orderId, amount) {
    const d = await call(env, 'GET', `/transactiondetail?order_id=${encodeURIComponent(orderId)}&amount=${amount}`)
    const t = d.transaction || {}
    return { status: t.status || 'pending', method: t.payment_method }
  },
  async cancel(env, orderId, amount) {
    await call(env, 'POST', '/canceltransaction', { order_id: orderId, amount })
  },
  // Sandbox-only test helper
  async simulate(env, orderId, amount) {
    await call(env, 'POST', '/paymentsimulation', { order_id: orderId, amount })
  },
}
