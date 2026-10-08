/**
 * Minimal PDF layout helpers over pdfkit (A4). Text is drawn with the bundled Unicode fonts (Noto Sans + Noto Sans
 * Kannada, HarfBuzz-shaped — see pdf-text.ts); identifiers/hashes in `mono` use Courier. `compress: false` keeps
 * content and attachments byte-searchable, which lets the signed JSON payload attached to reports be extracted and
 * verified with plain tools.
 */
import PDFDocument from 'pdfkit';
import { cleanText, drawText, loadPdfFonts, measureText, type DrawOptions } from './pdf-text.js';

export type Doc = InstanceType<typeof PDFDocument>;

/** "Karnataka State Police" in Kannada (document headers). */
export const KSP_KN = 'ಕರ್ನಾಟಕ ರಾಜ್ಯ ಪೊಲೀಸ್';
export { drawText, measureText, loadPdfFonts } from './pdf-text.js';

/** Normalise a value for the PDF (NFC, no control characters). Characters no bundled font covers print as '?'. */
export function pdfText(v: unknown): string {
  return cleanText(v);
}

export interface DocOptions {
  title: string;
  subject?: string;
  author?: string;
  createdAt?: Date;
  layout?: 'portrait' | 'landscape';
  margins?: { top: number; bottom: number; left: number; right: number };
  /** Default false (content streams stay byte-searchable). */
  compress?: boolean;
}

/** A4 pdfkit document with the bundled Unicode fonts loaded (draw text with drawText/para/keyValues/table). */
export async function createDoc(info: DocOptions): Promise<Doc> {
  await loadPdfFonts();
  return new PDFDocument({
    size: 'A4',
    layout: info.layout ?? 'portrait',
    margins: info.margins ?? { top: 50, bottom: 50, left: 45, right: 45 },
    compress: info.compress ?? false,
    bufferPages: true,
    info: {
      Title: info.title,
      Subject: info.subject ?? info.title,
      Author: info.author ?? 'KSP Video Evidence Management System',
      Creator: 'KSP VMS',
      ...(info.createdAt ? { CreationDate: info.createdAt, ModDate: info.createdAt } : {}),
    },
  });
}

/**
 * Close the document: footer + page numbers on every page, and optional STAMPS (e.g. "NON-EVIDENTIARY – TEST KEY",
 * "TEMPLATE – PENDING LEGAL APPROVAL") printed in red in the top margin of every page.
 */
export function finish(doc: Doc, footer: string, stamps: readonly string[] = []): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      drawText(doc, `${footer}  |  Page ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - 32, { size: 7, color: '#555555', width: contentWidth(doc), align: 'center', maxHeight: 9 });
      if (stamps.length) {
        const text = stamps.join('   |   ');
        const y = 16;
        doc.save();
        doc.rect(doc.page.margins.left, y - 3, contentWidth(doc), 16).lineWidth(1).strokeColor('#b00020').stroke();
        doc.restore();
        drawText(doc, text, doc.page.margins.left, y, { size: 9, bold: true, color: '#b00020', width: contentWidth(doc), align: 'center', maxHeight: 12 });
      }
    }
    doc.end();
  });
}

export const contentWidth = (doc: Doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;

export function ensureSpace(doc: Doc, h: number): void {
  if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

export function heading(doc: Doc, text: string, size = 12): void {
  ensureSpace(doc, size * 3);
  doc.y += size * 0.8;
  drawText(doc, text, doc.page.margins.left, doc.y, { size, bold: true, color: '#0b2a4a', width: contentWidth(doc) });
  const y = doc.y + 2;
  doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).lineWidth(0.5).strokeColor('#8899aa').stroke();
  doc.y += size * 0.5;
  doc.fillColor('#000000');
}

/** A flowing paragraph at the left margin (paginates). */
export function para(doc: Doc, text: string, opts: { size?: number; bold?: boolean; mono?: boolean; color?: string; align?: DrawOptions['align'] } = {}): void {
  const o: DrawOptions = { size: opts.size ?? 9, bold: opts.bold, mono: opts.mono, color: opts.color ?? '#000000', align: opts.align, width: contentWidth(doc), paginate: true };
  ensureSpace(doc, o.size * 1.4);
  drawText(doc, text, doc.page.margins.left, doc.y, o);
}

/** Vertical gap in multiples of a 9 pt line. */
export function gap(doc: Doc, lines = 1): void {
  doc.y += lines * 12;
}

/** Two-column label/value rows. Values in `mono` render in Courier (hashes, identifiers). */
export function keyValues(doc: Doc, rows: Array<[string, unknown, boolean?]>, labelWidth = 140): void {
  const left = doc.page.margins.left;
  const w = contentWidth(doc) - labelWidth;
  for (const [label, value, mono] of rows) {
    const v = pdfText(value === null || value === undefined || value === '' ? '-' : value);
    const vo: DrawOptions = { size: mono ? 8 : 9, mono, width: w };
    const lo: DrawOptions = { size: 9, bold: true, color: '#333333', width: labelWidth - 6 };
    const h = Math.max(measureText(doc, v, vo), measureText(doc, label, lo), 11);
    ensureSpace(doc, h + 2);
    const y = doc.y;
    drawText(doc, label, left, y, lo);
    drawText(doc, v, left + labelWidth, y, vo);
    doc.y = y + h + 2;
  }
}

export interface TableCol {
  header: string;
  width: number; // fraction of content width
  mono?: boolean;
}

export function table(doc: Doc, cols: TableCol[], rows: string[][], fontSize = 7.5): void {
  const left = doc.page.margins.left;
  const total = contentWidth(doc);
  const widths = cols.map((c) => c.width * total);
  const drawHeader = () => {
    ensureSpace(doc, 20);
    const y = doc.y;
    const h = Math.max(...cols.map((c, i) => measureText(doc, c.header, { size: fontSize, bold: true, width: widths[i]! - 4 })), 11) + 2;
    doc.rect(left, y - 2, total, h).fill('#e8edf3');
    let x = left;
    cols.forEach((c, i) => {
      drawText(doc, c.header, x + 2, y, { size: fontSize, bold: true, color: '#0b2a4a', width: widths[i]! - 4 });
      x += widths[i]!;
    });
    doc.y = y + h;
    doc.fillColor('#000000');
  };
  drawHeader();
  for (const r of rows) {
    const heights = r.map((cell, i) => measureText(doc, cell, { size: fontSize, mono: cols[i]!.mono, width: widths[i]! - 4 }));
    const h = Math.max(...heights, 9) + 3;
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    let x = left;
    r.forEach((cell, i) => {
      drawText(doc, cell, x + 2, y + 1, { size: fontSize, mono: cols[i]!.mono, width: widths[i]! - 4 });
      x += widths[i]!;
    });
    doc.moveTo(left, y + h).lineTo(left + total, y + h).lineWidth(0.3).strokeColor('#cccccc').stroke();
    doc.y = y + h + 1;
  }
  doc.x = left;
}

export function fmtTime(v: Date | string | null | undefined): string {
  if (!v) return '-';
  const d = typeof v === 'string' ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '-';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')} (${ms} ms)`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i ? v.toFixed(2) : v} ${u[i]} (${n} bytes)`;
}

/** Wrap long tokens (base64 signatures, hashes) at a fixed width for printing. */
export function wrapToken(s: string, width = 88): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += width) out.push(s.slice(i, i + width));
  return out.join('\n');
}
