'use client';

import type { Worker } from 'tesseract.js';

import {
  detectCandidates,
  type OcrWord,
  type PageReviewState,
  type ProcessingStage,
} from './redaction';
import { MuPdfWorkerClient } from './mupdf-client';

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
  renderWidth: number,
  renderHeight: number,
  pdfWidth: number,
  pdfHeight: number,
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
              const x1 = x0 + characterWidth;
              const y0 = word.bbox.y0;
              const y1 = word.bbox.y1;
              return {
                id: `${pageIndex}-ocr-${blockIndex}-${paragraphIndex}-${lineIndex}-${wordIndex}-${characterIndex}`,
                text: character,
                source: 'ocr' as const,
                bbox: { x: x0, y: y0, width: characterWidth, height },
                quad: [
                  (x0 / renderWidth) * pdfWidth,
                  (y0 / renderHeight) * pdfHeight,
                  (x1 / renderWidth) * pdfWidth,
                  (y0 / renderHeight) * pdfHeight,
                  (x0 / renderWidth) * pdfWidth,
                  (y1 / renderHeight) * pdfHeight,
                  (x1 / renderWidth) * pdfWidth,
                  (y1 / renderHeight) * pdfHeight,
                ],
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
          const x1 = x0 + width;
          const y0 = transform[5] - fontHeight;
          const y1 = transform[5];
          const toPdfX = (x: number) => (x / viewport.width) * (viewport.width / viewport.scale);
          const toPdfY = (y: number) => (y / viewport.height) * (viewport.height / viewport.scale);
          return {
            id: `${pageIndex}-native-${itemIndex}-${match.index}-${characterIndex}`,
            text: character,
            source: 'native' as const,
            bbox: { x: x0, y: y0, width, height: fontHeight },
            quad: [toPdfX(x0), toPdfY(y0), toPdfX(x1), toPdfY(y0), toPdfX(x0), toPdfY(y1), toPdfX(x1), toPdfY(y1)],
          };
        }),
      });
    }
  });
  return assignVisualLines(words);
}

export function startPdfAnalysis(
  file: File,
  enteredNames: string[],
  onProgress: (progress: ProcessingProgress) => void,
): AnalysisTask {
  let cancelled = false;
  let worker: Worker | null = null;
  let mupdfClient: MuPdfWorkerClient | null = null;
  const createdUrls: string[] = [];

  const ensureActive = () => {
    if (cancelled) throw new ProcessingCancelledError();
  };

  const run = (async () => {
    await validatePdfFile(file);
    onProgress({ stage: 'loading', progress: 1, message: 'PDF 구조를 확인하고 있어요.' });

    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    const sourceBytes = await file.arrayBuffer();
    mupdfClient = new MuPdfWorkerClient();
    const nativePages = await mupdfClient.extract(sourceBytes, (progress, pageIndex, message) => {
      onProgress({ stage: 'loading', progress, pageIndex, message: message ?? 'PDF 구조를 확인하고 있어요.' });
    });
    const bytes = new Uint8Array(sourceBytes.slice(0));
    ensureActive();

    let documentProxy: import('pdfjs-dist').PDFDocumentProxy | null = null;
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;
    try {
      loadingTask = pdfjs.getDocument({
        data: bytes,
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
          workerPath: '/tesseract/worker.min.js',
          corePath: '/tesseract/core',
          langPath: '/tessdata',
          gzip: true,
          logger: (status) => {
            if (status.status !== 'recognizing text') return;
            const pageProgress = typeof status.progress === 'number' ? status.progress : 0;
            onProgress({
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
        onProgress({
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
        const scaleX = canvas.width / Math.max(1, nativePage?.width ?? pdfViewport.width);
        const scaleY = canvas.height / Math.max(1, nativePage?.height ?? pdfViewport.height);
        const nativeWords = (nativePage?.words ?? []).map((word) => ({
          ...word,
          bbox: {
            x: word.bbox.x * scaleX,
            y: word.bbox.y * scaleY,
            width: word.bbox.width * scaleX,
            height: word.bbox.height * scaleY,
          },
          glyphs: word.glyphs.map((glyph) => ({
            ...glyph,
            bbox: {
              x: glyph.bbox.x * scaleX,
              y: glyph.bbox.y * scaleY,
              width: glyph.bbox.width * scaleX,
              height: glyph.bbox.height * scaleY,
            },
          })),
        }));
        const nativeCharacterCount = nativeWords.reduce((count, word) => count + word.text.length, 0);
        let words: OcrWord[];
        if (nativeWords.length >= 8 && nativeCharacterCount >= 30) {
          words = nativeWords;
          onProgress({
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
          words = flattenOcrWords(
            recognition.data.blocks,
            activePage,
            canvas.width,
            canvas.height,
            pdfViewport.width,
            pdfViewport.height,
          );
        }
        const imageBlob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
        const imageUrl = URL.createObjectURL(imageBlob);
        createdUrls.push(imageUrl);

        pages.push({
          pageIndex: activePage,
          pdfWidth: pdfViewport.width,
          pdfHeight: pdfViewport.height,
          renderWidth: canvas.width,
          renderHeight: canvas.height,
          imageUrl,
          imageType: 'image/jpeg',
          words,
          redactions: detectCandidates(words, enteredNames, {
            pageWidth: canvas.width,
            pageHeight: canvas.height,
          }),
          reviewed: false,
        });
        canvas.width = 1;
        canvas.height = 1;
        page.cleanup();
      }

      onProgress({
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
        throw new Error('암호로 보호된 PDF는 처리할 수 없습니다. 암호를 해제한 사본을 사용해 주세요.');
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
): Promise<Uint8Array> {
  const client = new MuPdfWorkerClient();
  try {
    const result = await client.redact(sourceBytes, pages, (progress, pageIndex, message) => {
      onProgress({ stage: 'exporting', progress, pageIndex, totalPages: pages.length, message: message ?? '선택한 글자를 지우고 있어요.' });
    });
    onProgress({ stage: 'complete', progress: 100, totalPages: pages.length, message: '빈자리로 영구 삭제된 PDF가 준비됐어요.' });
    return new Uint8Array(result.bytes);
  } finally {
    client.terminate();
  }
}
