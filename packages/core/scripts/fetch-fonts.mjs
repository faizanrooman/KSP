#!/usr/bin/env node
/**
 * Re-download the bundled PDF fonts from the pinned upstream commit and verify their SHA-256.
 *   node packages/core/scripts/fetch-fonts.mjs          # verify files in assets/fonts (download missing/mismatching)
 *   node packages/core/scripts/fetch-fonts.mjs --check  # verify only, never download (CI)
 * Fonts: Noto Sans + Noto Sans Kannada (SIL Open Font License 1.1, see assets/fonts/OFL.txt). The pins live in
 * assets/fonts/fonts.json, which the runtime (src/pdf-fonts.ts) also checks before embedding a font.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');
const manifest = JSON.parse(await readFile(join(dir, 'fonts.json'), 'utf8'));
const checkOnly = process.argv.includes('--check');
const sha = (b) => createHash('sha256').update(b).digest('hex');
let bad = 0;
for (const f of manifest.files) {
  const path = join(dir, f.file);
  const have = await readFile(path).catch(() => null);
  if (have && sha(have) === f.sha256) {
    console.log(`OK   ${f.file}`);
    continue;
  }
  if (checkOnly) {
    console.log(`FAIL ${f.file}: ${have ? 'sha256 mismatch' : 'missing'}`);
    bad++;
    continue;
  }
  const url = `${manifest.baseUrl}/${manifest.commit}/${f.path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (sha(body) !== f.sha256) {
    console.log(`FAIL ${f.file}: downloaded sha256 ${sha(body)} != pinned ${f.sha256}`);
    bad++;
    continue;
  }
  await writeFile(path, body);
  console.log(`GOT  ${f.file}`);
}
process.exit(bad ? 1 : 0);
