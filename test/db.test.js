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
