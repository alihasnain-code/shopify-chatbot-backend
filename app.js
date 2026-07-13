import express from 'express'
import chatRouter from './routes/chat.route.js'
import historyRouter from './routes/history.route.js'
import cartRouter from './routes/cart.route.js'

const app = express()

app.use(express.static('public'))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use('/api/v1', chatRouter)
app.use('/api/v1', historyRouter)
app.use('/api/v1', cartRouter)

export default app
