import { describe, expect, it } from 'vitest';

import { mergeNativeAndOcrWords, shouldRunOcr } from './pdf-processing';
import type { OcrWord } from './redaction';

function word(id: string, source: 'native' | 'ocr', x: number, text = id): OcrWord {
  const bbox = { x, y: 10, width: 40, height: 12 };
  const canonicalQuad = [x, 10, x + 40, 10, x, 22, x + 40, 22] as OcrWord['glyphs'][number]['canonicalQuad'];
  return {
    id,
    pageIndex: 0,
    lineId: 'line',
    text,
    confidence: 100,
    source,
    bbox,
    glyphs: [{
      id: `${id}-glyph`,
      text: text[0],
      source,
      bbox,
      sourceQuad: canonicalQuad,
      canonicalQuad,
    }],
  };
}

describe('native text and OCR routing', () => {
  it('keeps sparse digital text on the native glyph path', () => {
    expect(shouldRunOcr([word('resident-id', 'native', 10)], [], 400, 240)).toBe(false);
    expect(shouldRunOcr([], [], 400, 240)).toBe(true);
    expect(shouldRunOcr([word('header', 'native', 10)], [{ x: 0, y: 0, width: 400, height: 240 }], 400, 240)).toBe(true);
  });

  it('preserves native glyphs and adds only non-overlapping OCR words', () => {
    const native = word('native-id', 'native', 10, '900101-1234567');
    const duplicateOcr = word('ocr-duplicate', 'ocr', 12, '900101-1234567');
    const scannedOcr = word('ocr-address', 'ocr', 100, '경기도');
    const merged = mergeNativeAndOcrWords([native], [duplicateOcr, scannedOcr]);

    expect(merged.map((item) => item.id)).toEqual(['native-id', 'ocr-address']);
    expect(merged[0].source).toBe('native');
  });
});
