<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getPenpaBridge, type PenpaIframeBridge } from '../core/penpaBridge';

const props = defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: 'bridge-ready', bridge: PenpaIframeBridge): void;
  (e: 'update:visible', value: boolean): void;
  (e: 'bounds-change', rect: { x: number; y: number; w: number; h: number }): void;
}>();

const iframeEl = ref<HTMLIFrameElement | null>(null);
const collapsed = ref(false);
const dockOpacity = ref(0.96);
const scale = ref(1);
const readyState = ref(false);

// Default floating tool window size fits Penpa+ native 600px #buttons with zero layout distortion
const pos = ref({ x: 20, y: 64 });
const size = ref({ w: 660, h: 420 });

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
    w: collapsed.value ? 260 : size.value.w,
    h: collapsed.value ? 36 : size.value.h,
  });
}

function clampPosition() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const effectiveW = Math.min(size.value.w, Math.max(300, vw - 16));
  const effectiveH = Math.min(size.value.h, Math.max(220, vh - 80));
  if (vw < 700) {
    size.value.w = vw - 16;
    size.value.h = Math.min(300, Math.round(vh * 0.36));
    scale.value = Math.max(0.52, Math.min(1, (size.value.w - 14) / 640));
    pos.value.x = 8;
    pos.value.y = Math.max(64, vh - size.value.h - 24);
  } else {
    size.value.w = effectiveW;
    size.value.h = effectiveH;
    pos.value.x = Math.max(8, Math.min(vw - 120, pos.value.x));
    pos.value.y = Math.max(48, Math.min(vh - 48, pos.value.y));
  }
  emitBounds();
}

function startMove(e: PointerEvent) {
  if ((e.target as HTMLElement).closest('button, input')) return;
  e.preventDefault();
  dragMode = 'move';
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
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  if (dragMode === 'move') {
    pos.value.x = Math.max(0, Math.min(window.innerWidth - 100, dragStart.origX + dx));
    pos.value.y = Math.max(0, Math.min(window.innerHeight - 36, dragStart.origY + dy));
  } else {
    size.value.w = Math.max(320, Math.min(window.innerWidth - pos.value.x, dragStart.origW + dx));
    size.value.h = Math.max(200, Math.min(window.innerHeight - pos.value.y, dragStart.origH + dy));
  }
  emitBounds();
}

function onDragEnd(e: PointerEvent) {
  if (!dragMode) return;
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  dragMode = null;
}

function toggleCollapsed() {
  collapsed.value = !collapsed.value;
  emitBounds();
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

onMounted(() => {
  clampPosition();
  window.addEventListener('resize', clampPosition);
});

watch(
  () => props.visible,
  () => {
    emitBounds();
  },
);

onBeforeUnmount(() => {
  window.removeEventListener('resize', clampPosition);
  if (pollTimer) window.clearInterval(pollTimer);
});
</script>

<template>
  <!-- Keep mounted even when hidden so Penpa+ state & canvas never reset -->
  <section
    class="ac-dock"
    :class="{ collapsed, hidden: !visible }"
    :style="{
      left: `${pos.x}px`,
      top: `${pos.y}px`,
      width: collapsed ? '260px' : `${size.w}px`,
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
        <span>Penpa+ 工具与模式窗</span>
      </div>
      <div class="ac-dock-actions">
        <label class="ac-mini-slider" title="悬浮窗缩放">
          <span>缩放</span>
          <input
            v-model.number="scale"
            type="range"
            min="0.5"
            max="1.15"
            step="0.05"
          />
        </label>
        <label class="ac-mini-slider" title="悬浮窗透明度">
          <span>透明</span>
          <input
            v-model.number="dockOpacity"
            type="range"
            min="0.35"
            max="1"
            step="0.05"
          />
        </label>
        <button class="ac-icon-btn" :title="collapsed ? '展开' : '折叠'" @click="toggleCollapsed">
          {{ collapsed ? '▢' : '—' }}
        </button>
        <button class="ac-icon-btn" title="隐藏工具窗" @click="emit('update:visible', false)">
          ✕
        </button>
      </div>
    </header>

    <div class="ac-dock-body">
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
        title="拖动调整悬浮窗大小"
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
  gap: 8px;
  padding: 0 10px;
  background: var(--md-sys-color-surface-container-high);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  cursor: move;
  touch-action: none;
}

.ac-dock-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface);
  white-space: nowrap;
}

.ac-dot {
  width: 8px;
  height: 8px;
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
}

.ac-mini-slider {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--md-sys-color-on-surface-variant);
}

.ac-mini-slider input {
  width: 52px;
  accent-color: var(--md-sys-color-primary);
}

.ac-icon-btn {
  width: 24px;
  height: 24px;
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

.ac-icon-btn:hover {
  background: var(--md-sys-color-surface-container-highest);
}

.ac-dock-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #ffffff;
}

.ac-dock.collapsed .ac-dock-body {
  visibility: hidden;
  height: 0;
}

.ac-penpa-iframe {
  border: 0;
  display: block;
  background: #ffffff;
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
