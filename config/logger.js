import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'

const isProduction = process.env.NODE_ENV === 'production'

let logger

if (isProduction) {
    const logsDir = path.join(process.cwd(), 'logs')

    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true })
    }

    logger = pino(
        {
            level: process.env.LOG_LEVEL || 'trace',
            timestamp: pino.stdTimeFunctions.isoTime,
            formatters: {
                level(label) {
                    return { level: label.toUpperCase() }
                },
            },
        },
        pino.destination(path.join(logsDir, 'app.log'))
    )
} else {
    logger = pino({
        level: process.env.LOG_LEVEL || 'trace',

        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
            },
        },

        timestamp: pino.stdTimeFunctions.isoTime,

        formatters: {
            level(label) {
                return { level: label.toUpperCase() }
            },
        },
    })
}

export { logger }
