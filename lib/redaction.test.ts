import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { canonicalGlyphQuad, invertAffine, quadBounds, transformPoint, type AffineMatrix } from './pdf-geometry';

import {
  detectCandidates,
  rectsOverlap,
  sanitizeDownloadName,
  validateEnteredNames,
  type OcrWord,
} from './redaction';
import { alignNativeLayout, alignNativeWordsToRenderedLayout, extractNativeWordsForPage } from './pdf-processing';

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
      glyphs: Array.from(text).map((character, characterIndex, characters) => {
        const quad = [
          x + (width / characters.length) * characterIndex,
          20,
          x + (width / characters.length) * (characterIndex + 1),
          20,
          x + (width / characters.length) * characterIndex,
          38,
          x + (width / characters.length) * (characterIndex + 1),
          38,
        ] as const;
        return {
          id: `${pageIndex}-0-${index}-${characterIndex}`,
          text: character,
          source: 'native' as const,
          bbox: { x: x + (width / characters.length) * characterIndex, y: 20, width: width / characters.length, height: 18 },
          sourceQuad: [...quad],
          canonicalQuad: [...quad],
        };
      }),
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

  it('builds review markings from selected glyph bounds instead of a broad word advance', () => {
    const words = wordsFromLine(['성명', '김하늘']);
    words[0].bbox = { x: 450, y: 20, width: 30, height: 18 };
    words[1].bbox = { x: 500, y: 20, width: 120, height: 18 };
    words[1].glyphs.forEach((glyph, index) => {
      glyph.bbox = { x: 90 + index * 18, y: 20, width: 18, height: 18 };
    });
    const candidate = detectCandidates(words, []).find((item) => item.kind === 'student-name');
    expect(candidate).toMatchObject({ x: 86, y: 16, width: 62, height: 26 });
  });

  it('does not mistake distant Korean prose for a guardian name', () => {
    const result = detectCandidates(wordsFromLine(['보호자', '관계', '학습을', '탐구하고']), []);
    expect(result.some((item) => item.sourceText === '탐구하고')).toBe(false);
  });

  it('requires an explicit guardian-name label before selecting a guardian name', () => {
    const bareLabel = detectCandidates(wordsFromLine(['보호자', '김하늘']), []);
    const explicitLabel = detectCandidates(wordsFromLine(['보호자성명', '김하늘']), []);
    expect(bareLabel.some((item) => item.sourceText === '김하늘')).toBe(false);
    expect(explicitLabel.some((item) => item.kind === 'detected-name' && item.sourceText === '김하늘')).toBe(true);
  });

  it('does not treat explanatory "name pronunciation" prose as a name field', () => {
    const result = detectCandidates(wordsFromLine(['본인', '이름의훈과음']), []);
    expect(result.some((item) => item.kind === 'detected-name' || item.kind === 'student-name')).toBe(false);
  });

  it('does not treat an unpaired activity label "반" as a student class field', () => {
    const result = detectCandidates(wordsFromLine(['자율활동', '시수', '반', '12']), []);
    expect(result.some((item) => item.kind === 'class')).toBe(false);
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

  it('finds horizontally laid out footer class and student-number values', () => {
    const words = wordsFromLine(['반', '3', '번호', '12']);
    words.forEach((word) => {
      word.bbox.y = 1120;
      word.glyphs.forEach((glyph) => { glyph.bbox.y = 1120; });
    });
    const result = detectCandidates(words, [], { pageWidth: 900, pageHeight: 1200 });
    expect(result.some((item) => item.kind === 'class' && item.sourceText === '3')).toBe(true);
    expect(result.some((item) => item.kind === 'student-number' && item.sourceText === '12')).toBe(true);
  });

  it('does not scan downward from a paired footer row', () => {
    const footer = wordsFromLine(['반', '3', '번호', '12']);
    const unrelated = wordsFromLine(['7']);
    footer.forEach((word) => { word.bbox.y = 1120; });
    unrelated[0].bbox = { ...unrelated[0].bbox, x: footer[0].bbox.x, y: 1160 };
    unrelated[0].lineId = '0-unrelated';
    const result = detectCandidates([...footer, ...unrelated], [], { pageWidth: 900, pageHeight: 1200 });
    expect(result.filter((item) => item.kind === 'class').map((item) => item.sourceText)).toEqual(['3']);
    expect(result.some((item) => item.sourceText === '7')).toBe(false);
  });

  it('uses only a three-label student table for vertical class and number values', () => {
    const headers = wordsFromLine(['학년', '학과', '반', '번호', '담임성명']);
    const values = wordsFromLine(['2', '3', '17']);
    headers.forEach((word, index) => { word.bbox.x = 40 + index * 100; });
    values[0].bbox = { ...values[0].bbox, x: 240, y: 55 };
    values[1].bbox = { ...values[1].bbox, x: 340, y: 55 };
    values[2].bbox = { ...values[2].bbox, x: 240, y: 250 };
    values.forEach((word) => { word.lineId = '0-values'; });
    const result = detectCandidates([...headers, ...values], [], { pageWidth: 900, pageHeight: 1200 });
    expect(result.some((item) => item.kind === 'class' && item.sourceText === '2')).toBe(true);
    expect(result.some((item) => item.kind === 'student-number' && item.sourceText === '3')).toBe(true);
    expect(result.some((item) => item.sourceText === '17')).toBe(false);
  });

  it('excludes activity rows and requires identity context for inline class text', () => {
    const activity = detectCandidates(wordsFromLine(['자율활동', '시수', '반', '12', '번호', '7']), []);
    const narrative = detectCandidates(wordsFromLine(['우리반은', '3반']), []);
    const identity = detectCandidates(wordsFromLine(['성명', '홍길동', '3반']), []);
    expect(activity.some((item) => item.kind === 'class' || item.kind === 'student-number')).toBe(false);
    expect(narrative.some((item) => item.kind === 'class')).toBe(false);
    expect(identity.some((item) => item.kind === 'class' && item.sourceText === '3')).toBe(true);
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
      height: imageBounds.height + 2,
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
  it('uses PDF.js preview geometry while retaining MuPDF deletion targets', () => {
    const native = wordsFromLine(['홍길동']);
    native[0].bbox = { x: 700, y: 30, width: 16, height: 2 };
    native[0].glyphs.forEach((glyph, index) => {
      glyph.bbox = { x: 700 + index * 5, y: 30, width: 5, height: 2 };
      glyph.sourceQuad = [10, 20, 15, 20, 10, 20.5, 15, 20.5];
      glyph.canonicalQuad = [10, 20, 15, 20, 10, 20.5, 15, 20.5];
    });
    const rendered = wordsFromLine(['홍길동']);
    rendered[0].lineId = '0-native-rendered-4';
    rendered[0].bbox = { x: 130, y: 440, width: 72, height: 24 };
    rendered[0].glyphs.forEach((glyph, index) => {
      glyph.bbox = { x: 130 + index * 24, y: 440, width: 24, height: 24 };
    });

    const aligned = alignNativeWordsToRenderedLayout(native, rendered);
    expect(aligned[0]).toMatchObject({ bbox: rendered[0].bbox, lineId: rendered[0].lineId });
    expect(aligned[0].glyphs[0]).toMatchObject({ id: native[0].glyphs[0].id, canonicalQuad: native[0].glyphs[0].canonicalQuad, bbox: rendered[0].glyphs[0].bbox });
  });

  it('round-trips rotated CropBox coordinates through an affine transform', () => {
    const pdfToCanvas: AffineMatrix = [0, 2, 2, 0, -40, -20];
    const canvasToPdf = invertAffine(pdfToCanvas);
    const point: [number, number] = [50, 100];
    const roundTrip = transformPoint(canvasToPdf, transformPoint(pdfToCanvas, point));
    expect(roundTrip[0]).toBeCloseTo(point[0], 8);
    expect(roundTrip[1]).toBeCloseTo(point[1], 8);
  });

  it('keeps MuPDF advance width while using the rendered glyph height', () => {
    const canonical = canonicalGlyphQuad(
      [10, 20, 20, 20, 10, 21, 20, 21],
      { x: 10, y: 8, width: 30, height: 18 },
      { pdfToCanvas: [1, 0, 0, 1, 0, 0], canvasToPdf: [1, 0, 0, 1, 0, 0] },
    );
    expect(quadBounds(canonical)).toMatchObject({ x: 10, width: 10, y: 8, height: 18 });
  });

  it('pairs repeated school names by visual occurrence order', () => {
    const native = [...wordsFromLine(['안산강서고등학교']), ...wordsFromLine(['안산강서고등학교'])];
    native[0].id = 'first';
    native[1].id = 'second';
    native[0].bbox.y = 20;
    native[1].bbox.y = 200;
    const rendered = [...wordsFromLine(['안산강서고등학교']), ...wordsFromLine(['안산강서고등학교'])];
    rendered[0].bbox.y = 40;
    rendered[1].bbox.y = 240;
    rendered[0].lineId = 'rendered-first';
    rendered[1].lineId = 'rendered-second';
    const aligned = alignNativeLayout(native, rendered).words;
    expect(aligned.map((word) => word.lineId)).toEqual(['rendered-first', 'rendered-second']);
  });

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
