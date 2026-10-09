#!/usr/bin/env node
/**
 * Load realistic DEMO content into a running KSP VMS through its public API (the same paths officers use):
 * body-worn-camera style videos are generated with FFmpeg from the licensed test photographs (street, crowd, number
 * plate, portrait — see apps/ai-worker/test/fixtures/images/README.md), uploaded with the resumable upload protocol
 * (chunk hashes, WORM registration, playback renditions), then FIRs, cases, case-diary notes, tags, AI analyses, an
 * investigation workspace with bookmarks and a court-export request are created on top.
 *
 *   node scripts/demo/load-demo-content.mjs --api https://ksp.example [--password <demo password>] [--force]
 *
 * Env: KSP_API, DEMO_PASSWORD, IMAGES_DIR (default apps/ai-worker/test/fixtures/images), WORK (scratch, default tmp),
 *      FFMPEG (default ffmpeg; needs libx264, aac and the libass `ass` filter — every KSP worker image has them).
 * Idempotent: skips when the first demo video already exists (unless --force). No dependencies (Node 20+ fetch).
 * Uses only the seeded demo accounts io.meera / io.arjun / io.mysuru / fo.ravi / op.cubbon (no MFA required).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const API = (opt('api', process.env.KSP_API) ?? '').replace(/\/+$/, '');
const PASSWORD = opt('password', process.env.DEMO_PASSWORD ?? 'Ksp@Dev-Passw0rd!');
const FORCE = args.includes('--force');
const HERE = dirname(fileURLToPath(import.meta.url));
const IMAGES = process.env.IMAGES_DIR ?? resolve(HERE, '../../apps/ai-worker/test/fixtures/images');
const WORK = process.env.WORK ?? join(tmpdir(), 'ksp-demo-content');
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
if (!API) { console.error('usage: load-demo-content.mjs --api <https://host> [--password …] [--force]'); process.exit(2); }
mkdirSync(WORK, { recursive: true });

// ---------------------------------------------------------------------------------------------------- API client
class Api {
  constructor(user) { this.user = user; this.token = null; }
  async login() {
    const r = await this.raw('POST', '/auth/login', { username: this.user, password: PASSWORD, tokenMode: 'bearer' }, false);
    if (r.mfaRequired) throw new Error(`${this.user}: account requires MFA — the loader only uses accounts without MFA`);
    this.token = r.accessToken;
    this.home = r.me?.user?.homeOrgUnit?.id ?? (await this.raw('GET', '/auth/me')).user.homeOrgUnit.id;
    if (r.me?.user?.mustChangePassword) throw new Error(`${this.user}: must change password first`);
    return this;
  }
  async raw(method, path, json, auth = true, body, headers = {}) {
    const h = { accept: 'application/json', 'user-agent': 'ksp-demo-loader/1.0', ...headers };
    if (auth && this.token) h.authorization = `Bearer ${this.token}`;
    let payload;
    if (body) { h['content-type'] = 'application/octet-stream'; payload = body; } else if (json !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(json); }
    // Retry dropped connections: a keep-alive socket idle longer than the API's keep-alive timeout (72 s — e.g. while
    // clips are being generated on a slow host) is closed by the server and fails on reuse ("other side closed").
    let res;
    for (let attempt = 1; ; attempt++) {
      try { res = await fetch(`${API}/api/v1${path}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(300_000) }); break; }
      catch (e) {
        const code = e?.cause?.code ?? e?.code;
        if (attempt >= 4 || !['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_CLOSED'].includes(code)) throw e;
        await sleep(1000 * attempt);
      }
    }
    // access tokens live 15 min; long runs simply sign in again
    if (res.status === 401 && auth && this.token && !headers['x-retried']) { await this.login(); return this.raw(method, path, json, auth, body, { ...headers, 'x-retried': '1' }); }
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    if (!res.ok) { const e = data?.error; const err = new Error(`${method} ${path} → ${res.status} ${e?.code ?? ''} ${e?.message ?? text.slice(0, 200)}${e?.details ? ` ${JSON.stringify(e.details).slice(0, 400)}` : ''}`); err.status = res.status; err.code = e?.code; throw err; }
    return data;
  }
  get(p) { return this.raw('GET', p); }
  post(p, j = {}) { return this.raw('POST', p, j); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ------------------------------------------------------------------------------------------------- demo scenarios
// recorded times are IST wall-clock written as UTC offsets (+05:30)
const V = [
  { user: 'io.meera', officer: 'KSP-FO-1001', device: 'BWC-KA-1001', img: 'plate_uk.jpg', move: 'in', secs: 14, tag: true,
    title: 'Traffic violation stop — MG Road junction', category: 'TRAFFIC', at: '2026-09-28T18:42:10+05:30', lat: 12.9756, lon: 77.6068, place: 'MG Road / Brigade Road junction, Bengaluru',
    description: 'Vehicle stopped for signal jump; driver documents checked on camera. Number plate visible from 00:04.', tags: ['traffic', 'signal jump', 'number plate'] },
  { user: 'io.meera', officer: 'KSP-FO-1001', device: 'BWC-KA-1001', img: 'street_porlamar.jpg', move: 'pan-right', secs: 18, tag: true,
    title: 'Chain-snatching complaint — Kasturba Road', category: 'ROBBERY', at: '2026-09-29T10:15:00+05:30', lat: 12.9720, lon: 77.5960, place: 'Kasturba Road, near Cubbon Park metro, Bengaluru',
    description: 'First responder footage at the scene: complainant pointing in the direction of the escaping two-wheeler; bystanders identified.', tags: ['chain snatching', 'scene', 'witness'] },
  { user: 'io.meera', officer: 'KSP-IO-3001', device: 'BWC-KA-1007', img: 'portrait_obama.jpg', move: 'out', secs: 12, tag: false,
    title: 'Witness statement — Kasturba Road chain snatching', category: 'INVESTIGATION', at: '2026-09-29T13:05:00+05:30', lat: 12.9763, lon: 77.5929, place: 'Cubbon Park Police Station',
    description: 'Recorded statement of the eyewitness (shop owner) describing the suspect and the vehicle.', tags: ['statement', 'witness'] },
  { user: 'io.meera', officer: 'KSP-FO-1001', device: 'BWC-KA-1001', img: 'street_dhaka.jpg', move: 'pan-left', secs: 16, tag: true,
    title: 'Crowd management — Cubbon Park weekend', category: 'PUBLIC_ORDER', at: '2026-10-04T08:20:00+05:30', lat: 12.9763, lon: 77.5929, place: 'Cubbon Park, Bengaluru',
    description: 'Weekend crowd regulation near the Queens Road gate; lost-child announcement at 00:09.', tags: ['crowd', 'bandobast'] },
  { user: 'fo.ravi', officer: 'KSP-FO-1001', device: 'BWC-KA-1001', img: 'street_porlamar.jpg', move: 'in', secs: 15, tag: false, night: true,
    title: 'Night patrol — Queens Road', category: 'PATROL', at: '2026-10-05T23:40:00+05:30', place: 'Queens Road, Bengaluru',
    description: 'Routine night patrol, beat 4. No incident.', tags: ['patrol', 'night'] },
  { user: 'io.arjun', officer: 'KSP-IO-3002', device: 'BWC-KA-2203', img: 'street_dhaka.jpg', move: 'in', secs: 17, tag: true,
    title: 'Brawl outside pub — 100 Feet Road', category: 'ASSAULT', at: '2026-10-03T00:35:00+05:30', lat: 12.9719, lon: 77.6412, place: '100 Feet Road, Indiranagar, Bengaluru',
    description: 'Altercation between two groups; injured person shifted to hospital; three persons detained.', tags: ['assault', 'detention'] },
  { user: 'io.arjun', officer: 'KSP-IO-3002', device: 'BWC-KA-2203', img: 'plate_uk.jpg', move: 'pan-left', secs: 13, tag: true,
    title: 'Hit-and-run vehicle traced — CMH Road', category: 'TRAFFIC', at: '2026-10-06T16:10:00+05:30', lat: 12.9784, lon: 77.6408, place: 'CMH Road, Indiranagar, Bengaluru',
    description: 'Suspected vehicle from the 05-Oct hit-and-run located in a parking lot; registration plate captured.', tags: ['hit and run', 'number plate'] },
  { user: 'io.mysuru', officer: 'KSP-IO-3101', device: 'BWC-KA-5102', img: 'street_dhaka.jpg', move: 'pan-right', secs: 18, tag: true,
    title: 'Dasara procession bandobast — Sayyaji Rao Road', category: 'PUBLIC_ORDER', at: '2026-10-02T17:30:00+05:30', lat: 12.3052, lon: 76.6552, place: 'Sayyaji Rao Road, Mysuru',
    description: 'Crowd regulation along the Jamboo Savari route; barricade sector 3.', tags: ['dasara', 'crowd', 'bandobast'] },
  { user: 'io.mysuru', officer: 'KSP-IO-3101', device: 'BWC-KA-5102', img: 'plate_uk.jpg', move: 'out', secs: 12, tag: false,
    title: 'Vehicle check — Nazarbad Main Road', category: 'TRAFFIC', at: '2026-10-07T11:00:00+05:30', place: 'Nazarbad Main Road, Mysuru',
    description: 'Random vehicle check; documents verified.', tags: ['vehicle check'] },
  { user: 'op.cubbon', officer: 'KSP-FO-1001', device: 'BWC-KA-1003', img: 'street_porlamar.jpg', move: 'pan-left', secs: 14, tag: true,
    title: 'Station bulk upload — beat 2 morning patrol', category: 'PATROL', at: '2026-10-08T07:30:00+05:30', lat: 12.9698, lon: 77.5986, place: 'Richmond Road, Bengaluru',
    description: 'Docked camera BWC-KA-1003, uploaded by the station operator.', tags: ['patrol'] },
];

// ------------------------------------------------------------------------------------------- video generation
function iso6709(lat, lon) { const f = (v, w) => (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(4).padStart(w, '0'); return `${f(lat, 7)}${f(lon, 8)}/`; }
function makeVideo(v, i) {
  const out = join(WORK, `demo-${String(i + 1).padStart(2, '0')}.mp4`);
  if (existsSync(out)) return out;
  const fps = 25, frames = v.secs * fps;
  const z = { in: `min(1+0.0009*on,1.35)`, out: `max(1.35-0.0009*on,1)`, 'pan-right': '1.25', 'pan-left': '1.25' }[v.move];
  const x = { in: 'iw/2-(iw/zoom/2)', out: 'iw/2-(iw/zoom/2)', 'pan-right': `(iw-iw/zoom)*on/${frames}`, 'pan-left': `(iw-iw/zoom)*(1-on/${frames})` }[v.move];
  const epoch = Math.floor(new Date(v.at).getTime() / 1000) + 19800; // overlay shows IST wall clock
  const filters = [
    `scale=2560:-2,zoompan=z='${z}':x='${x}':y='ih/2-(ih/zoom/2)':d=${frames}:s=1280x720:fps=${fps}`,
    v.night ? 'eq=brightness=-0.28:saturation=0.35:gamma=0.9,noise=alls=14:allf=t' : 'eq=saturation=0.9,noise=alls=6:allf=t',
    'format=yuv420p',
  ];
  // Camera overlay as an ASS subtitle track burned in with libass (`ass` filter: present in every KSP worker image,
  // scripts/ops/check-ffmpeg.sh). Running clock = one event per second, IST wall clock of the recording.
  const assFile = `demo-${String(i + 1).padStart(2, '0')}.ass`;
  const ts = (sec) => `0:${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}.00`;
  const ist = (sec) => new Date((epoch + sec) * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const ev = [
    `Dialogue: 0,${ts(0)},${ts(v.secs)},Bar,,0,0,0,,{\\an7}KSP  ${v.device}   ${v.officer}`,
    `Dialogue: 0,${ts(0)},${ts(v.secs)},Bar,,0,0,0,,{\\an1}${v.lat !== undefined ? `GPS ${v.lat.toFixed(4)}N  ${v.lon.toFixed(4)}E` : 'GPS --'}`,
    `Dialogue: 0,${ts(0)},${ts(v.secs)},Rec,,0,0,0,,{\\an3}\u25CF REC`,
    ...Array.from({ length: v.secs }, (_, k) => `Dialogue: 0,${ts(k)},${ts(k + 1)},Bar,,0,0,0,,{\\an9}${ist(k)} IST`),
  ];
  writeFileSync(join(WORK, assFile), ['[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1280', 'PlayResY: 720', '',
    '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Bar,DejaVu Sans Mono,24,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,3,4,0,7,18,18,14,1',
    'Style: Rec,DejaVu Sans Mono,24,&H000000FF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,3,4,0,3,18,18,14,1', '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...ev, ''].join('\n'));
  filters.push(`ass=${assFile}`);
  const meta = ['-metadata', `creation_time=${new Date(v.at).toISOString()}`, '-metadata', `comment=KSP body-worn camera ${v.device}`];
  if (v.tag && v.lat !== undefined) meta.push('-metadata', `location=${iso6709(v.lat, v.lon)}`, '-metadata', `location-eng=${iso6709(v.lat, v.lon)}`);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-i', join(IMAGES, v.img),
    '-f', 'lavfi', '-i', 'anoisesrc=color=brown:amplitude=0.03:sample_rate=48000',
    '-filter_complex', `[0:v]${filters.join(',')}[v]`, '-map', '[v]', '-map', '1:a', '-t', String(v.secs),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', ...meta, out], { stdio: 'inherit', cwd: WORK });
  return out;
}

// ------------------------------------------------------------------------------------------------------- upload
async function upload(api, file, v) {
  const buf = readFileSync(file);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const metadata = { title: v.title, description: v.description, category: v.category, officerBadge: v.officer, deviceSerial: v.device, recordedAt: new Date(v.at).toISOString(), incidentAt: new Date(v.at).toISOString(), locationText: v.place };
  if (!v.tag && v.lat !== undefined) Object.assign(metadata, { latitude: v.lat, longitude: v.lon }); // external source when the file has no GPS tag
  const init = await api.post('/uploads', { orgUnitId: api.home, filename: file.split('/').pop(), size: buf.length, sha256, metadata });
  for (let n = 1; n <= init.totalChunks; n++) {
    const part = buf.subarray((n - 1) * init.chunkSize, Math.min(n * init.chunkSize, buf.length));
    await api.raw('PUT', `/uploads/${init.id}/parts/${n}`, undefined, true, part, { 'x-chunk-sha256': createHash('sha256').update(part).digest('hex') });
  }
  await api.post(`/uploads/${init.id}/complete`);
  for (let i = 0; i < 180; i++) { // registration (hash + immutable copy)
    const s = await api.get(`/uploads/${init.id}`);
    if (s.evidence?.status === 'REGISTERED') return s.evidence;
    if (['FAILED', 'QUARANTINED'].includes(s.status) || s.evidence?.status === 'QUARANTINED') throw new Error(`${v.title}: ${s.status} ${s.evidence?.statusReason ?? s.error ?? ''}`);
    await sleep(2000);
  }
  throw new Error(`${v.title}: not registered after 6 minutes`);
}
async function waitMedia(api, id) {
  for (let i = 0; i < 300; i++) { const e = await api.get(`/evidence/${id}`); if (e.mediaStatus === 'READY') return true; if (e.mediaStatus === 'FAILED') return false; await sleep(3000); }
  return false;
}

// --------------------------------------------------------------------------------------------------------- main
const sessions = {};
const as = async (u) => (sessions[u] ??= await new Api(u).login());

const meera = await as('io.meera');
const exists = await meera.post('/search/evidence', { text: V[0].title, pageSize: 1 }).catch(() => ({ items: [] }));
if (!FORCE && exists.items?.some((x) => x.title === V[0].title)) { log('demo content already present (use --force to load another copy)'); process.exit(0); }

log(`generating ${V.length} body-worn-camera clips …`);
const files = V.map(makeVideo);
const ev = [];
for (const [i, v] of V.entries()) {
  const api = await as(v.user);
  const e = await upload(api, files[i], v);
  ev.push({ ...v, id: e.id, number: e.evidenceNumber });
  log(`registered ${e.evidenceNumber}  ${v.title}  (${v.user}${v.tag ? ', GPS in file' : v.lat !== undefined ? ', GPS declared' : ''})`);
  for (const t of v.tags ?? []) await api.post(`/evidence/${e.id}/tags`, { tag: t }).catch(() => undefined);
}
log('waiting for playback renditions (proxy, HLS, thumbnails) …');
for (const e of ev) { const ok = await waitMedia(await as(e.user), e.id); if (!ok) log(`  media not ready for ${e.number} (continues in the background)`); }

const byTitle = (s) => ev.find((e) => e.title.startsWith(s));
const me = await meera.get('/auth/me');
const cubbon = me.user.homeOrgUnit.id;
const arjun = await as('io.arjun');
const indiranagar = (await arjun.get('/auth/me')).user.homeOrgUnit.id;

// FIRs + cases (re-runs with --force reuse an existing FIR number)
async function firOf(api, body) {
  try { return await api.post('/firs', body); }
  catch (e) {
    if (e.status !== 409) throw e;
    const r = await api.get(`/firs?q=${encodeURIComponent(body.firNumber)}&pageSize=20`);
    const f = r.items.find((x) => x.firNumber === body.firNumber && x.firYear === body.firYear);
    if (!f) throw e;
    return f;
  }
}
const fir1 = await firOf(meera, { firNumber: '0412/2026', firYear: 2026, orgUnitId: cubbon, registeredAt: '2026-09-29T12:00:00+05:30', actsSections: ['BNS 304(1)'], complainant: 'Smt. Lakshmi R.', briefFacts: 'Gold chain (approx. 25 g) snatched by two persons on a black two-wheeler near Kasturba Road at about 10:05 hrs; complainant pushed to the ground.', placeOfOccurrence: 'Kasturba Road, near Cubbon Park metro', occurredFrom: '2026-09-29T10:05:00+05:30' });
const case1 = await meera.post('/cases', { title: 'Chain snatching — Kasturba Road (FIR 0412/2026)', firId: fir1.id });
await meera.post(`/cases/${case1.id}/evidence`, { evidenceIds: [byTitle('Chain-snatching').id, byTitle('Witness statement').id] });
for (const body of ['Scene visited at 10:25 hrs; first-responder body-cam footage collected (KSP-FO-1001).', 'Eyewitness statement recorded on BWC-KA-1007; suspect description: two males, black Pulsar, partial plate KA-01.', 'CCTV request sent to Kasturba Road traders association; AI person/vehicle detection requested on scene footage.'])
  await meera.post(`/cases/${case1.id}/notes`, { body });
const fir2 = await firOf(arjun, { firNumber: '0377/2026', firYear: 2026, orgUnitId: indiranagar, registeredAt: '2026-10-03T02:10:00+05:30', actsSections: ['BNS 115(2)', 'BNS 352'], complainant: 'Sri. Rahul M.', briefFacts: 'Assault outside a pub on 100 Feet Road at about 00:30 hrs; complainant injured; three persons detained at the spot.', placeOfOccurrence: '100 Feet Road, Indiranagar', occurredFrom: '2026-10-03T00:30:00+05:30' });
const case2 = await arjun.post('/cases', { title: 'Assault — 100 Feet Road (FIR 0377/2026)', firId: fir2.id });
await arjun.post(`/cases/${case2.id}/evidence`, { evidenceIds: [byTitle('Brawl outside pub').id] });
await arjun.post(`/cases/${case2.id}/notes`, { body: 'Injured shifted to Bowring hospital; wound certificate awaited. Body-cam footage of the detention linked.' });
log(`FIRs 0412/2026 (Cubbon Park) and 0377/2026 (Indiranagar) with cases, linked evidence and case diary`);

// AI analyses (results stay advisory until reviewed in the AI review queue)
for (const [title, user, tasks] of [['Traffic violation stop', 'io.meera', ['ANPR', 'OBJECT_DETECTION']], ['Chain-snatching complaint', 'io.meera', ['PERSON_DETECTION', 'FACE_DETECTION', 'OBJECT_DETECTION']], ['Witness statement', 'io.meera', ['FACE_DETECTION']], ['Brawl outside pub', 'io.arjun', ['PERSON_DETECTION', 'FACE_DETECTION']], ['Hit-and-run vehicle', 'io.arjun', ['ANPR']]]) {
  try { await (await as(user)).post(`/ai/evidence/${byTitle(title).id}/jobs`, { tasks, sampleFps: 1 }); log(`AI analysis queued: ${title} (${tasks.join(', ')})`); }
  catch (e) { log(`AI analysis not queued for ${title}: ${e.message}`); }
}

// investigation workspace with bookmarks, and a court export waiting for the supervisor
const ws = await meera.post('/workspaces', { title: 'Kasturba Road chain snatching — reconstruction', caseId: case1.id });
await meera.post(`/workspaces/${ws.id}/items`, { evidenceIds: [byTitle('Chain-snatching').id, byTitle('Witness statement').id, byTitle('Traffic violation stop').id] });
await meera.post('/workspaces/bookmarks', { evidenceId: byTitle('Chain-snatching').id, workspaceId: ws.id, timeMs: 6000, label: 'Complainant points towards escape route' });
await meera.post('/workspaces/bookmarks', { evidenceId: byTitle('Witness statement').id, workspaceId: ws.id, timeMs: 4000, label: 'Suspect description' });
try {
  const ex = await meera.post('/exports', { evidenceIds: [byTitle('Chain-snatching').id, byTitle('Witness statement').id], purpose: 'Production before the court — FIR 0412/2026', courtName: 'Addl. Chief Metropolitan Magistrate, Bengaluru', options: { includeOriginal: false, includeWatermarked: true } });
  log(`court export requested (${ex.exportNumber ?? ex.id}) — waiting for supervisor approval (sign in as sup.kavya)`);
} catch (e) { log(`export not requested: ${e.message}`); }

log(`done: ${ev.length} evidence items, 2 FIRs, 2 cases, 1 workspace, AI analyses queued`);
