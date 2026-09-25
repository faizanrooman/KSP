/**
 * /exports/verify hostile inputs (security round 2): zip-slip entry names, zip bombs (high compression ratio,
 * huge declared totals, many entries), malformed / truncated / corrupted archives, and oversized manifests in
 * JSON mode. Nothing is ever written to disk by the verifier; the concern is resource exhaustion (SEC-14) and
 * error hygiene.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import yazl from 'yazl';
import { closeApp, login, type Agent } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown } from './evidence-setup.js';

let kavya: Agent;

beforeAll(async () => {
  await evidenceTestSetup();
  kavya = await login('sup.kavya');
});
afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

function makeZip(add: (z: yazl.ZipFile) => void): Promise<Buffer> {
  const z = new yazl.ZipFile();
  add(z);
  z.end();
  const chunks: Buffer[] = [];
  return new Promise((res, rej) => {
    z.outputStream.on('data', (c: Buffer) => chunks.push(c)).on('end', () => res(Buffer.concat(chunks))).on('error', rej);
  });
}
const manifestish = (z: yazl.ZipFile) => {
  z.addBuffer(Buffer.from('{"type":"x"}'), 'manifest.json');
  z.addBuffer(Buffer.from('c2ln'), 'manifest.sig');
};
const verify = (buf: Buffer) => kavya.request('POST', '/api/v1/exports/verify', { payload: buf, headers: { 'content-type': 'application/octet-stream' } });

describe('zip-slip entry names', () => {
  for (const name of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', '..\\..\\evil.txt', 'originals/../../../x']) {
    it(`refuses ${JSON.stringify(name)}`, async () => {
      // yazl refuses such names, so write a same-length placeholder and patch the raw bytes (local + central headers).
      const placeholder = 'Z'.repeat(name.length);
      const raw = await makeZip((z) => {
        manifestish(z);
        z.addBuffer(Buffer.from('pwn'), placeholder);
      });
      const zip = Buffer.from(raw.toString('latin1').split(placeholder).join(name), 'latin1');
      const r = await verify(zip);
      expect(r.status).toBe(400);
      expect(r.raw).not.toMatch(/node_modules|\.ts:|at /);
    });
  }
});

describe('zip bombs (SEC-14)', () => {
  it('a small archive that inflates to > 256 MiB is refused before it is inflated', async () => {
    const zeros = () => Readable.from((function* () { const c = Buffer.alloc(1024 * 1024); for (let i = 0; i < 300; i++) yield c; })());
    const zip = await makeZip((z) => {
      manifestish(z);
      z.addReadStream(zeros(), 'originals/bomb.bin', { size: 300 * 1024 * 1024 });
    });
    expect(zip.length).toBeLessThan(2 * 1024 * 1024);
    const t0 = Date.now();
    const r = await verify(zip);
    const ms = Date.now() - t0;
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/limit|ratio|too large/i);
    expect(ms).toBeLessThan(1500);
  });

  it('an entry with an extreme compression ratio is refused', async () => {
    const zip = await makeZip((z) => {
      manifestish(z);
      z.addBuffer(Buffer.alloc(40 * 1024 * 1024), 'originals/ratio.bin');
    });
    const r = await verify(zip);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/ratio/i);
  });

  it('too many entries are refused', async () => {
    const zip = await makeZip((z) => {
      manifestish(z);
      for (let i = 0; i < 10_050; i++) z.addBuffer(Buffer.from('x'), `f/${i}.txt`, { compress: false });
    });
    const r = await verify(zip);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/entries/i);
  });

  it('a JSON manifest with an absurd number of items is refused without per-item database lookups', async () => {
    const manifest = JSON.stringify({ type: 'KSP-COURT-EXPORT-MANIFEST', files: [], items: Array.from({ length: 50_000 }, (_, i) => ({ evidenceNumber: `N${i}`, sha256: 'a'.repeat(64) })) });
    const t0 = Date.now();
    const r = await kavya.post('/api/v1/exports/verify', { manifest, signature: Buffer.alloc(64).toString('base64') });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.status).toBeLessThan(500);
    expect(r.body.ok ?? false).toBe(false);
  });
});

describe('malformed archives', () => {
  it('random bytes, truncated, corrupted CRC and empty archives answer 4xx with a clean envelope', async () => {
    const good = await makeZip((z) => {
      manifestish(z);
      z.addBuffer(randomBytes(64 * 1024), 'originals/a.bin', { compress: false });
    });
    const corrupt = Buffer.from(good);
    corrupt[200] = corrupt[200]! ^ 0xff; // inside the stored entry data => CRC mismatch
    const cases: Record<string, Buffer> = {
      random: randomBytes(4096),
      truncated: good.subarray(0, Math.floor(good.length / 2)),
      corruptCrc: corrupt,
      empty: await makeZip(() => undefined),
      zeroBytes: Buffer.alloc(0),
    };
    for (const [name, buf] of Object.entries(cases)) {
      const r = await verify(buf);
      // A flipped data byte keeps the archive readable (ZIP CRCs are not trusted; SHA-256 against the signed manifest is
      // what matters), so that case may be a 200 report — but never ok, never 5xx.
      const acceptable = (r.status >= 400 && r.status < 500) || (name === 'corruptCrc' && r.status === 200 && r.body.ok === false);
      expect({ name, s: acceptable }).toEqual({ name, s: true });
      expect(r.raw).not.toMatch(/node_modules|\.ts:|\n\s+at /);
    }
  });
});
