/**
 * Outlook tool handlers — send, search, get_message, reply.
 *
 * All via Microsoft Graph; works identically on Windows + macOS.
 */
import type { ToolHandler, DispatchResult } from '../../../mcp/plugin'
import type { GraphClient } from '../graph-client'

interface MessageSummary {
    id: string
    subject?: string
    bodyPreview?: string
    from?: { emailAddress: { address: string; name?: string } }
    receivedDateTime?: string
    hasAttachments?: boolean
}

interface MessageDetail extends MessageSummary {
    toRecipients?: Array<{ emailAddress: { address: string; name?: string } }>
    ccRecipients?: Array<{ emailAddress: { address: string; name?: string } }>
    body?: { contentType?: string; content?: string }
}

export function buildOutlookHandlers(graph: GraphClient): Record<string, ToolHandler> {
    return {
        agentmark_outlook_send_email: async (args): Promise<DispatchResult> => {
            const to = requireStringArray(args, 'to')
            const subject = requireString(args, 'subject')
            const body = requireString(args, 'body')
            const bodyType = args.body_type === 'text' ? 'Text' : 'HTML'
            const cc = optionalStringArray(args, 'cc')
            const bcc = optionalStringArray(args, 'bcc')
            const saveToSent = args.save_to_sent_items !== false

            await graph.post<void>('/me/sendMail', {
                body: {
                    message: {
                        subject,
                        body: { contentType: bodyType, content: body },
                        toRecipients: to.map(toRecipient),
                        ...(cc ? { ccRecipients: cc.map(toRecipient) } : {}),
                        ...(bcc ? { bccRecipients: bcc.map(toRecipient) } : {}),
                    },
                    saveToSentItems: saveToSent,
                },
            })

            return {
                text: JSON.stringify({
                    sent: true,
                    to,
                    subject,
                    saved_to_sent_items: saveToSent,
                }, null, 2),
            }
        },

        agentmark_outlook_search: async (args): Promise<DispatchResult> => {
            const query = requireString(args, 'query')
            const top = clamp(typeof args.top === 'number' ? args.top : 25, 1, 100)
            const folder = typeof args.folder === 'string' ? args.folder : 'inbox'

            const result = await graph.get<{ value: MessageSummary[] }>(
                `/me/mailFolders/${encodeURIComponent(folder)}/messages`,
                {
                    query: {
                        $search: `"${query.replace(/"/g, '\\"')}"`,
                        $top: top,
                        $select: 'id,subject,bodyPreview,from,receivedDateTime,hasAttachments',
                    },
                },
            )

            const messages = (result.value ?? []).map((m) => ({
                id: m.id,
                subject: m.subject ?? '',
                from: m.from?.emailAddress.address ?? '',
                from_name: m.from?.emailAddress.name ?? '',
                received: m.receivedDateTime,
                has_attachments: !!m.hasAttachments,
                preview: m.bodyPreview ?? '',
            }))

            return { text: JSON.stringify({ count: messages.length, messages }, null, 2) }
        },

        agentmark_outlook_get_message: async (args): Promise<DispatchResult> => {
            const id = requireString(args, 'message_id')
            const m = await graph.get<MessageDetail>(`/me/messages/${encodeURIComponent(id)}`, {
                query: {
                    $select: 'id,subject,from,toRecipients,ccRecipients,body,hasAttachments,receivedDateTime',
                },
            })

            return {
                text: JSON.stringify({
                    id: m.id,
                    subject: m.subject ?? '',
                    from: m.from?.emailAddress.address ?? '',
                    to: (m.toRecipients ?? []).map((r) => r.emailAddress.address),
                    cc: (m.ccRecipients ?? []).map((r) => r.emailAddress.address),
                    received: m.receivedDateTime,
                    has_attachments: !!m.hasAttachments,
                    body_type: m.body?.contentType ?? '',
                    body: m.body?.content ?? '',
                }, null, 2),
            }
        },

        agentmark_outlook_reply: async (args): Promise<DispatchResult> => {
            const id = requireString(args, 'message_id')
            const body = requireString(args, 'body')
            const bodyType = args.body_type === 'text' ? 'Text' : 'HTML'
            const replyAll = args.reply_all === true

            const endpoint = replyAll ? 'replyAll' : 'reply'
            await graph.post<void>(`/me/messages/${encodeURIComponent(id)}/${endpoint}`, {
                body: {
                    message: { body: { contentType: bodyType, content: body } },
                },
            })

            return {
                text: JSON.stringify({ replied: true, message_id: id, reply_all: replyAll }, null, 2),
            }
        },
    }
}

function toRecipient(address: string): { emailAddress: { address: string } } {
    return { emailAddress: { address } }
}

function requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key]
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`Missing required argument: ${key}`)
    }
    return v
}

function requireStringArray(args: Record<string, unknown>, key: string): string[] {
    const v = args[key]
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        throw new Error(`Argument ${key} must be an array of strings.`)
    }
    return v as string[]
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
    if (args[key] === undefined) return undefined
    return requireStringArray(args, key)
}

function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n))
}
