import { Router } from 'express'
import cartAddController from '../controllers/cart.controller.js'

const router = Router()

router.post('/cart/add', cartAddController)

export default router
