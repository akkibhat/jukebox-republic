// Stamps package.json's version into public/*.html before a deploy: the
// visible "vX.Y.Z" tag next to the brand bar, and a ?v=X.Y.Z cache-busting
// query string on every local /js and /css reference. Firebase Hosting
// serves these HTML files as static content with no server-side templating
// available in production, so there's no request-time way to inject the
// version - this is a deliberate pre-deploy step instead of a build tool,
// matching the project's no-bundler setup. Run it, review the diff, commit,
// deploy: `node scripts/stamp-version.mjs`.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

const targets = ['public/index.html', 'public/host.html', 'public/guest.html'];

for (const relPath of targets) {
  const filePath = path.join(rootDir, relPath);
  let html = readFileSync(filePath, 'utf8');

  // The visible tag - matches whatever version text is already there.
  html = html.replace(
    /(<span class="app-version" id="app-version"[^>]*>)v[\d.]+(<\/span>)/,
    `$1v${version}$2`
  );

  // Cache-busting query string on local script/stylesheet references only -
  // never touches /socket.io/socket.io.js (server-provided, not ours) or
  // any external URL.
  html = html.replace(
    /((?:src|href)="\/(?:js|css)\/[^"?]+)(\?v=[^"]*)?"/g,
    `$1?v=${version}"`
  );

  writeFileSync(filePath, html);
  console.log(`stamped ${relPath} -> v${version}`);
}

// The same stamp on the scripts' own imports (`from './queueApp.js'`).
// Without it, a phone could pair a freshly loaded page with a shared
// module it cached from the last release for up to an hour (Hosting's
// default cache). Every import of a module gets the same stamp, so the
// browser still loads each module once, not two copies under two URLs.
const jsDir = path.join(rootDir, 'public', 'js');
for (const name of readdirSync(jsDir).filter((f) => f.endsWith('.js'))) {
  const filePath = path.join(jsDir, name);
  const source = readFileSync(filePath, 'utf8');
  const stamped = source.replace(
    /(from\s+['"]\.\/[^'"?]+\.js)(\?v=[^'"]*)?(['"])/g,
    `$1?v=${version}$3`
  );
  if (stamped !== source) {
    writeFileSync(filePath, stamped);
    console.log(`stamped public/js/${name} imports -> v${version}`);
  }
}
