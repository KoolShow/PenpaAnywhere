<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  applyHomography,
  computeHomography,
  invertMat3,
  isConvexQuad,
  isPointInQuad,
  type Mat3,
  type Point2D,
} from '../core/homography';
import { WebGLPerspectiveRenderer, type BlendRenderMode } from '../core/webglOverlay';
import type { GridBoundsNormalized, PenpaIframeBridge } from '../core/penpaBridge';
import { safeAreaInsets } from '../core/safeArea';
import { formatMessage, messages } from '../core/i18n';

export type AlignTarget = 'grid' | 'canvas';
export type QuadMode = 'rect' | 'free';
type RectEdge = 'top' | 'right' | 'bottom' | 'left';

const MIN_RECT_SIZE = 48;
const MIN_FREE_EDGE = 24;

interface ActiveDrag {
  pointerId: number;
  kind: 'corner' | 'edge' | 'whole';
  index: number;
  startPointer: Point2D;
  currentPointer: Point2D;
  grabOffset: Point2D;
}

interface SafeBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const props = defineProps<{
  bridge: PenpaIframeBridge | null;
  blendMode: BlendRenderMode;
  hasDomBackdrop: boolean;
  opacity: number;
  calibrating: boolean;
  alignTarget: AlignTarget;
  quadMode: QuadMode;
  corners: [Point2D, Point2D, Point2D, Point2D];
  visible?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:corners', value: [Point2D, Point2D, Point2D, Point2D]): void;
  (e: 'quad-geometry-change', outerQuad: [Point2D, Point2D, Point2D, Point2D]): void;
}>();

const hostEl = ref<HTMLDivElement | null>(null);
const glCanvasEl = ref<HTMLCanvasElement | null>(null);
const glError = ref<string | null>(null);

let renderer: WebGLPerspectiveRenderer | null = null;
let rafId = 0;
let unsubscribeBridge: (() => void) | null = null;
let hostResizeObserver: ResizeObserver | null = null;
let needsRender = true;

const activePointerDraw = ref(false);
const activeDrags = new Map<number, ActiveDrag>();
const activeHandleKeys = ref<Set<string>>(new Set());
let dragBaselineCorners: [Point2D, Point2D, Point2D, Point2D] | null = null;
let shiftPressed = false;
let altPressed = false;
const hoveredHandle = ref<string | null>(null);

const currentBounds = ref<GridBoundsNormalized>({
  u0: 0,
  v0: 0,
  u1: 1,
  v1: 1,
  canvasCssW: 1,
  canvasCssH: 1,
});

// Effective WebGL blend mode: CSS multiply/screen only work when a DOM backdrop exists in the same page.
const effectiveShaderMode = computed<BlendRenderMode>(() => {
  if (props.blendMode === 'multiply' && !props.hasDomBackdrop) {
    return 'alpha-minrgb';
  }
  if (props.blendMode === 'multiply-inv' && !props.hasDomBackdrop) {
    return 'alpha-minrgb-inv';
  }
  return props.blendMode;
});

const useCssMultiply = computed(
  () => props.blendMode === 'multiply' && props.hasDomBackdrop,
);

const useCssScreen = computed(
  () => props.blendMode === 'multiply-inv' && props.hasDomBackdrop,
);

const homographyState = computed<{ H: Mat3 | null; invH: Mat3 | null }>(() => {
  const b =
    props.alignTarget === 'grid'
      ? currentBounds.value
      : { u0: 0, v0: 0, u1: 1, v1: 1 };
  const src: [Point2D, Point2D, Point2D, Point2D] = [
    { x: b.u0, y: b.v0 },
    { x: b.u1, y: b.v0 },
    { x: b.u1, y: b.v1 },
    { x: b.u0, y: b.v1 },
  ];
  const H = computeHomography(src, props.corners);
  if (!H) return { H: null, invH: null };
  const invH = invertMat3(H);
  return { H, invH };
});

// Project full canvas [0,1]^2 through H so we can show outer margin guide and hit-test full canvas
const outerCanvasQuad = computed<[Point2D, Point2D, Point2D, Point2D]>(() => {
  const H = homographyState.value.H;
  if (!H) return props.corners;
  const p0 = applyHomography(H, 0, 0);
  const p1 = applyHomography(H, 1, 0);
  const p2 = applyHomography(H, 1, 1);
  const p3 = applyHomography(H, 0, 1);
  if (!p0 || !p1 || !p2 || !p3) return props.corners;
  return [p0, p1, p2, p3];
});

watch(
  outerCanvasQuad,
  (q) => {
    emit('quad-geometry-change', q);
    needsRender = true;
  },
  { deep: true, immediate: true },
);

watch(
  () => [props.quadMode, props.calibrating],
  () => {
    hoveredHandle.value = null;
    clearAllDrags();
  },
);

watch(
  () => [props.blendMode, props.hasDomBackdrop, props.opacity, props.alignTarget, props.corners],
  () => {
    needsRender = true;
  },
  { deep: true },
);

function refreshBoundsFromBridge() {
  if (!props.bridge || !props.bridge.isReady()) return;
  const next = props.bridge.getGridBoundsNormalized();
  const prev = currentBounds.value;
  if (
    Math.abs(next.u0 - prev.u0) > 1e-4 ||
    Math.abs(next.v0 - prev.v0) > 1e-4 ||
    Math.abs(next.u1 - prev.u1) > 1e-4 ||
    Math.abs(next.v1 - prev.v1) > 1e-4
  ) {
    currentBounds.value = next;
    needsRender = true;
  }
}

watch(
  () => props.bridge,
  (bridge) => {
    if (unsubscribeBridge) {
      unsubscribeBridge();
      unsubscribeBridge = null;
    }
    if (bridge) {
      unsubscribeBridge = bridge.subscribe(() => {
        refreshBoundsFromBridge();
        needsRender = true;
      });
      refreshBoundsFromBridge();
      needsRender = true;
    }
  },
  { immediate: true },
);

function handleResize() {
  if (!renderer || !hostEl.value) return;
  if (hostEl.value.clientWidth < 1 || hostEl.value.clientHeight < 1) return;
  const rect = hostEl.value.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const dpr = window.devicePixelRatio || 1;
  renderer.resize(rect.width, rect.height, dpr);
  needsRender = true;
}

watch(
  () => props.visible,
  (vis) => {
    if (vis !== false) {
      requestAnimationFrame(() => {
        handleResize();
        needsRender = true;
      });
    }
  },
);

function renderLoop() {
  rafId = requestAnimationFrame(renderLoop);
  if (!renderer || !hostEl.value) return;
  if (props.visible === false) return;
  if (hostEl.value.clientWidth < 1 || hostEl.value.clientHeight < 1) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = hostEl.value.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  if (renderer.resize(rect.width, rect.height, dpr)) {
    needsRender = true;
  }

  const bridge = props.bridge;
  if (bridge && bridge.isReady()) {
    refreshBoundsFromBridge();
    const srcCanvas = bridge.getCanvas();
    const ver = bridge.getFrameVersion();
    if (srcCanvas) {
      const uploaded = renderer.uploadSourceIfNeeded(srcCanvas, ver);
      if (uploaded) {
        needsRender = true;
      }
    }
  }

  if (!needsRender) return;
  needsRender = false;

  const invH = homographyState.value.invH;
  if (!invH) {
    renderer.clear();
    return;
  }
  renderer.render(invH, dpr, effectiveShaderMode.value, props.opacity);
}

// Convert client coordinates into normalized Penpa canvas UV via inverse homography
function clientToPenpaUv(clientX: number, clientY: number): { u: number; v: number } | null {
  const invH = homographyState.value.invH;
  const host = hostEl.value;
  if (!invH || !host) return null;
  const rect = host.getBoundingClientRect();
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  const uv = applyHomography(invH, sx, sy);
  if (!uv) return null;
  if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return null;
  return { u: uv.x, v: uv.y };
}

function onSurfacePointerDown(e: PointerEvent) {
  if (props.calibrating) return;
  if (!props.bridge || !props.bridge.isReady()) return;

  const uv = clientToPenpaUv(e.clientX, e.clientY);
  if (!uv) return;

  e.preventDefault();
  activePointerDraw.value = true;
  (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
  props.bridge.dispatchPointer('down', uv.u, uv.v, {
    button: e.button,
    buttons: e.buttons,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
  });
}

function onSurfacePointerMove(e: PointerEvent) {
  if (props.calibrating) return;
  if (!props.bridge || !props.bridge.isReady()) return;

  const uv = clientToPenpaUv(e.clientX, e.clientY);
  if (!uv) {
    if (activePointerDraw.value) {
      props.bridge.dispatchPointer('out', 0, 0);
    }
    return;
  }

  if (activePointerDraw.value) {
    e.preventDefault();
  }
  props.bridge.dispatchPointer('move', uv.u, uv.v, {
    button: e.button,
    buttons: e.buttons,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
  });
}

function onSurfacePointerUp(e: PointerEvent) {
  if (!activePointerDraw.value) return;
  activePointerDraw.value = false;
  (e.currentTarget as HTMLElement | null)?.releasePointerCapture?.(e.pointerId);
  if (!props.bridge || !props.bridge.isReady()) return;

  const uv = clientToPenpaUv(e.clientX, e.clientY);
  if (uv) {
    props.bridge.dispatchPointer('up', uv.u, uv.v, {
      button: e.button,
      buttons: e.buttons,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
    });
  } else {
    props.bridge.dispatchPointer('out', 0, 0);
  }
}

function onSurfaceContextMenu(e: MouseEvent) {
  if (props.calibrating) return;
  const uv = clientToPenpaUv(e.clientX, e.clientY);
  if (!uv) return;
  e.preventDefault();
  props.bridge?.dispatchPointer('contextmenu', uv.u, uv.v, { button: 2, buttons: 0 });
}

// --- Calibration geometry helpers & multi-touch / Shift / Alt handle dragging ---
const EDGE_NAMES: [RectEdge, RectEdge, RectEdge, RectEdge] = ['top', 'right', 'bottom', 'left'];

function cloneCorners(c: [Point2D, Point2D, Point2D, Point2D]): [Point2D, Point2D, Point2D, Point2D] {
  return [
    { x: c[0].x, y: c[0].y },
    { x: c[1].x, y: c[1].y },
    { x: c[2].x, y: c[2].y },
    { x: c[3].x, y: c[3].y },
  ];
}

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
    if (Math.hypot(q.x - p.x, q.y - p.y) < MIN_FREE_EDGE) {
      return false;
    }
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

function dragKeyFor(kind: 'corner' | 'edge' | 'whole', index: number): string {
  if (kind === 'corner') return `c-${index}`;
  if (kind === 'edge') return `e-${index}`;
  return 'whole';
}

function syncActiveHandleKeys() {
  const next = new Set<string>();
  for (const d of activeDrags.values()) {
    next.add(dragKeyFor(d.kind, d.index));
  }
  activeHandleKeys.value = next;
}

function clearAllDrags() {
  activeDrags.clear();
  dragBaselineCorners = null;
  syncActiveHandleKeys();
}

function resnapshotDrags(corners: [Point2D, Point2D, Point2D, Point2D]) {
  dragBaselineCorners = cloneCorners(corners);
  for (const d of activeDrags.values()) {
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

function getSafeHostBounds(rect: DOMRect): SafeBounds {
  const safe = safeAreaInsets.value;
  const minX = safe.left + 8;
  const minY = safe.top + 8;
  const maxX = Math.max(minX + MIN_RECT_SIZE, rect.width - safe.right - 8);
  const maxY = Math.max(minY + MIN_RECT_SIZE, rect.height - safe.bottom - 8);
  return { minX, minY, maxX, maxY };
}

function getLocalPointer(e: PointerEvent): Point2D | null {
  if (!hostEl.value) return null;
  const rect = hostEl.value.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function applySingleRectDrag(
  drag: ActiveDrag,
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
    const target = {
      x: drag.currentPointer.x + drag.grabOffset.x,
      y: drag.currentPointer.y + drag.grabOffset.y,
    };

    if (shiftPressed && altPressed) {
      // Center-symmetric aspect-locked scaling from initial drag-start ratio
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

    if (shiftPressed) {
      // Aspect-locked scaling anchored at opposite corner using initial drag-start aspect ratio
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
      const left = sx > 0 ? ax : ax - nw;
      const right = sx > 0 ? ax + nw : ax;
      const top = sy > 0 ? ay : ay - nh;
      const bottom = sy > 0 ? ay + nh : ay;
      return makeRectCorners(left, right, top, bottom);
    }

    if (altPressed) {
      // Center-symmetric independent width/height adjustment around initial rect center
      const maxHw = Math.max(MIN_RECT_SIZE * 0.5, Math.min(cx0 - bounds.minX, bounds.maxX - cx0));
      const maxHh = Math.max(MIN_RECT_SIZE * 0.5, Math.min(cy0 - bounds.minY, bounds.maxY - cy0));
      const hw = clampVal(sx * (target.x - cx0), MIN_RECT_SIZE * 0.5, maxHw);
      const hh = clampVal(sy * (target.y - cy0), MIN_RECT_SIZE * 0.5, maxHh);
      return makeRectCorners(cx0 - hw, cx0 + hw, cy0 - hh, cy0 + hh);
    }

    // Standard single-corner rect drag
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

  // Edge drag in rect mode
  const edge = EDGE_NAMES[drag.index];
  const dx = drag.currentPointer.x - drag.startPointer.x;
  const dy = drag.currentPointer.y - drag.startPointer.y;
  let left = L0;
  let right = R0;
  let top = T0;
  let bottom = B0;

  if (altPressed) {
    // Center-symmetric edge expansion/contraction around initial rect center
    const maxHw = Math.max(MIN_RECT_SIZE * 0.5, Math.min(cx0 - bounds.minX, bounds.maxX - cx0));
    const maxHh = Math.max(MIN_RECT_SIZE * 0.5, Math.min(cy0 - bounds.minY, bounds.maxY - cy0));
    if (edge === 'top') {
      const hh = clampVal(H0 * 0.5 - dy, MIN_RECT_SIZE * 0.5, maxHh);
      top = cy0 - hh;
      bottom = cy0 + hh;
    } else if (edge === 'bottom') {
      const hh = clampVal(H0 * 0.5 + dy, MIN_RECT_SIZE * 0.5, maxHh);
      top = cy0 - hh;
      bottom = cy0 + hh;
    } else if (edge === 'left') {
      const hw = clampVal(W0 * 0.5 - dx, MIN_RECT_SIZE * 0.5, maxHw);
      left = cx0 - hw;
      right = cx0 + hw;
    } else if (edge === 'right') {
      const hw = clampVal(W0 * 0.5 + dx, MIN_RECT_SIZE * 0.5, maxHw);
      left = cx0 - hw;
      right = cx0 + hw;
    }
    return makeRectCorners(left, right, top, bottom);
  }

  if (edge === 'top') {
    top = clampVal(T0 + dy, bounds.minY, B0 - MIN_RECT_SIZE);
  } else if (edge === 'bottom') {
    bottom = clampVal(B0 + dy, T0 + MIN_RECT_SIZE, bounds.maxY);
  } else if (edge === 'left') {
    left = clampVal(L0 + dx, bounds.minX, R0 - MIN_RECT_SIZE);
  } else if (edge === 'right') {
    right = clampVal(R0 + dx, L0 + MIN_RECT_SIZE, bounds.maxX);
  }
  return makeRectCorners(left, right, top, bottom);
}

function applySingleFreeDrag(
  drag: ActiveDrag,
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
      // Center-symmetric angle-preserving similarity scaling around quad centroid
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
      // Preserve ALL 4 interior angles: opposite vertex O stays fixed while the other 3 vertices move
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
          const cand = cloneCorners(base);
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
      // Center-symmetric synchronized opposite-corner adjustment (+d on dragged corner, -d on opposite)
      const d = subPt(target, base[idx]);
      return solveMaxValidAlpha((alpha) => {
        const cand = cloneCorners(base);
        cand[idx] = { x: base[idx].x + d.x * alpha, y: base[idx].y + d.y * alpha };
        cand[opp] = { x: base[opp].x - d.x * alpha, y: base[opp].y - d.y * alpha };
        return cand;
      }, bounds);
    }

    // Standard single-corner free drag
    const direct = cloneCorners(base);
    direct[idx] = target;
    if (isValidQuadInBounds(direct, bounds)) return direct;
    return solveMaxValidAlpha((alpha) => {
      const cand = cloneCorners(base);
      cand[idx] = lerpPt(base[idx], target, alpha);
      return cand;
    }, bounds);
  }

  // Edge drag in free mode
  const i0 = drag.index;
  const i1 = (i0 + 1) % 4;
  const j0 = (i0 + 2) % 4;
  const j1 = (i0 + 3) % 4;
  const d = subPt(drag.currentPointer, drag.startPointer);

  if (shiftPressed && altPressed) {
    // Center-symmetric angle-preserving slide of both grabbed edge and opposite edge along adjacent rays
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
        const cand = cloneCorners(base);
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
    // Preserve ALL 4 interior angles: opposite edge stays fixed while dragged edge slides along adjacent edge rays
    const eDir = subPt(base[i1], base[i0]);
    const adj0Dir = subPt(base[i0], base[j1]);
    const adj1Dir = subPt(base[i1], base[j0]);
    return solveMaxValidAlpha(
      (alpha) => {
        const pDrag = { x: base[i0].x + d.x * alpha, y: base[i0].y + d.y * alpha };
        const newI0 = intersectLines(base[j1], adj0Dir, pDrag, eDir);
        const newI1 = intersectLines(base[j0], adj1Dir, pDrag, eDir);
        if (!newI0 || !newI1) return null;
        const cand = cloneCorners(base);
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
    // Center-symmetric opposite-edge sync (+d on grabbed edge, -d on opposite edge)
    return solveMaxValidAlpha((alpha) => {
      const cand = cloneCorners(base);
      cand[i0] = { x: base[i0].x + d.x * alpha, y: base[i0].y + d.y * alpha };
      cand[i1] = { x: base[i1].x + d.x * alpha, y: base[i1].y + d.y * alpha };
      cand[j0] = { x: base[j0].x - d.x * alpha, y: base[j0].y - d.y * alpha };
      cand[j1] = { x: base[j1].x - d.x * alpha, y: base[j1].y - d.y * alpha };
      return cand;
    }, bounds);
  }

  // Standard free edge translation
  return solveMaxValidAlpha((alpha) => {
    const cand = cloneCorners(base);
    cand[i0] = clampPoint({ x: base[i0].x + d.x * alpha, y: base[i0].y + d.y * alpha }, bounds);
    cand[i1] = clampPoint({ x: base[i1].x + d.x * alpha, y: base[i1].y + d.y * alpha }, bounds);
    return cand;
  }, bounds);
}

function applyMultiTouchRectDrag(
  drags: ActiveDrag[],
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
    } else if (drag.kind === 'edge') {
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
  drags: ActiveDrag[],
  base: [Point2D, Point2D, Point2D, Point2D],
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
    } else if (drag.kind === 'edge') {
      edgeDeltas.set(drag.index, subPt(drag.currentPointer, drag.startPointer));
    }
  }

  const target: [Point2D, Point2D, Point2D, Point2D] = cloneCorners(base);
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

  // Smoothly approach target from current valid quad so concurrent fingers never stall abruptly
  const startValid = cloneCorners(props.corners);
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

function applyActiveDrags() {
  if (!hostEl.value || !dragBaselineCorners || activeDrags.size === 0) return;
  const rect = hostEl.value.getBoundingClientRect();
  const bounds = getSafeHostBounds(rect);
  const base = dragBaselineCorners;
  const drags = Array.from(activeDrags.values());

  if (drags.length === 1 && drags[0].kind === 'whole') {
    const drag = drags[0];
    let dx = drag.currentPointer.x - drag.startPointer.x;
    let dy = drag.currentPointer.y - drag.startPointer.y;
    const xs = base.map((p) => p.x);
    const ys = base.map((p) => p.y);
    dx = clampVal(dx, bounds.minX - Math.min(...xs), bounds.maxX - Math.max(...xs));
    dy = clampVal(dy, bounds.minY - Math.min(...ys), bounds.maxY - Math.max(...ys));
    emit('update:corners', [
      { x: base[0].x + dx, y: base[0].y + dy },
      { x: base[1].x + dx, y: base[1].y + dy },
      { x: base[2].x + dx, y: base[2].y + dy },
      { x: base[3].x + dx, y: base[3].y + dy },
    ]);
    return;
  }

  const handleDrags = drags.filter((d) => d.kind !== 'whole');
  if (handleDrags.length === 0) return;

  if (props.quadMode === 'rect') {
    const next =
      handleDrags.length === 1
        ? applySingleRectDrag(handleDrags[0], base, bounds)
        : applyMultiTouchRectDrag(handleDrags, base, bounds);
    emit('update:corners', next);
    return;
  }

  const next =
    handleDrags.length === 1
      ? applySingleFreeDrag(handleDrags[0], base, bounds)
      : applyMultiTouchFreeDrag(handleDrags, base, bounds);
  if (next) {
    emit('update:corners', next);
  }
}

function safeSetPointerCapture(el: EventTarget | null, pointerId: number) {
  try {
    (el as HTMLElement | null)?.setPointerCapture?.(pointerId);
  } catch {
    // Non-fatal for synthetic pointers or rapidly cancelled touches
  }
}

function safeReleasePointerCapture(el: EventTarget | null, pointerId: number) {
  try {
    (el as HTMLElement | null)?.releasePointerCapture?.(pointerId);
  } catch {
    // Ignore if capture was already released
  }
}

function startHandleDrag(index: number, e: PointerEvent) {
  const ptr = getLocalPointer(e);
  if (!ptr) return;
  e.preventDefault();
  e.stopPropagation();

  // Ignore duplicate pointer on the same corner
  for (const d of activeDrags.values()) {
    if (d.kind === 'corner' && d.index === index) return;
  }
  // Cancel any active whole-quad drag when a control point is grabbed
  for (const [pid, d] of activeDrags.entries()) {
    if (d.kind === 'whole') activeDrags.delete(pid);
  }

  shiftPressed = e.shiftKey;
  altPressed = e.altKey;
  safeSetPointerCapture(e.currentTarget, e.pointerId);

  if (activeDrags.size === 0) {
    dragBaselineCorners = cloneCorners(props.corners);
  } else {
    resnapshotDrags(props.corners);
  }

  activeDrags.set(e.pointerId, {
    pointerId: e.pointerId,
    kind: 'corner',
    index,
    startPointer: { ...ptr },
    currentPointer: { ...ptr },
    grabOffset: {
      x: props.corners[index].x - ptr.x,
      y: props.corners[index].y - ptr.y,
    },
  });
  syncActiveHandleKeys();
}

function startEdgeDrag(edgeIndex: number, e: PointerEvent) {
  const ptr = getLocalPointer(e);
  if (!ptr) return;
  e.preventDefault();
  e.stopPropagation();

  // Ignore duplicate pointer on the same edge
  for (const d of activeDrags.values()) {
    if (d.kind === 'edge' && d.index === edgeIndex) return;
  }
  for (const [pid, d] of activeDrags.entries()) {
    if (d.kind === 'whole') activeDrags.delete(pid);
  }

  shiftPressed = e.shiftKey;
  altPressed = e.altKey;
  safeSetPointerCapture(e.currentTarget, e.pointerId);

  if (activeDrags.size === 0) {
    dragBaselineCorners = cloneCorners(props.corners);
  } else {
    resnapshotDrags(props.corners);
  }

  activeDrags.set(e.pointerId, {
    pointerId: e.pointerId,
    kind: 'edge',
    index: edgeIndex,
    startPointer: { ...ptr },
    currentPointer: { ...ptr },
    grabOffset: { x: 0, y: 0 },
  });
  syncActiveHandleKeys();
}

function startWholeQuadDrag(e: PointerEvent) {
  if (!props.calibrating || activeDrags.size > 0) return;
  const ptr = getLocalPointer(e);
  if (!ptr || !isPointInQuad(ptr, props.corners)) return;

  e.preventDefault();
  shiftPressed = e.shiftKey;
  altPressed = e.altKey;
  dragBaselineCorners = cloneCorners(props.corners);
  activeDrags.set(e.pointerId, {
    pointerId: e.pointerId,
    kind: 'whole',
    index: -1,
    startPointer: { ...ptr },
    currentPointer: { ...ptr },
    grabOffset: { x: 0, y: 0 },
  });
  safeSetPointerCapture(e.currentTarget, e.pointerId);
  syncActiveHandleKeys();
}

function onCalibrationPointerMove(e: PointerEvent) {
  const drag = activeDrags.get(e.pointerId);
  if (!drag) return;
  const ptr = getLocalPointer(e);
  if (!ptr) return;
  e.preventDefault();
  drag.currentPointer = ptr;
  shiftPressed = e.shiftKey;
  altPressed = e.altKey;
  applyActiveDrags();
}

function onCalibrationPointerEnd(e: PointerEvent) {
  if (!activeDrags.has(e.pointerId)) return;
  safeReleasePointerCapture(e.currentTarget, e.pointerId);
  activeDrags.delete(e.pointerId);
  syncActiveHandleKeys();
  if (activeDrags.size === 0) {
    dragBaselineCorners = null;
  } else {
    resnapshotDrags(props.corners);
  }
}

function onModifierKeyChange(e: KeyboardEvent) {
  const changed = shiftPressed !== e.shiftKey || altPressed !== e.altKey;
  shiftPressed = e.shiftKey;
  altPressed = e.altKey;
  if (changed && activeDrags.size === 1) {
    applyActiveDrags();
  }
}

function onWindowBlur() {
  shiftPressed = false;
  altPressed = false;
}

function unitVec(ax: number, ay: number, bx: number, by: number): { ux: number; uy: number; len: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return { ux: 1, uy: 0, len: 0 };
  return { ux: dx / len, uy: dy / len, len };
}

// L-shaped corner brackets dynamically aligned to each vertex's two adjacent edges
const cornerBrackets = computed(() => {
  const c = props.corners;
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
    const cursorClass =
      props.quadMode === 'rect' ? (idx === 0 || idx === 2 ? 'cur-nwse' : 'cur-nesw') : 'cur-grab';
    return { idx, x: pt.x, y: pt.y, d, cursorClass };
  });
});

// Edge midpoint bars dynamically tangent to each quad edge (same thickness as corner brackets)
const edgeBars = computed(() => {
  const c = props.corners;
  return EDGE_NAMES.map((edge, idx) => {
    const a = c[idx];
    const b = c[(idx + 1) % 4];
    const { ux, uy, len } = unitVec(a.x, a.y, b.x, b.y);
    const mx = (a.x + b.x) * 0.5;
    const my = (a.y + b.y) * 0.5;
    const halfBar = Math.max(8, Math.min(20, len * 0.18));
    const cursorClass =
      props.quadMode === 'rect' ? (idx === 0 || idx === 2 ? 'cur-ns' : 'cur-ew') : 'cur-grab';
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

const quadPointsSvg = computed(() =>
  props.corners.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
);

const outerQuadPointsSvg = computed(() =>
  outerCanvasQuad.value.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
);

// Projective center of the calibrated quad (exact diagonal intersection / grid center)
const quadCenter = computed<Point2D>(() => {
  const H = homographyState.value.H;
  const b =
    props.alignTarget === 'grid'
      ? currentBounds.value
      : { u0: 0, v0: 0, u1: 1, v1: 1 };
  if (H) {
    const pt = applyHomography(H, (b.u0 + b.u1) * 0.5, (b.v0 + b.v1) * 0.5);
    if (pt) return pt;
  }
  const c = props.corners;
  return {
    x: (c[0].x + c[1].x + c[2].x + c[3].x) * 0.25,
    y: (c[0].y + c[1].y + c[2].y + c[3].y) * 0.25,
  };
});

onMounted(() => {
  try {
    if (glCanvasEl.value) {
      renderer = new WebGLPerspectiveRenderer(glCanvasEl.value);
      handleResize();
      rafId = requestAnimationFrame(renderLoop);
    }
  } catch (err) {
    glError.value = err instanceof Error ? err.message : String(err);
  }
  if (hostEl.value && typeof ResizeObserver !== 'undefined') {
    hostResizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    hostResizeObserver.observe(hostEl.value);
  }
  window.addEventListener('resize', handleResize);
  window.addEventListener('keydown', onModifierKeyChange);
  window.addEventListener('keyup', onModifierKeyChange);
  window.addEventListener('blur', onWindowBlur);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  hostResizeObserver?.disconnect();
  hostResizeObserver = null;
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('keydown', onModifierKeyChange);
  window.removeEventListener('keyup', onModifierKeyChange);
  window.removeEventListener('blur', onWindowBlur);
  clearAllDrags();
  if (unsubscribeBridge) unsubscribeBridge();
  renderer?.destroy();
  renderer = null;
});

function captureOverlayPng(): string | null {
  if (!glCanvasEl.value || !renderer) return null;
  const invH = homographyState.value.invH;
  if (invH) {
    const dpr = window.devicePixelRatio || 1;
    renderer.render(invH, dpr, effectiveShaderMode.value, props.opacity);
  }
  try {
    return glCanvasEl.value.toDataURL('image/png');
  } catch {
    return null;
  }
}

defineExpose({
  captureOverlayPng,
});
</script>

<template>
  <div
    ref="hostEl"
    class="ac-overlay-layer"
    :class="{ calibrating }"
    @pointerdown="onSurfacePointerDown"
    @pointermove="onSurfacePointerMove"
    @pointerup="onSurfacePointerUp"
    @pointercancel="onSurfacePointerUp"
    @contextmenu="onSurfaceContextMenu"
  >
    <canvas
      ref="glCanvasEl"
      class="ac-gl-canvas"
      :class="{ 'css-multiply': useCssMultiply, 'css-screen': useCssScreen }"
    />

    <!-- Unified Calibration Gizmo: Quad Guides + 4 Edge Midpoint Bars + 4 L-Shaped Corner Brackets -->
    <svg
      v-if="calibrating"
      class="ac-quad-svg"
      @pointerdown="startWholeQuadDrag"
      @pointermove="onCalibrationPointerMove"
      @pointerup="onCalibrationPointerEnd"
      @pointercancel="onCalibrationPointerEnd"
    >
      <polygon
        v-if="alignTarget === 'grid'"
        :points="outerQuadPointsSvg"
        class="ac-outer-poly"
      />
      <polygon :points="quadPointsSvg" class="ac-main-poly" />

      <!-- Non-interactive optical center reticle (crosshair + inner ring + center dot) -->
      <g class="ac-center-reticle" aria-hidden="true">
        <line
          :x1="quadCenter.x"
          :y1="quadCenter.y - 16"
          :x2="quadCenter.x"
          :y2="quadCenter.y - 5.5"
        />
        <line
          :x1="quadCenter.x"
          :y1="quadCenter.y + 5.5"
          :x2="quadCenter.x"
          :y2="quadCenter.y + 16"
        />
        <line
          :x1="quadCenter.x - 16"
          :y1="quadCenter.y"
          :x2="quadCenter.x - 5.5"
          :y2="quadCenter.y"
        />
        <line
          :x1="quadCenter.x + 5.5"
          :y1="quadCenter.y"
          :x2="quadCenter.x + 16"
          :y2="quadCenter.y"
        />
        <circle :cx="quadCenter.x" :cy="quadCenter.y" r="7.5" class="ac-reticle-ring" />
        <circle :cx="quadCenter.x" :cy="quadCenter.y" r="1.6" class="ac-reticle-dot" />
      </g>

      <!-- 4 Edge Midpoint Bars (shown in both Rect & Free modes, unified MD3 style & thickness with corners) -->
      <g v-for="eb in edgeBars" :key="eb.edge">
        <line
          :x1="eb.bx1"
          :y1="eb.by1"
          :x2="eb.bx2"
          :y2="eb.by2"
          class="ac-gizmo-rim"
          :class="{ active: activeHandleKeys.has(`e-${eb.idx}`) || hoveredHandle === `e-${eb.idx}` }"
        />
        <line
          :x1="eb.bx1"
          :y1="eb.by1"
          :x2="eb.bx2"
          :y2="eb.by2"
          class="ac-gizmo-core"
          :class="{ active: activeHandleKeys.has(`e-${eb.idx}`) || hoveredHandle === `e-${eb.idx}` }"
        />
        <line
          :x1="eb.x1"
          :y1="eb.y1"
          :x2="eb.x2"
          :y2="eb.y2"
          class="ac-edge-hitline"
          :class="eb.cursorClass"
          @pointerenter="hoveredHandle = `e-${eb.idx}`"
          @pointerleave="hoveredHandle === `e-${eb.idx}` && (hoveredHandle = null)"
          @pointerdown="startEdgeDrag(eb.idx, $event)"
          @pointermove="onCalibrationPointerMove"
          @pointerup="onCalibrationPointerEnd"
          @pointercancel="onCalibrationPointerEnd"
        />
      </g>

      <!-- 4 Corners: L-shaped brackets in 'rect' mode, sleek MD3 round dots in 'free' mode -->
      <template v-if="quadMode === 'rect'">
        <g v-for="cb in cornerBrackets" :key="cb.idx">
          <path
            :d="cb.d"
            class="ac-gizmo-rim"
            :class="{ active: activeHandleKeys.has(`c-${cb.idx}`) || hoveredHandle === `c-${cb.idx}` }"
          />
          <path
            :d="cb.d"
            class="ac-gizmo-core"
            :class="{ active: activeHandleKeys.has(`c-${cb.idx}`) || hoveredHandle === `c-${cb.idx}` }"
          />
          <path
            :d="cb.d"
            class="ac-corner-hitpath"
            :class="cb.cursorClass"
            @pointerenter="hoveredHandle = `c-${cb.idx}`"
            @pointerleave="hoveredHandle === `c-${cb.idx}` && (hoveredHandle = null)"
            @pointerdown="startHandleDrag(cb.idx, $event)"
            @pointermove="onCalibrationPointerMove"
            @pointerup="onCalibrationPointerEnd"
            @pointercancel="onCalibrationPointerEnd"
          />
        </g>
      </template>
      <template v-else>
        <g v-for="(pt, idx) in corners" :key="idx">
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
            @pointerenter="hoveredHandle = `c-${idx}`"
            @pointerleave="hoveredHandle === `c-${idx}` && (hoveredHandle = null)"
            @pointerdown="startHandleDrag(idx, $event)"
            @pointermove="onCalibrationPointerMove"
            @pointerup="onCalibrationPointerEnd"
            @pointercancel="onCalibrationPointerEnd"
          />
        </g>
      </template>
    </svg>

    <div v-if="glError" class="ac-gl-error">
      {{ formatMessage(messages.overlay.webglInitFailed, { error: glError }) }}
    </div>
  </div>
</template>

<style scoped>
.ac-overlay-layer {
  position: absolute;
  inset: 0;
  /* Do NOT set z-index here: creating a stacking context isolates mix-blend-mode from .ac-backdrop-stage! */
  background: transparent;
}

.ac-gl-canvas {
  position: absolute;
  inset: 0;
  z-index: 10;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
  background: transparent;
}

.ac-gl-canvas.css-multiply {
  mix-blend-mode: multiply;
}

.ac-gl-canvas.css-screen {
  mix-blend-mode: screen;
}

.ac-quad-svg {
  position: absolute;
  inset: 0;
  z-index: 15;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
  touch-action: none;
}

.ac-main-poly {
  fill: rgba(168, 199, 250, 0.08);
  stroke: var(--md-sys-color-primary);
  stroke-width: 2;
  stroke-dasharray: 6 4;
  pointer-events: all;
  cursor: move;
  touch-action: none;
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

/* Unified sleek MD3 L-shaped corner brackets & edge midpoint bars (primary-container body + crisp primary rim) */
.ac-gizmo-rim {
  fill: none;
  stroke: var(--md-sys-color-primary);
  stroke-width: 10;
  stroke-linecap: round;
  stroke-linejoin: round;
  pointer-events: none;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.42));
  transition: stroke-width 0.12s ease;
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

.cur-nwse {
  cursor: nwse-resize;
}

.cur-nesw {
  cursor: nesw-resize;
}

.cur-ns {
  cursor: ns-resize;
}

.cur-ew {
  cursor: ew-resize;
}

.cur-grab {
  cursor: grab;
}

.cur-grab:active {
  cursor: grabbing;
}

.ac-gl-error {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 16px;
  border-radius: 12px;
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
  font-size: 13px;
}
</style>
