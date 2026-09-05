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
  quad: PdfQuad;
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
  pageIndex: number;
  pdfWidth: number;
  pdfHeight: number;
  renderWidth: number;
  renderHeight: number;
  imageUrl: string;
  imageType: 'image/jpeg' | 'image/png';
  words: OcrWord[];
  redactions: RedactionCandidate[];
  reviewed: boolean;
}

const LABELS = ['성명', '이름', '신청인', '신청자', '민원인', '대표자', '보호자'];

export interface DetectionContext {
  pageWidth?: number;
  pageHeight?: number;
  imageBounds?: CanvasRect[];
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
  const rect = unionRects(words.map((word) => word.bbox), 4);
  const duplicate = candidates.some(
    (candidate) =>
      candidate.kind === kind &&
      Math.abs(candidate.x - rect.x) < 3 &&
      Math.abs(candidate.y - rect.y) < 3 &&
      Math.abs(candidate.width - rect.width) < 6,
  );
  if (duplicate) return;

  const glyphs = words.flatMap((word) => word.glyphs);

  candidates.push({
    id: `${words[0].pageIndex}-${kind}-${candidates.length}-${Math.round(rect.x)}-${Math.round(rect.y)}`,
    pageIndex: words[0].pageIndex,
    kind,
    sourceText,
    confidence: Math.round(words.reduce((sum, word) => sum + word.confidence, 0) / words.length),
    selected: true,
    reason,
    targetGlyphIds: glyphs.map((glyph) => glyph.id),
    targetQuads: glyphs.map((glyph) => ({ source: glyph.source, quad: glyph.quad, text: glyph.text })),
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
  const rect = {
    x: Math.max(0, word.bbox.x + characterWidth * start - leftPadding),
    y: Math.max(0, word.bbox.y - 5),
    width: characterWidth * slice.length + leftPadding + rightPadding,
    height: word.bbox.height + 10,
  };
  const before = candidates.length;
  pushRectCandidate(candidates, word.pageIndex, kind, slice, reason, rect, word.confidence);
  const candidate = candidates.length > before ? candidates.at(-1) : undefined;
  if (candidate && selectedGlyphs.length === slice.length) {
    candidate.targetGlyphIds = selectedGlyphs.map((glyph) => glyph.id);
    candidate.targetQuads = selectedGlyphs.map((glyph) => ({ source: glyph.source, quad: glyph.quad, text: glyph.text }));
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
      const label = LABELS.find((candidate) => normalized.startsWith(candidate));
      if (!label) return;

      const inlineValue = normalized.slice(label.length);
      const kind: RedactionKind = label === '성명' ? 'student-name' : 'detected-name';
      if (isKoreanName(inlineValue)) {
        pushWordSliceCandidate(candidates, word, inlineValue, kind, `${label} 항목 주변`);
        return;
      }

      const sameLine = words.slice(index + 1).find((candidate) => isKoreanName(candidate.text));
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
        if (!isKoreanName(candidate.text) || candidate.id === word.id) return false;
        const candidateCenterY = candidate.bbox.y + candidate.bbox.height / 2;
        const onSameRow = Math.abs(candidateCenterY - anchorCenterY) <= word.bbox.height * 1.5;
        const justBelow =
          candidate.bbox.y > word.bbox.y &&
          candidate.bbox.y - word.bbox.y <= word.bbox.height * 3 &&
          Math.abs(candidate.bbox.x - word.bbox.x) <= word.bbox.width * 2;
        return (onSameRow && candidate.bbox.x > word.bbox.x) || justBelow;
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
  const isSchoolRecord = /학교생활(?:세부사항)?기록부|대입전형자료/.test(documentText);

  const ignoredSchoolLabels = new Set(['출신중학교', '출신고등학교', '전입학교', '졸업학교']);
  for (const word of allWords) {
    const source = word.text.normalize('NFKC');
    for (const match of source.matchAll(/[가-힣A-Za-z0-9·.-]{2,}(?:초등학교|중학교|고등학교)/g)) {
      if (ignoredSchoolLabels.has(normalizeCompact(match[0])) || /학교생활/.test(match[0])) continue;
      pushWordSliceCandidate(candidates, word, match[0], 'school-name', '학교명 또는 출신학교명', 8, 6);
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

  for (const definition of columnDefinitions) {
    for (const header of allWords.filter((word) => definition.labels.test(normalizeCompact(word.text)))) {
      const centerX = header.bbox.x + header.bbox.width / 2;
      const values = allWords
        .filter((word) => {
          if (!/^\d{1,3}$/.test(normalizeCompact(word.text))) return false;
          const candidateCenterX = word.bbox.x + word.bbox.width / 2;
          const below = word.bbox.y > header.bbox.y + header.bbox.height * 0.5;
          const withinRows = word.bbox.y - header.bbox.y < pageHeight * 0.13;
          const sameColumn = Math.abs(candidateCenterX - centerX) < Math.max(header.bbox.width, pageWidth * 0.025);
          return below && withinRows && sameColumn;
        })
        .sort((a, b) => a.bbox.y - b.bbox.y)
        .slice(0, 3);
      values.forEach((word) =>
        pushCandidate(candidates, [word], definition.kind, normalizeCompact(word.text), definition.reason),
      );
    }
  }

  for (const [lineIndex, words] of lines.entries()) {
    const lineText = words.map((word) => word.text).join('');
    const footerMatch = lineText.match(/\/([가-힣]{2,5})\s*$/);
    if (footerMatch && words.some((word) => word.bbox.y > pageHeight * 0.88)) {
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

    words.forEach((word, wordIndex) => {
      const normalized = word.text.normalize('NFKC');
      for (const match of normalized.matchAll(/(\d{1,2})\s*(?:학급|반)/g)) {
        pushWordSliceCandidate(candidates, word, match[1], 'class', '학급(반) 항목');
      }
      for (const match of normalized.matchAll(/(\d{1,3})\s*번(?:호)?/g)) {
        pushWordSliceCandidate(candidates, word, match[1], 'student-number', '학생 번호 항목');
      }

      const compact = normalizeCompact(word.text);
      const adjacentDefinition = columnDefinitions.find((definition) => definition.labels.test(compact));
      if (!adjacentDefinition) return;
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
      const addressWords = words.slice(addressLabelIndex + 1).filter((word) => word.bbox.x > words[addressLabelIndex].bbox.x);
      const label = words[addressLabelIndex];
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
    pushRectCandidate(
      candidates,
      pageIndex,
      'photo',
      '학생 사진',
      photoImage ? 'PDF에 포함된 학생 사진 영역' : '학교생활기록부 사진 영역(추정)',
      photoImage ?? {
        x: pageWidth * 0.77,
        y: pageHeight * 0.145,
        width: pageWidth * 0.175,
        height: pageHeight * 0.16,
      },
      95,
    );
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
