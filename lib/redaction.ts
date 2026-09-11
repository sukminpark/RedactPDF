export type RedactionKind =
  | 'resident-id'
  | 'entered-name'
  | 'detected-name'
  | 'student-name'
  | 'homeroom-teacher'
  | 'outputter'
  | 'address'
  | 'photo'
  | 'school-name'
  | 'government-name'
  | 'government-staff'
  | 'school-seal'
  | 'issuance-info'
  | 'issuance-number'
  | 'class'
  | 'student-number'
  | 'manual';

export type ProcessingStage =
  | 'idle'
  | 'loading'
  | 'rendering'
  | 'ocr'
  | 'review'
  | 'exporting'
  | 'complete'
  | 'error'
  | 'cancelled';

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type GlyphSource = 'native' | 'ocr';
export type PdfQuad = [number, number, number, number, number, number, number, number];

export interface TextGlyph {
  id: string;
  text: string;
  source: GlyphSource;
  sourceQuad: PdfQuad;
  canonicalQuad: PdfQuad;
  bbox: CanvasRect;
}

export interface OcrWord {
  id: string;
  pageIndex: number;
  lineId: string;
  text: string;
  confidence: number;
  bbox: CanvasRect;
  source: GlyphSource;
  glyphs: TextGlyph[];
}

export interface RedactionCandidate extends CanvasRect {
  id: string;
  pageIndex: number;
  kind: RedactionKind;
  sourceText: string;
  confidence: number;
  selected: boolean;
  reason: string;
  targetGlyphIds: string[];
  targetQuads: Array<{ source: GlyphSource; quad: PdfQuad; text?: string }>;
  selectionMode: 'exact-glyphs' | 'region';
}

export interface PageReviewState {
  pageCount: number;
  pageIndex: number;
  pdfWidth: number;
  pdfHeight: number;
  renderWidth: number;
  renderHeight: number;
  transform: import('./pdf-geometry').PageTransform;
  imageUrl: string;
  imageType: 'image/jpeg' | 'image/png';
  words: OcrWord[];
  redactions: RedactionCandidate[];
  reviewed: boolean;
}

// A bare "보호자" often labels a relationship or narrative section rather
// than a name field. Require an explicit guardian-name label before treating
// the neighboring text as personally identifying information.
const LABELS = ['보호자성명', '보호자이름', '보호자명', '성명', '이름', '신청인', '신청자', '민원인', '대표자'];
// A slash at the end of a subject category is not an output-person field.
// This is intentionally limited to the legacy footer shorthand rule.
const OUTPUTTER_CATEGORY_TERMS = new Set(['교양', '국어', '수학', '영어', '과학', '사회', '예술', '체육']);
// MuPDF image redaction clips a fractional image edge as an open boundary.
// Keep two render-canvas pixels below an embedded portrait so the last raster
// row is deleted too; this is part of the actual photo candidate, not UI-only
// padding.
const PHOTO_IMAGE_BOTTOM_PADDING = 2;

export interface DetectionContext {
  pageCount?: number;
  pageWidth?: number;
  pageHeight?: number;
  imageBounds?: CanvasRect[];
  isSchoolRecordDocument?: boolean;
}

export function unionRects(rects: CanvasRect[], padding = 0): CanvasRect {
  const x0 = Math.min(...rects.map((rect) => rect.x));
  const y0 = Math.min(...rects.map((rect) => rect.y));
  const x1 = Math.max(...rects.map((rect) => rect.x + rect.width));
  const y1 = Math.max(...rects.map((rect) => rect.y + rect.height));

  return {
    x: Math.max(0, x0 - padding),
    y: Math.max(0, y0 - padding),
    width: x1 - x0 + padding * 2,
    height: y1 - y0 + padding * 2,
  };
}

export function rectsOverlap(a: CanvasRect, b: CanvasRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function regionTargetsGlyph(region: CanvasRect, glyph: CanvasRect): boolean {
  const centerX = glyph.x + glyph.width / 2;
  const centerY = glyph.y + glyph.height / 2;
  const centerInside =
    centerX >= region.x &&
    centerX <= region.x + region.width &&
    centerY >= region.y &&
    centerY <= region.y + region.height;
  if (centerInside) return true;

  const overlapWidth = Math.max(
    0,
    Math.min(region.x + region.width, glyph.x + glyph.width) - Math.max(region.x, glyph.x),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(region.y + region.height, glyph.y + glyph.height) - Math.max(region.y, glyph.y),
  );
  const glyphArea = Math.max(1, glyph.width * glyph.height);
  return (overlapWidth * overlapHeight) / glyphArea >= 0.5;
}

function normalizeCompact(text: string): string {
  return text.normalize('NFKC').replace(/[\s:：()[\]{}.,·ㆍ_]/g, '');
}

function validBirthDatePrefix(value: string): boolean {
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function lineGroups(words: OcrWord[]): OcrWord[][] {
  const lines = new Map<string, OcrWord[]>();
  for (const word of words) {
    const group = lines.get(word.lineId) ?? [];
    group.push(word);
    lines.set(word.lineId, group);
  }
  return [...lines.values()]
    .map((line) => line.sort((a, b) => a.bbox.x - b.bbox.x))
    .sort((a, b) => Math.min(...a.map((word) => word.bbox.y)) - Math.min(...b.map((word) => word.bbox.y)));
}

function pushCandidate(
  candidates: RedactionCandidate[],
  words: OcrWord[],
  kind: RedactionKind,
  sourceText: string,
  reason: string,
): void {
  if (words.length === 0) return;
  const glyphs = words.flatMap((word) => word.glyphs);
  // The review rectangle must use the same per-glyph geometry used by the
  // redaction engine. Word-level widths in Office PDFs can include advances
  // and spacing that visibly move a candidate away from its selected text.
  const rect = unionRects(
    glyphs.length > 0 ? glyphs.map((glyph) => glyph.bbox) : words.map((word) => word.bbox),
    4,
  );
  const duplicate = candidates.some(
    (candidate) =>
      candidate.kind === kind &&
      Math.abs(candidate.x - rect.x) < 3 &&
      Math.abs(candidate.y - rect.y) < 3 &&
      Math.abs(candidate.width - rect.width) < 6,
  );
  if (duplicate) return;

  candidates.push({
    id: `${words[0].pageIndex}-${kind}-${candidates.length}-${Math.round(rect.x)}-${Math.round(rect.y)}`,
    pageIndex: words[0].pageIndex,
    kind,
    sourceText,
    confidence: Math.round(words.reduce((sum, word) => sum + word.confidence, 0) / words.length),
    selected: true,
    reason,
    targetGlyphIds: glyphs.map((glyph) => glyph.id),
    targetQuads: glyphs.map((glyph) => ({ source: glyph.source, quad: glyph.canonicalQuad, text: glyph.text })),
    selectionMode: glyphs.length > 0 ? 'exact-glyphs' : 'region',
    ...rect,
  });
}

function pushRectCandidate(
  candidates: RedactionCandidate[],
  pageIndex: number,
  kind: RedactionKind,
  sourceText: string,
  reason: string,
  rect: CanvasRect,
  confidence = 90,
): void {
  const duplicate = candidates.some(
    (candidate) =>
      candidate.kind === kind &&
      Math.abs(candidate.x - rect.x) < 4 &&
      Math.abs(candidate.y - rect.y) < 4,
  );
  if (duplicate) return;
  candidates.push({
    id: `${pageIndex}-${kind}-${candidates.length}-${Math.round(rect.x)}-${Math.round(rect.y)}`,
    pageIndex,
    kind,
    sourceText,
    confidence,
    selected: true,
    reason,
    targetGlyphIds: [],
    targetQuads: [],
    selectionMode: 'region',
    ...rect,
  });
}

function pushWordSliceCandidate(
  candidates: RedactionCandidate[],
  word: OcrWord,
  slice: string,
  kind: RedactionKind,
  reason: string,
  leftPadding = 6,
  rightPadding = 6,
): void {
  const source = word.text.normalize('NFKC');
  const start = source.lastIndexOf(slice);
  if (start < 0) return;
  const selectedGlyphs = word.glyphs.slice(start, start + slice.length);
  const characterWidth = word.bbox.width / Math.max(1, source.length);
  const rect = selectedGlyphs.length === slice.length
    ? unionRects(selectedGlyphs.map((glyph) => glyph.bbox), Math.max(leftPadding, rightPadding))
    : {
        x: Math.max(0, word.bbox.x + characterWidth * start - leftPadding),
        y: Math.max(0, word.bbox.y - 5),
        width: characterWidth * slice.length + leftPadding + rightPadding,
        height: word.bbox.height + 10,
      };
  const before = candidates.length;
  pushRectCandidate(candidates, word.pageIndex, kind, slice, reason, rect, word.confidence);
  const candidate = candidates.length > before ? candidates.at(-1) : undefined;
  const selectedText = selectedGlyphs.map((glyph) => glyph.text).join('').normalize('NFKC');
  if (candidate && selectedGlyphs.length === Array.from(slice).length && selectedText === slice.normalize('NFKC')) {
    candidate.targetGlyphIds = selectedGlyphs.map((glyph) => glyph.id);
    candidate.targetQuads = selectedGlyphs.map((glyph) => ({ source: glyph.source, quad: glyph.canonicalQuad, text: glyph.text }));
    candidate.selectionMode = 'exact-glyphs';
  }
}

function pushWordSliceRegionCandidate(
  candidates: RedactionCandidate[],
  word: OcrWord,
  slice: string,
  kind: RedactionKind,
  reason: string,
  leftPadding = 6,
  rightPadding = 6,
  verticalPadding = 6,
): void {
  const source = word.text.normalize('NFKC');
  const start = source.lastIndexOf(slice);
  if (start < 0) return;
  const characterWidth = word.bbox.width / Math.max(1, Array.from(source).length);
  const selectedGlyphs = word.glyphs.slice(start, start + Array.from(slice).length);
  const selectedText = selectedGlyphs.map((glyph) => glyph.text).join('').normalize('NFKC');
  const hasExactGlyphs = selectedGlyphs.length === Array.from(slice).length
    && selectedText === slice.normalize('NFKC');
  const glyphBounds = hasExactGlyphs ? unionRects(selectedGlyphs.map((glyph) => glyph.bbox)) : undefined;
  const rect = glyphBounds
    ? {
        x: Math.max(0, glyphBounds.x - leftPadding),
        y: Math.max(0, glyphBounds.y - verticalPadding),
        width: glyphBounds.width + leftPadding + rightPadding,
        height: glyphBounds.height + verticalPadding * 2,
      }
    : {
        x: Math.max(0, word.bbox.x + characterWidth * start - leftPadding),
        y: Math.max(0, word.bbox.y - verticalPadding),
        width: characterWidth * Array.from(slice).length + leftPadding + rightPadding,
        height: word.bbox.height + verticalPadding * 2,
      };
  pushRectCandidate(candidates, word.pageIndex, kind, slice, reason, rect, word.confidence);
  const candidate = candidates.at(-1);
  if (candidate && hasExactGlyphs) {
    candidate.targetGlyphIds = selectedGlyphs.map((glyph) => glyph.id);
    candidate.targetQuads = selectedGlyphs.map((glyph) => ({ source: glyph.source, quad: glyph.canonicalQuad, text: glyph.text }));
    candidate.selectionMode = 'exact-glyphs';
  }
}
function findResidentIds(lines: OcrWord[][], candidates: RedactionCandidate[]): void {
  for (const words of lines) {
    const hasResidentLabel = words.some((word) => /주민(?:등록)?번호/.test(normalizeCompact(word.text)));
    let runWords: OcrWord[] = [];

    const inspectRun = () => {
      if (runWords.length === 0) return;
      let compact = '';
      const characterWordIndexes: number[] = [];
      runWords.forEach((word, wordIndex) => {
        const numeric = word.text.normalize('NFKC').replace(/[^\d*-]/g, '');
        for (const character of numeric) {
          compact += character;
          characterWordIndexes.push(wordIndex);
        }
      });
      const pattern = /\d{6}-?[1-8*][\d*]{6}/g;
      for (const match of compact.matchAll(pattern)) {
        if (match.index === undefined || !validBirthDatePrefix(match[0])) continue;
        const startWord = characterWordIndexes[match.index];
        const endWord = characterWordIndexes[match.index + match[0].length - 1];
        if (startWord === undefined || endWord === undefined) continue;
        const matchedWords = runWords.slice(startWord, endWord + 1);
        const containsHyphen = match[0].includes('-');
        const isSingleContinuousToken = matchedWords.length === 1 && /^\d{13}$/.test(match[0]);
        if (!containsHyphen && !isSingleContinuousToken && !hasResidentLabel) continue;
        pushCandidate(
          candidates,
          matchedWords,
          'resident-id',
          match[0],
          '주민등록번호 형식과 항목 위치',
        );
      }
      runWords = [];
    };

    words.forEach((word) => {
      const value = word.text.normalize('NFKC').trim();
      const numericOnly = /^[\d*\s-]+$/.test(value);
      const dateOrTime = /[.:/]|년|월|일/.test(value) || /^\d{4}-\d{1,2}-\d{1,2}$/.test(value);
      const previous = runWords.at(-1);
      const closeToPrevious =
        !previous || word.bbox.x - (previous.bbox.x + previous.bbox.width) <= Math.max(18, word.bbox.height * 1.8);
      if (numericOnly && !dateOrTime && closeToPrevious) {
        runWords.push(word);
      } else {
        inspectRun();
        if (numericOnly && !dateOrTime) runWords = [word];
      }
    });
    inspectRun();

    for (const word of words) {
      const embedded = word.text.normalize('NFKC').match(/\d{6}-[1-8*][\d*]{6}/);
      if (embedded && validBirthDatePrefix(embedded[0])) {
        pushWordSliceCandidate(
          candidates,
          word,
          embedded[0],
          'resident-id',
          '주민등록번호 형식과 항목 위치',
        );
      }
    }
  }
}

function findEnteredNames(
  lines: OcrWord[][],
  enteredNames: string[],
  candidates: RedactionCandidate[],
): void {
  for (const rawName of enteredNames) {
    const name = normalizeCompact(rawName);
    if (name.length < 2) continue;

    for (const words of lines) {
      let compact = '';
      const characterWordIndexes: number[] = [];
      words.forEach((word, wordIndex) => {
        const value = normalizeCompact(word.text);
        for (const character of value) {
          compact += character;
          characterWordIndexes.push(wordIndex);
        }
      });

      let offset = compact.indexOf(name);
      while (offset !== -1) {
        const startWord = characterWordIndexes[offset];
        const endWord = characterWordIndexes[offset + name.length - 1];
        if (startWord !== undefined && endWord !== undefined) {
          if (startWord === endWord) {
            pushWordSliceCandidate(
              candidates,
              words[startWord],
              name,
              'entered-name',
              '직접 입력한 이름',
            );
          } else {
            pushCandidate(
              candidates,
              words.slice(startWord, endWord + 1),
              'entered-name',
              rawName,
              '직접 입력한 이름',
            );
          }
        }
        offset = compact.indexOf(name, offset + name.length);
      }
    }
  }
}

function isKoreanName(value: string): boolean {
  return /^[가-힣]{2,5}$/.test(normalizeCompact(value));
}

function isPlausibleNameFieldValue(value: string, label: string): boolean {
  if (!isKoreanName(value)) return false;
  if (label !== '이름') return true;
  // A bare “이름” in narrative prose can be followed by a Korean predicate.
  // Keep form-style name fields, but never treat a predicate as a person's name.
  return !/(?:다고|했다|된다|였다|었다|졌다|이다|하며|하고|하는|하여|해서|게)$/.test(normalizeCompact(value));
}

function isLikelyFooterOutputter(value: string): boolean {
  const compact = normalizeCompact(value);
  return isKoreanName(compact) && !OUTPUTTER_CATEGORY_TERMS.has(compact);
}

function nameFieldLabel(word: OcrWord): string | undefined {
  const raw = word.text.normalize('NFKC').trim();
  const compact = normalizeCompact(raw);
  for (const label of LABELS) {
    // Plain “이름” is common in narrative school-record text. It is a field
    // label only when it has explicit field punctuation; Government24 tables
    // are handled separately with their own document-context rule.
    if (compact === label) {
      if (label !== '이름' || /[:：]/.test(raw)) return label;
      continue;
    }
    if (!raw.startsWith(label)) continue;
    const suffix = raw.slice(label.length);
    if (/^[\s:：]/.test(suffix)) return label;
    // Concatenated values are accepted only for explicit 성명 fields. A bare
    // word such as "이름의 훈과 음" is explanatory prose, not a name field.
    if ((label === '성명' || label.startsWith('보호자')) && isKoreanName(compact.slice(label.length))) {
      return label;
    }
  }
  return undefined;
}

function findDetectedNames(
  lines: OcrWord[][],
  allWords: OcrWord[],
  candidates: RedactionCandidate[],
): void {
  const orderedWords = [...allWords].sort(
    (a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x,
  );

  for (const words of lines) {
    words.forEach((word, index) => {
      const normalized = normalizeCompact(word.text);
      const label = nameFieldLabel(word);
      if (!label) return;

      const inlineValue = normalized.slice(label.length);
      const kind: RedactionKind = label === '성명' ? 'student-name' : 'detected-name';
      if (isPlausibleNameFieldValue(inlineValue, label)) {
        pushWordSliceCandidate(candidates, word, inlineValue, kind, `${label} 항목 주변`);
        return;
      }

      const labelRight = word.bbox.x + word.bbox.width;
      const sameLine = words.slice(index + 1).find((candidate) => {
        if (!isPlausibleNameFieldValue(candidate.text, label)) return false;
        const candidateCenterY = candidate.bbox.y + candidate.bbox.height / 2;
        const horizontalGap = candidate.bbox.x - labelRight;
        const sameRow = Math.abs(candidateCenterY - (word.bbox.y + word.bbox.height / 2)) <= word.bbox.height;
        // A field value follows its label directly. Without this bound, prose
        // later in a long row (for example "탐구하고") is mistaken for a name.
        return sameRow && horizontalGap >= -2 && horizontalGap <= Math.max(48, word.bbox.width * 2);
      });
      if (sameLine) {
        pushCandidate(
          candidates,
          [sameLine],
          kind,
          normalizeCompact(sameLine.text),
          `${label} 항목 주변`,
        );
        return;
      }

      const anchorCenterY = word.bbox.y + word.bbox.height / 2;
      const nearby = orderedWords.find((candidate) => {
        if (!isPlausibleNameFieldValue(candidate.text, label) || candidate.id === word.id) return false;
        const candidateCenterY = candidate.bbox.y + candidate.bbox.height / 2;
        const onSameRow = Math.abs(candidateCenterY - anchorCenterY) <= word.bbox.height * 1.5;
        const horizontalGap = candidate.bbox.x - (word.bbox.x + word.bbox.width);
        const justBelow =
          candidate.bbox.y > word.bbox.y &&
          candidate.bbox.y - word.bbox.y <= word.bbox.height * 3 &&
          Math.abs(candidate.bbox.x - word.bbox.x) <= word.bbox.width * 2;
        return (
          onSameRow &&
          horizontalGap >= -2 &&
          horizontalGap <= Math.max(48, word.bbox.width * 2)
        ) || justBelow;
      });
      if (nearby) {
        pushCandidate(
          candidates,
          [nearby],
          kind,
          normalizeCompact(nearby.text),
          `${label} 항목 주변`,
        );
      }
    });
  }
}

function findNameBesideLabel(
  line: OcrWord[],
  labelIndex: number,
  allWords: OcrWord[],
): OcrWord | undefined {
  const label = line[labelIndex];
  if (!label) return undefined;
  const labelCenterY = label.bbox.y + label.bbox.height / 2;
  const sameRow = line
    .filter((word, index) => {
      if (index <= labelIndex || !isKoreanName(word.text)) return false;
      const centerY = word.bbox.y + word.bbox.height / 2;
      const gap = word.bbox.x - (label.bbox.x + label.bbox.width);
      return Math.abs(centerY - labelCenterY) <= Math.max(label.bbox.height, word.bbox.height)
        && gap >= -2
        && gap <= Math.max(60, label.bbox.width * 3);
    })
    .sort((a, b) => a.bbox.x - b.bbox.x)[0];
  if (sameRow) return sameRow;

  const sameRowAcrossLines = allWords
    .filter((word) => {
      if (!isKoreanName(word.text) || word.id === label.id) return false;
      const centerY = word.bbox.y + word.bbox.height / 2;
      const gap = word.bbox.x - (label.bbox.x + label.bbox.width);
      return Math.abs(centerY - labelCenterY) <= Math.max(label.bbox.height, word.bbox.height) * 1.5
        && gap >= -2
        && gap <= Math.max(140, label.bbox.width * 6);
    })
    .sort((a, b) => a.bbox.x - b.bbox.x)[0];
  if (sameRowAcrossLines) return sameRowAcrossLines;

  return allWords
    .filter((word) => {
      if (!isKoreanName(word.text) || word.id === label.id) return false;
      const verticalGap = word.bbox.y - (label.bbox.y + label.bbox.height);
      const centerOffset = Math.abs(
        word.bbox.x + word.bbox.width / 2 - (label.bbox.x + label.bbox.width / 2),
      );
      return verticalGap >= -2
        && verticalGap <= Math.max(54, label.bbox.height * 3.5)
        && centerOffset <= Math.max(70, label.bbox.width * 2);
    })
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)[0];
}

function findNamePartsBesideLabel(
  line: OcrWord[],
  labelIndex: number,
  allWords: OcrWord[],
): OcrWord[] | undefined {
  const wholeName = findNameBesideLabel(line, labelIndex, allWords);
  if (wholeName) return [wholeName];

  const label = line[labelIndex];
  if (!label) return undefined;
  const labelCenterY = label.bbox.y + label.bbox.height / 2;
  const nameParts = allWords
    .filter((word) => {
      if (!/^[가-힣]$/.test(normalizeCompact(word.text)) || word.id === label.id) return false;
      const centerY = word.bbox.y + word.bbox.height / 2;
      const gap = word.bbox.x - (label.bbox.x + label.bbox.width);
      return Math.abs(centerY - labelCenterY) <= Math.max(label.bbox.height, word.bbox.height) * 1.5
        && gap >= -2
        && gap <= Math.max(140, label.bbox.width * 6);
    })
    .sort((a, b) => a.bbox.x - b.bbox.x);

  for (let start = 0; start < nameParts.length; start += 1) {
    const parts = [nameParts[start]];
    let compactName = normalizeCompact(nameParts[start].text);
    for (let index = start + 1; index < nameParts.length && compactName.length < 5; index += 1) {
      const previous = parts.at(-1)!;
      const next = nameParts[index];
      const gap = next.bbox.x - (previous.bbox.x + previous.bbox.width);
      if (gap > Math.max(28, previous.bbox.width * 1.5)) break;
      parts.push(next);
      compactName += normalizeCompact(next.text);
      if (isKoreanName(compactName)) {
        const following = nameParts[index + 1];
        const followingGap = following ? following.bbox.x - (next.bbox.x + next.bbox.width) : Number.POSITIVE_INFINITY;
        if (compactName.length === 2
          && following
          && /^[\uAC00-\uD7A3]$/.test(normalizeCompact(following.text))
          && followingGap <= Math.max(28, next.bbox.width * 1.5)) continue;
        return parts;
      }
    }
  }
}

function expandRect(rect: CanvasRect, horizontalPadding: number, verticalPadding: number): CanvasRect {
  return {
    x: Math.max(0, rect.x - horizontalPadding),
    y: Math.max(0, rect.y - verticalPadding),
    width: rect.width + horizontalPadding * 2,
    height: rect.height + verticalPadding * 2,
  };
}

function findGovernment24Fields(
  lines: OcrWord[][],
  allWords: OcrWord[],
  candidates: RedactionCandidate[],
  context: DetectionContext,
): void {
  if (allWords.length === 0) return;
  const documentText = allWords.map((word) => normalizeCompact(word.text)).join('');
  const isGovernment24Document = documentText.includes('정부24')
    || (documentText.includes('학교생활기록부') && documentText.includes('발급번호'));
  if (!isGovernment24Document) return;

  const pageIndex = allWords[0].pageIndex;
  const pageWidth = context.pageWidth ?? Math.max(...allWords.map((word) => word.bbox.x + word.bbox.width));
  const pageHeight = context.pageHeight ?? Math.max(...allWords.map((word) => word.bbox.y + word.bbox.height));

  for (const line of lines) {
    const lineText = line.map((word) => normalizeCompact(word.text)).join('');
    line.forEach((word, labelIndex) => {
      const label = normalizeCompact(word.text);
      const nextLabel = normalizeCompact(line[labelIndex + 1]?.text ?? '');
      const hasLeftLabelPart = (part: string) => allWords
        .filter((candidate) =>
          candidate.bbox.x + candidate.bbox.width <= word.bbox.x + 2
          && word.bbox.x - (candidate.bbox.x + candidate.bbox.width) <= Math.max(72, word.bbox.width * 4)
          && Math.abs(candidate.bbox.y + candidate.bbox.height / 2 - (word.bbox.y + word.bbox.height / 2)) <= Math.max(candidate.bbox.height, word.bbox.height) * 1.5,
        )
        .sort((a, b) => a.bbox.x - b.bbox.x)
        .slice(-3)
        .map((candidate) => normalizeCompact(candidate.text))
        .join('')
        .endsWith(part);
      const hasFollowingLabelPart = (label === '성' && nextLabel === '명') || (label === '담당' && nextLabel === '자');
      const splitNameLabel = (label === '성' && nextLabel === '명') || (label === '명' && hasLeftLabelPart('성'));
      const splitStaffLabel = (label === '담당' && nextLabel === '자') || (label === '자' && hasLeftLabelPart('담당'));
      const labelEndIndex = hasFollowingLabelPart ? labelIndex + 1 : labelIndex;
      const nearbyPersonalDetails = lineText.includes('인적사항') || allWords.some((candidate) =>
        (normalizeCompact(candidate.text).includes('인적사항') || /^(인적|사항)$/.test(normalizeCompact(candidate.text)))
        && Math.abs(candidate.bbox.y - word.bbox.y) <= Math.max(54, word.bbox.height * 3)
        && candidate.bbox.x <= word.bbox.x + word.bbox.width,
      );
      const kind: RedactionKind | undefined = nearbyPersonalDetails && (splitNameLabel || /^(이름|성명)$/.test(label))
        ? 'government-name'
        : splitStaffLabel || /^(담당자|처리담당자|발급담당자|담당)$/.test(label)
          ? 'government-staff'
          : undefined;
      if (!kind) return;
      const nameParts = findNamePartsBesideLabel(line, labelEndIndex, allWords);
      const nameBounds = nameParts ? unionRects(nameParts.map((name) => name.bbox)) : undefined;
      const alreadyCovered = nameParts && nameBounds && candidates.some((candidate) =>
        candidate.pageIndex === nameParts[0].pageIndex
        && rectsOverlap(candidate, nameBounds)
        && (candidate.kind === kind || candidate.kind === 'student-name' || candidate.kind === 'detected-name'),
      );
      if (nameParts && !alreadyCovered) {
        pushCandidate(
          candidates,
          nameParts,
          kind,
          nameParts.map((name) => normalizeCompact(name.text)).join(''),
          kind === 'government-name' ? '정부24 인적사항 이름' : '정부24 담당자 항목',
        );
      }
    });
  }

  for (const line of lines) {
    const issuanceLabelIndex = line.findIndex((word, index) => {
      const label = normalizeCompact(word.text);
      const nextLabel = normalizeCompact(line[index + 1]?.text ?? '');
      return label === '발급번호' || (label === '발급' && nextLabel === '번호');
    });
    if (issuanceLabelIndex < 0) continue;
    const labelEndIndex = normalizeCompact(line[issuanceLabelIndex].text) === '발급'
      ? issuanceLabelIndex + 1
      : issuanceLabelIndex;
    const labelWord = line[labelEndIndex];
    const labelCenterY = labelWord.bbox.y + labelWord.bbox.height / 2;
    const issuanceNumber = line
      .filter((word, index) => {
        if (index <= labelEndIndex) return false;
        const compact = normalizeCompact(word.text);
        const gap = word.bbox.x - (labelWord.bbox.x + labelWord.bbox.width);
        return /(?=.*\d)[A-Za-z0-9-]{4,}/.test(compact)
          && gap >= -2
          && gap <= Math.max(160, labelWord.bbox.width * 6)
          && Math.abs(word.bbox.y + word.bbox.height / 2 - labelCenterY) <= Math.max(labelWord.bbox.height, word.bbox.height);
      })
      .sort((a, b) => a.bbox.x - b.bbox.x)[0];
    if (issuanceNumber) {
      pushRectCandidate(
        candidates,
        pageIndex,
        'issuance-number',
        normalizeCompact(issuanceNumber.text),
        '정부24 발급번호 항목',
        expandRect(issuanceNumber.bbox, 5, 5),
        issuanceNumber.confidence,
      );
    }
  }

  const schoolPrincipalWords = allWords.filter((word) => normalizeCompact(word.text).includes('학교장'));
  for (const principal of schoolPrincipalWords) {
    const principalCenterY = principal.bbox.y + principal.bbox.height / 2;
    const nearbySeal = (context.imageBounds ?? [])
      .filter((image) => {
        const centerY = image.y + image.height / 2;
        const horizontalGap = image.x - (principal.bbox.x + principal.bbox.width);
        return horizontalGap >= -Math.max(24, principal.bbox.width)
          && horizontalGap <= pageWidth * 0.24
          && Math.abs(centerY - principalCenterY) <= Math.max(pageHeight * 0.12, principal.bbox.height * 4)
          && image.width >= pageWidth * 0.025
          && image.height >= pageHeight * 0.025;
      })
      .sort((a, b) => a.x - b.x || a.y - b.y)[0];
    if (nearbySeal) {
      pushRectCandidate(
        candidates,
        pageIndex,
        'school-seal',
        '학교장 직인',
        '정부24 학교장 직인 이미지',
        expandRect(nearbySeal, 2, 2),
        96,
      );
    }
  }

  if (context.pageCount !== undefined && pageIndex === context.pageCount - 1) {
    for (const line of lines) {
      const issuanceLabel = line.find((word) => normalizeCompact(word.text).includes('발급정보'));
      if (!issuanceLabel) continue;
      const sectionItems: CanvasRect[] = [
        ...allWords.filter((word) => word.bbox.y >= issuanceLabel.bbox.y - issuanceLabel.bbox.height * 0.5).map((word) => word.bbox),
        ...(context.imageBounds ?? []).filter((image) => image.y + image.height >= issuanceLabel.bbox.y).map((image) => image),
      ];
      if (sectionItems.length > 0) {
        pushRectCandidate(
          candidates,
          pageIndex,
          'issuance-info',
          '발급정보',
          '정부24 마지막 쪽 발급정보 전체',
          unionRects(sectionItems, 8),
          98,
        );
      }
      break;
    }
  }
}
function findSchoolRecordFields(
  lines: OcrWord[][],
  allWords: OcrWord[],
  candidates: RedactionCandidate[],
  context: DetectionContext,
): void {
  if (allWords.length === 0) return;
  const pageIndex = allWords[0].pageIndex;
  const pageWidth = context.pageWidth ?? Math.max(...allWords.map((word) => word.bbox.x + word.bbox.width));
  const pageHeight = context.pageHeight ?? Math.max(...allWords.map((word) => word.bbox.y + word.bbox.height));
  const documentText = allWords.map((word) => normalizeCompact(word.text)).join('');
  const isSchoolRecord = context.isSchoolRecordDocument
    ?? /학교생활(?:세부사항)?기록부|대입전형자료/.test(documentText);

  const ignoredSchoolLabels = new Set(['출신중학교', '출신고등학교', '전입학교', '졸업학교']);
  for (const word of allWords) {
    const source = word.text.normalize('NFKC');
    for (const match of source.matchAll(/[가-힣A-Za-z0-9·.-]{2,}(?:초등학교|중학교|고등학교)/g)) {
      if (ignoredSchoolLabels.has(normalizeCompact(match[0])) || /학교생활/.test(match[0])) continue;
      const isSchoolPrincipalName = normalizeCompact(word.text).includes('학교장');
      const verticalPadding = isSchoolPrincipalName
        ? Math.max(15, (32 - word.bbox.height) / 2)
        : 8;
      pushWordSliceRegionCandidate(candidates, word, match[0], 'school-name', '학교명 또는 출신학교명', 8, 6, verticalPadding);
    }
  }

  // A numbered school-record table can express the name field without a
  // colon (for example: 번호 | 2 | 이름 | 홍길동). Keep this distinct from
  // narrative “이름” by requiring the preceding number header and its value
  // on the same visual row.
  if (isSchoolRecord) {
    for (const nameHeader of allWords.filter((word) => normalizeCompact(word.text) === '이름')) {
      const centerY = nameHeader.bbox.y + nameHeader.bbox.height / 2;
      const row = allWords
        .filter((word) =>
          Math.abs(word.bbox.y + word.bbox.height / 2 - centerY) <= Math.max(nameHeader.bbox.height, word.bbox.height) * 1.4,
        )
        .sort((left, right) => left.bbox.x - right.bbox.x);
      const nameIndex = row.indexOf(nameHeader);
      const numberIndex = row.findIndex((word, index) => index < nameIndex && normalizeCompact(word.text) === '번호');
      const hasNumberValue = numberIndex >= 0 && row
        .slice(numberIndex + 1, nameIndex)
        .some((word) => /^\d{1,3}$/.test(normalizeCompact(word.text)));
      if (!hasNumberValue) continue;
      const name = row
        .slice(nameIndex + 1)
        .find((word) => {
          const gap = word.bbox.x - (nameHeader.bbox.x + nameHeader.bbox.width);
          return isPlausibleNameFieldValue(word.text, '이름')
            && gap >= -2
            && gap <= Math.max(140, nameHeader.bbox.width * 6);
        });
      if (name) {
        pushCandidate(candidates, [name], 'student-name', normalizeCompact(name.text), '번호·이름 표 항목');
      }
    }
  }

  for (const header of allWords.filter((word) => normalizeCompact(word.text).includes('담임성명'))) {
    const centerX = header.bbox.x + header.bbox.width / 2;
    const teacherWords = allWords
      .filter((word) => {
        if (!isKoreanName(word.text)) return false;
        const candidateCenterX = word.bbox.x + word.bbox.width / 2;
        const below = word.bbox.y > header.bbox.y + header.bbox.height * 0.5;
        const withinRows = word.bbox.y - header.bbox.y < pageHeight * 0.13;
        const sameColumn = Math.abs(candidateCenterX - centerX) < Math.max(header.bbox.width, pageWidth * 0.045);
        return below && withinRows && sameColumn;
      })
      .sort((a, b) => a.bbox.y - b.bbox.y)
      .slice(0, 3);
    teacherWords.forEach((word) =>
      pushCandidate(candidates, [word], 'homeroom-teacher', normalizeCompact(word.text), '담임성명 열'),
    );
  }

  const columnDefinitions: Array<{
    kind: 'class' | 'student-number';
    labels: RegExp;
    reason: string;
  }> = [
    { kind: 'class', labels: /^(학급|반)$/, reason: '학급(반) 항목' },
    { kind: 'student-number', labels: /^번호$/, reason: '학생 번호 항목' },
  ];
  const identityHeaders = ['학년', '학과', '반', '번호', '담임성명'];
  const activityContext = /자율활동|시수|누계시간|활동내용/;

  for (const definition of columnDefinitions) {
    for (const header of allWords.filter((word) => definition.labels.test(normalizeCompact(word.text)))) {
      const row = lines.find((line) => line.includes(header)) ?? [];
      const rowText = row.map((word) => normalizeCompact(word.text)).join(' ');
      const headerCenterY = header.bbox.y + header.bbox.height / 2;
      const headerBand = allWords.filter((word) =>
        Math.abs(word.bbox.y + word.bbox.height / 2 - headerCenterY) <= Math.max(header.bbox.height, word.bbox.height) * 1.6,
      );
      const tableHeaders = headerBand.filter((word) => identityHeaders.includes(normalizeCompact(word.text)));
      const headerText = tableHeaders.map((word) => normalizeCompact(word.text)).join(' ');
      if (activityContext.test(rowText) || activityContext.test(headerText)) continue;
      const hasClassLabel = tableHeaders.some((word) => /^(학급|반)$/.test(normalizeCompact(word.text)));
      const hasNumberLabel = tableHeaders.some((word) => /^번호$/.test(normalizeCompact(word.text)));
      const isTableHeader = tableHeaders.length >= 3;
      if (definition.kind === 'class' && normalizeCompact(header.text) === '반' && !hasNumberLabel) continue;

      // Footer and identity rows are horizontal. Once paired labels exist on
      // the row, use only the immediately adjacent value and never scan down.
      const horizontalValue = row
        .filter((word) => {
          const value = normalizeCompact(word.text);
          if (!/^\d{1,3}$/.test(value)) return false;
          const centerY = word.bbox.y + word.bbox.height / 2;
          const sameRow = Math.abs(centerY - headerCenterY) <= Math.max(header.bbox.height, word.bbox.height) * 0.8;
          const toRight = word.bbox.x >= header.bbox.x + header.bbox.width - 2;
          const nearby = word.bbox.x - (header.bbox.x + header.bbox.width) <= pageWidth * 0.09;
          return sameRow && toRight && nearby;
        })
        .sort((a, b) => a.bbox.x - b.bbox.x)[0];
      if (horizontalValue) {
        pushCandidate(
          candidates,
          [horizontalValue],
          definition.kind,
          normalizeCompact(horizontalValue.text),
          definition.reason,
        );
      }
      if (hasClassLabel && hasNumberLabel && !isTableHeader) continue;

      // Vertical lookup is reserved for a real student table header. Derive
      // cell boundaries from adjacent headers and select only its first row.
      if (!isTableHeader) continue;
      const orderedHeaders = [...tableHeaders].sort((a, b) => a.bbox.x - b.bbox.x);
      const headerIndex = orderedHeaders.indexOf(header);
      const previous = orderedHeaders[headerIndex - 1];
      const next = orderedHeaders[headerIndex + 1];
      const left = previous ? (previous.bbox.x + previous.bbox.width + header.bbox.x) / 2 : Math.max(0, header.bbox.x - pageWidth * 0.06);
      const right = next ? (header.bbox.x + header.bbox.width + next.bbox.x) / 2 : Math.min(pageWidth, header.bbox.x + header.bbox.width + pageWidth * 0.06);
      const gradeHeader = orderedHeaders.find((item) => normalizeCompact(item.text) === '학년');
      const gradeHeaderIndex = gradeHeader ? orderedHeaders.indexOf(gradeHeader) : -1;
      const gradePrevious = gradeHeaderIndex > 0 ? orderedHeaders[gradeHeaderIndex - 1] : undefined;
      const gradeNext = gradeHeaderIndex >= 0 ? orderedHeaders[gradeHeaderIndex + 1] : undefined;
      const gradeLeft = gradeHeader
        ? (gradePrevious ? (gradePrevious.bbox.x + gradePrevious.bbox.width + gradeHeader.bbox.x) / 2 : Math.max(0, gradeHeader.bbox.x - pageWidth * 0.06))
        : 0;
      const gradeRight = gradeHeader
        ? (gradeNext ? (gradeHeader.bbox.x + gradeHeader.bbox.width + gradeNext.bbox.x) / 2 : Math.min(pageWidth, gradeHeader.bbox.x + gradeHeader.bbox.width + pageWidth * 0.06))
        : 0;
      const gradeRowCenters = gradeHeader
        ? allWords
          .filter((word) => {
            const value = normalizeCompact(word.text);
            const centerX = word.bbox.x + word.bbox.width / 2;
            return /^[1-3]$/.test(value)
              && word.bbox.y > gradeHeader.bbox.y + gradeHeader.bbox.height * 0.5
              && word.bbox.y - gradeHeader.bbox.y < pageHeight * 0.16
              && centerX >= gradeLeft
              && centerX <= gradeRight;
          })
          .sort((a, b) => a.bbox.y - b.bbox.y)
          .slice(0, 3)
          .map((word) => word.bbox.y + word.bbox.height / 2)
        : [];

      const verticalValues = allWords
        .filter((word) => {
          if (!/^\d{1,3}$/.test(normalizeCompact(word.text))) return false;
          const candidateCenterX = word.bbox.x + word.bbox.width / 2;
          const candidateCenterY = word.bbox.y + word.bbox.height / 2;
          const below = word.bbox.y > header.bbox.y + header.bbox.height * 0.5;
          const onGradeRow = gradeRowCenters.length > 0
            ? gradeRowCenters.some((rowCenter) => Math.abs(candidateCenterY - rowCenter) <= Math.max(header.bbox.height, word.bbox.height) * 1.4)
            : word.bbox.y - header.bbox.y < pageHeight * 0.06;
          return below && onGradeRow && candidateCenterX >= left && candidateCenterX <= right;
        })
        .sort((a, b) => a.bbox.y - b.bbox.y);
      const selectedVerticalValues = gradeRowCenters.length > 0 ? verticalValues : verticalValues.slice(0, 1);
      selectedVerticalValues.forEach((verticalValue) =>
        pushCandidate(candidates, [verticalValue], definition.kind, normalizeCompact(verticalValue.text), definition.reason),
      );
    }
  }

  for (const [lineIndex, words] of lines.entries()) {
    const lineText = words.map((word) => word.text).join('');
    const footerMatch = lineText.match(/\/([가-힣]{2,5})\s*$/);
    if (footerMatch && isLikelyFooterOutputter(footerMatch[1]) && words.some((word) => word.bbox.y > pageHeight * 0.88)) {
      const outputterName = footerMatch[1];
      const exactWord = [...words].reverse().find((word) => normalizeCompact(word.text) === outputterName);
      if (exactWord) {
        const characterWidth = exactWord.bbox.width / Math.max(1, outputterName.length);
        pushRectCandidate(
          candidates,
          pageIndex,
          'outputter',
          outputterName,
          '하단 출력 정보의 출력자',
          {
            x: Math.max(0, exactWord.bbox.x - characterWidth - 7),
            y: Math.max(0, exactWord.bbox.y - 5),
            width: exactWord.bbox.width + characterWidth + 14,
            height: exactWord.bbox.height + 10,
          },
          exactWord.confidence,
        );
      } else {
        const containingWord = [...words].reverse().find((word) => word.text.includes(outputterName));
        if (containingWord) {
          const start = containingWord.text.lastIndexOf(outputterName);
          const ratioStart = start / Math.max(1, containingWord.text.length);
          const ratioWidth = outputterName.length / Math.max(1, containingWord.text.length);
          const characterWidth = containingWord.bbox.width / Math.max(1, containingWord.text.length);
          pushRectCandidate(
            candidates,
            pageIndex,
            'outputter',
            outputterName,
            '하단 출력 정보의 출력자',
            {
              x: Math.max(0, containingWord.bbox.x + containingWord.bbox.width * ratioStart - characterWidth - 7),
              y: Math.max(0, containingWord.bbox.y - 5),
              width: containingWord.bbox.width * ratioWidth + characterWidth + 14,
              height: containingWord.bbox.height + 10,
            },
          );
        }
      }
    }

    const outputterLabelIndex = words.findIndex((word) => normalizeCompact(word.text).includes('출력자'));
    if (outputterLabelIndex !== -1) {
      const name = words.slice(outputterLabelIndex + 1).find((word) => isKoreanName(word.text));
      if (name) pushCandidate(candidates, [name], 'outputter', normalizeCompact(name.text), '출력자 항목');
    }

    const lineHasActivityContext = activityContext.test(words.map((candidate) => normalizeCompact(candidate.text)).join(' '));
    words.forEach((word, wordIndex) => {
      const normalized = word.text.normalize('NFKC');
      const identityContext = words.some((candidate) => candidate !== word && /성명|학급|번호|담임성명|학생/.test(normalizeCompact(candidate.text)));
      if (!lineHasActivityContext && identityContext) {
        for (const match of normalized.matchAll(/(\d{1,2})\s*(?:학급|반)/g)) {
          pushWordSliceCandidate(candidates, word, match[1], 'class', '학급(반) 항목');
        }
      }
      if (!lineHasActivityContext && identityContext) {
        for (const match of normalized.matchAll(/(\d{1,3})\s*번(?:호)?/g)) {
          pushWordSliceCandidate(candidates, word, match[1], 'student-number', '학생 번호 항목');
        }
      }

      const compact = normalizeCompact(word.text);
      const adjacentDefinition = columnDefinitions.find((definition) => definition.labels.test(compact));
      if (!adjacentDefinition || lineHasActivityContext) return;
      if (
        adjacentDefinition.kind === 'class' &&
        compact === '반' &&
        !words.some((candidate) => normalizeCompact(candidate.text) === '번호')
      ) {
        return;
      }
      const previous = words[wordIndex - 1];
      const next = words[wordIndex + 1];
      const numeric = [next, previous].find((candidate) => candidate && /^\d{1,3}$/.test(normalizeCompact(candidate.text)));
      if (numeric) {
        pushCandidate(
          candidates,
          [numeric],
          adjacentDefinition.kind,
          normalizeCompact(numeric.text),
          adjacentDefinition.reason,
        );
      }
    });

    const addressLabelIndex = words.findIndex((word) => /^주소:?$/.test(normalizeCompact(word.text)));
    if (addressLabelIndex !== -1) {
      const label = words[addressLabelIndex];
      const labelCenterY = label.bbox.y + label.bbox.height / 2;
      // Government24 exports can assign successive table rows to one PDF text
      // line. Keep the first address row visual rather than logical: otherwise
      // academic-history text below the address becomes one oversized mask.
      const addressWords = words.slice(addressLabelIndex + 1).filter((word) => {
        const centerY = word.bbox.y + word.bbox.height / 2;
        const sameVisualRow = Math.abs(centerY - labelCenterY) <= Math.max(label.bbox.height, word.bbox.height) * 1.15;
        return sameVisualRow && word.bbox.x > label.bbox.x;
      });
      if (addressWords.length > 0) {
        const addressRect = unionRects(addressWords.map((word) => word.bbox), 5);
        const likelyWraps =
          addressWords.length >= 5 || addressRect.x + addressRect.width > pageWidth * 0.72;
        pushRectCandidate(
          candidates,
          pageIndex,
          'address',
          '학생 주소',
          likelyWraps ? '주소 항목(두 줄 범위 포함)' : '주소 항목',
          {
            ...addressRect,
            height: addressRect.height + (likelyWraps ? label.bbox.height * 1.45 : 0),
          },
          Math.round(addressWords.reduce((sum, word) => sum + word.confidence, 0) / addressWords.length),
        );
      }
      for (const continuation of lines.slice(lineIndex + 1, lineIndex + 5)) {
        const lineTop = Math.min(...continuation.map((word) => word.bbox.y));
        const closeBelow = lineTop - label.bbox.y < label.bbox.height * 7.5;
        const addressText = continuation.map((word) => word.text).join('');
        const looksLikeAddress = /(?:도|시|군|구|읍|면|동|리|로|길|번지|아파트|빌라|호)/.test(addressText);
        const continuationWords = continuation.filter((word) => word.bbox.x > label.bbox.x - label.bbox.width * 0.15);
        if (closeBelow && looksLikeAddress && continuationWords.length > 0) {
          pushCandidate(candidates, continuationWords, 'address', '학생 주소', '주소 항목의 이어진 줄');
        }
      }
    }
  }

  if (isSchoolRecord && pageIndex === 0 && pageWidth > 0 && pageHeight > 0) {
    // Prefer the actual image bounds embedded in the PDF. A percentage-based
    // guess is not reliable across student-record export programs and can
    // whiten the area above a portrait instead of the portrait itself.
    const photoImage = (context.imageBounds ?? [])
      .filter((image) => {
        const aspectRatio = image.height / Math.max(1, image.width);
        return (
          image.x >= pageWidth * 0.62 &&
          image.y >= pageHeight * 0.04 &&
          image.y < pageHeight * 0.58 &&
          image.width >= pageWidth * 0.06 &&
          image.height >= pageHeight * 0.08 &&
          aspectRatio >= 1 &&
          aspectRatio <= 1.8
        );
      })
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const photoBounds = photoImage
      ? {
          ...photoImage,
          height: Math.min(pageHeight - photoImage.y, photoImage.height + PHOTO_IMAGE_BOTTOM_PADDING),
        }
      : {
          x: pageWidth * 0.77,
          y: pageHeight * 0.145,
          width: pageWidth * 0.175,
          height: pageHeight * 0.16,
        };
    pushRectCandidate(
      candidates,
      pageIndex,
      'photo',
      '학생 사진',
      photoImage ? 'PDF에 포함된 학생 사진 영역' : '학교생활기록부 사진 영역(추정)',
      photoBounds,
      95,
    );
  }
}

function wordFromGlyphs(template: OcrWord, glyphs: TextGlyph[]): OcrWord {
  return {
    ...template,
    id: `${template.id}-glyph-slice-${glyphs[0]?.id ?? 'empty'}`,
    text: glyphs.map((glyph) => glyph.text).join(''),
    bbox: unionRects(glyphs.map((glyph) => glyph.bbox)),
    glyphs,
  };
}

function findCorrectionLedgerFields(allWords: OcrWord[], candidates: RedactionCandidate[]): void {
  if (!allWords.some((word) => normalizeCompact(word.text).includes('정정대장'))) return;

  const glyphs = allWords.flatMap((word) => word.glyphs);
  const nameHeaderStart = glyphs.find((glyph) =>
    glyph.text === '성' && glyphs.some((next) =>
      next.text === '명' &&
      next.bbox.x > glyph.bbox.x &&
      next.bbox.x - glyph.bbox.x < 30 &&
      Math.abs(next.bbox.y - glyph.bbox.y) < 8,
    ),
  );
  if (!nameHeaderStart) return;
  const nameHeaderEnd = glyphs.find((glyph) =>
    glyph.text === '명' &&
    glyph.bbox.x > nameHeaderStart.bbox.x &&
    glyph.bbox.x - nameHeaderStart.bbox.x < 30 &&
    Math.abs(glyph.bbox.y - nameHeaderStart.bbox.y) < 8,
  );
  const nextColumnHeader = glyphs.find((glyph) =>
    glyph.text === '항' &&
    glyph.bbox.x > (nameHeaderEnd?.bbox.x ?? nameHeaderStart.bbox.x) &&
    glyph.bbox.x - (nameHeaderEnd?.bbox.x ?? nameHeaderStart.bbox.x) < 80 &&
    Math.abs(glyph.bbox.y - nameHeaderStart.bbox.y) < 8,
  );
  if (!nameHeaderEnd || !nextColumnHeader) return;

  const nameColumnLeft = nameHeaderStart.bbox.x - 8;
  const nameColumnRight = (nameHeaderEnd.bbox.x + nameHeaderEnd.bbox.width + nextColumnHeader.bbox.x) / 2;
  const classRows = allWords.filter((word) => /(\d{1,2})\s*반/.test(word.text.normalize('NFKC')));

  for (const classWord of classRows) {
    const classMatch = classWord.text.normalize('NFKC').match(/(\d{1,2})\s*반/);
    if (!classMatch) continue;
    pushWordSliceCandidate(candidates, classWord, classMatch[1], 'class', '정정대장 학급(반) 열');

    const inlineNumber = classWord.text.normalize('NFKC').match(/\d{1,2}\s*반\s*(\d{1,3})\s*번?/);
    if (inlineNumber) {
      pushWordSliceCandidate(candidates, classWord, inlineNumber[1], 'student-number', '정정대장 번호 열');
    }

    const classCenterY = classWord.bbox.y + classWord.bbox.height / 2;
    const numberWord = allWords.find((word) => {
      if (word.id === classWord.id) return false;
      const value = word.text.normalize('NFKC');
      if (!/^(\d{1,3})\s*번?$/.test(value)) return false;
      const centerY = word.bbox.y + word.bbox.height / 2;
      return (
        Math.abs(centerY - classCenterY) <= Math.max(classWord.bbox.height, word.bbox.height) * 1.4 &&
        word.bbox.x >= classWord.bbox.x - classWord.bbox.width * 1.2 &&
        word.bbox.x < nameColumnLeft
      );
    });
    const numberMatch = numberWord?.text.normalize('NFKC').match(/^(\d{1,3})\s*번?$/);
    if (numberWord && numberMatch) {
      pushWordSliceCandidate(candidates, numberWord, numberMatch[1], 'student-number', '정정대장 번호 열');
    }

    const nameGlyphs = glyphs.filter((glyph) => {
      const centerY = glyph.bbox.y + glyph.bbox.height / 2;
      const onRow = Math.abs(centerY - classCenterY) <= Math.max(classWord.bbox.height, glyph.bbox.height) * 1.8;
      const inNameColumn = glyph.bbox.x >= nameColumnLeft && glyph.bbox.x + glyph.bbox.width <= nameColumnRight;
      return onRow && inNameColumn && /^[가-힣]$/.test(glyph.text);
    });
    const name = nameGlyphs.map((glyph) => glyph.text).join('');
    if (isKoreanName(name)) {
      pushCandidate(candidates, [wordFromGlyphs(classWord, nameGlyphs)], 'student-name', name, '정정대장 성명 열');
    }
  }
}

export function detectCandidates(
  words: OcrWord[],
  enteredNames: string[],
  context: DetectionContext = {},
): RedactionCandidate[] {
  const candidates: RedactionCandidate[] = [];
  const lines = lineGroups(words);
  findResidentIds(lines, candidates);
  findEnteredNames(lines, enteredNames, candidates);
  findDetectedNames(lines, words, candidates);
  findSchoolRecordFields(lines, words, candidates, context);
  findGovernment24Fields(lines, words, candidates, context);
  findCorrectionLedgerFields(words, candidates);
  return candidates;
}

export function mergeAutomaticCandidates(
  words: OcrWord[],
  enteredNames: string[],
  previous: RedactionCandidate[],
  context: DetectionContext = {},
): RedactionCandidate[] {
  return [...detectCandidates(words, enteredNames, context), ...previous.filter((item) => item.kind === 'manual')];
}

export function sanitizeDownloadName(originalName: string): string {
  const withoutExtension = originalName.replace(/\.pdf$/i, '').trim() || '문서';
  const invalidFilenameCharacters = '<>:"/\\|?*';
  const safe = Array.from(withoutExtension, (character) =>
    character.charCodeAt(0) < 32 || invalidFilenameCharacters.includes(character) ? '_' : character,
  ).join('');
  return `${safe}_비식별화.pdf`;
}

export function validateEnteredNames(values: unknown): string[] {
  if (!Array.isArray(values)) throw new Error('이름 목록은 배열이어야 합니다.');
  if (values.length > 20) throw new Error('이름은 최대 20개까지 설정할 수 있습니다.');
  const names = values.map((value) => {
    if (typeof value !== 'string') throw new Error('이름은 문자열이어야 합니다.');
    const trimmed = value.trim();
    if (trimmed.length < 2 || trimmed.length > 20) {
      throw new Error('각 이름은 2자 이상 20자 이하여야 합니다.');
    }
    return trimmed;
  });
  return [...new Set(names)];
}
