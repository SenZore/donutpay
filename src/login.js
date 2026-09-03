// One-off Microsoft login. Run: npm run login
// Prints a device code; open https://www.microsoft.com/link in any browser
// (phone or PC), sign in with the Minecraft Java account, approve. The token
// lands in auth_cache/ and the server reuses it from then on.
require('dotenv').config()
const path = require('path')
const mineflayer = require('mineflayer')

const profilesFolder = process.env.MC_AUTH_CACHE || path.join(__dirname, '..', 'auth_cache')

console.log('Login akun Microsoft buat bot Minecraft.')
console.log(`Auth cache: ${profilesFolder}\n`)

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || 'donutsmp.net',
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_USERNAME || 'bot',
  version: process.env.MC_VERSION || '1.21.1',
  auth: 'microsoft',
  profilesFolder,
})

bot.on('kicked', (r) => console.log('kicked (login tetap sukses kalau token kesimpen):', JSON.stringify(r).slice(0, 300)))
bot.on('error', (e) => console.error('error:', e.message))
bot.on('spawn', () => {
  console.log(`\nSukses. Login sebagai ${bot.username}, token tersimpan.`)
  console.log('Server (npm start) bakal pakai token ini otomatis.')
  bot.quit()
  process.exit(0)
})

// mineflayer prints the device code + URL to console during the flow.
setTimeout(() => {
  console.error('\nTimeout 5 menit. Ulangi: npm run login')
  process.exit(1)
}, 5 * 60 * 1000)
