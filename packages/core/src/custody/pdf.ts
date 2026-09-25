/**
 * Minimal PDF layout helpers over pdfkit (A4, standard Helvetica/Courier fonts — WinAnsi only; characters
 * outside it are transliterated). `compress: false` keeps content and attachments byte-searchable, which lets
 * the signed JSON payload attached to reports be extracted and verified with plain tools.
 */
import PDFDocument from 'pdfkit';

export type Doc = InstanceType<typeof PDFDocument>;

const REPLACE: Record<string, string> = { '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '≠': '!=', '→': '->', '•': '*', ' ': ' ' };

/** Restrict to printable Latin-1 so the standard PDF fonts render every character. */
export function pdfText(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return s.replace(/[^\x20-\x7e\xa0-\xff\n]/g, (c) => REPLACE[c] ?? '?');
}

export function createDoc(info: { title: string; subject?: string; createdAt: Date }): Doc {
  return new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 50, left: 45, right: 45 },
    compress: false,
    bufferPages: true,
    info: { Title: info.title, Subject: info.subject ?? info.title, Author: 'KSP Video Evidence Management System', Creator: 'KSP VMS', CreationDate: info.createdAt, ModDate: info.createdAt },
  });
}

export function finish(doc: Doc, footer: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7).fillColor('#555555')
        .text(pdfText(`${footer}  |  Page ${i + 1} of ${range.count}`), doc.page.margins.left, doc.page.height - 30, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'center', lineBreak: false });
      doc.page.margins.bottom = bottom;
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
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(size).fillColor('#0b2a4a').text(pdfText(text), doc.page.margins.left);
  const y = doc.y + 2;
  doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).lineWidth(0.5).strokeColor('#8899aa').stroke();
  doc.moveDown(0.4).fillColor('#000000');
}

export function para(doc: Doc, text: string, opts: { size?: number; bold?: boolean; mono?: boolean; color?: string } = {}): void {
  doc.font(opts.mono ? 'Courier' : opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size ?? 9).fillColor(opts.color ?? '#000000')
    .text(pdfText(text), doc.page.margins.left, doc.y, { width: contentWidth(doc) });
}

/** Two-column label/value rows. Values in `mono` render in Courier (hashes, identifiers). */
export function keyValues(doc: Doc, rows: Array<[string, unknown, boolean?]>, labelWidth = 140): void {
  const left = doc.page.margins.left;
  const w = contentWidth(doc) - labelWidth;
  for (const [label, value, mono] of rows) {
    const v = pdfText(value === null || value === undefined || value === '' ? '-' : value);
    doc.font(mono ? 'Courier' : 'Helvetica').fontSize(mono ? 8 : 9);
    const h = Math.max(doc.heightOfString(v, { width: w }), 11);
    ensureSpace(doc, h + 2);
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#333333').text(pdfText(label), left, y, { width: labelWidth - 6 });
    doc.font(mono ? 'Courier' : 'Helvetica').fontSize(mono ? 8 : 9).fillColor('#000000').text(v, left + labelWidth, y, { width: w });
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
    doc.rect(left, y - 2, total, 13).fill('#e8edf3');
    let x = left;
    cols.forEach((c, i) => {
      doc.font('Helvetica-Bold').fontSize(fontSize).fillColor('#0b2a4a').text(pdfText(c.header), x + 2, y, { width: widths[i]! - 4, lineBreak: false });
      x += widths[i]!;
    });
    doc.y = y + 13;
    doc.fillColor('#000000');
  };
  drawHeader();
  for (const r of rows) {
    const heights = r.map((cell, i) => {
      doc.font(cols[i]!.mono ? 'Courier' : 'Helvetica').fontSize(fontSize);
      return doc.heightOfString(pdfText(cell), { width: widths[i]! - 4 });
    });
    const h = Math.max(...heights, 9) + 3;
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    let x = left;
    r.forEach((cell, i) => {
      doc.font(cols[i]!.mono ? 'Courier' : 'Helvetica').fontSize(fontSize).fillColor('#000000').text(pdfText(cell), x + 2, y + 1, { width: widths[i]! - 4 });
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
