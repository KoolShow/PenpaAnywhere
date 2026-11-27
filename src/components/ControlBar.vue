<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { RuntimePlatform } from '../core/platform';
import type { WorkspaceMode } from '../core/world';
import type { WorldElement } from '../core/canvasItems';
import { loadPersistedState, patchPersistedState } from '../core/storage';
import { safeAreaInsets } from '../core/safeArea';
import { currentLocale, messages } from '../core/i18n';
import { beginGlobalDrag, endGlobalDrag, tryCapturePointer, tryReleasePointer } from '../core/dragGuard';

export type BackdropMode = WorkspaceMode;
export type UnavailableReasonKey =
  | 'multiplyOverlay'
  | 'overlayWeb'
  | 'screenUnsupported'
  | 'clickThroughUnavailable'
  | 'androidShotUnavailable'
  | 'dynamicColorUnavailable'
  | 'penpaCloneUnsupported';

const props = defineProps<{
  platform: RuntimePlatform;
  canSwitchOverlay: boolean;
  canScreenCapture: boolean;
  canPinWindow: boolean;
  alwaysOnTop: boolean;
  fullCanvasEnabled: boolean;
  backdropMode: WorkspaceMode;
  layersVisible: boolean;
  elements: WorldElement[];
  selectedId: string | null;
  showUnavailableOptions: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:backdropMode', v: WorkspaceMode): void;
  (e: 'update:layersVisible', v: boolean): void;
  (e: 'update:alwaysOnTop', v: boolean): void;
  (e: 'unavailable-click', key: UnavailableReasonKey): void;
  (e: 'add-image'): void;
  (e: 'add-screen'): void;
  (e: 'select-element', id: string): void;
  (e: 'toggle-visible', id: string): void;
  (e: 'toggle-lock', id: string): void;
  (e: 'toggle-passthrough', id: string): void;
  (e: 'toggle-dock', id: string): void;
  (e: 'move-up', id: string): void;
  (e: 'move-down', id: string): void;
  (e: 'remove-element', id: string): void;
  (e: 'open-settings'): void;
  (e: 'close-overlay'): void;
  (e: 'bounds-change', rect: { x: number; y: number; w: number; h: number }): void;
}>();

const barEl = ref<HTMLElement | null>(null);
const savedBar = loadPersistedState().bar;
const compact = ref(savedBar?.compact ?? false);
const addMenuOpen = ref(false);
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

const displayElements = computed(() =>
  [...props.elements].sort((a, b) => b.zIndex - a.zIndex),
);

const activePanel = computed<'add' | 'layers' | null>(() => {
  if (compact.value || !props.fullCanvasEnabled) return null;
  if (addMenuOpen.value) return 'add';
  if (props.layersVisible) return 'layers';
  return null;
});

watch(
  () => props.fullCanvasEnabled,
  (enabled) => {
    if (!enabled) addMenuOpen.value = false;
    requestAnimationFrame(reportBounds);
  },
);

function kindLabel(el: WorldElement): string {
  if (el.kind === 'grid') return messages.value.layers.kindGrid;
  if (el.kind === 'image') return messages.value.layers.kindImage;
  return messages.value.layers.kindScreen;
}

function displayLabel(el: WorldElement): string {
  if (el.label) return el.label;
  if (el.kind === 'grid') return messages.value.stage.gridDefaultLabel;
  if (el.kind === 'image') return messages.value.stage.imageDefaultLabel;
  return messages.value.stage.screenDefaultLabel;
}

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
  const maxX = Math.max(
    minX,
    window.innerWidth - safe.right - Math.min(bw, Math.max(100, window.innerWidth - safe.left - safe.right - 8)),
  );
  const maxY = Math.max(minY, window.innerHeight - safe.bottom - Math.min(bh, 44) - 4);
  return { minX, minY, maxX, maxY };
}

function clampBarToViewport() {
  const { minX, minY, maxX, maxY } = getSafeDragLimits();
  pos.value.x = Math.max(minX, Math.min(maxX, pos.value.x));
  pos.value.y = Math.max(minY, Math.min(maxY, pos.value.y));
  reportBounds();
}

function reportBounds() {
  if (!barEl.value) return;
  const r = barEl.value.getBoundingClientRect();
  emit('bounds-change', { x: r.left, y: r.top, w: r.width, h: r.height });
}

function handleOverlayModeClick() {
  if (!props.canSwitchOverlay) {
    emit('unavailable-click', 'overlayWeb');
    return;
  }
  addMenuOpen.value = false;
  emit('update:backdropMode', 'overlay');
}

function handleToggleAddMenu() {
  const next = !addMenuOpen.value;
  addMenuOpen.value = next;
  if (next && props.layersVisible) {
    emit('update:layersVisible', false);
  }
  requestAnimationFrame(reportBounds);
}

function handleToggleLayers() {
  const next = !props.layersVisible;
  if (next) addMenuOpen.value = false;
  emit('update:layersVisible', next);
  requestAnimationFrame(reportBounds);
}

function handleAddImageClick() {
  addMenuOpen.value = false;
  emit('add-image');
  requestAnimationFrame(reportBounds);
}

function handleAddScreenClick() {
  addMenuOpen.value = false;
  requestAnimationFrame(reportBounds);
  if (!props.canScreenCapture) {
    emit('unavailable-click', 'screenUnsupported');
    return;
  }
  emit('add-screen');
}

function onGlobalPointerDown(e: PointerEvent) {
  if (!addMenuOpen.value) return;
  if (barEl.value && !barEl.value.contains(e.target as Node)) {
    addMenuOpen.value = false;
    requestAnimationFrame(reportBounds);
  }
}

// Universal drag from toolbar header/buttons (ignores scrollable layers table body so clicks/scrolls feel native)
const DRAG_THRESHOLD_PX = 8;
let pointerId: number | null = null;
let dragMoved = false;
let dragCapturedEl: Element | null = null;
let suppressNextClick = false;
let dragStart = { x: 0, y: 0, ox: 0, oy: 0 };

function finishBarDrag(persist: boolean) {
  if (pointerId === null) return;
  const pid = pointerId;
  const wasMoved = dragMoved;
  pointerId = null;
  dragMoved = false;
  tryReleasePointer(dragCapturedEl, pid);
  dragCapturedEl = null;
  if (wasMoved) {
    endGlobalDrag();
    reportBounds();
    if (persist) persistBarState();
    window.setTimeout(() => {
      suppressNextClick = false;
    }, 80);
  }
}

function onBarPointerDown(e: PointerEvent) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  const target = e.target as HTMLElement | null;
  if (target?.closest('.ac-layers-scroll')) return;
  if (pointerId !== null) finishBarDrag(false);
  pointerId = e.pointerId;
  dragMoved = false;
  dragStart = { x: e.clientX, y: e.clientY, ox: pos.value.x, oy: pos.value.y };
}

function onWindowBarPointerMove(e: PointerEvent) {
  if (pointerId === null || e.pointerId !== pointerId) return;
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;

  if (!dragMoved) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    dragMoved = true;
    suppressNextClick = true;
    dragCapturedEl = tryCapturePointer(barEl.value, e.pointerId);
    beginGlobalDrag();
  }

  e.preventDefault();
  const { minX, minY, maxX, maxY } = getSafeDragLimits();
  pos.value.x = Math.max(minX, Math.min(maxX, dragStart.ox + dx));
  pos.value.y = Math.max(minY, Math.min(maxY, dragStart.oy + dy));
  reportBounds();
}

function onWindowBarPointerUp(e: PointerEvent) {
  if (pointerId === null || e.pointerId !== pointerId) return;
  finishBarDrag(true);
}

function onWindowBarBlur() {
  finishBarDrag(true);
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
  addMenuOpen.value = false;
  persistBarState();
  requestAnimationFrame(reportBounds);
}

watch(
  [safeAreaInsets, currentLocale],
  () => {
    requestAnimationFrame(clampBarToViewport);
  },
  { deep: true },
);

watch(
  [() => props.backdropMode, () => props.layersVisible, () => props.elements.length],
  () => {
    requestAnimationFrame(reportBounds);
  },
);

let barResizeObserver: ResizeObserver | null = null;

onMounted(() => {
  requestAnimationFrame(clampBarToViewport);
  barResizeObserver = new ResizeObserver(reportBounds);
  if (barEl.value) barResizeObserver.observe(barEl.value);
  window.addEventListener('pointerdown', onGlobalPointerDown, true);
  window.addEventListener('pointermove', onWindowBarPointerMove);
  window.addEventListener('pointerup', onWindowBarPointerUp);
  window.addEventListener('pointercancel', onWindowBarPointerUp);
  window.addEventListener('blur', onWindowBarBlur);
  window.addEventListener('resize', clampBarToViewport);
});

onBeforeUnmount(() => {
  finishBarDrag(false);
  barResizeObserver?.disconnect();
  window.removeEventListener('pointerdown', onGlobalPointerDown, true);
  window.removeEventListener('pointermove', onWindowBarPointerMove);
  window.removeEventListener('pointerup', onWindowBarPointerUp);
  window.removeEventListener('pointercancel', onWindowBarPointerUp);
  window.removeEventListener('blur', onWindowBarBlur);
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
    @click.capture="onBarClickCapture"
  >
    <div class="ac-bar-row">
      <span class="ac-brand" :title="messages.bar.dragTitle">⋮⋮</span>

      <!-- Expanded controls (collapsed state ONLY keeps drag handle + Expand button) -->
      <div class="ac-anim-slot" :class="{ closed: compact }" :inert="compact">
        <div class="ac-anim-inner">
          <div class="ac-segmented" role="group" :aria-label="messages.bar.backdropGroupAria">
            <button
              v-if="canSwitchOverlay || showUnavailableOptions"
              class="ac-seg-btn"
              :class="{ active: backdropMode === 'overlay', unavailable: !canSwitchOverlay }"
              @click="handleOverlayModeClick"
            >
              {{ messages.bar.modeOverlay }}
            </button>
            <button
              class="ac-seg-btn"
              :class="{ active: backdropMode === 'canvas' }"
              @click="emit('update:backdropMode', 'canvas')"
            >
              {{ messages.bar.modeCanvas }}
            </button>
          </div>

          <!-- Toggle buttons (切换式): Add, Layers (hidden when fullCanvasEnabled=false), Window Pin -->
          <button
            v-if="fullCanvasEnabled"
            class="ac-btn ac-gap-left"
            :class="{ active: addMenuOpen }"
            :title="messages.bar.addTitle"
            @click="handleToggleAddMenu"
          >
            {{ messages.bar.add }}
          </button>

          <button
            v-if="fullCanvasEnabled"
            class="ac-btn ac-gap-left"
            :class="{ active: layersVisible && !addMenuOpen }"
            :title="messages.bar.layersTitle"
            @click="handleToggleLayers"
          >
            {{ messages.bar.layers }}
          </button>

          <button
            v-if="canPinWindow"
            class="ac-btn ac-gap-left"
            :class="{ active: alwaysOnTop }"
            :title="messages.bar.pinTitle"
            @click="emit('update:alwaysOnTop', !alwaysOnTop)"
          >
            {{ messages.bar.pin }}
          </button>

          <span class="ac-sep" aria-hidden="true" />

          <!-- Trigger buttons (触发式): Settings, Exit, Collapse/Expand -->
          <button class="ac-btn action" :title="messages.bar.settingsTitle" @click="emit('open-settings')">
            {{ messages.bar.settings }}
          </button>

          <button
            v-if="platform === 'tauri' || platform === 'android-overlay' || platform === 'android-app'"
            class="ac-btn action danger ac-gap-left"
            :title="platform === 'android-app' ? messages.bar.exitAppTitle : messages.bar.exitOverlayTitle"
            @click="emit('close-overlay')"
          >
            {{ messages.bar.exit }}
          </button>
        </div>
      </div>

      <button
        class="ac-btn action ac-gap-left"
        :title="compact ? messages.bar.expandTitle : messages.bar.collapseTitle"
        @click="toggleCompact"
      >
        {{ compact ? messages.bar.expand : messages.bar.collapse }}
      </button>
    </div>

    <!-- Pure-DOM MD3 inline expandable strip ("Add" picker OR aligned "Layers" table) -->
    <div class="ac-popover-wrap" :class="{ open: activePanel !== null }">
      <div class="ac-popover-inner">
        <div v-if="activePanel === 'add'" class="ac-popover-row">
          <button class="ac-btn action tonal" @click="handleAddImageClick">
            {{ messages.bar.addImageOption }}
          </button>
          <button
            v-if="canScreenCapture || showUnavailableOptions"
            class="ac-btn action tonal"
            :class="{ unavailable: !canScreenCapture }"
            @click="handleAddScreenClick"
          >
            {{ messages.bar.addScreenOption }}
          </button>
        </div>

        <div v-else-if="activePanel === 'layers'" class="ac-layers-scroll" @wheel.stop>
          <div v-if="displayElements.length === 0" class="ac-layers-empty">
            {{ messages.layers.empty }}
          </div>
          <table v-else class="ac-layers-table">
            <tbody>
              <tr
                v-for="(el, idx) in displayElements"
                :key="el.id"
                class="ac-layer-tr"
                :class="{ selected: el.id === selectedId, muted: !el.visible }"
                @click="emit('select-element', el.id)"
              >
                <td class="col-kind">
                  <span class="ac-layer-badge" :class="`kind-${el.kind}`">{{ kindLabel(el) }}</span>
                </td>
                <td class="col-name" :title="displayLabel(el)">
                  <span class="ac-layer-name">{{ displayLabel(el) }}</span>
                </td>
                <td class="col-act" @click.stop>
                  <button
                    class="ac-chip-btn"
                    :class="{ active: el.visible }"
                    :title="el.visible ? messages.layers.hide : messages.layers.show"
                    @click="emit('toggle-visible', el.id)"
                  >
                    {{ el.visible ? messages.layers.show : messages.layers.hide }}
                  </button>
                </td>
                <td class="col-act" @click.stop>
                  <button
                    class="ac-chip-btn"
                    :class="{ active: el.locked }"
                    :title="el.locked ? messages.layers.unlock : messages.layers.lock"
                    @click="emit('toggle-lock', el.id)"
                  >
                    {{ el.locked ? messages.layers.unlock : messages.layers.lock }}
                  </button>
                </td>
                <td class="col-act" @click.stop>
                  <button
                    class="ac-chip-btn"
                    :class="{ danger: el.locked && el.passThrough }"
                    :disabled="!el.locked"
                    :title="messages.layers.passThrough"
                    @click="emit('toggle-passthrough', el.id)"
                  >
                    {{ messages.layers.passThrough }}
                  </button>
                </td>
                <td class="col-act" @click.stop>
                  <button
                    class="ac-chip-btn"
                    :class="{ active: el.kind === 'grid' && el.dockVisible }"
                    :disabled="el.kind !== 'grid'"
                    :title="messages.layers.tools"
                    @click="emit('toggle-dock', el.id)"
                  >
                    {{ messages.layers.tools }}
                  </button>
                </td>
                <td class="col-act" @click.stop>
                  <button
                    class="ac-chip-btn ac-chip-icon"
                    :disabled="idx === 0"
                    :title="messages.layers.moveUp"
                    @click="emit('move-up', el.id)"
                  >
                    ↑
                  </button>
                </td>
                <td class="col-act" @click.stop>
                  <button
                    class="ac-chip-btn ac-chip-icon"
                    :disabled="idx === displayElements.length - 1"
                    :title="messages.layers.moveDown"
                    @click="emit('move-down', el.id)"
                  >
                    ↓
                  </button>
                </td>
                <td class="col-act" @click.stop>
                  <button
                    class="ac-chip-btn ac-chip-icon"
                    :class="{ danger: el.kind !== 'grid' }"
                    :disabled="el.kind === 'grid'"
                    :title="messages.layers.remove"
                    @click="emit('remove-element', el.id)"
                  >
                    ×
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.ac-control-bar {
  position: fixed;
  z-index: 1150;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
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
}

.ac-bar-row {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  max-width: 100%;
}

.ac-anim-slot {
  display: inline-grid;
  grid-template-columns: 1fr;
  align-items: center;
  opacity: 1;
  transition:
    grid-template-columns 0.22s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.16s cubic-bezier(0.2, 0, 0, 1);
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
}

.ac-brand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  color: var(--md-sys-color-primary);
  padding: 0 3px;
  user-select: none;
  white-space: nowrap;
  flex-shrink: 0;
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
  line-height: 1;
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

.ac-seg-btn.unavailable {
  opacity: 0.45;
  cursor: help;
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

.ac-popover-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding-top: 5px;
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

/* Aligned inline Layers table */
.ac-layers-scroll {
  width: 100%;
  max-height: min(260px, 45vh);
  overflow-y: auto;
  overflow-x: auto;
  padding-top: 6px;
  border-top: 1px solid var(--md-sys-color-outline-variant);
  cursor: default;
  touch-action: pan-y;
}

.ac-layers-empty {
  padding: 10px 6px;
  text-align: center;
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
}

.ac-layers-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0 4px;
}

.ac-layer-tr {
  cursor: pointer;
}

.ac-layer-tr td {
  padding: 4px 2.5px;
  vertical-align: middle;
  white-space: nowrap;
  background: var(--md-sys-color-surface-container-low);
  border-top: 1px solid var(--md-sys-color-outline-variant);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  transition: background 0.14s ease, border-color 0.14s ease;
}

.ac-layer-tr td:first-child {
  padding-left: 7px;
  border-left: 1px solid var(--md-sys-color-outline-variant);
  border-top-left-radius: 9px;
  border-bottom-left-radius: 9px;
}

.ac-layer-tr td:last-child {
  padding-right: 7px;
  border-right: 1px solid var(--md-sys-color-outline-variant);
  border-top-right-radius: 9px;
  border-bottom-right-radius: 9px;
}

.ac-layer-tr.selected td {
  background: color-mix(in srgb, var(--md-sys-color-primary-container) 34%, var(--md-sys-color-surface-container-low));
  border-color: var(--md-sys-color-primary);
}

.ac-layer-tr.muted {
  opacity: 0.62;
}

.col-kind {
  width: 1%;
  line-height: 0;
  font-size: 0;
}

.col-name {
  max-width: 132px;
  padding-left: 4px !important;
  padding-right: 6px !important;
}

.col-act {
  width: 1%;
  text-align: center;
  line-height: 0;
  font-size: 0;
}

.ac-layer-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 22px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  vertical-align: middle;
}

.ac-layer-badge.kind-grid {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}

.ac-layer-badge.kind-image {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}

.ac-layer-badge.kind-screen {
  background: var(--md-sys-color-tertiary-container);
  color: var(--md-sys-color-on-tertiary-container);
}

.ac-layer-name {
  display: block;
  height: 22px;
  line-height: 22px;
  max-width: 126px;
  font-size: 11px;
  font-weight: 500;
  color: var(--md-sys-color-on-surface);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-chip-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-width: 34px;
  height: 22px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface-variant);
  font-size: 10px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease, opacity 0.12s ease;
}

.ac-chip-btn.ac-chip-icon {
  min-width: 24px;
  padding: 0 5px;
  font-size: 12px;
  line-height: 1;
}

.ac-chip-btn.active {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  border-color: var(--md-sys-color-primary);
}

.ac-chip-btn.danger {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
  border-color: var(--md-sys-color-error);
}

.ac-chip-btn:disabled {
  opacity: 0.34;
  background: var(--md-sys-color-surface-container-low);
  color: var(--md-sys-color-on-surface-variant);
  border-color: var(--md-sys-color-outline-variant);
  cursor: not-allowed;
}
</style>
