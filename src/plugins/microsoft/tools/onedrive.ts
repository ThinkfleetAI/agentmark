/**
 * OneDrive tool handlers — list, upload, download.
 *
 * Uploads under ~4MB use a single PUT; larger files use a Graph upload
 * session (chunked, resumable). Downloads stream via /content.
 */
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import type { ToolHandler, DispatchResult } from '../../../mcp/plugin'
import type { GraphClient } from '../graph-client'

const SMALL_FILE_THRESHOLD = 4 * 1024 * 1024 // 4 MB
const UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024 // 5 MB — must be a multiple of 320 KiB per Graph docs

interface DriveItem {
    id: string
    name: string
    size?: number
    lastModifiedDateTime?: string
    webUrl?: string
    folder?: { childCount?: number }
    file?: { mimeType?: string }
}

export function buildOneDriveHandlers(graph: GraphClient): Record<string, ToolHandler> {
    return {
        agentmark_onedrive_list: async (args): Promise<DispatchResult> => {
            const targetPath = typeof args.path === 'string' ? args.path : undefined
            const top = clamp(typeof args.top === 'number' ? args.top : 200, 1, 999)
            const url = targetPath
                ? `/me/drive/root:${encodePath(targetPath)}:/children`
                : '/me/drive/root/children'

            const result = await graph.get<{ value: DriveItem[] }>(url, {
                query: {
                    $top: top,
                    $select: 'id,name,size,lastModifiedDateTime,webUrl,folder,file',
                },
            })

            const items = (result.value ?? []).map((it) => ({
                id: it.id,
                name: it.name,
                kind: it.folder ? 'folder' : 'file',
                size: it.size ?? 0,
                modified: it.lastModifiedDateTime,
                mime_type: it.file?.mimeType,
                child_count: it.folder?.childCount,
                web_url: it.webUrl,
            }))

            return { text: JSON.stringify({ count: items.length, items }, null, 2) }
        },

        agentmark_onedrive_upload: async (args): Promise<DispatchResult> => {
            const localPath = path.resolve(requireString(args, 'local_path'))
            const remotePath = requireString(args, 'remote_path')
            const conflict = (args.conflict_behavior as string | undefined) ?? 'replace'
            if (!['rename', 'replace', 'fail'].includes(conflict)) {
                return {
                    text: `conflict_behavior must be one of rename|replace|fail; got "${conflict}"`,
                    isError: true,
                }
            }

            const info = await stat(localPath)
            if (!info.isFile()) {
                return { text: `local_path is not a file: ${localPath}`, isError: true }
            }

            let item: DriveItem
            if (info.size <= SMALL_FILE_THRESHOLD) {
                const bytes = new Uint8Array(await readFile(localPath))
                item = await graph.put<DriveItem>(
                    `/me/drive/root:${encodePath(remotePath)}:/content`,
                    {
                        bytes,
                        query: { '@microsoft.graph.conflictBehavior': conflict },
                    },
                )
            } else {
                item = await uploadLargeFile(graph, localPath, remotePath, info.size, conflict)
            }

            return {
                text: JSON.stringify({
                    uploaded: true,
                    id: item.id,
                    name: item.name,
                    size: item.size ?? info.size,
                    web_url: item.webUrl,
                }, null, 2),
            }
        },

        agentmark_onedrive_download: async (args): Promise<DispatchResult> => {
            const remotePath = requireString(args, 'remote_path')
            const localPath = path.resolve(requireString(args, 'local_path'))
            const bytes = await graph.getBytes(`/me/drive/root:${encodePath(remotePath)}:/content`)
            await mkdir(path.dirname(localPath), { recursive: true })
            await writeFile(localPath, bytes)
            return {
                text: JSON.stringify({
                    downloaded: true,
                    local_path: localPath,
                    bytes: bytes.length,
                }, null, 2),
            }
        },
    }
}

async function uploadLargeFile(
    graph: GraphClient,
    localPath: string,
    remotePath: string,
    totalSize: number,
    conflict: string,
): Promise<DriveItem> {
    // Step 1: create the upload session.
    const session = await graph.post<{ uploadUrl: string }>(
        `/me/drive/root:${encodePath(remotePath)}:/createUploadSession`,
        {
            body: {
                item: {
                    '@microsoft.graph.conflictBehavior': conflict,
                    name: path.basename(remotePath),
                },
            },
        },
    )

    // Step 2: upload chunks. The session URL is pre-authenticated; do not
    // attach the bearer token, per Graph docs.
    const data = await readFile(localPath)
    let offset = 0
    let finalItem: DriveItem | null = null

    while (offset < totalSize) {
        const end = Math.min(offset + UPLOAD_CHUNK_SIZE, totalSize)
        const chunk = data.subarray(offset, end)
        const response = await fetch(session.uploadUrl, {
            method: 'PUT',
            headers: {
                'content-length': String(chunk.length),
                'content-range': `bytes ${offset}-${end - 1}/${totalSize}`,
            },
            // Node's undici accepts Buffer; dom-lib BodyInit type is narrow.
            body: chunk as unknown as BodyInit,
        })
        if (!response.ok) {
            throw new Error(
                `Chunk upload failed at offset ${offset}: ${response.status} ${await response.text()}`,
            )
        }
        // The final chunk responds with the DriveItem; intermediate chunks
        // respond with an upload-progress structure we don't need to inspect.
        if (end === totalSize) {
            finalItem = (await response.json()) as DriveItem
        }
        offset = end
    }

    if (!finalItem) throw new Error('Upload completed without a final response item.')
    return finalItem
}

function encodePath(p: string): string {
    // OneDrive uses "/drive/root:/path/to/file" — the path after the colon
    // must be URL-encoded segment-by-segment, with leading slash.
    const cleaned = p.startsWith('/') ? p : '/' + p
    return cleaned.split('/').map(encodeURIComponent).join('/')
}

function requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key]
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`Missing required argument: ${key}`)
    }
    return v
}

function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n))
}
