import { defineConfig } from 'vitest/config'

/**
 * Root vitest config.
 *
 * Default `exclude` is fine for `node_modules` BUT our `pieces/agentmark`
 * subdirectory has its own `node_modules/@thinkfleet/agentmark` symlinked
 * back to the root. That makes vitest's globs recurse into the piece's
 * test directory through the symlink and run root tests *twice* — once
 * normally and once from the piece's module-resolution graph, which loads
 * separate module instances and breaks `instanceof` checks. Explicitly
 * exclude any sibling package's tests; each package runs its own suite.
 */
export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        exclude: [
            '**/node_modules/**',
            '**/dist/**',
            'pieces/**',
        ],
    },
})
