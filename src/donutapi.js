// DonutSMP Data API client (https://api.donutsmp.net)
// Key didapat in-game dengan /api, dipakai sebagai Bearer token.
const BASE = 'https://api.donutsmp.net'

async function call(env, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${env.DONUT_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.message || `DonutAPI HTTP ${res.status}`), { status: res.status })
  return data
}

// Balance akun bot/shop dalam donut. Values di API adalah number-as-string.
async function balance(env) {
  const d = await call(env, `/v1/stats/${encodeURIComponent(env.MC_USERNAME)}`)
  const money = Number(d.result?.money ?? 0)
  return { money, millions: money / 1_000_000 }
}

module.exports = { balance }
