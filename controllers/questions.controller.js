import { prisma } from '../lib/prisma.js'

export default async function getStarterQuestions(req, res) {
    const { shop } = req.params

    if (!shop) {
        return res.status(400).json({
            success: false,
            message: 'shop is required.',
        })
    }

    try {
        const questions = await prisma.starterquestion.findMany({
            where: {
                session: {
                    shop,
                    isOnline: false,
                },
            },
            orderBy: { position: 'asc' },
            select: {
                id: true,
                question: true,
                position: true,
            },
        })

        return res.status(200).json({
            success: true,
            data: questions,
        })
    } catch (error) {
        console.error('getStarterQuestions error:', error)
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch starter questions.',
        })
    }
}
