<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  applyHomography,
  computeHomography,
  invertMat3,
  rectToQuad,
  type Mat3,
  type Point2D,
} from '../core/homography';
import { WebGLPerspectiveRenderer, type BlendRenderMode } from '../core/webglOverlay';
import type { GridBoundsNormalized, PenpaIframeBridge } from '../core/penpaBridge';
import {
  isElementPassThrough,
  isItemCropped,
  type CropDraft,
  type GridElement,
} from '../core/canvasItems';
import {
  IDENTITY_VIEWPORT_TRANSFORM,
  multiplyMat3,
  viewportTransformToMat3,
  worldQuadToViewport,
  type WorldViewportTransform,
} from '../core/world';
import { useWholeElementDrag } from '../core/useWholeElementDrag';
import { formatMessage, messages } from '../core/i18n';

const props = defineProps<{
  element: GridElement;
  bridge: PenpaIframeBridge | null;
  hasDomBackdrop: boolean;
  viewportTransform?: WorldViewportTransform;
  worldBoundedToViewport: boolean;
  selected: boolean;
  cropDraft: CropDraft | null;
  spacePanning: boolean;
}>();

const emit = defineEmits<{
  (e: 'select', id: string): void;
  (e: 'update-corners', id: string, corners: [Point2D, Point2D, Point2D, Point2D]): void;
  (e: 'update-crop-draft', draft: CropDraft): void;
  (e: 'toggle-crop', id: string): void;
  (e: 'quad-geometry-change', outerQuad: [Point2D, Point2D, Point2D, Point2D]): void;
  (e: 'bounds-change', bounds: GridBoundsNormalized): void;
}>();

const glCanvasEl = ref<HTMLCanvasElement | null>(null);
const glError = ref<string | null>(null);

let renderer: WebGLPerspectiveRenderer | null = null;
let rafId = 0;
let unsubscribeBridge: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let needsRender = true;
const activePointerDraw = ref(false);

const currentBounds = ref<GridBoundsNormalized>({
  u0: 0,
  v0: 0,
  u1: 1,
  v1: 1,
  canvasCssW: 1,
  canvasCssH: 1,
});

const effectiveViewport = computed<WorldViewportTransform>(
  () => props.viewportTransform ?? IDENTITY_VIEWPORT_TRANSFORM,
);

const effectivePassThrough = computed(
  () => isElementPassThrough(props.element) || props.spacePanning,
);

const isCropping = computed(() => !!props.cropDraft);

const activeCrop = computed(() => props.cropDraft?.crop ?? props.element.crop);

const displayWorldCorners = computed<[Point2D, Point2D, Point2D, Point2D]>(() => {
  if (props.cropDraft) {
    return rectToQuad(props.cropDraft.croppedRect);
  }
  return props.element.corners;
});

const viewportCorners = computed<[Point2D, Point2D, Point2D, Point2D]>(() =>
  worldQuadToViewport(displayWorldCorners.value, effectiveViewport.value),
);

const effectiveShaderMode = computed<BlendRenderMode>(() => {
  if (props.element.blendMode === 'multiply' && !props.hasDomBackdrop) {
    return 'alpha-minrgb';
  }
  if (props.element.blendMode === 'multiply-inv' && !props.hasDomBackdrop) {
    return 'alpha-minrgb-inv';
  }
  return props.element.blendMode;
});

const useCssMultiply = computed(
  () => props.element.blendMode === 'multiply' && props.hasDomBackdrop,
);

const useCssScreen = computed(
  () => props.element.blendMode === 'multiply-inv' && props.hasDomBackdrop,
);

// Grid always aligns the full Penpa+ canvas [0, 0, 1, 1] modulated by activeCrop (identical to Image & Screen!)
const webglClipRect = computed<[number, number, number, number]>(() => {
  const c = activeCrop.value;
  if (!isItemCropped(c)) {
    return [0, 0, 1, 1];
  }
  return [c.left, c.top, c.right, c.bottom];
});

const homographyState = computed<{ H: Mat3 | null; invH: Mat3 | null }>(() => {
  if (props.cropDraft) {
    // Crop preview: map full uncropped [0..1]x[0..1] onto draft.fullRect so cropped-out region shows at 30% opacity!
    const fullSrc: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const H_world = computeHomography(fullSrc, rectToQuad(props.cropDraft.fullRect));
    if (!H_world) return { H: null, invH: null };
    const H = multiplyMat3(viewportTransformToMat3(effectiveViewport.value), H_world);
    return { H, invH: invertMat3(H) };
  }
  const c = props.element.crop;
  const src: [Point2D, Point2D, Point2D, Point2D] = [
    { x: c.left, y: c.top },
    { x: c.right, y: c.top },
    { x: c.right, y: c.bottom },
    { x: c.left, y: c.bottom },
  ];
  const H_world = computeHomography(src, displayWorldCorners.value);
  if (!H_world) return { H: null, invH: null };
  const H = multiplyMat3(viewportTransformToMat3(effectiveViewport.value), H_world);
  const invH = invertMat3(H);
  return { H, invH };
});

const outerCanvasQuad = computed<[Point2D, Point2D, Point2D, Point2D]>(() => {
  const H = homographyState.value.H;
  if (!H) return viewportCorners.value;
  const clip = webglClipRect.value;
  const p0 = applyHomography(H, clip[0], clip[1]);
  const p1 = applyHomography(H, clip[2], clip[1]);
  const p2 = applyHomography(H, clip[2], clip[3]);
  const p3 = applyHomography(H, clip[0], clip[3]);
  if (!p0 || !p1 || !p2 || !p3) return viewportCorners.value;
  return [p0, p1, p2, p3];
});

const hitPolyPointsSvg = computed(() => {
  const pts = props.cropDraft
    ? worldQuadToViewport(rectToQuad(props.cropDraft.fullRect), effectiveViewport.value)
    : viewportCorners.value;
  return pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
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
  () => [
    props.element,
    props.hasDomBackdrop,
    props.cropDraft,
    effectiveViewport.value,
  ],
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
    emit('bounds-change', next);
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
      emit('bounds-change', currentBounds.value);
      needsRender = true;
    }
  },
  { immediate: true },
);

function handleResize() {
  if (!renderer || !glCanvasEl.value) return;
  const rect = glCanvasEl.value.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const dpr = window.devicePixelRatio || 1;
  renderer.resize(rect.width, rect.height, dpr);
  needsRender = true;
}

watch(
  () => props.element.visible,
  (vis) => {
    if (vis) {
      requestAnimationFrame(() => {
        handleResize();
        needsRender = true;
      });
    }
  },
);

function renderLoop() {
  rafId = requestAnimationFrame(renderLoop);
  if (!renderer || !glCanvasEl.value) return;
  if (!props.element.visible) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = glCanvasEl.value.getBoundingClientRect();
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
      if (uploaded) needsRender = true;
    }
  }

  if (!needsRender) return;
  needsRender = false;

  const invH = homographyState.value.invH;
  if (!invH) {
    renderer.clear();
    return;
  }
  renderer.render(
    invH,
    dpr,
    effectiveShaderMode.value,
    props.element.opacity,
    0.99,
    webglClipRect.value,
    isCropping.value ? 0.3 : 0.0,
  );
}

function clientToPenpaUv(clientX: number, clientY: number): { u: number; v: number } | null {
  const invH = homographyState.value.invH;
  const canvas = glCanvasEl.value;
  if (!invH || !canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  const uv = applyHomography(invH, sx, sy);
  if (!uv) return null;
  const clip = webglClipRect.value;
  if (uv.x < clip[0] || uv.x > clip[2] || uv.y < clip[1] || uv.y > clip[3]) return null;
  return { u: uv.x, v: uv.y };
}

// Shared whole-body drag & crop-preview background-pan composable (same UX & clamping as MediaElementView)
const { beginDrag, beginCropPan } = useWholeElementDrag({
  getElement: () => props.element,
  getCropDraft: () => props.cropDraft,
  getViewport: () => effectiveViewport.value,
  isWorldBounded: () => props.worldBoundedToViewport,
  onUpdateCorners: (id, corners) => emit('update-corners', id, corners),
  onUpdateCropDraft: (draft) => emit('update-crop-draft', draft),
});

const cropGhostStyle = computed(() => {
  if (!props.cropDraft || !props.element.visible) return null;
  const fullRect = props.cropDraft.fullRect;
  const v = effectiveViewport.value;
  return {
    left: `${(fullRect.x - v.offsetX) * v.zoom}px`,
    top: `${(fullRect.y - v.offsetY) * v.zoom}px`,
    width: `${fullRect.w * v.zoom}px`,
    height: `${fullRect.h * v.zoom}px`,
    zIndex: Math.max(0, props.element.zIndex - 1),
  };
});

function onSurfacePointerDown(e: PointerEvent) {
  if (effectivePassThrough.value) return;
  if (e.button === 1) return; // allow middle-mouse canvas pan to bubble

  e.stopPropagation();
  emit('select', props.element.id);

  // Unlocked grid: start crop background-pan (in crop mode) or whole-body drag
  if (!props.element.locked) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    if (isCropping.value) {
      beginCropPan(e);
      return;
    }
    beginDrag(e);
    return;
  }

  // Locked grid: draw in Penpa+
  if (!props.bridge || !props.bridge.isReady()) return;
  const uv = clientToPenpaUv(e.clientX, e.clientY);
  if (!uv) return;

  e.preventDefault();
  activePointerDraw.value = true;
  try {
    (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
  } catch {}
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
  if (effectivePassThrough.value || !props.element.locked) return;
  if (!props.bridge || !props.bridge.isReady()) return;

  const uv = clientToPenpaUv(e.clientX, e.clientY);
  if (!uv) {
    if (activePointerDraw.value) props.bridge.dispatchPointer('out', 0, 0);
    return;
  }
  if (activePointerDraw.value) e.preventDefault();
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
  try {
    (e.currentTarget as HTMLElement | null)?.releasePointerCapture?.(e.pointerId);
  } catch {}
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
  if (effectivePassThrough.value || !props.element.locked) return;
  const uv = clientToPenpaUv(e.clientX, e.clientY);
  if (!uv) return;
  e.preventDefault();
  props.bridge?.dispatchPointer('contextmenu', uv.u, uv.v, { button: 2, buttons: 0 });
}

function onSurfaceDoubleClick(e: MouseEvent) {
  if (effectivePassThrough.value || props.element.locked) return;
  e.stopPropagation();
  emit('select', props.element.id);
  emit('toggle-crop', props.element.id);
}

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
  if (glCanvasEl.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(glCanvasEl.value);
  }
  window.addEventListener('resize', handleResize);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  resizeObserver?.disconnect();
  resizeObserver = null;
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
    renderer.render(
      invH,
      dpr,
      effectiveShaderMode.value,
      props.element.opacity,
      0.99,
      webglClipRect.value,
    );
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
  <!-- Direct sibling fragment: NO wrapper stacking context so mix-blend-mode & unified zIndex interleave freely! -->
  <div
    v-if="cropGhostStyle"
    class="ac-grid-crop-ghost"
    :style="cropGhostStyle"
    aria-hidden="true"
  />

  <canvas
    v-show="element.visible"
    ref="glCanvasEl"
    class="ac-gl-canvas"
    :class="{ 'css-multiply': useCssMultiply, 'css-screen': useCssScreen }"
    :style="{ zIndex: element.zIndex }"
  />

  <svg
    v-if="element.visible && !effectivePassThrough"
    class="ac-draw-hit-svg"
    :style="{ zIndex: element.zIndex }"
  >
    <polygon
      :points="hitPolyPointsSvg"
      class="ac-draw-hit-poly"
      :class="{ unlocked: !element.locked }"
      @pointerdown="onSurfacePointerDown"
      @pointermove="onSurfacePointerMove"
      @pointerup="onSurfacePointerUp"
      @pointercancel="onSurfacePointerUp"
      @contextmenu="onSurfaceContextMenu"
      @dblclick="onSurfaceDoubleClick"
    />
  </svg>

  <div v-if="glError" class="ac-gl-error">
    {{ formatMessage(messages.overlay.webglInitFailed, { error: glError }) }}
  </div>
</template>

<style scoped>
.ac-grid-crop-ghost {
  position: absolute;
  pointer-events: none;
  border: 1px dashed var(--md-sys-color-outline);
  background: color-mix(in srgb, var(--md-sys-color-surface-container) 16%, transparent);
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

.ac-gl-canvas.css-screen {
  mix-blend-mode: screen;
}

.ac-draw-hit-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

.ac-draw-hit-poly {
  fill: transparent;
  stroke: none;
  pointer-events: all;
  touch-action: none;
  cursor: default;
}

.ac-draw-hit-poly.unlocked {
  cursor: move;
}

.ac-gl-error {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 1200;
  padding: 12px 16px;
  border-radius: 12px;
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
  font-size: 13px;
  pointer-events: auto;
}
</style>
