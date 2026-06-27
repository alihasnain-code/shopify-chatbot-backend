import 'dotenv/config'
import app from './app.js'
import { prisma } from './lib/prisma.js'
import { logger } from './config/logger.js'

const PORT = process.env.PORT || 3000

process.on('uncaughtException', (error) => {
    logger.fatal(error, 'Uncaught Exception')
    process.exit(1)
})

process.on('unhandledRejection', (reason) => {
    logger.fatal(reason, 'Unhandled Promise Rejection')
    process.exit(1)
})

async function bootstrap() {
    try {
        await prisma.$connect()
        logger.info('Database connected successfully')

        const server = app.listen(PORT, () => {
            logger.info(`Server started on port ${PORT}`)
        })

        const shutdown = async (signal) => {
            logger.info(`${signal} received, shutting down`)

            await prisma.$disconnect()

            server.close(() => {
                logger.info('Server stopped')
                process.exit(0)
            })
        }

        process.on('SIGINT', () => shutdown('SIGINT'))
        process.on('SIGTERM', () => shutdown('SIGTERM'))
    } catch (error) {
        logger.fatal(error, 'Failed to connect to database')
        process.exit(1)
    }
}

bootstrap()
