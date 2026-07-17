import { Router } from 'express'
import getForms from '../controllers/form.controller.js'

const router = Router()

router.get('/forms/:shop', getForms)

export default router
