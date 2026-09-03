// Picks the payment provider from PAYMENT_PROVIDER env (pakasir | midtrans)
// and normalizes the interface the rest of the app uses.
module.exports = function loadProvider(env) {
  const name = (env.PAYMENT_PROVIDER || 'pakasir').toLowerCase()
  const provider = require(`./payments/${name}`)
  return provider
}
