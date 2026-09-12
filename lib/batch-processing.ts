import { strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';

import { sanitizeDownloadName } from './redaction';

export const MAX_BATCH_FILES = 10;

export type BatchMode = 'review' | 'automatic';

export type BatchItemStatus =
  | 'queued'
  | 'analyzing'
  | 'awaiting-password'
  | 'reviewing'
  | 'exporting'
  | 'complete'
  | 'needs-review'
  | 'error'
  | 'skipped';

export interface BatchItem {
  id: string;
  file: File;
  status: BatchItemStatus;
  progress: number;
  message: string;
  error?: string;
  output?: Blob;
  outputName?: string;
  reviewRequested?: boolean;
}

export interface BatchArchiveEntry {
  originalName: string;
  status: BatchItemStatus;
  output?: Blob;
  error?: string;
}

const terminalStatuses = new Set<BatchItemStatus>([
  'complete',
  'needs-review',
  'error',
  'skipped',
]);

const statusLabels: Record<BatchItemStatus, string> = {
  queued: '대기',
  analyzing: '분석 중',
  'awaiting-password': '비밀번호 대기',
  reviewing: '검토 중',
  exporting: 'PDF 생성 중',
  complete: '완료',
  'needs-review': '검토 필요',
  error: '오류',
  skipped: '건너뜀',
};

export function batchStatusLabel(status: BatchItemStatus): string {
  return statusLabels[status];
}

export function isPdfFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
}

export function validateBatchSelection(files: File[]): string | null {
  if (files.length > MAX_BATCH_FILES) {
    return `PDF는 한 번에 최대 ${MAX_BATCH_FILES}개까지 선택할 수 있습니다.`;
  }
  if (files.some((file) => !isPdfFile(file))) {
    return 'PDF 파일만 선택할 수 있습니다.';
  }
  return null;
}

export function createBatchItems(files: File[]): BatchItem[] {
  return files.map((file) => ({
    id: crypto.randomUUID(),
    file,
    status: 'queued',
    progress: 0,
    message: '처리 대기 중',
  }));
}

export function nextQueuedItem(items: BatchItem[]): BatchItem | undefined {
  return items.find((item) => item.status === 'queued');
}

export function isTerminalBatchStatus(status: BatchItemStatus): boolean {
  return terminalStatuses.has(status);
}

export function batchOverallProgress(items: BatchItem[]): number {
  if (items.length === 0) return 0;
  const total = items.reduce((sum, item) => {
    if (isTerminalBatchStatus(item.status)) return sum + 100;
    if (item.status === 'reviewing' || item.status === 'awaiting-password') return sum;
    return sum + item.progress;
  }, 0);
  return Math.round(total / items.length);
}

export function uniqueOutputName(originalName: string, usedNames: Set<string>): string {
  const preferred = sanitizeDownloadName(originalName);
  const stem = preferred.replace(/\.pdf$/iu, '');
  let candidate = preferred;
  let suffix = 2;
  while (usedNames.has(candidate.toLocaleLowerCase())) {
    candidate = `${stem}_${suffix}.pdf`;
    suffix += 1;
  }
  usedNames.add(candidate.toLocaleLowerCase());
  return candidate;
}

export function batchArchiveName(now = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `가림PDF_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

export function buildBatchReport(entries: BatchArchiveEntry[]): string {
  const lines = [
    '가림PDF 일괄처리 결과',
    `생성 시각: ${new Date().toLocaleString('ko-KR')}`,
    '',
  ];
  entries.forEach((entry, index) => {
    const detail = entry.error ? ` - ${entry.error}` : '';
    lines.push(`${index + 1}. ${entry.originalName}: ${statusLabels[entry.status]}${detail}`);
  });
  return `${lines.join('\n')}\n`;
}

async function pushBlob(stream: ZipPassThrough, blob: Blob): Promise<void> {
  const reader = blob.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stream.push(value, false);
    }
    stream.push(new Uint8Array(0), true);
  } finally {
    reader.releaseLock();
  }
}

export async function createBatchArchive(entries: BatchArchiveEntry[]): Promise<Blob> {
  const successful = entries.filter(
    (entry): entry is BatchArchiveEntry & { output: Blob } =>
      entry.status === 'complete' && entry.output instanceof Blob,
  );
  if (successful.length === 0) {
    throw new Error('저장할 수 있는 완료 파일이 없습니다.');
  }

  return new Promise<Blob>((resolve, reject) => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error('ZIP 파일을 만들지 못했습니다.'));
    };
    const archive = new Zip((error, data, final) => {
      if (error) {
        fail(error);
        return;
      }
      chunks.push(data);
      if (final && !settled) {
        settled = true;
        resolve(new Blob(chunks, { type: 'application/zip' }));
      }
    });

    void (async () => {
      try {
        const usedNames = new Set<string>();
        for (const entry of successful) {
          const filename = uniqueOutputName(entry.originalName, usedNames);
          const stream = new ZipPassThrough(filename);
          archive.add(stream);
          await pushBlob(stream, entry.output);
        }

        const report = new ZipDeflate('처리결과.txt', { level: 6 });
        archive.add(report);
        report.push(strToU8(`\uFEFF${buildBatchReport(entries)}`), true);
        archive.end();
      } catch (error) {
        archive.terminate();
        fail(error);
      }
    })();
  });
}
