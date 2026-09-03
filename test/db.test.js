const { test } = require('node:test')
const assert = require('node:assert')
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// Each test file runs against a throwaway DB so they never touch shop.db.
const tmpDb = path.join(require('os').tmpdir(), `donutpay-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = tmpDb
process.env.PAYMENT_PROVIDER = 'pakasir'
process.env.PAKASIR_SLUG = 'testslug'
process.env.PAKASIR_API_KEY = 'testkey'
process.env.ADMIN_USER = 'admin'
process.env.ADMIN_PASSWORD = 'testpass'
process.env.PAYMENT_MODE = 'sandbox'

const db = require('../src/db')

test.after(() => {
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) {
    try { fs.unlinkSync(f) } catch {}
  }
})

test('order lifecycle: pending -> paid -> delivered', () => {
  db.createOrder({ id: 'T1', user: 'oSenz_', amt: 5, amount: 2250 })
  let o = db.getOrder('T1')
  assert.equal(o.status, 'pending')
  assert.equal(o.user, 'oSenz_')

  assert.equal(db.markPaid('T1'), true)
  o = db.getOrder('T1')
  assert.equal(o.status, 'paid')
  assert.ok(o.paid_ts > 0)

  // second writer loses the race
  assert.equal(db.markPaid('T1'), false)

  assert.equal(db.markDelivered('T1'), true)
  o = db.getOrder('T1')
  assert.equal(o.status, 'delivered')
  assert.ok(o.delivered_ts > 0)

  // delivered is terminal: cancel/expire must not touch it
  assert.equal(db.markCanceled('T1'), false)
  assert.equal(db.markExpired('T1'), false)
  assert.equal(db.getOrder('T1').status, 'delivered')
})

test('cancel only works from pending', () => {
  db.createOrder({ id: 'T2', user: 'abc', amt: 1, amount: 450 })
  assert.equal(db.markCanceled('T2'), true)
  assert.equal(db.markPaid('T2'), false) // canceled -> paid blocked
  assert.equal(db.getOrder('T2').status, 'canceled')
})

test('expired_at stored and pendingOrders only returns pending', () => {
  db.createOrder({ id: 'T3', user: 'xyz', amt: 2, amount: 900, expiredAt: Date.now() + 60_000 })
  const pend = db.pendingOrders().map(o => o.id)
  assert.ok(pend.includes('T3'))
  assert.ok(!pend.includes('T1'))
  assert.ok(!pend.includes('T2'))
  db.markExpired('T3')
  assert.equal(db.getOrder('T3').status, 'expired')
})

test('attempts counter', () => {
  db.createOrder({ id: 'T4', user: 'qqq', amt: 1, amount: 450 })
  assert.equal(db.attempts('T4'), 0)
  db.bumpAttempts('T4'); db.bumpAttempts('T4')
  assert.equal(db.attempts('T4'), 2)
})

test('stats + logs', () => {
  const s = db.stats()
  assert.equal(s.delivered, 1)
  assert.equal(s.canceled, 1)
  db.log('info', 'hello')
  const logs = db.recentLogs(5)
  assert.ok(logs.some(l => l.msg === 'hello'))
})

test('server module loads and exposes routes', () => {
  const { app } = require('../src/server')
  const routes = []
  app._router.stack.forEach(l => { if (l.route) routes.push(l.route.path) })
  for (const r of ['/api/order', '/api/config', '/webhook/:provider', '/admin/orders.csv', '/admin/requeue', '/admin/login', '/admin/order', '/admin/overview', '/admin/settings']) {
    assert.ok(routes.includes(r), `missing route ${r}`)
  }
})

test('cfg store works', () => {
  assert.equal(db.getCfg('nope'), null)
  assert.equal(db.getCfg('nope', 'fb'), 'fb')
  db.setCfg('rate', 3000)
  assert.equal(db.getCfg('rate'), '3000')
  db.setCfg('rate', 2500)
  assert.equal(db.getCfg('rate'), '2500')
})

test('payment provider loader picks the right module', () => {
  const load = require('../src/payment')
  assert.equal(load({ PAYMENT_PROVIDER: 'pakasir' }).name, 'pakasir')
  assert.equal(load({ PAYMENT_PROVIDER: 'midtrans' }).name, 'midtrans')
})

test('branding endpoints (default, set, reset)', async () => {
  const { app } = require('../src/server')
  const srv = app.listen(0)
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    // public default
    let r = await fetch(`${base}/api/branding`)
    let b = await r.json()
    assert.equal(b.name, 'DonutPay')
    assert.equal(b.favicon, '')
    assert.equal(b.icon, '')

    // login admin
    r = await fetch(`${base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin', pass: 'testpass' }) })
    const { token } = await r.json()
    const H = { 'Content-Type': 'application/json', 'x-admin-token': token }

    // set valid
    const png = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64')
    r = await fetch(`${base}/admin/branding`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'TokoGw', tagline: 'murah', favicon: png, icon: png }) })
    assert.equal(r.status, 200)
    b = (await r.json()).branding
    assert.equal(b.name, 'TokoGw')
    assert.equal(b.favicon, png)

    // reject invalid data url
    r = await fetch(`${base}/admin/branding`, { method: 'POST', headers: H, body: JSON.stringify({ icon: 'data:text/html;base64,PHNjcmlwdD4=' }) })
    assert.equal(r.status, 400)

    // reject empty name
    r = await fetch(`${base}/admin/branding`, { method: 'POST', headers: H, body: JSON.stringify({ name: '  ' }) })
    assert.equal(r.status, 400)

    // reset
    r = await fetch(`${base}/admin/branding`, { method: 'POST', headers: H, body: JSON.stringify({ favicon: '', icon: '' }) })
    b = (await r.json()).branding
    assert.equal(b.favicon, '')
    assert.equal(b.icon, '')
    assert.equal(b.name, 'TokoGw')

    // public reflects
    r = await fetch(`${base}/api/branding`)
    b = await r.json()
    assert.equal(b.name, 'TokoGw')
    assert.equal(b.tagline, 'murah')

    // unauthorized
    r = await fetch(`${base}/admin/branding`)
    assert.equal(r.status, 401)
  } finally {
    srv.close()
  }
})

test('login and bot modules parse cleanly', () => {
  execSync(`node --check ${path.join(__dirname, '..', 'src', 'login.js')}`)
  execSync(`node --check ${path.join(__dirname, '..', 'src', 'bot.js')}`)
  execSync(`node --check ${path.join(__dirname, '..', 'src', 'donutapi.js')}`)
  execSync(`node --check ${path.join(__dirname, '..', 'src', 'admin.js')}`)
  execSync(`node --check ${path.join(__dirname, '..', 'src', 'payments', 'pakasir.js')}`)
  execSync(`node --check ${path.join(__dirname, '..', 'src', 'payments', 'midtrans.js')}`)
  execSync(`node --check ${path.join(__dirname, '..', 'public', 'app.js')}`)
  execSync(`node --check ${path.join(__dirname, '..', 'public', 'admin.js')}`)
})
