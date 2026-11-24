<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { BlendRenderMode } from '../core/webglOverlay';
import type { AlignTarget, QuadMode } from './PerspectiveOverlay.vue';
import type { RuntimePlatform } from '../core/platform';
import { loadPersistedState, patchPersistedState } from '../core/storage';
import { safeAreaInsets } from '../core/safeArea';

export type BackdropMode = 'overlay' | 'image' | 'screen';

const props = defineProps<{
  platform: RuntimePlatform;
  canNativeOverlay: boolean;
  canScreenCapture: boolean;
  backdropMode: BackdropMode;
  blendMode: BlendRenderMode;
  calibrating: boolean;
  alignTarget: AlignTarget;
  quadMode: QuadMode;
  opacity: number;
  dockVisible: boolean;
  clickThrough: boolean;
  hotkeyLabel?: string;
  hasScreenStream: boolean;
  hasImage: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:backdropMode', v: BackdropMode): void;
  (e: 'update:blendMode', v: BlendRenderMode): void;
  (e: 'update:calibrating', v: boolean): void;
  (e: 'update:alignTarget', v: AlignTarget): void;
  (e: 'update:quadMode', v: QuadMode): void;
  (e: 'update:opacity', v: number): void;
  (e: 'update:dockVisible', v: boolean): void;
  (e: 'update:clickThrough', v: boolean): void;
  (e: 'pick-image'): void;
  (e: 'start-screen-capture'): void;
  (e: 'stop-screen-capture'): void;
  (e: 'open-settings'): void;
  (e: 'close-overlay'): void;
  (e: 'bounds-change', rect: { x: number; y: number; w: number; h: number }): void;
}>();

const barEl = ref<HTMLElement | null>(null);
const savedBar = loadPersistedState().bar;
const compact = ref(savedBar?.compact ?? false);
const initSafe = safeAreaInsets.value;
const pos = ref({
  x:
    typeof savedBar?.xRatio === 'number'
      ? Math.max(
          initSafe.left + 4,
          Math.min(
            Math.max(initSafe.left + 4, window.innerWidth - initSafe.right - 100),
            savedBar.xRatio * window.innerWidth,
          ),
        )
      : initSafe.left + 8,
  y:
    typeof savedBar?.yRatio === 'number'
      ? Math.max(
          initSafe.top + 4,
          Math.min(
            Math.max(initSafe.top + 4, window.innerHeight - initSafe.bottom - 44),
            savedBar.yRatio * window.innerHeight,
          ),
        )
      : initSafe.top + 8,
});
const openMenu = ref<'align' | 'blend' | null>(null);

function persistBarState() {
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  patchPersistedState({
    bar: {
      xRatio: pos.value.x / vw,
      yRatio: pos.value.y / vh,
      compact: compact.value,
    },
  });
}

function getSafeDragLimits() {
  const safe = safeAreaInsets.value;
  const bw = barEl.value?.offsetWidth || 160;
  const bh = barEl.value?.offsetHeight || 40;
  const minX = safe.left + 4;
  const minY = safe.top + 4;
  const maxX = Math.max(minX, window.innerWidth - safe.right - Math.min(bw, Math.max(100, window.innerWidth - safe.left - safe.right - 8)));
  const maxY = Math.max(minY, window.innerHeight - safe.bottom - Math.min(bh, 44) - 4);
  return { minX, minY, maxX, maxY };
}

function clampBarToViewport() {
  const { minX, minY, maxX, maxY } = getSafeDragLimits();
  pos.value.x = Math.max(minX, Math.min(maxX, pos.value.x));
  pos.value.y = Math.max(minY, Math.min(maxY, pos.value.y));
  reportBounds();
}

const alignOptions: Array<{ value: AlignTarget; label: string }> = [
  { value: 'grid', label: '对齐:网格' },
  { value: 'canvas', label: '对齐:画布' },
];

const blendOptions: Array<{ value: BlendRenderMode; label: string }> = [
  { value: 'multiply', label: '正片叠底' },
  { value: 'multiply-inv', label: '正片叠底(反转)' },
  { value: 'alpha-luma', label: 'Alpha=1-亮度' },
  { value: 'alpha-luma-inv', label: 'Alpha=1-亮度(反转)' },
  { value: 'alpha-minrgb', label: '去白保色' },
  { value: 'alpha-minrgb-inv', label: '去白保色(反转)' },
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
  const { minX, minY, maxX, maxY } = getSafeDragLimits();
  pos.value.x = Math.max(minX, Math.min(maxX, dragStart.ox + dx));
  pos.value.y = Math.max(minY, Math.min(maxY, dragStart.oy + dy));
  reportBounds();
}

function onBarPointerUp(e: PointerEvent) {
  if (pointerId === null || e.pointerId !== pointerId) return;
  if (dragMoved) {
    barEl.value?.releasePointerCapture?.(e.pointerId);
    reportBounds();
    persistBarState();
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
  persistBarState();
  requestAnimationFrame(reportBounds);
}

watch(
  safeAreaInsets,
  () => {
    requestAnimationFrame(clampBarToViewport);
  },
  { deep: true },
);

watch(
  () => props.calibrating,
  (cal) => {
    if (!cal && openMenu.value === 'align') {
      openMenu.value = null;
    }
    requestAnimationFrame(reportBounds);
  },
);

let barResizeObserver: ResizeObserver | null = null;

onMounted(() => {
  requestAnimationFrame(clampBarToViewport);
  barResizeObserver = new ResizeObserver(reportBounds);
  if (barEl.value) barResizeObserver.observe(barEl.value);
  window.addEventListener('pointerdown', onGlobalPointerDown, true);
  window.addEventListener('resize', clampBarToViewport);
});

onBeforeUnmount(() => {
  barResizeObserver?.disconnect();
  window.removeEventListener('pointerdown', onGlobalPointerDown, true);
  window.removeEventListener('resize', clampBarToViewport);
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
    <!-- Row 1: Mode & Interaction controls (drag anywhere to move bar) -->
    <div class="ac-bar-row ac-row-main">
      <span class="ac-brand" title="拖动工具栏任意位置移动">⋮⋮</span>

      <div class="ac-anim-slot" :class="{ closed: compact }" :inert="compact">
        <div class="ac-anim-inner">
          <!-- Category 1: Backdrop Mode (Capsule Segmented Selector) -->
          <div class="ac-segmented" role="group" aria-label="底图模式">
            <button
              v-if="canNativeOverlay"
              class="ac-seg-btn"
              :class="{ active: backdropMode === 'overlay' }"
              @click="emit('update:backdropMode', 'overlay')"
            >
              叠加
            </button>
            <button
              class="ac-seg-btn"
              :class="{ active: backdropMode === 'image' }"
              @click="emit('update:backdropMode', 'image')"
            >
              图片
            </button>
            <button
              v-if="canScreenCapture"
              class="ac-seg-btn"
              :class="{ active: backdropMode === 'screen' }"
              @click="
                emit('update:backdropMode', 'screen');
                if (!hasScreenStream) emit('start-screen-capture');
              "
            >
              录屏
            </button>
          </div>

          <div
            class="ac-anim-slot"
            :class="{ closed: backdropMode !== 'image' }"
            :inert="backdropMode !== 'image'"
          >
            <div class="ac-anim-inner ac-gap-left">
              <button class="ac-btn tonal" @click="emit('pick-image')">
                {{ hasImage ? '换图' : '选图' }}
              </button>
            </div>
          </div>

          <div
            class="ac-anim-slot"
            :class="{ closed: backdropMode !== 'screen' }"
            :inert="backdropMode !== 'screen'"
          >
            <div class="ac-anim-inner ac-gap-left">
              <button
                class="ac-btn"
                :class="hasScreenStream ? 'danger' : 'tonal'"
                @click="hasScreenStream ? emit('stop-screen-capture') : emit('start-screen-capture')"
              >
                {{ hasScreenStream ? '停止' : '捕获' }}
              </button>
            </div>
          </div>

          <span class="ac-sep" aria-hidden="true" />

          <!-- Category 2: Interaction & Dock -->
          <button
            class="ac-btn"
            :class="{ active: calibrating }"
            @click="emit('update:calibrating', !calibrating)"
          >
            {{ calibrating ? '去画图' : '调四点' }}
          </button>

          <button
            class="ac-btn ac-gap-left"
            :class="{ active: dockVisible }"
            @click="emit('update:dockVisible', !dockVisible)"
          >
            {{ dockVisible ? '藏工具' : '工具' }}
          </button>

          <div
            v-if="canNativeOverlay"
            class="ac-anim-slot"
            :class="{ closed: backdropMode !== 'overlay' }"
            :inert="backdropMode !== 'overlay'"
          >
            <div class="ac-anim-inner ac-gap-left">
              <button
                class="ac-btn"
                :class="{ danger: clickThrough }"
                :title="`锁定题板与工具窗穿透到底层应用${hotkeyLabel && hotkeyLabel !== '未绑定' ? ` (${hotkeyLabel})` : ''}`"
                @click="emit('update:clickThrough', !clickThrough)"
              >
                {{ clickThrough ? '穿透中' : '穿透' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Row 2: Calibration Alignment (only in calibrating mode) & Blend/Opacity -->
    <div class="ac-anim-slot ac-row-render-slot" :class="{ closed: compact }" :inert="compact">
      <div class="ac-anim-inner">
        <span class="ac-sep ac-sep-desktop" aria-hidden="true" />

        <div class="ac-bar-row ac-row-render">
          <!-- Category 3: Alignment & Rect/Free Mode (ONLY shown while calibrating) -->
          <div class="ac-anim-slot" :class="{ closed: !calibrating }" :inert="!calibrating">
            <div class="ac-anim-inner">
              <button
                class="ac-btn ac-dropdown-trigger"
                :class="{ active: openMenu === 'align' }"
                @click="toggleMenu('align')"
              >
                <span>{{ currentAlignLabel }}</span>
                <span class="ac-caret">▾</span>
              </button>

              <div
                class="ac-segmented ac-gap-left"
                role="group"
                aria-label="拖拽几何模式"
                title="切换矩形/自由模式时自动重置四角"
              >
                <button
                  class="ac-seg-btn"
                  :class="{ active: quadMode === 'rect' }"
                  @click="emit('update:quadMode', 'rect')"
                >
                  矩形
                </button>
                <button
                  class="ac-seg-btn"
                  :class="{ active: quadMode === 'free' }"
                  @click="emit('update:quadMode', 'free')"
                >
                  自由
                </button>
              </div>

              <span class="ac-sep" aria-hidden="true" />
            </div>
          </div>

          <!-- Category 4: Blend Mode & Opacity -->
          <button
            class="ac-btn ac-dropdown-trigger"
            :class="{ active: openMenu === 'blend' }"
            @click="toggleMenu('blend')"
          >
            <span>{{ currentBlendLabel }}</span>
            <span class="ac-caret">▾</span>
          </button>

          <label class="ac-opacity-box ac-gap-left" title="题板叠加不透明度">
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
      </div>
    </div>

    <!-- Category 5: System Actions (Settings / Exit / Collapse) -->
    <div class="ac-bar-row ac-row-sys">
      <div class="ac-anim-slot" :class="{ closed: compact }" :inert="compact">
        <div class="ac-anim-inner">
          <span class="ac-sep" aria-hidden="true" />
          <button class="ac-btn" title="自定义 CSS 与快捷键设置" @click="emit('open-settings')">
            设置
          </button>

          <button
            v-if="platform === 'tauri' || platform === 'android-overlay' || platform === 'android-app'"
            class="ac-btn danger ac-gap-left"
            :title="platform === 'android-app' ? '返回主界面' : '退出叠加层'"
            @click="emit('close-overlay')"
          >
            退出
          </button>
        </div>
      </div>

      <button
        class="ac-btn ac-gap-left"
        :title="compact ? '展开控制条' : '收起控制条'"
        @click="toggleCompact"
      >
        {{ compact ? '展开' : '收起' }}
      </button>
    </div>

    <!-- Pure-DOM MD3 inline option strip with smooth vertical collapse animation -->
    <div class="ac-popover-wrap" :class="{ open: !compact && openMenu !== null }">
      <div class="ac-popover-inner">
        <div v-if="openMenu === 'align'" class="ac-popover-row">
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

        <div v-else-if="openMenu === 'blend'" class="ac-popover-row">
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
      </div>
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
  gap: 0;
  max-width: calc(100vw - var(--ac-safe-left, 0px) - var(--ac-safe-right, 0px) - 16px);
  padding: 6px 10px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--md-sys-color-surface-container) 92%, transparent);
  border: 1px solid var(--md-sys-color-outline-variant);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(12px);
  pointer-events: auto;
  cursor: move;
  touch-action: none;
  transition: border-radius 0.22s cubic-bezier(0.2, 0, 0, 1), padding 0.22s cubic-bezier(0.2, 0, 0, 1);
}

.ac-bar-row {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 0;
  max-width: 100%;
}

/* Smooth MD3 horizontal collapse/expand slot for dynamic toolbar items */
.ac-anim-slot {
  display: inline-grid;
  grid-template-columns: 1fr;
  align-items: center;
  opacity: 1;
  transition:
    grid-template-columns 0.24s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.18s cubic-bezier(0.2, 0, 0, 1);
}

.ac-anim-slot.closed {
  grid-template-columns: 0fr;
  opacity: 0;
  pointer-events: none;
}

.ac-anim-inner {
  overflow: hidden;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}

.ac-gap-left {
  margin-left: 5px;
}

.ac-sep {
  display: inline-block;
  width: 1px;
  height: 16px;
  margin: 0 7px;
  background: var(--md-sys-color-outline-variant);
  opacity: 0.9;
  flex-shrink: 0;
  align-self: center;
}

.ac-popover-wrap {
  width: 100%;
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition:
    grid-template-rows 0.2s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.16s ease,
    margin-top 0.2s cubic-bezier(0.2, 0, 0, 1);
}

.ac-popover-wrap.open {
  grid-template-rows: 1fr;
  opacity: 1;
  margin-top: 6px;
}

.ac-popover-inner {
  overflow: hidden;
  min-height: 0;
}

.ac-segmented {
  display: inline-flex;
  align-items: stretch;
  height: 30px;
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
  padding: 0 10px;
  border: none;
  border-right: 1px solid var(--md-sys-color-outline-variant);
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease;
}

.ac-seg-btn:last-child {
  border-right: none;
}

@media (hover: hover) {
  .ac-seg-btn:hover {
    background: var(--md-sys-color-surface-container-highest);
    color: var(--md-sys-color-on-surface);
  }
}

.ac-seg-btn.active {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  font-weight: 600;
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
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    width: auto;
    max-width: calc(100vw - var(--ac-safe-left, 0px) - var(--ac-safe-right, 0px) - 12px);
    padding: 5px 7px;
    row-gap: 5px;
    border-radius: 14px;
  }

  .ac-bar-row {
    flex-wrap: wrap;
    row-gap: 4px;
  }

  .ac-row-main {
    order: 1;
  }

  .ac-row-sys {
    order: 2;
  }

  .ac-row-render-slot {
    order: 3;
    width: 100%;
  }

  .ac-row-render-slot.closed {
    display: none;
  }

  .ac-popover-wrap {
    order: 4;
  }

  .ac-gap-left {
    margin-left: 4px;
  }

  .ac-sep {
    height: 14px;
    margin: 0 5px;
  }

  .ac-sep-desktop {
    display: none;
  }

  .ac-control-bar :deep(.ac-btn) {
    height: 26px;
    padding: 0 7px;
    font-size: 11px;
    flex-shrink: 0;
  }

  .ac-segmented {
    height: 26px;
  }

  .ac-seg-btn {
    padding: 0 7px;
    font-size: 11px;
  }

  .ac-opacity-box input {
    width: 58px;
  }
}
</style>
