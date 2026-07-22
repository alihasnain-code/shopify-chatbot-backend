import { Router } from 'express'
import {
    start,
    callback,
} from '../controllers/customer-account-auth.controller.js'

const router = Router()

router.post('/customer-auth/start', start)
router.get('/customer-auth/callback', callback)

export default router
