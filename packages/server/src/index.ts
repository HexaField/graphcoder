import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import graphRouter from './routes/graph.js'
import gitRouter from './routes/git.js'
import annotationRouter from './routes/annotations.js'
import { setupWebSocket } from './ws.js'

/** API port. High in the range so it does not collide with other tooling. */
const DEFAULT_PORT = 3357

const app = express()
const port = parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10)
const host = process.env.HOST ?? '0.0.0.0'

app.use(cors())
app.use(express.json())

app.use('/api', graphRouter)
app.use('/api', gitRouter)
app.use('/api', annotationRouter)

const server = createServer(app)
setupWebSocket(server)

server.listen(port, host, () => {
  console.log(`GraphCoder server running at http://${host}:${port}`)
})
