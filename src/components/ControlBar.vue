<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { setAndroidKeyboardFocusable, type RuntimePlatform } from '../core/platform';
import type { WorkspaceMode } from '../core/world';
import { canDeleteSingleTarget, type SelectableTarget } from '../core/canvasItems';
import { loadPersistedState, patchPersistedState, type ButtonDisplayMode } from '../core/storage';
import { safeAreaInsets } from '../core/safeArea';
import { currentLocale, formatMessage, messages } from '../core/i18n';
import { beginGlobalDrag, endGlobalDrag, tryCapturePointer, tryReleasePointer } from '../core/dragGuard';
import MdIcon, { type MdIconName } from './MdIcon.vue';
import MdActionBtn from './MdActionBtn.vue';

export type BackdropMode = WorkspaceMode;
export type UnavailableReasonKey =
  | 'multiplyOverlay'
  | 'overlayWeb'
  | 'screenUnsupported'
  | 'clickThroughUnavailable'
  | 'androidShotUnavailable'
  | 'dynamicColorUnavailable'
  | 'penpaCloneUnsupported'
  | 'multiMonitorUnavailable';

const props = defineProps<{
  platform: RuntimePlatform;
  canSwitchOverlay: boolean;
  canScreenCapture: boolean;
  canPinWindow: boolean;
  alwaysOnTop: boolean;
  fullCanvasEnabled: boolean;
  backdropMode: WorkspaceMode;
  layersVisible: boolean;
  elements: SelectableTarget[];
  selectedIds: string[];
  buttonDisplayMode: ButtonDisplayMode;
  globalScale: number;
  showUnavailableOptions: boolean;
  initialBarOverride?: { xRatio: number; yRatio: number; compact: boolean } | null;
  delegatePersistence?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:backdropMode', v: WorkspaceMode): void;
  (e: 'update:layersVisible', v: boolean): void;
  (e: 'update:alwaysOnTop', v: boolean): void;
  (e: 'unavailable-click', key: UnavailableReasonKey): void;
  (e: 'add-grid'): void;
  (e: 'add-image'): void;
  (e: 'add-screen'): void;
  (e: 'select-element', id: string, additive: boolean): void;
  (e: 'toggle-visible', id: string): void;
  (e: 'toggle-lock', id: string): void;
  (e: 'toggle-passthrough', id: string): void;
  (e: 'toggle-dock', id: string): void;
  (e: 'move-up', id: string): void;
  (e: 'move-down', id: string): void;
  (e: 'remove-element', id: string): void;
  (e: 'rename-element', id: string, label: string): void;
  (e: 'open-settings'): void;
  (e: 'close-overlay'): void;
  (e: 'bar-state-change', state: { xRatio: number; yRatio: number; compact: boolean }): void;
  (e: 'bounds-change', rect: { x: number; y: number; w: number; h: number }): void;
}>();

const barEl = ref<HTMLElement | null>(null);
const savedBar = props.initialBarOverride ?? loadPersistedState().bar;
const compact = ref(savedBar?.compact ?? false);
const editingId = ref<string | null>(null);
const editingValue = ref('');
let renameInputEl: HTMLInputElement | null = null;
const initSafe = safeAreaInsets.value;

function setRenameInputRef(el: HTMLInputElement | null) {
  renameInputEl = el;
}

function startRename(el: SelectableTarget) {
  editingId.value = el.id;
  editingValue.value = el.label || displayLabel(el);
  void nextTick(() => {
    if (renameInputEl) {
      renameInputEl.focus();
      renameInputEl.select();
    }
  });
}

function commitRename() {
  const id = editingId.value;
  if (!id) return;
  const trimmed = editingValue.value.trim();
  editingId.value = null;
  setAndroidKeyboardFocusable(false);
  emit('rename-element', id, trimmed);
}

function cancelRename() {
  if (!editingId.value) return;
  editingId.value = null;
  setAndroidKeyboardFocusable(false);
}

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

const layersPanelOpen = computed(
  () => !compact.value && props.fullCanvasEnabled && props.layersVisible,
);

watch(layersPanelOpen, (open) => {
  if (!open) cancelRename();
});

watch(
  () => props.fullCanvasEnabled,
  () => {
    requestAnimationFrame(reportBounds);
  },
);

function kindLabel(el: SelectableTarget): string {
  if (el.kind === 'group') return messages.value.layers.kindGroup;
  if (el.kind === 'grid') return messages.value.layers.kindGrid;
  if (el.kind === 'image') return messages.value.layers.kindImage;
  return messages.value.layers.kindScreen;
}

function kindIconName(el: SelectableTarget): MdIconName {
  if (el.kind === 'group') return 'stack_group';
  if (el.kind === 'grid') return 'grid_on';
  if (el.kind === 'image') return 'image';
  return 'cast';
}

function displayLabel(el: SelectableTarget): string {
  if (el.label) return el.label;
  if (el.kind === 'group') {
    return formatMessage(messages.value.stage.groupDefaultLabel, { count: el.memberIds.length });
  }
  if (el.kind === 'grid') return messages.value.stage.gridDefaultLabel;
  if (el.kind === 'image') return messages.value.stage.imageDefaultLabel;
  return messages.value.stage.screenDefaultLabel;
}

function targetHasGrid(el: SelectableTarget): boolean {
  return el.kind === 'grid' || (el.kind === 'group' && el.hasGrid);
}

function targetDockVisible(el: SelectableTarget): boolean {
  return (el.kind === 'grid' || el.kind === 'group') && el.dockVisible;
}

function persistBarState() {
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  const next = {
    xRatio: pos.value.x / vw,
    yRatio: pos.value.y / vh,
    compact: compact.value,
  };
  emit('bar-state-change', next);
  if (!props.delegatePersistence) {
    patchPersistedState({ bar: next });
  }
}

function getSafeDragLimits() {
  const safe = safeAreaInsets.value;
  const r = barEl.value?.getBoundingClientRect();
  const bw = r && r.width > 1 ? r.width : 160;
  const bh = r && r.height > 1 ? r.height : 40;
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
  emit('update:backdropMode', 'overlay');
}

function handleToggleLayers() {
  emit('update:layersVisible', !props.layersVisible);
  requestAnimationFrame(reportBounds);
}

function handleAddGridClick() {
  emit('add-grid');
  requestAnimationFrame(reportBounds);
}

function handleAddImageClick() {
  emit('add-image');
  requestAnimationFrame(reportBounds);
}

function handleAddScreenClick() {
  requestAnimationFrame(reportBounds);
  if (!props.canScreenCapture) {
    emit('unavailable-click', 'screenUnsupported');
    return;
  }
  emit('add-screen');
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
  persistBarState();
  requestAnimationFrame(reportBounds);
}

watch(
  [safeAreaInsets, currentLocale, () => props.globalScale],
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
  window.addEventListener('pointermove', onWindowBarPointerMove);
  window.addEventListener('pointerup', onWindowBarPointerUp);
  window.addEventListener('pointercancel', onWindowBarPointerUp);
  window.addEventListener('blur', onWindowBarBlur);
  window.addEventListener('resize', clampBarToViewport);
});

onBeforeUnmount(() => {
  finishBarDrag(false);
  emit('bounds-change', { x: 0, y: 0, w: 0, h: 0 });
  barResizeObserver?.disconnect();
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
      <span class="ac-brand" :title="messages.bar.dragTitle">
        <MdIcon name="drag_indicator" :size="16" />
      </span>

      <!-- Left section (collapses when compact): Mode switcher, Add, Layers, Divider -->
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

          <!-- Layers toggle (includes inline Add actions; hidden in simple Overlay mode) -->
          <MdActionBtn
            v-if="fullCanvasEnabled"
            class="ac-gap-left"
            icon="layers"
            :label="messages.bar.layers"
            :title="messages.bar.layersTitle"
            :mode="buttonDisplayMode"
            variant="toggle"
            :active="layersVisible"
            @click="handleToggleLayers"
          />

          <span class="ac-sep" aria-hidden="true" />
        </div>
      </div>

      <!-- Right divider section starts with Window Pin (ALWAYS visible even when collapsed!) -->
      <MdActionBtn
        v-if="canPinWindow"
        :class="{ 'ac-gap-left': compact }"
        icon="keep"
        :label="messages.bar.pin"
        :title="messages.bar.pinTitle"
        :mode="buttonDisplayMode"
        variant="toggle"
        :active="alwaysOnTop"
        @click="emit('update:alwaysOnTop', !alwaysOnTop)"
      />

      <!-- Right-side collapsible triggers: Settings & Exit -->
      <div class="ac-anim-slot" :class="{ closed: compact }" :inert="compact">
        <div class="ac-anim-inner">
          <MdActionBtn
            :class="{ 'ac-gap-left': canPinWindow }"
            icon="settings"
            :label="messages.bar.settings"
            :title="messages.bar.settingsTitle"
            :mode="buttonDisplayMode"
            variant="trigger"
            @click="emit('open-settings')"
          />

          <MdActionBtn
            v-if="platform === 'tauri' || platform === 'android-overlay' || platform === 'android-app'"
            class="ac-gap-left"
            icon="logout"
            :label="messages.bar.exit"
            :title="platform === 'android-app' ? messages.bar.exitAppTitle : messages.bar.exitOverlayTitle"
            :mode="buttonDisplayMode"
            variant="trigger"
            tone="danger"
            @click="emit('close-overlay')"
          />
        </div>
      </div>

      <MdActionBtn
        class="ac-gap-left"
        :icon="compact ? 'chevron_right' : 'chevron_left'"
        :label="compact ? messages.bar.expand : messages.bar.collapse"
        :title="compact ? messages.bar.expandTitle : messages.bar.collapseTitle"
        :mode="buttonDisplayMode"
        variant="trigger"
        :icon-size="buttonDisplayMode === 'icon-only' ? 20 : 17"
        @click="toggleCompact"
      />
    </div>

    <!-- Pure-DOM MD3 inline expandable Layers drawer (with merged Add strip at top) -->
    <div class="ac-popover-wrap" :class="{ open: layersPanelOpen }">
      <div class="ac-popover-inner">
        <template v-if="layersPanelOpen">
          <div class="ac-layers-add-row">
            <MdActionBtn
              icon="grid_on"
              :label="messages.bar.addGridOption"
              :mode="buttonDisplayMode"
              variant="trigger"
              tone="tonal"
              size="sm"
              @click="handleAddGridClick"
            />
            <MdActionBtn
              icon="image"
              :label="messages.bar.addImageOption"
              :mode="buttonDisplayMode"
              variant="trigger"
              tone="tonal"
              size="sm"
              @click="handleAddImageClick"
            />
            <MdActionBtn
              v-if="canScreenCapture || showUnavailableOptions"
              icon="cast"
              :label="messages.bar.addScreenOption"
              :mode="buttonDisplayMode"
              variant="trigger"
              tone="tonal"
              size="sm"
              :unavailable="!canScreenCapture"
              @click="handleAddScreenClick"
            />
          </div>

          <div class="ac-layers-scroll" @wheel.stop>
          <div v-if="displayElements.length === 0" class="ac-layers-empty">
            {{ messages.layers.empty }}
          </div>
          <table v-else class="ac-layers-table">
            <tbody>
              <tr
                v-for="(el, idx) in displayElements"
                :key="el.id"
                class="ac-layer-tr"
                :class="{ selected: selectedIds.includes(el.id), muted: !el.visible }"
                @click="emit('select-element', el.id, $event.ctrlKey || $event.metaKey)"
              >
                <td class="col-kind">
                  <span
                    class="ac-layer-kind-icon"
                    :class="`kind-${el.kind}`"
                    :title="kindLabel(el)"
                    :aria-label="kindLabel(el)"
                  >
                    <MdIcon :name="kindIconName(el)" :size="17" />
                  </span>
                </td>
                <td class="col-name" :title="displayLabel(el)" @dblclick.stop="startRename(el)">
                  <input
                    v-if="editingId === el.id"
                    :ref="(node) => setRenameInputRef(node as HTMLInputElement | null)"
                    v-model="editingValue"
                    type="text"
                    class="ac-layer-rename-input"
                    @click.stop
                    @pointerdown.stop
                    @dblclick.stop
                    @keydown.stop
                    @keydown.enter.prevent="commitRename"
                    @keydown.esc.prevent="cancelRename"
                    @focus="setAndroidKeyboardFocusable(true)"
                    @blur="commitRename"
                  />
                  <span v-else class="ac-layer-name">{{ displayLabel(el) }}</span>
                </td>
                <td class="col-act" @click.stop>
                  <button
                    class="ac-icon-btn xs"
                    :class="{ active: el.visible }"
                    :title="el.visible ? messages.layers.hide : messages.layers.show"
                    :aria-label="el.visible ? messages.layers.hide : messages.layers.show"
                    @click="emit('toggle-visible', el.id)"
                  >
                    <MdIcon :name="el.visible ? 'visibility' : 'visibility_off'" :size="16" />
                  </button>
                </td>
                <td class="col-act" @click.stop>
                  <button
                    class="ac-icon-btn xs"
                    :class="{ active: el.locked }"
                    :title="el.locked ? messages.layers.unlock : messages.layers.lock"
                    :aria-label="el.locked ? messages.layers.unlock : messages.layers.lock"
                    @click="emit('toggle-lock', el.id)"
                  >
                    <MdIcon :name="el.locked ? 'lock' : 'lock_open'" :size="16" />
                  </button>
                </td>
                <td class="col-act" @click.stop>
                  <button
                    class="ac-icon-btn xs"
                    :class="{
                      danger: el.locked && el.visible && el.passThrough,
                      active: el.locked && el.visible && el.passThrough,
                    }"
                    :disabled="!el.locked || !el.visible"
                    :title="messages.layers.passThrough"
                    :aria-label="messages.layers.passThrough"
                    @click="emit('toggle-passthrough', el.id)"
                  >
                    <MdIcon name="do_not_touch" :size="16" />
                  </button>
                </td>
                <td class="col-act" @click.stop>
                  <button
                    class="ac-icon-btn xs"
                    :class="{ active: targetDockVisible(el) }"
                    :disabled="!targetHasGrid(el)"
                    :title="messages.layers.tools"
                    :aria-label="messages.layers.tools"
                    @click="emit('toggle-dock', el.id)"
                  >
                    <MdIcon name="build" :size="16" />
                  </button>
                </td>
                <td class="col-act" @click.stop>
                  <button
                    class="ac-icon-btn xs"
                    :disabled="idx === 0"
                    :title="messages.layers.moveUp"
                    :aria-label="messages.layers.moveUp"
                    @click="emit('move-up', el.id)"
                  >
                    <MdIcon name="arrow_upward" :size="16" />
                  </button>
                </td>
                <td class="col-act" @click.stop>
                  <button
                    class="ac-icon-btn xs"
                    :disabled="idx === displayElements.length - 1"
                    :title="messages.layers.moveDown"
                    :aria-label="messages.layers.moveDown"
                    @click="emit('move-down', el.id)"
                  >
                    <MdIcon name="arrow_downward" :size="16" />
                  </button>
                </td>
                <td class="col-act" @click.stop>
                  <button
                    class="ac-icon-btn xs"
                    :class="{ danger: canDeleteSingleTarget(el) }"
                    :disabled="!canDeleteSingleTarget(el)"
                    :title="messages.layers.remove"
                    :aria-label="messages.layers.remove"
                    @click="emit('remove-element', el.id)"
                  >
                    <MdIcon name="delete" :size="16" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          </div>
        </template>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.ac-control-bar {
  position: fixed;
  z-index: 1150;
  transform: scale(var(--ac-ui-scale, 1));
  transform-origin: top left;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: calc((100vw - var(--ac-safe-left, 0px) - var(--ac-safe-right, 0px) - 16px) / var(--ac-ui-scale, 1));
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

.ac-layers-add-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 6px 0;
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

/* Aligned inline Layers table */
.ac-layers-scroll {
  width: 100%;
  max-height: min(260px, 45vh);
  overflow-y: auto;
  overflow-x: auto;
  overscroll-behavior: contain;
  padding-top: 5px;
  border-top: 1px solid color-mix(in srgb, var(--md-sys-color-outline-variant) 70%, transparent);
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

.ac-layer-kind-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  vertical-align: middle;
}

.ac-layer-kind-icon.kind-grid {
  color: var(--md-sys-color-primary);
}

.ac-layer-kind-icon.kind-image {
  color: var(--md-sys-color-secondary);
}

.ac-layer-kind-icon.kind-screen {
  color: var(--md-sys-color-tertiary);
}

.ac-layer-kind-icon.kind-group {
  color: var(--md-sys-color-primary);
}

.ac-layer-name {
  display: block;
  height: 24px;
  line-height: 24px;
  max-width: 126px;
  font-size: 11px;
  font-weight: 500;
  color: var(--md-sys-color-on-surface);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-layer-rename-input {
  display: block;
  width: 118px;
  height: 22px;
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid var(--md-sys-color-primary);
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-on-surface);
  font-size: 11px;
  font-weight: 500;
  line-height: 20px;
  outline: none;
  user-select: text;
  -webkit-user-select: text;
}
</style>
