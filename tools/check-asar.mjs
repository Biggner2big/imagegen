/**
 * Development tool: verifies that every `require('pkg')` inside a packaged
 * app.asar can actually be resolved from the requiring file's location.
 *
 *   node tools/check-asar.mjs "dist/win-unpacked/resources/app.asar"
 *
 * Prints unresolved package names grouped by requiring file. Exit code 1 when
 * anything is unresolved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const asarPath = path.resolve(process.argv[2] || path.join(projectRoot, 'dist', 'win-unpacked', 'resources', 'app.asar'));
const extractDir = path.join(projectRoot, '.cache', 'asar-extract');

fs.rmSync(extractDir, { recursive: true, force: true });
fs.mkdirSync(extractDir, { recursive: true });
asar.extractAll(asarPath, extractDir);

const builtins = new Set(require('node:module').builtinModules.flatMap((name) => [name, `node:${name}`]));
const JS_EXT = new Set(['.js', '.cjs', '.mjs']);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (JS_EXT.has(path.extname(entry.name))) files.push(full);
  }
}
walk(extractDir);

function packageName(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.slice(0, 2).join('/');
  }
  return specifier.split('/')[0];
}

function resolves(fromFile, pkgName) {
  let dir = path.dirname(fromFile);
  while (true) {
    const candidate = path.join(dir, 'node_modules', pkgName, 'package.json');
    if (fs.existsSync(candidate)) return true;
    // Never escape the extracted app root into the project's own node_modules.
    if (dir === extractDir) return false;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

const IGNORED_PATH = /(^|[\\/])(bench|benchmark|benchmarks|test|tests|example|examples|install)[\\/]|\.(test|bench|min)\.(js|cjs|mjs)$|eslint\.config\.js$|\.config\.js$/;

const unresolved = new Map();
let requiresChecked = 0;

for (const file of files) {
  const relative = path.relative(extractDir, file);
  if (IGNORED_PATH.test(relative)) continue;
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    continue;
  }
  const regex = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    const specifier = match[2];
    if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue;
    if (builtins.has(specifier)) continue;
    requiresChecked += 1;
    const pkgName = packageName(specifier);
    if (!pkgName) continue;
    if (resolves(file, pkgName)) continue;

    if (!unresolved.has(pkgName)) unresolved.set(pkgName, new Set());
    unresolved.get(pkgName).add(relative);
  }
}

console.log(`asar: ${asarPath}`);
console.log(`js files scanned: ${files.length}`);
console.log(`bare require() calls checked: ${requiresChecked}`);
if (unresolved.size === 0) {
  console.log('OK: every required package resolves inside the asar');
  process.exit(0);
}

console.log(`\nUNRESOLVED PACKAGES (${unresolved.size}):`);
for (const [pkgName, requirers] of [...unresolved.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${pkgName}`);
  for (const requirer of [...requirers].slice(0, 4)) console.log(`      <- ${requirer}`);
}
process.exit(1);
