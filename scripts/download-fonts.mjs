// Bundle pixel fonts locally (offline) for the 8-bit UI.
//   Press Start 2P -> headings / buttons / numbers (iconic 8-bit, used small)
//   VT323         -> body text / lists (pixel but legible at size)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'fonts');
mkdirSync(outDir, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const families = [['Pirata One', 'pirata-one'], ['IM Fell English', 'im-fell']];

for (const [family, slug] of families) {
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}&display=swap`, { headers: { 'User-Agent': UA } })).text();
  const m = css.match(/url\((https:\/\/[^)]+\.woff2)\)/); // first (latin) subset
  if (!m) { console.error('No woff2 for', family); continue; }
  const buf = Buffer.from(await (await fetch(m[1])).arrayBuffer());
  writeFileSync(join(outDir, `${slug}.woff2`), buf);
  console.log(`font ${family} -> ${slug}.woff2 (${buf.length} bytes)`);
}
console.log('Fonts bundled ->', outDir);
