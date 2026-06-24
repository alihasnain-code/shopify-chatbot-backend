import pino from "pino";
import path from "node:path";

const logFilePath = path.join(process.cwd(), "logs", "app.log")

export const logger = pino({
    level: process.env.LOG_LEVEL || 'trace',

    timestamp: pino.stdTimeFunctions.isoTime,

    formatters: {
        level(label) {
            return { level: label.toUpperCase() }
        }
    }
}, pino.destination(logFilePath));