import { readConfig } from './config.js'
import { createServer } from './server.js'

const config = readConfig()
const { server } = createServer(config)

const shutdown = () => {
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

server.listen(config.port, '0.0.0.0', () => {
  console.log(
    `browser-daemon listening on http://0.0.0.0:${config.port} (profile: ${config.profileName})`,
  )
})