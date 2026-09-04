import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';

import { extractNativePages, redactPdf, validateRedactedPdf } from './mupdf-engine';
import { regionTargetsGlyph, unionRects, type RedactionCandidate } from './redaction';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const result = new Uint8Array(12 + data.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(typeBytes, 4);
  result.set(data, 8);
  view.setUint32(8 + data.length, crc32(result.subarray(4, 8 + data.length)));
  return result;
}

function solidPng(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const pixels = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) pixels.set([210, 45, 45], row + 1 + x * 3);
  }
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', new Uint8Array())];
  const output = new Uint8Array(signature.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  output.set(signature);
  let offset = signature.length;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

function renderPixels(bytes: Uint8Array) {
  const document = new mupdf.PDFDocument(bytes);
  const page = document.loadPage(0);
  const pixmap = page.toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
  const result = { pixels: new Uint8ClampedArray(pixmap.getPixels()), width: pixmap.getWidth(), components: pixmap.getNumberOfComponents() };
  pixmap.destroy();
  page.destroy();
  document.destroy();
  return result;
}

function rgbAt(render: ReturnType<typeof renderPixels>, x: number, y: number): number[] {
  const offset = (y * render.width + x) * render.components;
  return Array.from(render.pixels.slice(offset, offset + 3));
}

async function makeDigitalFixture(lines: Array<{ text: string; y: number }>): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([420, 240]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawLine({ start: { x: 20, y: 120 }, end: { x: 400, y: 120 }, thickness: 1, color: rgb(0, 0, 0) });
  page.drawLine({ start: { x: 210, y: 40 }, end: { x: 210, y: 210 }, thickness: 1, color: rgb(0, 0, 0) });
  for (const line of lines) page.drawText(line.text, { x: 40, y: line.y, size: 18, font });
  document.setTitle('secret title');
  document.setAuthor('secret author');
  await document.attach(new Uint8Array([1, 2, 3]), 'secret.bin', { mimeType: 'application/octet-stream' });
  return document.save();
}

function exactCandidate(pageIndex: number, glyphs: ReturnType<typeof extractNativePages>[number]['words'][number]['glyphs']): RedactionCandidate {
  const rect = unionRects(glyphs.map((glyph) => glyph.bbox), 4);
  return {
    id: `candidate-${pageIndex}`,
    pageIndex,
    kind: 'entered-name',
    sourceText: glyphs.map((glyph) => glyph.text).join(''),
    confidence: 100,
    selected: true,
    reason: 'test',
    targetGlyphIds: glyphs.map((glyph) => glyph.id),
    targetQuads: glyphs.map((glyph) => ({ source: glyph.source, quad: glyph.quad })),
    selectionMode: 'exact-glyphs',
    ...rect,
  };
}

function reviewFor(bytes: Uint8Array, candidate: RedactionCandidate) {
  const page = extractNativePages(bytes)[candidate.pageIndex];
  return {
    pageIndex: page.pageIndex,
    pdfWidth: page.width,
    pdfHeight: page.height,
    renderWidth: page.width,
    renderHeight: page.height,
    words: page.words,
    redactions: [candidate],
  };
}

describe('MuPDF structure-preserving redaction', () => {
  it('removes only matching glyphs inside one text run and keeps neighboring text', async () => {
    const source = await makeDigitalFixture([{ text: 'LEFTSECRETRIGHT', y: 170 }]);
    const original = extractNativePages(source);
    const word = original[0].words.find((item) => item.text.includes('LEFTSECRETRIGHT'))!;
    const candidate = exactCandidate(0, word.glyphs.slice(4, 10));
    const output = redactPdf(source, [reviewFor(source, candidate)]);
    if (process.env.WRITE_PDF_QA === '1') {
      mkdirSync('tmp/pdfs', { recursive: true });
      writeFileSync('tmp/pdfs/original-digital.pdf', source);
      writeFileSync('tmp/pdfs/redacted-digital.pdf', output);
    }
    const result = extractNativePages(output);

    expect(result[0].text).toContain('LEFT');
    expect(result[0].text).toContain('RIGHT');
    expect(result[0].text).not.toContain('SECRET');
    expect(validateRedactedPdf(output, [{ width: original[0].width, height: original[0].height }], [{ pageIndex: 0, text: 'SECRET', quads: candidate.targetQuads.map((item) => item.quad) }]).valid).toBe(true);

    const reopened = new mupdf.PDFDocument(output);
    expect(Object.keys(reopened.getEmbeddedFiles())).toHaveLength(0);
    expect(reopened.getMetaData(mupdf.Document.META_INFO_AUTHOR) || '').toBe('');
    reopened.destroy();
  });

  it('removes one selected occurrence while leaving the same text elsewhere searchable', async () => {
    const source = await makeDigitalFixture([{ text: 'SECRET', y: 170 }, { text: 'SECRET', y: 70 }]);
    const original = extractNativePages(source);
    const first = original[0].words.filter((item) => item.text === 'SECRET')[0];
    const candidate = exactCandidate(0, first.glyphs);
    const output = redactPdf(source, [reviewFor(source, candidate)]);
    const text = extractNativePages(output)[0].text;
    expect(text.match(/SECRET/g)).toHaveLength(1);
    expect(validateRedactedPdf(output, [{ width: original[0].width, height: original[0].height }], [{ pageIndex: 0, text: 'SECRET', quads: candidate.targetQuads.map((item) => item.quad) }]).valid).toBe(true);
  });

  it('retries the reviewed region when an Office-style glyph link cannot be applied', async () => {
    const source = await makeDigitalFixture([{ text: 'LEFTSECRETRIGHT', y: 170 }]);
    const original = extractNativePages(source);
    const word = original[0].words.find((item) => item.text.includes('LEFTSECRETRIGHT'))!;
    const candidate = exactCandidate(0, word.glyphs.slice(4, 10));
    candidate.targetGlyphIds = ['unavailable-office-glyph'];

    const output = redactPdf(source, [reviewFor(source, candidate)]);
    const text = extractNativePages(output)[0].text;

    expect(text).toContain('LEFT');
    expect(text).toContain('RIGHT');
    expect(text).not.toContain('SECRET');
  });

  it('preserves rotation and CropBox during a full rewrite', async () => {
    const sourceDocument = await PDFDocument.create();
    const page = sourceDocument.addPage([500, 300]);
    const font = await sourceDocument.embedFont(StandardFonts.Helvetica);
    page.drawText('KEEP SECRET', { x: 40, y: 140, size: 18, font });
    page.setRotation(degrees(90));
    page.setCropBox(10, 20, 460, 250);
    const source = await sourceDocument.save();
    const native = extractNativePages(source);
    const secret = native[0].words.find((item) => item.text === 'SECRET')!;
    const output = redactPdf(source, [reviewFor(source, exactCandidate(0, secret.glyphs))]);
    const reopened = await PDFDocument.load(output);
    expect(reopened.getPage(0).getRotation().angle).toBe(90);
    expect(reopened.getPage(0).getCropBox()).toMatchObject({ x: 10, y: 20, width: 460, height: 250 });
    expect(extractNativePages(output)[0].text).toContain('KEEP');
  });

  it('whitens only selected pixels inside a scanned image', async () => {
    const sourceDocument = await PDFDocument.create();
    const page = sourceDocument.addPage([200, 200]);
    const image = await sourceDocument.embedPng(solidPng(20, 20));
    page.drawImage(image, { x: 40, y: 40, width: 120, height: 120 });
    const source = await sourceDocument.save();
    const native = extractNativePages(source)[0];
    const candidate: RedactionCandidate = {
      id: 'manual-image', pageIndex: 0, kind: 'manual', sourceText: 'manual', confidence: 100,
      selected: true, reason: 'test', targetGlyphIds: [], targetQuads: [], selectionMode: 'region',
      x: 75, y: 75, width: 30, height: 30,
    };
    const output = redactPdf(source, [{
      pageIndex: 0, pdfWidth: native.width, pdfHeight: native.height,
      renderWidth: native.width, renderHeight: native.height, words: [], redactions: [candidate],
    }]);
    const before = renderPixels(source);
    const after = renderPixels(output);
    expect(rgbAt(after, 90, 90).every((channel) => channel >= 245)).toBe(true);
    expect(rgbAt(after, 55, 90)).toEqual(rgbAt(before, 55, 90));
  });
});

describe('region glyph threshold', () => {
  const glyph = { x: 10, y: 10, width: 20, height: 10 };
  it('targets a glyph when its center is inside', () => {
    expect(regionTargetsGlyph({ x: 19, y: 14, width: 2, height: 2 }, glyph)).toBe(true);
  });
  it('targets at 50% overlap but not below it', () => {
    expect(regionTargetsGlyph({ x: 10, y: 10, width: 10, height: 10 }, glyph)).toBe(true);
    expect(regionTargetsGlyph({ x: 10, y: 10, width: 9, height: 10 }, glyph)).toBe(false);
  });
});
