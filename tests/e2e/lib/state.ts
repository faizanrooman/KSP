/** Values shared between spec files within one run (specs run in file order with one worker). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATE_DIR } from './env';

const FILE = resolve(STATE_DIR, 'run.json');

export function runId(): string {
  const f = resolve(STATE_DIR, 'run-id');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : 'adhoc';
}

export function getState<T = string>(key: string): T | undefined {
  if (!existsSync(FILE)) return undefined;
  return (JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, T>)[key];
}

export function setState(key: string, value: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const all = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown>) : {};
  all[key] = value;
  writeFileSync(FILE, JSON.stringify(all, null, 2));
}
