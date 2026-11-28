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
export interface PhysicalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Snapshot of a connected physical display reported by the OS.
 * Explicitly distinguishes OS System Primary Monitor (`isPrimary`) from the
 * App Launch Monitor (`isLaunch`, where the user started the application).
 */
export interface MonitorDescriptor {
  id: string;
  name: string;
  physRect: PhysicalRect;
  workArea: PhysicalRect;
  scale: number;
  isPrimary: boolean;
  isLaunch: boolean;
}

/**
 * Build a WorldViewportTransform that projects Desktop Physical Coordinates directly into a
 * specific monitor's local CSS viewport:
 *   cssX = (physX - monitor.physRect.x) / monitor.scale
 *   cssY = (physY - monitor.physRect.y) / monitor.scale
 *
 * Because adjacent monitors share exact edges in Windows physical pixel space (and macOS logical
 * point space when scale=1), seams across mixed-DPI displays are 100% continuous.
 */
export function monitorToViewportTransform(monitor: MonitorDescriptor): WorldViewportTransform {
  const safeScale =
    typeof monitor.scale === 'number' && Number.isFinite(monitor.scale) && monitor.scale > 0.1
      ? monitor.scale
      : 1;
  return {
    offsetX: monitor.physRect.x,
    offsetY: monitor.physRect.y,
    zoom: 1 / safeScale,
  };
}

export function physicalToMonitorCss(pt: Point2D, monitor: MonitorDescriptor): Point2D {
  return worldToViewport(pt, monitorToViewportTransform(monitor));
}

export function monitorCssToPhysical(pt: Point2D, monitor: MonitorDescriptor): Point2D {
  return viewportToWorld(pt, monitorToViewportTransform(monitor));
}

export function physicalQuadToMonitorCss(
  quad: [Point2D, Point2D, Point2D, Point2D],
  monitor: MonitorDescriptor,
): [Point2D, Point2D, Point2D, Point2D] {
  return worldQuadToViewport(quad, monitorToViewportTransform(monitor));
}

export function monitorCssQuadToPhysical(
  quad: [Point2D, Point2D, Point2D, Point2D],
  monitor: MonitorDescriptor,
): [Point2D, Point2D, Point2D, Point2D] {
  const v = monitorToViewportTransform(monitor);
  return [
    viewportToWorld(quad[0], v),
    viewportToWorld(quad[1], v),
    viewportToWorld(quad[2], v),
    viewportToWorld(quad[3], v),
  ];
}

export function quadCentroid(quad: [Point2D, Point2D, Point2D, Point2D]): Point2D {
  return {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) * 0.25,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) * 0.25,
  };
}

/**
 * Find the monitor containing a physical desktop point, falling back to the nearest monitor
 * (Euclidean distance to rect) if the point lies in a dead void between heterogeneous displays.
 */
export function findMonitorContainingPhysicalPoint(
  pt: Point2D,
  monitors: ReadonlyArray<MonitorDescriptor>,
): MonitorDescriptor | null {
  if (monitors.length === 0) return null;
  for (const m of monitors) {
    const r = m.physRect;
    if (pt.x >= r.x && pt.x < r.x + r.w && pt.y >= r.y && pt.y < r.y + r.h) {
      return m;
    }
  }
  let best = monitors[0];
  let bestDistSq = Infinity;
  for (const m of monitors) {
    const r = m.physRect;
    const cx = Math.max(r.x, Math.min(r.x + r.w, pt.x));
    const cy = Math.max(r.y, Math.min(r.y + r.h, pt.y));
    const dx = pt.x - cx;
    const dy = pt.y - cy;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = m;
    }
  }
  return best;
}

/**
 * Resolve the owning monitor of an element in Desktop Physical space by its quad center.
 */
export function findOwnerMonitorForPhysicalQuad(
  physQuad: [Point2D, Point2D, Point2D, Point2D],
  monitors: ReadonlyArray<MonitorDescriptor>,
): MonitorDescriptor | null {
  return findMonitorContainingPhysicalPoint(quadCentroid(physQuad), monitors);
}

/**
 * Check whether a physical-space quad's AABB overlaps a monitor's physical bounds
 * (expanded by optional physical margin for gizmo handles / floating toolbars).
 */
export function quadIntersectsMonitor(
  physQuad: [Point2D, Point2D, Point2D, Point2D],
  monitor: MonitorDescriptor,
  marginPhys = 0,
): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of physQuad) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const r = monitor.physRect;
  return (
    maxX >= r.x - marginPhys &&
    minX <= r.x + r.w + marginPhys &&
    maxY >= r.y - marginPhys &&
    minY <= r.y + r.h + marginPhys
  );
}

/**
 * Windows Per-Monitor V2 scaling behavior: when an element's owning monitor switches from
 * `prevScale` to `nextScale`, rescale its physical corners around `pivotPhys` by `nextScale / prevScale`
 * so its visual physical size remains consistent across mixed-DPI displays.
 */
export function rescalePhysicalQuadForMonitorChange(
  physQuad: [Point2D, Point2D, Point2D, Point2D],
  prevScale: number,
  nextScale: number,
  pivotPhys?: Point2D,
): [Point2D, Point2D, Point2D, Point2D] {
  const s0 = prevScale > 0.1 ? prevScale : 1;
  const s1 = nextScale > 0.1 ? nextScale : 1;
  const ratio = s1 / s0;
  if (Math.abs(ratio - 1) < 1e-4) {
    return [
      { ...physQuad[0] },
      { ...physQuad[1] },
      { ...physQuad[2] },
      { ...physQuad[3] },
    ];
  }
  const pivot = pivotPhys ?? quadCentroid(physQuad);
  return [
    { x: pivot.x + (physQuad[0].x - pivot.x) * ratio, y: pivot.y + (physQuad[0].y - pivot.y) * ratio },
    { x: pivot.x + (physQuad[1].x - pivot.x) * ratio, y: pivot.y + (physQuad[1].y - pivot.y) * ratio },
    { x: pivot.x + (physQuad[2].x - pivot.x) * ratio, y: pivot.y + (physQuad[2].y - pivot.y) * ratio },
    { x: pivot.x + (physQuad[3].x - pivot.x) * ratio, y: pivot.y + (physQuad[3].y - pivot.y) * ratio },
  ];
}

export function dipQuadToPhysical(
  dipQuad: [Point2D, Point2D, Point2D, Point2D],
  anchorMonitor: MonitorDescriptor,
): [Point2D, Point2D, Point2D, Point2D] {
  return monitorCssQuadToPhysical(dipQuad, anchorMonitor);
}

export function physicalQuadToDip(
  physQuad: [Point2D, Point2D, Point2D, Point2D],
  anchorMonitor: MonitorDescriptor,
): [Point2D, Point2D, Point2D, Point2D] {
  return physicalQuadToMonitorCss(physQuad, anchorMonitor);
}

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
