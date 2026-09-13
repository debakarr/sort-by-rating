#!/usr/bin/env node
/**
 * Builds the unpacked extension for Chrome and Firefox from ./src, and packages
 * each build into a zip ready for the Chrome Web Store, addons.mozilla.org and
 * GitHub releases.
 *
 * Chrome, Edge, Brave, Opera, Vivaldi and other Chromium browsers all use the
 * Chrome build. Firefox desktop and Firefox for Android use the Firefox build,
 * which adds the gecko id, the Android opt-in and the data-collection
 * declaration AMO requires.
 */
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from './tools/zip.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, 'src');
const distDir = join(root, 'dist');

const targets = [
  {
    name: 'chrome',
    label: 'chromium',
    extra: {}
  },
  {
    name: 'firefox',
    label: 'firefox',
    extra: {
      browser_specific_settings: {
        gecko: {
          id: 'sort-by-rating@debakarr.github.io',
          strict_min_version: '115.0',
          // This extension collects and transmits nothing.
          data_collection_permissions: { required: ['none'] }
        },
        // Required for the add-on to be installable on Firefox for Android.
        gecko_android: { strict_min_version: '120.0' }
      }
    }
  }
];

const baseVersion = JSON.parse(readFileSync(join(srcDir, 'manifest.json'), 'utf8')).version;

for (const target of targets) {
  const outDir = join(distDir, target.name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(srcDir, outDir, { recursive: true });

  const manifestPath = join(outDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  Object.assign(manifest, target.extra);

  // Give Firefox a distinct name so it is obvious which build is loaded.
  if (target.name === 'firefox') manifest.name += ' (Firefox)';

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const zipName = `sort-by-rating-${target.label}-v${manifest.version}.zip`;
  const zipPath = join(distDir, zipName);
  const count = makeZip(outDir, zipPath);
  console.log(`built dist/${target.name} (${count} files) -> dist/${zipName}`);
}

console.log(`\nrelease zips for v${baseVersion} are in dist/`);
