<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { BlendRenderMode } from '../core/webglOverlay';
import type { AlignTarget } from './PerspectiveOverlay.vue';
import type { RuntimePlatform } from '../core/platform';

export type BackdropMode = 'overlay' | 'image' | 'screen';

const props = defineProps<{
  platform: RuntimePlatform;
  canNativeOverlay: boolean;
  canScreenCapture: boolean;
  backdropMode: BackdropMode;
  blendMode: BlendRenderMode;
  calibrating: boolean;
  alignTarget: AlignTarget;
  opacity: number;
  dockVisible: boolean;
  clickThrough: boolean;
  hasScreenStream: boolean;
  hasImage: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:backdropMode', v: BackdropMode): void;
  (e: 'update:blendMode', v: BlendRenderMode): void;
  (e: 'update:calibrating', v: boolean): void;
  (e: 'update:alignTarget', v: AlignTarget): void;
  (e: 'update:opacity', v: number): void;
  (e: 'update:dockVisible', v: boolean): void;
  (e: 'update:clickThrough', v: boolean): void;
  (e: 'pick-image'): void;
  (e: 'start-screen-capture'): void;
  (e: 'stop-screen-capture'): void;
  (e: 'reset-corners'): void;
  (e: 'close-overlay'): void;
  (e: 'bounds-change', rect: { x: number; y: number; w: number; h: number }): void;
}>();

const barEl = ref<HTMLElement | null>(null);
const compact = ref(false);
const pos = ref({ x: 8, y: window.innerHeight > window.innerWidth ? 36 : 10 });
const openMenu = ref<'align' | 'blend' | null>(null);

const alignOptions: Array<{ value: AlignTarget; label: string }> = [
  { value: 'grid', label: '对齐:网格' },
  { value: 'canvas', label: '对齐:画布' },
];

const blendOptions: Array<{ value: BlendRenderMode; label: string }> = [
  { value: 'multiply', label: '正片叠底' },
  { value: 'alpha-luma', label: 'Alpha=1-亮度' },
  { value: 'alpha-minrgb', label: '去白保色' },
];

const currentAlignLabel = computed(
  () => alignOptions.find((o) => o.value === props.alignTarget)?.label ?? '对齐:网格',
);

const currentBlendLabel = computed(
  () => blendOptions.find((o) => o.value === props.blendMode)?.label ?? 'Alpha=1-亮度',
);

// Universal drag from ANY area of the toolbar (including interactive buttons),
// while preserving normal button taps (movement <= 8px) and range slider input.
const DRAG_THRESHOLD_PX = 8;
let pointerId: number | null = null;
let dragMoved = false;
let suppressNextClick = false;
let dragStart = { x: 0, y: 0, ox: 0, oy: 0 };

function reportBounds() {
  if (!barEl.value) return;
  const r = barEl.value.getBoundingClientRect();
  emit('bounds-change', { x: r.left, y: r.top, w: r.width, h: r.height });
}

function toggleMenu(name: 'align' | 'blend') {
  openMenu.value = openMenu.value === name ? null : name;
  requestAnimationFrame(reportBounds);
}

function selectAlign(val: AlignTarget) {
  emit('update:alignTarget', val);
  openMenu.value = null;
  requestAnimationFrame(reportBounds);
}

function selectBlend(val: BlendRenderMode) {
  emit('update:blendMode', val);
  openMenu.value = null;
  requestAnimationFrame(reportBounds);
}

function onGlobalPointerDown(e: PointerEvent) {
  if (!openMenu.value) return;
  if (barEl.value && !barEl.value.contains(e.target as Node)) {
    openMenu.value = null;
    requestAnimationFrame(reportBounds);
  }
}

function onBarPointerDown(e: PointerEvent) {
  // Keep range slider draggable for opacity adjustment
  const target = e.target as HTMLElement | null;
  if (target?.closest('input[type="range"]')) return;
  if (e.button !== 0 && e.pointerType === 'mouse') return;

  pointerId = e.pointerId;
  dragMoved = false;
  dragStart = { x: e.clientX, y: e.clientY, ox: pos.value.x, oy: pos.value.y };
}

function onBarPointerMove(e: PointerEvent) {
  if (pointerId === null || e.pointerId !== pointerId) return;
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;

  if (!dragMoved) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    dragMoved = true;
    suppressNextClick = true;
    barEl.value?.setPointerCapture?.(e.pointerId);
  }

  e.preventDefault();
  const bw = barEl.value?.offsetWidth || 160;
  const bh = barEl.value?.offsetHeight || 40;
  const maxX = Math.max(4, window.innerWidth - Math.min(bw, 100));
  const maxY = Math.max(4, window.innerHeight - Math.min(bh, 44));
  pos.value.x = Math.max(4, Math.min(maxX, dragStart.ox + dx));
  pos.value.y = Math.max(4, Math.min(maxY, dragStart.oy + dy));
  reportBounds();
}

function onBarPointerUp(e: PointerEvent) {
  if (pointerId === null || e.pointerId !== pointerId) return;
  if (dragMoved) {
    barEl.value?.releasePointerCapture?.(e.pointerId);
    reportBounds();
    window.setTimeout(() => {
      suppressNextClick = false;
    }, 80);
  }
  pointerId = null;
  dragMoved = false;
}

function onBarClickCapture(e: MouseEvent) {
  if (suppressNextClick) {
    e.preventDefault();
    e.stopPropagation();
    suppressNextClick = false;
  }
}

function toggleCompact() {
  compact.value = !compact.value;
  openMenu.value = null;
  requestAnimationFrame(reportBounds);
}

onMounted(() => {
  requestAnimationFrame(reportBounds);
  const ro = new ResizeObserver(reportBounds);
  if (barEl.value) ro.observe(barEl.value);
  window.addEventListener('pointerdown', onGlobalPointerDown, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onGlobalPointerDown, true);
});
</script>

<template>
  <nav
    ref="barEl"
    class="ac-control-bar"
    :class="{ compact }"
    :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
    @pointerdown="onBarPointerDown"
    @pointermove="onBarPointerMove"
    @pointerup="onBarPointerUp"
    @pointercancel="onBarPointerUp"
    @click.capture="onBarClickCapture"
  >
    <!-- Row 1: Primary controls (fits cleanly on narrow mobile screens; drag anywhere to move bar) -->
    <div class="ac-bar-row">
      <span class="ac-brand" title="拖动工具栏任意位置移动">⋮⋮</span>

      <template v-if="!compact">
        <button
          v-if="canNativeOverlay"
          class="ac-btn"
          :class="{ active: backdropMode === 'overlay' }"
          @click="emit('update:backdropMode', 'overlay')"
        >
          叠加
        </button>
        <button
          class="ac-btn"
          :class="{ active: backdropMode === 'image' }"
          @click="emit('update:backdropMode', 'image')"
        >
          图片
        </button>
        <button
          v-if="canScreenCapture"
          class="ac-btn"
          :class="{ active: backdropMode === 'screen' }"
          @click="
            emit('update:backdropMode', 'screen');
            if (!hasScreenStream) emit('start-screen-capture');
          "
        >
          录屏
        </button>

        <button
          v-if="backdropMode === 'image'"
          class="ac-btn tonal"
          @click="emit('pick-image')"
        >
          {{ hasImage ? '换图' : '选图' }}
        </button>
        <button
          v-if="backdropMode === 'screen'"
          class="ac-btn"
          :class="hasScreenStream ? 'danger' : 'tonal'"
          @click="hasScreenStream ? emit('stop-screen-capture') : emit('start-screen-capture')"
        >
          {{ hasScreenStream ? '停止' : '捕获' }}
        </button>

        <button
          class="ac-btn"
          :class="{ active: calibrating }"
          @click="emit('update:calibrating', !calibrating)"
        >
          {{ calibrating ? '去画图' : '调四点' }}
        </button>

        <button
          class="ac-btn"
          :class="{ active: dockVisible }"
          @click="emit('update:dockVisible', !dockVisible)"
        >
          {{ dockVisible ? '藏工具' : '工具' }}
        </button>

        <button
          v-if="canNativeOverlay && backdropMode === 'overlay'"
          class="ac-btn"
          :class="{ danger: clickThrough }"
          title="锁定题板与工具窗穿透到底层应用"
          @click="emit('update:clickThrough', !clickThrough)"
        >
          {{ clickThrough ? '穿透中' : '穿透' }}
        </button>

        <button
          v-if="platform === 'tauri' || platform === 'android-overlay'"
          class="ac-btn danger"
          title="退出叠加层"
          @click="emit('close-overlay')"
        >
          退出
        </button>
      </template>

      <button class="ac-btn" :title="compact ? '展开控制条' : '收起控制条'" @click="toggleCompact">
        {{ compact ? '展开' : '收起' }}
      </button>
    </div>

    <!-- Row 2: Alignment, Reset, Blend Mode, Opacity -->
    <div v-if="!compact" class="ac-bar-row">
      <button
        class="ac-btn ac-dropdown-trigger"
        :class="{ active: openMenu === 'align' }"
        @click="toggleMenu('align')"
      >
        <span>{{ currentAlignLabel }}</span>
        <span class="ac-caret">▾</span>
      </button>

      <button class="ac-btn" title="重置四控制点" @click="emit('reset-corners')">
        重置四角
      </button>

      <button
        class="ac-btn ac-dropdown-trigger"
        :class="{ active: openMenu === 'blend' }"
        @click="toggleMenu('blend')"
      >
        <span>{{ currentBlendLabel }}</span>
        <span class="ac-caret">▾</span>
      </button>

      <label class="ac-opacity-box" title="题板叠加不透明度">
        <span>{{ Math.round(opacity * 100) }}%</span>
        <input
          type="range"
          min="0.1"
          max="1"
          step="0.02"
          :value="opacity"
          @input="emit('update:opacity', parseFloat(($event.target as HTMLInputElement).value))"
        />
      </label>
    </div>

    <!-- Pure-DOM MD3 inline option strip -->
    <div v-if="!compact && openMenu === 'align'" class="ac-popover-row">
      <button
        v-for="opt in alignOptions"
        :key="opt.value"
        class="ac-btn"
        :class="{ active: alignTarget === opt.value }"
        @click="selectAlign(opt.value)"
      >
        {{ opt.label }}
      </button>
    </div>

    <div v-if="!compact && openMenu === 'blend'" class="ac-popover-row">
      <button
        v-for="opt in blendOptions"
        :key="opt.value"
        class="ac-btn"
        :class="{ active: blendMode === opt.value }"
        @click="selectBlend(opt.value)"
      >
        {{ opt.label }}
      </button>
    </div>
  </nav>
</template>

<style scoped>
.ac-control-bar {
  position: fixed;
  z-index: 60;
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  max-width: calc(100vw - 16px);
  padding: 6px 10px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--md-sys-color-surface-container) 92%, transparent);
  border: 1px solid var(--md-sys-color-outline-variant);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(12px);
  pointer-events: auto;
  cursor: move;
  touch-action: none;
}

.ac-bar-row {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 5px;
  max-width: 100%;
}

.ac-popover-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding-top: 4px;
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.ac-dropdown-trigger {
  gap: 4px;
}

.ac-caret {
  font-size: 10px;
  opacity: 0.85;
}

.ac-brand {
  font-size: 13px;
  font-weight: 700;
  color: var(--md-sys-color-primary);
  padding: 0 3px;
  user-select: none;
  white-space: nowrap;
  flex-shrink: 0;
}

.ac-opacity-box {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
  flex-shrink: 0;
}

.ac-opacity-box input {
  width: 64px;
  accent-color: var(--md-sys-color-primary);
  touch-action: pan-x;
}

@media (max-width: 760px) {
  .ac-control-bar {
    flex-direction: column;
    align-items: stretch;
    width: auto;
    max-width: calc(100vw - 12px);
    padding: 5px 7px;
    gap: 5px;
    border-radius: 14px;
  }

  .ac-bar-row {
    flex-wrap: wrap;
    gap: 4px;
  }

  .ac-control-bar :deep(.ac-btn) {
    height: 26px;
    padding: 0 7px;
    font-size: 11px;
    flex-shrink: 0;
  }

  .ac-opacity-box input {
    width: 58px;
  }
}
</style>
