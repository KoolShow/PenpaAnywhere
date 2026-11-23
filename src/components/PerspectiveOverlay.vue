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

export type AlignTarget = 'grid' | 'canvas';

const props = defineProps<{
  bridge: PenpaIframeBridge | null;
  blendMode: BlendRenderMode;
  hasDomBackdrop: boolean;
  opacity: number;
  calibrating: boolean;
  alignTarget: AlignTarget;
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

// Effective WebGL blend mode: CSS multiply only works when a DOM backdrop exists in the same page.
const effectiveShaderMode = computed<BlendRenderMode>(() => {
  if (props.blendMode === 'multiply' && !props.hasDomBackdrop) {
    return 'alpha-luma';
  }
  return props.blendMode;
});

const useCssMultiply = computed(
  () => props.blendMode === 'multiply' && props.hasDomBackdrop,
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

function moveHandleDrag(e: PointerEvent) {
  const idx = draggingHandleIndex.value;
  if (idx === null || !hostEl.value) return;
  e.preventDefault();
  const rect = hostEl.value.getBoundingClientRect();
  const nx = Math.max(8, Math.min(rect.width - 8, e.clientX - rect.left));
  const ny = Math.max(8, Math.min(rect.height - 8, e.clientY - rect.top));

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
  const dx = e.clientX - rect.left - drag.start.x;
  const dy = e.clientY - rect.top - drag.start.y;
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

const handleLabels = ['TL', 'TR', 'BR', 'BL'];

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
      :class="{ 'css-multiply': useCssMultiply }"
    />

    <!-- Calibration Quad Guides & 4 Perspective Control Points -->
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
    </svg>

    <template v-if="calibrating">
      <div
        v-for="(pt, idx) in corners"
        :key="idx"
        class="ac-handle"
        :style="{ left: `${pt.x}px`, top: `${pt.y}px` }"
        @pointerdown="startHandleDrag(idx, $event)"
        @pointermove="moveHandleDrag"
        @pointerup="endHandleDrag"
        @pointercancel="endHandleDrag"
      >
        <div class="ac-handle-crosshair" />
        <span class="ac-handle-label">{{ handleLabels[idx] }}</span>
      </div>
    </template>

    <div v-if="glError" class="ac-gl-error">
      WebGL2 初始化失败：{{ glError }}
    </div>
  </div>
</template>

<style scoped>
.ac-overlay-layer {
  position: absolute;
  inset: 0;
  z-index: 10;
  background: transparent;
}

.ac-gl-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
  background: transparent;
}

.ac-gl-canvas.css-multiply {
  mix-blend-mode: multiply;
}

.ac-quad-svg {
  position: absolute;
  inset: 0;
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

.ac-handle {
  position: absolute;
  width: 28px;
  height: 28px;
  margin-left: -14px;
  margin-top: -14px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--md-sys-color-primary-container) 82%, transparent);
  border: 2px solid var(--md-sys-color-primary);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.55);
  cursor: grab;
  z-index: 20;
  touch-action: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ac-handle:active {
  cursor: grabbing;
  transform: scale(1.12);
  background: var(--md-sys-color-primary);
}

.ac-handle-crosshair {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--md-sys-color-on-primary-container);
}

.ac-handle-label {
  position: absolute;
  top: -20px;
  left: 50%;
  transform: translateX(-50%);
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-primary);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  pointer-events: none;
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
