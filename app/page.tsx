'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Download,
  FileText,
  Grip,
  LockKeyhole,
  ListChecks,
  Plus,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  SquareDashedMousePointer,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Progress,
  ProgressLabel,
} from '@/components/ui/progress';
import {
  exportRedactedPdf,
  ProcessingCancelledError,
  startPdfAnalysis,
  type AnalysisTask,
} from '@/lib/pdf-processing';
import {
  mergeAutomaticCandidates,
  sanitizeDownloadName,
  validateEnteredNames,
  type CanvasRect,
  type PageReviewState,
  type ProcessingStage,
  type RedactionCandidate,
  type RedactionKind,
} from '@/lib/redaction';

type Gesture = {
  pointerId: number;
  mode: 'draw' | 'move' | 'resize';
  start: { x: number; y: number };
  redactionId?: string;
  original?: CanvasRect;
};

const kindLabels: Record<RedactionKind, string> = {
  'resident-id': '주민번호',
  'entered-name': '입력 이름',
  'detected-name': '이름 후보',
  'student-name': '학생 성명',
  'homeroom-teacher': '담임 성명',
  outputter: '출력자',
  address: '학생 주소',
  photo: '학생 사진',
  'school-name': '학교명',
  class: '학급(반)',
  'student-number': '학생 번호',
  manual: '수동 영역',
};

const kindStyles: Record<RedactionKind, string> = {
  'resident-id': 'border-rose-200 bg-rose-50 text-rose-700',
  'entered-name': 'border-blue-200 bg-blue-50 text-blue-700',
  'detected-name': 'border-amber-200 bg-amber-50 text-amber-800',
  'student-name': 'border-violet-200 bg-violet-50 text-violet-700',
  'homeroom-teacher': 'border-sky-200 bg-sky-50 text-sky-700',
  outputter: 'border-cyan-200 bg-cyan-50 text-cyan-700',
  address: 'border-orange-200 bg-orange-50 text-orange-700',
  photo: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700',
  'school-name': 'border-emerald-200 bg-emerald-50 text-emerald-700',
  class: 'border-lime-200 bg-lime-50 text-lime-800',
  'student-number': 'border-teal-200 bg-teal-50 text-teal-700',
  manual: 'border-zinc-200 bg-zinc-100 text-zinc-700',
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function Header({ onReset, hasDocument }: { onReset: () => void; hasDocument: boolean }) {
  const sourceCommit = __SOURCE_COMMIT__;
  return (
    <header className="border-b border-border/80 bg-background/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-[15px] font-bold tracking-[-0.02em]">가림PDF</p>
            <p className="text-[11px] text-muted-foreground">학교생활기록부 비식별화 도구</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            className="hidden text-xs font-semibold text-muted-foreground underline-offset-4 hover:text-foreground hover:underline md:inline"
            href={`https://github.com/sukminpark/RedactPDF/tree/${sourceCommit}`}
            target="_blank"
            rel="noreferrer"
          >
            공개 소스 {sourceCommit.slice(0, 7)}
          </a>
          {hasDocument && (
            <Button variant="ghost" className="hidden sm:inline-flex" onClick={onReset}>
              <RotateCcw aria-hidden="true" />새 문서
            </Button>
          )}
          <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800">
            <LockKeyhole className="size-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">브라우저에서만 처리</span>
            <span className="sm:hidden">로컬 처리</span>
          </div>
        </div>
      </div>
    </header>
  );
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const analysisTaskRef = useRef<AnalysisTask | null>(null);
  const pagesRef = useRef<PageReviewState[]>([]);
  const gestureRef = useRef<Gesture | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [pages, setPages] = useState<PageReviewState[]>([]);
  const [enteredNames, setEnteredNames] = useState<string[]>([]);
  const [nameInput, setNameInput] = useState('');
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [stage, setStage] = useState<ProcessingStage>('idle');
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [zoom, setZoom] = useState(0.46);
  const [draftRect, setDraftRect] = useState<CanvasRect | null>(null);
  const [isSummaryOpen, setIsSummaryOpen] = useState(false);

  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  const releasePageUrls = useCallback((states: PageReviewState[]) => {
    states.forEach((page) => URL.revokeObjectURL(page.imageUrl));
  }, []);

  useEffect(
    () => () => {
      void analysisTaskRef.current?.cancel();
      releasePageUrls(pagesRef.current);
    },
    [releasePageUrls],
  );

  const configureNames = useCallback((names: string[]) => {
    setEnteredNames(names);
    setPages((current) =>
      current.map((page) => ({
        ...page,
        reviewed: false,
        redactions: mergeAutomaticCandidates(page.words, names, page.redactions, {
          pageWidth: page.renderWidth,
          pageHeight: page.renderHeight,
        }),
      })),
    );
  }, []);
  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(
      context.registerTool(
        {
          name: 'configure_redaction_names',
          title: '삭제할 이름 설정',
          description: 'PDF에서 우선 탐지할 이름 목록을 화면에 설정합니다. 파일 선택과 검토는 사용자가 직접 합니다.',
          inputSchema: {
            type: 'object',
            properties: {
              names: {
                type: 'array',
                items: { type: 'string', minLength: 2, maxLength: 20 },
                maxItems: 20,
              },
            },
            required: ['names'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute(input: unknown) {
            if (!input || typeof input !== 'object' || !('names' in input)) {
              throw new Error('names 배열이 필요합니다.');
            }
            const names = validateEnteredNames((input as { names: unknown }).names);
            configureNames(names);
            return { configuredCount: names.length, names };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);
    return () => lifecycle.abort();
  }, [configureNames]);

  const resetDocument = useCallback(async () => {
    await analysisTaskRef.current?.cancel();
    analysisTaskRef.current = null;
    releasePageUrls(pagesRef.current);
    pagesRef.current = [];
    setPages([]);
    setFile(null);
    setStage('idle');
    setProgress(0);
    setProgressMessage('');
    setError(null);
    setCurrentPageIndex(0);
    setManualMode(false);
    setDraftRect(null);
    setIsSummaryOpen(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [releasePageUrls]);

  const processFile = useCallback(
    async (nextFile: File) => {
      await analysisTaskRef.current?.cancel();
      releasePageUrls(pagesRef.current);
      pagesRef.current = [];
      setPages([]);
      setFile(nextFile);
      setError(null);
      setProgress(0);
      setStage('loading');
      setCurrentPageIndex(0);

      const task = startPdfAnalysis(nextFile, enteredNames, (nextProgress) => {
        setStage(nextProgress.stage);
        setProgress(nextProgress.progress);
        setProgressMessage(nextProgress.message);
      });
      analysisTaskRef.current = task;
      try {
        const nextPages = await task.run;
        pagesRef.current = nextPages;
        setPages(nextPages);
        setStage('review');
      } catch (processingError) {
        if (processingError instanceof ProcessingCancelledError) {
          setStage('cancelled');
          setProgressMessage('처리를 취소했어요.');
        } else {
          setStage('error');
          setError(
            processingError instanceof Error
              ? processingError.message
              : 'PDF를 처리하는 중 알 수 없는 오류가 발생했습니다.',
          );
        }
      } finally {
        analysisTaskRef.current = null;
      }
    },
    [enteredNames, releasePageUrls],
  );

  const handleDroppedFile = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      event.preventDefault();
      setIsDraggingFile(false);
      const droppedFile = event.dataTransfer.files[0];
      if (droppedFile) void processFile(droppedFile);
    },
    [processFile],
  );

  const addName = useCallback(() => {
    const value = nameInput.trim();
    if (value.length < 2 || value.length > 20 || enteredNames.includes(value)) return;
    configureNames([...enteredNames, value]);
    setNameInput('');
  }, [configureNames, enteredNames, nameInput]);

  const currentPage = pages[currentPageIndex];
  const allReviewed = pages.length > 0 && pages.every((page) => page.reviewed);
  const selectedCount = useMemo(
    () => pages.reduce((count, page) => count + page.redactions.filter((item) => item.selected).length, 0),
    [pages],
  );

  const updateCurrentPage = useCallback(
    (updater: (page: PageReviewState) => PageReviewState) => {
      setPages((current) =>
        current.map((page, index) => (index === currentPageIndex ? updater(page) : page)),
      );
    },
    [currentPageIndex],
  );

  const updateRedactionOnPage = useCallback(
    (
      pageIndex: number,
      id: string,
      updater: (redaction: RedactionCandidate) => RedactionCandidate,
    ) => {
      setPages((current) =>
        current.map((page) =>
          page.pageIndex === pageIndex
            ? {
                ...page,
                reviewed: false,
                redactions: page.redactions.map((redaction) =>
                  redaction.id === id ? updater(redaction) : redaction,
                ),
              }
            : page,
        ),
      );
    },
    [],
  );

  const updateRedaction = useCallback(
    (id: string, updater: (redaction: RedactionCandidate) => RedactionCandidate) => {
      updateRedactionOnPage(currentPageIndex, id, updater);
    },
    [currentPageIndex, updateRedactionOnPage],
  );

  const pointInCanvas = useCallback((event: ReactPointerEvent): { x: number; y: number } => {
    const bounds = overlayRef.current?.getBoundingClientRect();
    if (!bounds || !currentPage) return { x: 0, y: 0 };
    return {
      x: clamp(((event.clientX - bounds.left) / bounds.width) * currentPage.renderWidth, 0, currentPage.renderWidth),
      y: clamp(((event.clientY - bounds.top) / bounds.height) * currentPage.renderHeight, 0, currentPage.renderHeight),
    };
  }, [currentPage]);

  const beginDraw = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!manualMode || !currentPage) return;
      const start = pointInCanvas(event);
      overlayRef.current?.setPointerCapture(event.pointerId);
      gestureRef.current = { pointerId: event.pointerId, mode: 'draw', start };
      setDraftRect({ x: start.x, y: start.y, width: 0, height: 0 });
    },
    [currentPage, manualMode, pointInCanvas],
  );

  const beginRedactionGesture = useCallback(
    (event: ReactPointerEvent, redaction: RedactionCandidate, mode: 'move' | 'resize') => {
      event.preventDefault();
      event.stopPropagation();
      const start = pointInCanvas(event);
      overlayRef.current?.setPointerCapture(event.pointerId);
      gestureRef.current = {
        pointerId: event.pointerId,
        mode,
        start,
        redactionId: redaction.id,
        original: {
          x: redaction.x,
          y: redaction.y,
          width: redaction.width,
          height: redaction.height,
        },
      };
    },
    [pointInCanvas],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || !currentPage || gesture.pointerId !== event.pointerId) return;
      const point = pointInCanvas(event);
      if (gesture.mode === 'draw') {
        setDraftRect({
          x: Math.min(point.x, gesture.start.x),
          y: Math.min(point.y, gesture.start.y),
          width: Math.abs(point.x - gesture.start.x),
          height: Math.abs(point.y - gesture.start.y),
        });
        return;
      }
      if (!gesture.redactionId || !gesture.original) return;
      const dx = point.x - gesture.start.x;
      const dy = point.y - gesture.start.y;
      const original = gesture.original;
      updateRedaction(gesture.redactionId, (redaction) =>
        gesture.mode === 'move'
          ? {
              ...redaction,
              selectionMode: 'region',
              x: clamp(original.x + dx, 0, currentPage.renderWidth - original.width),
              y: clamp(original.y + dy, 0, currentPage.renderHeight - original.height),
            }
          : {
              ...redaction,
              selectionMode: 'region',
              width: clamp(original.width + dx, 16, currentPage.renderWidth - original.x),
              height: clamp(original.height + dy, 12, currentPage.renderHeight - original.y),
            },
      );
    },
    [currentPage, pointInCanvas, updateRedaction],
  );

  const finishGesture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId || !currentPage) return;
      overlayRef.current?.releasePointerCapture(event.pointerId);
      if (gesture.mode === 'draw' && draftRect && draftRect.width >= 8 && draftRect.height >= 8) {
        const manual: RedactionCandidate = {
          id: `manual-${crypto.randomUUID()}`,
          pageIndex: currentPageIndex,
          kind: 'manual',
          sourceText: '직접 지정한 영역',
          confidence: 100,
          selected: true,
          reason: '사용자가 직접 지정',
          targetGlyphIds: [],
          targetQuads: [],
          selectionMode: 'region',
          ...draftRect,
        };
        updateCurrentPage((page) => ({
          ...page,
          reviewed: false,
          redactions: [...page.redactions, manual],
        }));
      }
      gestureRef.current = null;
      setDraftRect(null);
    },
    [currentPage, currentPageIndex, draftRect, updateCurrentPage],
  );

  const downloadResult = useCallback(async (approveAllPages = false) => {
    const pagesToExport = approveAllPages
      ? pages.map((page) => ({ ...page, reviewed: true }))
      : pages;
    const ready = pagesToExport.length > 0 && pagesToExport.every((page) => page.reviewed);
    const exportSelectionCount = pagesToExport.reduce(
      (count, page) => count + page.redactions.filter((item) => item.selected).length,
      0,
    );
    if (!file || !ready || exportSelectionCount === 0) return;
    if (approveAllPages) {
      setPages(pagesToExport);
      setIsSummaryOpen(false);
    }
    setError(null);
    try {
      const bytes = await exportRedactedPdf(
        await file.arrayBuffer(),
        pagesToExport,
        (nextProgress) => {
          setStage(nextProgress.stage);
          setProgress(nextProgress.progress);
          setProgressMessage(nextProgress.message);
        },
      );
      const outputBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const blob = new Blob([outputBuffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const anchor = Object.assign(document.createElement('a'), {
        href: url,
        download: sanitizeDownloadName(file.name),
      });
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setStage('complete');
    } catch (exportError) {
      setStage('review');
      setError(exportError instanceof Error ? exportError.message : '새 PDF를 만들지 못했습니다.');
    }
  }, [file, pages]);

  const isProcessing = ['loading', 'rendering', 'ocr'].includes(stage);
  const isWorkspace = pages.length > 0;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <Header onReset={() => void resetDocument()} hasDocument={Boolean(file)} />

      {!isWorkspace ? (
        <section className="mx-auto grid max-w-[1480px] gap-8 px-5 py-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)] lg:px-8 lg:py-12">
          <div className="flex min-h-[610px] flex-col rounded-[28px] border border-border bg-card p-6 shadow-[0_22px_70px_rgba(28,34,31,0.08)] sm:p-9">
            <div className="mb-7 flex items-start justify-between gap-4">
              <div>
                <p className="mb-2 text-sm font-medium text-muted-foreground sm:text-base">학교생활기록부, 대입전형자료</p>
                <h1 className="max-w-xl text-3xl font-bold tracking-[-0.045em] sm:text-4xl">
                  개인정보를 지우고,
                  <br />안전한 파일로 다시 만드세요.
                </h1>
              </div>
              <span className="hidden size-12 place-items-center rounded-2xl bg-secondary text-primary sm:grid">
                <ScanSearch className="size-6" aria-hidden="true" />
              </span>
            </div>

            {isProcessing ? (
              <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-border bg-muted/45 px-6 py-14 text-center">
                <span className="relative mb-6 grid size-20 place-items-center rounded-3xl bg-background shadow-sm">
                  <FileText className="size-9 text-primary" aria-hidden="true" />
                  <span className="absolute -right-1 -top-1 size-4 animate-pulse rounded-full border-2 border-background bg-emerald-500" />
                </span>
                <h2 className="text-lg font-bold">{file?.name}</h2>
                <p className="mt-2 text-sm text-muted-foreground">{progressMessage}</p>
                <Progress className="mt-7 w-full max-w-md" value={progress}>
                  <ProgressLabel>로컬 처리 중</ProgressLabel>
                  <span className="ml-auto text-sm tabular-nums text-muted-foreground">{progress}%</span>
                </Progress>
                <Button
                  variant="outline"
                  className="mt-7"
                  onClick={() => void analysisTaskRef.current?.cancel()}
                >
                  처리 취소
                </Button>
              </div>
            ) : (
              <button
                type="button"
                className={`group flex flex-1 flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition ${
                  isDraggingFile
                    ? 'border-primary bg-primary/[0.06]'
                    : 'border-border bg-muted/45 hover:border-primary/50 hover:bg-muted/70'
                }`}
                onClick={() => fileInputRef.current?.click()}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setIsDraggingFile(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setIsDraggingFile(false)}
                onDrop={handleDroppedFile}
              >
                <span className="mb-5 grid size-16 place-items-center rounded-2xl border border-border bg-background shadow-sm transition group-hover:-translate-y-1">
                  <FileText className="size-7 text-primary" aria-hidden="true" />
                </span>
                <span className="text-lg font-bold">PDF 파일을 여기에 놓으세요</span>
                <span className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                  문서는 서버로 전송하지 않고 이 기기 안에서만 분석합니다.
                </span>
                <span className="mt-5 max-w-lg rounded-xl border border-border bg-background/80 px-4 py-3 text-left">
                  <span className="block text-xs font-bold text-foreground">자동 식별 내역</span>
                  <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">
                    학생 성명 · 주민등록번호 · 주소 · 사진 · 담임 성명 · 출력자 · 학교명(출신중학교 포함) · 학급(반) · 번호
                  </span>
                </span>
                <span className="mt-3 text-xs text-muted-foreground">PDF 1개 · 최대 50MB · 최대 50쪽</span>
                <span className="mt-6 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm">
                  파일 선택
                </span>
              </button>
            )}
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => {
                const nextFile = event.target.files?.[0];
                if (nextFile) void processFile(nextFile);
              }}
            />
            {error && (
              <div role="alert" className="mt-4 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <div className="flex-1">
                  <p className="font-semibold">문서를 열지 못했어요</p>
                  <p className="mt-1 text-red-700">{error}</p>
                </div>
              </div>
            )}
            {stage === 'cancelled' && (
              <p className="mt-4 text-center text-sm text-muted-foreground">처리를 취소했습니다. 다른 파일을 선택할 수 있어요.</p>
            )}
          </div>

          <aside className="space-y-5">
            <section className="rounded-[24px] border border-border bg-card p-6 shadow-[0_18px_50px_rgba(28,34,31,0.06)]">
              <div className="mb-5 flex items-center gap-3">
                <span className="grid size-9 place-items-center rounded-xl bg-secondary text-primary">
                  <Plus className="size-4" aria-hidden="true" />
                </span>
                <div>
                  <h2 className="font-bold">추가로 찾을 이름</h2>
                  <p className="text-xs text-muted-foreground">학생·교직원 이름을 더 입력하면 문서 전체에서 찾습니다.</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Input
                  className="h-10 bg-background"
                  value={nameInput}
                  maxLength={20}
                  placeholder="예: 홍길동"
                  aria-label="삭제할 이름"
                  onChange={(event) => setNameInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') addName();
                  }}
                />
                <Button className="h-10 px-4" disabled={nameInput.trim().length < 2} onClick={addName}>추가</Button>
              </div>
              {enteredNames.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {enteredNames.map((name) => (
                    <span key={name} className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-xs font-semibold text-secondary-foreground">
                      {name}
                      <button
                        type="button"
                        aria-label={`${name} 삭제`}
                        className="rounded-full p-0.5 hover:bg-primary/10"
                        onClick={() => configureNames(enteredNames.filter((item) => item !== name))}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-[24px] border border-emerald-200 bg-emerald-50/70 p-6">
              <div className="mb-4 flex items-center gap-3 text-emerald-900">
                <ShieldCheck className="size-5" aria-hidden="true" />
                <h2 className="font-bold">원본은 밖으로 나가지 않아요</h2>
              </div>
              <p className="text-sm leading-6 text-emerald-950/70">
                업로드, 서버 저장, 분석 기록 없이 이 브라우저 안에서만 문서를 처리합니다. 창을 닫으면 작업 내용도 함께 사라집니다.
              </p>
            </section>

            <div className="grid grid-cols-3 gap-3 text-center">
              {[
                ['1', '파일 열기'],
                ['2', '후보 검토'],
                ['3', '새 PDF 저장'],
              ].map(([number, label]) => (
                <div key={number} className="rounded-2xl border border-border bg-card px-2 py-4">
                  <span className="mx-auto mb-2 grid size-7 place-items-center rounded-full bg-secondary text-xs font-bold text-primary">{number}</span>
                  <span className="text-xs font-semibold text-muted-foreground">{label}</span>
                </div>
              ))}
            </div>
          </aside>
        </section>
      ) : (
        <section className="mx-auto max-w-[1600px] px-3 py-4 sm:px-5 lg:px-8">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3 shadow-sm">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-secondary text-primary">
                <FileText className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold">{file?.name}</p>
                <p className="text-xs text-muted-foreground">{pages.length}쪽 · 삭제 영역 {selectedCount}개</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge className={allReviewed ? 'bg-emerald-600 text-white' : 'bg-amber-100 text-amber-800'}>
                {allReviewed ? <Check className="size-3" /> : null}
                {pages.filter((page) => page.reviewed).length}/{pages.length}쪽 검토
              </Badge>
              <Button variant="outline" className="h-9 px-4" onClick={() => setIsSummaryOpen(true)}>
                <ListChecks aria-hidden="true" />
                전체 검토
              </Button>
              <Button
                className="h-9 px-4"
                disabled={!allReviewed || selectedCount === 0 || stage === 'exporting'}
                onClick={() => void downloadResult()}
              >
                <Download aria-hidden="true" />
                {stage === 'exporting' ? `${progress}%` : '비식별화 PDF 저장'}
              </Button>
            </div>
          </div>

          {error && (
            <div role="alert" className="mb-4 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <AlertCircle className="size-4" aria-hidden="true" />{error}
            </div>
          )}
          {stage === 'complete' && (
            <div aria-live="polite" className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
              <CheckCircle2 className="size-4" aria-hidden="true" />새 PDF를 저장했습니다. 원본은 변경되지 않았어요.
            </div>
          )}

          <div className="grid min-h-[calc(100vh-160px)] items-start overflow-visible rounded-[24px] border border-border bg-card shadow-[0_20px_65px_rgba(28,34,31,0.09)] lg:grid-cols-[170px_minmax(0,1fr)_320px]">
            <aside className="hidden border-r border-border bg-muted/35 p-3 lg:sticky lg:top-4 lg:flex lg:h-[calc(100vh-2rem)] lg:flex-col lg:rounded-l-[24px]">
              <p className="px-2 pb-3 pt-1 text-xs font-bold text-muted-foreground">페이지</p>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                {pages.map((page) => (
                  <button
                    key={page.pageIndex}
                    type="button"
                    className={`w-full rounded-xl border p-2 text-left transition ${
                      currentPageIndex === page.pageIndex
                        ? 'border-primary bg-background shadow-sm'
                        : 'border-transparent hover:border-border hover:bg-background/70'
                    }`}
                    onClick={() => setCurrentPageIndex(page.pageIndex)}
                  >
                    <div className="relative overflow-hidden rounded-md border border-border bg-white">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img className="aspect-[0.707] w-full object-contain" src={page.imageUrl} alt={`${page.pageIndex + 1}쪽 미리보기`} />
                      {page.reviewed && (
                        <span className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-emerald-600 text-white shadow">
                          <Check className="size-3" />
                        </span>
                      )}
                    </div>
                    <p className="mt-2 text-center text-xs font-semibold">{page.pageIndex + 1}쪽</p>
                  </button>
                ))}
              </div>
            </aside>

            <div className="flex min-w-0 flex-col bg-[#222825]">
              <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b border-white/10 px-3 py-2 text-white sm:px-4">
                <div className="flex items-center gap-1">
                  <Button
                    variant={manualMode ? 'secondary' : 'ghost'}
                    className={manualMode ? 'bg-white text-zinc-900 hover:bg-white/90' : 'text-white hover:bg-white/10 hover:text-white'}
                    onClick={() => setManualMode((value) => !value)}
                  >
                    <SquareDashedMousePointer aria-hidden="true" />영역 직접 추가
                  </Button>
                  <span className="hidden text-xs text-white/55 sm:inline">{manualMode ? '문서 위를 드래그하세요' : '영역을 눌러 이동·크기 조절'}</span>
                </div>
                <div className="flex items-center gap-1 rounded-lg bg-black/20 p-1">
                  <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label="축소" onClick={() => setZoom((value) => clamp(value - 0.08, 0.25, 1))}>
                    <ZoomOut />
                  </Button>
                  <span className="w-12 text-center text-xs tabular-nums text-white/80">{Math.round(zoom * 100)}%</span>
                  <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label="확대" onClick={() => setZoom((value) => clamp(value + 0.08, 0.25, 1))}>
                    <ZoomIn />
                  </Button>
                </div>
              </div>

              <div className={`flex flex-1 overflow-auto p-5 sm:p-8 ${manualMode ? 'cursor-crosshair' : ''}`}>
                <div className="m-auto shadow-[0_28px_70px_rgba(0,0,0,0.35)]" style={{ width: currentPage.renderWidth * zoom, height: currentPage.renderHeight * zoom }}>
                  <div className="relative h-full w-full select-none bg-white">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img className="pointer-events-none absolute inset-0 h-full w-full" src={currentPage.imageUrl} alt={`${currentPageIndex + 1}쪽 문서`} draggable={false} />
                    <div
                      ref={overlayRef}
                      className="absolute inset-0 touch-none"
                      aria-label="삭제 영역 편집 화면"
                      onPointerDown={beginDraw}
                      onPointerMove={handlePointerMove}
                      onPointerUp={finishGesture}
                      onPointerCancel={finishGesture}
                    >
                      {currentPage.redactions.map((redaction) => (
                        <button
                          key={redaction.id}
                          type="button"
                          aria-label={`${kindLabels[redaction.kind]} ${redaction.sourceText} 영역`}
                          className={`absolute flex items-center justify-center overflow-visible border-2 text-center font-bold shadow-sm ${
                            redaction.selected
                              ? 'border-rose-500 bg-rose-400/20 text-rose-900'
                              : 'border-dashed border-amber-500 bg-amber-100/25 text-amber-900'
                          } ${manualMode ? 'pointer-events-none' : 'cursor-move'}`}
                          style={{
                            left: redaction.x * zoom,
                            top: redaction.y * zoom,
                            width: redaction.width * zoom,
                            height: redaction.height * zoom,
                            fontSize: clamp(redaction.height * zoom * 0.28, 6, 12),
                          }}
                          onPointerDown={(event) => beginRedactionGesture(event, redaction, 'move')}
                          onKeyDown={(event) => {
                            if (event.key === 'Delete' && redaction.kind === 'manual') {
                              updateCurrentPage((page) => ({ ...page, reviewed: false, redactions: page.redactions.filter((item) => item.id !== redaction.id) }));
                            }
                          }}
                        >
                          {!manualMode && (
                            <span
                              title="영역 크기 조절"
                              className="absolute -bottom-2 -right-2 grid size-4 cursor-se-resize place-items-center rounded-sm border border-white bg-primary text-white shadow"
                              onPointerDown={(event) => beginRedactionGesture(event, redaction, 'resize')}
                            >
                              <Grip className="size-2.5" />
                            </span>
                          )}
                        </button>
                      ))}
                      {draftRect && (
                        <div className="pointer-events-none absolute border-2 border-dashed border-white bg-white/20" style={{ left: draftRect.x * zoom, top: draftRect.y * zoom, width: draftRect.width * zoom, height: draftRect.height * zoom }} />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <aside className="flex min-h-[420px] flex-col border-t border-border bg-card lg:sticky lg:top-4 lg:h-[calc(100vh-2rem)] lg:min-h-0 lg:rounded-r-[24px] lg:border-l lg:border-t-0">
              <div className="border-b border-border p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="font-bold">{currentPageIndex + 1}쪽 탐지 결과</h2>
                    <p className="mt-1 text-xs text-muted-foreground">필요 없는 후보는 선택을 해제하세요.</p>
                  </div>
                  <Badge variant="secondary">{currentPage.redactions.length}개</Badge>
                </div>
              </div>
              <div className="min-h-0 max-h-[360px] flex-1 space-y-2 overflow-y-auto p-3 lg:max-h-none">
                {currentPage.redactions.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border p-5 text-center">
                    <ScanSearch className="mx-auto size-6 text-muted-foreground" />
                    <p className="mt-2 text-sm font-semibold">자동 탐지 결과가 없어요</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">문서에서 빠진 정보는 직접 영역을 추가해 주세요.</p>
                  </div>
                ) : (
                  currentPage.redactions.map((redaction) => (
                    <div key={redaction.id} className={`rounded-xl border p-3 transition ${redaction.selected ? 'border-border bg-background' : 'border-border/70 bg-muted/40 opacity-70'}`}>
                      <div className="flex items-start gap-3">
                        <Checkbox
                          className="mt-1"
                          checked={redaction.selected}
                          aria-label={`${redaction.sourceText} 삭제 ${redaction.selected ? '해제' : '선택'}`}
                          onCheckedChange={(checked) => updateRedaction(redaction.id, (item) => ({ ...item, selected: checked === true }))}
                        />
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => updateRedaction(redaction.id, (item) => ({ ...item, selected: !item.selected }))}>
                          <div className="flex items-center gap-2">
                            <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${kindStyles[redaction.kind]}`}>{kindLabels[redaction.kind]}</span>
                            {redaction.kind !== 'manual' && <span className="text-[10px] text-muted-foreground">신뢰도 {redaction.confidence}%</span>}
                          </div>
                          <p className="mt-1.5 truncate text-sm font-semibold">{redaction.sourceText}</p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">{redaction.reason}</p>
                        </button>
                        {redaction.kind === 'manual' && (
                          <Button size="icon-sm" variant="ghost" aria-label="수동 영역 삭제" onClick={() => updateCurrentPage((page) => ({ ...page, reviewed: false, redactions: page.redactions.filter((item) => item.id !== redaction.id) }))}>
                            <Trash2 />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
              <div className="mt-auto border-t border-border p-4">
                <label htmlFor={`review-page-${currentPage.pageIndex}`} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${currentPage.reviewed ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
                  <Checkbox
                    id={`review-page-${currentPage.pageIndex}`}
                    className="mt-0.5"
                    checked={currentPage.reviewed}
                    onCheckedChange={(checked) => updateCurrentPage((page) => ({ ...page, reviewed: checked === true }))}
                  />
                  <span>
                    <span className="block text-sm font-bold">이 페이지를 확인했습니다</span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">OCR은 누락될 수 있으니 문서를 직접 확인해 주세요.</span>
                  </span>
                </label>
                <div className="mt-3 flex gap-2 lg:hidden">
                  {pages.map((page) => (
                    <button key={page.pageIndex} type="button" aria-label={`${page.pageIndex + 1}쪽으로 이동`} className={`size-8 rounded-lg text-xs font-bold ${currentPageIndex === page.pageIndex ? 'bg-primary text-white' : 'bg-muted text-muted-foreground'}`} onClick={() => setCurrentPageIndex(page.pageIndex)}>{page.pageIndex + 1}</button>
                  ))}
                </div>
                <Button variant="outline" className="mt-3 w-full sm:hidden" onClick={() => void resetDocument()}>
                  <RotateCcw />새 문서
                </Button>
              </div>
            </aside>
          </div>
          {!allReviewed && (
            <p className="mt-3 text-center text-xs text-muted-foreground">모든 페이지를 검토한 뒤 새 PDF를 저장할 수 있습니다.</p>
          )}

          <Dialog open={isSummaryOpen} onOpenChange={setIsSummaryOpen}>
            <DialogContent className="max-h-[90vh] grid-rows-[auto_auto_minmax(0,1fr)_auto] sm:max-w-4xl">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-lg">
                  <ListChecks className="size-5 text-primary" aria-hidden="true" />
                  전체 탐지 내역 최종 검토
                </DialogTitle>
                <DialogDescription>
                  {pages.length}쪽에서 찾은 {pages.reduce((count, page) => count + page.redactions.length, 0)}개 후보를 확인하고, 최종 판정과 PDF 생성을 한 번에 완료하세요.
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted/35 p-3">
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPages((current) => current.map((page) => ({
                      ...page,
                      reviewed: false,
                      redactions: page.redactions.map((redaction) => ({ ...redaction, selected: true })),
                    })))}
                  >
                    전체 선택
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPages((current) => current.map((page) => ({
                      ...page,
                      reviewed: false,
                      redactions: page.redactions.map((redaction) => ({ ...redaction, selected: false })),
                    })))}
                  >
                    전체 해제
                  </Button>
                </div>
              </div>

              <div className="min-h-0 space-y-4 overflow-y-auto rounded-xl border border-border p-3">
                {pages.map((page) => (
                  <section key={page.pageIndex} className="rounded-xl border border-border bg-background">
                    <div className="sticky top-0 z-10 flex items-center justify-between rounded-t-xl border-b border-border bg-muted px-3 py-2">
                      <button
                        type="button"
                        className="text-sm font-bold hover:text-primary"
                        onClick={() => {
                          setCurrentPageIndex(page.pageIndex);
                          setIsSummaryOpen(false);
                        }}
                      >
                        {page.pageIndex + 1}쪽 보기
                      </button>
                      <Badge variant="secondary">
                        {page.redactions.filter((redaction) => redaction.selected).length}/{page.redactions.length}개 선택
                      </Badge>
                    </div>
                    {page.redactions.length === 0 ? (
                      <p className="px-3 py-4 text-xs text-muted-foreground">탐지된 후보가 없습니다. 페이지 화면에서 필요한 영역을 직접 추가해 주세요.</p>
                    ) : (
                      <div className="grid gap-2 p-3 sm:grid-cols-2">
                        {page.redactions.map((redaction) => (
                          <label htmlFor={`summary-redaction-${redaction.id}`} key={redaction.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${redaction.selected ? 'border-border bg-card' : 'border-border/60 bg-muted/30 opacity-65'}`}>
                            <Checkbox
                              id={`summary-redaction-${redaction.id}`}
                              className="mt-0.5"
                              checked={redaction.selected}
                              onCheckedChange={(checked) =>
                                updateRedactionOnPage(page.pageIndex, redaction.id, (item) => ({
                                  ...item,
                                  selected: checked === true,
                                }))
                              }
                            />
                            <span className="min-w-0">
                              <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${kindStyles[redaction.kind]}`}>
                                {kindLabels[redaction.kind]}
                              </span>
                              <span className="mt-1.5 block truncate text-sm font-semibold">{redaction.sourceText}</span>
                              <span className="mt-0.5 block text-[11px] text-muted-foreground">{redaction.reason}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </section>
                ))}
              </div>

              <DialogFooter className="items-center sm:justify-between">
                <p className="text-xs leading-5 text-muted-foreground">
                  선택한 글자가 빈자리로 영구 삭제됩니다. 표 선과 주변 문서 구조는 그대로 유지됩니다.
                </p>
                <Button
                  disabled={selectedCount === 0 || stage === 'exporting'}
                  onClick={() => void downloadResult(true)}
                >
                  <Download aria-hidden="true" />
                  {stage === 'exporting' ? `${progress}% 생성 중` : '최종 판정 및 PDF 생성'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </section>
      )}
    </main>
  );
}
