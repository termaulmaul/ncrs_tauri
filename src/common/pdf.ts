export type PdfOptions = {
  title?: string;
  author?: string;
  pageWidth?: number; // points
  pageHeight?: number; // points
  margin?: number; // points
  fontSize?: number; // points
  lineHeight?: number; // points
};

function pad10(n: number) {
  const s = String(n);
  return '0'.repeat(10 - s.length) + s;
}

function asciiApprox(text: string) {
  // Replace common UTF punctuation with ASCII approximations to keep stream ASCII-only
  return text
    .replace(/[\u2013\u2014\u2212\u2015]/g, '-') // en/em/minus/horizontal bar → hyphen
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'") // left/right/single primes → '
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"') // left/right/double primes → "
    .replace(/[\u00A0\u2007\u202F]/g, ' ') // non-breaking spaces → space
    .replace(/[\u2022\u2023\u2043\u2219]/g, '*') // bullets → *
    .replace(/[\u2192\u27A1]/g, '->') // arrows → ->
    .replace(/[\u2026]/g, '...'); // ellipsis → ...
}

function pdfEscape(text: string) {
  return text
    .split('\n').join(' ') // avoid accidental newlines
    .split('\r').join(' ')
    .replace(/[\u0080-\uFFFF]/g, (ch) => asciiApprox(ch))
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/**
 * Build a very small PDF with core font Courier and multi-page text.
 * Lines are rendered monospaced; caller is responsible for wrapping.
 */
export function buildSimplePdf(headerLines: string[], bodyLines: string[], options: PdfOptions = {}) {
  const pageWidth = options.pageWidth ?? 595.28; // A4 width
  const pageHeight = options.pageHeight ?? 841.89; // A4 height
  const margin = options.margin ?? 36; // 0.5 inch
  const fontSize = options.fontSize ?? 10;
  const lineHeight = options.lineHeight ?? 12;

  const topY = pageHeight - margin - fontSize;
  const leftX = margin;

  const usableHeight = pageHeight - margin * 2 - fontSize; // rough
  const maxLinesPerPage = Math.max(1, Math.floor(usableHeight / lineHeight));
  const headerCount = headerLines.length;
  const bodyPerPage = Math.max(1, maxLinesPerPage - headerCount);

  // Chunk body into pages, repeating header on each page
  const pages: string[][] = [];
  for (let i = 0; i < bodyLines.length || (i === 0 && bodyLines.length === 0); i += bodyPerPage) {
    const chunk = bodyLines.slice(i, i + bodyPerPage);
    pages.push([...headerLines, ...chunk]);
  }

  // Objects: 1 Catalog, 2 Pages, 3 Font, then N pairs (Page, Content), then Info
  type Obj = { id: number; content: string };
  const objs: Obj[] = [];

  const catalogId = 1;
  const pagesId = 2;
  const fontId = 3;

  // Predeclare page and content ids
  const pageObjs: { pageId: number; contentId: number }[] = [];
  let nextId = 4;
  for (let p = 0; p < pages.length; p++) {
    pageObjs.push({ pageId: nextId++, contentId: nextId++ });
  }
  const infoId = nextId++;

  // Font object (Courier)
  objs.push({ id: fontId, content: `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>` });

  // Page objects and content streams
  const kidsRef: string[] = [];
  pages.forEach((lines, idx) => {
    const { pageId, contentId } = pageObjs[idx];
    kidsRef.push(`${pageId} 0 R`);

    // Compose content stream
    const escapedLines = lines.map((l) => pdfEscape(asciiApprox(l)));
    const contentLines: string[] = [];
    contentLines.push('BT');
    contentLines.push(`/F1 ${fontSize} Tf`);
    contentLines.push(`1 0 0 1 ${leftX.toFixed(2)} ${topY.toFixed(2)} Tm`);
    for (let i = 0; i < escapedLines.length; i++) {
      const t = escapedLines[i] || ' ';
      if (i === 0) {
        contentLines.push(`(${t}) Tj`);
      } else {
        contentLines.push(`0 -${lineHeight} Td`);
        contentLines.push(`(${t}) Tj`);
      }
    }
    contentLines.push('ET');
    const contentStream = contentLines.join('\n');
    const content = `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`;

    objs.push({ id: contentId, content });

    // Page object
    const pageDict = [
      '<<',
      '/Type /Page',
      `/Parent ${pagesId} 0 R`,
      `/MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}]`,
      `/Resources << /Font << /F1 ${fontId} 0 R >> >>`,
      `/Contents ${contentId} 0 R`,
      '>>',
    ].join(' ');
    objs.push({ id: pageId, content: pageDict });
  });

  // Pages object
  const pagesDict = `<< /Type /Pages /Count ${pages.length} /Kids [ ${kidsRef.join(' ')} ] >>`;
  objs.push({ id: pagesId, content: pagesDict });

  // Catalog object
  const catalogDict = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs.push({ id: catalogId, content: catalogDict });

  // Info
  const now = new Date();
  const date = `D:${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}+00'00'`;
  const title = options.title ? pdfEscape(options.title) : 'Document';
  const author = options.author ? pdfEscape(options.author) : 'NCRS';
  const infoDict = `<< /Title (${title}) /Author (${author}) /Producer (NCRS) /Creator (NCRS) /CreationDate (${date}) >>`;
  objs.push({ id: infoId, content: infoDict });

  // Assemble
  // Sort by id just in case
  objs.sort((a, b) => a.id - b.id);
  let offset = 0;
  const parts: string[] = [];
  parts.push('%PDF-1.4\n');
  offset += parts[0].length;

  const xrefEntries: { id: number; offset: number }[] = [];
  for (const obj of objs) {
    const head = `${obj.id} 0 obj\n`;
    const body = `${obj.content}\n`;
    const end = `endobj\n`;
    const s = head + body + end;
    xrefEntries.push({ id: obj.id, offset });
    parts.push(s);
    offset += s.length;
  }

  const xrefStart = offset;
  const maxId = Math.max(...objs.map(o => o.id));
  const xrefLines: string[] = [];
  xrefLines.push('xref');
  xrefLines.push(`0 ${maxId + 1}`);
  xrefLines.push('0000000000 65535 f ');
  for (let i = 1; i <= maxId; i++) {
    const entry = xrefEntries.find(e => e.id === i);
    const off = entry ? pad10(entry.offset) : '0000000000';
    xrefLines.push(`${off} 00000 n `);
  }
  const xrefStr = xrefLines.join('\n') + '\n';
  parts.push(xrefStr);
  offset += xrefStr.length;

  const trailer = [
    'trailer',
    `<< /Size ${maxId + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>`,
    'startxref',
    String(xrefStart),
    '%%EOF\n',
  ].join('\n');
  parts.push(trailer);

  const pdf = parts.join('');
  return new Blob([pdf], { type: 'application/pdf' });
}
