<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  isIdentityViewportTransform,
  panViewportBy,
  worldToViewport,
  zoomViewportAt,
  type WorldViewportTransform,
} from '../core/world';
import { messages } from '../core/i18n';
import { beginGlobalDrag, endGlobalDrag, tryCapturePointer, tryReleasePointer } from '../core/dragGuard';
import type { ButtonDisplayMode } from '../core/storage';
import MdIcon from './MdIcon.vue';
import MdActionBtn from './MdActionBtn.vue';

const props = defineProps<{
  viewportTransform: WorldViewportTransform;
  selectedId: string | null;
  buttonDisplayMode: ButtonDisplayMode;
}>();

const emit = defineEmits<{
  (e: 'update:viewportTransform', v: WorldViewportTransform): void;
  (e: 'select', id: string | null): void;
}>();

const spacePanning = ref(false);
const isPanning = ref(false);
const viewportSize = ref({ w: window.innerWidth || 1280, h: window.innerHeight || 800 });
const backdropEl = ref<HTMLDivElement | null>(null);

const checkerboardStyle = computed(() => {
  const v = props.viewportTransform;
  const tile = Math.max(8, Math.min(96, 24 * v.zoom));
  const half = tile * 0.5;
  const ox = -v.offsetX * v.zoom;
  const oy = -v.offsetY * v.zoom;
  return {
    backgroundSize: `${tile}px ${tile}px`,
    backgroundPosition: `${ox}px ${oy}px, ${ox}px ${oy + half}px, ${ox + half}px ${oy - half}px, ${ox - half}px ${oy}px`,
  };
});

const originVp = computed(() => worldToViewport({ x: 0, y: 0 }, props.viewportTransform));
const showOriginMarker = computed(() => !isIdentityViewportTransform(props.viewportTransform));
const zoomPercent = computed(() => Math.round(props.viewportTransform.zoom * 100));

// Empty-space pan & 2-finger touch pinch-zoom (window-bound + pointer capture so fast drags never stall)
const bgTouchPointers = new Map<number, { x: number; y: number }>();
let panSession: {
  pointerId: number;
  captureEl: Element | null;
  startClient: { x: number; y: number };
  baseTransform: WorldViewportTransform;
} | null = null;
let pinchSession: {
  baseTransform: WorldViewportTransform;
  startMid: { x: number; y: number };
  startDist: number;
} | null = null;
let globalDragHeld = false;

function syncStageGlobalDrag() {
  const active = !!panSession || !!pinchSession;
  if (active && !globalDragHeld) {
    globalDragHeld = true;
    beginGlobalDrag();
  } else if (!active && globalDragHeld) {
    globalDragHeld = false;
    endGlobalDrag();
  }
}

function startPan(e: PointerEvent) {
  if (panSession) {
    tryReleasePointer(panSession.captureEl, panSession.pointerId);
  }
  const captureEl = tryCapturePointer(backdropEl.value, e.pointerId);
  panSession = {
    pointerId: e.pointerId,
    captureEl,
    startClient: { x: e.clientX, y: e.clientY },
    baseTransform: { ...props.viewportTransform },
  };
  isPanning.value = true;
  syncStageGlobalDrag();
}

function onStagePointerDown(e: PointerEvent) {
  if (e.button === 1 || (e.button === 0 && spacePanning.value)) {
    e.preventDefault();
    startPan(e);
    return;
  }
  if (e.button !== 0 && e.pointerType === 'mouse') return;

  if (props.selectedId !== null) {
    emit('select', null);
  }
  if (e.pointerType === 'touch') {
    bgTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    tryCapturePointer(backdropEl.value, e.pointerId);
    if (bgTouchPointers.size === 2) {
      if (panSession) {
        tryReleasePointer(panSession.captureEl, panSession.pointerId);
        panSession = null;
      }
      isPanning.value = true;
      const pts = Array.from(bgTouchPointers.values());
      pinchSession = {
        baseTransform: { ...props.viewportTransform },
        startMid: { x: (pts[0].x + pts[1].x) * 0.5, y: (pts[0].y + pts[1].y) * 0.5 },
        startDist: Math.max(10, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)),
      };
      syncStageGlobalDrag();
      return;
    }
  }
  startPan(e);
}

function onStagePointerMove(e: PointerEvent) {
  if (bgTouchPointers.has(e.pointerId)) {
    bgTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinchSession && bgTouchPointers.size === 2) {
      e.preventDefault();
      const pts = Array.from(bgTouchPointers.values());
      const curMid = { x: (pts[0].x + pts[1].x) * 0.5, y: (pts[0].y + pts[1].y) * 0.5 };
      const curDist = Math.max(10, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
      const scaleRatio = curDist / pinchSession.startDist;
      const panned = panViewportBy(
        pinchSession.baseTransform,
        curMid.x - pinchSession.startMid.x,
        curMid.y - pinchSession.startMid.y,
      );
      emit('update:viewportTransform', zoomViewportAt(panned, pinchSession.baseTransform.zoom * scaleRatio, curMid));
      return;
    }
  }

  if (panSession && e.pointerId === panSession.pointerId) {
    e.preventDefault();
    const dx = e.clientX - panSession.startClient.x;
    const dy = e.clientY - panSession.startClient.y;
    emit('update:viewportTransform', panViewportBy(panSession.baseTransform, dx, dy));
  }
}

function onStagePointerUp(e: PointerEvent) {
  if (bgTouchPointers.has(e.pointerId)) {
    bgTouchPointers.delete(e.pointerId);
    tryReleasePointer(backdropEl.value, e.pointerId);
    if (bgTouchPointers.size < 2) pinchSession = null;
  }
  if (panSession && e.pointerId === panSession.pointerId) {
    tryReleasePointer(panSession.captureEl, panSession.pointerId);
    panSession = null;
  }
  if (!panSession && !pinchSession) {
    isPanning.value = false;
  }
  syncStageGlobalDrag();
}

function zoomStep(factor: number) {
  const center = { x: viewportSize.value.w * 0.5, y: viewportSize.value.h * 0.5 };
  emit('update:viewportTransform', zoomViewportAt(props.viewportTransform, props.viewportTransform.zoom * factor, center));
}

function resetViewport() {
  emit('update:viewportTransform', { offsetX: 0, offsetY: 0, zoom: 1 });
}

function onWindowKeyDown(e: KeyboardEvent) {
  const tag = (document.activeElement?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.code === 'Space' && !e.repeat) spacePanning.value = true;
}

function onWindowKeyUp(e: KeyboardEvent) {
  if (e.code === 'Space') spacePanning.value = false;
}

function onWindowBlur() {
  spacePanning.value = false;
  if (panSession) {
    tryReleasePointer(panSession.captureEl, panSession.pointerId);
    panSession = null;
  }
  pinchSession = null;
  bgTouchPointers.clear();
  isPanning.value = false;
  syncStageGlobalDrag();
}

function onWindowResize() {
  viewportSize.value = { w: window.innerWidth || 1280, h: window.innerHeight || 800 };
}

onMounted(() => {
  window.addEventListener('pointermove', onStagePointerMove);
  window.addEventListener('pointerup', onStagePointerUp);
  window.addEventListener('pointercancel', onStagePointerUp);
  window.addEventListener('keydown', onWindowKeyDown);
  window.addEventListener('keyup', onWindowKeyUp);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('resize', onWindowResize);
});

onBeforeUnmount(() => {
  onWindowBlur();
  window.removeEventListener('pointermove', onStagePointerMove);
  window.removeEventListener('pointerup', onStagePointerUp);
  window.removeEventListener('pointercancel', onStagePointerUp);
  window.removeEventListener('keydown', onWindowKeyDown);
  window.removeEventListener('keyup', onWindowKeyUp);
  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('resize', onWindowResize);
});
</script>

<template>
  <!-- Background checkerboard + empty-space pan surface (z-index: 0, behind all unified world elements) -->
  <div
    ref="backdropEl"
    class="ac-canvas-backdrop"
    :class="{ panning: spacePanning || isPanning }"
    :style="checkerboardStyle"
    @pointerdown="onStagePointerDown"
  >
    <!-- Exact 21x21 symmetric world origin (0, 0) crosshair (10px + 1px + 10px equal arms) -->
    <svg
      v-if="showOriginMarker"
      class="ac-world-origin"
      width="21"
      height="21"
      viewBox="0 0 21 21"
      :style="{ left: `${Math.round(originVp.x)}px`, top: `${Math.round(originVp.y)}px` }"
      aria-hidden="true"
    >
      <line x1="0" y1="10.5" x2="21" y2="10.5" />
      <line x1="10.5" y1="0" x2="10.5" y2="21" />
    </svg>
  </div>

  <!-- Bottom-left Viewport Zoom / Reset HUD pill -->
  <div class="ac-viewport-hud" @pointerdown.stop>
    <button
      class="ac-icon-btn xs"
      :title="messages.stage.zoomOutTitle"
      :aria-label="messages.stage.zoomOutTitle"
      @click="zoomStep(1 / 1.2)"
    >
      <MdIcon name="remove" :size="16" />
    </button>
    <span class="ac-hud-zoom">{{ zoomPercent }}%</span>
    <button
      class="ac-icon-btn xs"
      :title="messages.stage.zoomInTitle"
      :aria-label="messages.stage.zoomInTitle"
      @click="zoomStep(1.2)"
    >
      <MdIcon name="add" :size="16" />
    </button>
    <MdActionBtn
      class="ac-hud-reset"
      icon="recenter"
      :label="messages.stage.resetView"
      :title="messages.stage.resetViewTitle"
      :mode="buttonDisplayMode"
      variant="toggle"
      :active="showOriginMarker"
      size="xs"
      @click="resetViewport"
    />
  </div>
</template>

<style scoped>
.ac-canvas-backdrop {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: auto;
  touch-action: none;
  background-image:
    linear-gradient(45deg, var(--ac-checker-a) 25%, transparent 25%),
    linear-gradient(-45deg, var(--ac-checker-a) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--ac-checker-a) 75%),
    linear-gradient(-45deg, transparent 75%, var(--ac-checker-a) 75%);
  background-color: var(--ac-checker-b);
  cursor: default;
}

.ac-canvas-backdrop.panning {
  cursor: grabbing;
}

.ac-world-origin {
  position: absolute;
  transform: translate(-10.5px, -10.5px);
  pointer-events: none;
  opacity: 0.72;
  overflow: visible;
}

.ac-world-origin line {
  stroke: var(--md-sys-color-primary);
  stroke-width: 1;
  shape-rendering: crispEdges;
}

.ac-viewport-hud {
  position: fixed;
  z-index: 1020;
  left: calc(14px + var(--ac-safe-left, 0px));
  bottom: calc(14px + var(--ac-safe-bottom, 0px));
  transform: scale(var(--ac-ui-scale, 1));
  transform-origin: bottom left;
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--md-sys-color-surface-container) 92%, transparent);
  border: 1px solid var(--md-sys-color-outline-variant);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.36);
  backdrop-filter: blur(10px);
}

.ac-hud-zoom {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  min-width: 40px;
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  color: var(--md-sys-color-on-surface-variant);
  font-variant-numeric: tabular-nums;
}

.ac-hud-reset {
  margin-left: 2px;
}
</style>
