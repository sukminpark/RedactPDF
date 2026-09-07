import type { PageTransform } from './pdf-geometry';
import type { CanvasRect, OcrWord, PageReviewState, PdfQuad } from './redaction';

export type PdfErrorCode = 'password-required' | 'incorrect-password' | 'unsupported-encryption';

export class PdfProcessingError extends Error {
  constructor(public readonly code: PdfErrorCode, message: string) {
    super(message);
    this.name = 'PdfProcessingError';
  }
}

export interface NativePageText {
  pageIndex: number;
  width: number;
  height: number;
  rotation: number;
  cropBox: [number, number, number, number];
  pageToPdf: import('./pdf-geometry').AffineMatrix;
  imageBounds: CanvasRect[];
  words: OcrWord[];
  text: string;
}

export interface WorkerReviewPage {
  pageIndex: number;
  pdfWidth: number;
  pdfHeight: number;
  renderWidth: number;
  renderHeight: number;
  transform: PageTransform;
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
  | { id: string; type: 'extract'; bytes: ArrayBuffer; password?: string }
  | { id: string; type: 'redact'; bytes: ArrayBuffer; pages: WorkerReviewPage[]; password?: string }
  | {
      id: string;
      type: 'validate';
      bytes: ArrayBuffer;
      expectedPages: Array<{ width: number; height: number }>;
      forbidden: Array<{ pageIndex: number; text: string; quads: Array<{ quad: PdfQuad; text?: string }> }>;
    }
  | { id: string; type: 'cancel' };

export type MuPdfResponse =
  | { id: string; type: 'progress'; progress: number; pageIndex?: number; message: string }
  | { id: string; type: 'extracted'; pages: NativePageText[] }
  | { id: string; type: 'redacted'; bytes: ArrayBuffer; validation: ValidationResult }
  | { id: string; type: 'validated'; validation: ValidationResult }
  | { id: string; type: 'cancelled' }
  | { id: string; type: 'error'; message: string; code?: PdfErrorCode };
