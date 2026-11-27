<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  applyHomography,
  computeHomography,
  isConvexQuad,
  rectToQuad,
  type Point2D,
  type Rect2D,
} from '../core/homography';
import {
  applyRectCropDrag,
  cloneQuad,
  createDefaultCrop,
  getCroppedSubRect,
  isItemCropped,
  type CropDraft,
  type MediaCrop,
  type QuadMode,
  type ResizeHandle,
  type SelectableTarget,
  type WorldElement,
} from '../core/canvasItems';
import type { GridBoundsNormalized } from '../core/penpaBridge';
import type { ButtonDisplayMode } from '../core/storage';
import {
  viewportToWorld,
  worldQuadToViewport,
  type WorldViewportTransform,
} from '../core/world';
import { safeAreaInsets } from '../core/safeArea';
import { messages } from '../core/i18n';
import MdActionBtn from './MdActionBtn.vue';
import { beginGlobalDrag, endGlobalDrag, tryCapturePointer, tryReleasePointer } from '../core/dragGuard';

type RectEdge = 'top' | 'right' | 'bottom' | 'left';
const EDGE_NAMES: [RectEdge, RectEdge, RectEdge, RectEdge] = ['top', 'right', 'bottom', 'left'];
const CORNER_HANDLES: [ResizeHandle, ResizeHandle, ResizeHandle, ResizeHandle] = ['nw', 'ne', 'se', 'sw'];
const EDGE_HANDLES: [ResizeHandle, ResizeHandle, ResizeHandle, ResizeHandle] = ['n', 'e', 's', 'w'];

const MIN_RECT_SIZE = 48;
const MIN_FREE_EDGE = 24;

interface ActiveQuadDrag {
  pointerId: number;
  pointerType: string;
  kind: 'corner' | 'edge';
  index: number;
  startPointer: Point2D;
  currentPointer: Point2D;
  grabOffset: Point2D;
}

interface ActiveCropDrag {
  pointerId: number;
  elementId: string;
  handle: ResizeHandle;
  startClient: { x: number; y: number };
  fullRect: Rect2D;
  baseCrop: MediaCrop;
}

interface SafeBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const props = defineProps<{
  selectedTargets: SelectableTarget[];
  hoveredLockedTarget: SelectableTarget | null;
  viewportTransform: WorldViewportTransform;
  worldBoundedToViewport: boolean;
  showLayerOrderActions: boolean;
  buttonDisplayMode: ButtonDisplayMode;
  cropDraft: CropDraft | null;
  gridBounds?: GridBoundsNormalized;
}>();

const emit = defineEmits<{
  (e: 'update-element', id: string, patch: Partial<WorldElement>): void;
  (e: 'update-quad-mode', id: string, mode: QuadMode): void;
  (e: 'reset-size', id: string): void;
  (e: 'start-crop', id: string): void;
  (e: 'update-crop-draft', draft: CropDraft): void;
  (e: 'commit-crop'): void;
  (e: 'cancel-crop'): void;
  (e: 'group-selected'): void;
  (e: 'ungroup-target', id: string): void;
  (e: 'toggle-passthrough', id: string): void;
  (e: 'toggle-dock', id: string): void;
  (e: 'bring-front', id: string): void;
  (e: 'send-back', id: string): void;
  (e: 'remove-element', id: string): void;
  (e: 'unlock-element', id: string): void;
  (e: 'lock-element', id: string): void;
  (e: 'toolbar-bounds-change', rect: { x: number; y: number; w: number; h: number }): void;
  (e: 'hover-toolbar-bounds-change', rect: { x: number; y: number; w: number; h: number }): void;
}>();

const toolbarEl = ref<HTMLDivElement | null>(null);
const hoverToolbarEl = ref<HTMLDivElement | null>(null);
const viewportSize = ref({ w: window.innerWidth || 1280, h: window.innerHeight || 800 });
const hoveredHandle = ref<string | null>(null);

const activeQuadDrags = new Map<number, ActiveQuadDrag>();
let activeCropDrag: ActiveCropDrag | null = null;
const activeHandleKeys = ref<Set<string>>(new Set());
let dragBaselineCorners: [Point2D, Point2D, Point2D, Point2D] | null = null;
let shiftPressed = false;
let altPressed = false;

const isMultiSelect = computed(() => props.selectedTargets.length >= 2);
const singleTarget = computed<SelectableTarget | null>(() =>
  props.selectedTargets.length === 1 ? props.selectedTargets[0] : null,
);
const singleElement = computed<WorldElement | null>(() =>
  singleTarget.value && singleTarget.value.kind !== 'group' ? singleTarget.value : null,
);
const isGroupTarget = computed(() => singleTarget.value?.kind === 'group');
const isLocked = computed(() => !!singleTarget.value?.locked);
const activeCropDraft = computed<CropDraft | null>(() =>
  singleElement.value &&
  !isLocked.value &&
  props.cropDraft &&
  props.cropDraft.elementId === singleElement.value.id
    ? props.cropDraft
    : null,
);
const isCropping = computed(() => !!activeCropDraft.value);
const isFreeQuad = computed(
  () => !!singleElement.value && singleElement.value.quadMode === 'free' && !isCropping.value,
);

function targetHasGrid(t: SelectableTarget | null): boolean {
  if (!t) return false;
  return t.kind === 'grid' || (t.kind === 'group' && t.hasGrid);
}

function targetDockVisible(t: SelectableTarget | null): boolean {
  if (!t) return false;
  return (t.kind === 'grid' || t.kind === 'group') && t.dockVisible;
}

const displayWorldCorners = computed<[Point2D, Point2D, Point2D, Point2D] | null>(() => {
  const t = singleTarget.value;
  if (!t) return null;
  if (activeCropDraft.value) {
    return rectToQuad(activeCropDraft.value.croppedRect);
  }
  return t.corners;
});

const viewportCorners = computed<[Point2D, Point2D, Point2D, Point2D] | null>(() => {
  if (!displayWorldCorners.value) return null;
  return worldQuadToViewport(displayWorldCorners.value, props.viewportTransform);
});

const multiSelectPolys = computed(() => {
  if (!isMultiSelect.value) return [];
  return props.selectedTargets.map((t) => {
    const vp = worldQuadToViewport(t.corners, props.viewportTransform);
    return {
      id: t.id,
      locked: t.locked,
      points: vp.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
    };
  });
});

const multiSelectViewportQuad = computed<[Point2D, Point2D, Point2D, Point2D] | null>(() => {
  if (!isMultiSelect.value) return null;
  // Anchor multi-select floating toolbar beside the LAST clicked target rather than the combined center
  const lastTarget = props.selectedTargets[props.selectedTargets.length - 1];
  if (!lastTarget) return null;
  return worldQuadToViewport(lastTarget.corners, props.viewportTransform);
});

const quadPointsSvg = computed(() => {
  const c = viewportCorners.value;
  if (!c) return '';
  return c.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
});

const quadCenter = computed<Point2D | null>(() => {
  const c = viewportCorners.value;
  if (!c) return null;
  const unitH = computeHomography(
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    c,
  );
  if (unitH) {
    const pt = applyHomography(unitH, 0.5, 0.5);
    if (pt) return pt;
  }
  return {
    x: (c[0].x + c[1].x + c[2].x + c[3].x) * 0.25,
    y: (c[0].y + c[1].y + c[2].y + c[3].y) * 0.25,
  };
});

function unitVec(ax: number, ay: number, bx: number, by: number): { ux: number; uy: number; len: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return { ux: 1, uy: 0, len: 0 };
  return { ux: dx / len, uy: dy / len, len };
}

const cornerBrackets = computed(() => {
  const c = viewportCorners.value;
  if (!c) return [];
  return c.map((pt, idx) => {
    const prev = c[(idx + 3) % 4];
    const next = c[(idx + 1) % 4];
    const vPrev = unitVec(pt.x, pt.y, prev.x, prev.y);
    const vNext = unitVec(pt.x, pt.y, next.x, next.y);
    const arm = Math.max(10, Math.min(24, vPrev.len * 0.24, vNext.len * 0.24));
    const p1x = pt.x + vPrev.ux * arm;
    const p1y = pt.y + vPrev.uy * arm;
    const p2x = pt.x + vNext.ux * arm;
    const p2y = pt.y + vNext.uy * arm;
    const d = `M ${p1x.toFixed(1)} ${p1y.toFixed(1)} L ${pt.x.toFixed(1)} ${pt.y.toFixed(1)} L ${p2x.toFixed(1)} ${p2y.toFixed(1)}`;
    const cursorClass = isFreeQuad.value
      ? 'cur-grab'
      : idx === 0 || idx === 2
        ? 'cur-nwse'
        : 'cur-nesw';
    return { idx, x: pt.x, y: pt.y, d, cursorClass };
  });
});

const edgeBars = computed(() => {
  const c = viewportCorners.value;
  if (!c) return [];
  return EDGE_NAMES.map((edge, idx) => {
    const a = c[idx];
    const b = c[(idx + 1) % 4];
    const { ux, uy, len } = unitVec(a.x, a.y, b.x, b.y);
    const mx = (a.x + b.x) * 0.5;
    const my = (a.y + b.y) * 0.5;
    const halfBar = Math.max(8, Math.min(20, len * 0.18));
    const cursorClass = isFreeQuad.value
      ? 'cur-grab'
      : idx === 0 || idx === 2
        ? 'cur-ns'
        : 'cur-ew';
    return {
      idx,
      edge,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      bx1: mx - ux * halfBar,
      by1: my - uy * halfBar,
      bx2: mx + ux * halfBar,
      by2: my + uy * halfBar,
      cursorClass,
    };
  });
});

function computeFloatingToolbarPos(
  c: [Point2D, Point2D, Point2D, Point2D],
  elRef: HTMLDivElement | null,
  fallbackW = 260,
): { left: string; top: string } {
  const minX = Math.min(c[0].x, c[1].x, c[2].x, c[3].x);
  const maxX = Math.max(c[0].x, c[1].x, c[2].x, c[3].x);
  const minY = Math.min(c[0].y, c[1].y, c[2].y, c[3].y);
  const maxY = Math.max(c[0].y, c[1].y, c[2].y, c[3].y);
  const safe = safeAreaInsets.value;
  const vw = viewportSize.value.w;
  const vh = viewportSize.value.h;
  const cx = (minX + maxX) * 0.5;
  const tbW = elRef?.offsetWidth || fallbackW;
  const tbH = elRef?.offsetHeight || 36;
  const halfW = tbW * 0.5;
  const minLeft = safe.left + halfW + 8;
  const maxLeft = Math.max(minLeft, vw - safe.right - halfW - 8);
  const left = Math.max(minLeft, Math.min(maxLeft, cx));

  const minTop = safe.top + 8;
  const maxTop = Math.max(minTop, vh - safe.bottom - tbH - 8);
  const preferTop = minY - tbH - 10;
  const belowTop = maxY + 12;
  let top: number;
  if (preferTop >= safe.top + 54 && preferTop <= maxTop) {
    top = preferTop;
  } else if (belowTop >= minTop && belowTop <= maxTop) {
    top = belowTop;
  } else {
    top = Math.max(minTop, Math.min(maxTop, preferTop));
  }
  return {
    left: `${left}px`,
    top: `${top}px`,
  };
}

const floatingToolbarStyle = computed(() => {
  const c = isMultiSelect.value ? multiSelectViewportQuad.value : viewportCorners.value;
  if (!c) return null;
  return computeFloatingToolbarPos(c, toolbarEl.value, isMultiSelect.value ? 120 : 320);
});

const distinctHoveredLocked = computed<SelectableTarget | null>(() => {
  const h = props.hoveredLockedTarget;
  if (!h || !h.locked || !h.visible) return null;
  if (singleTarget.value && singleTarget.value.id === h.id && floatingToolbarStyle.value) return null;
  return h;
});

const hoverToolbarStyle = computed(() => {
  const h = distinctHoveredLocked.value;
  if (!h) return null;
  const vp = worldQuadToViewport(h.corners, props.viewportTransform);
  return computeFloatingToolbarPos(vp, hoverToolbarEl.value, 180);
});

function reportToolbarBounds() {
  if (props.selectedTargets.length === 0 || !toolbarEl.value) {
    emit('toolbar-bounds-change', { x: 0, y: 0, w: 0, h: 0 });
  } else {
    const r = toolbarEl.value.getBoundingClientRect();
    emit('toolbar-bounds-change', { x: r.left, y: r.top, w: r.width, h: r.height });
  }

  if (!distinctHoveredLocked.value || !hoverToolbarEl.value) {
    emit('hover-toolbar-bounds-change', { x: 0, y: 0, w: 0, h: 0 });
  } else {
    const r = hoverToolbarEl.value.getBoundingClientRect();
    emit('hover-toolbar-bounds-change', { x: r.left, y: r.top, w: r.width, h: r.height });
  }
}

watch(
  [
    () => props.selectedTargets,
    () => props.hoveredLockedTarget,
    () => props.viewportTransform,
    () => props.cropDraft,
    () => props.buttonDisplayMode,
  ],
  () => {
    requestAnimationFrame(reportToolbarBounds);
  },
  { deep: true },
);

watch(
  () =>
    `${props.selectedTargets.map((t) => t.id).join(',')}|${singleElement.value?.quadMode ?? ''}|${isLocked.value}|${isCropping.value}`,
  () => {
    hoveredHandle.value = null;
    clearAllDrags();
  },
);

// --- Unified Quad Geometry Helpers (Shared by Grid, Image, and Screen!) ---
function clampVal(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clampPoint(p: Point2D, b: SafeBounds): Point2D {
  return { x: clampVal(p.x, b.minX, b.maxX), y: clampVal(p.y, b.minY, b.maxY) };
}

function subPt(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function lerpPt(a: Point2D, b: Point2D, t: number): Point2D {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function cross2(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function intersectLines(p1: Point2D, d1: Point2D, p2: Point2D, d2: Point2D): Point2D | null {
  const denom = cross2(d1.x, d1.y, d2.x, d2.y);
  if (Math.abs(denom) < 1e-6) return null;
  const rx = p2.x - p1.x;
  const ry = p2.y - p1.y;
  const t = cross2(rx, ry, d2.x, d2.y) / denom;
  if (!Number.isFinite(t)) return null;
  return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

function quadCentroid(c: [Point2D, Point2D, Point2D, Point2D]): Point2D {
  return {
    x: (c[0].x + c[1].x + c[2].x + c[3].x) * 0.25,
    y: (c[0].y + c[1].y + c[2].y + c[3].y) * 0.25,
  };
}

function sameEdgeDirections(
  base: [Point2D, Point2D, Point2D, Point2D],
  cand: [Point2D, Point2D, Point2D, Point2D],
): boolean {
  for (let i = 0; i < 4; i++) {
    const b0 = base[i];
    const b1 = base[(i + 1) % 4];
    const c0 = cand[i];
    const c1 = cand[(i + 1) % 4];
    const dot = (c1.x - c0.x) * (b1.x - b0.x) + (c1.y - c0.y) * (b1.y - b0.y);
    if (dot <= 0) return false;
  }
  return true;
}

function isValidQuadInBounds(
  pts: [Point2D, Point2D, Point2D, Point2D],
  bounds: SafeBounds,
): boolean {
  for (let i = 0; i < 4; i++) {
    const p = pts[i];
    if (
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      p.x < bounds.minX - 0.5 ||
      p.x > bounds.maxX + 0.5 ||
      p.y < bounds.minY - 0.5 ||
      p.y > bounds.maxY + 0.5
    ) {
      return false;
    }
    const q = pts[(i + 1) % 4];
    if (Math.hypot(q.x - p.x, q.y - p.y) < MIN_FREE_EDGE) return false;
  }
  return isConvexQuad(pts);
}

function solveMaxValidAlpha(
  evalAt: (alpha: number) => [Point2D, Point2D, Point2D, Point2D] | null,
  bounds: SafeBounds,
  extraCheck?: (cand: [Point2D, Point2D, Point2D, Point2D]) => boolean,
): [Point2D, Point2D, Point2D, Point2D] | null {
  const isOk = (c: [Point2D, Point2D, Point2D, Point2D] | null): c is [Point2D, Point2D, Point2D, Point2D] =>
    !!c && isValidQuadInBounds(c, bounds) && (!extraCheck || extraCheck(c));

  const full = evalAt(1);
  if (isOk(full)) return full;

  let lo = 0;
  let hi = 1;
  let best: [Point2D, Point2D, Point2D, Point2D] | null = null;
  for (let iter = 0; iter < 18; iter++) {
    const mid = (lo + hi) * 0.5;
    const cand = evalAt(mid);
    if (isOk(cand)) {
      best = cand;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

function makeRectCorners(left: number, right: number, top: number, bottom: number): [Point2D, Point2D, Point2D, Point2D] {
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

const capturedGizmoPointers = new Map<number, Element>();
let gizmoGlobalDragHeld = false;

function syncActiveHandleKeys() {
  const next = new Set<string>();
  for (const d of activeQuadDrags.values()) {
    next.add(d.kind === 'corner' ? `c-${d.index}` : `e-${d.index}`);
  }
  if (activeCropDrag) {
    const cIdx = CORNER_HANDLES.indexOf(activeCropDrag.handle);
    if (cIdx >= 0) next.add(`c-${cIdx}`);
    const eIdx = EDGE_HANDLES.indexOf(activeCropDrag.handle);
    if (eIdx >= 0) next.add(`e-${eIdx}`);
  }
  activeHandleKeys.value = next;

  const draggingNow = activeQuadDrags.size > 0 || !!activeCropDrag;
  if (draggingNow && !gizmoGlobalDragHeld) {
    gizmoGlobalDragHeld = true;
    beginGlobalDrag();
  } else if (!draggingNow && gizmoGlobalDragHeld) {
    gizmoGlobalDragHeld = false;
    endGlobalDrag();
  }
}

function captureGizmoPointer(pointerId: number) {
  const el = tryCapturePointer(document.documentElement, pointerId);
  if (el) capturedGizmoPointers.set(pointerId, el);
}

function releaseGizmoPointer(pointerId: number) {
  const el = capturedGizmoPointers.get(pointerId);
  if (el) {
    tryReleasePointer(el, pointerId);
    capturedGizmoPointers.delete(pointerId);
  }
}

function clearAllDrags() {
  for (const [pid, el] of capturedGizmoPointers.entries()) {
    tryReleasePointer(el, pid);
  }
  capturedGizmoPointers.clear();
  activeQuadDrags.clear();
  activeCropDrag = null;
  dragBaselineCorners = null;
  syncActiveHandleKeys();
}

function resnapshotQuadDrags(corners: [Point2D, Point2D, Point2D, Point2D]) {
  dragBaselineCorners = cloneQuad(corners);
  for (const d of activeQuadDrags.values()) {
    d.startPointer = { ...d.currentPointer };
    if (d.kind === 'corner') {
      d.grabOffset = {
        x: corners[d.index].x - d.currentPointer.x,
        y: corners[d.index].y - d.currentPointer.y,
      };
    } else {
      d.grabOffset = { x: 0, y: 0 };
    }
  }
}

function getSafeWorldBounds(): SafeBounds {
  // Elements are allowed to move/resize freely beyond the viewport bounds
  return { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 };
}

function getWorldPointer(e: PointerEvent): Point2D {
  return viewportToWorld({ x: e.clientX, y: e.clientY }, props.viewportTransform);
}

function applySingleRectDrag(
  drag: ActiveQuadDrag,
  base: [Point2D, Point2D, Point2D, Point2D],
  bounds: SafeBounds,
): [Point2D, Point2D, Point2D, Point2D] {
  const L0 = Math.min(base[0].x, base[3].x);
  const R0 = Math.max(base[1].x, base[2].x);
  const T0 = Math.min(base[0].y, base[1].y);
  const B0 = Math.max(base[2].y, base[3].y);
  const W0 = Math.max(MIN_RECT_SIZE, R0 - L0);
  const H0 = Math.max(MIN_RECT_SIZE, B0 - T0);
  const cx0 = (L0 + R0) * 0.5;
  const cy0 = (T0 + B0) * 0.5;

  if (drag.kind === 'corner') {
    const idx = drag.index;
    const sx = idx === 1 || idx === 2 ? 1 : -1;
    const sy = idx === 2 || idx === 3 ? 1 : -1;
    // Touch corner drag defaults to preserving aspect ratio; mouse/pen defaults to free stretch (Shift toggles)
    const keepAspect = drag.pointerType === 'touch' ? !shiftPressed : shiftPressed;
    const target = {
      x: drag.currentPointer.x + drag.grabOffset.x,
      y: drag.currentPointer.y + drag.grabOffset.y,
    };

    if (keepAspect && altPressed) {
      const hw0 = W0 * 0.5;
      const hh0 = H0 * 0.5;
      const vx = sx * (target.x - cx0);
      const vy = sy * (target.y - cy0);
      const maxHw = Math.max(MIN_RECT_SIZE * 0.5, Math.min(cx0 - bounds.minX, bounds.maxX - cx0));
      const maxHh = Math.max(MIN_RECT_SIZE * 0.5, Math.min(cy0 - bounds.minY, bounds.maxY - cy0));
      const sMax = Math.min(maxHw / hw0, maxHh / hh0);
      const sMin = Math.min(sMax, Math.max(MIN_RECT_SIZE / W0, MIN_RECT_SIZE / H0));
      const rawS = (vx * hw0 + vy * hh0) / (hw0 * hw0 + hh0 * hh0);
      const s = clampVal(rawS, sMin, sMax);
      return makeRectCorners(cx0 - hw0 * s, cx0 + hw0 * s, cy0 - hh0 * s, cy0 + hh0 * s);
    }

    if (keepAspect) {
      const ax = sx > 0 ? L0 : R0;
      const ay = sy > 0 ? T0 : B0;
      const vx = sx * (target.x - ax);
      const vy = sy * (target.y - ay);
      const maxW = Math.max(MIN_RECT_SIZE, sx > 0 ? bounds.maxX - ax : ax - bounds.minX);
      const maxH = Math.max(MIN_RECT_SIZE, sy > 0 ? bounds.maxY - ay : ay - bounds.minY);
      const sMax = Math.min(maxW / W0, maxH / H0);
      const sMin = Math.min(sMax, Math.max(MIN_RECT_SIZE / W0, MIN_RECT_SIZE / H0));
      const rawS = (vx * W0 + vy * H0) / (W0 * W0 + H0 * H0);
      const s = clampVal(rawS, sMin, sMax);
      const nw = W0 * s;
      const nh = H0 * s;
      return makeRectCorners(
        sx > 0 ? ax : ax - nw,
        sx > 0 ? ax + nw : ax,
        sy > 0 ? ay : ay - nh,
        sy > 0 ? ay + nh : ay,
      );
    }

    if (altPressed) {
      const maxHw = Math.max(MIN_RECT_SIZE * 0.5, Math.min(cx0 - bounds.minX, bounds.maxX - cx0));
      const maxHh = Math.max(MIN_RECT_SIZE * 0.5, Math.min(cy0 - bounds.minY, bounds.maxY - cy0));
      const hw = clampVal(sx * (target.x - cx0), MIN_RECT_SIZE * 0.5, maxHw);
      const hh = clampVal(sy * (target.y - cy0), MIN_RECT_SIZE * 0.5, maxHh);
      return makeRectCorners(cx0 - hw, cx0 + hw, cy0 - hh, cy0 + hh);
    }

    const nx = clampVal(target.x, bounds.minX, bounds.maxX);
    const ny = clampVal(target.y, bounds.minY, bounds.maxY);
    let left = L0;
    let right = R0;
    let top = T0;
    let bottom = B0;
    if (idx === 0) {
      left = Math.min(nx, R0 - MIN_RECT_SIZE);
      top = Math.min(ny, B0 - MIN_RECT_SIZE);
    } else if (idx === 1) {
      right = Math.max(nx, L0 + MIN_RECT_SIZE);
      top = Math.min(ny, B0 - MIN_RECT_SIZE);
    } else if (idx === 2) {
      right = Math.max(nx, L0 + MIN_RECT_SIZE);
      bottom = Math.max(ny, T0 + MIN_RECT_SIZE);
    } else if (idx === 3) {
      left = Math.min(nx, R0 - MIN_RECT_SIZE);
      bottom = Math.max(ny, T0 + MIN_RECT_SIZE);
    }
    return makeRectCorners(left, right, top, bottom);
  }

  const edge = EDGE_NAMES[drag.index];
  const dx = drag.currentPointer.x - drag.startPointer.x;
  const dy = drag.currentPointer.y - drag.startPointer.y;
  let left = L0;
  let right = R0;
  let top = T0;
  let bottom = B0;

  if (altPressed) {
    const maxHw = Math.max(MIN_RECT_SIZE * 0.5, Math.min(cx0 - bounds.minX, bounds.maxX - cx0));
    const maxHh = Math.max(MIN_RECT_SIZE * 0.5, Math.min(cy0 - bounds.minY, bounds.maxY - cy0));
    if (edge === 'top' || edge === 'bottom') {
      const hh = clampVal(H0 * 0.5 + (edge === 'bottom' ? dy : -dy), MIN_RECT_SIZE * 0.5, maxHh);
      return makeRectCorners(L0, R0, cy0 - hh, cy0 + hh);
    }
    const hw = clampVal(W0 * 0.5 + (edge === 'right' ? dx : -dx), MIN_RECT_SIZE * 0.5, maxHw);
    return makeRectCorners(cx0 - hw, cx0 + hw, T0, B0);
  }

  if (edge === 'top') top = clampVal(T0 + dy, bounds.minY, B0 - MIN_RECT_SIZE);
  else if (edge === 'bottom') bottom = clampVal(B0 + dy, T0 + MIN_RECT_SIZE, bounds.maxY);
  else if (edge === 'left') left = clampVal(L0 + dx, bounds.minX, R0 - MIN_RECT_SIZE);
  else if (edge === 'right') right = clampVal(R0 + dx, L0 + MIN_RECT_SIZE, bounds.maxX);
  return makeRectCorners(left, right, top, bottom);
}

function applySingleFreeDrag(
  drag: ActiveQuadDrag,
  base: [Point2D, Point2D, Point2D, Point2D],
  bounds: SafeBounds,
): [Point2D, Point2D, Point2D, Point2D] | null {
  if (drag.kind === 'corner') {
    const idx = drag.index;
    const opp = (idx + 2) % 4;
    const adjA = (idx + 3) % 4;
    const adjB = (idx + 1) % 4;
    const target = clampPoint(
      {
        x: drag.currentPointer.x + drag.grabOffset.x,
        y: drag.currentPointer.y + drag.grabOffset.y,
      },
      bounds,
    );

    if (shiftPressed && altPressed) {
      const c0 = quadCentroid(base);
      const v0 = subPt(base[idx], c0);
      const v0Sq = v0.x * v0.x + v0.y * v0.y;
      const vt = subPt(target, c0);
      const rawS = v0Sq > 1e-6 ? (vt.x * v0.x + vt.y * v0.y) / v0Sq : 1;
      return solveMaxValidAlpha(
        (alpha) => {
          const s = 1 + alpha * (rawS - 1);
          if (s <= 0.01) return null;
          return [
            { x: c0.x + (base[0].x - c0.x) * s, y: c0.y + (base[0].y - c0.y) * s },
            { x: c0.x + (base[1].x - c0.x) * s, y: c0.y + (base[1].y - c0.y) * s },
            { x: c0.x + (base[2].x - c0.x) * s, y: c0.y + (base[2].y - c0.y) * s },
            { x: c0.x + (base[3].x - c0.x) * s, y: c0.y + (base[3].y - c0.y) * s },
          ];
        },
        bounds,
        (cand) => sameEdgeDirections(base, cand),
      );
    }

    if (shiftPressed) {
      const O = base[opp];
      const A0 = base[adjA];
      const B0 = base[adjB];
      const C0 = base[idx];
      const dOA = subPt(A0, O);
      const dOB = subPt(B0, O);
      const dCA = subPt(A0, C0);
      const dCB = subPt(B0, C0);
      return solveMaxValidAlpha(
        (alpha) => {
          const Q = lerpPt(C0, target, alpha);
          const nextA = intersectLines(O, dOA, Q, dCA);
          const nextB = intersectLines(O, dOB, Q, dCB);
          if (!nextA || !nextB) return null;
          const cand = cloneQuad(base);
          cand[opp] = { ...O };
          cand[idx] = Q;
          cand[adjA] = nextA;
          cand[adjB] = nextB;
          return cand;
        },
        bounds,
        (cand) => sameEdgeDirections(base, cand),
      );
    }

    if (altPressed) {
      const d = subPt(target, base[idx]);
      return solveMaxValidAlpha((alpha) => {
        const cand = cloneQuad(base);
        cand[idx] = { x: base[idx].x + d.x * alpha, y: base[idx].y + d.y * alpha };
        cand[opp] = { x: base[opp].x - d.x * alpha, y: base[opp].y - d.y * alpha };
        return cand;
      }, bounds);
    }

    const direct = cloneQuad(base);
    direct[idx] = target;
    if (isValidQuadInBounds(direct, bounds)) return direct;
    return solveMaxValidAlpha((alpha) => {
      const cand = cloneQuad(base);
      cand[idx] = lerpPt(base[idx], target, alpha);
      return cand;
    }, bounds);
  }

  const i0 = drag.index;
  const i1 = (i0 + 1) % 4;
  const j0 = (i0 + 2) % 4;
  const j1 = (i0 + 3) % 4;
  const d = subPt(drag.currentPointer, drag.startPointer);

  if (shiftPressed && altPressed) {
    const eDir = subPt(base[i1], base[i0]);
    const oppDir = subPt(base[j1], base[j0]);
    const adj0Dir = subPt(base[i0], base[j1]);
    const adj1Dir = subPt(base[i1], base[j0]);
    return solveMaxValidAlpha(
      (alpha) => {
        const pDrag = { x: base[i0].x + d.x * alpha, y: base[i0].y + d.y * alpha };
        const pOpp = { x: base[j0].x - d.x * alpha, y: base[j0].y - d.y * alpha };
        const newI0 = intersectLines(base[j1], adj0Dir, pDrag, eDir);
        const newI1 = intersectLines(base[j0], adj1Dir, pDrag, eDir);
        const newJ0 = intersectLines(base[j0], adj1Dir, pOpp, oppDir);
        const newJ1 = intersectLines(base[j1], adj0Dir, pOpp, oppDir);
        if (!newI0 || !newI1 || !newJ0 || !newJ1) return null;
        const cand = cloneQuad(base);
        cand[i0] = newI0;
        cand[i1] = newI1;
        cand[j0] = newJ0;
        cand[j1] = newJ1;
        return cand;
      },
      bounds,
      (cand) => sameEdgeDirections(base, cand),
    );
  }

  if (shiftPressed) {
    const eDir = subPt(base[i1], base[i0]);
    const adj0Dir = subPt(base[i0], base[j1]);
    const adj1Dir = subPt(base[i1], base[j0]);
    return solveMaxValidAlpha(
      (alpha) => {
        const pDrag = { x: base[i0].x + d.x * alpha, y: base[i0].y + d.y * alpha };
        const newI0 = intersectLines(base[j1], adj0Dir, pDrag, eDir);
        const newI1 = intersectLines(base[j0], adj1Dir, pDrag, eDir);
        if (!newI0 || !newI1) return null;
        const cand = cloneQuad(base);
        cand[i0] = newI0;
        cand[i1] = newI1;
        cand[j0] = { ...base[j0] };
        cand[j1] = { ...base[j1] };
        return cand;
      },
      bounds,
      (cand) => sameEdgeDirections(base, cand),
    );
  }

  if (altPressed) {
    return solveMaxValidAlpha((alpha) => {
      const cand = cloneQuad(base);
      cand[i0] = { x: base[i0].x + d.x * alpha, y: base[i0].y + d.y * alpha };
      cand[i1] = { x: base[i1].x + d.x * alpha, y: base[i1].y + d.y * alpha };
      cand[j0] = { x: base[j0].x - d.x * alpha, y: base[j0].y - d.y * alpha };
      cand[j1] = { x: base[j1].x - d.x * alpha, y: base[j1].y - d.y * alpha };
      return cand;
    }, bounds);
  }

  return solveMaxValidAlpha((alpha) => {
    const cand = cloneQuad(base);
    cand[i0] = clampPoint({ x: base[i0].x + d.x * alpha, y: base[i0].y + d.y * alpha }, bounds);
    cand[i1] = clampPoint({ x: base[i1].x + d.x * alpha, y: base[i1].y + d.y * alpha }, bounds);
    return cand;
  }, bounds);
}

function applyMultiTouchRectDrag(
  drags: ActiveQuadDrag[],
  base: [Point2D, Point2D, Point2D, Point2D],
  bounds: SafeBounds,
): [Point2D, Point2D, Point2D, Point2D] {
  const L0 = Math.min(base[0].x, base[3].x);
  const R0 = Math.max(base[1].x, base[2].x);
  const T0 = Math.min(base[0].y, base[1].y);
  const B0 = Math.max(base[2].y, base[3].y);
  const leftVals: number[] = [];
  const rightVals: number[] = [];
  const topVals: number[] = [];
  const bottomVals: number[] = [];

  for (const drag of drags) {
    if (drag.kind === 'corner') {
      const tx = clampVal(drag.currentPointer.x + drag.grabOffset.x, bounds.minX, bounds.maxX);
      const ty = clampVal(drag.currentPointer.y + drag.grabOffset.y, bounds.minY, bounds.maxY);
      if (drag.index === 0 || drag.index === 3) leftVals.push(tx);
      if (drag.index === 1 || drag.index === 2) rightVals.push(tx);
      if (drag.index === 0 || drag.index === 1) topVals.push(ty);
      if (drag.index === 2 || drag.index === 3) bottomVals.push(ty);
    } else {
      const dx = drag.currentPointer.x - drag.startPointer.x;
      const dy = drag.currentPointer.y - drag.startPointer.y;
      const edge = EDGE_NAMES[drag.index];
      if (edge === 'top') topVals.push(clampVal(T0 + dy, bounds.minY, bounds.maxY));
      else if (edge === 'bottom') bottomVals.push(clampVal(B0 + dy, bounds.minY, bounds.maxY));
      else if (edge === 'left') leftVals.push(clampVal(L0 + dx, bounds.minX, bounds.maxX));
      else if (edge === 'right') rightVals.push(clampVal(R0 + dx, bounds.minX, bounds.maxX));
    }
  }

  const avg = (arr: number[], fallback: number) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : fallback;

  let left = avg(leftVals, L0);
  let right = avg(rightVals, R0);
  let top = avg(topVals, T0);
  let bottom = avg(bottomVals, B0);

  if (right - left < MIN_RECT_SIZE) {
    if (leftVals.length && rightVals.length) {
      const mid = clampVal((left + right) * 0.5, bounds.minX + MIN_RECT_SIZE * 0.5, bounds.maxX - MIN_RECT_SIZE * 0.5);
      left = mid - MIN_RECT_SIZE * 0.5;
      right = mid + MIN_RECT_SIZE * 0.5;
    } else if (leftVals.length) {
      left = Math.max(bounds.minX, right - MIN_RECT_SIZE);
    } else {
      right = Math.min(bounds.maxX, left + MIN_RECT_SIZE);
    }
  }

  if (bottom - top < MIN_RECT_SIZE) {
    if (topVals.length && bottomVals.length) {
      const mid = clampVal((top + bottom) * 0.5, bounds.minY + MIN_RECT_SIZE * 0.5, bounds.maxY - MIN_RECT_SIZE * 0.5);
      top = mid - MIN_RECT_SIZE * 0.5;
      bottom = mid + MIN_RECT_SIZE * 0.5;
    } else if (topVals.length) {
      top = Math.max(bounds.minY, bottom - MIN_RECT_SIZE);
    } else {
      bottom = Math.min(bounds.maxY, top + MIN_RECT_SIZE);
    }
  }

  return makeRectCorners(left, right, top, bottom);
}

function applyMultiTouchFreeDrag(
  drags: ActiveQuadDrag[],
  base: [Point2D, Point2D, Point2D, Point2D],
  currentCorners: [Point2D, Point2D, Point2D, Point2D],
  bounds: SafeBounds,
): [Point2D, Point2D, Point2D, Point2D] | null {
  const cornerTargets = new Map<number, Point2D>();
  const edgeDeltas = new Map<number, Point2D>();

  for (const drag of drags) {
    if (drag.kind === 'corner') {
      cornerTargets.set(
        drag.index,
        clampPoint(
          {
            x: drag.currentPointer.x + drag.grabOffset.x,
            y: drag.currentPointer.y + drag.grabOffset.y,
          },
          bounds,
        ),
      );
    } else {
      edgeDeltas.set(drag.index, subPt(drag.currentPointer, drag.startPointer));
    }
  }

  const target = cloneQuad(base);
  for (let v = 0; v < 4; v++) {
    const explicit = cornerTargets.get(v);
    if (explicit) {
      target[v] = explicit;
      continue;
    }
    const ePrev = (v + 3) % 4;
    const eNext = v;
    const dPrev = edgeDeltas.get(ePrev);
    const dNext = edgeDeltas.get(eNext);
    if (dPrev && dNext) {
      const prevDir = subPt(base[v], base[ePrev]);
      const nextDir = subPt(base[(v + 1) % 4], base[v]);
      const pPrev = { x: base[v].x + dPrev.x, y: base[v].y + dPrev.y };
      const pNext = { x: base[v].x + dNext.x, y: base[v].y + dNext.y };
      const inter = intersectLines(pPrev, prevDir, pNext, nextDir);
      target[v] = clampPoint(
        inter ?? { x: base[v].x + (dPrev.x + dNext.x) * 0.5, y: base[v].y + (dPrev.y + dNext.y) * 0.5 },
        bounds,
      );
    } else if (dPrev) {
      target[v] = clampPoint({ x: base[v].x + dPrev.x, y: base[v].y + dPrev.y }, bounds);
    } else if (dNext) {
      target[v] = clampPoint({ x: base[v].x + dNext.x, y: base[v].y + dNext.y }, bounds);
    }
  }

  if (isValidQuadInBounds(target, bounds)) return target;

  const startValid = cloneQuad(currentCorners);
  return solveMaxValidAlpha(
    (alpha) => [
      lerpPt(startValid[0], target[0], alpha),
      lerpPt(startValid[1], target[1], alpha),
      lerpPt(startValid[2], target[2], alpha),
      lerpPt(startValid[3], target[3], alpha),
    ],
    bounds,
  );
}

function applyActiveQuadDrags() {
  const el = singleElement.value;
  if (!el || !dragBaselineCorners || activeQuadDrags.size === 0) return;
  const bounds = getSafeWorldBounds();
  const base = dragBaselineCorners;
  const drags = Array.from(activeQuadDrags.values());

  if (el.quadMode === 'rect') {
    const next =
      drags.length === 1
        ? applySingleRectDrag(drags[0], base, bounds)
        : applyMultiTouchRectDrag(drags, base, bounds);
    emit('update-element', el.id, { corners: next });
    return;
  }

  const next =
    drags.length === 1
      ? applySingleFreeDrag(drags[0], base, bounds)
      : applyMultiTouchFreeDrag(drags, base, el.corners, bounds);
  if (next) {
    emit('update-element', el.id, { corners: next });
  }
}

// --- Unified Handle Drag Starters (ONE path for Grid, Image, Screen!) ---
function startHandleDrag(kind: 'corner' | 'edge', idx: number, e: PointerEvent) {
  const el = singleElement.value;
  if (!el || el.locked) return;
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  e.preventDefault();
  e.stopPropagation();

  if (activeCropDraft.value) {
    activeCropDrag = {
      pointerId: e.pointerId,
      elementId: activeCropDraft.value.elementId,
      handle: kind === 'corner' ? CORNER_HANDLES[idx] : EDGE_HANDLES[idx],
      startClient: { x: e.clientX, y: e.clientY },
      fullRect: { ...activeCropDraft.value.fullRect },
      baseCrop: { ...activeCropDraft.value.crop },
    };
    captureGizmoPointer(e.pointerId);
    syncActiveHandleKeys();
    return;
  }

  const ptr = getWorldPointer(e);
  for (const d of activeQuadDrags.values()) {
    if (d.kind === kind && d.index === idx) return;
  }
  shiftPressed = e.shiftKey;
  altPressed = e.altKey;
  if (activeQuadDrags.size === 0) dragBaselineCorners = cloneQuad(el.corners);
  else resnapshotQuadDrags(el.corners);

  activeQuadDrags.set(e.pointerId, {
    pointerId: e.pointerId,
    pointerType: e.pointerType || 'mouse',
    kind,
    index: idx,
    startPointer: { ...ptr },
    currentPointer: { ...ptr },
    grabOffset:
      kind === 'corner'
        ? { x: el.corners[idx].x - ptr.x, y: el.corners[idx].y - ptr.y }
        : { x: 0, y: 0 },
  });
  captureGizmoPointer(e.pointerId);
  syncActiveHandleKeys();
}

function onGizmoPointerMove(e: PointerEvent) {
  if (activeQuadDrags.has(e.pointerId)) {
    const drag = activeQuadDrags.get(e.pointerId)!;
    e.preventDefault();
    drag.currentPointer = getWorldPointer(e);
    shiftPressed = e.shiftKey;
    altPressed = e.altKey;
    applyActiveQuadDrags();
    return;
  }

  if (activeCropDrag && e.pointerId === activeCropDrag.pointerId && singleElement.value) {
    e.preventDefault();
    const z = props.viewportTransform.zoom || 1;
    const dxWorld = (e.clientX - activeCropDrag.startClient.x) / z;
    const dyWorld = (e.clientY - activeCropDrag.startClient.y) / z;
    const res = applyRectCropDrag(
      activeCropDrag.fullRect,
      activeCropDrag.baseCrop,
      activeCropDrag.handle,
      dxWorld,
      dyWorld,
    );
    emit('update-crop-draft', {
      elementId: activeCropDrag.elementId,
      fullRect: { ...activeCropDrag.fullRect },
      crop: res.crop,
      croppedRect: res.rect,
    });
  }
}

function onGizmoPointerEnd(e: PointerEvent) {
  if (activeQuadDrags.has(e.pointerId)) {
    activeQuadDrags.delete(e.pointerId);
    releaseGizmoPointer(e.pointerId);
    syncActiveHandleKeys();
    if (activeQuadDrags.size === 0) {
      dragBaselineCorners = null;
    } else if (singleElement.value) {
      resnapshotQuadDrags(singleElement.value.corners);
    }
    return;
  }

  if (activeCropDrag && e.pointerId === activeCropDrag.pointerId) {
    activeCropDrag = null;
    releaseGizmoPointer(e.pointerId);
    syncActiveHandleKeys();
  }
}

// --- Unified Floating Toolbar Actions ---
function handleResetCrop() {
  const draft = activeCropDraft.value;
  if (!draft) return;
  const crop = createDefaultCrop();
  emit('update-crop-draft', {
    elementId: draft.elementId,
    fullRect: { ...draft.fullRect },
    crop,
    croppedRect: { ...draft.fullRect },
  });
}

function handleCropGridMargins() {
  const draft = activeCropDraft.value;
  const gb = props.gridBounds;
  if (!draft || !gb) return;
  const left = Math.max(0, Math.min(0.95, gb.u0));
  const top = Math.max(0, Math.min(0.95, gb.v0));
  const right = Math.min(1, Math.max(left + 0.05, gb.u1));
  const bottom = Math.min(1, Math.max(top + 0.05, gb.v1));
  const crop: MediaCrop = { left, top, right, bottom };
  emit('update-crop-draft', {
    elementId: draft.elementId,
    fullRect: { ...draft.fullRect },
    crop,
    croppedRect: getCroppedSubRect(draft.fullRect, crop),
  });
}

function handleToggleLockFor(t: SelectableTarget | null) {
  if (!t) return;
  if (t.locked) {
    emit('unlock-element', t.id);
  } else {
    if (isCropping.value) emit('cancel-crop');
    emit('lock-element', t.id);
  }
}

function handleTogglePassThroughFor(t: SelectableTarget | null) {
  if (!t || !t.locked) return;
  emit('toggle-passthrough', t.id);
}

function handleToggleDockFor(t: SelectableTarget | null) {
  if (!targetHasGrid(t) || !t) return;
  emit('toggle-dock', t.id);
}

function handleToggleLock() {
  handleToggleLockFor(singleTarget.value);
}

function handleTogglePassThrough() {
  handleTogglePassThroughFor(singleTarget.value);
}

function handleToggleDock() {
  handleToggleDockFor(singleTarget.value);
}

function onModifierKeyChange(e: KeyboardEvent) {
  const changed = shiftPressed !== e.shiftKey || altPressed !== e.altKey;
  shiftPressed = e.shiftKey;
  altPressed = e.altKey;
  if (changed && activeQuadDrags.size === 1) {
    applyActiveQuadDrags();
  }
}

function onWindowBlur() {
  shiftPressed = false;
  altPressed = false;
  clearAllDrags();
}

function onWindowResize() {
  viewportSize.value = { w: window.innerWidth || 1280, h: window.innerHeight || 800 };
  requestAnimationFrame(reportToolbarBounds);
}

let toolbarResizeObserver: ResizeObserver | null = null;

onMounted(() => {
  window.addEventListener('pointermove', onGizmoPointerMove);
  window.addEventListener('pointerup', onGizmoPointerEnd);
  window.addEventListener('pointercancel', onGizmoPointerEnd);
  window.addEventListener('keydown', onModifierKeyChange);
  window.addEventListener('keyup', onModifierKeyChange);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('resize', onWindowResize);
  if (typeof ResizeObserver !== 'undefined') {
    toolbarResizeObserver = new ResizeObserver(reportToolbarBounds);
  }
  requestAnimationFrame(reportToolbarBounds);
});

watch(toolbarEl, (el, prev) => {
  if (prev) toolbarResizeObserver?.unobserve(prev);
  if (el) toolbarResizeObserver?.observe(el);
  requestAnimationFrame(reportToolbarBounds);
});

watch(hoverToolbarEl, (el, prev) => {
  if (prev) toolbarResizeObserver?.unobserve(prev);
  if (el) toolbarResizeObserver?.observe(el);
  requestAnimationFrame(reportToolbarBounds);
});

onBeforeUnmount(() => {
  toolbarResizeObserver?.disconnect();
  window.removeEventListener('pointermove', onGizmoPointerMove);
  window.removeEventListener('pointerup', onGizmoPointerEnd);
  window.removeEventListener('pointercancel', onGizmoPointerEnd);
  window.removeEventListener('keydown', onModifierKeyChange);
  window.removeEventListener('keyup', onModifierKeyChange);
  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('resize', onWindowResize);
  clearAllDrags();
});
</script>

<template>
  <div v-if="(singleTarget && viewportCorners) || isMultiSelect || distinctHoveredLocked" class="ac-gizmo-layer">
    <!-- Multi-selection outlines (Ctrl/Cmd + click multiple targets) -->
    <svg v-if="isMultiSelect" class="ac-gizmo-svg">
      <polygon
        v-for="mp in multiSelectPolys"
        :key="mp.id"
        :points="mp.points"
        class="ac-main-poly multi-selected"
        :class="{ locked: mp.locked }"
      />
    </svg>

    <!-- Single-target SVG Gizmo (non-blocking visual border + interactive 8 corner/edge handles for non-group elements) -->
    <svg v-else-if="singleTarget && viewportCorners" class="ac-gizmo-svg">
      <!-- Pure visual boundary outline (pointer-events: none so higher-z sibling elements ALWAYS stay clickable!) -->
      <polygon
        :points="quadPointsSvg"
        class="ac-main-poly"
        :class="{ locked: isLocked, cropping: isCropping }"
      />

      <!-- Optical center reticle for unlocked single elements & groups -->
      <g v-if="!isLocked && !isCropping && quadCenter" class="ac-center-reticle" aria-hidden="true">
        <line :x1="quadCenter.x" :y1="quadCenter.y - 16" :x2="quadCenter.x" :y2="quadCenter.y - 5.5" />
        <line :x1="quadCenter.x" :y1="quadCenter.y + 5.5" :x2="quadCenter.x" :y2="quadCenter.y + 16" />
        <line :x1="quadCenter.x - 16" :y1="quadCenter.y" :x2="quadCenter.x - 5.5" :y2="quadCenter.y" />
        <line :x1="quadCenter.x + 5.5" :y1="quadCenter.y" :x2="quadCenter.x + 16" :y2="quadCenter.y" />
        <circle :cx="quadCenter.x" :cy="quadCenter.y" r="7.5" class="ac-reticle-ring" />
        <circle :cx="quadCenter.x" :cy="quadCenter.y" r="1.6" class="ac-reticle-dot" />
      </g>

      <!-- Unified Interactive Edge Midpoint Bars & Corner Handles (ONLY for unlocked non-group elements!) -->
      <template v-if="!isLocked && !isGroupTarget">
        <g v-for="eb in edgeBars" :key="eb.edge">
          <line
            :x1="eb.bx1"
            :y1="eb.by1"
            :x2="eb.bx2"
            :y2="eb.by2"
            class="ac-gizmo-rim"
            :class="{
              cropping: isCropping,
              active: activeHandleKeys.has(`e-${eb.idx}`) || hoveredHandle === `e-${eb.idx}`,
            }"
          />
          <line
            :x1="eb.bx1"
            :y1="eb.by1"
            :x2="eb.bx2"
            :y2="eb.by2"
            class="ac-gizmo-core"
            :class="{
              cropping: isCropping,
              active: activeHandleKeys.has(`e-${eb.idx}`) || hoveredHandle === `e-${eb.idx}`,
            }"
          />
          <line
            :x1="eb.x1"
            :y1="eb.y1"
            :x2="eb.x2"
            :y2="eb.y2"
            class="ac-edge-hitline"
            :class="[eb.cursorClass, `h-${EDGE_HANDLES[eb.idx]}`]"
            @pointerenter="hoveredHandle = `e-${eb.idx}`"
            @pointerleave="hoveredHandle === `e-${eb.idx}` && (hoveredHandle = null)"
            @pointerdown="startHandleDrag('edge', eb.idx, $event)"
          />
        </g>

        <!-- Free-quad round vertex dots (ALL elements in 'free' mode!) -->
        <template v-if="isFreeQuad">
          <g v-for="(pt, idx) in viewportCorners" :key="idx">
            <circle
              :cx="pt.x"
              :cy="pt.y"
              :r="activeHandleKeys.has(`c-${idx}`) || hoveredHandle === `c-${idx}` ? 12.5 : 10"
              class="ac-corner-dot"
              :class="{ active: activeHandleKeys.has(`c-${idx}`) || hoveredHandle === `c-${idx}` }"
            />
            <circle :cx="pt.x" :cy="pt.y" r="2.5" class="ac-corner-dot-center" />
            <circle
              :cx="pt.x"
              :cy="pt.y"
              r="20"
              class="ac-corner-hitcircle cur-grab"
              :class="`h-${CORNER_HANDLES[idx]}`"
              @pointerenter="hoveredHandle = `c-${idx}`"
              @pointerleave="hoveredHandle === `c-${idx}` && (hoveredHandle = null)"
              @pointerdown="startHandleDrag('corner', idx, $event)"
            />
          </g>
        </template>

        <!-- Unified L-shaped MD3 corner brackets (ALL elements in 'rect' & 'crop' modes!) -->
        <template v-else>
          <g v-for="cb in cornerBrackets" :key="cb.idx">
            <path
              :d="cb.d"
              class="ac-gizmo-rim"
              :class="{
                cropping: isCropping,
                active: activeHandleKeys.has(`c-${cb.idx}`) || hoveredHandle === `c-${cb.idx}`,
              }"
            />
            <path
              :d="cb.d"
              class="ac-gizmo-core"
              :class="{
                cropping: isCropping,
                active: activeHandleKeys.has(`c-${cb.idx}`) || hoveredHandle === `c-${cb.idx}`,
              }"
            />
            <path
              :d="cb.d"
              class="ac-corner-hitpath"
              :class="[cb.cursorClass, `h-${CORNER_HANDLES[cb.idx]}`]"
              @pointerenter="hoveredHandle = `c-${cb.idx}`"
              @pointerleave="hoveredHandle === `c-${cb.idx}` && (hoveredHandle = null)"
              @pointerdown="startHandleDrag('corner', cb.idx, $event)"
            />
          </g>
        </template>
      </template>
    </svg>

    <!-- Unified MD3 Floating Context Toolbar (Multi-Select / Group / Element / Crop / Locked) -->
    <div
      v-if="(isMultiSelect || singleTarget) && floatingToolbarStyle"
      ref="toolbarEl"
      class="ac-element-toolbar"
      :class="{ 'locked-toolbar': !isMultiSelect && isLocked }"
      :data-element-id="singleTarget ? singleTarget.id : 'multi'"
      :style="floatingToolbarStyle"
      @pointerdown.stop
    >
      <div class="ac-toolbar-main">
        <!-- State 0: Multi-Selection -> Group button -->
        <template v-if="isMultiSelect">
          <MdActionBtn
            icon="stack_group"
            :label="messages.stage.group"
            :title="messages.stage.groupTitle"
            :mode="buttonDisplayMode"
            variant="trigger"
            tone="primary"
            size="sm"
            @click="emit('group-selected')"
          />
        </template>

        <!-- State 1: Locked (Element or Group) -> PassThrough (+ Tools if has grid) + Unlock on far right -->
        <template v-else-if="singleTarget && isLocked">
          <MdActionBtn
            icon="do_not_touch"
            :label="singleTarget.passThrough ? messages.bar.passthroughOn : messages.bar.passthroughOff"
            :title="messages.bar.passthroughTitle"
            :mode="buttonDisplayMode"
            variant="toggle"
            :tone="singleTarget.passThrough ? 'danger' : 'default'"
            :active="singleTarget.passThrough"
            size="sm"
            @click="handleTogglePassThrough"
          />
          <MdActionBtn
            v-if="targetHasGrid(singleTarget)"
            icon="build"
            :label="messages.bar.tools"
            :title="messages.bar.toolsTitle"
            :mode="buttonDisplayMode"
            variant="toggle"
            :active="targetDockVisible(singleTarget)"
            size="sm"
            @click="handleToggleDock"
          />
          <MdActionBtn
            icon="lock"
            :label="messages.stage.unlock"
            :title="messages.stage.unlock"
            :mode="buttonDisplayMode"
            variant="toggle"
            :active="true"
            size="sm"
            @click="handleToggleLock"
          />
        </template>

        <!-- State 2: Cropping Preview (non-group elements only; text-only triggers without icons) -->
        <template v-else-if="singleElement && isCropping && activeCropDraft">
          <button
            v-if="singleElement.kind === 'grid' && gridBounds"
            class="ac-btn action tonal"
            @click="handleCropGridMargins"
          >
            {{ messages.stage.cropMargins }}
          </button>
          <button
            v-if="isItemCropped(activeCropDraft.crop)"
            class="ac-btn action"
            @click="handleResetCrop"
          >
            {{ messages.stage.resetCrop }}
          </button>
          <button class="ac-btn action" @click="emit('cancel-crop')">
            {{ messages.stage.cropCancel }}
          </button>
          <button class="ac-btn action primary" @click="emit('commit-crop')">
            {{ messages.stage.cropDone }}
          </button>
        </template>

        <!-- State 3: Unlocked Group -> NO resize/stretch/crop/reset; Ungroup + layer order + tools + lock + delete -->
        <template v-else-if="singleTarget && isGroupTarget">
          <MdActionBtn
            icon="stack"
            :label="messages.stage.ungroup"
            :title="messages.stage.ungroupTitle"
            :mode="buttonDisplayMode"
            variant="trigger"
            tone="tonal"
            size="sm"
            @click="emit('ungroup-target', singleTarget.id)"
          />

          <template v-if="showLayerOrderActions">
            <MdActionBtn
              icon="vertical_align_top"
              :label="messages.stage.bringFront"
              :mode="buttonDisplayMode"
              variant="trigger"
              size="sm"
              @click="emit('bring-front', singleTarget.id)"
            />
            <MdActionBtn
              icon="vertical_align_bottom"
              :label="messages.stage.sendBack"
              :mode="buttonDisplayMode"
              variant="trigger"
              size="sm"
              @click="emit('send-back', singleTarget.id)"
            />
          </template>

          <MdActionBtn
            v-if="targetHasGrid(singleTarget)"
            icon="build"
            :label="messages.bar.tools"
            :title="messages.bar.toolsTitle"
            :mode="buttonDisplayMode"
            variant="toggle"
            :active="targetDockVisible(singleTarget)"
            size="sm"
            @click="handleToggleDock"
          />

          <MdActionBtn
            icon="lock_open"
            :label="messages.stage.lock"
            :title="messages.stage.lock"
            :mode="buttonDisplayMode"
            variant="toggle"
            size="sm"
            @click="handleToggleLock"
          />

          <MdActionBtn
            v-if="!targetHasGrid(singleTarget)"
            icon="delete"
            :label="messages.stage.remove"
            :mode="buttonDisplayMode"
            variant="trigger"
            tone="danger"
            size="sm"
            @click="emit('remove-element', singleTarget.id)"
          />
        </template>

        <!-- State 4: Unlocked Single Element -> Rect|Free, Reset (text-only), Crop, Front, Back, Tools, Lock, Delete -->
        <template v-else-if="singleElement">
          <div
            class="ac-segmented"
            role="group"
            :aria-label="messages.bar.geomGroupAria"
            :title="messages.bar.quadModeTitle"
          >
            <button
              class="ac-seg-btn"
              :class="{ active: singleElement.quadMode === 'rect' }"
              @click="emit('update-quad-mode', singleElement.id, 'rect')"
            >
              {{ messages.bar.quadRect }}
            </button>
            <button
              class="ac-seg-btn"
              :class="{ active: singleElement.quadMode === 'free' }"
              @click="emit('update-quad-mode', singleElement.id, 'free')"
            >
              {{ messages.bar.quadFree }}
            </button>
          </div>

          <button
            class="ac-btn action"
            :title="messages.stage.resetSizeTitle"
            @click="emit('reset-size', singleElement.id)"
          >
            {{ messages.stage.resetSize }}
          </button>

          <MdActionBtn
            icon="crop"
            :label="messages.stage.crop"
            :mode="buttonDisplayMode"
            variant="trigger"
            size="sm"
            @click="emit('start-crop', singleElement.id)"
          />

          <template v-if="showLayerOrderActions">
            <MdActionBtn
              icon="vertical_align_top"
              :label="messages.stage.bringFront"
              :mode="buttonDisplayMode"
              variant="trigger"
              size="sm"
              @click="emit('bring-front', singleElement.id)"
            />
            <MdActionBtn
              icon="vertical_align_bottom"
              :label="messages.stage.sendBack"
              :mode="buttonDisplayMode"
              variant="trigger"
              size="sm"
              @click="emit('send-back', singleElement.id)"
            />
          </template>

          <MdActionBtn
            v-if="singleElement.kind === 'grid'"
            icon="build"
            :label="messages.bar.tools"
            :title="messages.bar.toolsTitle"
            :mode="buttonDisplayMode"
            variant="toggle"
            :active="singleElement.dockVisible"
            size="sm"
            @click="handleToggleDock"
          />

          <MdActionBtn
            icon="lock_open"
            :label="messages.stage.lock"
            :title="messages.stage.lock"
            :mode="buttonDisplayMode"
            variant="toggle"
            size="sm"
            @click="handleToggleLock"
          />

          <MdActionBtn
            v-if="singleElement.kind !== 'grid'"
            icon="delete"
            :label="messages.stage.remove"
            :mode="buttonDisplayMode"
            variant="trigger"
            tone="danger"
            size="sm"
            @click="emit('remove-element', singleElement.id)"
          />
        </template>
      </div>
    </div>

    <!-- Hover-revealed Floating Toolbar for Locked Elements & Locked Groups -->
    <div
      v-if="distinctHoveredLocked && hoverToolbarStyle"
      ref="hoverToolbarEl"
      class="ac-element-toolbar ac-hover-locked-toolbar locked-toolbar"
      :data-element-id="distinctHoveredLocked.id"
      :style="hoverToolbarStyle"
      @pointerdown.stop
    >
      <div class="ac-toolbar-main">
        <MdActionBtn
          icon="do_not_touch"
          :label="distinctHoveredLocked.passThrough ? messages.bar.passthroughOn : messages.bar.passthroughOff"
          :title="messages.bar.passthroughTitle"
          :mode="buttonDisplayMode"
          variant="toggle"
          :tone="distinctHoveredLocked.passThrough ? 'danger' : 'default'"
          :active="distinctHoveredLocked.passThrough"
          size="sm"
          @click="handleTogglePassThroughFor(distinctHoveredLocked)"
        />
        <MdActionBtn
          v-if="targetHasGrid(distinctHoveredLocked)"
          icon="build"
          :label="messages.bar.tools"
          :title="messages.bar.toolsTitle"
          :mode="buttonDisplayMode"
          variant="toggle"
          :active="targetDockVisible(distinctHoveredLocked)"
          size="sm"
          @click="handleToggleDockFor(distinctHoveredLocked)"
        />
        <MdActionBtn
          icon="lock"
          :label="messages.stage.unlock"
          :title="messages.stage.unlock"
          :mode="buttonDisplayMode"
          variant="toggle"
          :active="true"
          size="sm"
          @click="handleToggleLockFor(distinctHoveredLocked)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.ac-gizmo-layer {
  position: absolute;
  inset: 0;
  z-index: 1050;
  pointer-events: none;
  overflow: hidden;
}

.ac-gizmo-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
  touch-action: none;
}

.ac-main-poly {
  fill: none;
  stroke: var(--md-sys-color-primary);
  stroke-width: 2;
  stroke-dasharray: 6 4;
  pointer-events: none;
}

.ac-main-poly.cropping {
  fill: none;
  stroke: var(--md-sys-color-primary);
  stroke-dasharray: none;
}

.ac-main-poly.locked {
  fill: none;
  stroke: var(--md-sys-color-primary);
  stroke-width: 1.75;
  stroke-dasharray: 5 4;
  opacity: 0.82;
}

.ac-outer-poly {
  fill: none;
  stroke: var(--md-sys-color-tertiary);
  stroke-width: 1.25;
  stroke-dasharray: 3 4;
  opacity: 0.7;
  pointer-events: none;
}

.ac-center-reticle {
  pointer-events: none;
  opacity: 0.88;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.5));
}

.ac-center-reticle line,
.ac-reticle-ring {
  fill: none;
  stroke: var(--md-sys-color-primary);
  stroke-width: 1.25;
  stroke-linecap: round;
}

.ac-reticle-dot {
  fill: var(--md-sys-color-primary);
  stroke: none;
}

.ac-gizmo-rim {
  fill: none;
  stroke: var(--md-sys-color-primary);
  stroke-width: 10;
  stroke-linecap: round;
  stroke-linejoin: round;
  pointer-events: none;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.42));
  transition: stroke-width 0.12s ease, stroke 0.12s ease;
}

.ac-gizmo-rim.active {
  stroke-width: 13.5;
}

.ac-gizmo-core {
  fill: none;
  stroke: color-mix(in srgb, var(--md-sys-color-primary-container) 92%, transparent);
  stroke-width: 6.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  pointer-events: none;
  transition: stroke 0.12s ease, stroke-width 0.12s ease;
}

.ac-gizmo-core.active {
  stroke: var(--md-sys-color-primary);
  stroke-width: 9.5;
}

.ac-edge-hitline {
  fill: none;
  stroke: transparent;
  stroke-width: 24;
  stroke-linecap: round;
  pointer-events: stroke;
  touch-action: none;
}

.ac-corner-hitpath {
  fill: none;
  stroke: transparent;
  stroke-width: 34;
  stroke-linecap: round;
  stroke-linejoin: round;
  pointer-events: stroke;
  touch-action: none;
}

.ac-corner-dot {
  fill: color-mix(in srgb, var(--md-sys-color-primary-container) 88%, transparent);
  stroke: var(--md-sys-color-primary);
  stroke-width: 2;
  pointer-events: none;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.42));
  transition: fill 0.12s ease, r 0.12s ease, stroke-width 0.12s ease;
}

.ac-corner-dot.active {
  fill: var(--md-sys-color-primary);
  stroke-width: 2.5;
}

.ac-corner-dot-center {
  fill: var(--md-sys-color-on-primary-container);
  pointer-events: none;
}

.ac-corner-hitcircle {
  fill: transparent;
  pointer-events: all;
  touch-action: none;
}

.ac-element-toolbar {
  position: absolute;
  transform: translateX(-50%);
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 4px 6px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--md-sys-color-surface-container) 94%, transparent);
  border: 1px solid var(--md-sys-color-outline-variant);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(12px);
  white-space: nowrap;
}

.ac-element-toolbar.locked-toolbar {
  opacity: 0.3;
  transition: opacity 0.14s ease;
}

.ac-element-toolbar.locked-toolbar:hover,
.ac-element-toolbar.locked-toolbar:focus-within {
  opacity: 1;
}

.ac-toolbar-main {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.ac-toolbar-subrow {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.ac-element-toolbar .ac-btn {
  height: 26px;
  padding: 0 10px;
  font-size: 11px;
}

.ac-segmented {
  display: inline-flex;
  align-items: stretch;
  height: 26px;
  border-radius: 999px;
  border: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-high);
  overflow: hidden;
  flex-shrink: 0;
}

.ac-seg-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 0 9px;
  border: none;
  border-right: 1px solid var(--md-sys-color-outline-variant);
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease;
}

.ac-seg-btn:last-child {
  border-right: none;
}

.ac-seg-btn.active {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  font-weight: 600;
}

.cur-nwse { cursor: nwse-resize; }
.cur-nesw { cursor: nesw-resize; }
.cur-ns { cursor: ns-resize; }
.cur-ew { cursor: ew-resize; }
.cur-grab { cursor: grab; }
</style>
