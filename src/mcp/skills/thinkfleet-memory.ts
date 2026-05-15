/**
 * The canonical ThinkFleet Memory skill — instruction packet that
 * teaches AI tools (Claude Code, Cursor, Codex, Copilot, Windsurf)
 * when and how to use the `agentmark_memory_*` MCP tools.
 *
 * Inlined as a string constant on purpose:
 *   - Skill content travels with the @thinkfleet/agentmark npm
 *     package — no separate asset to bundle, no runtime path-
 *     resolution to debug across `npx`, global install, and
 *     ThinkFleet Desktop's bundled-layout deployments.
 *   - Easy to diff in code review when we evolve the skill.
 *
 * Versioning:
 *   `version: 1` in the frontmatter is a content version (not a
 *   semver). The skill installer treats different versions as
 *   different content and rewrites the on-disk skill file when
 *   the version bumps. Add a CHANGELOG note when bumping.
 */

export const THINKFLEET_MEMORY_SKILL_NAME = 'thinkfleet-memory'

export const THINKFLEET_MEMORY_SKILL_VERSION = 1

/**
 * Markdown body of the skill with YAML frontmatter. Claude-family
 * tools read the frontmatter to populate the skill catalog UI; the
 * markdown body is the prompt the agent reads at session start.
 *
 * Tools that don't have a native "skills" concept (Cursor, Windsurf,
 * Codex CLI) get the same content rendered as a managed block inside
 * their rules file — see `src/mcp/install/skills.ts`.
 */
export const THINKFLEET_MEMORY_SKILL = `---
name: thinkfleet-memory
version: ${THINKFLEET_MEMORY_SKILL_VERSION}
description: Hierarchical persistent memory across every AI session, project, and tool.
triggers:
  - At session start, load context for the current project.
  - When the user shares a preference, decision, or fact — save it.
  - Before asking the user a question whose answer might already be remembered, search memory first.
  - When the user says "remember that…", "from now on…", or "going forward…" — save verbatim to the implied scope.
tools:
  - agentmark_memory_get
  - agentmark_memory_set
  - agentmark_memory_search
  - agentmark_memory_list
  - agentmark_memory_delete
---

# Using ThinkFleet Memory

You have access to a hierarchical persistent memory system that survives
across all sessions, in every project, on every machine the user works on.
Memory is organized into five scopes; pick the right one when saving.

## Mandatory: at session start

The very first thing you do in a new conversation is call:

\`\`\`
agentmark_memory_search({ query: "", scope: { type: "project", id: "<current absolute path>" }, limit: 20 })
\`\`\`

…then for facts about the human:

\`\`\`
agentmark_memory_list({ scope: { type: "user", id: "<their email or stable id>" }, limit: 50 })
\`\`\`

…and for things they want you to always know:

\`\`\`
agentmark_memory_list({ scope: { type: "platform" }, limit: 50 })
\`\`\`

Read what comes back. **Do not** re-ask the user about anything covered
there. If they tell you something contradicting a memory, save the new
fact (it supersedes the old by recency).

## During the session, save without being asked

Whenever the user shares one of these, call \`agentmark_memory_set\` immediately:

- **Preferences**: "I prefer pnpm" → \`set('prefs.package-manager', 'pnpm', scope: 'user')\`
- **Facts about you**: "I'm a senior eng at X" → \`set('user.role', 'senior eng', scope: 'user')\`
- **Project conventions**: "this repo uses ESM" → \`set('repo.module-system', 'esm', scope: 'project')\`
- **Decisions made**: "we chose lance for vectors" → \`set('decision.vector-store', 'lance', scope: 'project')\`
- **Build / test commands**: "tests run with pnpm test" → \`set('repo.test-command', 'pnpm test', scope: 'project')\`
- **"Remember that…" / "From now on…"**: save the exact statement, scope = whatever it sounds like (user-level if it's about them; project-level if scoped to this repo).

You don't have to ask permission first. Saving is cheap and reversible.

## Before guessing about the user's environment

If you'd otherwise ask the user *"what shell do you use?"*, *"what's your editor?"*,
*"what's our deploy command?"* — search memory first:

\`\`\`
agentmark_memory_search({ query: "shell editor deploy", scope: { type: "user", id: "..." } })
agentmark_memory_search({ query: "shell editor deploy", scope: { type: "project", id: "..." } })
\`\`\`

If it's there, use it. If not, ask once and then save the answer.

## Scope picker

| Scope | When to use | \`id\` value |
|---|---|---|
| **platform** | Things that should be true forever, across every project. Brand, voice, top-level user identity. | (none — pass scope as \`{ type: "platform" }\`) |
| **user** | Personal preferences, role, identity. Spans every project. | The user's stable id (email or display name). |
| **project** | Conventions of THIS repo. Tech stack, commands, decisions. | The absolute path to the repo root. |
| **agent** | Rarely needed. Use when memory is specific to one AI tool (e.g. only Claude Code uses this). | The agent / tool name. |
| **session** | Just this conversation. Use sparingly — most useful info should outlive the chat. | The MCP session id. |

When in doubt, prefer **user** over **session**, **project** over **user**.
A memory in the wrong scope is recoverable; a memory you didn't save is gone.

## Failure modes (read these once)

- **\`memory_set\` returns \`{ saved: true, record: null }\`** — the SaaS backend rejected the value. Don't retry; tell the user "memory save failed" and proceed.
- **\`memory_get\` for a key returns \`null\`** — not an error; nothing was saved under that key in the queried scope(s).
- **All memory tools throw** — the MCP server lost its backend connection. Continue the session; memory will recover on the next round-trip. Don't keep asking the user "is your memory working?"

## What you must NOT do

- **Don't dump every memory at the user.** Read silently; act on what you find. Surfacing every recall is noise.
- **Don't save secrets.** Tokens, passwords, private keys → never \`memory_set\`. If the user pastes one, treat it as ephemeral.
- **Don't overwrite the user.** If a memory is \`prefs.editor=vscode\` and the user says "I'm in nvim today," save a *new* memory with a session scope rather than overwriting the user-scope value.
`

/**
 * Returns a lookup table of all skills shipped with this package.
 * Today there's only one — ThinkFleet Memory — but the shape is set
 * up so future skills (recipes, lattice observe, industry packs)
 * can register without touching the installer.
 */
export const BUILT_IN_SKILLS: Record<string, { version: number; content: string }> = {
    [THINKFLEET_MEMORY_SKILL_NAME]: {
        version: THINKFLEET_MEMORY_SKILL_VERSION,
        content: THINKFLEET_MEMORY_SKILL,
    },
}

export function getSkillContent(name: string): { version: number; content: string } | null {
    return BUILT_IN_SKILLS[name] ?? null
}
