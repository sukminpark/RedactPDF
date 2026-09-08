import type { CanvasRect, PdfQuad } from './redaction';

export type AffineMatrix = [number, number, number, number, number, number];
export type PdfPoint = [number, number];

export interface PageTransform {
  pdfToCanvas: AffineMatrix;
  canvasToPdf: AffineMatrix;
  rotation: number;
  cropBox: [number, number, number, number];
}

export function transformPoint(matrix: AffineMatrix, point: PdfPoint): PdfPoint {
  const [a, b, c, d, e, f] = matrix;
  return [a * point[0] + c * point[1] + e, b * point[0] + d * point[1] + f];
}

export function invertAffine(matrix: AffineMatrix): AffineMatrix {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-10) throw new Error('PDF 페이지 좌표 변환을 계산하지 못했습니다.');
  return [d / determinant, -b / determinant, -c / determinant, a / determinant, (c * f - d * e) / determinant, (b * e - a * f) / determinant];
}

export function transformQuad(matrix: AffineMatrix, quad: PdfQuad): PdfQuad {
  return [...transformPoint(matrix, [quad[0], quad[1]]), ...transformPoint(matrix, [quad[2], quad[3]]), ...transformPoint(matrix, [quad[4], quad[5]]), ...transformPoint(matrix, [quad[6], quad[7]])] as PdfQuad;
}

export function rectQuad(rect: CanvasRect): PdfQuad {
  return [rect.x, rect.y, rect.x + rect.width, rect.y, rect.x, rect.y + rect.height, rect.x + rect.width, rect.y + rect.height];
}

export function quadBounds(quad: PdfQuad): CanvasRect {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function projection(point: PdfPoint, axis: PdfPoint): number {
  return point[0] * axis[0] + point[1] * axis[1];
}

function normalized(vector: PdfPoint): PdfPoint | null {
  const length = Math.hypot(vector[0], vector[1]);
  return length > 1e-6 ? [vector[0] / length, vector[1] / length] : null;
}

/** Keep MuPDF's real glyph advances while borrowing PDF.js's stable painted height/baseline. */
export function canonicalGlyphQuad(sourcePdfQuad: PdfQuad, renderedBounds: CanvasRect, transform: Pick<PageTransform, 'pdfToCanvas' | 'canvasToPdf'>): PdfQuad {
  const source = transformQuad(transform.pdfToCanvas, sourcePdfQuad);
  const direction = normalized([source[2] - source[0], source[3] - source[1]]);
  const sourceNormal = normalized([source[4] - source[0], source[5] - source[1]]);
  if (!direction || !sourceNormal || Math.abs(direction[0] * sourceNormal[0] + direction[1] * sourceNormal[1]) > 0.2) return transformQuad(transform.canvasToPdf, rectQuad(renderedBounds));
  // Projection and reconstruction need an orthonormal basis. A tiny skew in
  // an Office-style height edge otherwise gets amplified by absolute page
  // coordinates and can move one glyph into a neighboring table row.
  const normalSign = (-direction[1] * sourceNormal[0] + direction[0] * sourceNormal[1]) < 0 ? -1 : 1;
  const normal: PdfPoint = [-direction[1] * normalSign, direction[0] * normalSign];
  const sourcePoints: PdfPoint[] = [[source[0], source[1]], [source[2], source[3]], [source[4], source[5]], [source[6], source[7]]];
  const rendered = rectQuad(renderedBounds);
  const renderedPoints: PdfPoint[] = [[rendered[0], rendered[1]], [rendered[2], rendered[3]], [rendered[4], rendered[5]], [rendered[6], rendered[7]]];
  const along = sourcePoints.map((point) => projection(point, direction));
  const across = renderedPoints.map((point) => projection(point, normal));
  const u0 = Math.min(...along);
  const u1 = Math.max(...along);
  const v0 = Math.min(...across);
  const v1 = Math.max(...across);
  const point = (u: number, v: number): PdfPoint => [direction[0] * u + normal[0] * v, direction[1] * u + normal[1] * v];
  return transformQuad(transform.canvasToPdf, [...point(u0, v0), ...point(u1, v0), ...point(u0, v1), ...point(u1, v1)] as PdfQuad);
}
