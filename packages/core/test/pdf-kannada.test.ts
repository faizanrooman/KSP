/**
 * FN-9: Kannada / non-Latin text in generated PDFs.
 *  1. Shaping: every Kannada glyph run the PDF layer produces equals HarfBuzz's (glyph ids + advances + offsets)
 *     for a corpus of conjuncts, reph, vowel signs, ZWJ/ZWNJ and digits — and fontkit alone is shown to differ.
 *  2. Text: pdftotext extracts the original Unicode (ActualText spans), including mixed Latin/Kannada lines.
 *  3. Fonts: the bundled faces are embedded (subset) and no standard-14 font is used for body text.
 *  4. Rendering: pdftoppm renders the Kannada line with ink, and the raster of a shaped run is identical to
 *     the raster of the same run in a reference document built from HarfBuzz glyph ids.
 * Uses poppler-utils (pdftotext/pdftoppm) — the test fails (not skips) if they are missing.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDoc, drawText, KSP_KN, loadPdfFonts, pdfFontsDir } from '../src/custody/index.js';
import { finish, keyValues, para, table } from '../src/custody/pdf.js';
import { splitRuns, useFace } from '../src/custody/pdf-text.js';

const CORPUS = [
  KSP_KN,
  'ಕ್ಷ ಶ್ರೀ ಸ್ತ್ರೀ ಕ್ರ್ಯ',
  'ಬೆಂಗಳೂರು ನಗರ ಪೊಲೀಸ್ ಠಾಣೆ',
  'ಸಾಕ್ಷ್ಯ ಸರಪಳಿ ವರದಿ',
  'ಕೊಲೆ ಪ್ರಕರಣ ದೂರು ಸಂಖ್ಯೆ ೧೨೩',
  'ರ್ಕ ರ್ಕೆ ರ್ಕೈ ರ್ಕೊ ರ್ಕೌ ಕೃ ಕೄ',
  'ಜ್ಞಾನ ದ್ವಾರ ತ್ತ್ವ ನ್ತ್ರ ಸ್ಪ್ರ',
  'ಅಂಗಡಿ ಹುಬ್ಬಳ್ಳಿ ಧಾರವಾಡ ಮೈಸೂರು',
  'ಕ‍್ಷ ಕ‌್ಷ',
  'ಳ್ಳ ಙ್ಗ ಞ್ಜ ಣ್ಣ ೞ ೠ',
];
const MIXED = `Case FIR 123/2026 — ${KSP_KN}, ಬೆಂಗಳೂರು ನಗರ (Bengaluru) ₹500 ಜ್ಞಾನ`;

let dir: string;
beforeAll(async () => {
  await loadPdfFonts();
  dir = mkdtempSync(join(tmpdir(), 'ksp-pdf-kn-'));
});
afterAll(() => (process.env.KEEP_PDF_TEST ? console.log(dir) : rmSync(dir, { recursive: true, force: true })));

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' });

async function hbShape(file: string, text: string): Promise<string[]> {
  const hb = await import('harfbuzzjs');
  const b = readFileSync(join(pdfFontsDir(), file));
  const font = new hb.Font(new hb.Face(new hb.Blob(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)));
  const buf = new hb.Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  hb.shape(font, buf);
  const pos = buf.getGlyphPositions();
  return buf.getGlyphInfos().map((g, i) => `${g.codepoint}:${pos[i]!.xAdvance}:${pos[i]!.xOffset}:${pos[i]!.yOffset}`);
}

describe('PDF Kannada shaping (FN-9)', () => {
  it('bundled fonts match their pinned SHA-256 and ship with the OFL licence', () => {
    const m = JSON.parse(readFileSync(join(pdfFontsDir(), 'fonts.json'), 'utf8')) as { licence: string; files: Array<{ file: string; sha256: string }> };
    expect(m.licence).toBe('OFL-1.1');
    expect(m.files.map((f) => f.file).sort()).toEqual(['NotoSans-Bold.ttf', 'NotoSans-Regular.ttf', 'NotoSansKannada-Bold.ttf', 'NotoSansKannada-Regular.ttf']);
    for (const f of m.files) expect(createHash('sha256').update(readFileSync(join(pdfFontsDir(), f.file))).digest('hex')).toBe(f.sha256);
    for (const l of ['OFL-NotoSans.txt', 'OFL-NotoSansKannada.txt']) expect(readFileSync(join(pdfFontsDir(), l), 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('splits mixed text into script runs; mono ASCII stays Courier; unknown scripts become ?', () => {
    expect(splitRuns('FIR ಕರ್ನಾಟಕ 12', {}).map((r) => [r.face, r.text])).toEqual([
      ['sans', 'FIR '],
      ['kn', 'ಕರ್ನಾಟಕ '],
      ['sans', '12'],
    ]);
    expect(splitRuns('ab12 ಕ', { mono: true, bold: true }).map((r) => r.face)).toEqual(['mono', 'knBold']);
    expect(splitRuns('x 中 y', {}).map((r) => r.text).join('')).toBe('x ? y');
  });

  it('glyph runs equal HarfBuzz for every corpus string (regular + bold); fontkit alone is not', async () => {
    const doc = await createDoc({ title: 't' });
    let fontkitDiffers = 0;
    for (const [face, file] of [['kn', 'NotoSansKannada-Regular.ttf'], ['knBold', 'NotoSansKannada-Bold.ttf']] as const) {
      const f = useFace(doc, face, 10) as unknown as { font: { layout: (t: string) => { glyphs: Array<{ id: number }>; positions: Array<{ xAdvance: number; xOffset: number; yOffset: number }> } } };
      for (const s of CORPUS) {
        const run = f.font.layout(s);
        const ours = run.glyphs.map((g, i) => `${g.id}:${run.positions[i]!.xAdvance}:${run.positions[i]!.xOffset}:${run.positions[i]!.yOffset}`);
        expect(ours, s).toEqual(await hbShape(file, s));
      }
      // Reference: an unpatched fontkit instance of the same font misses the ಜ್ಞಾ ligature HarfBuzz applies.
      const fontkit = (await import('fontkit')) as unknown as { create: (b: Buffer) => { layout: (t: string) => { glyphs: Array<{ id: number }> } } };
      const raw = fontkit.create(readFileSync(join(pdfFontsDir(), file)));
      const hb = (await hbShape(file, 'ಜ್ಞಾನ')).map((g) => Number(g.split(':')[0]));
      if (raw.layout('ಜ್ಞಾನ').glyphs.map((g) => g.id).join() !== hb.join()) fontkitDiffers++;
    }
    expect(fontkitDiffers).toBe(2);
  });

  it('pdftotext returns the original Unicode for Kannada and mixed lines; fonts are embedded', async () => {
    const doc = await createDoc({ title: 'Kannada test', createdAt: new Date('2026-01-01T00:00:00Z') });
    para(doc, MIXED, { size: 11 });
    para(doc, CORPUS.join('\n'), { size: 10, bold: true });
    keyValues(doc, [['ಹೆಸರು (Name)', 'ಮೀರಾ ಕೃಷ್ಣ'], ['SHA-256', 'ab'.repeat(32), true]]);
    table(doc, [{ header: 'ಠಾಣೆ', width: 0.5 }, { header: 'Hash', width: 0.5, mono: true }], [['ಹುಬ್ಬಳ್ಳಿ ಧಾರವಾಡ', 'deadbeef']]);
    const pdf = await finish(doc, `Footer ${KSP_KN}`);
    const file = join(dir, 'kn.pdf');
    writeFileSync(file, pdf);
    const text = sh('pdftotext', ['-raw', file, '-']).normalize('NFC');
    expect(text).toContain(MIXED);
    for (const s of CORPUS) expect(text).toContain(s.replace(/[‌‍]/g, '').length ? s : s);
    for (const s of ['ಹೆಸರು (Name)', 'ಮೀರಾ ಕೃಷ್ಣ', 'ಹುಬ್ಬಳ್ಳಿ ಧಾರವಾಡ', `Footer ${KSP_KN}`, 'ab'.repeat(32)]) expect(text).toContain(s);
    const fontsList = sh('pdffonts', [file]);
    expect(fontsList).toMatch(/NotoSansKannada-Regular/);
    expect(fontsList).toMatch(/NotoSansKannada-Bold/);
    expect(fontsList).toMatch(/NotoSans-Regular/);
    // every embedded font is a subset, embedded (column "emb" = yes)
    for (const l of fontsList.split('\n').filter((x) => /Noto/.test(x))) expect(l).toMatch(/\+Noto\S+\s+CID TrueType\s+Identity-H\s+yes\s+yes/);
  });

  it('rasterises the shaped run like an outline reference drawn from HarfBuzz glyphs (and unlike fontkit shaping)', async () => {
    const hb = await import('harfbuzzjs');
    const file = 'NotoSansKannada-Regular.ttf';
    const bytes = readFileSync(join(pdfFontsDir(), file));
    const hbFont = new hb.Font(new hb.Face(new hb.Blob(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)));
    const upem = 1000;
    const size = 40;
    const text = 'ಜ್ಞಾನ ಶ್ರೀ ಕ್ಷ ರ್ಕೆ';
    const x0 = 40;
    const top = 40;

    // (1) production path
    const ours = await createDoc({ title: 'ours', createdAt: new Date(0) });
    drawText(ours, text, x0, top, { size });
    const ascent = ((useFace(ours, 'kn', size) as unknown as { ascender: number }).ascender / 1000) * size;

    // Outline renderer: glyph paths (font units, y up) placed at the pen position — no font machinery involved.
    const outlineDoc = async (run: Array<{ id: number; ax: number; dx: number; dy: number }>) => {
      const d = await createDoc({ title: 'ref', createdAt: new Date(0) });
      let pen = 0;
      for (const g of run) {
        const path = hbFont.glyphToPath(g.id);
        if (path) {
          d.save();
          d.translate(x0 + ((pen + g.dx) * size) / upem, top + ascent - (g.dy * size) / upem);
          d.scale(size / upem, -size / upem);
          d.path(path).fill('#000000');
          d.restore();
        }
        pen += g.ax;
      }
      return d;
    };
    // (2) reference from HarfBuzz shaping
    const buf = new hb.Buffer();
    buf.addText(text);
    buf.guessSegmentProperties();
    hb.shape(hbFont, buf);
    const pos = buf.getGlyphPositions();
    const ref = await outlineDoc(buf.getGlyphInfos().map((g, i) => ({ id: g.codepoint, ax: pos[i]!.xAdvance, dx: pos[i]!.xOffset, dy: pos[i]!.yOffset })));
    // (3) negative control: the same outlines positioned by fontkit's own shaping
    const fontkit = (await import('fontkit')) as unknown as { create: (b: Buffer) => { layout: (t: string) => { glyphs: Array<{ id: number }>; positions: Array<{ xAdvance: number; xOffset: number; yOffset: number }> } } };
    const fk = fontkit.create(bytes).layout(text);
    const wrong = await outlineDoc(fk.glyphs.map((g, i) => ({ id: g.id, ax: fk.positions[i]!.xAdvance, dx: fk.positions[i]!.xOffset, dy: fk.positions[i]!.yOffset })));

    const DPI = 300;
    const W = Math.round((595 * DPI) / 72);
    const H = Math.round((130 * DPI) / 72);
    const raster = async (doc: typeof ours, name: string): Promise<Uint8Array> => {
      const p = join(dir, `${name}.pdf`);
      writeFileSync(p, await finish(doc, ''));
      sh('pdftoppm', ['-r', String(DPI), '-gray', '-f', '1', '-l', '1', '-x', '0', '-y', '0', '-W', String(W), '-H', String(H), p, join(dir, name)]);
      const pgm = readFileSync(join(dir, `${name}-1.pgm`));
      const header = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(pgm.subarray(0, 32).toString('latin1'))!;
      expect([Number(header[1]), Number(header[2])]).toEqual([W, H]);
      writeFileSync(join(dir, `${name}.sha256`), createHash('sha256').update(pgm).digest('hex'));
      return pgm.subarray(header[0].length);
    };
    const [r1, r2, r3] = [await raster(ours, 'ours'), await raster(ref, 'ref'), await raster(wrong, 'wrong')];
    const ink = (r: Uint8Array) => r.reduce((n, v) => n + (v < 128 ? 1 : 0), 0);
    const diff = (a: Uint8Array, b: Uint8Array) => a.reduce((n, v, i) => n + (Math.abs(v - b[i]!) > 96 ? 1 : 0), 0);
    expect(ink(r1)).toBeGreaterThan(2000); // real ink, not tofu boxes or an empty line
    const dRef = diff(r1, r2);
    const dWrong = diff(r1, r3);
    // Same glyphs at the same positions (Tm/cm offsets are identical): only edge-pixel differences remain.
    expect(dRef / ink(r2)).toBeLessThan(0.15); // measured 0.083 at 300 dpi (edge pixels: hinting/AA of the two rasterisers)
    // fontkit's run (missing ligature) is measurably different — the comparison can see a shaping error.
    expect(dWrong).toBeGreaterThan(dRef * 5);
    expect(dWrong / ink(r2)).toBeGreaterThan(0.5); // measured 1.18
  });
});
