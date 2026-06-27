import express from 'express'
import chatRouter from './routes/chat.route.js'

const app = express()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use('/api/v1', chatRouter)

export default app
