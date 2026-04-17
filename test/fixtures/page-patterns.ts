/**
 * Realistic RawExtraction fixtures representing common page patterns.
 * These exercise the buildSnapshot + body-builder + serializer pipeline
 * end-to-end without needing a real browser.
 *
 * Real browser-side extraction (the EXTRACTOR_SCRIPT) is tested via
 * end-to-end fixtures in the ThinkBrowse integration layer.
 */
import type { RawExtraction } from '../../src/extractors/dom-extractor'

export const articlePage: RawExtraction = {
    title: 'An Introduction to AI Agents',
    url: 'https://blog.example.com/intro-to-agents',
    language: 'en',
    direction: 'ltr',
    state: { loading: false, modal_open: false, ssl: 'valid' },
    actions: {
        act_share: { type: 'click', label: 'Share', disabled: false },
        act_subscribe: { type: 'click', label: 'Subscribe', disabled: false },
    },
    media: {
        img_hero: { type: 'image', alt: 'AI agent diagram', preview_url: 'https://blog.example.com/hero.png', width: 1200, height: 600 },
    },
    body_segments: [
        { kind: 'heading', level: 1, text: 'An Introduction to AI Agents' },
        { kind: 'paragraph', text: 'AI agents are software programs that use language models to plan and execute multi-step tasks autonomously.' },
        { kind: 'tag', tag: 'MEDIA', ref: 'img_hero' },
        { kind: 'heading', level: 2, text: 'What an Agent Actually Is' },
        { kind: 'paragraph', text: 'An agent has three components: a planner, an executor, and a memory.' },
        { kind: 'heading', level: 2, text: 'Common Architectures' },
        { kind: 'list', ordered: true, items: ['ReAct loops', 'Plan-and-execute', 'Hierarchical task decomposition'] },
        { kind: 'tag', tag: 'ACTION', ref: 'act_share' },
        { kind: 'tag', tag: 'ACTION', ref: 'act_subscribe' },
    ],
    cookies: { banner_present: false },
}

export const loginWall: RawExtraction = {
    title: 'Sign In — Salesforce',
    url: 'https://login.salesforce.com/',
    language: 'en',
    direction: 'ltr',
    state: { loading: false, modal_open: false, ssl: 'valid' },
    actions: {
        act_username: { type: 'type', label: 'Username', disabled: false, required: true, validation: 'email' },
        act_password: { type: 'type', label: '(redacted)', disabled: false, required: true, description: 'Sensitive field — content not exposed to agent. Type: password' },
        act_login: { type: 'click', label: 'Log In to Sandbox', disabled: false, auth_required: 'salesforce' },
    },
    media: {},
    body_segments: [
        { kind: 'tag', tag: 'AUTH_WALL' },
        { kind: 'heading', level: 1, text: 'Sign In' },
        { kind: 'tag', tag: 'INPUT', ref: 'act_username' },
        { kind: 'tag', tag: 'INPUT', ref: 'act_password' },
        { kind: 'tag', tag: 'ACTION', ref: 'act_login' },
    ],
    cookies: { banner_present: false },
}

export const checkoutForm: RawExtraction = {
    title: 'Checkout — Acme Shop',
    url: 'https://shop.example.com/checkout',
    language: 'en',
    direction: 'ltr',
    state: { loading: false, modal_open: false, ssl: 'valid' },
    actions: {
        act_email: { type: 'type', label: 'Email', disabled: false, required: true, validation: 'email' },
        act_addr1: { type: 'type', label: 'Street address', disabled: false, required: true },
        act_addr2_honeypot: { type: 'type', label: 'Address line 2', disabled: false, honeypot: true },
        act_city: { type: 'type', label: 'City', disabled: false, required: true },
        act_zip: { type: 'type', label: 'ZIP code', disabled: false, required: true, validation: 'regex:^[0-9]{5}(-[0-9]{4})?$' },
        act_country: { type: 'select', label: 'Country', disabled: false, options: ['US', 'CA', 'MX', 'GB'], value: 'US' },
        act_submit: { type: 'click', label: 'Place Order', disabled: false, cost: 'financial' },
    },
    media: {},
    body_segments: [
        { kind: 'heading', level: 1, text: 'Checkout' },
        { kind: 'tag', tag: 'INPUT', ref: 'act_email' },
        { kind: 'tag', tag: 'INPUT', ref: 'act_addr1' },
        { kind: 'tag', tag: 'INPUT', ref: 'act_city' },
        { kind: 'tag', tag: 'INPUT', ref: 'act_zip' },
        { kind: 'tag', tag: 'INPUT', ref: 'act_country' },
        { kind: 'tag', tag: 'ACTION', ref: 'act_submit' },
    ],
    cookies: { banner_present: false },
}

export const cloudflareBlocked: RawExtraction = {
    title: 'Just a moment...',
    url: 'https://protected.example.com/',
    language: 'en',
    direction: 'ltr',
    state: { loading: true, modal_open: false, ssl: 'valid' },
    actions: {},
    media: {},
    body_segments: [
        { kind: 'tag', tag: 'CHALLENGE', ref: 'cloudflare' },
        { kind: 'heading', level: 1, text: 'Just a moment...' },
        { kind: 'paragraph', text: 'The site is using Cloudflare to verify visitors.' },
    ],
    cookies: { banner_present: false },
}

export const spaWithModal: RawExtraction = {
    title: 'Dashboard — Acme',
    url: 'https://app.example.com/dashboard',
    language: 'en',
    direction: 'ltr',
    state: { loading: false, modal_open: true, ssl: 'valid' },
    actions: {
        act_filter: { type: 'type', label: 'Filter projects', disabled: false },
        act_create: { type: 'click', label: 'New Project', disabled: false },
        act_confirm_delete: { type: 'click', label: 'Delete project', disabled: false, cost: 'destructive' },
        act_cancel: { type: 'click', label: 'Cancel', disabled: false },
    },
    media: {},
    body_segments: [
        { kind: 'tag', tag: 'MODAL', ref: 'mod_delete' },
        { kind: 'heading', level: 1, text: 'Confirm Deletion' },
        { kind: 'paragraph', text: 'Are you sure?' },
        { kind: 'tag', tag: 'ACTION', ref: 'act_confirm_delete' },
        { kind: 'tag', tag: 'ACTION', ref: 'act_cancel' },
        { kind: 'separator' },
        { kind: 'heading', level: 1, text: 'Dashboard' },
        { kind: 'tag', tag: 'INPUT', ref: 'act_filter' },
        { kind: 'tag', tag: 'ACTION', ref: 'act_create' },
    ],
    cookies: { banner_present: false },
}

export const cookieBannerPage: RawExtraction = {
    title: 'Welcome to Example',
    url: 'https://example.com/',
    language: 'en',
    direction: 'ltr',
    state: { loading: false, modal_open: false, ssl: 'valid' },
    actions: {
        act_cookie_accept: { type: 'click', label: 'Accept All Cookies', disabled: false },
        act_signup: { type: 'click', label: 'Get Started', disabled: false },
    },
    media: {},
    body_segments: [
        { kind: 'tag', tag: 'ACTION', ref: 'act_cookie_accept' },
        { kind: 'heading', level: 1, text: 'Welcome' },
        { kind: 'paragraph', text: 'The fastest way to do X.' },
        { kind: 'tag', tag: 'ACTION', ref: 'act_signup' },
    ],
    cookies: { banner_present: true, banner_action_id: 'act_cookie_accept' },
}
