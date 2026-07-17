import * as cheerio from 'cheerio'

export function cleanPolicyText(htmlBody) {
    if (!htmlBody) return ''

    // 1. Remove all {% logic %} and {{ variables }} instantly
    const noLiquidHtml = htmlBody.replace(
        /\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g,
        ''
    )

    // 2. Load into structural parser
    const $ = cheerio.load(noLiquidHtml)

    // 3. Inject explicit formatting line breaks so chunk boundary detection works smoothly
    $('h2, h3').prepend('\n\n').append('\n')
    $('p, li').append('\n')

    return $.text().trim()
}
