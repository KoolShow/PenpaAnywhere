export interface Point2D {
  x: number;
  y: number;
}

/** 3x3 matrix stored in row-major order (length 9). */
export type Mat3 = [
  number, number, number,
  number, number, number,
  number, number, number,
];

/**
 * Solve 8x8 linear system A * x = b using Gaussian elimination with partial pivoting.
 */
function solve8x8(A: number[][], b: number[]): number[] | null {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    let maxVal = Math.abs(M[col][col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(M[row][col]);
      if (v > maxVal) {
        maxVal = v;
        maxRow = row;
      }
    }
    if (maxVal < 1e-10) return null;

    if (maxRow !== col) {
      const tmp = M[col];
      M[col] = M[maxRow];
      M[maxRow] = tmp;
    }

    const pivot = M[col][col];
    for (let j = col; j <= n; j++) {
      M[col][j] /= pivot;
    }

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col];
      if (Math.abs(factor) < 1e-12) continue;
      for (let j = col; j <= n; j++) {
        M[row][j] -= factor * M[col][j];
      }
    }
  }

  return M.map((row) => row[n]);
}

/**
 * Compute 3x3 homography H mapping src[i] -> dst[i] for 4 correspondences.
 */
export function computeHomography(
  src: [Point2D, Point2D, Point2D, Point2D],
  dst: [Point2D, Point2D, Point2D, Point2D],
): Mat3 | null {
  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = src[i];
    const { x, y } = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }

  const h = solve8x8(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * Invert a 3x3 row-major matrix.
 */
export function invertMat3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const c00 = e * i - f * h;
  const c01 = -(d * i - f * g);
  const c02 = d * h - e * g;

  const det = a * c00 + b * c01 + c * c02;
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;

  return [
    c00 * invDet,
    -(b * i - c * h) * invDet,
    (b * f - c * e) * invDet,
    c01 * invDet,
    (a * i - c * g) * invDet,
    -(a * f - c * d) * invDet,
    c02 * invDet,
    -(a * h - b * g) * invDet,
    (a * e - b * d) * invDet,
  ];
}

/**
 * Apply row-major 3x3 homography to a 2D point.
 */
export function applyHomography(m: Mat3, x: number, y: number): Point2D | null {
  const w = m[6] * x + m[7] * y + m[8];
  if (Math.abs(w) < 1e-9) return null;
  return {
    x: (m[0] * x + m[1] * y + m[2]) / w,
    y: (m[3] * x + m[4] * y + m[5]) / w,
  };
}

/**
 * Convert row-major Mat3 to column-major Float32Array for WebGL uniformMatrix3fv.
 */
export function mat3ToColumnMajorFloat32(m: Mat3): Float32Array {
  return new Float32Array([
    m[0], m[3], m[6],
    m[1], m[4], m[7],
    m[2], m[5], m[8],
  ]);
}

/**
 * Check whether 4 ordered points form a strictly convex quadrilateral (CW or CCW).
 */
export function isConvexQuad(pts: [Point2D, Point2D, Point2D, Point2D]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-3) return false;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return false;
  }
  return true;
}

/**
 * Point-in-convex-quad test (accepts CW or CCW ordering).
 */
export function isPointInQuad(p: Point2D, quad: [Point2D, Point2D, Point2D, Point2D]): boolean {
  let hasPos = false;
  let hasNeg = false;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross > 0) hasPos = true;
    else if (cross < 0) hasNeg = true;
    if (hasPos && hasNeg) return false;
  }
  return true;
}
