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
  reviewRequested?: boolean;
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
