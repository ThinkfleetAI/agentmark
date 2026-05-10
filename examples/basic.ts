/**
 * Basic AgentMark usage — capture a snapshot, print it, fill a form.
 *
 *   npx tsx examples/basic.ts
 */

import { createBrowser, consoleLogger } from '../src'

async function main() {
    const browser = await createBrowser({
        launch: { headless: false },     // set true for CI
        logger: consoleLogger,           // structured event stream
    })

    try {
        const page = await browser.newPage()
        await page.goto('https://example.com')

        const snap = await page.snapshot()

        console.log('\n────── AgentMark snapshot ──────\n')
        console.log(snap.agentmark)
        console.log('\n────── Available actions ──────\n')
        for (const [id, action] of Object.entries(snap.snapshot.actions ?? {})) {
            console.log(`  ${id}: [${action.type}] ${action.label}`)
        }
    } finally {
        await browser.close()
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
