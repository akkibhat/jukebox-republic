// One-shot release script: bumps package.json's version, stamps it into
// public/*.html (see stamp-version.mjs), commits, pushes, tags, and creates
// a GitHub Release listing every commit since the last tag. Run manually -
// `node scripts/release.mjs patch|minor|major` (or an explicit
// `node scripts/release.mjs 1.2.0`).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgPath = path.join(rootDir, 'package.json');

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/release.mjs <patch|minor|major|X.Y.Z>');
  process.exit(1);
}

function bump(version, kind) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  return kind; // an explicit X.Y.Z was passed instead of a bump kind
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const nextVersion = bump(pkg.version, arg);
console.log(`${pkg.version} -> ${nextVersion}`);

// Captured before any commits happen below, so it's genuinely "the tag
// before this release" rather than something that could shift underneath
// us. `gh release create --generate-notes` looks empty-handed on this repo
// - it builds its "What's Changed" list from merged PRs, and everything
// here is a direct commit to main - so the release body is built by hand
// from the real commit log instead.
let previousTag = null;
try {
  previousTag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: rootDir }).toString().trim();
} catch {
  // No prior tag - this is the first release, so the range below covers
  // the whole history up to HEAD.
}

pkg.version = nextVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd: rootDir, stdio: 'inherit' });
}

run('node', ['scripts/stamp-version.mjs']);
run('git', ['add', 'package.json', 'public/index.html', 'public/host.html', 'public/guest.html']);
run('git', ['commit', '-m', `Release v${nextVersion}`]);
run('git', ['push']);
run('git', ['tag', '-a', `v${nextVersion}`, '-m', `v${nextVersion}`]);
run('git', ['push', 'origin', `v${nextVersion}`]);

const range = previousTag ? `${previousTag}..HEAD` : 'HEAD';
const commitList = execFileSync('git', ['log', '--reverse', '--format=- `%h` %s', range], { cwd: rootDir })
  .toString()
  .trim();
const notes = `## What changed\n\n${commitList}\n`;
run('gh', ['release', 'create', `v${nextVersion}`, '--title', `v${nextVersion}`, '--notes', notes]);

console.log(`\nReleased v${nextVersion}.`);
