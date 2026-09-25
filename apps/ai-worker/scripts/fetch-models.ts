/**
 * Download, SHA-256-verify and register the pinned AI models.
 *   npm run fetch-models -w @ksp/ai-worker [-- --no-db] [--no-activate]
 * Registration uses DATABASE_URL (operator/app role): the isolated ksp_ai role cannot write the model registry.
 */
import { createDb, loadConfig } from '@ksp/core';
import { fetchAndRegisterModels } from '../src/models/manifest.js';

const args = new Set(process.argv.slice(2));
const cfg = loadConfig();
const conn = args.has('--no-db') ? null : createDb(cfg.DATABASE_URL, 2);
try {
  const res = await fetchAndRegisterModels(conn?.db ?? null, { activate: !args.has('--no-activate'), log: (m) => console.log(m) });
  for (const r of res) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.task.padEnd(17)} ${r.code.padEnd(22)} ${r.status ?? ''} ${r.error ?? ''}`);
  if (res.some((r) => !r.ok)) {
    console.log('Some models could not be obtained: their tasks stay UNAVAILABLE (the API rejects tasks without an ACTIVE model).');
    process.exitCode = 2;
  }
} finally {
  await conn?.db.destroy();
}
