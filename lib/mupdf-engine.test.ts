import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { invertAffine, quadBounds, transformQuad, type AffineMatrix, type PageTransform } from './pdf-geometry';

import { classifyPdfOpenError, extractNativePages, redactPdf, redactionValidationInputs, validateRedactedPdf } from './mupdf-engine';
import { alignNativeLayout, extractNativeWordsForPage } from './pdf-processing';
import { detectCandidates, regionTargetsGlyph, unionRects, type PdfQuad, type RedactionCandidate } from './redaction';

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

function encryptFixture(source: Uint8Array, password: string): Uint8Array {
  const document = mupdf.Document.openDocument(source, 'application/pdf').asPDF();
  if (!document) throw new Error('fixture is not a PDF');
  const buffer = document.saveToBuffer(`encrypt=aes-256,user-password=${password},owner-password=owner-${password}`);
  try {
    return new Uint8Array(buffer.asUint8Array());
  } finally {
    buffer.destroy();
    document.destroy();
  }
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
    targetQuads: glyphs.map((glyph) => ({ source: glyph.source, quad: glyph.canonicalQuad, text: glyph.text })),
    selectionMode: 'exact-glyphs',
    ...rect,
  };
}

function reviewFor(bytes: Uint8Array, candidate: RedactionCandidate, password?: string) {
  const page = extractNativePages(bytes, undefined, password)[candidate.pageIndex];
  const pdfToCanvas = invertAffine(page.pageToPdf);
  return {
    pageIndex: page.pageIndex,
    pdfWidth: page.width,
    pdfHeight: page.height,
    renderWidth: page.width,
    renderHeight: page.height,
    transform: { pdfToCanvas, canvasToPdf: page.pageToPdf, rotation: page.rotation, cropBox: page.cropBox },
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
    expect(validateRedactedPdf(output, [{ width: original[0].width, height: original[0].height }], [{ pageIndex: 0, text: 'SECRET', quads: candidate.targetQuads }]).valid).toBe(true);

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
    expect(validateRedactedPdf(output, [{ width: original[0].width, height: original[0].height }], [{ pageIndex: 0, text: 'SECRET', quads: candidate.targetQuads }]).valid).toBe(true);
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

  it('validates against the same canonical Quads used for deletion', async () => {
    const source = await makeDigitalFixture([{ text: 'SECRET', y: 170 }]);
    const glyphs = extractNativePages(source)[0].words.find((item) => item.text === 'SECRET')!.glyphs;
    const candidate = exactCandidate(0, glyphs);
    const review = reviewFor(source, candidate);
    // Moving a review-only rectangle must not change deletion validation.
    candidate.y += 12;
    review.words.flatMap((word) => word.glyphs).forEach((glyph) => { glyph.bbox.y += 12; });
    const inputs = redactionValidationInputs([review]);

    expect(inputs.forbidden[0].quads[0].quad).toEqual(candidate.targetQuads[0].quad);
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
    expect(native[0].cropBox).toEqual([10, 20, 470, 270]);
    const secret = native[0].words.find((item) => item.text === 'SECRET')!;
    const output = redactPdf(source, [reviewFor(source, exactCandidate(0, secret.glyphs))]);
    const reopened = await PDFDocument.load(output);
    expect(reopened.getPage(0).getRotation().angle).toBe(90);
    expect(reopened.getPage(0).getCropBox()).toMatchObject({ x: 10, y: 20, width: 460, height: 250 });
    const outputText = extractNativePages(output)[0].text;
    expect(outputText).toContain('KEEP');
    expect(outputText).not.toContain('SECRET');
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
      renderWidth: native.width, renderHeight: native.height,
      transform: { pdfToCanvas: invertAffine(native.pageToPdf), canvasToPdf: native.pageToPdf, rotation: native.rotation, cropBox: native.cropBox },
      words: [], redactions: [candidate],
    }]);
    const before = renderPixels(source);
    const after = renderPixels(output);
    expect(rgbAt(after, 90, 90).every((channel) => channel >= 245)).toBe(true);
    expect(rgbAt(after, 55, 90)).toEqual(rgbAt(before, 55, 90));
  });

  it('removes image pixels through the complete selected photo boundary', async () => {
    const sourceDocument = await PDFDocument.create();
    const page = sourceDocument.addPage([200, 200]);
    const image = await sourceDocument.embedPng(solidPng(20, 20));
    page.drawImage(image, { x: 40, y: 40, width: 120, height: 120 });
    const source = await sourceDocument.save();
    const native = extractNativePages(source)[0];
    const imageBounds = native.imageBounds[0];
    const candidate: RedactionCandidate = {
      id: 'photo-boundary', pageIndex: 0, kind: 'photo', sourceText: '학생 사진', confidence: 100,
      selected: true, reason: 'test', targetGlyphIds: [], targetQuads: [], selectionMode: 'region',
      ...imageBounds,
    };
    const output = redactPdf(source, [{
      pageIndex: 0, pdfWidth: native.width, pdfHeight: native.height,
      renderWidth: native.width, renderHeight: native.height,
      transform: { pdfToCanvas: invertAffine(native.pageToPdf), canvasToPdf: native.pageToPdf, rotation: native.rotation, cropBox: native.cropBox },
      words: [], redactions: [candidate],
    }]);
    const after = renderPixels(output);

    expect(rgbAt(after, 100, 159).every((channel) => channel >= 245)).toBe(true);
  });

  it('removes the bottom pixel for fractional image bounds', async () => {
    const sourceDocument = await PDFDocument.create();
    const page = sourceDocument.addPage([200, 200]);
    const image = await sourceDocument.embedPng(solidPng(20, 20));
    page.drawImage(image, { x: 50.2, y: 2.5, width: 96.34, height: 123.12 });
    const source = await sourceDocument.save();
    const native = extractNativePages(source)[0];
    const imageBounds = native.imageBounds[0];
    expect(imageBounds.x).toBeCloseTo(50.2, 3);
    expect(imageBounds.y).toBeCloseTo(74.38, 3);
    expect(imageBounds.width).toBeCloseTo(96.34, 3);
    expect(imageBounds.height).toBeCloseTo(123.12, 3);
    const candidate: RedactionCandidate = {
      id: 'fractional-photo-boundary', pageIndex: 0, kind: 'photo', sourceText: '학생 사진', confidence: 100,
      selected: true, reason: 'test', targetGlyphIds: [], targetQuads: [], selectionMode: 'region',
      ...imageBounds,
    };
    const output = redactPdf(source, [{
      pageIndex: 0, pdfWidth: native.width, pdfHeight: native.height,
      renderWidth: native.width, renderHeight: native.height,
      transform: { pdfToCanvas: invertAffine(native.pageToPdf), canvasToPdf: native.pageToPdf, rotation: native.rotation, cropBox: native.cropBox },
      words: [], redactions: [candidate],
    }]);
    const after = renderPixels(output);

    expect(rgbAt(after, 98, 197).every((channel) => channel >= 245)).toBe(true);
  });

  it('extracts the actual bounds of an embedded image', async () => {
    const sourceDocument = await PDFDocument.create();
    const page = sourceDocument.addPage([200, 200]);
    const image = await sourceDocument.embedPng(solidPng(20, 20));
    page.drawImage(image, { x: 40, y: 40, width: 120, height: 80 });
    const native = extractNativePages(await sourceDocument.save())[0];

    expect(native.imageBounds).toHaveLength(1);
    expect(native.imageBounds[0]).toMatchObject({ x: 40, y: 80, width: 120, height: 80 });
  });

  it('does not treat a different overlapping glyph as an undeleted target', async () => {
    const source = await makeDigitalFixture([{ text: 'KEEP', y: 170 }]);
    const page = extractNativePages(source)[0];
    const broadQuad: PdfQuad = [0, 0, page.width, 0, 0, page.height, page.width, page.height];

    expect(validateRedactedPdf(source, [{ width: page.width, height: page.height }], [{
      pageIndex: 0,
      text: 'SECRET',
      quads: [{ quad: broadQuad, text: 'SECRET' }],
    }]).valid).toBe(true);
  });

  it('distinguishes missing and incorrect passwords, then extracts with the correct password', async () => {
    const encrypted = encryptFixture(await makeDigitalFixture([{ text: 'KEEP SECRET', y: 170 }]), 'school-1234');
    expect(() => extractNativePages(encrypted)).toThrow(expect.objectContaining({ code: 'password-required' }));
    expect(() => extractNativePages(encrypted, undefined, 'wrong')).toThrow(expect.objectContaining({ code: 'incorrect-password' }));
    expect(extractNativePages(encrypted, undefined, 'school-1234')[0].text).toContain('KEEP SECRET');
  });

  it('redacts an encrypted source and saves an unencrypted result', async () => {
    const password = 'school-1234';
    const encrypted = encryptFixture(await makeDigitalFixture([{ text: 'LEFTSECRETRIGHT', y: 170 }]), password);
    const original = extractNativePages(encrypted, undefined, password);
    const word = original[0].words.find((item) => item.text.includes('LEFTSECRETRIGHT'))!;
    const candidate = exactCandidate(0, word.glyphs.slice(4, 10));
    const output = redactPdf(encrypted, [reviewFor(encrypted, candidate, password)], undefined, password);
    const reopened = mupdf.Document.openDocument(output, 'application/pdf');
    expect(reopened.needsPassword()).toBe(false);
    reopened.destroy();
    const text = extractNativePages(output)[0].text;
    expect(text).toContain('LEFT');
    expect(text).toContain('RIGHT');
    expect(text).not.toContain('SECRET');
  });

  it('redacts a detected resident ID after PDF.js preview alignment', async () => {
    const password = 'school-1234';
    const source = encryptFixture(await makeDigitalFixture([{ text: 'KEEP 900101-1234567 SAFE', y: 170 }]), password);
    const native = structuredClone(extractNativePages(source, undefined, password)[0]);
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(source), password });
    const document = await loadingTask.promise;
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 200 / 72 });
    const pdfToCanvas = viewport.transform as AffineMatrix;
    const transform: PageTransform = {
      pdfToCanvas,
      canvasToPdf: invertAffine(pdfToCanvas),
      rotation: viewport.rotation,
      cropBox: [...viewport.viewBox] as [number, number, number, number],
    };
    const projected = native.words.map((word) => {
      const glyphs = word.glyphs.map((glyph) => ({
        ...glyph,
        bbox: quadBounds(transformQuad(transform.pdfToCanvas, glyph.canonicalQuad)),
      }));
      return { ...word, glyphs, bbox: unionRects(glyphs.map((glyph) => glyph.bbox)) };
    });
    const rendered = await extractNativeWordsForPage(page, viewport, 0, pdfjs.Util);
    const words = alignNativeLayout(projected, rendered, transform).words;
    const candidate = detectCandidates(words, [], {
      pageWidth: viewport.width,
      pageHeight: viewport.height,
    }).find((item) => item.kind === 'resident-id')!;

    const review = structuredClone({
      pageIndex: 0,
      pdfWidth: viewport.width / viewport.scale,
      pdfHeight: viewport.height / viewport.scale,
      renderWidth: viewport.width,
      renderHeight: viewport.height,
      transform,
      words,
      redactions: [candidate],
    });
    const output = redactPdf(source, [review], undefined, password);

    expect(extractNativePages(output)[0].text).not.toContain('900101-1234567');
    page.cleanup();
    await loadingTask.destroy();
  });

  it('maps encryption-related open failures to unsupported encryption', () => {
    expect(classifyPdfOpenError('unknown crypt filter in encrypted document')).toBe('unsupported-encryption');
    expect(classifyPdfOpenError('invalid xref table')).toBeUndefined();
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

const localRegressionSample = resolve('sample', '비식별화 테스트.pdf');
const describeWithLocalRegressionSample = existsSync(localRegressionSample) ? describe : describe.skip;

describeWithLocalRegressionSample('비식별화 테스트.pdf local regression', () => {
  it('does not select activity hours on page 4 and fully removes page-5 school names', () => {
    const source = new Uint8Array(readFileSync(localRegressionSample));
    const original = extractNativePages(source);
    expect(original).toHaveLength(17);

    const page4Candidates = detectCandidates(original[3].words, [], {
      pageWidth: original[3].width,
      pageHeight: original[3].height,
    });
    const activityHourCandidates = page4Candidates.filter(
      (candidate) =>
        (candidate.kind === 'class' || candidate.kind === 'student-number') &&
        candidate.sourceText === '42',
    );
    expect(activityHourCandidates).toHaveLength(0);

    const page5Candidates = detectCandidates(original[4].words, [], {
      pageWidth: original[4].width,
      pageHeight: original[4].height,
    });
    const schoolCandidates = page5Candidates.filter((candidate) => candidate.kind === 'school-name');
    expect(schoolCandidates.length).toBeGreaterThan(0);
    expect(original[4].text).toContain('안산강서고등학교');

    const reviews = original.map((page) => ({
      pageIndex: page.pageIndex,
      pdfWidth: page.width,
      pdfHeight: page.height,
      renderWidth: page.width,
      renderHeight: page.height,
      transform: {
        pdfToCanvas: invertAffine(page.pageToPdf),
        canvasToPdf: page.pageToPdf,
        rotation: page.rotation,
        cropBox: page.cropBox,
      },
      words: page.words,
      redactions: page.pageIndex === 4 ? schoolCandidates : [],
    }));
    const output = redactPdf(source, reviews);
    const redacted = extractNativePages(output);
    if (process.env.WRITE_PDF_QA === '1') {
      mkdirSync('tmp/pdfs', { recursive: true });
      writeFileSync('tmp/pdfs/sample-original.pdf', source);
      writeFileSync('tmp/pdfs/sample-school-redacted.pdf', output);
    }

    expect(redacted).toHaveLength(original.length);
    expect(redacted[4].text).not.toContain('안산강서고등학교');
    expect(redacted[4].text).not.toContain('안산');
    expect(redacted[4].width).toBe(original[4].width);
    expect(redacted[4].height).toBe(original[4].height);
  }, 30_000);
});

const localCollegePhotoSample = resolve('sample', 'college-photo-regression.pdf');
const describeWithLocalCollegePhotoSample = existsSync(localCollegePhotoSample) ? describe : describe.skip;

describeWithLocalCollegePhotoSample('college photo local regression', () => {
  it('removes the final portrait raster row without moving the candidate above the image', () => {
    const source = new Uint8Array(readFileSync(localCollegePhotoSample));
    const original = extractNativePages(source);
    const firstPage = original[0];
    const photo = detectCandidates(firstPage.words, [], {
      pageWidth: firstPage.width,
      pageHeight: firstPage.height,
      imageBounds: firstPage.imageBounds,
    }).find((candidate) => candidate.kind === 'photo');
    expect(photo).toBeDefined();
    expect(photo!.y).toBeCloseTo(firstPage.imageBounds[0].y, 3);
    expect(photo!.height).toBeGreaterThan(firstPage.imageBounds[0].height);

    const reviews = original.map((page) => ({
      pageIndex: page.pageIndex,
      pdfWidth: page.width,
      pdfHeight: page.height,
      renderWidth: page.width,
      renderHeight: page.height,
      transform: {
        pdfToCanvas: invertAffine(page.pageToPdf),
        canvasToPdf: page.pageToPdf,
        rotation: page.rotation,
        cropBox: page.cropBox,
      },
      words: page.words,
      redactions: page.pageIndex === 0 ? [photo!] : [],
    }));
    const output = redactPdf(source, reviews);
    const before = renderPixels(source);
    const image = renderPixels(output);
    const x = Math.floor(photo!.x + photo!.width * 0.77);
    const y = Math.floor(firstPage.imageBounds[0].y + firstPage.imageBounds[0].height - 0.5);

    expect(rgbAt(before, x, y).some((channel) => channel < 245)).toBe(true);
    expect(rgbAt(image, x, y).every((channel) => channel >= 245)).toBe(true);
  }, 30_000);
});
