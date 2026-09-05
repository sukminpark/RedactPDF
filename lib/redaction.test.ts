import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import {
  detectCandidates,
  rectsOverlap,
  sanitizeDownloadName,
  validateEnteredNames,
  type OcrWord,
} from './redaction';
import { extractNativeWordsForPage } from './pdf-processing';

function wordsFromLine(texts: string[], pageIndex = 0): OcrWord[] {
  let x = 10;
  return texts.map((text, index) => {
    const width = Math.max(20, text.length * 12);
    const word: OcrWord = {
      id: `${pageIndex}-0-${index}`,
      pageIndex,
      lineId: `${pageIndex}-0`,
      text,
      confidence: 94,
      bbox: { x, y: 20, width, height: 18 },
      source: 'native',
      glyphs: Array.from(text).map((character, characterIndex, characters) => ({
        id: `${pageIndex}-0-${index}-${characterIndex}`,
        text: character,
        source: 'native' as const,
        bbox: { x: x + (width / characters.length) * characterIndex, y: 20, width: width / characters.length, height: 18 },
        quad: [
          x + (width / characters.length) * characterIndex,
          20,
          x + (width / characters.length) * (characterIndex + 1),
          20,
          x + (width / characters.length) * characterIndex,
          38,
          x + (width / characters.length) * (characterIndex + 1),
          38,
        ],
      })),
    };
    x += width + 8;
    return word;
  });
}

describe('detectCandidates', () => {
  it.each([
    [['900101-1234567'], '900101-1234567'],
    [['900101', '-', '1234567'], '900101-1234567'],
    [['9001011234567'], '9001011234567'],
    [['900101-1******'], '900101-1******'],
  ])('finds resident IDs split across OCR words', (tokens, expected) => {
    const result = detectCandidates(wordsFromLine(tokens), []);
    expect(result.some((item) => item.kind === 'resident-id' && item.sourceText === expected)).toBe(true);
  });

  it('rejects date-like values with an invalid month', () => {
    const result = detectCandidates(wordsFromLine(['901301-1234567']), []);
    expect(result.some((item) => item.kind === 'resident-id')).toBe(false);
  });

  it('does not join dates, times, and page numbers into a resident ID', () => {
    const result = detectCandidates(
      wordsFromLine(['2026.09.02', '14:10', '19', '11', '6']),
      [],
    );
    expect(result.some((item) => item.kind === 'resident-id')).toBe(false);
  });

  it('finds an explicitly entered name across adjacent OCR words', () => {
    const result = detectCandidates(wordsFromLine(['홍', '길동']), ['홍길동']);
    expect(result.some((item) => item.kind === 'entered-name')).toBe(true);
  });

  it('finds a Korean name next to a known field label', () => {
    const result = detectCandidates(wordsFromLine(['성명', '김하늘']), []);
    expect(result.some((item) => item.kind === 'student-name' && item.sourceText === '김하늘')).toBe(true);
  });

  it('finds school name, class, and student number fields', () => {
    const result = detectCandidates(
      wordsFromLine(['학교명', '새봄고등학교', '학급', '3', '번호', '12']),
      [],
      { pageWidth: 900, pageHeight: 1200 },
    );
    expect(result.some((item) => item.kind === 'school-name' && item.sourceText === '새봄고등학교')).toBe(true);
    expect(result.some((item) => item.kind === 'class' && item.sourceText === '3')).toBe(true);
    expect(result.some((item) => item.kind === 'student-number' && item.sourceText === '12')).toBe(true);
  });

  it('uses the embedded portrait bounds instead of a template position guess', () => {
    const imageBounds = { x: 760, y: 290, width: 145, height: 190 };
    const result = detectCandidates(wordsFromLine(['학교생활기록부']), [], {
      pageWidth: 1000,
      pageHeight: 1400,
      imageBounds: [imageBounds],
    });
    expect(result.find((item) => item.kind === 'photo')).toMatchObject({
      ...imageBounds,
      reason: 'PDF에 포함된 학생 사진 영역',
    });
  });
});

const samplePath = resolve('sample', '4세대 나이스 시스템.pdf');
const describeWithSample = existsSync(samplePath) ? describe : describe.skip;

describeWithSample('4세대 나이스 학교생활기록부 sample', () => {
  it('finds school-record identifiers without treating dates as resident IDs', async () => {
    const documentTask = pdfjs.getDocument({ data: new Uint8Array(readFileSync(samplePath)) });
    const document = await documentTask.promise;
    expect(document.numPages).toBe(19);

    const firstPage = await document.getPage(1);
    const viewport = firstPage.getViewport({ scale: 200 / 72 });
    const words = await extractNativeWordsForPage(firstPage, viewport, 0, pdfjs.Util);
    const candidates = detectCandidates(words, [], {
      pageWidth: viewport.width,
      pageHeight: viewport.height,
    });

    const residentIds = candidates.filter((item) => item.kind === 'resident-id');
    expect(residentIds).toHaveLength(1);
    expect(residentIds[0].sourceText).toMatch(/^\d{6}-[1-8]\d{6}$/);
    expect(candidates.filter((item) => item.kind === 'homeroom-teacher')).toHaveLength(3);
    const outputter = candidates.find((item) => item.kind === 'outputter');
    expect(outputter).toBeDefined();
    const outputterWord = words.find(
      (word) => word.bbox.y > viewport.height * 0.88 && outputter && word.text.includes(outputter.sourceText),
    );
    if (outputter && outputterWord) {
      const start = outputterWord.text.lastIndexOf(outputter.sourceText);
      const characterWidth = outputterWord.bbox.width / outputterWord.text.length;
      const nameX = outputterWord.bbox.x + characterWidth * start;
      expect(outputter.x).toBeLessThan(nameX);
      expect(outputter.x + outputter.width).toBeGreaterThan(nameX + characterWidth * outputter.sourceText.length);
    }
    const studentName = candidates.find((item) => item.kind === 'student-name');
    expect(studentName).toBeDefined();
    const address = candidates.find((item) => item.kind === 'address');
    expect(address).toBeDefined();
    expect(address?.height).toBeGreaterThan(60);
    expect(candidates.some((item) => item.kind === 'photo')).toBe(true);
    expect(candidates.some((item) => item.kind === 'school-name')).toBe(true);
    expect(candidates.some((item) => item.kind === 'class')).toBe(true);
    expect(candidates.some((item) => item.kind === 'student-number')).toBe(true);
    expect(candidates.filter((item) => item.kind === 'resident-id')).toHaveLength(1);

    let outputterPageCount = candidates.some((item) => item.kind === 'outputter') ? 1 : 0;
    let studentNamePageCount = candidates.some((item) => item.kind === 'student-name') ? 1 : 0;
    let residentIdCount = candidates.filter((item) => item.kind === 'resident-id').length;
    for (let pageNumber = 2; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const pageViewport = page.getViewport({ scale: 200 / 72 });
      const pageWords = await extractNativeWordsForPage(page, pageViewport, pageNumber - 1, pdfjs.Util);
      const pageCandidates = detectCandidates(pageWords, [], {
        pageWidth: pageViewport.width,
        pageHeight: pageViewport.height,
      });
      if (outputter && pageCandidates.some((item) => item.kind === 'outputter' && item.sourceText === outputter.sourceText)) {
        outputterPageCount += 1;
      }
      if (studentName && pageCandidates.some((item) => item.kind === 'student-name' && item.sourceText === studentName.sourceText)) {
        studentNamePageCount += 1;
      }
      residentIdCount += pageCandidates.filter((item) => item.kind === 'resident-id').length;
    }

    expect(outputterPageCount).toBe(19);
    expect(studentNamePageCount).toBe(19);
    expect(residentIdCount).toBe(1);

    await documentTask.destroy();
  }, 20_000);
});

describe('geometry and validation', () => {
  it('detects rectangle intersections', () => {
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 5, height: 5 })).toBe(true);
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 10, width: 5, height: 5 })).toBe(false);
  });

  it('sanitizes download names', () => {
    expect(sanitizeDownloadName('신청서:최종.pdf')).toBe('신청서_최종_비식별화.pdf');
  });

  it('validates and deduplicates configured names', () => {
    expect(validateEnteredNames(['홍길동', '홍길동', '김하늘'])).toEqual(['홍길동', '김하늘']);
    expect(() => validateEnteredNames(['가'])).toThrow();
  });
});
