import { Router } from 'express'
import getStarterQuestions from '../controllers/questions.controller.js'

const router = Router()

router.get('/questions/:shop', getStarterQuestions)

export default router
