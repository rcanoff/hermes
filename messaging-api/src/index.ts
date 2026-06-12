import { buildApp } from './app.js'
import { readConfig } from './config.js'

const config = readConfig(process.env)
const app = buildApp(config)
const port = Number(process.env.PORT ?? 3000)

await app.listen({ host: '0.0.0.0', port })
