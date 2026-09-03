require('dotenv').config()
const express = require('express')
const QRCode = require('qrcode')
const crypto = require('crypto')
const path = require('path')

const db = require('./db')
const loadProvider = require('./payment')
const bot = require('./bot')
const donutapi = require('./donutapi')
const adminRoutes = require('./admin')
const { requeuePaid, startWorker } = require('./worker')

const env = process.env
const payment = loadProvider(env)

const app = express()
// Branding POST bawa data URL gambar (bisa >64kb) → limit lebih besar khusus route itu.
app.use('/admin/branding', express.json({ limit: '600kb' }))
app.use(express.json({ limit: '64kb' }))
app.use(express.static(path.join(__dirname, '..', 'public')))
app.set('etag', false)

const RATE = Number(env.RATE || 450)
const ORDER_TTL_MS = 15 * 60 * 1000

// Only trust cf-connecting-ip when the app actually sits behind Cloudflare
// (TRUST_CF_HEADER=1 in .env) — otherwise anyone can send a random value for
// this header on every request and get a fresh rate-limit bucket each time.
function clientIp(req) {
  if (env.TRUST_CF_HEADER === '1' && req.headers['cf-connecting-ip']) return req.headers['cf-connecting-ip']
  return req.ip
}

function makeRateLimiter({ max, windowMs }) {
  const hits = new Map()
  return (req, res, next) => {
    const ip = clientIp(req)
    const cutoff = Date.now() - windowMs
    const list = (hits.get(ip) || []).filter(t => t > cutoff)
    list.push(Date.now())
    hits.set(ip, list)
    if (list.length > max) return res.status(429).json({ error: 'terlalu sering, coba lagi nanti' })
    next()
  }
}

const rateLimit = makeRateLimiter({ max: 8, windowMs: 60_000 })
// Stricter bucket for admin login to slow down password brute-forcing.
const loginRateLimit = makeRateLimiter({ max: 5, windowMs: 5 * 60_000 })

function newOrderId() {
  return 'DP' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase()
}

const currentRate = () => Number(db.getCfg('rate', RATE))

// Branding publik: nama toko, tagline, favicon & icon (data URL, '' = belum diset).
app.get('/api/branding', (req, res) => {
  res.json({
    name: db.getCfg('brand_name', 'DonutPay'),
    tagline: db.getCfg('brand_tagline', ''),
    favicon: db.getCfg('brand_favicon', ''),
    icon: db.getCfg('brand_icon', ''),
  })
})

app.get('/api/config', async (req, res) => {
  let stock = null
  if (db.getCfg('show_stock', '1') === '1' && env.DONUT_API_KEY && env.MC_USERNAME) {
    try {
      const b = await donutapi.balance(env)
      stock = b.millions
    } catch { /* stock gagal bukan masalah fatal */ }
  }
  res.json({
    rate: currentRate(),
    bot_online: bot.isOnline(),
    provider: payment.name,
    mode: env.PAYMENT_MODE || 'sandbox',
    stock,
  })
})

app.post('/api/order', rateLimit, async (req, res) => {
  const user = String(req.body?.user || '').trim()
  const amt = Number(req.body?.amt)
  if (!/^\w{3,16}$/.test(user)) return res.status(400).json({ error: 'username Minecraft tidak valid' })
  if (!Number.isFinite(amt) || amt < 1 || amt > 1000) return res.status(400).json({ error: 'jumlah harus 1-1000 (juta donut)' })

  const amount = Math.ceil(amt * currentRate())
  if (amount < 500) return res.status(400).json({ error: 'minimal pembayaran Rp500' })

  const id = newOrderId()
  let paymentInfo
  try {
    paymentInfo = await payment.createQris(env, id, amount)
  } catch (err) {
    db.log('error', `createQris ${id}: ${err.message}`)
    return res.status(502).json({ error: 'payment gateway bermasalah, coba lagi sebentar' })
  }

  const expiredAt = paymentInfo.expiredAt || Date.now() + ORDER_TTL_MS
  db.createOrder({ id, user, amt, amount, qr: paymentInfo.qr, expiredAt })
  db.log('info', `order ${id}: ${user} beli ${amt}M donut = Rp${amount}`)
  res.json({ id, user, amt, amount, total: paymentInfo.total ?? amount, expired_at: expiredAt })
})

app.get('/api/order/:id', (req, res) => {
  const o = db.getOrder(req.params.id)
  if (!o) return res.status(404).json({ error: 'not found' })
  res.json({ id: o.id, user: o.user, amt: o.amt, amount: o.amount, status: o.status, expired_at: o.expired_at })
})

app.get('/api/order/:id/status', async (req, res) => {
  const o = db.getOrder(req.params.id)
  if (!o) return res.status(404).json({ error: 'not found' })
  if (o.status === 'pending') await checkPayment(o)
  const fresh = db.getOrder(req.params.id)
  res.json({ status: fresh.status })
})

app.get('/api/order/:id/qr.png', async (req, res) => {
  const o = db.getOrder(req.params.id)
  if (!o || o.status !== 'pending' || !o.qr) return res.status(404).end()
  const png = await QRCode.toBuffer(o.qr, { width: 320, margin: 1 })
  res.set('Content-Type', 'image/png')
  res.set('Cache-Control', 'no-store')
  res.send(png)
})

app.post('/api/order/:id/cancel', async (req, res) => {
  const o = db.getOrder(req.params.id)
  if (!o) return res.status(404).json({ error: 'not found' })
  if (o.status !== 'pending') return res.status(400).json({ error: `status sudah ${o.status}` })
  try {
    await payment.cancel(env, o.id, o.amount)
  } catch (err) {
    db.log('warn', `cancel ${o.id} di gateway: ${err.message}`)
  }
  db.markCanceled(o.id) && db.log('info', `order ${o.id} dibatalkan user`)
  res.json({ ok: true })
})

// Webhook: Pakasir maupun Midtrans kirim notifikasi ke sini.
// Tidak ada signature yang bisa dipercaya, jadi selalu re-verify ke gateway.
app.post('/webhook/:provider', async (req, res) => {
  res.json({ ok: true })
  const orderId = String(req.body?.order_id || '')
  // Our own order ids only ever look like DP... or MANUAL-...; anything else
  // is not a real order and must not be logged verbatim (untrusted input).
  if (!/^[A-Z0-9-]{3,40}$/.test(orderId)) {
    return db.log('warn', 'webhook: order_id malformed, ignored')
  }
  const o = db.getOrder(orderId)
  if (!o) return db.log('warn', `webhook unknown order ${orderId}`)
  await checkPayment(o)
})

async function checkPayment(o) {
  try {
    const tx = await payment.checkStatus(env, o.id, o.amount)
    if (tx.status === 'completed' && db.markPaid(o.id)) {
      db.log('info', `order ${o.id} paid (${tx.method || 'qris'})`)
      bot.enqueue(o.id)
    } else if (tx.status === 'canceled' || tx.status === 'expired') {
      db.markExpired(o.id)
    }
  } catch (err) {
    if (err.status !== 404) db.log('error', `check ${o.id}: ${err.message}`)
  }
}

app.get('/api/stats', (req, res) => {
  const s = db.stats()
  res.json({ bot_online: bot.isOnline(), queue: bot.queueSize(), pending: s.pending || 0, uptime: Math.floor(process.uptime()) })
})

adminRoutes(app, { db, bot, donutapi, env, loginRateLimit })

// Sandbox helper (Pakasir only, blocked di live)
app.post('/api/dev/simulate', async (req, res) => {
  if (env.PAYMENT_MODE === 'live') return res.status(403).json({ error: 'simulasi cuma buat sandbox' })
  const token = req.query.token || req.headers['x-admin-token']
  if (token !== env.ADMIN_PASSWORD) return res.status(401).json({ error: 'wrong password' })
  const o = db.getOrder(req.body?.id)
  if (!o) return res.status(404).json({ error: 'not found' })
  try {
    await payment.simulate(env, o.id, o.amount)
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

if (require.main === module) {
  const need = {
    pakasir: ['PAKASIR_SLUG', 'PAKASIR_API_KEY'],
    midtrans: ['MIDTRANS_SERVER_KEY'],
  }[payment.name] || []
  const missing = need.filter(k => !env[k])
  if (missing.length) {
    console.error(`env kurang buat provider ${payment.name}: ${missing.join(', ')}. Cek .env.`)
    process.exit(1)
  }
  bot.setLogger(db.log)
  bot.createBot({
    host: env.MC_HOST || 'donutsmp.net',
    port: Number(env.MC_PORT || 25565),
    username: env.MC_USERNAME,
    version: env.MC_VERSION || '1.21.1',
    profilesFolder: env.MC_AUTH_CACHE || path.join(__dirname, '..', 'auth_cache'),
  })
  requeuePaid(db, bot)
  startWorker(db, { transactionDetail: (id, amt) => payment.checkStatus(env, id, amt) }, bot)
  const port = Number(env.PORT || 3000)
  app.listen(port, () => console.log(`donutpay di http://localhost:${port} | provider=${payment.name} | rate=Rp${currentRate()}/1M`))
}

module.exports = { app, checkPayment }
