const mineflayer = require('mineflayer')

let bot = null
let online = false
const queue = []
let draining = false
let logFn = (level, msg) => console.log(`${level}: ${msg}`)
let _db = null

function setLogger(fn) { logFn = fn }
function db() { if (!_db) _db = require('./db'); return _db }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// The real account comes from the device-code login in src/login.js, which
// stores the Microsoft token under profilesFolder. MC_USERNAME is only the
// nickname the server displays.
function createBot(cfg) {
  if (!cfg.username) return null
  const make = () => {
    bot = mineflayer.createBot({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      version: cfg.version,
      auth: 'microsoft',
      profilesFolder: cfg.profilesFolder,
    })
    bot.on('spawn', () => {
      online = true
      reconnectDelay = 5000
      logFn('info', `bot spawned as ${bot.username}`)
      setImmediate(drain)
    })
    bot.on('online', () => { online = true })
    bot.on('kicked', (reason) => {
      online = false
      logFn('warn', `kicked: ${JSON.stringify(reason)}`)
    })
    bot.on('error', (err) => {
      online = false
      logFn('error', `bot error: ${err.message}`)
    })
    bot.on('death', () => {
      // Auto-respawn kalau di-bunuh; bot.respawn() default di mineflayer,
      // kita cuma log biar kelihatan di admin logs.
      logFn('warn', 'bot mati, auto-respawn')
    })
    // end bisa karena kick/crash — selalu coba relogin dengan backoff.
    bot.on('end', () => {
      online = false
      reconnectDelay = Math.min(reconnectDelay * 2, 120_000)
      logFn('info', `disconnected, relogin dalam ${reconnectDelay / 1000}s`)
      setTimeout(() => { if (active) make() }, reconnectDelay).unref()
    })
  }
  let reconnectDelay = 5000
  let active = true
  make()
  return {
    quit: () => { active = false; try { bot?.quit() } catch {} },
  }
}

function enqueue(orderId) {
  if (!queue.includes(orderId)) queue.push(orderId)
  drain()
}

async function drain() {
  if (draining) return
  draining = true
  try {
    while (queue.length) {
      const id = queue[0]
      if (!bot || !online) break // wait for spawn, mineflayer will reconnect
      const ok = await deliver(id)
      if (ok) { queue.shift(); continue }
      db().bumpAttempts(id)
      if (db().attempts(id) >= 5) {
        logFn('error', `order ${id} failed delivery 5x, dropped (re-queue via /admin/requeue)`)
        queue.shift()
      } else {
        await sleep(3000)
      }
    }
  } finally {
    draining = false
  }
}

async function deliver(orderId) {
  const order = db().getOrder(orderId)
  if (!order) return true
  if (order.status !== 'paid') return order.status === 'delivered'

  // DonutSMP convention: amounts are in millions of donuts, /pay takes
  // suffixes like 5m or 1.5b.
  const m = Number(order.amt)
  const payAmt = m >= 1000 ? `${m / 1000}b` : `${m}m`

  try {
    await payPlayer(order.user, payAmt)
  } catch (err) {
    logFn('error', `deliver ${orderId}: ${err.message}`)
    return false
  }
  if (db().markDelivered(orderId)) {
    logFn('info', `paid /pay ${order.user} ${payAmt} (order ${orderId})`)
  }
  return true
}

// Chat commands have no return value; the server answers in chat. Wait for a
// confirmation or failure line that mentions the /pay, with a hard timeout.
function payPlayer(player, amount) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      bot.removeListener('message', onMsg)
      reject(new Error('no /pay response within 20s'))
    }, 20_000)
    function onMsg(message) {
      const text = message.toString()
      const mine = text.includes(player) || /\/?pay/i.test(text)
      if (!mine) return
      if (/success|sent|paid|received/i.test(text)) {
        clearTimeout(timeout); bot.removeListener('message', onMsg); resolve(text)
      } else if (/not found|insufficient|invalid|cannot|can't|error/i.test(text)) {
        clearTimeout(timeout); bot.removeListener('message', onMsg); reject(new Error(text))
      }
    }
    bot.on('message', onMsg)
    bot.chat(`/pay ${player} ${amount}`)
  })
}

module.exports = { createBot, enqueue, deliver, setLogger, isOnline: () => online, queueSize: () => queue.length }
