// Shared helpers for the HTTP load scripts (autocannon). Plain ESM, no build step:
//   node tests/perf/api-load.mjs --base http://127.0.0.1:4130
// Requests carry a random X-Forwarded-For from a pool so per-IP rate limits behave as with many clients
// (start the API with TRUST_PROXY=true for this); every other production control stays on.
import autocannon from 'autocannon';

export const BASE = process.env.PERF_BASE ?? 'http://127.0.0.1:4130';
export const PASSWORD = process.env.PERF_PASSWORD ?? 'Ksp@Dev-Passw0rd!';
const ip = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${(i & 255) || 1}`;
let ipSeq = 1;
export const nextIp = () => ip(ipSeq++);

export async function login(username, password = PASSWORD) {
  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
    body: JSON.stringify({ username, password, tokenMode: 'bearer' }),
  });
  if (r.status !== 200) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
  return (await r.json()).accessToken;
}

export async function getJson(path, token) {
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': nextIp() } });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function postJson(path, token, body) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

/**
 * Run one autocannon scenario. `requests` is an array of autocannon request objects (method/path/body/headers);
 * they are cycled. Returns a compact result row.
 */
export async function run(name, { connections, duration = Number(process.env.PERF_DURATION ?? 15), requests, token, amount }) {
  let n = 0;
  const res = await autocannon({
    url: BASE,
    connections,
    duration: amount ? undefined : duration,
    amount,
    timeout: 60,
    requests: requests.map((r) => ({
      ...r,
      setupRequest: (req) => {
        n++;
        req.headers = { ...(req.headers ?? {}), 'x-forwarded-for': ip(100000 + (n % 50000)), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(r.method === 'POST' ? { 'content-type': 'application/json' } : {}) };
        return r.setup ? r.setup(req, n) : req;
      },
    })),
  });
  const row = {
    scenario: name, connections, requests: res.requests.total, rps: Math.round(res.requests.average), p50: res.latency.p50, p95: pct(res, 95), p99: res.latency.p99,
    max: res.latency.max, errors: res.errors + res.timeouts, non2xx: res.non2xx, mbps: +(res.throughput.average / 1048576).toFixed(2),
  };
  console.log(JSON.stringify(row));
  return row;
}

// autocannon reports p2_5, p50, p75, p90, p97_5, p99; p95 is interpolated between p90 and p97.5.
function pct(res, p) {
  if (res.latency[`p${p}`] !== undefined) return res.latency[`p${p}`];
  const a = res.latency.p90, b = res.latency.p97_5;
  return +(a + ((b - a) * (95 - 90)) / (97.5 - 90)).toFixed(1);
}
