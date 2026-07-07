#!/usr/bin/env node
/**
 * Copy GSD hooks to dist for installation.
 */

const fs = require('fs');
const path = require('path');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const DIST_DIR = path.join(HOOKS_DIR, 'dist');

// Hooks to copy (pure Node.js, no bundling needed)
const HOOKS_TO_COPY = [
  'gsd-check-update.js',
  'gsd-context-monitor.js',
  'gsd-statusline.js',
  // v3.5 output-compression rewrite hooks (.cjs, copied verbatim). These
  // require('./lib/...') deps, staged into dist/lib below.
  'gsd-compress-gate.cjs',
  'gsd-compress-post.cjs'
];

// Shared lib deps the compression hooks require at runtime
// (hooks/gsd-compress-gate.cjs + gsd-compress-post.cjs both do
//  require('./lib/hook-common.cjs') + require('./lib/compress-classify.cjs')).
// Staged into dist/lib so a registered hook can resolve them post-install.
// NOTE: get-shit-done/bin/gsd-compress.cjs (the post hook's other dep) is NOT
// staged here — get-shit-done/ ships wholesale via the installer.
const LIB_TO_COPY = [
  'hook-common.cjs',
  'compress-classify.cjs'
];

function build() {
  // Ensure dist directory exists
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }

  // Copy hooks to dist
  for (const hook of HOOKS_TO_COPY) {
    const src = path.join(HOOKS_DIR, hook);
    const dest = path.join(DIST_DIR, hook);

    if (!fs.existsSync(src)) {
      console.warn(`Warning: ${hook} not found, skipping`);
      continue;
    }

    console.log(`Copying ${hook}...`);
    fs.copyFileSync(src, dest);
    console.log(`  → ${dest}`);
  }

  // Stage the compression hooks' shared lib deps into dist/lib so their
  // require('./lib/...') calls resolve from the installed tree.
  const distLibDir = path.join(DIST_DIR, 'lib');
  fs.mkdirSync(distLibDir, { recursive: true });
  for (const libFile of LIB_TO_COPY) {
    const s = path.join(HOOKS_DIR, 'lib', libFile);
    const d = path.join(distLibDir, libFile);

    if (!fs.existsSync(s)) {
      console.warn(`Warning: lib/${libFile} not found, skipping`);
      continue;
    }

    console.log(`Copying lib/${libFile}...`);
    fs.copyFileSync(s, d);
    console.log(`  → ${d}`);
  }

  console.log('\nBuild complete.');
}

build();
