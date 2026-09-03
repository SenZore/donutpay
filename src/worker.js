// Keeps the DB honest without trusting webhooks alone: polls Pakasir for
// every live pending order, expires stale ones, and re-queues paid orders
// that never got delivered (e.g. after a restart).

function requeuePaid(db, bot) {
  for (const o of db.paidOrders()) {
    db.log('info', `boot: re-queue ${o.id} (${o.user})`)
    bot.enqueue(o.id)
  }
}

function startWorker(db, gateway, bot, intervalMs = 15_000) {
  const tick = async () => {
    const now = Date.now()
    for (const o of db.pendingOrders()) {
      if (o.expired_at && o.expired_at < now) {
        db.markExpired(o.id)
        db.log('info', `order ${o.id} expired`)
        continue
      }
      try {
        const tx = await gateway.transactionDetail(o.id, o.amount)
        if (tx.status === 'completed' && db.markPaid(o.id)) {
          db.log('info', `order ${o.id} paid via ${tx.payment_method}`)
          bot.enqueue(o.id)
        } else if (tx.status === 'canceled' || tx.status === 'expired') {
          db.markExpired(o.id)
        }
      } catch (err) {
        // 404 means Pakasir has no such transaction yet; normal for fresh orders
        if (err.status !== 404) db.log('error', `poll ${o.id}: ${err.message}`)
      }
    }
  }
  const timer = setInterval(() => tick().catch(e => db.log('error', `worker: ${e.message}`)), intervalMs)
  timer.unref()
  return tick
}

module.exports = { requeuePaid, startWorker }
