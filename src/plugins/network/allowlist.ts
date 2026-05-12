// URL allowlist matching for the Network Pack.
//
// Patterns use shell-style globbing on hostname + path. Examples:
//   "https://api.example.com/[asterisk]"          — any path under that host
//   "https://[asterisk].example.com/[asterisk]"   — any subdomain
//   "wss://[asterisk].realtime.example.com/[asterisk]" — WebSocket allowlist
//
// (literal "*" in patterns — written here as [asterisk] only because
// the closing "*/" of a JSDoc comment would otherwise be triggered.)
//
// Default allowlist is empty — requests will be refused with a helpful
// error until the operator explicitly configures one. This prevents the
// agent from exfiltrating data to arbitrary endpoints.

export interface Allowlist {
    /** Glob-style patterns. Empty list = deny all. */
    patterns: string[]
}

export class UrlAllowlist {
    readonly patterns: string[]
    private readonly compiled: RegExp[]

    constructor(patterns: string[] = []) {
        this.patterns = patterns
        this.compiled = patterns.map((p) => globToRegex(p))
    }

    /** True if `url` matches at least one configured pattern. */
    allows(url: string): boolean {
        return this.compiled.some((re) => re.test(url))
    }

    /**
     * Throws with a clear message if `url` is not allowed. Used at the
     * boundary of every handler so the agent gets actionable feedback.
     */
    assertAllowed(url: string): void {
        if (this.patterns.length === 0) {
            throw new Error(
                'Network allowlist is empty. The agent cannot make HTTP or '
                + 'WebSocket calls until the operator configures one. Set '
                + '`urlAllowlist` on createNetworkPlugin() or AGENTMARK_HTTP_ALLOWLIST.',
            )
        }
        if (!this.allows(url)) {
            throw new Error(
                `URL not in allowlist: ${url}. Configured patterns: `
                + this.patterns.map((p) => `"${p}"`).join(', '),
            )
        }
    }
}

/**
 * Convert a glob pattern to a regex. `*` matches any character except
 * `/`; `**` matches any character including `/`. Other regex
 * metacharacters are escaped.
 */
function globToRegex(pattern: string): RegExp {
    let out = '^'
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i]
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                out += '.*'
                i++
            } else {
                out += '[^/]*'
            }
        } else if ('.+?^$(){}[]|\\'.includes(ch)) {
            out += '\\' + ch
        } else {
            out += ch
        }
    }
    out += '$'
    return new RegExp(out)
}
