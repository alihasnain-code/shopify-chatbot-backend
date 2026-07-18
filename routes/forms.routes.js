import { Router } from 'express'
import { getForms, submitFormResponse } from '../controllers/form.controller.js'

const router = Router()

router.get('/forms/:shop', getForms)

router.post('/forms/:shop/submit', submitFormResponse)

export default router
