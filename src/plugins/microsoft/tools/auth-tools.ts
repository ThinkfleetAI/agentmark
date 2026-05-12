/**
 * Auth-related tool handlers (login / logout / whoami).
 *
 * `login` runs the device-code flow inline by default — the AI gets back
 * the user_code + verification_uri to show, then the handler polls until
 * the user finishes. Pass wait=false for UIs that want to render the code
 * themselves and orchestrate completion separately.
 */
import type { ToolHandler, DispatchResult } from '../../../mcp/plugin'
import type { GraphClient } from '../graph-client'
import type { MicrosoftAuth } from '../auth'

interface UserProfile {
    id: string
    displayName?: string
    userPrincipalName?: string
    mail?: string
}

export function buildAuthHandlers(auth: MicrosoftAuth, graph: GraphClient): Record<string, ToolHandler> {
    return {
        agentmark_microsoft_login: async (args): Promise<DispatchResult> => {
            const wait = args.wait !== false
            const start = await auth.startDeviceCode()

            const instructions = {
                verification_uri: start.verification_uri,
                user_code: start.user_code,
                expires_in_seconds: start.expires_in,
                message: start.message,
            }

            if (!wait) {
                return {
                    text: JSON.stringify({
                        status: 'pending',
                        instructions,
                        note: 'Call agentmark_microsoft_login again (with wait=true) once the user has finished.',
                    }, null, 2),
                }
            }

            // Tell the user up-front via the response. The AI surfaces this
            // immediately; polling happens in the background.
            const tokens = await auth.completeDeviceCode(start)
            return {
                text: JSON.stringify({
                    status: 'authenticated',
                    instructions, // include for transcript completeness
                    expires_at: new Date(tokens.expires_at).toISOString(),
                    scopes: tokens.scope.split(' '),
                }, null, 2),
            }
        },

        agentmark_microsoft_logout: async (): Promise<DispatchResult> => {
            await auth.clear()
            return { text: JSON.stringify({ status: 'logged_out' }, null, 2) }
        },

        agentmark_microsoft_whoami: async (): Promise<DispatchResult> => {
            const me = await graph.get<UserProfile>('/me', {
                query: { $select: 'id,displayName,userPrincipalName,mail' },
            })
            return {
                text: JSON.stringify({
                    id: me.id,
                    display_name: me.displayName,
                    user_principal_name: me.userPrincipalName,
                    mail: me.mail,
                }, null, 2),
            }
        },
    }
}
