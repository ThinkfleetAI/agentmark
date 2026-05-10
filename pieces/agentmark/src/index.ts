/**
 * @thinkfleet/piece-agentmark — Activepieces piece for AgentMark.
 *
 * Drop into any Activepieces flow to convert web pages or PDFs into
 * AgentMark snapshots and fill PDF forms — all without leaving the flow
 * builder. Wraps the core @thinkfleet/agentmark library.
 */

import { createPiece, PieceAuth } from '@activepieces/pieces-framework'
import { snapshotWebPage } from './lib/actions/snapshot-web-page'
import { snapshotPdf } from './lib/actions/snapshot-pdf'
import { fillPdfForm } from './lib/actions/fill-pdf-form'

export const agentmark = createPiece({
    displayName: 'AgentMark',
    description:
        'Convert web pages and PDFs into compact AgentMark snapshots; fill '
        + 'AcroForm PDFs from flow data. Powered by @thinkfleet/agentmark.',
    auth: PieceAuth.None(),
    minimumSupportedRelease: '0.78.0',
    logoUrl: 'https://agentmark.dev/logo.svg',
    authors: ['thinkfleet'],
    actions: [snapshotWebPage, snapshotPdf, fillPdfForm],
    triggers: [],
})

export { snapshotWebPage, snapshotPdf, fillPdfForm }
