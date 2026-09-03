/* Static checks on the pages: every element id a script reaches for must exist
   in its HTML, and every script a page loads must exist on disk. Cheap, and it
   catches the rename-one-side mistake that only shows up as a null crash. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

/**
 * Ids that legitimately may not be in a page's HTML:
 *  - media-el is built at runtime by renderMedia()
 *  - banner is optional; common.js's banner() no-ops when the page has no strip
 */
const OPTIONAL_IDS = new Set(['media-el', 'banner']);

const PAGES = [
  { html: 'index.html', scripts: ['common.js', 'shapes.js', 'pads.js', 'join.js'] },
  { html: 'host.html', scripts: ['common.js', 'shapes.js', 'pads.js', 'stage.js', 'host.js'] },
  { html: 'admin.html', scripts: ['common.js', 'shapes.js', 'admin.js', 'chat.js'] },
];

let pass = 0,
  fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${extra}`);
  }
};

for (const page of PAGES) {
  const html = fs.readFileSync(path.join(PUBLIC, page.html), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

  // Every <script src> and <link href> the page pulls in must be a real file.
  const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
  for (const asset of assets) {
    if (asset.startsWith('/socket.io/')) continue; // served by the socket.io server
    check(
      `${page.html} → ${asset} exists`,
      fs.existsSync(path.join(PUBLIC, asset.replace(/^\//, ''))),
    );
  }

  for (const script of page.scripts) {
    const source = fs.readFileSync(path.join(PUBLIC, 'js', script), 'utf8');
    const used = new Set([...source.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
    const missing = [...used].filter((id) => !ids.has(id) && !OPTIONAL_IDS.has(id));
    check(`${page.html} + ${script}: all element ids resolve`, missing.length === 0, missing.join(', '));
  }
}

// Every button must actually do something. A button whose handler was lost in a
// refactor looks perfectly fine on screen and silently does nothing when clicked.
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(PUBLIC, page.html), 'utf8');
  const source = page.scripts
    .map((s) => fs.readFileSync(path.join(PUBLIC, 'js', s), 'utf8'))
    .join('\n');

  for (const tag of html.match(/<button\b[^>]*>/g) ?? []) {
    const id = /id="([^"]+)"/.exec(tag)?.[1];
    if (!id) continue;

    const wired = source.includes(`$('${id}').addEventListener`);
    const inline = /\bon[a-z]+=/.test(tag); // e.g. onclick="…"
    const submits = /type="submit"/.test(tag); // handled by its form's submit

    check(`${page.html}: #${id} is wired to something`, wired || inline || submits, tag.slice(0, 70));
  }
}

// Screen lists must name real elements, or showScreen() silently does nothing.
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(PUBLIC, page.html), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const script of page.scripts) {
    const source = fs.readFileSync(path.join(PUBLIC, 'js', script), 'utf8');
    const match = /const SCREENS = \[([^\]]+)\]/.exec(source);
    if (!match) continue;
    const screens = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const missing = screens.filter((id) => !ids.has(id));
    check(`${page.html}: SCREENS all exist`, missing.length === 0, missing.join(', '));
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
