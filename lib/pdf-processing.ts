'use client';

import type { Worker } from 'tesseract.js';

import { canonicalGlyphQuad, invertAffine, quadBounds, rectQuad, transformQuad, type AffineMatrix, type PageTransform } from './pdf-geometry';
import {
  detectCandidates,
  unionRects,
  type CanvasRect,
  type OcrWord,
  type PageReviewState,
  type ProcessingStage,
} from './redaction';
import { MuPdfWorkerClient } from './mupdf-client';
import { PdfProcessingError } from './mupdf-types';
import { deploymentAssetPath } from './deployment-path';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 50;
const RENDER_SCALE = 200 / 72;

export interface ProcessingProgress {
  stage: ProcessingStage;
  progress: number;
  pageIndex?: number;
  totalPages?: number;
  message: string;
}

export class ProcessingCancelledError extends Error {
  constructor() {
    super('사용자가 처리를 취소했습니다.');
    this.name = 'ProcessingCancelledError';
  }
}

export interface AnalysisTask {
  run: Promise<PageReviewState[]>;
  cancel: () => Promise<void>;
}

async function terminateOcrWorker(worker: Worker | null): Promise<void> {
  if (!worker) return;
  await worker.terminate().catch(() => undefined);
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: 'image/jpeg' | 'image/png',
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('페이지 이미지를 만들지 못했습니다.'))),
      type,
      quality,
    );
  });
}

async function validatePdfFile(file: File): Promise<void> {
  if (file.size === 0) throw new Error('빈 파일은 처리할 수 없습니다.');
  if (file.size > MAX_FILE_BYTES) throw new Error('파일 크기는 50MB 이하여야 합니다.');
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    throw new Error('PDF 파일만 선택할 수 있습니다.');
  }
  const signature = new TextDecoder('ascii').decode(await file.slice(0, 5).arrayBuffer());
  if (signature !== '%PDF-') throw new Error('올바른 PDF 파일이 아닙니다.');
}

function flattenOcrWords(
  blocks: import('tesseract.js').Block[] | null,
  pageIndex: number,
  transform: PageTransform,
): OcrWord[] {
  if (!blocks) return [];
  const words: OcrWord[] = [];
  blocks.forEach((block, blockIndex) => {
    block.paragraphs.forEach((paragraph, paragraphIndex) => {
      paragraph.lines.forEach((line, lineIndex) => {
        line.words.forEach((word, wordIndex) => {
          const text = word.text.trim();
          if (!text) return;
          const width = Math.max(1, word.bbox.x1 - word.bbox.x0);
          const height = Math.max(1, word.bbox.y1 - word.bbox.y0);
          const characters = Array.from(text);
          const characterWidth = width / Math.max(1, characters.length);
          words.push({
            id: `${pageIndex}-${blockIndex}-${paragraphIndex}-${lineIndex}-${wordIndex}`,
            pageIndex,
            lineId: `${pageIndex}-${blockIndex}-${paragraphIndex}-${lineIndex}`,
            text,
            confidence: word.confidence,
            source: 'ocr',
            bbox: {
              x: word.bbox.x0,
              y: word.bbox.y0,
              width,
              height,
            },
            glyphs: characters.map((character, characterIndex) => {
              const x0 = word.bbox.x0 + characterWidth * characterIndex;
              const y0 = word.bbox.y0;
              const bbox = { x: x0, y: y0, width: characterWidth, height };
              const canonicalQuad = transformQuad(transform.canvasToPdf, rectQuad(bbox));
              return {
                id: `${pageIndex}-ocr-${blockIndex}-${paragraphIndex}-${lineIndex}-${wordIndex}-${characterIndex}`,
                text: character,
                source: 'ocr' as const,
                bbox,
                sourceQuad: canonicalQuad,
                canonicalQuad,
              };
            }),
          });
        });
      });
    });
  });
  return words;
}

function assignVisualLines(words: OcrWord[]): OcrWord[] {
  const rows: Array<{ centerY: number; height: number; words: OcrWord[] }> = [];
  for (const word of [...words].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)) {
    const centerY = word.bbox.y + word.bbox.height / 2;
    const row = rows.find(
      (candidate) =>
        Math.abs(candidate.centerY - centerY) <= Math.max(8, Math.min(candidate.height, word.bbox.height) * 0.75),
    );
    if (row) {
      row.words.push(word);
      row.centerY = (row.centerY * (row.words.length - 1) + centerY) / row.words.length;
      row.height = Math.max(row.height, word.bbox.height);
    } else {
      rows.push({ centerY, height: word.bbox.height, words: [word] });
    }
  }
  rows.sort((a, b) => a.centerY - b.centerY);
  rows.forEach((row, rowIndex) => {
    row.words.sort((a, b) => a.bbox.x - b.bbox.x);
    row.words.forEach((word) => {
      word.lineId = `${word.pageIndex}-native-${rowIndex}`;
    });
  });
  return words;
}

export async function extractNativeWordsForPage(
  page: import('pdfjs-dist').PDFPageProxy,
  viewport: import('pdfjs-dist').PageViewport,
  pageIndex: number,
  util: typeof import('pdfjs-dist').Util,
): Promise<OcrWord[]> {
  const content = await page.getTextContent({ disableNormalization: false });
  const words: OcrWord[] = [];
  content.items.forEach((item, itemIndex) => {
    if (!('str' in item) || !item.str.trim()) return;
    const transform = util.transform(viewport.transform, item.transform);
    const fontHeight = Math.max(4, Math.hypot(transform[2], transform[3]));
    const fullWidth = Math.max(1, item.width * viewport.scale);
    const textLength = Math.max(1, item.str.length);
    for (const match of item.str.matchAll(/\S+/g)) {
      if (match.index === undefined) continue;
      const value = match[0];
      const startRatio = match.index / textLength;
      const widthRatio = value.length / textLength;
      words.push({
        id: `${pageIndex}-native-${itemIndex}-${match.index}`,
        pageIndex,
        lineId: '',
        text: value,
        confidence: 100,
        source: 'native',
        bbox: {
          x: transform[4] + fullWidth * startRatio,
          y: transform[5] - fontHeight,
          width: Math.max(2, fullWidth * widthRatio),
          height: fontHeight,
        },
        glyphs: Array.from(value).map((character, characterIndex, characters) => {
          const width = Math.max(2, fullWidth * widthRatio) / Math.max(1, characters.length);
          const x0 = transform[4] + fullWidth * startRatio + width * characterIndex;
          const y0 = transform[5] - fontHeight;
          const bbox = { x: x0, y: y0, width, height: fontHeight };
          const canvasToPdf = invertAffine(viewport.transform as AffineMatrix);
          const canonicalQuad = transformQuad(canvasToPdf, rectQuad(bbox));
          return {
            id: `${pageIndex}-native-${itemIndex}-${match.index}-${characterIndex}`,
            text: character,
            source: 'native' as const,
            bbox,
            sourceQuad: canonicalQuad,
            canonicalQuad,
          };
        }),
      });
    }
  });
  return assignVisualLines(words);
}

function comparableText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '');
}

function overlapOnSmallerArea(left: CanvasRect, right: CanvasRect): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const smallerArea = Math.min(left.width * left.height, right.width * right.height);
  return smallerArea > 0 ? (width * height) / smallerArea : 0;
}

export function shouldRunOcr(
  nativeWords: OcrWord[],
  imageBounds: CanvasRect[],
  pageWidth: number,
  pageHeight: number,
): boolean {
  if (nativeWords.length === 0) return true;
  const pageArea = Math.max(1, pageWidth * pageHeight);
  return imageBounds.some((image) => image.width * image.height >= pageArea * 0.2);
}

export function mergeNativeAndOcrWords(nativeWords: OcrWord[], ocrWords: OcrWord[]): OcrWord[] {
  const additionalOcrWords = ocrWords.filter(
    (ocrWord) => !nativeWords.some((nativeWord) => overlapOnSmallerArea(nativeWord.bbox, ocrWord.bbox) >= 0.5),
  );
  return assignVisualLines([...nativeWords, ...additionalOcrWords]);
}

/**
 * MuPDF supplies the glyph identity and the PDF-space Quad used for deletion,
 * while PDF.js supplies the geometry that is actually painted in our preview.
 * A few office-produced PDFs report a shifted or near-zero-height MuPDF bbox;
 * retain the former, but use the latter for every on-screen interaction.
 */
export function alignNativeWordsToRenderedLayout(nativeWords: OcrWord[], renderedWords: OcrWord[]): OcrWord[] {
  return alignNativeLayout(nativeWords, renderedWords).words;
}

export function alignNativeLayout(
  nativeWords: OcrWord[],
  renderedWords: OcrWord[],
  transform?: Pick<PageTransform, 'pdfToCanvas' | 'canvasToPdf'>,
): { words: OcrWord[]; offset: CanvasRect } {
  const nativeByText = new Map<string, OcrWord[]>();
  const renderedByText = new Map<string, Array<{ word: OcrWord; index: number }>>();
  nativeWords.forEach((word) => {
    const text = comparableText(word.text);
    if (text) nativeByText.set(text, [...(nativeByText.get(text) ?? []), word]);
  });
  renderedWords.forEach((word, index) => {
    const text = comparableText(word.text);
    if (text) renderedByText.set(text, [...(renderedByText.get(text) ?? []), { word, index }]);
  });

  const offset: CanvasRect = { x: 0, y: 0, width: 0, height: 0 };
  const matchesByNativeId = new Map<string, OcrWord>();
  nativeByText.forEach((nativeMatches, text) => {
    const renderedMatches = renderedByText.get(text);
    if (!renderedMatches) return;
    const visualOrder = (left: OcrWord, right: OcrWord) => left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x;
    const orderedNative = [...nativeMatches].sort(visualOrder);
    const orderedRendered = renderedMatches.map(({ word }) => word).sort(visualOrder);
    orderedNative.slice(0, orderedRendered.length).forEach((word, index) => matchesByNativeId.set(word.id, orderedRendered[index]));
  });

  const words = nativeWords.map((nativeWord) => {
    const renderedWord = matchesByNativeId.get(nativeWord.id);
    if (!renderedWord) return nativeWord;
    const glyphs = nativeWord.glyphs.map((glyph, glyphIndex) => {
      const renderedGlyph = renderedWord.glyphs[glyphIndex];
      if (renderedGlyph && comparableText(renderedGlyph.text) === comparableText(glyph.text)) {
        const canonicalQuad = transform
          ? canonicalGlyphQuad(glyph.canonicalQuad, renderedGlyph.bbox, transform)
          : glyph.canonicalQuad;
        return {
          ...glyph,
          canonicalQuad,
          bbox: transform ? quadBounds(transformQuad(transform.pdfToCanvas, canonicalQuad)) : { ...renderedGlyph.bbox },
        };
      }
      return glyph;
    });

    return {
      ...nativeWord,
      lineId: renderedWord.lineId,
      bbox: unionRects(glyphs.map((glyph) => glyph.bbox)),
      glyphs,
    };
  });

  return { words, offset };
}

export function startPdfAnalysis(
  file: File,
  enteredNames: string[],
  onProgress: (progress: ProcessingProgress) => void,
  password?: string,
): AnalysisTask {
  let cancelled = false;
  let worker: Worker | null = null;
  let mupdfClient: MuPdfWorkerClient | null = null;
  const createdUrls: string[] = [];
  let reportedProgress = 0;

  // MuPDF extraction ends before PDF.js preview rendering begins. Keep the
  // user-visible gauge forward-only across those independent worker stages.
  const reportProgress = (progress: ProcessingProgress) => {
    reportedProgress = Math.max(reportedProgress, progress.progress);
    onProgress({ ...progress, progress: reportedProgress });
  };

  const ensureActive = () => {
    if (cancelled) throw new ProcessingCancelledError();
  };

  const run = (async () => {
    await validatePdfFile(file);
    reportProgress({ stage: 'loading', progress: 1, message: 'PDF 구조를 확인하고 있어요.' });

    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = deploymentAssetPath('pdf.worker.min.mjs');
    const sourceBytes = await file.arrayBuffer();
    mupdfClient = new MuPdfWorkerClient();
    const nativePages = await mupdfClient.extract(sourceBytes, password, (progress, pageIndex, message) => {
      reportProgress({ stage: 'loading', progress, pageIndex, message: message ?? 'PDF 구조를 확인하고 있어요.' });
    });
    const bytes = new Uint8Array(sourceBytes.slice(0));
    ensureActive();

    let documentProxy: import('pdfjs-dist').PDFDocumentProxy | null = null;
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;
    try {
      loadingTask = pdfjs.getDocument({
        data: bytes,
        password,
        stopAtErrors: true,
      });
      documentProxy = await loadingTask.promise;

      if (documentProxy.numPages > MAX_PAGES) {
        throw new Error(`PDF는 최대 ${MAX_PAGES}쪽까지 처리할 수 있습니다.`);
      }

      const totalPages = documentProxy.numPages;
      let activePage = 0;

      const ensureOcrWorker = async () => {
        if (worker) return worker;
        const { createWorker, OEM } = await import('tesseract.js');
        worker = await createWorker(['kor', 'eng'], OEM.LSTM_ONLY, {
          workerPath: deploymentAssetPath('tesseract/worker.min.js'),
          corePath: deploymentAssetPath('tesseract/core'),
          langPath: '/tessdata',
          gzip: true,
          logger: (status) => {
            if (status.status !== 'recognizing text') return;
            const pageProgress = typeof status.progress === 'number' ? status.progress : 0;
            reportProgress({
              stage: 'ocr',
              progress: Math.round(((activePage + pageProgress) / totalPages) * 100),
              pageIndex: activePage,
              totalPages,
              message: `${activePage + 1}쪽의 개인정보를 찾고 있어요.`,
            });
          },
        });
        return worker;
      };

      const pages: PageReviewState[] = [];
      for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
        ensureActive();
        activePage = pageNumber - 1;
        reportProgress({
          stage: 'rendering',
          progress: Math.round((activePage / totalPages) * 100),
          pageIndex: activePage,
          totalPages,
        message: `${pageNumber}쪽의 원본 구조와 미리보기를 준비하고 있어요.`,
        });

        const page = await documentProxy.getPage(pageNumber);
        const pdfViewport = page.getViewport({ scale: 1 });
        const renderViewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(renderViewport.width);
        canvas.height = Math.ceil(renderViewport.height);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('이 브라우저에서는 PDF 페이지를 그릴 수 없습니다.');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: context, viewport: renderViewport }).promise;
        ensureActive();

        const nativePage = nativePages[activePage];
        const transform: PageTransform = {
          pdfToCanvas: renderViewport.transform as AffineMatrix,
          canvasToPdf: invertAffine(renderViewport.transform as AffineMatrix),
          rotation: renderViewport.rotation,
          cropBox: [...pdfViewport.viewBox] as [number, number, number, number],
        };
        const nativeWordsWithFallbackGeometry = (nativePage?.words ?? []).map((word) => ({
          ...word,
          glyphs: word.glyphs.map((glyph) => {
            const bbox = quadBounds(transformQuad(transform.pdfToCanvas, glyph.canonicalQuad));
            return { ...glyph, bbox };
          }),
        }));
        nativeWordsWithFallbackGeometry.forEach((word) => { word.bbox = unionRects(word.glyphs.map((glyph) => glyph.bbox)); });
        const renderedNativeWords = await extractNativeWordsForPage(page, renderViewport, activePage, pdfjs.Util);
        const nativeLayout = alignNativeLayout(nativeWordsWithFallbackGeometry, renderedNativeWords, transform);
        const nativeWords = nativeLayout.words;
        const nativeImageBounds = (nativePage?.imageBounds ?? []).map((image) => ({
          ...quadBounds(transformQuad(transform.pdfToCanvas, transformQuad(nativePage.pageToPdf, rectQuad(image)))),
        }));
        let words: OcrWord[];
        if (!shouldRunOcr(nativeWords, nativeImageBounds, canvas.width, canvas.height)) {
          words = nativeWords;
          reportProgress({
            stage: 'ocr',
            progress: Math.round(((activePage + 0.92) / totalPages) * 100),
            pageIndex: activePage,
            totalPages,
            message: `${pageNumber}쪽의 문서 항목을 확인하고 있어요.`,
          });
        } else {
          const ocrWorker = await ensureOcrWorker();
          const recognition = await ocrWorker.recognize(
            canvas,
            { rotateAuto: true },
            { text: true, blocks: true },
          );
          ensureActive();
          const ocrWords = flattenOcrWords(
            recognition.data.blocks,
            activePage,
            transform,
          );
          words = mergeNativeAndOcrWords(nativeWords, ocrWords);
        }
        const imageBlob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
        const imageUrl = URL.createObjectURL(imageBlob);
        createdUrls.push(imageUrl);

        pages.push({
          pageIndex: activePage,
          pageCount: totalPages,
          pdfWidth: pdfViewport.width,
          pdfHeight: pdfViewport.height,
          renderWidth: canvas.width,
          renderHeight: canvas.height,
          transform,
          imageUrl,
          imageType: 'image/jpeg',
          words,
          redactions: detectCandidates(words, enteredNames, {
            pageWidth: canvas.width,
            pageHeight: canvas.height,
            pageCount: totalPages,
            imageBounds: nativeImageBounds,
          }),
          reviewed: false,
        });
        canvas.width = 1;
        canvas.height = 1;
        page.cleanup();
      }

      reportProgress({
        stage: 'review',
        progress: 100,
        totalPages,
        message: '탐지가 끝났어요. 각 페이지를 확인해 주세요.',
      });
      return pages;
    } catch (error) {
      if (cancelled) throw new ProcessingCancelledError();
      const name = error instanceof Error ? error.name : '';
      if (name === 'PasswordException') {
        const code = typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : 1;
        throw new PdfProcessingError(
          code === 2 ? 'incorrect-password' : 'password-required',
          code === 2 ? '비밀번호가 올바르지 않습니다.' : 'PDF 비밀번호를 입력해 주세요.',
        );
      }
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
      throw error;
    } finally {
      await terminateOcrWorker(worker);
      worker = null;
      mupdfClient?.terminate();
      mupdfClient = null;
      await loadingTask?.destroy().catch(() => undefined);
    }
  })();

  return {
    run,
    cancel: async () => {
      cancelled = true;
      await terminateOcrWorker(worker);
      worker = null;
      mupdfClient?.terminate();
      mupdfClient = null;
    },
  };
}

export async function exportRedactedPdf(
  sourceBytes: ArrayBuffer,
  pages: PageReviewState[],
  onProgress: (progress: ProcessingProgress) => void,
  password?: string,
): Promise<Uint8Array> {
  const client = new MuPdfWorkerClient();
  let lastProgress = 0;
  try {
    const result = await client.redact(sourceBytes, pages, password, (progress, pageIndex, message) => {
      lastProgress = Math.max(lastProgress, progress);
      onProgress({ stage: 'exporting', progress: lastProgress, pageIndex, totalPages: pages.length, message: message ?? '선택한 글자를 지우고 있어요.' });
    });
    onProgress({ stage: 'complete', progress: 100, totalPages: pages.length, message: '빈자리로 영구 삭제된 PDF가 준비됐어요.' });
    return new Uint8Array(result.bytes);
  } finally {
    client.terminate();
  }
}
