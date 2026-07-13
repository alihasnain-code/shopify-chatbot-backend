import { Router } from 'express'
import historyController from '../controllers/history.controller.js'

const router = Router()

router.get('/history', historyController)

export default router
