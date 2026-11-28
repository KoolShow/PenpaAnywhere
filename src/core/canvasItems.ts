import {
  isConvexQuad,
  quadToBoundingRect,
  rectToQuad,
  type Point2D,
  type Rect2D,
} from './homography';
import type { BlendRenderMode } from './webglOverlay';
import {
  ROOT_WORLD_ID,
  viewportToWorld,
  worldToViewport,
  type WorldViewportTransform,
} from './world';

export type WorldElementKind = 'grid' | 'image' | 'screen';
export type QuadMode = 'rect' | 'free';
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface MediaCrop {
  left: number;   // [0..1), normalized source U start
  top: number;    // [0..1), normalized source V start
  right: number;  // (0..1], normalized source U end
  bottom: number; // (0..1], normalized source V end
}

/**
 * Transactional crop preview state. Never mutates the real element until committed via "Done".
 */
export interface CropDraft {
  elementId: string;
  fullRect: Rect2D;
  crop: MediaCrop;
  croppedRect: Rect2D;
}

/**
 * Unified base shared by ALL first-class World Elements (grid, image, screen).
 * Every element lives in Root World coordinates via 4 target corners, supports
 * rect & free 4-point perspective, source-domain crop, shared zIndex ordering,
 * locking, and locked-only click pass-through.
 */
export interface WorldElementBase {
  id: string;
  kind: WorldElementKind;
  worldId: string;
  label: string;
  corners: [Point2D, Point2D, Point2D, Point2D];
  quadMode: QuadMode;
  crop: MediaCrop;
  zIndex: number;
  visible: boolean;
  locked: boolean;
  passThrough: boolean;
}

export interface GridElement extends WorldElementBase {
  kind: 'grid';
  blendMode: BlendRenderMode;
  opacity: number;
  enhanceOpacity: boolean;
  dockVisible: boolean;
}

export interface ImageElementMeta extends WorldElementBase {
  kind: 'image';
  naturalW: number;
  naturalH: number;
  /** Legacy fields kept optional for backward-compatible migration from pre-quad saves */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface ImageElement extends ImageElementMeta {
  src: string;
}

export interface ScreenElement extends WorldElementBase {
  kind: 'screen';
  streamId: string;
  naturalW: number;
  naturalH: number;
}

export type MediaElement = ImageElement | ScreenElement;
export type WorldElement = GridElement | ImageElement | ScreenElement;

export interface ElementGroup {
  id: string;
  label: string;
  /** Direct children IDs: may reference WorldElement IDs OR nested child ElementGroup IDs */
  memberIds: string[];
  visible: boolean;
  locked: boolean;
  passThrough: boolean;
}

export interface GroupSelectionTarget {
  id: string;
  kind: 'group';
  label: string;
  /** Direct child IDs (WorldElement IDs and/or nested child ElementGroup IDs) */
  memberIds: string[];
  /** All descendant leaf WorldElements (flattened recursively) */
  members: WorldElement[];
  corners: [Point2D, Point2D, Point2D, Point2D];
  zIndex: number;
  minZIndex: number;
  visible: boolean;
  locked: boolean;
  passThrough: boolean;
  hasGrid: boolean;
  gridCount: number;
  dockVisible: boolean;
}

export type SelectableTarget = WorldElement | GroupSelectionTarget;

export interface TargetSetCapabilities {
  count: number;
  hasGrid: boolean;
  anyDockVisible: boolean;
  canBringFront: boolean;
  canSendBack: boolean;
  canLock: boolean;
  canDelete: boolean;
}

/**
 * Single source of truth for per-target deletion eligibility.
 * Shared by single selection, groups, and multi-selection.
 */
export function canDeleteSingleTarget(
  target: SelectableTarget | null,
  allowDelete = true,
): boolean {
  return allowDelete && !!target;
}

/**
 * Unified capability inspection shared by both Group targets and Multi-Selection sets.
 */
export function inspectTargetSet(
  targets: ReadonlyArray<SelectableTarget>,
  allowDelete = true,
): TargetSetCapabilities {
  let hasGrid = false;
  let anyDockVisible = false;
  let canLock = false;
  let canDelete = allowDelete && targets.length > 0;
  for (const t of targets) {
    if (t.kind === 'grid') {
      hasGrid = true;
      if (t.dockVisible) anyDockVisible = true;
    } else if (t.kind === 'group') {
      if (t.hasGrid) hasGrid = true;
      if (t.dockVisible) anyDockVisible = true;
    }
    if (!t.locked) canLock = true;
    if (!canDeleteSingleTarget(t, allowDelete)) canDelete = false;
  }
  return {
    count: targets.length,
    hasGrid,
    anyDockVisible,
    canBringFront: targets.length > 0,
    canSendBack: targets.length > 0,
    canLock,
    canDelete,
  };
}

export function getParentGroup(
  id: string,
  groups: ReadonlyArray<ElementGroup>,
): ElementGroup | null {
  return groups.find((g) => g.memberIds.includes(id)) ?? null;
}

export function getAncestorGroupChain(
  id: string,
  groups: ReadonlyArray<ElementGroup>,
): ElementGroup[] {
  const chain: ElementGroup[] = [];
  const visited = new Set<string>([id]);
  let curId = id;
  while (true) {
    const parent = getParentGroup(curId, groups);
    if (!parent || visited.has(parent.id)) break;
    visited.add(parent.id);
    chain.push(parent);
    curId = parent.id;
  }
  return chain;
}

export function resolveTopLevelTargetId(
  id: string,
  groups: ReadonlyArray<ElementGroup>,
): string {
  const chain = getAncestorGroupChain(id, groups);
  return chain.length > 0 ? chain[chain.length - 1].id : id;
}

export function getDescendantGroupIds(
  groupId: string,
  groups: ReadonlyArray<ElementGroup>,
): string[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const result: string[] = [];
  const visited = new Set<string>();
  const walk = (gid: string) => {
    if (visited.has(gid)) return;
    const g = byId.get(gid);
    if (!g) return;
    visited.add(gid);
    result.push(gid);
    for (const mid of g.memberIds) {
      if (byId.has(mid)) walk(mid);
    }
  };
  walk(groupId);
  return result;
}

export function getDescendantLeafIds(
  groupId: string,
  groups: ReadonlyArray<ElementGroup>,
  elementIdSet: ReadonlySet<string>,
): string[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const leaves: string[] = [];
  const visitedGroups = new Set<string>();
  const seenLeaves = new Set<string>();
  const walk = (gid: string) => {
    if (visitedGroups.has(gid)) return;
    const g = byId.get(gid);
    if (!g) return;
    visitedGroups.add(gid);
    for (const mid of g.memberIds) {
      if (elementIdSet.has(mid)) {
        if (!seenLeaves.has(mid)) {
          seenLeaves.add(mid);
          leaves.push(mid);
        }
      } else if (byId.has(mid)) {
        walk(mid);
      }
    }
  };
  walk(groupId);
  return leaves;
}

export function generateGroupId(): string {
  return `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function computeCombinedWorldQuad(
  members: ReadonlyArray<Pick<WorldElementBase, 'corners'>>,
): [Point2D, Point2D, Point2D, Point2D] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const m of members) {
    for (const p of m.corners) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) {
    return rectToQuad({ x: 0, y: 0, w: 100, h: 100 });
  }
  return rectToQuad({
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  });
}

// Backward-compatible aliases
export type CanvasImageItemMeta = ImageElementMeta;
export type CanvasImageItem = ImageElement;
export type CanvasScreenItem = ScreenElement;
export type CanvasItem = MediaElement;

export const MIN_ITEM_WORLD_SIZE = 48;
export const MIN_CROP_SPAN = 0.04;

export function createDefaultCrop(): MediaCrop {
  return { left: 0, top: 0, right: 1, bottom: 1 };
}

export function sanitizeCrop(raw?: Partial<MediaCrop> | null): MediaCrop {
  if (!raw || typeof raw !== 'object') return createDefaultCrop();
  let left = typeof raw.left === 'number' && Number.isFinite(raw.left) ? raw.left : 0;
  let top = typeof raw.top === 'number' && Number.isFinite(raw.top) ? raw.top : 0;
  let right = typeof raw.right === 'number' && Number.isFinite(raw.right) ? raw.right : 1;
  let bottom = typeof raw.bottom === 'number' && Number.isFinite(raw.bottom) ? raw.bottom : 1;

  left = Math.max(0, Math.min(1 - MIN_CROP_SPAN, left));
  top = Math.max(0, Math.min(1 - MIN_CROP_SPAN, top));
  right = Math.max(left + MIN_CROP_SPAN, Math.min(1, right));
  bottom = Math.max(top + MIN_CROP_SPAN, Math.min(1, bottom));
  return { left, top, right, bottom };
}

export function isItemCropped(crop: MediaCrop): boolean {
  return (
    crop.left > 1e-3 ||
    crop.top > 1e-3 ||
    crop.right < 1 - 1e-3 ||
    crop.bottom < 1 - 1e-3
  );
}

/**
 * Single source of truth for element pass-through:
 * pass-through is ONLY visible and active when the element is locked.
 */
export function isElementPassThrough(el: Pick<WorldElementBase, 'locked' | 'passThrough'>): boolean {
  return el.locked && el.passThrough;
}

export function cloneQuad(c: [Point2D, Point2D, Point2D, Point2D]): [Point2D, Point2D, Point2D, Point2D] {
  return [
    { x: c[0].x, y: c[0].y },
    { x: c[1].x, y: c[1].y },
    { x: c[2].x, y: c[2].y },
    { x: c[3].x, y: c[3].y },
  ];
}

export function sanitizeQuad(
  raw: unknown,
  fallbackRect?: Rect2D,
): [Point2D, Point2D, Point2D, Point2D] | null {
  if (Array.isArray(raw) && raw.length === 4) {
    const valid = raw.every(
      (p) =>
        p &&
        typeof p.x === 'number' &&
        typeof p.y === 'number' &&
        Number.isFinite(p.x) &&
        Number.isFinite(p.y),
    );
    if (valid) {
      const pts: [Point2D, Point2D, Point2D, Point2D] = [
        { x: raw[0].x, y: raw[0].y },
        { x: raw[1].x, y: raw[1].y },
        { x: raw[2].x, y: raw[2].y },
        { x: raw[3].x, y: raw[3].y },
      ];
      if (isConvexQuad(pts)) return pts;
    }
  }
  if (fallbackRect) {
    return rectToQuad({
      x: fallbackRect.x,
      y: fallbackRect.y,
      w: Math.max(MIN_ITEM_WORLD_SIZE, fallbackRect.w),
      h: Math.max(MIN_ITEM_WORLD_SIZE, fallbackRect.h),
    });
  }
  return null;
}

/**
 * Switch any element between 'rect' and 'free' without resetting:
 * - rect -> free: keeps exact current 4 corners.
 * - free -> rect: expands/snaps to the exact axis-aligned bounding rectangle covering all 4 corners.
 */
export function convertElementQuadMode(
  el: Pick<WorldElementBase, 'corners' | 'quadMode'>,
  nextMode: QuadMode,
): { quadMode: QuadMode; corners: [Point2D, Point2D, Point2D, Point2D] } {
  if (el.quadMode === nextMode) {
    return { quadMode: nextMode, corners: cloneQuad(el.corners) };
  }
  if (nextMode === 'free') {
    return { quadMode: 'free', corners: cloneQuad(el.corners) };
  }
  return {
    quadMode: 'rect',
    corners: rectToQuad(quadToBoundingRect(el.corners, MIN_ITEM_WORLD_SIZE)),
  };
}

export function generateCanvasItemId(prefix: 'img' | 'scr' | 'grid'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Standard CSS 1 inch = 96 CSS px */
export const MIN_ELEMENT_CSS_INCH_PX = 96;

/**
 * Proportionally clamp (natW, natH) in world coordinates so that on screen (viewport CSS px)
 * BOTH width and height fall in [1in (96px), 50%vw / 50%vh].
 * If the feasible proportional scale range is empty (e.g. extreme aspect ratio or tiny viewport),
 * fit proportionally into 50%vw / 50%vh.
 */
export function clampSizeProportional(
  natW: number,
  natH: number,
  viewportW: number,
  viewportH: number,
  zoom = 1,
): { w: number; h: number } {
  const z = Math.max(0.05, zoom || 1);
  const w0 = Math.max(1, natW);
  const h0 = Math.max(1, natH);
  const minW = MIN_ELEMENT_CSS_INCH_PX / z;
  const minH = MIN_ELEMENT_CSS_INCH_PX / z;
  const maxW = Math.max(1, (Math.max(1, viewportW) * 0.5) / z);
  const maxH = Math.max(1, (Math.max(1, viewportH) * 0.5) / z);

  const sMin = Math.max(minW / w0, minH / h0);
  const sMax = Math.min(maxW / w0, maxH / h0);
  const s = sMin <= sMax ? Math.max(sMin, Math.min(sMax, 1)) : sMax;
  return {
    w: Math.max(1, Math.round(w0 * s)),
    h: Math.max(1, Math.round(h0 * s)),
  };
}

/**
 * Compute an initial world-space rectangle for a newly added image or screen projection,
 * proportionally clamped between 1in (96px) and 50%vw/50%vh (falling back to 50%vw/50%vh if empty).
 */
export function computeInitialItemWorldRect(
  naturalW: number,
  naturalH: number,
  viewport: WorldViewportTransform,
  viewportW: number,
  viewportH: number,
  safeTop: number,
  safeRight: number,
  safeBottom: number,
  safeLeft: number,
  existingCount: number,
): Rect2D {
  const nw = Math.max(1, naturalW || 800);
  const nh = Math.max(1, naturalH || 600);
  const safeW = Math.max(120, viewportW - safeLeft - safeRight);
  const safeH = Math.max(120, viewportH - safeTop - safeBottom);
  const z = viewport.zoom || 1;

  const { w, h } = clampSizeProportional(nw, nh, viewportW, viewportH, z);

  const cascade = (existingCount % 6) * (24 / z);
  const centerVp = {
    x: safeLeft + safeW * 0.56,
    y: safeTop + safeH * 0.52,
  };
  const centerWorld = viewportToWorld(centerVp, viewport);
  return {
    x: Math.round(centerWorld.x - w * 0.5 + cascade),
    y: Math.round(centerWorld.y - h * 0.5 + cascade),
    w,
    h,
  };
}

export function toCanvasImageMeta(item: ImageElement): ImageElementMeta {
  return {
    id: item.id,
    kind: 'image',
    worldId: item.worldId || ROOT_WORLD_ID,
    label: item.label,
    corners: cloneQuad(item.corners),
    quadMode: item.quadMode,
    naturalW: item.naturalW,
    naturalH: item.naturalH,
    crop: sanitizeCrop(item.crop),
    zIndex: item.zIndex,
    visible: item.visible,
    locked: item.locked,
    passThrough: !!item.passThrough,
  };
}

/**
 * Given a cropped rectangular box and its normalized crop [left, top, right, bottom],
 * compute the full uncropped world bounds.
 */
export function getUncroppedWorldBounds(rect: Rect2D, crop: MediaCrop): {
  fullX: number;
  fullY: number;
  fullW: number;
  fullH: number;
} {
  const cw = Math.max(MIN_CROP_SPAN, crop.right - crop.left);
  const ch = Math.max(MIN_CROP_SPAN, crop.bottom - crop.top);
  const fullW = rect.w / cw;
  const fullH = rect.h / ch;
  return {
    fullX: rect.x - crop.left * fullW,
    fullY: rect.y - crop.top * fullH,
    fullW,
    fullH,
  };
}

/**
 * Given an uncropped bounding rect and normalized crop, compute the cropped sub-rect.
 */
export function getCroppedSubRect(fullRect: Rect2D, crop: MediaCrop): Rect2D {
  return {
    x: fullRect.x + crop.left * fullRect.w,
    y: fullRect.y + crop.top * fullRect.h,
    w: Math.max(MIN_ITEM_WORLD_SIZE * 0.25, (crop.right - crop.left) * fullRect.w),
    h: Math.max(MIN_ITEM_WORLD_SIZE * 0.25, (crop.bottom - crop.top) * fullRect.h),
  };
}

/**
 * Compute temporary unwarped full/cropped world rectangles for Crop Mode on ANY WorldElement:
 * - 'free': unfolds to axis-aligned bounding rectangle so full source fills fullRect and crop trims inside it.
 * - 'rect': keeps visible pixels stationary so fullRect expands around the current cropped box.
 */
export function getCropWorkBounds(
  el: Pick<WorldElementBase, 'corners' | 'quadMode' | 'crop'>,
): { fullRect: Rect2D; croppedRect: Rect2D } {
  const bbox = quadToBoundingRect(el.corners, MIN_ITEM_WORLD_SIZE);
  if (el.quadMode === 'free') {
    return {
      fullRect: bbox,
      croppedRect: getCroppedSubRect(bbox, el.crop),
    };
  }
  const u = getUncroppedWorldBounds(bbox, el.crop);
  return {
    fullRect: { x: u.fullX, y: u.fullY, w: u.fullW, h: u.fullH },
    croppedRect: bbox,
  };
}

/**
 * Unified crop drag calculation:
 * - In 'rect' mode: in-place crop where full uncropped media stays stationary in World Space
 *   and BOTH crop and rect shrink/expand together.
 * - In 'free' mode: crop operates on the element's unwarped bounding rectangle (full media fills fullRect),
 *   trimming normalized crop inside fullRect; the new cropped vertices map via free transform to target corners.
 */
export function applyRectCropDrag(
  fullRect: Rect2D,
  baseCrop: MediaCrop,
  handle: ResizeHandle,
  dxWorld: number,
  dyWorld: number,
): { rect: Rect2D; crop: MediaCrop } {
  const minSpanU = Math.max(MIN_CROP_SPAN, MIN_ITEM_WORLD_SIZE / Math.max(1, fullRect.w));
  const minSpanV = Math.max(MIN_CROP_SPAN, MIN_ITEM_WORLD_SIZE / Math.max(1, fullRect.h));

  let { left, top, right, bottom } = baseCrop;
  if (handle.includes('w')) {
    left = Math.max(0, Math.min(right - minSpanU, baseCrop.left + dxWorld / fullRect.w));
  }
  if (handle.includes('e')) {
    right = Math.min(1, Math.max(left + minSpanU, baseCrop.right + dxWorld / fullRect.w));
  }
  if (handle.includes('n')) {
    top = Math.max(0, Math.min(bottom - minSpanV, baseCrop.top + dyWorld / fullRect.h));
  }
  if (handle.includes('s')) {
    bottom = Math.min(1, Math.max(top + minSpanV, baseCrop.bottom + dyWorld / fullRect.h));
  }

  const crop = { left, top, right, bottom };
  return {
    rect: getCroppedSubRect(fullRect, crop),
    crop,
  };
}

export function createCropDraft(
  el: Pick<WorldElementBase, 'id' | 'corners' | 'quadMode' | 'crop'>,
): CropDraft {
  const work = getCropWorkBounds(el);
  return {
    elementId: el.id,
    fullRect: { ...work.fullRect },
    crop: { ...el.crop },
    croppedRect: { ...work.croppedRect },
  };
}

/**
 * Reset any element's world-space size back to its natural dimensions scaled by current crop,
 * proportionally clamped to [1in, 50%vw/vh] (or 50%vw/vh if empty), clamping its center into the
 * visible viewport, and leaving `crop` untouched.
 */
export function resetElementSizeCorners(
  el: Pick<WorldElementBase, 'corners' | 'crop'>,
  naturalW: number,
  naturalH: number,
  viewport: WorldViewportTransform,
  viewportW: number,
  viewportH: number,
  safeInsets: { top: number; right: number; bottom: number; left: number },
): [Point2D, Point2D, Point2D, Point2D] {
  const bbox = quadToBoundingRect(el.corners, MIN_ITEM_WORLD_SIZE);
  const worldCenter = { x: bbox.x + bbox.w * 0.5, y: bbox.y + bbox.h * 0.5 };
  const vpCenter = worldToViewport(worldCenter, viewport);
  const pad = 24;
  const minVpX = safeInsets.left + pad;
  const maxVpX = Math.max(minVpX, viewportW - safeInsets.right - pad);
  const minVpY = safeInsets.top + pad;
  const maxVpY = Math.max(minVpY, viewportH - safeInsets.bottom - pad);
  const clampedCenter = viewportToWorld(
    {
      x: Math.max(minVpX, Math.min(maxVpX, vpCenter.x)),
      y: Math.max(minVpY, Math.min(maxVpY, vpCenter.y)),
    },
    viewport,
  );

  const cw = Math.max(MIN_CROP_SPAN, el.crop.right - el.crop.left);
  const ch = Math.max(MIN_CROP_SPAN, el.crop.bottom - el.crop.top);
  const { w, h } = clampSizeProportional(
    Math.max(1, naturalW) * cw,
    Math.max(1, naturalH) * ch,
    viewportW,
    viewportH,
    viewport.zoom || 1,
  );
  return rectToQuad({
    x: clampedCenter.x - w * 0.5,
    y: clampedCenter.y - h * 0.5,
    w,
    h,
  });
}

/**
 * Pan the background source (`fullRect`) underneath a FIXED crop window (`croppedRect`),
 * clamped so the background always covers the crop window without leaving [0, 1] x [0, 1].
 */
export function applyCropBackgroundPanDrag(
  baseFullRect: Rect2D,
  baseCrop: MediaCrop,
  dxWorld: number,
  dyWorld: number,
): { fullRect: Rect2D; crop: MediaCrop; croppedRect: Rect2D } {
  const cropBox = getCroppedSubRect(baseFullRect, baseCrop);
  const cw = baseCrop.right - baseCrop.left;
  const ch = baseCrop.bottom - baseCrop.top;
  const fullW = Math.max(1, baseFullRect.w);
  const fullH = Math.max(1, baseFullRect.h);
  const left = Math.max(0, Math.min(1 - cw, baseCrop.left - dxWorld / fullW));
  const top = Math.max(0, Math.min(1 - ch, baseCrop.top - dyWorld / fullH));
  const crop: MediaCrop = {
    left,
    top,
    right: left + cw,
    bottom: top + ch,
  };
  const fullRect: Rect2D = {
    x: cropBox.x - left * fullW,
    y: cropBox.y - top * fullH,
    w: fullW,
    h: fullH,
  };
  return {
    fullRect,
    crop,
    croppedRect: cropBox,
  };
}
