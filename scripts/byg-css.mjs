/* Bygger assets/tailwind.css ud af de klasser siderne faktisk bruger.
 *
 *   node scripts/byg-css.mjs
 *
 * Kør den, når du har tilføjet en Tailwind-klasse i en HTML-fil. Gør du det
 * ikke, findes klassen ikke i stylesheetet, og den gør ingenting — stille.
 * Derfor siger scriptet også, hvor stor filen blev, så en pludselig ændring
 * kan ses.
 *
 * Vi bruger den samme version, play-CDN'en serverede (3.4.17), så det der
 * bygges er det samme, der blev vist før.
 */
import { spawnSync } from 'node:child_process';
import { statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'assets/tailwind.css');

const dir = mkdtempSync(join(tmpdir(), 'tw-'));
const input = join(dir, 'ind.css');
writeFileSync(input, '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');

const before = (() => { try { return statSync(OUT).size; } catch { return 0; } })();

const r = spawnSync('npx', ['-y', 'tailwindcss@3.4.17',
  '-c', resolve(ROOT, 'tailwind.config.js'), '-i', input, '-o', OUT, '--minify'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

if (r.status !== 0) {
  console.error(r.stderr || r.stdout);
  process.exit(1);
}
const after = statSync(OUT).size;
console.log(`assets/tailwind.css: ${(after / 1024).toFixed(1)} KB`
  + (before ? ` (var ${(before / 1024).toFixed(1)} KB)` : ''));
