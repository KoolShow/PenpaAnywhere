import type { Mat3, Point2D } from './homography';

export type WorkspaceMode = 'overlay' | 'canvas';

export const ROOT_WORLD_ID = 'root';

export const MIN_VIEWPORT_ZOOM = 0.15;
export const MAX_VIEWPORT_ZOOM = 8.0;

/**
 * Hierarchical world-space node descriptor.
 * All objects currently attach to the shared ROOT_WORLD_ID ('root').
 * Future child worlds (e.g. anchored to individual desktop windows in overlay mode)
 * can attach via parentId without changing the rendering or hit-testing pipeline.
 */
export interface WorldSpaceNode {
  id: string;
  parentId: string | null;
  offsetX: number;
  offsetY: number;
  scale: number;
}

/**
 * Mapping from Root World coordinates into the main application Viewport (CSS px):
 *   viewportX = (worldX - offsetX) * zoom
 *   viewportY = (worldY - offsetY) * zoom
 *
 * Identity { offsetX: 0, offsetY: 0, zoom: 1 } keeps the viewport top-left
 * coincident with the world origin (0, 0).
 */
export interface WorldViewportTransform {
  offsetX: number;
  offsetY: number;
  zoom: number;
}

export const IDENTITY_VIEWPORT_TRANSFORM: Readonly<WorldViewportTransform> = Object.freeze({
  offsetX: 0,
  offsetY: 0,
  zoom: 1,
});

export function createRootWorldNode(): WorldSpaceNode {
  return {
    id: ROOT_WORLD_ID,
    parentId: null,
    offsetX: 0,
    offsetY: 0,
    scale: 1,
  };
}

export function sanitizeViewportTransform(
  raw?: Partial<WorldViewportTransform> | null,
): WorldViewportTransform {
  if (!raw || typeof raw !== 'object') {
    return { offsetX: 0, offsetY: 0, zoom: 1 };
  }
  const offsetX = typeof raw.offsetX === 'number' && Number.isFinite(raw.offsetX) ? raw.offsetX : 0;
  const offsetY = typeof raw.offsetY === 'number' && Number.isFinite(raw.offsetY) ? raw.offsetY : 0;
  const rawZoom = typeof raw.zoom === 'number' && Number.isFinite(raw.zoom) ? raw.zoom : 1;
  const zoom = Math.max(MIN_VIEWPORT_ZOOM, Math.min(MAX_VIEWPORT_ZOOM, rawZoom));
  return { offsetX, offsetY, zoom };
}

export function isIdentityViewportTransform(v: WorldViewportTransform): boolean {
  return Math.abs(v.offsetX) < 0.5 && Math.abs(v.offsetY) < 0.5 && Math.abs(v.zoom - 1) < 1e-3;
}

/**
 * Resolve a WorldSpaceNode's cumulative transform into Root World space.
 */
export function resolveWorldToRoot(
  worldId: string,
  worlds: ReadonlyMap<string, WorldSpaceNode>,
): { offsetX: number; offsetY: number; scale: number } {
  let offsetX = 0;
  let offsetY = 0;
  let scale = 1;
  const visited = new Set<string>();
  let curId: string | null = worldId;
  while (curId && curId !== ROOT_WORLD_ID && !visited.has(curId)) {
    visited.add(curId);
    const node = worlds.get(curId);
    if (!node) break;
    offsetX = offsetX * node.scale + node.offsetX;
    offsetY = offsetY * node.scale + node.offsetY;
    scale *= node.scale;
    curId = node.parentId;
  }
  return { offsetX, offsetY, scale };
}

export function worldToViewport(pt: Point2D, v: WorldViewportTransform): Point2D {
  return {
    x: (pt.x - v.offsetX) * v.zoom,
    y: (pt.y - v.offsetY) * v.zoom,
  };
}

export function viewportToWorld(pt: Point2D, v: WorldViewportTransform): Point2D {
  const z = v.zoom || 1;
  return {
    x: pt.x / z + v.offsetX,
    y: pt.y / z + v.offsetY,
  };
}

export function worldQuadToViewport(
  quad: [Point2D, Point2D, Point2D, Point2D],
  v: WorldViewportTransform,
): [Point2D, Point2D, Point2D, Point2D] {
  return [
    worldToViewport(quad[0], v),
    worldToViewport(quad[1], v),
    worldToViewport(quad[2], v),
    worldToViewport(quad[3], v),
  ];
}

/**
 * Build row-major 3x3 affine matrix mapping Root World -> Viewport.
 */
export function viewportTransformToMat3(v: WorldViewportTransform): Mat3 {
  return [
    v.zoom, 0, -v.offsetX * v.zoom,
    0, v.zoom, -v.offsetY * v.zoom,
    0, 0, 1,
  ];
}

/**
 * Multiply two row-major 3x3 matrices: C = A * B.
 */
export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],

    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],

    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}

/**
 * Pan viewport by a delta measured in viewport pixels.
 */
export function panViewportBy(
  v: WorldViewportTransform,
  dxViewport: number,
  dyViewport: number,
): WorldViewportTransform {
  const z = v.zoom || 1;
  return {
    offsetX: v.offsetX - dxViewport / z,
    offsetY: v.offsetY - dyViewport / z,
    zoom: z,
  };
}

/**
 * Zoom viewport around a fixed anchor point in viewport coordinates so the world point
 * under the cursor / pinch midpoint stays stationary.
 */
export function zoomViewportAt(
  v: WorldViewportTransform,
  nextZoomRaw: number,
  anchorViewport: Point2D,
): WorldViewportTransform {
  const nextZoom = Math.max(MIN_VIEWPORT_ZOOM, Math.min(MAX_VIEWPORT_ZOOM, nextZoomRaw));
  const worldAnchor = viewportToWorld(anchorViewport, v);
  return {
    offsetX: worldAnchor.x - anchorViewport.x / nextZoom,
    offsetY: worldAnchor.y - anchorViewport.y / nextZoom,
    zoom: nextZoom,
  };
}
