#!/usr/bin/env node
// Patches a missing libsodium-sumo.mjs in libsodium-wrappers-sumo's ESM dist.
// The file lives in libsodium-sumo but libsodium-wrappers-sumo's ESM entry
// tries to import it from its own directory, causing ERR_MODULE_NOT_FOUND.

'use strict';

const fs = require('fs');
const path = require('path');

const src = path.join(
  __dirname, '..', 'node_modules', 'libsodium-sumo',
  'dist', 'modules-sumo-esm', 'libsodium-sumo.mjs',
);
const dst = path.join(
  __dirname, '..', 'node_modules', 'libsodium-wrappers-sumo',
  'dist', 'modules-sumo-esm', 'libsodium-sumo.mjs',
);

if (!fs.existsSync(src)) {
  // libsodium-sumo not installed — skip
  process.exit(0);
}

if (fs.existsSync(dst)) {
  // Already patched
  process.exit(0);
}

try {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log('[postinstall] patched libsodium-wrappers-sumo ESM (copied libsodium-sumo.mjs)');
} catch (e) {
  console.warn('[postinstall] could not patch libsodium-wrappers-sumo:', e.message);
  // Non-fatal — Dockerfile will have the correct Node.js version where this may be fixed
}
