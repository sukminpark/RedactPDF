'use client';

// oxlint-disable-next-line import/default -- Vite turns this query import into a Worker constructor.
import MuPdfWorker from './mupdf.worker.ts?worker';
import type { NativePageText, MuPdfRequest, MuPdfResponse, ValidationResult, WorkerReviewPage } from './mupdf-types';

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  onProgress?: (progress: number, pageIndex?: number, message?: string) => void;
}

const WORKER_INACTIVITY_TIMEOUT_MS = 45_000;

export class MuPdfWorkerClient {
  // Vinext resolves import.meta.url as a file URL at build time. Let Vite provide
  // the emitted deployment-root Worker URL instead.
  private readonly worker = new MuPdfWorker();
  private readonly pending = new Map<string, PendingRequest<unknown>>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<MuPdfResponse>) => {
      const message = event.data;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.type === 'progress') {
        pending.onProgress?.(message.progress, message.pageIndex, message.message);
        return;
      }
      this.pending.delete(message.id);
      if (message.type === 'error') pending.reject(new Error(message.message));
      else if (message.type === 'cancelled') pending.reject(new Error('CANCELLED'));
      else if (message.type === 'extracted') pending.resolve(message.pages);
      else if (message.type === 'redacted') pending.resolve({ bytes: message.bytes, validation: message.validation });
      else pending.resolve(message.validation);
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'MuPDF Worker를 시작하지 못했습니다.');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
  }

  private request<T>(request: MuPdfRequest, transfer: Transferable[], onProgress?: PendingRequest<T>['onProgress']): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      const settle = <Value>(callback: (value: Value) => void, value: Value) => {
        clearTimeout(timeout);
        callback(value);
      };
      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          if (!this.pending.delete(request.id)) return;
          reject(new Error('PDF 분석 엔진이 45초 동안 응답하지 않았습니다. 잠시 후 다시 시도하거나 다른 PDF를 사용해 주세요.'));
        }, WORKER_INACTIVITY_TIMEOUT_MS);
      };
      resetTimeout();
      this.pending.set(request.id, {
        resolve: (value) => settle(resolve as (result: unknown) => void, value),
        reject: (reason) => settle(reject, reason),
        onProgress: (progress, pageIndex, message) => {
          resetTimeout();
          onProgress?.(progress, pageIndex, message);
        },
      });
      this.worker.postMessage(request, transfer);
    });
  }

  extract(bytes: ArrayBuffer, onProgress?: PendingRequest<NativePageText[]>['onProgress']): Promise<NativePageText[]> {
    const copy = bytes.slice(0);
    return this.request({ id: crypto.randomUUID(), type: 'extract', bytes: copy }, [copy], onProgress);
  }

  redact(bytes: ArrayBuffer, pages: WorkerReviewPage[], onProgress?: PendingRequest<unknown>['onProgress']): Promise<{ bytes: ArrayBuffer; validation: ValidationResult }> {
    const copy = bytes.slice(0);
    return this.request({ id: crypto.randomUUID(), type: 'redact', bytes: copy, pages }, [copy], onProgress);
  }

  terminate(): void {
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error('CANCELLED'));
    this.pending.clear();
  }
}
