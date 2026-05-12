/**
 * Microsoft Workflows Pack — v0 (Graph-only surface).
 *
 * Cross-platform by construction: every tool here hits Microsoft Graph
 * over HTTPS, so the same code path runs on Windows and macOS. Native
 * Office drivers (Excel-COM on Windows, AppleScript on macOS) ship in
 * a follow-up pack.
 *
 * Tools shipped:
 *   - agentmark_microsoft_login / logout / whoami
 *   - agentmark_outlook_send_email / search / get_message / reply
 *   - agentmark_onedrive_list / upload / download
 *
 * Auth model: OAuth 2.0 device-code flow. The user is prompted with a
 * short code + URL, completes login in a browser, and tokens are cached
 * to ~/.thinkfleet/agentmark/microsoft-tokens.json (mode 0600). Refresh
 * tokens rotate automatically on access-token expiry.
 *
 * Setup:
 *   1. Register an Azure AD app at https://entra.microsoft.com
 *      - Account types: "Accounts in any organizational directory and personal Microsoft accounts"
 *      - Add "Allow public client flows": Yes (for device-code)
 *      - API permissions (delegated): Mail.Send, Mail.ReadWrite,
 *        Files.ReadWrite, offline_access, User.Read
 *   2. Either set AGENTMARK_MS_CLIENT_ID environment variable, or pass
 *      `clientId` when creating the plugin.
 */
import { MicrosoftAuth, type MicrosoftAuthConfig } from './auth'
import { GraphClient } from './graph-client'
import { MICROSOFT_TOOLS } from './tool-defs'
import { buildOutlookHandlers } from './tools/outlook'
import { buildOneDriveHandlers } from './tools/onedrive'
import { buildAuthHandlers } from './tools/auth-tools'
import type { AgentMarkPlugin } from '../../mcp/plugin'

export interface MicrosoftPluginConfig extends MicrosoftAuthConfig {}

export function createMicrosoftPlugin(config: MicrosoftPluginConfig = {}): AgentMarkPlugin {
    const auth = new MicrosoftAuth(config)
    const graph = new GraphClient(auth)

    const handlers = {
        ...buildAuthHandlers(auth, graph),
        ...buildOutlookHandlers(graph),
        ...buildOneDriveHandlers(graph),
    }

    return {
        name: 'microsoft',
        version: '0.1.0',
        tools: MICROSOFT_TOOLS,
        handlers,
        describeSessions: () => ({
            microsoft: {
                client_id_set: !!auth.clientId,
                scopes: auth.scopes,
            },
        }),
    }
}

// Re-export the building blocks so packs that want a custom subset can
// compose their own plugin.
export { MicrosoftAuth, NotAuthenticatedError } from './auth'
export { GraphClient, GraphError } from './graph-client'
export type { MicrosoftAuthConfig, TokenSet, DeviceCodeStartResponse } from './auth'
export { MICROSOFT_TOOLS } from './tool-defs'
