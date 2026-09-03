import type { CanvasRect, OcrWord, PageReviewState, PdfQuad } from './redaction';

export interface NativePageText {
  pageIndex: number;
  width: number;
  height: number;
  rotation: number;
  words: OcrWord[];
  text: string;
}

export interface WorkerReviewPage {
  pageIndex: number;
  pdfWidth: number;
  pdfHeight: number;
  renderWidth: number;
  renderHeight: number;
  words: OcrWord[];
  redactions: PageReviewState['redactions'];
}

export interface ValidationPage {
  pageIndex: number;
  width: number;
  height: number;
  text: string;
}

export interface ValidationResult {
  valid: boolean;
  pages: ValidationPage[];
  errors: string[];
}

export type MuPdfRequest =
  | { id: string; type: 'extract'; bytes: ArrayBuffer }
  | { id: string; type: 'redact'; bytes: ArrayBuffer; pages: WorkerReviewPage[] }
  | {
      id: string;
      type: 'validate';
      bytes: ArrayBuffer;
      expectedPages: Array<{ width: number; height: number }>;
      forbidden: Array<{ pageIndex: number; text: string; quads: PdfQuad[] }>;
    }
  | { id: string; type: 'cancel' };

export type MuPdfResponse =
  | { id: string; type: 'progress'; progress: number; pageIndex?: number; message: string }
  | { id: string; type: 'extracted'; pages: NativePageText[] }
  | { id: string; type: 'redacted'; bytes: ArrayBuffer; validation: ValidationResult }
  | { id: string; type: 'validated'; validation: ValidationResult }
  | { id: string; type: 'cancelled' }
  | { id: string; type: 'error'; message: string };

export function canvasRectToPdfRect(
  rect: CanvasRect,
  page: Pick<WorkerReviewPage, 'pdfWidth' | 'pdfHeight' | 'renderWidth' | 'renderHeight'>,
): [number, number, number, number] {
  const scaleX = page.pdfWidth / page.renderWidth;
  const scaleY = page.pdfHeight / page.renderHeight;
  return [
    rect.x * scaleX,
    rect.y * scaleY,
    (rect.x + rect.width) * scaleX,
    (rect.y + rect.height) * scaleY,
  ];
}
