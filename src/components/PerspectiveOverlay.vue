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

export type AlignTarget = 'grid' | 'canvas';
export type QuadMode = 'rect' | 'free';
type RectEdge = 'top' | 'right' | 'bottom' | 'left';

const MIN_RECT_SIZE = 48;

const props = defineProps<{
  bridge: PenpaIframeBridge | null;
  blendMode: BlendRenderMode;
  hasDomBackdrop: boolean;
  opacity: number;
  calibrating: boolean;
  alignTarget: AlignTarget;
  quadMode: QuadMode;
  corners: [Point2D, Point2D, Point2D, Point2D];
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
let needsRender = true;

const activePointerDraw = ref(false);
const draggingHandleIndex = ref<number | null>(null);
const draggingEdge = ref<{
  edge: RectEdge;
  edgeIndex: number;
  start: Point2D;
  initialCorners: [Point2D, Point2D, Point2D, Point2D];
} | null>(null);
const hoveredHandle = ref<string | null>(null);
const draggingWholeQuad = ref<{
  start: Point2D;
  initialCorners: [Point2D, Point2D, Point2D, Point2D];
} | null>(null);

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
    return 'alpha-luma';
  }
  if (props.blendMode === 'multiply-inv' && !props.hasDomBackdrop) {
    return 'alpha-luma-inv';
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
  const rect = hostEl.value.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  renderer.resize(rect.width, rect.height, dpr);
  needsRender = true;
}

function renderLoop() {
  rafId = requestAnimationFrame(renderLoop);
  if (!renderer || !hostEl.value) return;

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
  const dpr = window.devicePixelRatio || 1;
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

// --- Calibration handle dragging ---
function startHandleDrag(index: number, e: PointerEvent) {
  e.preventDefault();
  e.stopPropagation();
  draggingHandleIndex.value = index;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function getSafeHostBounds(rect: DOMRect) {
  const safe = safeAreaInsets.value;
  const minX = safe.left + 8;
  const minY = safe.top + 8;
  const maxX = Math.max(minX + MIN_RECT_SIZE, rect.width - safe.right - 8);
  const maxY = Math.max(minY + MIN_RECT_SIZE, rect.height - safe.bottom - 8);
  return { minX, minY, maxX, maxY };
}

function moveHandleDrag(e: PointerEvent) {
  const idx = draggingHandleIndex.value;
  if (idx === null || !hostEl.value) return;
  e.preventDefault();
  const rect = hostEl.value.getBoundingClientRect();
  const bounds = getSafeHostBounds(rect);
  const nx = Math.max(bounds.minX, Math.min(bounds.maxX, e.clientX - rect.left));
  const ny = Math.max(bounds.minY, Math.min(bounds.maxY, e.clientY - rect.top));

  if (props.quadMode === 'rect') {
    let left = Math.min(props.corners[0].x, props.corners[3].x);
    let right = Math.max(props.corners[1].x, props.corners[2].x);
    let top = Math.min(props.corners[0].y, props.corners[1].y);
    let bottom = Math.max(props.corners[2].y, props.corners[3].y);

    if (idx === 0) {
      left = Math.min(nx, right - MIN_RECT_SIZE);
      top = Math.min(ny, bottom - MIN_RECT_SIZE);
    } else if (idx === 1) {
      right = Math.max(nx, left + MIN_RECT_SIZE);
      top = Math.min(ny, bottom - MIN_RECT_SIZE);
    } else if (idx === 2) {
      right = Math.max(nx, left + MIN_RECT_SIZE);
      bottom = Math.max(ny, top + MIN_RECT_SIZE);
    } else if (idx === 3) {
      left = Math.min(nx, right - MIN_RECT_SIZE);
      bottom = Math.max(ny, top + MIN_RECT_SIZE);
    }

    emit('update:corners', [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ]);
    return;
  }

  const next: [Point2D, Point2D, Point2D, Point2D] = [
    { ...props.corners[0] },
    { ...props.corners[1] },
    { ...props.corners[2] },
    { ...props.corners[3] },
  ];
  next[idx] = { x: nx, y: ny };
  if (isConvexQuad(next)) {
    emit('update:corners', next);
  }
}

function endHandleDrag(e: PointerEvent) {
  if (draggingHandleIndex.value === null) return;
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  draggingHandleIndex.value = null;
}

// --- Unified 4-edge dragging (axis-locked in 'rect' mode, parallel edge slide in 'free' mode) ---
const EDGE_NAMES: [RectEdge, RectEdge, RectEdge, RectEdge] = ['top', 'right', 'bottom', 'left'];

function startEdgeDrag(edgeIndex: number, e: PointerEvent) {
  if (!hostEl.value) return;
  e.preventDefault();
  e.stopPropagation();
  const rect = hostEl.value.getBoundingClientRect();
  draggingEdge.value = {
    edge: EDGE_NAMES[edgeIndex],
    edgeIndex,
    start: { x: e.clientX - rect.left, y: e.clientY - rect.top },
    initialCorners: [
      { ...props.corners[0] },
      { ...props.corners[1] },
      { ...props.corners[2] },
      { ...props.corners[3] },
    ],
  };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function moveEdgeDrag(e: PointerEvent) {
  const drag = draggingEdge.value;
  if (!drag || !hostEl.value) return;
  e.preventDefault();
  const rect = hostEl.value.getBoundingClientRect();
  const bounds = getSafeHostBounds(rect);
  const nx = Math.max(bounds.minX, Math.min(bounds.maxX, e.clientX - rect.left));
  const ny = Math.max(bounds.minY, Math.min(bounds.maxY, e.clientY - rect.top));

  if (props.quadMode === 'rect') {
    let left = Math.min(props.corners[0].x, props.corners[3].x);
    let right = Math.max(props.corners[1].x, props.corners[2].x);
    let top = Math.min(props.corners[0].y, props.corners[1].y);
    let bottom = Math.max(props.corners[2].y, props.corners[3].y);

    if (drag.edge === 'top') {
      top = Math.min(ny, bottom - MIN_RECT_SIZE);
    } else if (drag.edge === 'bottom') {
      bottom = Math.max(ny, top + MIN_RECT_SIZE);
    } else if (drag.edge === 'left') {
      left = Math.min(nx, right - MIN_RECT_SIZE);
    } else if (drag.edge === 'right') {
      right = Math.max(nx, left + MIN_RECT_SIZE);
    }

    emit('update:corners', [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ]);
    return;
  }

  // Free mode: translate both endpoints of the grabbed edge together
  const dx = e.clientX - rect.left - drag.start.x;
  const dy = e.clientY - rect.top - drag.start.y;
  const i0 = drag.edgeIndex;
  const i1 = (drag.edgeIndex + 1) % 4;
  const next: [Point2D, Point2D, Point2D, Point2D] = [
    { ...drag.initialCorners[0] },
    { ...drag.initialCorners[1] },
    { ...drag.initialCorners[2] },
    { ...drag.initialCorners[3] },
  ];
  next[i0] = {
    x: Math.max(bounds.minX, Math.min(bounds.maxX, drag.initialCorners[i0].x + dx)),
    y: Math.max(bounds.minY, Math.min(bounds.maxY, drag.initialCorners[i0].y + dy)),
  };
  next[i1] = {
    x: Math.max(bounds.minX, Math.min(bounds.maxX, drag.initialCorners[i1].x + dx)),
    y: Math.max(bounds.minY, Math.min(bounds.maxY, drag.initialCorners[i1].y + dy)),
  };
  if (isConvexQuad(next)) {
    emit('update:corners', next);
  }
}

function endEdgeDrag(e: PointerEvent) {
  if (!draggingEdge.value) return;
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  draggingEdge.value = null;
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

function startWholeQuadDrag(e: PointerEvent) {
  if (!props.calibrating || !hostEl.value) return;
  const rect = hostEl.value.getBoundingClientRect();
  const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  if (!isPointInQuad(pt, props.corners)) return;

  e.preventDefault();
  draggingWholeQuad.value = {
    start: pt,
    initialCorners: [
      { ...props.corners[0] },
      { ...props.corners[1] },
      { ...props.corners[2] },
      { ...props.corners[3] },
    ],
  };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function moveWholeQuadDrag(e: PointerEvent) {
  const drag = draggingWholeQuad.value;
  if (!drag || !hostEl.value) return;
  e.preventDefault();
  const rect = hostEl.value.getBoundingClientRect();
  const bounds = getSafeHostBounds(rect);
  let dx = e.clientX - rect.left - drag.start.x;
  let dy = e.clientY - rect.top - drag.start.y;
  const xs = drag.initialCorners.map((p) => p.x);
  const ys = drag.initialCorners.map((p) => p.y);
  const minDx = bounds.minX - Math.min(...xs);
  const maxDx = bounds.maxX - Math.max(...xs);
  const minDy = bounds.minY - Math.min(...ys);
  const maxDy = bounds.maxY - Math.max(...ys);
  dx = Math.max(minDx, Math.min(maxDx, dx));
  dy = Math.max(minDy, Math.min(maxDy, dy));
  const next: [Point2D, Point2D, Point2D, Point2D] = [
    { x: drag.initialCorners[0].x + dx, y: drag.initialCorners[0].y + dy },
    { x: drag.initialCorners[1].x + dx, y: drag.initialCorners[1].y + dy },
    { x: drag.initialCorners[2].x + dx, y: drag.initialCorners[2].y + dy },
    { x: drag.initialCorners[3].x + dx, y: drag.initialCorners[3].y + dy },
  ];
  emit('update:corners', next);
}

function endWholeQuadDrag(e: PointerEvent) {
  if (!draggingWholeQuad.value) return;
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  draggingWholeQuad.value = null;
}

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
  window.addEventListener('resize', handleResize);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  window.removeEventListener('resize', handleResize);
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
      @pointermove="moveWholeQuadDrag"
      @pointerup="endWholeQuadDrag"
      @pointercancel="endWholeQuadDrag"
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
          :class="{ active: draggingEdge?.edgeIndex === eb.idx || hoveredHandle === `e-${eb.idx}` }"
        />
        <line
          :x1="eb.bx1"
          :y1="eb.by1"
          :x2="eb.bx2"
          :y2="eb.by2"
          class="ac-gizmo-core"
          :class="{ active: draggingEdge?.edgeIndex === eb.idx || hoveredHandle === `e-${eb.idx}` }"
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
          @pointermove="moveEdgeDrag"
          @pointerup="endEdgeDrag"
          @pointercancel="endEdgeDrag"
        />
      </g>

      <!-- 4 Corners: L-shaped brackets in 'rect' mode, sleek MD3 round dots in 'free' mode -->
      <template v-if="quadMode === 'rect'">
        <g v-for="cb in cornerBrackets" :key="cb.idx">
          <path
            :d="cb.d"
            class="ac-gizmo-rim"
            :class="{ active: draggingHandleIndex === cb.idx || hoveredHandle === `c-${cb.idx}` }"
          />
          <path
            :d="cb.d"
            class="ac-gizmo-core"
            :class="{ active: draggingHandleIndex === cb.idx || hoveredHandle === `c-${cb.idx}` }"
          />
          <path
            :d="cb.d"
            class="ac-corner-hitpath"
            :class="cb.cursorClass"
            @pointerenter="hoveredHandle = `c-${cb.idx}`"
            @pointerleave="hoveredHandle === `c-${cb.idx}` && (hoveredHandle = null)"
            @pointerdown="startHandleDrag(cb.idx, $event)"
            @pointermove="moveHandleDrag"
            @pointerup="endHandleDrag"
            @pointercancel="endHandleDrag"
          />
        </g>
      </template>
      <template v-else>
        <g v-for="(pt, idx) in corners" :key="idx">
          <circle
            :cx="pt.x"
            :cy="pt.y"
            :r="draggingHandleIndex === idx || hoveredHandle === `c-${idx}` ? 12.5 : 10"
            class="ac-corner-dot"
            :class="{ active: draggingHandleIndex === idx || hoveredHandle === `c-${idx}` }"
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
            @pointermove="moveHandleDrag"
            @pointerup="endHandleDrag"
            @pointercancel="endHandleDrag"
          />
        </g>
      </template>
    </svg>

    <div v-if="glError" class="ac-gl-error">
      WebGL2 初始化失败：{{ glError }}
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
}

.ac-main-poly {
  fill: rgba(168, 199, 250, 0.08);
  stroke: var(--md-sys-color-primary);
  stroke-width: 2;
  stroke-dasharray: 6 4;
  pointer-events: all;
  cursor: move;
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
