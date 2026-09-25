#!/usr/bin/env node
/**
 * Production model provisioning (runs from the built ai-worker image — no tsx / dev dependencies needed).
 *
 *   node scripts/ops/fetch-models.mjs              download + SHA-256-verify pinned artefacts into AI_MODELS_DIR
 *                                                  and register/activate them (DATABASE_URL, operator/app role)
 *   node scripts/ops/fetch-models.mjs --no-db      download + verify only (no registration)
 *   node scripts/ops/fetch-models.mjs --verify-only
 *                                                  NEVER downloads: re-hash every artefact already in AI_MODELS_DIR
 *                                                  and exit 1 on any missing/mismatching file (ai-worker init container)
 *
 * The manifest (URLs + SHA-256 pins) is apps/ai-worker/src/models/manifest.ts — the single source of truth.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const manifest = await import(resolve(here, '../../apps/ai-worker/dist/models/manifest.js'));
const { createDb, loadConfig } = await import('@ksp/core');

const args = new Set(process.argv.slice(2));
const cfg = loadConfig();
const dir = resolve(cfg.AI_MODELS_DIR);

function sha256(file) {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', fail);
  });
}

if (args.has('--verify-only')) {
  let bad = 0;
  for (const a of Object.values(manifest.ARTIFACTS)) {
    const f = join(dir, a.file);
    if (!existsSync(f)) {
      console.log(`MISSING ${a.file}`);
      bad++;
      continue;
    }
    const got = await sha256(f);
    const ok = got === a.sha256;
    if (!ok) bad++;
    console.log(`${ok ? 'OK      ' : 'MISMATCH'} ${a.file} ${got}`);
  }
  process.exit(bad ? 1 : 0);
}

const conn = args.has('--no-db') ? null : createDb(cfg.DATABASE_URL, 2);
try {
  const res = await manifest.fetchAndRegisterModels(conn?.db ?? null, { dir, activate: !args.has('--no-activate'), log: (m) => console.log(m) });
  for (const r of res) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.task.padEnd(17)} ${r.code.padEnd(22)} ${r.status ?? ''} ${r.error ?? ''}`);
  if (res.some((r) => !r.ok)) process.exitCode = 2;
} finally {
  await conn?.db.destroy();
}
