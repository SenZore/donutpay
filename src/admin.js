// Admin routes: session login, dashboard data, manual order, stock, settings.
const crypto = require('crypto')

const sessions = new Map() // token -> expiry ms
const SESSION_TTL = 12 * 60 * 60 * 1000

function newSession() {
  const token = crypto.randomBytes(24).toString('hex')
  sessions.set(token, Date.now() + SESSION_TTL)
  return token
}

function checkSession(req) {
  const token = req.headers['x-admin-token'] || req.query.token
  if (!token) return false
  const exp = sessions.get(token)
  if (!exp || exp < Date.now()) { sessions.delete(token); return false }
  return true
}

function csv(res, head, rows) {
  res.set('Content-Type', 'text/csv; charset=utf-8')
  res.send(head + rows.join('\n'))
}

module.exports = function adminRoutes(app, { db, bot, donutapi, env, loginRateLimit }) {
  const auth = (req, res, next) =>
    checkSession(req) ? next() : res.status(401).json({ error: 'unauthorized' })

  const loginLimiter = loginRateLimit || ((req, res, next) => next())

  app.post('/admin/login', loginLimiter, (req, res) => {
    const { user, pass } = req.body || {}
    if (user === env.ADMIN_USER && pass === env.ADMIN_PASSWORD) {
      db.log('info', 'admin login ok')
      return res.json({ token: newSession() })
    }
    db.log('warn', 'admin login gagal')
    res.status(401).json({ error: 'username atau password salah' })
  })

  app.get('/admin/logout', (req, res) => {
    sessions.delete(req.headers['x-admin-token'] || req.query.token)
    res.json({ ok: true })
  })

  app.get('/admin/overview', auth, async (req, res) => {
    const s = db.stats()
    let stock = null
    if (env.DONUT_API_KEY && env.MC_USERNAME) {
      try {
        const b = await donutapi.balance(env)
        stock = { money: b.money, millions: b.millions, as_of: Date.now() }
      } catch (err) {
        stock = { error: err.message }
      }
    }
    res.json({
      bot_online: bot.isOnline(),
      queue: bot.queueSize(),
      pending: s.pending || 0,
      paid: s.paid || 0,
      delivered: s.delivered || 0,
      canceled: (s.canceled || 0) + (s.expired || 0),
      stock,
      rate: Number(db.getCfg("rate", env.RATE)),
      show_stock: db.getCfg('show_stock', '1') === '1',
      provider: (env.PAYMENT_PROVIDER || 'pakasir'),
      mode: env.PAYMENT_MODE || 'sandbox',
    })
  })

  app.get('/admin/orders', auth, (req, res) => {
    res.json(db.recentOrders(200))
  })

  app.get('/admin/logs', auth, (req, res) => {
    res.json(db.recentLogs(200).reverse())
  })

  // Manual order: bikin order langsung 'paid' tanpa pembayaran, antre delivery.
  app.post('/admin/order', auth, (req, res) => {
    const user = String(req.body?.user || '').trim()
    const amt = Number(req.body?.amt)
    if (!/^\w{3,16}$/.test(user)) return res.status(400).json({ error: 'username tidak valid' })
    if (!Number.isFinite(amt) || amt < 1 || amt > 1000) return res.status(400).json({ error: 'jumlah 1-1000' })
    const id = 'MANUAL-' + crypto.randomBytes(4).toString('hex').toUpperCase()
    db.createOrder({ id, user, amt, amount: 0 })
    db.markPaid(id)
    db.log('info', `admin manual order ${id}: ${user} ${amt}M (gratis)`)
    bot.enqueue(id)
    res.json({ id, ok: true })
  })

  app.post('/admin/requeue', auth, (req, res) => {
    const o = db.getOrder(req.body?.id)
    if (!o) return res.status(404).json({ error: 'not found' })
    if (o.status === 'pending') db.markPaid(o.id)
    bot.enqueue(o.id)
    db.log('info', `admin requeue ${o.id}`)
    res.json({ ok: true })
  })

  app.post('/admin/settings', auth, (req, res) => {
    const { rate, show_stock } = req.body || {}
    if (rate !== undefined) {
      const r = Number(rate)
      if (!Number.isFinite(r) || r <= 0) return res.status(400).json({ error: 'rate tidak valid' })
      db.setCfg('rate', r)
      db.log('info', `admin set rate = ${r}`)
    }
    if (show_stock !== undefined) {
      db.setCfg('show_stock', show_stock ? '1' : '0')
    }
    res.json({ ok: true })
  })

  app.get('/admin/orders.csv', auth, (req, res) => {
    csv(res, 'id,user,amt,amount,status,ts,paid_ts,delivered_ts,attempts\n',
      db.allOrders().map(o => [o.id, o.user, o.amt, o.amount, o.status,
        new Date(o.ts).toISOString(), o.paid_ts ? new Date(o.paid_ts).toISOString() : '',
        o.delivered_ts ? new Date(o.delivered_ts).toISOString() : '', o.attempts].join(',')))
  })

  app.get('/admin/logs.csv', auth, (req, res) => {
    csv(res, 'ts,level,msg\n',
      db.allLogs().map(l => [new Date(l.ts).toISOString(), l.level, `"${String(l.msg).replaceAll('"', '""')}"`].join(',')))
  })
}
