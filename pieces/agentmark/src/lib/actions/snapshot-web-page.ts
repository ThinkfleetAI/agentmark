import { createAction, Property } from '@activepieces/pieces-framework'
import { createBrowser } from '@thinkfleet/agentmark'

export const snapshotWebPage = createAction({
    name: 'snapshot_web_page',
    displayName: 'Capture Web Page',
    description:
        'Navigate to a URL and return a compact AgentMark snapshot. The result '
        + 'is 5–10× smaller than raw HTML and can be passed to any LLM as the '
        + 'page representation.',
    props: {
        url: Property.ShortText({
            displayName: 'URL',
            description: 'The page to capture.',
            required: true,
        }),
        wait_until: Property.StaticDropdown({
            displayName: 'Wait Until',
            description: 'When to consider the page loaded.',
            required: false,
            defaultValue: 'load',
            options: {
                disabled: false,
                options: [
                    { label: 'Page load event', value: 'load' },
                    { label: 'DOM content loaded', value: 'domcontentloaded' },
                    { label: 'Network idle', value: 'networkidle' },
                ],
            },
        }),
        timeout_ms: Property.Number({
            displayName: 'Navigation Timeout (ms)',
            description: 'Default 30000.',
            required: false,
            defaultValue: 30_000,
        }),
        headless: Property.Checkbox({
            displayName: 'Headless',
            description: 'Run Chromium in headless mode (recommended).',
            required: false,
            defaultValue: true,
        }),
    },
    async run(context) {
        const { url, wait_until, timeout_ms, headless } = context.propsValue
        const browser = await createBrowser({
            launch: { headless: headless !== false },
        })
        try {
            const page = await browser.newPage()
            await page.goto(url, {
                waitUntil: (wait_until as 'load' | 'domcontentloaded' | 'networkidle') ?? 'load',
                timeout: timeout_ms ?? 30_000,
            })
            const snap = await page.snapshot()
            return {
                agentmark: snap.agentmark,
                url: page.url(),
                title: snap.snapshot.title,
                kind: snap.snapshot.kind ?? 'webpage',
                action_count: Object.keys(snap.snapshot.actions ?? {}).length,
                bytes: snap.agentmark.length,
                captured_at: snap.capturedAt.toISOString(),
            }
        } finally {
            await browser.close()
        }
    },
})
