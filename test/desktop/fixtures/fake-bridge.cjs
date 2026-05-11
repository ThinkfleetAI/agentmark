#!/usr/bin/env node
// Fake agentmark-bridge-windows.exe for unit tests. Speaks the same
// stdio JSON-RPC 2.0 protocol the real bridge does but returns
// pre-baked responses keyed by method name. Behaviour can be tuned
// via env vars:
//
//   AGENTMARK_FAKE_BRIDGE_DELAY_MS  -- artificial latency per request
//   AGENTMARK_FAKE_BRIDGE_FAIL_PING -- if "1", reject ping (handshake-failure tests)
//   AGENTMARK_FAKE_BRIDGE_EXIT      -- if "1", exit immediately (crash test)
//
// Single-line JSON over stdin/stdout, stderr ignored by tests.

'use strict'

if (process.env.AGENTMARK_FAKE_BRIDGE_EXIT === '1') {
    process.exit(99)
}

const delayMs = Number(process.env.AGENTMARK_FAKE_BRIDGE_DELAY_MS) || 0

function respond(req, result) {
    const env = { jsonrpc: '2.0', id: req.id, result }
    process.stdout.write(JSON.stringify(env) + '\n')
}

function error(req, code, message) {
    const env = { jsonrpc: '2.0', id: req.id, error: { code, message } }
    process.stdout.write(JSON.stringify(env) + '\n')
}

const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })

rl.on('line', (line) => {
    const handle = () => {
        let req
        try { req = JSON.parse(line.trim().replace(/^﻿/, '')) }
        catch (err) { return }

        switch (req.method) {
            case 'ping':
                if (process.env.AGENTMARK_FAKE_BRIDGE_FAIL_PING === '1') {
                    return error(req, -32603, 'fake bridge refused ping')
                }
                return respond(req, {
                    pong: true,
                    version: '0.4.0-fake',
                    arch: 'fake',
                    processId: process.pid,
                })

            case 'capabilities':
                return respond(req, {
                    bridge: 'agentmark-bridge-fake',
                    version: '0.4.0-fake',
                    methods: ['ping', 'capabilities', 'list_windows', 'capture', 'execute'],
                    uiaProvider: 'fake',
                    platform: 'fake',
                })

            case 'list_windows':
                return respond(req, {
                    windows: [
                        {
                            windowId: 'hwnd:0xABCD0001',
                            processName: 'FakeApp.exe',
                            processId: 42,
                            windowTitle: 'Fake Window 1',
                            windowClass: 'FakeClass',
                            hasFocus: true,
                        },
                    ],
                })

            case 'capture': {
                // Echo back the requested target in the capture for tests.
                return respond(req, {
                    platform: 'windows',
                    processName: req.params?.processName ?? 'FakeApp.exe',
                    processId: req.params?.processId ?? 42,
                    windowTitle: 'Fake Window 1',
                    windowClass: 'FakeClass',
                    windowId: req.params?.windowId ?? 'hwnd:0xABCD0001',
                    focusedElementId: 'in_company',
                    treeDepth: 2,
                    elementCount: 3,
                    root: {
                        id: 'root',
                        role: 'window',
                        name: 'Fake Window 1',
                        enabled: true,
                        children: [
                            {
                                id: 'in_company',
                                role: 'text_input',
                                name: 'Company Name',
                                value: 'Acme',
                                enabled: true,
                            },
                            {
                                id: 'btn_save',
                                role: 'button',
                                name: 'Save',
                                enabled: true,
                            },
                        ],
                    },
                })
            }

            case 'execute': {
                const p = req.params || {}
                // Record the last execute so tests can assert.
                process.send?.({ kind: 'execute-call', params: p })
                return respond(req, {
                    ok: true,
                    newValue: p.actionType === 'type' ? (p.text || '') : null,
                })
            }

            default:
                return error(req, -32601, 'Unknown method: ' + req.method)
        }
    }
    if (delayMs > 0) setTimeout(handle, delayMs)
    else handle()
})

rl.on('close', () => process.exit(0))
