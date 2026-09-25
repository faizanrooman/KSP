#!/usr/bin/env node
// Summarise tests/e2e/artifacts/a11y/*.json: one line per page with violation counts by impact (+ rule ids).
//   node tests/e2e/scripts/axe-summary.mjs [--rules] [--markdown]
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(import.meta.dirname, '../artifacts/a11y');
const rules = process.argv.includes('--rules');
const md = process.argv.includes('--markdown');
const rows = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')))
  .sort((a, b) => a.page.localeCompare(b.page));
const count = (s, imp) => s.violations.filter((v) => v.impact === imp).reduce((n, v) => n + v.nodes, 0);
if (md) console.log('| Page | critical | serious | moderate | minor | rules |\n|---|---|---|---|---|---|');
for (const s of rows) {
  const c = ['critical', 'serious', 'moderate', 'minor'].map((i) => count(s, i));
  const ids = s.violations.map((v) => `${v.wcag === false ? 'bp:' : ''}${v.id}(${v.impact?.[0]}${v.nodes})`).join(' ');
  if (md) console.log(`| ${s.page} | ${c.join(' | ')} | ${ids || '—'} |`);
  else console.log(`${s.page.padEnd(40)} C${c[0]} S${c[1]} M${c[2]} m${c[3]}  ${ids}`);
  if (rules) for (const v of s.violations) console.log(`    ${v.id} [${v.impact}] ${v.help} :: ${v.targets.slice(0, 3).join(' | ')}`);
}
