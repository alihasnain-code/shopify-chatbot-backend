import { prisma } from '../lib/prisma.js'

export async function getForms(req, res) {
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
                version: true,
            },
        })

        const data = []

        for (const form of forms) {
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

            // If the parsed fields array is empty, skip this form entirely
            if (!Array.isArray(parsedFields) || parsedFields.length === 0) {
                continue
            }

            data.push({
                id: form.id,
                name: form.name,
                status: form.status,
                position: form.position,
                fields: parsedFields,
                version: form.version,
            })
        }

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

export async function submitFormResponse(req, res) {
    const { shop } = req.params
    const { formId, data } = req.body

    if (!shop) {
        return res.status(400).json({
            success: false,
            message: 'shop is required.',
        })
    }

    try {
        const session = await prisma.session.findFirst({
            where: { shop, isOnline: false },
            select: { id: true },
        })

        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Shop not found.',
            })
        }

        const response = await prisma.form_response.create({
            data: {
                formId: Number(formId),
                sessionId: session.id,
                data: JSON.stringify(data || {}),
            },
        })

        return res.status(201).json({
            success: true,
            data: { id: response.id },
        })
    } catch (error) {
        console.error('submitFormResponse error:', error)
        return res.status(500).json({
            success: false,
            message: 'Failed to save form response.',
        })
    }
}
