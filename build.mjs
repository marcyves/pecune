const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 22) {
  console.error(`Node ${process.version} (${process.arch}) est trop ancien pour construire l’application.`)
  console.error('Il faut Node 22 ou plus récent, celui d’Homebrew :')
  console.error('  /opt/homebrew/bin/npm start')
  process.exit(1)
}

const { build } = await import('esbuild')
const { copyFile, mkdir } = await import('node:fs/promises')

await mkdir('dist/renderer', { recursive: true })

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/main.js',
  external: ['electron'],
  packages: 'external',
})

await build({
  entryPoints: ['src/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/preload.cjs',
  external: ['electron'],
})

await build({
  entryPoints: ['src/renderer/renderer.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  outfile: 'dist/renderer/renderer.js',
})

await copyFile('src/renderer/index.html', 'dist/renderer/index.html')
await copyFile('src/renderer/styles.css', 'dist/renderer/styles.css')
