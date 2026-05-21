import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  sourcemap: true,
  treeshake: true,
  // tsup preserves the `#!/usr/bin/env node` shebang from src/index.ts and
  // marks dist/index.js executable.
})
