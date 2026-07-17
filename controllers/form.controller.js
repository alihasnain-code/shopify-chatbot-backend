import { prisma } from '../lib/prisma.js'

export default async function getForms(req, res) {
    const { shop } = req.params

    if (!shop) {
        return res.status(400).json({
            success: false,
            message: 'shop is required.',
        })
    }

    try {
        const forms = await prisma.form.findMany({
            where: {
                status: 'active',
                session: {
                    shop,
                    isOnline: false,
                },
            },
            orderBy: { position: 'asc' },
            select: {
                id: true,
                name: true,
                status: true,
                position: true,
                fields: true,
            },
        })

        const data = forms.map((form) => {
            let parsedFields = []
            try {
                parsedFields = JSON.parse(form.fields)
            } catch (parseError) {
                // Malformed fields JSON shouldn't take down the whole
                // response — log it and fall back to an empty field list
                // for this form only.
                console.error(
                    `Failed to parse fields for form id=${form.id}:`,
                    parseError
                )
            }

            return {
                id: form.id,
                name: form.name,
                status: form.status,
                position: form.position,
                fields: parsedFields,
            }
        })

        return res.status(200).json({
            success: true,
            data,
        })
    } catch (error) {
        console.error('getForms error:', error)
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch forms.',
        })
    }
}
