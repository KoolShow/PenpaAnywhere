<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getPenpaBridge, type PenpaIframeBridge } from '../core/penpaBridge';
import { loadPersistedState, patchPersistedState } from '../core/storage';
import { safeAreaInsets } from '../core/safeArea';
import { messages } from '../core/i18n';

const props = defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: 'bridge-ready', bridge: PenpaIframeBridge): void;
  (e: 'update:visible', value: boolean): void;
  (e: 'bounds-change', rect: { x: number; y: number; w: number; h: number }): void;
}>();

const savedDock = loadPersistedState().dock;
const hasSavedDock = !!savedDock;

const iframeEl = ref<HTMLIFrameElement | null>(null);
const collapsed = ref(savedDock?.collapsed ?? false);
const dockOpacity = ref(
  typeof savedDock?.opacity === 'number' && savedDock.opacity >= 0.35 && savedDock.opacity <= 1
    ? savedDock.opacity
    : 0.96,
);
const scale = ref(
  typeof savedDock?.scale === 'number' && savedDock.scale >= 0.5 && savedDock.scale <= 1.15
    ? savedDock.scale
    : 1,
);
const readyState = ref(false);
const isInteracting = ref(false);

// Default floating tool window size fits Penpa+ native 600px #buttons with zero layout distortion
const pos = ref({
  x:
    typeof savedDock?.xRatio === 'number'
      ? Math.round(savedDock.xRatio * (window.innerWidth || 1280))
      : 20,
  y:
    typeof savedDock?.yRatio === 'number'
      ? Math.round(savedDock.yRatio * (window.innerHeight || 800))
      : 64,
});
const size = ref({
  w: typeof savedDock?.w === 'number' && savedDock.w >= 260 ? savedDock.w : 660,
  h: typeof savedDock?.h === 'number' && savedDock.h >= 180 ? savedDock.h : 420,
});

function persistDockState() {
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  patchPersistedState({
    dock: {
      xRatio: pos.value.x / vw,
      yRatio: pos.value.y / vh,
      w: size.value.w,
      h: size.value.h,
      scale: scale.value,
      opacity: dockOpacity.value,
      collapsed: collapsed.value,
    },
  });
}

let dragMode: 'move' | 'resize' | null = null;
let dragStart = { x: 0, y: 0, origX: 0, origY: 0, origW: 0, origH: 0 };
let pollTimer = 0;

function emitBounds() {
  if (!props.visible) {
    emit('bounds-change', { x: -100, y: -100, w: 0, h: 0 });
    return;
  }
  emit('bounds-change', {
    x: pos.value.x,
    y: pos.value.y,
    w: collapsed.value ? 156 : size.value.w,
    h: collapsed.value ? 36 : size.value.h,
  });
}

function clampPosition(isInitial = false) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const safe = safeAreaInsets.value;
  const safeW = Math.max(240, vw - safe.left - safe.right);
  const safeH = Math.max(160, vh - safe.top - safe.bottom);
  const minX = safe.left + 4;
  const minY = safe.top + 4;

  if (vw < 700 && isInitial && !hasSavedDock) {
    size.value.w = Math.max(260, safeW - 12);
    size.value.h = Math.min(300, Math.round(safeH * 0.36));
    scale.value = Math.max(0.52, Math.min(1, (size.value.w - 14) / 640));
    pos.value.x = safe.left + 6;
    pos.value.y = Math.max(minY + 56, vh - safe.bottom - size.value.h - 12);
  } else {
    const effectiveW = Math.min(size.value.w, Math.max(260, safeW - 12));
    const effectiveH = Math.min(size.value.h, Math.max(160, safeH - 48));
    size.value.w = effectiveW;
    size.value.h = effectiveH;
    const maxX = Math.max(minX, vw - safe.right - Math.min(collapsed.value ? 156 : effectiveW, 100));
    const maxY = Math.max(minY, vh - safe.bottom - 40);
    pos.value.x = Math.max(minX, Math.min(maxX, pos.value.x));
    pos.value.y = Math.max(minY, Math.min(maxY, pos.value.y));
  }
  emitBounds();
}

function startMove(e: PointerEvent) {
  if ((e.target as HTMLElement).closest('button, input')) return;
  e.preventDefault();
  dragMode = 'move';
  isInteracting.value = true;
  dragStart = {
    x: e.clientX,
    y: e.clientY,
    origX: pos.value.x,
    origY: pos.value.y,
    origW: size.value.w,
    origH: size.value.h,
  };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function startResize(e: PointerEvent) {
  e.preventDefault();
  e.stopPropagation();
  dragMode = 'resize';
  isInteracting.value = true;
  dragStart = {
    x: e.clientX,
    y: e.clientY,
    origX: pos.value.x,
    origY: pos.value.y,
    origW: size.value.w,
    origH: size.value.h,
  };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onDragMove(e: PointerEvent) {
  if (!dragMode) return;
  e.preventDefault();
  const safe = safeAreaInsets.value;
  const minX = safe.left + 4;
  const minY = safe.top + 4;
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  if (dragMode === 'move') {
    const curW = collapsed.value ? 156 : size.value.w;
    const maxX = Math.max(minX, window.innerWidth - safe.right - Math.min(curW, 100));
    const maxY = Math.max(minY, window.innerHeight - safe.bottom - 40);
    pos.value.x = Math.max(minX, Math.min(maxX, dragStart.origX + dx));
    pos.value.y = Math.max(minY, Math.min(maxY, dragStart.origY + dy));
  } else {
    const maxW = Math.max(260, window.innerWidth - safe.right - pos.value.x - 4);
    const maxH = Math.max(160, window.innerHeight - safe.bottom - pos.value.y - 4);
    size.value.w = Math.max(260, Math.min(maxW, dragStart.origW + dx));
    size.value.h = Math.max(160, Math.min(maxH, dragStart.origH + dy));
  }
  emitBounds();
}

function onDragEnd(e: PointerEvent) {
  if (!dragMode) return;
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  dragMode = null;
  isInteracting.value = false;
  persistDockState();
}

function toggleCollapsed() {
  collapsed.value = !collapsed.value;
  emitBounds();
  persistDockState();
}

function onIframeLoad() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    const bridge = getPenpaBridge(iframeEl.value);
    if (bridge && bridge.isReady()) {
      window.clearInterval(pollTimer);
      pollTimer = 0;
      readyState.value = true;
      emit('bridge-ready', bridge);
    }
  }, 100);
}

const iframeStyle = computed(() => {
  const s = scale.value;
  return {
    width: `${100 / s}%`,
    height: `${100 / s}%`,
    transform: `scale(${s})`,
    transformOrigin: 'top left',
  };
});

function onWindowResize() {
  clampPosition(false);
}

onMounted(() => {
  clampPosition(true);
  window.addEventListener('resize', onWindowResize);
});

watch(
  safeAreaInsets,
  () => {
    clampPosition(false);
  },
  { deep: true },
);

watch([scale, dockOpacity], () => {
  persistDockState();
});

watch(
  () => props.visible,
  () => {
    emitBounds();
  },
);

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize);
  if (pollTimer) window.clearInterval(pollTimer);
});
</script>

<template>
  <!-- Keep mounted even when hidden so Penpa+ state & canvas never reset -->
  <section
    class="ac-dock"
    :class="{ collapsed, hidden: !visible, animating: !isInteracting }"
    :style="{
      left: `${pos.x}px`,
      top: `${pos.y}px`,
      width: collapsed ? '156px' : `${size.w}px`,
      height: collapsed ? '36px' : `${size.h}px`,
      opacity: dockOpacity,
    }"
  >
    <header
      class="ac-dock-header"
      @pointerdown="startMove"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
    >
      <div class="ac-dock-title">
        <span class="ac-dot" :class="{ ready: readyState }" />
        <span>Penpa+</span>
      </div>
      <div class="ac-dock-actions">
        <div class="ac-dock-sliders" :class="{ closed: collapsed }" :inert="collapsed">
          <div class="ac-dock-sliders-inner">
            <label class="ac-mini-slider" :title="messages.dock.zoomTitle">
              <span>{{ messages.dock.zoom }}</span>
              <input
                v-model.number="scale"
                type="range"
                min="0.5"
                max="1.15"
                step="0.05"
              />
            </label>
            <label class="ac-mini-slider" :title="messages.dock.opacityTitle">
              <span>{{ messages.dock.opacity }}</span>
              <input
                v-model.number="dockOpacity"
                type="range"
                min="0.35"
                max="1"
                step="0.05"
              />
            </label>
          </div>
        </div>
        <div class="ac-dock-btns">
          <button
            class="ac-icon-btn"
            :title="collapsed ? messages.dock.expand : messages.dock.collapse"
            @click="toggleCollapsed"
          >
            {{ collapsed ? '▢' : '—' }}
          </button>
          <button
            class="ac-icon-btn"
            :title="messages.dock.hide"
            @click="emit('update:visible', false)"
          >
            ✕
          </button>
        </div>
      </div>
    </header>

    <div class="ac-dock-body" :inert="collapsed">
      <iframe
        ref="iframeEl"
        src="./penpa-edit/index.html"
        class="ac-penpa-iframe"
        :style="iframeStyle"
        @load="onIframeLoad"
      />
      <div
        v-if="!collapsed"
        class="ac-resize-handle"
        :title="messages.dock.resizeTitle"
        @pointerdown="startResize"
        @pointermove="onDragMove"
        @pointerup="onDragEnd"
        @pointercancel="onDragEnd"
      />
    </div>
  </section>
</template>

<style scoped>
.ac-dock {
  position: fixed;
  z-index: 40;
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  overflow: hidden;
  background: var(--md-sys-color-surface-container);
  border: 1px solid var(--md-sys-color-outline-variant);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.52);
  pointer-events: auto;
}

.ac-dock.animating {
  transition:
    width 0.24s cubic-bezier(0.2, 0, 0, 1),
    height 0.24s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.18s ease;
}

.ac-dock.hidden {
  visibility: hidden;
  pointer-events: none;
  left: -9999px !important;
}

.ac-dock-header {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 0 8px 0 10px;
  background: var(--md-sys-color-surface-container-high);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  cursor: move;
  touch-action: none;
  overflow: hidden;
}

.ac-dock-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-shrink: 1;
  font-size: 12px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ac-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--md-sys-color-error);
}

.ac-dot.ready {
  background: var(--md-sys-color-tertiary);
}

.ac-dock-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-shrink: 1;
}

.ac-dock-sliders {
  display: inline-grid;
  grid-template-columns: 1fr;
  min-width: 0;
  flex-shrink: 1;
  opacity: 1;
  transition:
    grid-template-columns 0.22s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.16s ease;
}

.ac-dock-sliders.closed {
  grid-template-columns: 0fr;
  opacity: 0;
  pointer-events: none;
}

.ac-dock-sliders-inner {
  overflow: hidden;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.ac-dock-btns {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.ac-mini-slider {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--md-sys-color-on-surface-variant);
  flex-shrink: 1;
  min-width: 0;
}

.ac-mini-slider input {
  width: 48px;
  accent-color: var(--md-sys-color-primary);
}

.ac-icon-btn {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--md-sys-color-on-surface);
  cursor: pointer;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

@media (hover: hover) {
  .ac-icon-btn:hover {
    background: var(--md-sys-color-surface-container-highest);
  }
}

.ac-dock-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--md-sys-color-surface-container);
  opacity: 1;
  transition: opacity 0.18s ease;
}

.ac-dock.collapsed .ac-dock-body {
  opacity: 0;
  pointer-events: none;
}

.ac-penpa-iframe {
  border: 0;
  display: block;
  background: var(--md-sys-color-surface-container);
}

.ac-resize-handle {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 18px;
  height: 18px;
  cursor: nwse-resize;
  touch-action: none;
  background: linear-gradient(
    135deg,
    transparent 50%,
    var(--md-sys-color-primary) 50%,
    var(--md-sys-color-primary) 65%,
    transparent 65%,
    transparent 78%,
    var(--md-sys-color-primary) 78%
  );
  opacity: 0.85;
}
</style>
