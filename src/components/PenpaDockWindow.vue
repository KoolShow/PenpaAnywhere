<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getPenpaBridge, type PenpaIframeBridge } from '../core/penpaBridge';
import type { BlendRenderMode } from '../core/webglOverlay';
import type { WorkspaceMode } from '../core/world';
import type { UnavailableReasonKey } from './ControlBar.vue';
import { loadPersistedState, patchPersistedState } from '../core/storage';
import { safeAreaInsets } from '../core/safeArea';
import { messages } from '../core/i18n';
import { beginGlobalDrag, endGlobalDrag, tryCapturePointer, tryReleasePointer } from '../core/dragGuard';
import MdIcon from './MdIcon.vue';
import MdSlider from './MdSlider.vue';

const props = defineProps<{
  visible: boolean;
  title?: string;
  backdropMode: WorkspaceMode;
  blendMode: BlendRenderMode;
  boardOpacity: number;
  enhanceOpacity: boolean;
  showUnavailableOptions: boolean;
}>();

const emit = defineEmits<{
  (e: 'bridge-ready', bridge: PenpaIframeBridge): void;
  (e: 'update:visible', value: boolean): void;
  (e: 'update:blendMode', value: BlendRenderMode): void;
  (e: 'update:boardOpacity', value: number): void;
  (e: 'update:enhanceOpacity', value: boolean): void;
  (e: 'unavailable-click', key: UnavailableReasonKey): void;
  (e: 'bounds-change', rect: { x: number; y: number; w: number; h: number }): void;
}>();

const blendMenuOpen = ref(false);

const blendOptions = computed<Array<{ value: BlendRenderMode; label: string; unavailable: boolean }>>(() => {
  const isOverlay = props.backdropMode === 'overlay';
  return [
    { value: 'multiply', label: messages.value.bar.blendMultiply, unavailable: isOverlay },
    { value: 'multiply-inv', label: messages.value.bar.blendMultiplyInv, unavailable: isOverlay },
    { value: 'alpha-luma', label: messages.value.bar.blendAlphaLuma, unavailable: false },
    { value: 'alpha-luma-inv', label: messages.value.bar.blendAlphaLumaInv, unavailable: false },
    { value: 'alpha-minrgb', label: messages.value.bar.blendAlphaMinRgb, unavailable: false },
    { value: 'alpha-minrgb-inv', label: messages.value.bar.blendAlphaMinRgbInv, unavailable: false },
  ];
});

const visibleBlendOptions = computed(() =>
  blendOptions.value.filter((opt) => !opt.unavailable || props.showUnavailableOptions),
);

const currentBlendLabel = computed(
  () => blendOptions.value.find((o) => o.value === props.blendMode)?.label ?? messages.value.bar.blendAlphaMinRgb,
);

function selectBlend(opt: { value: BlendRenderMode; unavailable: boolean }) {
  if (opt.unavailable) {
    blendMenuOpen.value = false;
    emit('unavailable-click', 'multiplyOverlay');
    return;
  }
  emit('update:blendMode', opt.value);
  blendMenuOpen.value = false;
}

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

let dragMode: 'move' | 'resize' | null = null;
let dragPointerId: number | null = null;
let dragCapturedEl: Element | null = null;
let dragStart = { x: 0, y: 0, origX: 0, origY: 0, origW: 0, origH: 0 };

function finishDockDrag(persist: boolean) {
  if (!dragMode) return;
  if (dragPointerId !== null) {
    tryReleasePointer(dragCapturedEl, dragPointerId);
  }
  dragMode = null;
  dragPointerId = null;
  dragCapturedEl = null;
  isInteracting.value = false;
  endGlobalDrag();
  if (persist) persistDockState();
}

function startMove(e: PointerEvent) {
  if ((e.target as HTMLElement).closest('button, input, .ac-md-slider')) return;
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  e.preventDefault();
  if (dragMode) finishDockDrag(false);
  dragMode = 'move';
  dragPointerId = e.pointerId;
  isInteracting.value = true;
  dragStart = {
    x: e.clientX,
    y: e.clientY,
    origX: pos.value.x,
    origY: pos.value.y,
    origW: size.value.w,
    origH: size.value.h,
  };
  dragCapturedEl = tryCapturePointer(e.currentTarget as HTMLElement, e.pointerId);
  beginGlobalDrag();
}

function startResize(e: PointerEvent) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  e.preventDefault();
  e.stopPropagation();
  if (dragMode) finishDockDrag(false);
  dragMode = 'resize';
  dragPointerId = e.pointerId;
  isInteracting.value = true;
  dragStart = {
    x: e.clientX,
    y: e.clientY,
    origX: pos.value.x,
    origY: pos.value.y,
    origW: size.value.w,
    origH: size.value.h,
  };
  dragCapturedEl = tryCapturePointer(e.currentTarget as HTMLElement, e.pointerId);
  beginGlobalDrag();
}

function onDragMove(e: PointerEvent) {
  if (!dragMode || (dragPointerId !== null && e.pointerId !== dragPointerId)) return;
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
  if (!dragMode || (dragPointerId !== null && e.pointerId !== dragPointerId)) return;
  finishDockDrag(true);
}

function onWindowDockBlur() {
  finishDockDrag(true);
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
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
  window.addEventListener('blur', onWindowDockBlur);
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
  finishDockDrag(false);
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  window.removeEventListener('blur', onWindowDockBlur);
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
    >
      <div class="ac-dock-title">
        <span class="ac-dot" :class="{ ready: readyState }" />
        <span>{{ title || 'Penpa+' }}</span>
      </div>
      <div class="ac-dock-actions">
        <div class="ac-dock-sliders" :class="{ closed: collapsed }" :inert="collapsed">
          <div class="ac-dock-sliders-inner">
            <label class="ac-mini-slider" :title="messages.dock.zoomTitle">
              <span>{{ messages.dock.zoom }}</span>
              <MdSlider
                v-model="scale"
                :min="0.5"
                :max="1.15"
                :step="0.05"
                width="54px"
                :aria-label="messages.dock.zoomTitle"
              />
            </label>
            <label class="ac-mini-slider" :title="messages.dock.opacityTitle">
              <span>{{ messages.dock.opacity }}</span>
              <MdSlider
                v-model="dockOpacity"
                :min="0.35"
                :max="1"
                :step="0.05"
                width="54px"
                :aria-label="messages.dock.opacityTitle"
              />
            </label>
          </div>
        </div>
        <div class="ac-dock-btns">
          <button
            class="ac-icon-btn xs"
            :title="collapsed ? messages.dock.expand : messages.dock.collapse"
            :aria-label="collapsed ? messages.dock.expand : messages.dock.collapse"
            @click="toggleCollapsed"
          >
            <MdIcon :name="collapsed ? 'keyboard_arrow_down' : 'keyboard_arrow_up'" :size="18" />
          </button>
          <button
            class="ac-icon-btn xs"
            :title="messages.dock.hide"
            :aria-label="messages.dock.hide"
            @click="emit('update:visible', false)"
          >
            <MdIcon name="close" :size="16" />
          </button>
        </div>
      </div>
    </header>

    <!-- Per-grid render settings sub-bar (Blend mode & Board opacity, isolated per Penpa+ instance) -->
    <div v-if="!collapsed" class="ac-dock-render-bar">
      <div class="ac-dock-render-row">
        <button
          class="ac-btn ac-dock-blend-btn"
          :class="{ active: blendMenuOpen }"
          :title="messages.dock.boardBlendTitle"
          @click="blendMenuOpen = !blendMenuOpen"
        >
          <MdIcon name="contrast" :size="15" />
          <span>{{ currentBlendLabel }}</span>
        </button>

        <div class="ac-dock-render-controls">
          <div class="ac-enhance-opacity-box" :title="messages.dock.enhanceOpacityTitle">
            <span>{{ messages.dock.enhanceOpacity }}</span>
            <button
              type="button"
              role="switch"
              class="ac-md3-switch-sm"
              :class="{ checked: enhanceOpacity }"
              :aria-checked="enhanceOpacity"
              :aria-label="messages.dock.enhanceOpacity"
              @click="emit('update:enhanceOpacity', !enhanceOpacity)"
            >
              <span class="ac-md3-switch-sm-thumb">
                <MdIcon v-if="enhanceOpacity" name="check" :size="10" />
              </span>
            </button>
          </div>

          <label class="ac-board-opacity-box" :title="messages.dock.boardOpacityTitle">
            <span>{{ messages.dock.boardOpacity }} {{ Math.round(boardOpacity * 100) }}%</span>
            <MdSlider
              :model-value="boardOpacity"
              :min="0.1"
              :max="1"
              :step="0.02"
              width="86px"
              :aria-label="messages.dock.boardOpacityTitle"
              @update:model-value="emit('update:boardOpacity', $event)"
            />
          </label>
        </div>
      </div>

      <div v-if="blendMenuOpen" class="ac-dock-blend-popover">
        <button
          v-for="opt in visibleBlendOptions"
          :key="opt.value"
          class="ac-btn"
          :class="{ active: !opt.unavailable && blendMode === opt.value, unavailable: opt.unavailable }"
          @click="selectBlend(opt)"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

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
      />
    </div>
  </section>
</template>

<style scoped>
.ac-dock {
  position: fixed;
  z-index: 1100;
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
  line-height: 1;
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
  padding: 3px 2px;
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
  gap: 5px;
  font-size: 11px;
  line-height: 1;
  color: var(--md-sys-color-on-surface-variant);
  flex-shrink: 1;
  min-width: 0;
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

.ac-dock-render-bar {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 5px 10px;
  background: var(--md-sys-color-surface-container-low);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.ac-dock-render-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ac-dock-blend-btn {
  height: 26px;
  padding: 0 10px;
  font-size: 11px;
}

.ac-dock-render-controls {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.ac-enhance-opacity-box {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  line-height: 1;
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
}

.ac-board-opacity-box {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  line-height: 1;
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
}

.ac-dock-blend-popover {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  padding-top: 5px;
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.ac-dock-blend-popover .ac-btn {
  height: 24px;
  padding: 0 9px;
  font-size: 11px;
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
