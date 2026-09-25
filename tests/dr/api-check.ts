#!/usr/bin/env node
/**
 * Post-restore service checks against a running API (used by tests/dr/drill.sh):
 *   node tests/dr/api-check.ts <baseUrl> <username> <password> <expectedEvidenceCount> [--fixity]
 * login (bearer) -> evidence list (count) -> detail of each -> playback descriptor -> optional on-demand fixity
 * check executed by the worker against the (DR) object store, polled until a new successful integrity result.
 * Prints one JSON line with timings; exits 1 on any failure.
 */
const [base, username, password, expectedRaw] = process.argv.slice(2);
const fixity = process.argv.includes('--fixity');
if (!base || !username || !password || !expectedRaw) {
  console.error('usage: api-check.ts <baseUrl> <username> <password> <expectedEvidenceCount> [--fixity]');
  process.exit(2);
}
const expected = Number(expectedRaw);
const t0 = Date.now();
const timings: Record<string, number> = {};
const mark = (k: string, since: number) => { timings[k] = Date.now() - since; };

async function call(method: string, path: string, token?: string, body?: unknown): Promise<any> {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function main(): Promise<void> {
  let t = Date.now();
  const login = await call('POST', '/auth/login', undefined, { username, password, tokenMode: 'bearer' });
  const token: string = login.accessToken;
  if (!token) throw new Error(`login did not return a bearer token: ${JSON.stringify(login).slice(0, 200)}`);
  mark('loginMs', t);

  t = Date.now();
  const list = await call('GET', '/evidence?pageSize=200', token);
  mark('listMs', t);
  if (list.total !== expected) throw new Error(`evidence total ${list.total} != expected ${expected}`);

  t = Date.now();
  const ids: string[] = list.items.map((i: { id: string }) => i.id);
  for (const id of ids) {
    const d = await call('GET', `/evidence/${id}`, token);
    if (!d || (d.id ?? d.evidence?.id) !== id) throw new Error(`detail for ${id} malformed`);
    const pb = await call('GET', `/media/evidence/${id}/playback`, token);
    if (!pb) throw new Error(`no playback descriptor for ${id}`);
  }
  mark('detailAndPlaybackMs', t);

  const fixityResults: { id: string; ok: boolean; ms: number }[] = [];
  if (fixity) {
    for (const id of ids) {
      t = Date.now();
      const before = await call('GET', `/evidence/${id}/integrity`, token);
      const seen = new Set<string>((before.checks ?? before.items ?? []).map((c: { id: string }) => c.id));
      await call('POST', `/evidence/${id}/verify`, token);
      let result: { ok: boolean } | undefined;
      for (let i = 0; i < 240 && !result; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const now = await call('GET', `/evidence/${id}/integrity`, token);
        result = (now.checks ?? now.items ?? []).find((c: { id: string }) => !seen.has(c.id));
      }
      if (!result) throw new Error(`fixity check for ${id} did not complete in 120 s`);
      if (!result.ok) throw new Error(`fixity check FAILED for ${id}: ${JSON.stringify(result)}`);
      fixityResults.push({ id, ok: true, ms: Date.now() - t });
    }
  }
  console.log(JSON.stringify({ ok: true, evidence: ids.length, timings, fixity: fixityResults, totalMs: Date.now() - t0 }));
}

main().catch((err: Error) => {
  console.log(JSON.stringify({ ok: false, error: err.message, timings }));
  process.exit(1);
});
