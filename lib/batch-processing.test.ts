import { describe, expect, it } from 'vitest';

import {
  batchOverallProgress,
  nextQueuedItem,
  validateBatchSelection,
  type BatchItem,
} from './batch-processing';

function pdfFile(name: string, content = '%PDF-test'): File {
  return new File([content], name, { type: 'application/pdf' });
}

function item(overrides: Partial<BatchItem>): BatchItem {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    file: overrides.file ?? pdfFile('문서.pdf'),
    status: overrides.status ?? 'queued',
    progress: overrides.progress ?? 0,
    message: overrides.message ?? '',
    ...overrides,
  };
}

describe('batch queue helpers', () => {
  it('rejects more than ten files and non-PDF selections', () => {
    expect(validateBatchSelection(Array.from({ length: 11 }, (_, index) => pdfFile(`${index}.pdf`)))).toContain('10개');
    expect(validateBatchSelection([new File(['text'], 'notes.txt', { type: 'text/plain' })])).toContain('PDF');
    expect(validateBatchSelection([pdfFile('one.pdf'), pdfFile('two.pdf')])).toBeNull();
  });

  it('finds the next queued item and computes aggregate progress', () => {
    const items = [
      item({ status: 'complete', progress: 100 }),
      item({ status: 'analyzing', progress: 50 }),
      item({ status: 'queued' }),
    ];
    expect(nextQueuedItem(items)).toBe(items[2]);
    expect(batchOverallProgress(items)).toBe(50);
  });

});
