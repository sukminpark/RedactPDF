import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';

import {
  batchArchiveName,
  batchOverallProgress,
  buildBatchReport,
  createBatchArchive,
  nextQueuedItem,
  uniqueOutputName,
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

  it('deduplicates sanitized output names case-insensitively', () => {
    const used = new Set<string>();
    expect(uniqueOutputName('학생.pdf', used)).toBe('학생_비식별화.pdf');
    expect(uniqueOutputName('학생.PDF', used)).toBe('학생_비식별화_2.pdf');
  });

  it('formats the archive name with local date and time', () => {
    expect(batchArchiveName(new Date(2026, 8, 12, 9, 5))).toBe('가림PDF_20260912-0905.zip');
  });

  it('builds a report for success, review, error, and skipped states', () => {
    const report = buildBatchReport([
      { originalName: '완료.pdf', status: 'complete' },
      { originalName: '확인.pdf', status: 'needs-review' },
      { originalName: '오류.pdf', status: 'error', error: '손상된 PDF' },
      { originalName: '암호.pdf', status: 'skipped', error: '사용자가 건너뜀' },
    ]);
    expect(report).toContain('완료.pdf: 완료');
    expect(report).toContain('확인.pdf: 검토 필요');
    expect(report).toContain('오류.pdf: 오류 - 손상된 PDF');
    expect(report).toContain('암호.pdf: 건너뜀 - 사용자가 건너뜀');
  });
});

describe('batch ZIP creation', () => {
  it('stores successful PDFs without compression and includes a UTF-8 report', async () => {
    const archive = await createBatchArchive([
      { originalName: '학생.pdf', status: 'complete', output: new Blob(['first'], { type: 'application/pdf' }) },
      { originalName: '학생.PDF', status: 'complete', output: new Blob(['second'], { type: 'application/pdf' }) },
      { originalName: '검토.pdf', status: 'needs-review' },
    ]);
    const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(strFromU8(files['학생_비식별화.pdf'])).toBe('first');
    expect(strFromU8(files['학생_비식별화_2.pdf'])).toBe('second');
    expect(strFromU8(files['처리결과.txt']).replace(/^\uFEFF/u, '')).toContain('검토.pdf: 검토 필요');
  });

  it('rejects an archive with no completed output', async () => {
    await expect(createBatchArchive([{ originalName: '검토.pdf', status: 'needs-review' }])).rejects.toThrow('완료 파일');
  });
});
