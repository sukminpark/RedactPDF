import * as mupdf from 'mupdf';
import type { Quad, Rect } from 'mupdf';

import { canvasRectToPdfRect, type NativePageText, type ValidationResult, type WorkerReviewPage } from './mupdf-types';
import { regionTargetsGlyph, unionRects, type OcrWord, type PdfQuad, type TextGlyph } from './redaction';

const TEXT_OPTIONS = 'preserve-whitespace,accurate-bboxes,accurate-side-bearings';
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

export function extractNativePages(source: ArrayBuffer | Uint8Array): NativePageText[] {
  const document = mupdf.Document.openDocument(source, 'application/pdf');
  try {
    if (document.needsPassword()) throw new Error('암호로 보호된 PDF는 처리할 수 없습니다. 암호를 해제한 사본을 사용해 주세요.');
    return Array.from({ length: document.countPages() }, (_, pageIndex) => {
      const page = document.loadPage(pageIndex) as mupdf.PDFPage;
      const structured = page.toStructuredText(TEXT_OPTIONS);
      try {
        const bounds = page.getBounds();
        const words: OcrWord[] = [];
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
          endLine: flush,
        });
        flush();
        return {
          pageIndex,
          width: bounds[2] - bounds[0],
          height: bounds[3] - bounds[1],
          rotation: (() => {
            try { return page.getObject().getInheritable('Rotate').asNumber(); } catch { return 0; }
          })(),
          words,
          text: structured.asText(),
        };
      } finally {
        structured.destroy();
        page.destroy();
      }
    });
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

function selectedTargets(page: WorkerReviewPage): { textQuads: PdfQuad[]; imageQuads: PdfQuad[] } {
  const glyphById = new Map(page.words.flatMap((word) => word.glyphs).map((glyph) => [glyph.id, glyph]));
  const textQuads: PdfQuad[] = [];
  const imageQuads: PdfQuad[] = [];
  for (const candidate of page.redactions.filter((item) => item.selected)) {
    if (candidate.selectionMode === 'exact-glyphs' && candidate.targetGlyphIds.length > 0) {
      for (const id of candidate.targetGlyphIds) {
        const glyph = glyphById.get(id);
        if (glyph?.source === 'native') textQuads.push(glyph.quad);
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
    if (candidate.kind === 'manual' || candidate.kind === 'photo' || matchingGlyphs.some((glyph) => glyph.source === 'ocr')) {
      imageQuads.push([rect[0], rect[1], rect[2], rect[1], rect[0], rect[3], rect[2], rect[3]]);
    }
  }
  return { textQuads, imageQuads };
}

function addRedactionQuads(page: mupdf.PDFPage, quads: PdfQuad[]): void {
  for (const quad of quads) {
    const annotation = page.createAnnotation('Redact');
    annotation.setQuadPoints([quad as Quad]);
    annotation.update();
  }
}

export function redactPdf(
  source: ArrayBuffer | Uint8Array,
  reviewPages: WorkerReviewPage[],
  onProgress?: (pageIndex: number, progress: number) => void,
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
      onProgress?.(pageIndex, Math.round((pageIndex / Math.max(1, document.countPages())) * 90));
      const page = document.loadPage(pageIndex) as mupdf.PDFPage;
      try {
        for (const annotation of page.getAnnotations()) page.deleteAnnotation(annotation);
        for (const link of page.getLinks()) page.deleteLink(link);
        try { page.getObject().delete('AA'); } catch { /* absent page actions */ }
        const review = reviewPages.find((candidate) => candidate.pageIndex === pageIndex);
        if (!review) continue;
        const targets = selectedTargets(review);
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

export function validateRedactedPdf(
  bytes: ArrayBuffer | Uint8Array,
  expectedPages: Array<{ width: number; height: number }>,
  forbidden: Array<{ pageIndex: number; text: string; quads?: PdfQuad[] }>,
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
  for (const item of forbidden) {
    const page = pages[item.pageIndex];
    const remainingAtTarget = item.quads?.some((target) => {
      const targetRect = quadRect(target);
      return page?.words.some((word) => word.glyphs.some((glyph) => {
        const centerX = glyph.bbox.x + glyph.bbox.width / 2;
        const centerY = glyph.bbox.y + glyph.bbox.height / 2;
        return centerX >= targetRect[0] && centerX <= targetRect[2] && centerY >= targetRect[1] && centerY <= targetRect[3];
      }));
    });
    const globalFallback = !item.quads?.length && item.text.trim() && page?.text.normalize('NFKC').includes(item.text.normalize('NFKC'));
    if (remainingAtTarget || globalFallback) {
      errors.push(`${item.pageIndex + 1}쪽에서 삭제 대상 텍스트가 다시 추출됩니다.`);
    }
  }
  return { valid: errors.length === 0, pages: pages.map(({ pageIndex, width, height, text }) => ({ pageIndex, width, height, text })), errors };
}
