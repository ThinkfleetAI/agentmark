/**
 * Challenge resolver — handles anti-bot challenges before agentmark extraction.
 *
 * Strategy (cascading):
 *   1. Cloudflare JS challenge → just wait; it auto-resolves in real Chromium
 *   2. Cloudflare Turnstile "I am human" → click the checkbox in iframe
 *   3. reCAPTCHA v2 "I'm not a robot" → click the checkbox in iframe
 *   4. hCaptcha "I am human" → click the checkbox in iframe
 *   5. Visual CAPTCHA (image grid) → attempt with AI vision if solver provided
 *   6. Unresolvable → return false (caller emits [CHALLENGE] tag)
 *
 * All checkbox challenges work because we're running real Chromium with a
 * real browser fingerprint. The challenge providers check browser signals
 * (WebGL, canvas, fonts, etc.) — not whether a human physically clicked.
 * In most cases, clicking the checkbox in a non-headless session passes.
 */

import type { Page, Frame } from 'playwright-core'

export interface ChallengeResolverOptions {
    /** Max time to wait for JS challenges to self-resolve. Default: 10000ms */
    jsWaitMs?: number
    /** Max time to wait after clicking a checkbox. Default: 8000ms */
    clickWaitMs?: number
    /** Max retries for checkbox challenges. Default: 2 */
    maxRetries?: number
    /** Optional AI vision solver for image CAPTCHAs (Claude/GPT-4o). If not provided, visual CAPTCHAs are reported as unresolvable. */
    visionSolver?: (screenshotBase64: string, prompt: string) => Promise<string>
}

export interface ChallengeResult {
    resolved: boolean
    method: 'none' | 'js_wait' | 'turnstile_click' | 'recaptcha_click' | 'hcaptcha_click' | 'vision' | 'unresolvable'
    attempts: number
    durationMs: number
}

/**
 * Attempt to resolve any anti-bot challenge on the current page.
 * Returns { resolved: true } if the page is now accessible.
 */
export async function resolveChallenge(page: Page, options: ChallengeResolverOptions = {}): Promise<ChallengeResult> {
    const jsWaitMs = options.jsWaitMs ?? 10_000
    const clickWaitMs = options.clickWaitMs ?? 8_000
    const maxRetries = options.maxRetries ?? 2
    const startTime = Date.now()
    let attempts = 0

    // 1. Is this even a challenge page?
    const challengeType = await detectChallenge(page)
    if (challengeType === 'none') {
        return { resolved: true, method: 'none', attempts: 0, durationMs: 0 }
    }

    // 2. Cloudflare JS challenge — just wait; real Chromium solves it automatically
    if (challengeType === 'cloudflare_js') {
        const resolved = await waitForChallengeToResolve(page, jsWaitMs)
        return {
            resolved,
            method: resolved ? 'js_wait' : 'unresolvable',
            attempts: 1,
            durationMs: Date.now() - startTime,
        }
    }

    // 3. Checkbox-style challenges — click the checkbox in the iframe
    for (let retry = 0; retry <= maxRetries; retry++) {
        attempts++
        const clicked = await clickChallengeCheckbox(page, challengeType)
        if (!clicked) break

        // Wait for the challenge to resolve after clicking
        const resolved = await waitForChallengeToResolve(page, clickWaitMs)
        if (resolved) {
            return {
                resolved: true,
                method: `${challengeType}_click` as ChallengeResult['method'],
                attempts,
                durationMs: Date.now() - startTime,
            }
        }

        // Check if a visual CAPTCHA appeared (image grid)
        if (options.visionSolver) {
            const visualResolved = await attemptVisualSolve(page, options.visionSolver)
            if (visualResolved) {
                return {
                    resolved: true,
                    method: 'vision',
                    attempts,
                    durationMs: Date.now() - startTime,
                }
            }
        }
    }

    return {
        resolved: false,
        method: 'unresolvable',
        attempts,
        durationMs: Date.now() - startTime,
    }
}

type ChallengeType = 'none' | 'cloudflare_js' | 'turnstile' | 'recaptcha' | 'hcaptcha'

async function detectChallenge(page: Page): Promise<ChallengeType> {
    return page.evaluate(`(() => {
        // Cloudflare JS challenge (auto-resolving "Just a moment...")
        if (document.title === 'Just a moment...' && document.querySelector('#cf-please-wait, .cf-browser-verification')) {
            return 'cloudflare_js';
        }
        // Cloudflare Turnstile iframe
        if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) {
            return 'turnstile';
        }
        // reCAPTCHA v2 iframe
        if (document.querySelector('iframe[src*="google.com/recaptcha"]')) {
            return 'recaptcha';
        }
        // hCaptcha iframe
        if (document.querySelector('iframe[src*="hcaptcha.com"]')) {
            return 'hcaptcha';
        }
        return 'none';
    })()`) as Promise<ChallengeType>
}

async function waitForChallengeToResolve(page: Page, maxMs: number): Promise<boolean> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < maxMs) {
        const stillChallenge = await detectChallenge(page)
        if (stillChallenge === 'none') return true
        // Check if the page title changed (challenge resolved → real page loaded)
        const title = await page.title()
        if (title !== 'Just a moment...' && !title.includes('Security') && !title.includes('Verify')) {
            return true
        }
        await page.waitForTimeout(500).catch(() => {})
    }
    return false
}

async function clickChallengeCheckbox(page: Page, type: ChallengeType): Promise<boolean> {
    try {
        let challengeFrame: Frame | null = null

        switch (type) {
            case 'turnstile': {
                const iframe = await page.$('iframe[src*="challenges.cloudflare.com"]')
                if (!iframe) return false
                challengeFrame = await iframe.contentFrame()
                if (!challengeFrame) return false
                // Turnstile checkbox
                const checkbox = await challengeFrame.$('input[type="checkbox"], .cb-i, label')
                if (checkbox) {
                    await checkbox.click({ timeout: 3000 })
                    return true
                }
                // Sometimes it's just a div that needs clicking
                const body = await challengeFrame.$('body')
                if (body) {
                    await body.click({ position: { x: 28, y: 28 }, timeout: 3000 })
                    return true
                }
                return false
            }
            case 'recaptcha': {
                const iframe = await page.$('iframe[src*="google.com/recaptcha"]')
                if (!iframe) return false
                challengeFrame = await iframe.contentFrame()
                if (!challengeFrame) return false
                const checkbox = await challengeFrame.$('#recaptcha-anchor, .recaptcha-checkbox')
                if (checkbox) {
                    await checkbox.click({ timeout: 3000 })
                    return true
                }
                return false
            }
            case 'hcaptcha': {
                const iframe = await page.$('iframe[src*="hcaptcha.com"]')
                if (!iframe) return false
                challengeFrame = await iframe.contentFrame()
                if (!challengeFrame) return false
                const checkbox = await challengeFrame.$('#checkbox, .check')
                if (checkbox) {
                    await checkbox.click({ timeout: 3000 })
                    return true
                }
                return false
            }
            default:
                return false
        }
    } catch {
        return false
    }
}

/**
 * Attempt to solve a visual CAPTCHA using an AI vision model.
 *
 * Takes a screenshot of the challenge iframe, sends it to the vision solver
 * with instructions, and clicks the indicated elements.
 *
 * This is opt-in — only runs if `visionSolver` is provided in options.
 */
async function attemptVisualSolve(
    page: Page,
    solver: (screenshotBase64: string, prompt: string) => Promise<string>,
): Promise<boolean> {
    try {
        // Find the challenge iframe (could be reCAPTCHA image grid or hCaptcha puzzle)
        const challengeIframe = await page.$(
            'iframe[src*="google.com/recaptcha"][title*="challenge" i], ' +
            'iframe[src*="hcaptcha.com"][title*="challenge" i], ' +
            'iframe[src*="newassets.hcaptcha.com"]',
        )
        if (!challengeIframe) return false

        // Screenshot the challenge
        const screenshot = await challengeIframe.screenshot({ type: 'png' })
        const b64 = screenshot.toString('base64')

        // Ask the vision model to describe what to click
        const instructions = await solver(b64, [
            'You are looking at a CAPTCHA challenge image.',
            'If this is a reCAPTCHA image grid: identify which squares contain the requested object and respond with their grid positions (e.g. "1,2,5,8" for a 3x3 grid numbered left-to-right, top-to-bottom).',
            'If this is an hCaptcha: describe which image to select.',
            'If this is already solved (green checkmark): respond with "SOLVED".',
            'Respond ONLY with the grid positions or "SOLVED". No explanation.',
        ].join(' '))

        if (instructions.trim().toUpperCase() === 'SOLVED') return true

        // Parse grid positions and click them
        const positions = instructions.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
        if (positions.length === 0) return false

        const frame = await challengeIframe.contentFrame()
        if (!frame) return false

        // reCAPTCHA image grid: tiles are in a table or div grid
        const tiles = await frame.$$('td.rc-imageselect-tile, .task-image')
        for (const pos of positions) {
            const idx = pos - 1
            if (idx >= 0 && idx < tiles.length) {
                await tiles[idx].click().catch(() => {})
                await page.waitForTimeout(200).catch(() => {})
            }
        }

        // Click verify/submit button
        const verifyBtn = await frame.$('#recaptcha-verify-button, .verify-button, button[type="submit"]')
        if (verifyBtn) await verifyBtn.click().catch(() => {})

        // Wait for result
        await page.waitForTimeout(2000).catch(() => {})
        const stillChallenge = await detectChallenge(page)
        return stillChallenge === 'none'
    } catch {
        return false
    }
}
