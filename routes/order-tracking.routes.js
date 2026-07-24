import { Router } from 'express'
import { verify } from '../controllers/order-tracking.controller.js'

const router = Router()

router.post('/order-tracking/verify', verify)

export default router
