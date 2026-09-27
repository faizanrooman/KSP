/**
 * Unicode text for pdfkit documents: bundled Noto Sans + Noto Sans Kannada (SIL OFL 1.1, `assets/fonts/`),
 * script-run font selection, HarfBuzz shaping for Kannada, and a small line layouter that measures/wraps text
 * made of several fonts.
 *
 * Why not plain pdfkit: pdfkit shapes with fontkit, which picks ONE script per string (a Latin-first line shapes
 * Kannada with the Latin rules → broken conjuncts) and whose Indic shaper misses ligatures HarfBuzz applies
 * (e.g. ಜ್ಞಾ). So Kannada runs are shaped by HarfBuzz (harfbuzzjs/wasm) and the glyph run is handed to pdfkit by
 * replacing that face's `layout()`; everything else keeps fontkit. Every Kannada run is wrapped in a marked-content
 * span with /ActualText so text extraction (copy/paste, pdftotext, search) returns the original Unicode even where
 * glyphs are ligated or reordered.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type PDFDocument from 'pdfkit';

type Doc = InstanceType<typeof PDFDocument>;
type Hb = typeof import('harfbuzzjs');

export type Face = 'sans' | 'sansBold' | 'kn' | 'knBold' | 'mono';
const FILES = { sans: 'NotoSans-Regular.ttf', sansBold: 'NotoSans-Bold.ttf', kn: 'NotoSansKannada-Regular.ttf', knBold: 'NotoSansKannada-Bold.ttf' } as const;
type FileFace = keyof typeof FILES;
const FAMILY: Record<Face, string> = { sans: 'KspNotoSans', sansBold: 'KspNotoSans-Bold', kn: 'KspNotoSansKannada', knBold: 'KspNotoSansKannada-Bold', mono: 'Courier' };

interface Loaded {
  hb: Hb;
  buf: Record<FileFace, Buffer>;
  hbFont: Record<'kn' | 'knBold', InstanceType<Hb['Font']>>;
  cover: Record<FileFace, Set<number>>;
}

/** Directory of the bundled fonts: `PDF_FONTS_DIR` or `packages/core/assets/fonts` (same from src/ and dist/). */
export function pdfFontsDir(): string {
  return process.env.PDF_FONTS_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts');
}

let loaded: Loaded | null = null;
let loading: Promise<Loaded> | null = null;

/** Load + SHA-256-verify the fonts (pins in assets/fonts/fonts.json) and initialise HarfBuzz. Idempotent. */
export function loadPdfFonts(): Promise<Loaded> {
  loading ??= (async () => {
    const dir = pdfFontsDir();
    const manifest = JSON.parse(readFileSync(join(dir, 'fonts.json'), 'utf8')) as { files: Array<{ file: string; sha256: string }> };
    const buf = {} as Record<FileFace, Buffer>;
    for (const [face, file] of Object.entries(FILES) as Array<[FileFace, string]>) {
      const b = readFileSync(join(dir, file));
      const pin = manifest.files.find((f) => f.file === file)?.sha256;
      const got = createHash('sha256').update(b).digest('hex');
      if (!pin || pin !== got) throw new Error(`PDF font ${file}: SHA-256 ${got} does not match the pinned value in fonts.json`);
      buf[face] = b;
    }
    const hb = (await import('harfbuzzjs')) as Hb;
    const face = (b: Buffer) => new hb.Face(new hb.Blob(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer));
    const faces = Object.fromEntries((Object.keys(FILES) as FileFace[]).map((k) => [k, face(buf[k])])) as Record<FileFace, InstanceType<Hb['Face']>>;
    const cover = Object.fromEntries((Object.keys(FILES) as FileFace[]).map((k) => [k, new Set(faces[k].collectUnicodes())])) as Record<FileFace, Set<number>>;
    loaded = { hb, buf, cover, hbFont: { kn: new hb.Font(faces.kn), knBold: new hb.Font(faces.knBold) } };
    return loaded;
  })();
  loading.catch(() => (loading = null));
  return loading;
}

function fonts(): Loaded {
  if (!loaded) throw new Error('PDF fonts not loaded: await loadPdfFonts() (createDoc does) before drawing text');
  return loaded;
}

// ---------------------------------------------------------------------------------------------- font selection

export interface TextStyle {
  size: number;
  bold?: boolean;
  mono?: boolean;
}

interface Run {
  face: Face;
  text: string;
}

const isKannadaBlock = (cp: number) => (cp >= 0x0c80 && cp <= 0x0cff) || cp === 0x0964 || cp === 0x0965 || (cp >= 0x1cd0 && cp <= 0x1cff);
/** Characters that never start a run of their own: they join the surrounding run (marks, joiners, spaces). */
const isNeutral = (ch: string) => ch === ' ' || ch === '\u00a0' || ch === '\u200c' || ch === '\u200d' || /\p{M}/u.test(ch);

/** Normalise text for the PDF: NFC, tabs → space, other control characters removed. */
export function cleanText(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return s.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff]/g, '');
}

/** Split one line (no \n) into runs of a single font. Characters no bundled font has become '?'. */
export function splitRuns(line: string, style: Omit<TextStyle, 'size'>): Run[] {
  const { cover } = fonts();
  const sans: Face = style.bold ? 'sansBold' : 'sans';
  const kn: Face = style.bold ? 'knBold' : 'kn';
  const runs: Run[] = [];
  let pending = ''; // leading neutral characters before the first run
  for (const ch of line) {
    const cp = ch.codePointAt(0)!;
    let face: Face;
    let out = ch;
    if (isNeutral(ch) && (runs.length || pending)) {
      if (runs.length) runs[runs.length - 1]!.text += ch;
      else pending += ch;
      continue;
    }
    if (style.mono && cp >= 0x20 && cp <= 0x7e) face = 'mono';
    else if (isKannadaBlock(cp) && cover.kn.has(cp)) face = kn;
    else if (cover.sans.has(cp)) face = sans;
    else if (cover.kn.has(cp)) face = kn;
    else {
      face = sans;
      out = '?';
    }
    const last = runs[runs.length - 1];
    if (last && last.face === face) last.text += out;
    else {
      runs.push({ face, text: pending + out });
      pending = '';
    }
  }
  if (pending) runs.push({ face: sans, text: pending });
  return runs;
}

// ---------------------------------------------------------------------------------------------- shaping

interface FontkitGlyph {
  id: number;
  advanceWidth: number;
}
interface FontkitFont {
  getGlyph(id: number, codePoints?: number[]): FontkitGlyph;
  glyphForCodePoint(cp: number): FontkitGlyph;
  layout(text: string, features?: unknown): unknown;
}
interface PdfkitFont {
  font?: FontkitFont;
  ascender: number;
  descender: number;
  __kspShaped?: boolean;
}

/** HarfBuzz glyph run in pdfkit/fontkit GlyphRun shape (positions in font units; advanceWidth is a getter). */
function hbLayout(hbFont: InstanceType<Hb['Font']>, fk: FontkitFont, text: string) {
  const { hb } = fonts();
  const b = new hb.Buffer();
  b.addText(text);
  b.guessSegmentProperties();
  hb.shape(hbFont, b);
  const infos = b.getGlyphInfos();
  const pos = b.getGlyphPositions();
  // Cluster values are UTF-16 offsets into `text`; a cluster spans up to the next larger cluster value.
  const starts = [...new Set(infos.map((g) => g.cluster))].sort((a, z) => a - z);
  const clusterText = (c: number) => text.slice(c, starts[starts.indexOf(c) + 1] ?? text.length);
  const seen = new Set<number>();
  const glyphs = infos.map((g) => {
    const cps = [...clusterText(g.cluster)].map((c) => c.codePointAt(0)!);
    const nominal = cps.find((cp) => fk.glyphForCodePoint(cp).id === g.codepoint);
    const first = !seen.has(g.cluster);
    seen.add(g.cluster);
    return fk.getGlyph(g.codepoint, nominal !== undefined ? [nominal] : first ? cps : []);
  });
  const positions = pos.map((p) => ({ xAdvance: p.xAdvance, yAdvance: p.yAdvance, xOffset: p.xOffset, yOffset: p.yOffset }));
  return {
    glyphs,
    positions,
    get advanceWidth() {
      return positions.reduce((s, p) => s + p.xAdvance, 0);
    },
  };
}

/** Select a face on the document (embedding + patching it on first use). */
export function useFace(doc: Doc, face: Face, size: number): PdfkitFont {
  if (face === 'mono') doc.font('Courier');
  else {
    const registered = (doc as unknown as { _registeredFonts: Record<string, unknown> })._registeredFonts;
    if (!registered[FAMILY[face]]) doc.registerFont(FAMILY[face], fonts().buf[face]);
    doc.font(FAMILY[face]);
  }
  doc.fontSize(size);
  const f = (doc as unknown as { _font: PdfkitFont })._font;
  if ((face === 'kn' || face === 'knBold') && !f.__kspShaped && f.font) {
    const fk = f.font;
    const hbFont = fonts().hbFont[face];
    fk.layout = (text: string) => hbLayout(hbFont, fk, text);
    f.__kspShaped = true;
  }
  return f;
}

// ---------------------------------------------------------------------------------------------- layout

interface Piece extends Run {
  width: number;
}
export interface Line {
  pieces: Piece[];
  width: number;
}

function measure(doc: Doc, run: Run, size: number): number {
  useFace(doc, run.face, size);
  return doc.widthOfString(run.text);
}

/**
 * Line height (pt) and max ascender (pt) for the faces a text uses: uniform lines with a shared baseline. Mixed
 * lines need Latin's ascender (1.069 em) plus Kannada's descender (0.54 em, subscript conjuncts), and Kannada
 * lines get a little extra leading so stacked conjuncts never touch the next line's vowel signs.
 */
function metrics(doc: Doc, faces: Set<Face>, size: number): { lineHeight: number; ascent: number } {
  let lineHeight = 0;
  let ascent = 0;
  let descent = 0;
  let kannada = false;
  for (const face of faces.size ? faces : new Set<Face>(['sans'])) {
    const f = useFace(doc, face, size);
    lineHeight = Math.max(lineHeight, doc.currentLineHeight(true));
    ascent = Math.max(ascent, (f.ascender / 1000) * size);
    descent = Math.max(descent, (-f.descender / 1000) * size);
    kannada ||= face === 'kn' || face === 'knBold';
  }
  return { lineHeight: Math.max(lineHeight, ascent + descent) + (kannada ? 0.12 * size : 0), ascent };
}

/** Greedy word wrap of mixed-font text into lines of at most `width` points (no width: one line per \n). */
export function layoutLines(doc: Doc, text: string, style: TextStyle, width?: number): Line[] {
  const lines: Line[] = [];
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const para of cleanText(text).split('\n')) {
    let cur: Line = { pieces: [], width: 0 };
    let wrapped = false; // cur is a continuation line of this paragraph
    const push = (runs: Run[], w: number) => {
      for (const r of runs) {
        const last = cur.pieces[cur.pieces.length - 1];
        const rw = runs.length === 1 ? w : measure(doc, r, style.size);
        if (last && last.face === r.face) {
          last.text += r.text;
          last.width += rw;
        } else cur.pieces.push({ ...r, width: rw });
      }
      cur.width += w;
    };
    const flush = () => {
      const last = cur.pieces[cur.pieces.length - 1];
      if (last && /\s$/.test(last.text)) {
        const trimmed = last.text.replace(/\s+$/, '');
        const w = trimmed ? measure(doc, { face: last.face, text: trimmed }, style.size) : 0;
        cur.width -= last.width - w;
        last.text = trimmed;
        last.width = w;
      }
      lines.push(cur);
      cur = { pieces: [], width: 0 };
      wrapped = true;
    };
    for (const token of para.split(/(\s+)/).filter(Boolean)) {
      const space = /^\s+$/.test(token);
      const prev = cur.pieces[cur.pieces.length - 1];
      // Spaces take the font of the text before them (a Kannada phrase stays one run and one font).
      const runs = space && prev ? [{ face: prev.face, text: token }] : splitRuns(token, style);
      const w = runs.reduce((s, r) => s + measure(doc, r, style.size), 0);
      if (width === undefined || cur.width + w <= width + 0.01) {
        if (!(space && wrapped && !cur.pieces.length)) push(runs, w);
        continue;
      }
      if (space) {
        flush();
        continue;
      }
      if (cur.pieces.length && w <= width) {
        flush();
        push(runs, w);
        continue;
      }
      // Token longer than a line (hashes, URLs, long compounds): break at grapheme boundaries.
      for (const { segment } of seg.segment(token)) {
        const r = splitRuns(segment, style);
        const gw = r.reduce((s, x) => s + measure(doc, x, style.size), 0);
        if (cur.pieces.length && cur.width + gw > width + 0.01) flush();
        push(r, gw);
      }
    }
    flush();
    wrapped = false;
  }
  return lines;
}

/**
 * Wrap the text object(s) drawn by `draw` in `/Span << /ActualText <UTF-16BE> >> BDC … EMC`, placed INSIDE pdfkit's
 * q…Q around BT/ET: poppler resolves the span's position with the graphics state current at EMC, so an EMC after
 * pdfkit's Q misplaces the text. The value is written as a hex string (no escaping/injection concerns).
 */
function withActualText(doc: Doc, actual: string, draw: () => void): void {
  const d = doc as unknown as { addContent: (data: string) => unknown };
  const orig = d.addContent;
  const hex = 'feff' + Buffer.from(actual, 'utf16le').swap16().toString('hex');
  d.addContent = function (this: unknown, data: string) {
    if (data === 'BT') orig.call(this, `/Span << /ActualText <${hex}> >> BDC`);
    const r = orig.call(this, data);
    if (data === 'ET') orig.call(this, 'EMC');
    return r;
  };
  try {
    draw();
  } finally {
    d.addContent = orig;
  }
}

export interface DrawOptions extends TextStyle {
  width?: number;
  color?: string;
  align?: 'left' | 'center' | 'right';
  /** Clip to this many points of height (whole lines); the last kept line gets an ellipsis if text was cut. */
  maxHeight?: number;
  /** Start a new page when the next line would cross the bottom margin (flowing paragraphs). */
  paginate?: boolean;
}

/** Faces that draw visible glyphs (whitespace-only pieces do not affect line metrics). */
function facesOf(lines: Line[]): Set<Face> {
  return new Set(lines.flatMap((l) => l.pieces.filter((p) => /\S/.test(p.text)).map((p) => p.face)));
}

/** Height (pt) `text` would take when drawn with `opts`. */
export function measureText(doc: Doc, text: string, opts: DrawOptions): number {
  const lines = layoutLines(doc, text, opts, opts.width);
  const { lineHeight } = metrics(doc, facesOf(lines), opts.size);
  const n = opts.maxHeight ? Math.min(lines.length, Math.max(1, Math.floor(opts.maxHeight / lineHeight))) : lines.length;
  return n * lineHeight;
}

/**
 * Draw text at (x, y) — top of the first line — and return its height. Leaves doc.x = x and doc.y below the last
 * line. Without `paginate` callers reserve the space first (measureText).
 */
export function drawText(doc: Doc, text: string, x: number, y: number, opts: DrawOptions): number {
  let lines = layoutLines(doc, text, opts, opts.width);
  const { lineHeight, ascent } = metrics(doc, facesOf(lines), opts.size);
  if (opts.maxHeight) {
    const max = Math.max(1, Math.floor(opts.maxHeight / lineHeight));
    if (lines.length > max) {
      lines = lines.slice(0, max);
      const last = lines[max - 1]!;
      const face: Face = opts.bold ? 'sansBold' : 'sans';
      last.pieces.push({ face, text: '…', width: measure(doc, { face, text: '…' }, opts.size) });
    }
  }
  let top = y;
  lines.forEach((line, i) => {
    if (opts.paginate && i > 0 && top + lineHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      top = doc.page.margins.top;
    }
    const lw = line.pieces.reduce((s, p) => s + p.width, 0);
    let px = x;
    if (opts.width !== undefined && opts.align === 'center') px += Math.max(0, (opts.width - lw) / 2);
    if (opts.width !== undefined && opts.align === 'right') px += Math.max(0, opts.width - lw);
    const baseline = top + ascent;
    for (const p of line.pieces) {
      if (!p.text) continue;
      const f = useFace(doc, p.face, opts.size);
      doc.fillColor(opts.color ?? '#000000');
      const ty = baseline - (f.ascender / 1000) * opts.size;
      if (p.face === 'kn' || p.face === 'knBold') {
        // One /ActualText span per word (spaces stay real space glyphs) so extractors keep word order.
        let wx = px;
        for (const w of p.text.split(/(\s+)/).filter(Boolean)) {
          const ww = doc.widthOfString(w);
          if (/\S/.test(w)) withActualText(doc, w, () => doc.text(w, wx, ty, { lineBreak: false }));
          wx += ww;
        }
      } else doc.text(p.text, px, ty, { lineBreak: false });
      px += p.width;
    }
    top += lineHeight;
  });
  doc.x = x;
  doc.y = top;
  return lines.length * lineHeight;
}
