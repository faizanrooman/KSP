#!/usr/bin/env node
/**
 * Merge the per-topic Kannada dictionaries (apps/web/src/i18n/kn/*.json) into the single kn.json the app imports,
 * and report coverage against the extracted UI strings (keys.json + extra-keys.json).
 *
 *   node scripts/i18n/build-dictionary.mjs            # write kn.json, print coverage
 *   node scripts/i18n/build-dictionary.mjs --check    # exit 1 if any extracted key has no translation
 *   node scripts/i18n/build-dictionary.mjs --missing  # list untranslated keys
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'web', 'src', 'i18n');
const args = new Set(process.argv.slice(2));
const dict = {};
const dupes = [];
for (const f of readdirSync(join(root, 'kn')).filter((f) => f.endsWith('.json')).sort()) {
  const part = JSON.parse(readFileSync(join(root, 'kn', f), 'utf8'));
  for (const [k, v] of Object.entries(part)) {
    if (typeof v !== 'string' || !v) throw new Error(`${f}: empty translation for ${JSON.stringify(k)}`);
    if (k in dict && dict[k] !== v) dupes.push(`${f}: ${JSON.stringify(k)}`);
    dict[k] = v;
  }
}
const keys = [...new Set([...JSON.parse(readFileSync(join(root, 'keys.json'), 'utf8')), ...JSON.parse(readFileSync(join(root, 'extra-keys.json'), 'utf8'))])];
const missing = keys.filter((k) => !(k in dict));
// placeholders must survive translation
const badVars = keys.filter((k) => k in dict && [...k.matchAll(/\{(\w+)\}/g)].some((m) => !dict[k].includes(m[0])));
const sorted = Object.fromEntries(Object.entries(dict).sort(([a], [b]) => a.localeCompare(b)));
if (!args.has('--check') && !args.has('--missing')) writeFileSync(join(root, 'kn.json'), JSON.stringify(sorted, null, 2) + '\n');
const covered = keys.length - missing.length;
console.log(`kn: ${Object.keys(dict).length} translations; ${covered}/${keys.length} extracted strings covered (${((100 * covered) / keys.length).toFixed(1)}%)`);
if (dupes.length) console.log(`conflicting duplicates (last file wins):\n  ${dupes.join('\n  ')}`);
if (badVars.length) { console.error(`placeholder mismatch:\n  ${badVars.join('\n  ')}`); process.exitCode = 1; }
if (args.has('--missing')) console.log(missing.map((k) => JSON.stringify(k)).join('\n'));
if (args.has('--check') && missing.length) { console.error(`${missing.length} untranslated keys (run with --missing)`); process.exitCode = 1; }
