import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import graphRouter from './routes/graph.js'
import gitRouter from './routes/git.js'
import { setupWebSocket } from './ws.js'

const app = express()
const port = parseInt(process.env.PORT ?? '3001', 10)
const host = process.env.HOST ?? '0.0.0.0'

app.use(cors())
app.use(express.json())

app.use('/api', graphRouter)
app.use('/api', gitRouter)

const server = createServer(app)
setupWebSocket(server)

server.listen(port, host, () => {
  console.log(`GraphCoder server running at http://${host}:${port}`)
})
