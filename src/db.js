const Database = require('better-sqlite3')
const path = require('path')

const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'shop.db'))
db.pragma('journal_mode = WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  amt REAL NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  qr TEXT,
  ts INTEGER NOT NULL,
  paid_ts INTEGER,
  delivered_ts INTEGER,
  expired_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  msg TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE TABLE IF NOT EXISTS cfg (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`)

const now = () => Date.now()

function log(level, msg) {
  db.prepare(`INSERT INTO logs (ts, level, msg) VALUES (?, ?, ?)`)
    .run(now(), level, String(msg).slice(0, 500))
  console.log(`[${new Date().toISOString()}] ${level}: ${msg}`)
}

const stmts = {
  insert: db.prepare(`INSERT INTO orders (id, user, amt, amount, qr, ts, expired_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  get: db.prepare(`SELECT * FROM orders WHERE id = ?`),
  // Status changes race between webhook, poller, and cancel; the compare on
  // current status makes only the first writer win.
  setState: db.prepare(`UPDATE orders SET status = ?, paid_ts = COALESCE(?, paid_ts), delivered_ts = COALESCE(?, delivered_ts) WHERE id = ? AND status = ?`),
  bumpAttempts: db.prepare(`UPDATE orders SET attempts = attempts + 1 WHERE id = ?`),
  pending: db.prepare(`SELECT * FROM orders WHERE status = 'pending' ORDER BY ts`),
  paid: db.prepare(`SELECT * FROM orders WHERE status = 'paid' ORDER BY ts`),
  recent: db.prepare(`SELECT id, user, amt, amount, status, ts FROM orders ORDER BY ts DESC LIMIT ?`),
  all: db.prepare(`SELECT * FROM orders ORDER BY ts DESC`),
  countBy: db.prepare(`SELECT status, COUNT(*) n FROM orders GROUP BY status`),
  recentLogs: db.prepare(`SELECT ts, level, msg FROM logs ORDER BY id DESC LIMIT ?`),
  allLogs: db.prepare(`SELECT * FROM logs ORDER BY id`),
  cfgGet: db.prepare(`SELECT value FROM cfg WHERE key = ?`),
  cfgSet: db.prepare(`INSERT INTO cfg (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
}

module.exports = {
  log,
  createOrder: ({ id, user, amt, amount, qr, expiredAt }) =>
    stmts.insert.run(id, user, amt, amount, qr || null, now(), expiredAt || null),
  getOrder: (id) => stmts.get.get(id),
  markPaid: (id) => stmts.setState.run('paid', now(), null, id, 'pending').changes > 0,
  markDelivered: (id) => stmts.setState.run('delivered', null, now(), id, 'paid').changes > 0,
  markCanceled: (id) => stmts.setState.run('canceled', null, null, id, 'pending').changes > 0,
  markExpired: (id) => stmts.setState.run('expired', null, null, id, 'pending').changes > 0,
  bumpAttempts: (id) => stmts.bumpAttempts.run(id),
  attempts: (id) => stmts.get.get(id)?.attempts ?? 0,
  pendingOrders: () => stmts.pending.all(),
  paidOrders: () => stmts.paid.all(),
  stats: () => Object.fromEntries(stmts.countBy.all().map(r => [r.status, r.n])),
  recentOrders: (n) => stmts.recent.all(n),
  allOrders: () => stmts.all.all(),
  recentLogs: (n) => stmts.recentLogs.all(n),
  allLogs: () => stmts.allLogs.all(),
  getCfg: (key, fallback = null) => {
    const v = stmts.cfgGet.get(key)?.value
    return v === undefined || v === null ? fallback : v
  },
  setCfg: (key, value) => stmts.cfgSet.run(key, String(value)),
}
