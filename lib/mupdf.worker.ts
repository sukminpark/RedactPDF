/// <reference lib="webworker" />

import { extractNativePages, redactPdf, validateRedactedPdf } from './mupdf-engine';
import type { MuPdfRequest, MuPdfResponse } from './mupdf-types';

const cancelled = new Set<string>();
const respond = (message: MuPdfResponse, transfer: Transferable[] = []) => self.postMessage(message, { transfer });

self.onmessage = (event: MessageEvent<MuPdfRequest>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    cancelled.add(request.id);
    respond({ id: request.id, type: 'cancelled' });
    return;
  }
  try {
    if (request.type === 'extract') {
      const pages = extractNativePages(request.bytes);
      respond({ id: request.id, type: 'extracted', pages });
      return;
    }
    if (request.type === 'validate') {
      const validation = validateRedactedPdf(request.bytes, request.expectedPages, request.forbidden);
      respond({ id: request.id, type: 'validated', validation });
      return;
    }
    const bytes = redactPdf(request.bytes, request.pages, (pageIndex, progress) => {
      if (cancelled.has(request.id)) throw new Error('CANCELLED');
      respond({ id: request.id, type: 'progress', progress, pageIndex, message: `${pageIndex + 1}쪽의 선택한 글자를 지우고 있어요.` });
    });
    const validation = validateRedactedPdf(
      bytes,
      request.pages.map((page) => ({ width: page.pdfWidth, height: page.pdfHeight })),
      request.pages.flatMap((page) => page.redactions.filter((item) => item.selected && item.selectionMode === 'exact-glyphs').map((item) => ({ pageIndex: page.pageIndex, text: item.sourceText, quads: item.targetQuads.map((target) => target.quad) }))),
    );
    if (!validation.valid) throw new Error(validation.errors.join(' '));
    const output = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    respond({ id: request.id, type: 'redacted', bytes: output, validation }, [output]);
  } catch (error) {
    if (error instanceof Error && error.message === 'CANCELLED') respond({ id: request.id, type: 'cancelled' });
    else respond({ id: request.id, type: 'error', message: error instanceof Error ? error.message : 'MuPDF 처리 중 오류가 발생했습니다.' });
  } finally {
    cancelled.delete(request.id);
  }
};

export {};
