/** Regenerate packages/core/src/db/types.ts from the live (migrated) dev database. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfig, repoRoot } from '../config.js';

const cfg = loadConfig();
const out = resolve(repoRoot(), 'packages/core/src/db/types.ts');
execFileSync(
  'npx',
  ['kysely-codegen', '--dialect', 'postgres', '--url', cfg.DATABASE_MIGRATION_URL ?? cfg.DATABASE_URL, '--out-file', out, '--exclude-pattern', 'schema_migrations', '--default-schema', 'public', '--include-pattern', 'public.*'],
  { stdio: 'inherit' },
);

// Runtime parsers in db/index.ts return int8/numeric as JS numbers; make the types agree.
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync(out, 'utf8')
  .replace('export type Int8 = ColumnType<string,', 'export type Int8 = ColumnType<number,')
  .replace('export type Numeric = ColumnType<string,', 'export type Numeric = ColumnType<number,');
writeFileSync(out, src);
