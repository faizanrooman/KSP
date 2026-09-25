#!/usr/bin/env node
/**
 * ksp-upload — police-station bulk evidence uploader.
 *
 *   ksp-upload --server https://vms.ksp.example --username op.cubbon --station ps_cubbonpark \
 *              [--label "Night shift"] [--state ./.ksp-upload-state.json] [--files 3] [--parts 3] \
 *              [--officer KSP-FO-1001] [--device CAM-0042] [--category PATROL] [--no-wait] <files|folders…>
 *
 * Password: prompted (hidden) or KSP_PASSWORD. TOTP (if MFA is enabled): prompted or KSP_TOTP.
 */
import { createInterface } from 'node:readline';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { DeclaredUploadMetadata } from '@ksp/shared';
import { ApiError, KspClient } from './client.js';
import { collectFiles, summaryTable, uploadFiles, type FileResult } from './uploader.js';

export const VERSION = '1.0.0';

const HELP = `ksp-upload ${VERSION} — upload body-worn camera footage to the KSP Video Evidence Management System

Usage: ksp-upload --server <url> --username <user> --station <code|id> [options] <files|folders…>

Options:
  --server <url>        VMS base URL (e.g. https://vms.ksp.example)
  --username <user>     your VMS username (password is prompted, or KSP_PASSWORD)
  --station <code|id>   police station code (e.g. ps_cubbonpark) or org unit id
  --label <text>        batch label (default: "<host> <date>")
  --state <file>        resume state file (default: ./.ksp-upload-state.json)
  --files <n>           files uploaded in parallel (default 3)
  --parts <n>           chunks per file uploaded in parallel (default 3)
  --chunk-mib <n>       preferred chunk size in MiB (5-64; default: server policy)
  --officer <badge>     default recording officer badge (sidecar <file>.json overrides)
  --device <serial>     default camera serial
  --category <text>     default category
  --no-hash             skip whole-file SHA-256 pre-computation (server still hashes)
  --no-wait             do not wait for validation/registration results
  --wait-timeout <sec>  how long to wait for results (default 900)
  -h, --help            show this help

Per-file metadata: put a JSON object next to the video as <video>.json or <video-name>.json with any of
title, description, category, officerBadge, officerId, deviceSerial, recordedAt, incidentAt,
locationText, latitude, longitude, notes.
`;

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
  prompt: (question: string, hidden: boolean) => Promise<string>;
  env: NodeJS.ProcessEnv;
}

function ttyPrompt(question: string, hidden: boolean): Promise<string> {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const w = (rl as unknown as { _writeToOutput: (s: string) => void });
      w._writeToOutput = (s: string) => {
        if (s.includes(question)) process.stdout.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      res(answer);
    });
  });
}

const defaultIO: CliIO = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  prompt: ttyPrompt,
  env: process.env,
};

export async function resolveStation(client: KspClient, station: string): Promise<{ id: string; name: string; code: string }> {
  const { items } = await client.get<{ items: Array<{ id: string; code: string; name: string; unitType: string }> }>('/directory/org-units');
  const hit = items.find((u) => u.id === station || u.code.toLowerCase() === station.toLowerCase());
  if (!hit) throw new Error(`Unknown station "${station}"`);
  return hit;
}

/** Returns the process exit code: 0 all registered/uploaded, 1 some failed/quarantined, 2 usage/auth error. */
export async function main(argv: string[], io: CliIO = defaultIO): Promise<{ code: number; results: FileResult[] }> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        server: { type: 'string' }, username: { type: 'string' }, station: { type: 'string' }, label: { type: 'string' },
        state: { type: 'string' }, files: { type: 'string' }, parts: { type: 'string' }, officer: { type: 'string' },
        device: { type: 'string' }, category: { type: 'string' }, 'no-hash': { type: 'boolean' }, 'no-wait': { type: 'boolean' },
        'wait-timeout': { type: 'string' }, 'chunk-mib': { type: 'string' }, 'poll-interval': { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    io.err(`${(err as Error).message}\n\n${HELP}`);
    return { code: 2, results: [] };
  }
  const v = args.values;
  if (v.help) {
    io.out(HELP);
    return { code: 0, results: [] };
  }
  if (!v.server || !v.username || !v.station || !args.positionals.length) {
    io.err(`--server, --username, --station and at least one file or folder are required.\n\n${HELP}`);
    return { code: 2, results: [] };
  }
  const { files, skipped } = await collectFiles(args.positionals);
  for (const s of skipped) io.err(`skipping ${s}: not an accepted video file type`);
  if (!files.length) {
    io.err('No video files found.');
    return { code: 2, results: [] };
  }

  const client = new KspClient(v.server, `ksp-station-client/${VERSION} (${hostname()})`);
  try {
    const password = io.env.KSP_PASSWORD ?? (await io.prompt(`Password for ${v.username}: `, true));
    const me = await client.login({
      username: v.username,
      password,
      totp: async () => io.env.KSP_TOTP ?? (await io.prompt('Authenticator code: ', false)),
    });
    if (me.mustChangePassword || me.mfaEnrollmentRequired) {
      io.err('Your account must change its password / enrol MFA in the web application before uploading.');
      return { code: 2, results: [] };
    }
    io.out(`Logged in as ${me.fullName} (${me.username})`);
  } catch (err) {
    io.err(`Login failed: ${err instanceof ApiError ? err.message : (err as Error).message}`);
    return { code: 2, results: [] };
  }

  try {
    const station = await resolveStation(client, v.station);
    const label = v.label ?? `${hostname()} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const batch = await client.post<{ id: string }>('/uploads/batches', { orgUnitId: station.id, label, clientInfo: { client: 'ksp-station-client', version: VERSION, host: hostname(), files: files.length } });
    const total = files.length;
    io.out(`Station: ${station.name} (${station.code}) · batch ${batch.id} · ${total} file(s)`);
    const defaults: DeclaredUploadMetadata = {};
    if (v.officer) defaults.officerBadge = v.officer;
    if (v.device) defaults.deviceSerial = v.device;
    if (v.category) defaults.category = v.category;
    const started = Date.now();
    const results = await uploadFiles(client, files, {
      orgUnitId: station.id,
      batchId: batch.id,
      chunkSize: v['chunk-mib'] ? Number(v['chunk-mib']) * 1048576 : undefined,
      fileConcurrency: Number(v.files ?? 3) || 3,
      partConcurrency: Number(v.parts ?? 3) || 3,
      statePath: resolve(v.state ?? '.ksp-upload-state.json'),
      hashFiles: !v['no-hash'],
      waitMs: v['no-wait'] ? 0 : (Number(v['wait-timeout'] ?? 900) || 900) * 1000,
      pollIntervalMs: Number(v['poll-interval'] ?? 3000) || 3000,
      defaults,
      log: io.out,
    });
    const bytes = results.reduce((a, r) => a + r.size, 0);
    const secs = Math.max(0.001, (Date.now() - started) / 1000);
    io.out('');
    io.out(summaryTable(results));
    io.out('');
    const count = (s: FileResult['status']) => results.filter((r) => r.status === s).length;
    io.out(`${count('REGISTERED')} registered, ${count('QUARANTINED')} quarantined, ${count('PROCESSING') + count('UPLOADED')} processing, ${count('FAILED')} failed · ${(bytes / 1048576 / secs).toFixed(1)} MiB/s`);
    const bad = results.some((r) => r.status === 'FAILED' || r.status === 'QUARANTINED' || r.status === 'REJECTED');
    return { code: bad ? 1 : 0, results };
  } catch (err) {
    io.err(`Error: ${err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message}`);
    return { code: 2, results: [] };
  } finally {
    await client.logout();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(({ code }) => process.exit(code), (err: unknown) => {
    process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
    process.exit(2);
  });
}
