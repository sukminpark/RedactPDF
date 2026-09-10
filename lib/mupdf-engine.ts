import * as mupdf from 'mupdf';
import type { Quad, Rect } from 'mupdf';

import { invertAffine, quadBounds, rectQuad as boundsQuad, transformQuad, type AffineMatrix } from './pdf-geometry';
import { PdfProcessingError, type NativePageText, type PdfErrorCode, type ValidationResult, type WorkerReviewPage } from './mupdf-types';
import { regionTargetsGlyph, unionRects, type CanvasRect, type OcrWord, type PdfQuad, type TextGlyph } from './redaction';

const TEXT_OPTIONS = 'preserve-whitespace,accurate-bboxes,accurate-side-bearings,preserve-images';
const METADATA_KEYS = [
  mupdf.Document.META_INFO_AUTHOR,
  mupdf.Document.META_INFO_TITLE,
  mupdf.Document.META_INFO_SUBJECT,
  mupdf.Document.META_INFO_KEYWORDS,
  mupdf.Document.META_INFO_CREATOR,
  mupdf.Document.META_INFO_PRODUCER,
  mupdf.Document.META_INFO_CREATIONDATE,
  mupdf.Document.META_INFO_MODIFICATIONDATE,
];

function quadRect(quad: PdfQuad): Rect {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function classifyPdfOpenError(message: string): PdfErrorCode | undefined {
  return /encrypt|password|crypt/i.test(message) ? 'unsupported-encryption' : undefined;
}

function openAuthenticatedDocument(source: ArrayBuffer | Uint8Array, password?: string): mupdf.Document {
  let document: mupdf.Document;
  try {
    document = mupdf.Document.openDocument(source, 'application/pdf');
  } catch (error) {
    if (classifyPdfOpenError(error instanceof Error ? error.message : '') === 'unsupported-encryption') {
      throw new PdfProcessingError('unsupported-encryption', '이 PDF의 암호화 방식은 지원하지 않습니다.');
    }
    throw error;
  }
  if (!document.needsPassword()) return document;
  if (password === undefined) {
    document.destroy();
    throw new PdfProcessingError('password-required', 'PDF 비밀번호를 입력해 주세요.');
  }
  try {
    if (document.authenticatePassword(password) === 0) {
      document.destroy();
      throw new PdfProcessingError('incorrect-password', '비밀번호가 올바르지 않습니다.');
    }
  } catch (error) {
    document.destroy();
    if (error instanceof PdfProcessingError) throw error;
    throw new PdfProcessingError('unsupported-encryption', '이 PDF의 암호화 방식은 지원하지 않습니다.');
  }
  return document;
}

function closeWord(
  words: OcrWord[],
  glyphs: TextGlyph[],
  pageIndex: number,
  lineIndex: number,
  wordIndex: number,
): void {
  if (glyphs.length === 0) return;
  words.push({
    id: `${pageIndex}-native-${lineIndex}-${wordIndex}`,
    pageIndex,
    lineId: `${pageIndex}-native-${lineIndex}`,
    text: glyphs.map((glyph) => glyph.text).join(''),
    confidence: 100,
    bbox: unionRects(glyphs.map((glyph) => glyph.bbox)),
    source: 'native',
    glyphs,
  });
}

export function extractNativePages(
  source: ArrayBuffer | Uint8Array,
  onPageStart?: (pageIndex: number, totalPages: number) => void,
  password?: string,
): NativePageText[] {
  const document = openAuthenticatedDocument(source, password);
  try {
    const totalPages = document.countPages();
    const pages: NativePageText[] = [];
    for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
      onPageStart?.(pageIndex, totalPages);
      const page = document.loadPage(pageIndex) as mupdf.PDFPage;
      const structured = page.toStructuredText(TEXT_OPTIONS);
      try {
        const bounds = page.getBounds();
        const pdfToPage = page.getTransform() as AffineMatrix;
        const pageToPdf = invertAffine(pdfToPage);
        const cropBox = quadBounds(transformQuad(pageToPdf, boundsQuad({
          x: bounds[0], y: bounds[1], width: bounds[2] - bounds[0], height: bounds[3] - bounds[1],
        })));
        const words: OcrWord[] = [];
        const imageBounds: CanvasRect[] = [];
        let lineIndex = -1;
        let wordIndex = 0;
        let glyphs: TextGlyph[] = [];
        const flush = () => {
          closeWord(words, glyphs, pageIndex, lineIndex, wordIndex);
          if (glyphs.length > 0) wordIndex += 1;
          glyphs = [];
        };
        structured.walk({
          beginLine() {
            flush();
            lineIndex += 1;
            wordIndex = 0;
          },
          onChar(character, _origin, _font, _size, rawQuad) {
            if (/\s/u.test(character)) {
              flush();
              return;
            }
            const quad = [...rawQuad] as PdfQuad;
            const rect = quadRect(quad);
            glyphs.push({
              id: `${pageIndex}-native-${lineIndex}-${wordIndex}-${glyphs.length}`,
              text: character,
              source: 'native',
              sourceQuad: quad,
              canonicalQuad: transformQuad(pageToPdf, quad),
              bbox: { x: rect[0], y: rect[1], width: Math.max(0.01, rect[2] - rect[0]), height: Math.max(0.01, rect[3] - rect[1]) },
            });
          },
          onImageBlock(bbox) {
            imageBounds.push({
              x: bbox[0],
              y: bbox[1],
              width: Math.max(0.01, bbox[2] - bbox[0]),
              height: Math.max(0.01, bbox[3] - bbox[1]),
            });
          },
          endLine: flush,
        });
        flush();
        pages.push({
          pageIndex,
          width: bounds[2] - bounds[0],
          height: bounds[3] - bounds[1],
          rotation: (() => {
            try { return page.getObject().getInheritable('Rotate').asNumber(); } catch { return 0; }
          })(),
          cropBox: [cropBox.x, cropBox.y, cropBox.x + cropBox.width, cropBox.y + cropBox.height],
          pageToPdf,
          imageBounds,
          words,
          text: structured.asText(),
        });
      } finally {
        structured.destroy();
        page.destroy();
      }
    }
    return pages;
  } finally {
    document.destroy();
  }
}

function sanitizeDocument(document: mupdf.PDFDocument): void {
  document.disableJS();
  document.bake(false, true);
  for (const filename of Object.keys(document.getEmbeddedFiles())) document.deleteEmbeddedFile(filename);
  for (const key of METADATA_KEYS) {
    try { document.setMetaData(key, ''); } catch { /* absent metadata */ }
  }
  const root = document.getTrailer().get('Root');
  for (const key of ['AcroForm', 'Metadata', 'OpenAction', 'AA', 'Perms', 'StructTreeRoot', 'MarkInfo']) {
    try { root.delete(key); } catch { /* absent catalog entry */ }
  }
  try {
    const names = root.get('Names');
    names.delete('JavaScript');
    names.delete('EmbeddedFiles');
  } catch { /* absent names dictionary */ }
  try { document.getTrailer().delete('Info'); } catch { /* absent info dictionary */ }
}

type RedactionTargetMode = 'exact-glyphs' | 'regions';

function canonicalToPageQuad(page: mupdf.PDFPage, quad: PdfQuad): PdfQuad {
  return transformQuad(page.getTransform() as AffineMatrix, quad);
}

function canvasRectToPageQuad(page: mupdf.PDFPage, review: WorkerReviewPage, rect: CanvasRect): PdfQuad {
  const canonical = transformQuad(review.transform.canvasToPdf, boundsQuad(rect));
  return canonicalToPageQuad(page, canonical);
}

function selectedTargets(
  page: WorkerReviewPage,
  pdfPage: mupdf.PDFPage,
  targetMode: RedactionTargetMode,
): { textQuads: PdfQuad[]; imageQuads: PdfQuad[] } {
  const glyphById = new Map(page.words.flatMap((word) => word.glyphs).map((glyph) => [glyph.id, glyph]));
  const textQuads: PdfQuad[] = [];
  const imageQuads: PdfQuad[] = [];
  for (const candidate of page.redactions.filter((item) => item.selected)) {
    const targetedGlyphs = candidate.targetGlyphIds
      .map((id) => glyphById.get(id))
      .filter((glyph): glyph is TextGlyph => Boolean(glyph));
    if (targetMode === 'exact-glyphs' && candidate.selectionMode === 'exact-glyphs' && candidate.targetGlyphIds.length > 0) {
      for (const glyph of targetedGlyphs) {
        if (glyph.source === 'native') textQuads.push(canonicalToPageQuad(pdfPage, glyph.canonicalQuad));
        if (glyph.source === 'ocr') imageQuads.push(canonicalToPageQuad(pdfPage, glyph.canonicalQuad));
      }
      continue;
    }
    const matchingGlyphs = targetMode === 'regions' && candidate.selectionMode === 'exact-glyphs' && targetedGlyphs.length > 0
      ? targetedGlyphs
      : page.words
        .flatMap((word) => word.glyphs)
        .filter((glyph) => regionTargetsGlyph(candidate, glyph.bbox));
    for (const glyph of matchingGlyphs) {
      if (glyph.source === 'native') textQuads.push(canonicalToPageQuad(pdfPage, glyph.canonicalQuad));
    }
    // Office-exported PDFs can expose glyph Quads that are too narrow for the
    // redaction operator. Only after the exact-glyph pass fails, retry against
    // the same reviewed on-screen region (the box includes just its small UI
    // padding), still without rasterising the page.
    const matchingNativeGlyphs = matchingGlyphs.filter((glyph) => glyph.source === 'native');
    if (targetMode === 'regions' && matchingNativeGlyphs.length > 0) {
      // Do not use the visible candidate's padding here. Rebuild the fallback
      // rectangle from the glyphs selected inside it, so adjacent characters
      // remain outside the destructive fallback area.
      const nativeBounds = unionRects(matchingNativeGlyphs.map((glyph) => glyph.bbox));
      const minimumThickness = Math.min(page.renderWidth / Math.max(1, page.pdfWidth), page.renderHeight / Math.max(1, page.pdfHeight)) * 10;
      if (nativeBounds.width >= nativeBounds.height && nativeBounds.height < minimumThickness) {
        nativeBounds.y -= (minimumThickness - nativeBounds.height) / 2;
        nativeBounds.height = minimumThickness;
      } else if (nativeBounds.width < minimumThickness) {
        nativeBounds.x -= (minimumThickness - nativeBounds.width) / 2;
        nativeBounds.width = minimumThickness;
      }
      textQuads.push(canvasRectToPageQuad(pdfPage, page, nativeBounds));
    }
    if (candidate.kind === 'manual' || candidate.kind === 'photo' || matchingGlyphs.some((glyph) => glyph.source === 'ocr')) {
      imageQuads.push(canvasRectToPageQuad(pdfPage, page, candidate));
    }
  }
  return { textQuads, imageQuads };
}

function addRedactionQuads(page: mupdf.PDFPage, quads: PdfQuad[]): void {
  for (const quad of quads) {
    const annotation = page.createAnnotation('Redact');
    // A Quad identifies the exact glyph, while Rect is the redaction area MuPDF
    // applies to page content. Supplying both is required by some Office-exported
    // PDFs, which otherwise preserve their text despite retaining the Quad data.
    annotation.setRect(quadRect(quad));
    annotation.setQuadPoints([quad as Quad]);
    annotation.update();
  }
}

function redactPdfPass(
  source: ArrayBuffer | Uint8Array,
  reviewPages: WorkerReviewPage[],
  targetMode: RedactionTargetMode,
  password?: string,
  onProgress?: (pageIndex: number, progress: number) => void,
  progressStart = 0,
  progressEnd = 90,
): Uint8Array {
  const opened = openAuthenticatedDocument(source, password);
  const document = opened.asPDF();
  if (!document) {
    opened.destroy();
    throw new Error('PDF 문서를 열지 못했습니다.');
  }
  try {
    sanitizeDocument(document);
    for (let pageIndex = 0; pageIndex < document.countPages(); pageIndex += 1) {
      const progress = progressStart + Math.round((pageIndex / Math.max(1, document.countPages())) * (progressEnd - progressStart));
      onProgress?.(pageIndex, progress);
      const page = document.loadPage(pageIndex) as mupdf.PDFPage;
      try {
        for (const annotation of page.getAnnotations()) page.deleteAnnotation(annotation);
        for (const link of page.getLinks()) page.deleteLink(link);
        try { page.getObject().delete('AA'); } catch { /* absent page actions */ }
        const review = reviewPages.find((candidate) => candidate.pageIndex === pageIndex);
        if (!review) continue;
        const targets = selectedTargets(review, page, targetMode);
        addRedactionQuads(page, targets.textQuads);
        if (targets.textQuads.length > 0) {
          page.applyRedactions(
            false,
            mupdf.PDFPage.REDACT_IMAGE_NONE,
            mupdf.PDFPage.REDACT_LINE_ART_NONE,
            mupdf.PDFPage.REDACT_TEXT_REMOVE,
          );
        }
        addRedactionQuads(page, targets.imageQuads);
        if (targets.imageQuads.length > 0) {
          page.applyRedactions(
            false,
            mupdf.PDFPage.REDACT_IMAGE_PIXELS,
            mupdf.PDFPage.REDACT_LINE_ART_NONE,
            mupdf.PDFPage.REDACT_TEXT_NONE,
          );
        }
      } finally {
        page.destroy();
      }
    }
    const buffer = document.saveToBuffer('garbage=deduplicate,compress=yes,compress-fonts=yes,sanitize=yes,encrypt=none,regenerate-id=yes');
    try {
      return new Uint8Array(buffer.asUint8Array());
    } finally {
      buffer.destroy();
    }
  } finally {
    document.destroy();
  }
}

export function redactionValidationInputs(reviewPages: WorkerReviewPage[]) {
  return {
    expectedPages: reviewPages.map((page) => ({ width: page.pdfWidth, height: page.pdfHeight })),
    forbidden: reviewPages.flatMap((page) => {
      const glyphById = new Map(page.words.flatMap((word) => word.glyphs).map((glyph) => [glyph.id, glyph]));
      return page.redactions
        .filter((item) => item.selected && item.selectionMode === 'exact-glyphs')
        .map((item) => {
          const quads = item.targetGlyphIds.map((id) => glyphById.get(id)).filter((glyph): glyph is TextGlyph => Boolean(glyph)).map((glyph) => ({
            text: glyph.text,
            // Validate the exact rectangle supplied to MuPDF, rather than its
            // original paint-only Quad. These differ in Office PDFs with
            // clipped glyph metrics and must never disagree.
            quad: glyph.canonicalQuad,
          }));
          return { pageIndex: page.pageIndex, text: item.sourceText, quads: quads.length > 0 ? quads : item.targetQuads };
        });
    }),
  };
}

export function redactPdf(
  source: ArrayBuffer | Uint8Array,
  reviewPages: WorkerReviewPage[],
  onProgress?: (pageIndex: number, progress: number) => void,
  password?: string,
): Uint8Array {
  const inputs = redactionValidationInputs(reviewPages);
  const exactOutput = redactPdfPass(source, reviewPages, 'exact-glyphs', password, onProgress, 3, 85);
  if (validateRedactedPdf(exactOutput, inputs.expectedPages, inputs.forbidden).valid) return exactOutput;

  onProgress?.(0, 87);
  const regionOutput = redactPdfPass(source, reviewPages, 'regions', password, onProgress, 87, 98);
  const fallbackValidation = validateRedactedPdf(regionOutput, inputs.expectedPages, inputs.forbidden);
  if (!fallbackValidation.valid) throw new Error(fallbackValidation.errors.join(' '));
  return regionOutput;
}

export function validateRedactedPdf(
  bytes: ArrayBuffer | Uint8Array,
  expectedPages: Array<{ width: number; height: number }>,
  forbidden: Array<{ pageIndex: number; text: string; quads?: Array<{ quad: PdfQuad; text?: string }> }>,
): ValidationResult {
  const pages = extractNativePages(bytes);
  const errors: string[] = [];
  if (pages.length !== expectedPages.length) errors.push('원본과 결과의 페이지 수가 다릅니다.');
  pages.forEach((page, index) => {
    const expected = expectedPages[index];
    if (expected && (Math.abs(page.width - expected.width) > 0.5 || Math.abs(page.height - expected.height) > 0.5)) {
      errors.push(`${index + 1}쪽의 페이지 크기가 달라졌습니다.`);
    }
  });
  const pagesWithRemainingText = new Set<number>();
  for (const item of forbidden) {
    const page = pages[item.pageIndex];
    const remainingAtTarget = item.quads?.some((target) => {
      const targetRect = quadRect(target.quad);
      const targetText = target.text?.normalize('NFKC');
      return page?.words.some((word) => word.glyphs.some((glyph) => {
        // Some office PDFs use broad or overlapping glyph quads. A nearby
        // character in that geometry is not evidence that the selected
        // character survived the redaction.
        if (targetText && glyph.text.normalize('NFKC') !== targetText) return false;
        const glyphRect = quadRect(glyph.canonicalQuad);
        const centerX = (glyphRect[0] + glyphRect[2]) / 2;
        const centerY = (glyphRect[1] + glyphRect[3]) / 2;
        return centerX >= targetRect[0] && centerX <= targetRect[2] && centerY >= targetRect[1] && centerY <= targetRect[3];
      }));
    });
    const globalFallback = !item.quads?.length && item.text.trim() && page?.text.normalize('NFKC').includes(item.text.normalize('NFKC'));
    if (remainingAtTarget || globalFallback) {
      pagesWithRemainingText.add(item.pageIndex);
    }
  }
  for (const pageIndex of pagesWithRemainingText) errors.push(`${pageIndex + 1}쪽에서 삭제 대상 텍스트가 다시 추출됩니다.`);
  return { valid: errors.length === 0, pages: pages.map(({ pageIndex, width, height, text }) => ({ pageIndex, width, height, text })), errors };
}
