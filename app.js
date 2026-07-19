import express from 'express'
import chatRouter from './routes/chat.route.js'
import historyRouter from './routes/history.route.js'
import cartRouter from './routes/cart.route.js'
import questionsRouter from './routes/questions.routes.js'
import formsRouter from './routes/forms.routes.js'
import './workers/policySyncWorker.js'
import { logger } from './config/logger.js'

const app = express()

app.use(express.static('public'))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.use((req, res, next) => {
    logger.info(
        {
            remoteAddress: req.socket.remoteAddress,
            xForwardedFor: req.headers['x-forwarded-for'],
        },
        'Incoming request'
    )

    next()
})

app.use('/api/v1', chatRouter)
app.use('/api/v1', historyRouter)
app.use('/api/v1', cartRouter)
app.use('/api/v1', questionsRouter)
app.use('/api/v1', formsRouter)

export default app
