import * as mupdf from 'mupdf';
import type { Quad, Rect } from 'mupdf';

import { canvasRectToPdfRect, type NativePageText, type ValidationResult, type WorkerReviewPage } from './mupdf-types';
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
): NativePageText[] {
  const document = mupdf.Document.openDocument(source, 'application/pdf');
  try {
    if (document.needsPassword()) throw new Error('암호로 보호된 PDF는 처리할 수 없습니다. 암호를 해제한 사본을 사용해 주세요.');
    const totalPages = document.countPages();
    const pages: NativePageText[] = [];
    for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
      onPageStart?.(pageIndex, totalPages);
      const page = document.loadPage(pageIndex) as mupdf.PDFPage;
      const structured = page.toStructuredText(TEXT_OPTIONS);
      try {
        const bounds = page.getBounds();
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
              quad,
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

function rectQuad([x0, y0, x1, y1]: [number, number, number, number]): PdfQuad {
  return [x0, y0, x1, y0, x0, y1, x1, y1];
}

function exactGlyphQuad(glyph: TextGlyph, candidate: WorkerReviewPage['redactions'][number], page: WorkerReviewPage): PdfQuad {
  const renderScaleY = page.renderHeight / Math.max(1, page.pdfHeight);
  // Some NICE exports expose a valid horizontal Quad but a nearly zero-height
  // vertical Quad. Keep the glyph's exact horizontal span, then derive only
  // the missing vertical extent from the reviewed on-screen candidate.
  if (glyph.bbox.height >= renderScaleY * 2) return glyph.quad;
  const height = Math.min(candidate.height, Math.max(glyph.bbox.height, renderScaleY * 10));
  const centerY = Math.min(
    candidate.y + candidate.height - height / 2,
    Math.max(candidate.y + height / 2, glyph.bbox.y + glyph.bbox.height / 2),
  );
  return rectQuad(canvasRectToPdfRect({
    x: glyph.bbox.x,
    y: centerY - height / 2,
    width: glyph.bbox.width,
    height,
  }, page));
}

function selectedTargets(
  page: WorkerReviewPage,
  targetMode: RedactionTargetMode,
): { textQuads: PdfQuad[]; imageQuads: PdfQuad[] } {
  const glyphById = new Map(page.words.flatMap((word) => word.glyphs).map((glyph) => [glyph.id, glyph]));
  const textQuads: PdfQuad[] = [];
  const imageQuads: PdfQuad[] = [];
  for (const candidate of page.redactions.filter((item) => item.selected)) {
    if (targetMode === 'exact-glyphs' && candidate.selectionMode === 'exact-glyphs' && candidate.targetGlyphIds.length > 0) {
      for (const id of candidate.targetGlyphIds) {
        const glyph = glyphById.get(id);
        if (glyph?.source === 'native') textQuads.push(exactGlyphQuad(glyph, candidate, page));
        if (glyph?.source === 'ocr') imageQuads.push(glyph.quad);
      }
      continue;
    }
    const matchingGlyphs = page.words
      .flatMap((word) => word.glyphs)
      .filter((glyph) => regionTargetsGlyph(candidate, glyph.bbox));
    for (const glyph of matchingGlyphs) {
      if (glyph.source === 'native') textQuads.push(glyph.quad);
    }
    const rect = canvasRectToPdfRect(candidate, page);
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
      textQuads.push(rectQuad(canvasRectToPdfRect(nativeBounds, page)));
    }
    if (candidate.kind === 'manual' || candidate.kind === 'photo' || matchingGlyphs.some((glyph) => glyph.source === 'ocr')) {
      imageQuads.push(rectQuad(rect));
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
  onProgress?: (pageIndex: number, progress: number) => void,
  progressStart = 0,
  progressEnd = 90,
): Uint8Array {
  const opened = mupdf.Document.openDocument(source, 'application/pdf');
  const document = opened.asPDF();
  if (!document) {
    opened.destroy();
    throw new Error('PDF 문서를 열지 못했습니다.');
  }
  try {
    if (document.needsPassword()) throw new Error('암호로 보호된 PDF는 저장할 수 없습니다.');
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
        const targets = selectedTargets(review, targetMode);
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

function validationInputs(reviewPages: WorkerReviewPage[]) {
  return {
    expectedPages: reviewPages.map((page) => ({ width: page.pdfWidth, height: page.pdfHeight })),
    forbidden: reviewPages.flatMap((page) =>
      page.redactions
        .filter((item) => item.selected && item.selectionMode === 'exact-glyphs')
        .map((item) => ({
          pageIndex: page.pageIndex,
          text: item.sourceText,
          quads: item.targetQuads,
        })),
    ),
  };
}

export function redactPdf(
  source: ArrayBuffer | Uint8Array,
  reviewPages: WorkerReviewPage[],
  onProgress?: (pageIndex: number, progress: number) => void,
): Uint8Array {
  const inputs = validationInputs(reviewPages);
  const exactOutput = redactPdfPass(source, reviewPages, 'exact-glyphs', onProgress, 3, 85);
  if (validateRedactedPdf(exactOutput, inputs.expectedPages, inputs.forbidden).valid) return exactOutput;

  onProgress?.(0, 87);
  const regionOutput = redactPdfPass(source, reviewPages, 'regions', onProgress, 87, 98);
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
        const centerX = glyph.bbox.x + glyph.bbox.width / 2;
        const centerY = glyph.bbox.y + glyph.bbox.height / 2;
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
