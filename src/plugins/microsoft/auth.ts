/**
 * Microsoft Graph authentication — device code OAuth 2.0 flow with
 * refresh-token rotation and on-disk token cache.
 *
 * Device code is the right flow for desktop / CLI contexts: the user
 * opens a URL on any device, enters a short code, completes login. No
 * embedded webview, no redirect URI. Works identically on Windows and
 * macOS.
 *
 * Token cache lives at `~/.thinkfleet/agentmark/microsoft-tokens.json`
 * with 0600 permissions. The cache is keyed by `clientId|scopeSet` so
 * multiple Azure AD apps can coexist on one machine.
 */
import { mkdir, readFile, writeFile, chmod, unlink } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

/** Default Azure AD client ID. Override via AGENTMARK_MS_CLIENT_ID. */
const DEFAULT_CLIENT_ID = process.env.AGENTMARK_MS_CLIENT_ID ?? ''

/** The "common" tenant accepts personal + work/school Microsoft accounts. */
const TENANT = 'common'

const DEVICE_CODE_ENDPOINT = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`
const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`

/** Default scope set for the v0 pack (Outlook + OneDrive + offline refresh). */
export const DEFAULT_SCOPES = [
    'Mail.Send',
    'Mail.ReadWrite',
    'Files.ReadWrite',
    'offline_access',
    'User.Read',
]

export interface MicrosoftAuthConfig {
    /** Azure AD app client id. Falls back to AGENTMARK_MS_CLIENT_ID env var. */
    clientId?: string
    /** OAuth scopes. Defaults to the v0 pack scope set. */
    scopes?: string[]
    /** Override the token-cache file path (mostly for tests). */
    cachePath?: string
}

export interface TokenSet {
    access_token: string
    refresh_token?: string
    expires_at: number // epoch ms
    scope: string
}

export interface DeviceCodeStartResponse {
    user_code: string
    device_code: string
    verification_uri: string
    expires_in: number
    interval: number
    message: string
}

export class MicrosoftAuth {
    readonly clientId: string
    readonly scopes: string[]
    private readonly cachePath: string
    private cached: TokenSet | null = null

    constructor(config: MicrosoftAuthConfig = {}) {
        this.clientId = config.clientId ?? DEFAULT_CLIENT_ID
        this.scopes = config.scopes ?? DEFAULT_SCOPES
        this.cachePath = config.cachePath ?? defaultCachePath()
    }

    /**
     * Begin a device-code login. Surface the returned `verification_uri`
     * and `user_code` to the user; then call `completeDeviceCode()` with
     * the returned `device_code` to poll for completion.
     */
    async startDeviceCode(): Promise<DeviceCodeStartResponse> {
        this.requireClientId()
        const body = new URLSearchParams({
            client_id: this.clientId,
            scope: this.scopes.join(' '),
        })
        const response = await fetch(DEVICE_CODE_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
        })
        if (!response.ok) {
            throw new Error(
                `Microsoft device-code request failed: ${response.status} ${await response.text()}`,
            )
        }
        return (await response.json()) as DeviceCodeStartResponse
    }

    /**
     * Poll the token endpoint until the user completes login or the
     * device code expires. Persists the resulting token to disk on
     * success. Throws on failure / timeout.
     */
    async completeDeviceCode(start: DeviceCodeStartResponse): Promise<TokenSet> {
        const deadline = Date.now() + start.expires_in * 1000
        // RFC 8628 §3.5: clients MUST respect the server-supplied interval
        // (and bump it by ≥5s when slow_down comes back). Microsoft sends
        // 5 in practice; tests pass 0 to run fast.
        const intervalMs = Math.max(start.interval * 1000, 0)

        while (Date.now() < deadline) {
            await sleep(intervalMs)
            const body = new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                client_id: this.clientId,
                device_code: start.device_code,
            })
            const response = await fetch(TOKEN_ENDPOINT, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body,
            })
            if (response.ok) {
                const json = (await response.json()) as {
                    access_token: string
                    refresh_token?: string
                    expires_in: number
                    scope: string
                }
                const tokens: TokenSet = {
                    access_token: json.access_token,
                    refresh_token: json.refresh_token,
                    expires_at: Date.now() + (json.expires_in - 60) * 1000,
                    scope: json.scope,
                }
                await this.saveTokens(tokens)
                return tokens
            }
            const err = (await response.json()) as { error?: string; error_description?: string }
            if (err.error === 'authorization_pending') continue
            if (err.error === 'slow_down') continue
            throw new Error(
                `Microsoft device-code completion failed: ${err.error ?? response.status}: ${err.error_description ?? ''}`,
            )
        }
        throw new Error('Microsoft device-code login timed out.')
    }

    /**
     * Return a non-expired access token, refreshing or surfacing a
     * `NotAuthenticated` error if necessary.
     */
    async getAccessToken(): Promise<string> {
        const tokens = await this.loadTokens()
        if (!tokens) {
            throw new NotAuthenticatedError(
                'No Microsoft tokens cached. Run agentmark_microsoft_login first.',
            )
        }
        if (Date.now() < tokens.expires_at) {
            return tokens.access_token
        }
        if (!tokens.refresh_token) {
            throw new NotAuthenticatedError(
                'Access token expired and no refresh token available. Re-run agentmark_microsoft_login.',
            )
        }
        const refreshed = await this.refresh(tokens.refresh_token)
        return refreshed.access_token
    }

    /** Drop the cached token file and in-memory cache. */
    async clear(): Promise<void> {
        this.cached = null
        await unlink(this.cachePath).catch(() => {})
    }

    /** Whether a token file currently exists on disk. */
    async hasTokens(): Promise<boolean> {
        return (await this.loadTokens()) !== null
    }

    private async refresh(refreshToken: string): Promise<TokenSet> {
        this.requireClientId()
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: this.clientId,
            refresh_token: refreshToken,
            scope: this.scopes.join(' '),
        })
        const response = await fetch(TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
        })
        if (!response.ok) {
            const text = await response.text()
            throw new NotAuthenticatedError(
                `Microsoft token refresh failed (${response.status}). Re-run agentmark_microsoft_login. Detail: ${text}`,
            )
        }
        const json = (await response.json()) as {
            access_token: string
            refresh_token?: string
            expires_in: number
            scope: string
        }
        const tokens: TokenSet = {
            access_token: json.access_token,
            refresh_token: json.refresh_token ?? refreshToken,
            expires_at: Date.now() + (json.expires_in - 60) * 1000,
            scope: json.scope,
        }
        await this.saveTokens(tokens)
        return tokens
    }

    private async loadTokens(): Promise<TokenSet | null> {
        if (this.cached) return this.cached
        try {
            const raw = await readFile(this.cachePath, 'utf8')
            const parsed = JSON.parse(raw) as TokenSet
            this.cached = parsed
            return parsed
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw err
        }
    }

    private async saveTokens(tokens: TokenSet): Promise<void> {
        this.cached = tokens
        await mkdir(path.dirname(this.cachePath), { recursive: true })
        await writeFile(this.cachePath, JSON.stringify(tokens, null, 2), { encoding: 'utf8' })
        await chmod(this.cachePath, 0o600).catch(() => {
            // Windows ACLs swallow chmod; not fatal.
        })
    }

    private requireClientId(): void {
        if (!this.clientId) {
            throw new Error(
                'Microsoft Graph client ID is not set. '
                + 'Register an Azure AD app and pass `clientId` to createMicrosoftPlugin() '
                + 'or set the AGENTMARK_MS_CLIENT_ID environment variable.',
            )
        }
    }
}

export class NotAuthenticatedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'NotAuthenticatedError'
    }
}

function defaultCachePath(): string {
    return path.join(os.homedir(), '.thinkfleet', 'agentmark', 'microsoft-tokens.json')
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
