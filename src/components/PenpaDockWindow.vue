<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getPenpaBridge, type PenpaIframeBridge } from '../core/penpaBridge';
import type { BlendRenderMode } from '../core/webglOverlay';
import type { WorkspaceMode } from '../core/world';
import type { UnavailableReasonKey } from './ControlBar.vue';
import type { PersistedDockState } from '../core/storage';
import { setAndroidKeyboardFocusable } from '../core/platform';
import { safeAreaInsets } from '../core/safeArea';
import { messages } from '../core/i18n';
import { beginGlobalDrag, endGlobalDrag, tryCapturePointer, tryReleasePointer } from '../core/dragGuard';
import MdIcon from './MdIcon.vue';
import MdSlider from './MdSlider.vue';

const props = defineProps<{
  gridId: string;
  visible: boolean;
  nativeWindowMode?: boolean;
  title?: string;
  label?: string;
  dockZIndex: number;
  dockIndex: number;
  initialDockState?: PersistedDockState;
  isFocusedDock: boolean;
  linkedHighlight?: boolean;
  backdropMode: WorkspaceMode;
  blendMode: BlendRenderMode;
  boardOpacity: number;
  enhanceOpacity: boolean;
  showUnavailableOptions: boolean;
  globalScale: number;
  penpaScale: number;
  blurOpacity: number;
}>();

const emit = defineEmits<{
  (e: 'bridge-ready', bridge: PenpaIframeBridge): void;
  (e: 'activate'): void;
  (e: 'rename', label: string): void;
  (e: 'dock-state-change', state: PersistedDockState): void;
  (e: 'native-drag-start', logicalW: number, logicalH: number): void;
  (e: 'native-drag-end'): void;
  (e: 'native-move-delta', dxScreenCss: number, dyScreenCss: number): void;
  (e: 'native-resize-to', logicalW: number, logicalH: number): void;
  (e: 'update:visible', value: boolean): void;
  (e: 'update:blendMode', value: BlendRenderMode): void;
  (e: 'update:boardOpacity', value: number): void;
  (e: 'update:enhanceOpacity', value: boolean): void;
  (e: 'unavailable-click', key: UnavailableReasonKey): void;
  (e: 'bounds-change', rect: { x: number; y: number; w: number; h: number }): void;
}>();

const dockEl = ref<HTMLElement | null>(null);
const iframeEl = ref<HTMLIFrameElement | null>(null);
const titleInputEl = ref<HTMLInputElement | null>(null);
const editingTitle = ref(false);
const titleDraft = ref('');

function startTitleRename() {
  if (editingTitle.value) return;
  closeRenderBarMenus();
  editingTitle.value = true;
  titleDraft.value = props.label || props.title || '';
  emit('activate');
  void nextTick(() => {
    if (titleInputEl.value) {
      titleInputEl.value.focus();
      titleInputEl.value.select();
    }
  });
}

function commitTitleRename() {
  if (!editingTitle.value) return;
  const trimmed = titleDraft.value.trim();
  editingTitle.value = false;
  setAndroidKeyboardFocusable(false);
  emit('rename', trimmed);
}

function cancelTitleRename() {
  if (!editingTitle.value) return;
  editingTitle.value = false;
  setAndroidKeyboardFocusable(false);
}

const blendMenuOpen = ref(false);
const headerHovered = ref(false);
const renderBarHovered = ref(false);
const renderBarHoverHold = ref(false);
const renderBarInteracting = ref(false);
const touchRenderBarPinned = ref(false);
const dockHovered = ref(false);
let hoverCloseTimer = 0;

function cancelHoverClose() {
  if (hoverCloseTimer) {
    window.clearTimeout(hoverCloseTimer);
    hoverCloseTimer = 0;
  }
}

function scheduleHoverClose() {
  cancelHoverClose();
  renderBarHoverHold.value = true;
  hoverCloseTimer = window.setTimeout(() => {
    hoverCloseTimer = 0;
    renderBarHoverHold.value = false;
    if (!headerHovered.value && !renderBarHovered.value && !renderBarInteracting.value) {
      blendMenuOpen.value = false;
    }
  }, 140);
}

function onDockPointerEnter(e: PointerEvent) {
  if (e.pointerType === 'touch') return;
  dockHovered.value = true;
}

function onDockPointerLeave(e: PointerEvent) {
  if (e.pointerType === 'touch') return;
  dockHovered.value = false;
}

function onDockPointerDown() {
  emit('activate');
}

function onDockFocusIn() {
  emit('activate');
}

function onHeaderPointerEnter(e: PointerEvent) {
  if (e.pointerType === 'touch') return;
  cancelHoverClose();
  renderBarHoverHold.value = false;
  headerHovered.value = true;
}

function onHeaderPointerLeave(e: PointerEvent) {
  if (e.pointerType === 'touch') return;
  headerHovered.value = false;
  scheduleHoverClose();
}

function onRenderBarPointerEnter(e: PointerEvent) {
  if (e.pointerType === 'touch') return;
  cancelHoverClose();
  renderBarHoverHold.value = false;
  renderBarHovered.value = true;
}

function onRenderBarPointerLeave(e: PointerEvent) {
  if (e.pointerType === 'touch') return;
  renderBarHovered.value = false;
  scheduleHoverClose();
}

function onRenderBarPointerDown() {
  cancelHoverClose();
  renderBarHoverHold.value = false;
  renderBarInteracting.value = true;
}

function onWindowRenderBarPointerEnd() {
  if (!renderBarInteracting.value) return;
  renderBarInteracting.value = false;
  if (!headerHovered.value && !renderBarHovered.value) {
    scheduleHoverClose();
  }
}

function closeRenderBarMenus() {
  cancelHoverClose();
  headerHovered.value = false;
  renderBarHovered.value = false;
  renderBarHoverHold.value = false;
  renderBarInteracting.value = false;
  touchRenderBarPinned.value = false;
  blendMenuOpen.value = false;
}

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

function formatPercent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

const savedDock = props.initialDockState;
const hasSavedDock = !!savedDock;

const collapsed = ref(savedDock?.collapsed ?? false);
const readyState = ref(false);
const isInteracting = ref(false);

const renderBarOpen = computed(
  () =>
    !collapsed.value &&
    !isInteracting.value &&
    !editingTitle.value &&
    (headerHovered.value ||
      renderBarHovered.value ||
      renderBarHoverHold.value ||
      renderBarInteracting.value ||
      blendMenuOpen.value ||
      touchRenderBarPinned.value),
);

const effectiveDockOpacity = computed(() => {
  if (
    dockHovered.value ||
    props.isFocusedDock ||
    props.linkedHighlight ||
    editingTitle.value ||
    isInteracting.value ||
    blendMenuOpen.value ||
    renderBarInteracting.value ||
    touchRenderBarPinned.value
  ) {
    return 1;
  }
  return Math.max(0.2, Math.min(1, props.blurOpacity));
});

const collapsedW = computed(() => Math.round(168 * (props.globalScale || 1)));
const collapsedH = computed(() => Math.round(36 * (props.globalScale || 1)));

const cascadeOffset = (props.dockIndex % 6) * 28;
// Default floating tool window size fits Penpa+ native 600px #buttons with zero layout distortion
const pos = ref({
  x:
    typeof savedDock?.xRatio === 'number'
      ? Math.round(savedDock.xRatio * (window.innerWidth || 1280))
      : 20 + cascadeOffset,
  y:
    typeof savedDock?.yRatio === 'number'
      ? Math.round(savedDock.yRatio * (window.innerHeight || 800))
      : 64 + cascadeOffset,
});
const size = ref({
  w: typeof savedDock?.w === 'number' && savedDock.w >= 260 ? savedDock.w : 660,
  h: typeof savedDock?.h === 'number' && savedDock.h >= 180 ? savedDock.h : 420,
});

function persistDockState() {
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  emit('dock-state-change', {
    xRatio: pos.value.x / vw,
    yRatio: pos.value.y / vh,
    w: size.value.w,
    h: size.value.h,
    scale: props.penpaScale,
    opacity: props.blurOpacity,
    collapsed: collapsed.value,
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
    w: collapsed.value ? collapsedW.value : size.value.w,
    h: collapsed.value ? collapsedH.value : size.value.h,
  });
}

function clampPosition(isInitial = false) {
  // Native floating window mode is sized & positioned directly by the OS window manager
  if (props.nativeWindowMode) {
    emitBounds();
    return;
  }
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
    pos.value.x = safe.left + 6;
    pos.value.y = Math.max(minY + 56, vh - safe.bottom - size.value.h - 12);
  } else {
    const effectiveW = Math.min(size.value.w, Math.max(260, safeW - 12));
    const effectiveH = Math.min(size.value.h, Math.max(160, safeH - 48));
    size.value.w = effectiveW;
    size.value.h = effectiveH;
    const maxX = Math.max(minX, vw - safe.right - Math.min(collapsed.value ? collapsedW.value : effectiveW, 100));
    const maxY = Math.max(minY, vh - safe.bottom - 40);
    pos.value.x = Math.max(minX, Math.min(maxX, pos.value.x));
    pos.value.y = Math.max(minY, Math.min(maxY, pos.value.y));
  }
  emitBounds();
}

let dragMode: 'move' | 'resize' | null = null;
let dragPointerId: number | null = null;
let dragCapturedEl: Element | null = null;
let dragSourceEl: HTMLElement | null = null;
let dragPointerType = 'mouse';
let dragMoved = false;
let dragGlobalHeld = false;
let dragStart = { x: 0, y: 0, screenX: 0, screenY: 0, origX: 0, origY: 0, origW: 0, origH: 0 };

function finishDockDrag(persist: boolean) {
  if (!dragMode) return;
  const wasNativeMove = !!props.nativeWindowMode && dragMode === 'move' && dragMoved;
  const wasTouchTapOnHeader = dragMode === 'move' && dragPointerType === 'touch' && !dragMoved;
  const wasMoved = dragMoved || dragMode === 'resize';
  if (dragPointerId !== null) {
    tryReleasePointer(dragCapturedEl, dragPointerId);
  }
  dragMode = null;
  dragPointerId = null;
  dragCapturedEl = null;
  dragSourceEl = null;
  dragMoved = false;
  isInteracting.value = false;
  if (dragGlobalHeld) {
    dragGlobalHeld = false;
    endGlobalDrag();
  }
  if (wasNativeMove) {
    emit('native-drag-end');
  }
  if (wasTouchTapOnHeader && !collapsed.value) {
    touchRenderBarPinned.value = !touchRenderBarPinned.value;
    if (!touchRenderBarPinned.value) blendMenuOpen.value = false;
  } else if (persist && wasMoved && !props.nativeWindowMode) {
    persistDockState();
  }
}

function startMove(e: PointerEvent) {
  if (editingTitle.value) return;
  if ((e.target as HTMLElement).closest('button, input, .ac-md-slider')) return;
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  if (dragMode) finishDockDrag(false);
  dragMode = 'move';
  dragPointerId = e.pointerId;
  dragPointerType = e.pointerType || 'mouse';
  dragSourceEl = e.currentTarget as HTMLElement | null;
  dragMoved = false;
  dragStart = {
    x: e.clientX,
    y: e.clientY,
    screenX: e.screenX,
    screenY: e.screenY,
    origX: pos.value.x,
    origY: pos.value.y,
    origW: size.value.w,
    origH: size.value.h,
  };
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
    screenX: e.screenX,
    screenY: e.screenY,
    origX: pos.value.x,
    origY: pos.value.y,
    origW: size.value.w,
    origH: size.value.h,
  };
  dragCapturedEl = tryCapturePointer(e.currentTarget as HTMLElement, e.pointerId);
  dragGlobalHeld = true;
  beginGlobalDrag();
}

function onDragMove(e: PointerEvent) {
  if (!dragMode || (dragPointerId !== null && e.pointerId !== dragPointerId)) return;
  const dx = props.nativeWindowMode ? e.screenX - dragStart.screenX : e.clientX - dragStart.x;
  const dy = props.nativeWindowMode ? e.screenY - dragStart.screenY : e.clientY - dragStart.y;
  if (dragMode === 'move' && !dragMoved) {
    if (Math.hypot(dx, dy) < 4) return;
    dragMoved = true;
    isInteracting.value = true;
    dragCapturedEl = tryCapturePointer(dragSourceEl, e.pointerId);
    if (!dragGlobalHeld) {
      dragGlobalHeld = true;
      beginGlobalDrag();
    }
    if (props.nativeWindowMode) {
      emit(
        'native-drag-start',
        collapsed.value ? collapsedW.value : size.value.w,
        collapsed.value ? collapsedH.value : size.value.h,
      );
      return;
    }
  }
  e.preventDefault();
  if (props.nativeWindowMode) {
    if (dragMode === 'move') {
      // Driven natively in Rust via physical cursor polling once native-drag-start fires
      return;
    } else {
      const nextW = Math.max(260, Math.min(1200, Math.round(dragStart.origW + dx)));
      const nextH = Math.max(160, Math.min(1000, Math.round(dragStart.origH + dy)));
      size.value.w = nextW;
      size.value.h = nextH;
      emit('native-resize-to', nextW, nextH);
    }
    return;
  }
  const safe = safeAreaInsets.value;
  const minX = safe.left + 4;
  const minY = safe.top + 4;
  if (dragMode === 'move') {
    const curW = collapsed.value ? collapsedW.value : size.value.w;
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
  closeRenderBarMenus();
  window.setTimeout(() => {
    if (!document.hasFocus()) {
      dockHovered.value = false;
    } else if (document.activeElement === iframeEl.value) {
      emit('activate');
    }
  }, 0);
}

function toggleCollapsed() {
  collapsed.value = !collapsed.value;
  if (collapsed.value) closeRenderBarMenus();
  if (props.nativeWindowMode) {
    emit(
      'native-resize-to',
      collapsed.value ? collapsedW.value : size.value.w,
      collapsed.value ? collapsedH.value : size.value.h,
    );
  }
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
  const s = Math.max(0.5, Math.min(1.25, props.penpaScale || 1));
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
  window.addEventListener('pointerup', onWindowRenderBarPointerEnd);
  window.addEventListener('pointercancel', onWindowRenderBarPointerEnd);
  window.addEventListener('blur', onWindowDockBlur);
  window.addEventListener('resize', onWindowResize);
});

watch(
  [safeAreaInsets, () => props.globalScale],
  () => {
    clampPosition(false);
  },
  { deep: true },
);

watch(
  () => props.visible,
  (vis) => {
    if (!vis) {
      dockHovered.value = false;
      closeRenderBarMenus();
    }
    emitBounds();
  },
);

onBeforeUnmount(() => {
  finishDockDrag(false);
  cancelHoverClose();
  emit('bounds-change', { x: -100, y: -100, w: 0, h: 0 });
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  window.removeEventListener('pointerup', onWindowRenderBarPointerEnd);
  window.removeEventListener('pointercancel', onWindowRenderBarPointerEnd);
  window.removeEventListener('blur', onWindowDockBlur);
  window.removeEventListener('resize', onWindowResize);
  if (pollTimer) window.clearInterval(pollTimer);
});
</script>

<template>
  <!-- Keep mounted even when hidden so Penpa+ state & canvas never reset -->
  <section
    ref="dockEl"
    class="ac-dock"
    :class="{
      collapsed,
      hidden: !visible && !nativeWindowMode,
      'native-window': !!nativeWindowMode,
      animating: !isInteracting && !nativeWindowMode,
      focused: isFocusedDock,
      'linked-highlight': linkedHighlight,
    }"
    :data-grid-id="gridId"
    :style="
      nativeWindowMode
        ? {
            left: '4px',
            top: '4px',
            right: '4px',
            bottom: '4px',
            opacity: effectiveDockOpacity,
          }
        : {
            left: `${pos.x}px`,
            top: `${pos.y}px`,
            width: collapsed ? `${collapsedW}px` : `${size.w}px`,
            height: collapsed ? `${collapsedH}px` : `${size.h}px`,
            opacity: effectiveDockOpacity,
            zIndex: dockZIndex,
          }
    "
    @pointerenter="onDockPointerEnter"
    @pointerleave="onDockPointerLeave"
    @pointerdown="onDockPointerDown"
    @focusin="onDockFocusIn"
  >
    <header
      class="ac-dock-header"
      @pointerdown="startMove"
      @pointerenter="onHeaderPointerEnter"
      @pointerleave="onHeaderPointerLeave"
    >
      <div class="ac-dock-title" @dblclick.stop="startTitleRename">
        <span class="ac-dot" :class="{ ready: readyState }" />
        <input
          v-if="editingTitle"
          ref="titleInputEl"
          v-model="titleDraft"
          type="text"
          class="ac-dock-title-input"
          @click.stop
          @pointerdown.stop
          @dblclick.stop
          @keydown.stop
          @keydown.enter.prevent="commitTitleRename"
          @keydown.esc.prevent="cancelTitleRename"
          @focus="setAndroidKeyboardFocusable(true)"
          @blur="commitTitleRename"
        />
        <span v-else class="ac-dock-title-text">{{ title || 'Penpa+' }}</span>
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
    </header>

    <!-- Per-grid render settings sub-bar (expands on title bar hover, floats over body with zero layout shift) -->
    <div
      v-if="!collapsed"
      class="ac-dock-render-bar"
      :class="{ open: renderBarOpen }"
      :inert="!renderBarOpen"
      @pointerenter="onRenderBarPointerEnter"
      @pointerleave="onRenderBarPointerLeave"
      @pointerdown="onRenderBarPointerDown"
    >
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
              size="sm"
              width="86px"
              :format-value="formatPercent"
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
        :data-grid-id="gridId"
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

.ac-dock.focused {
  border-color: color-mix(in srgb, var(--md-sys-color-primary) 58%, var(--md-sys-color-outline-variant));
}

.ac-dock.linked-highlight {
  outline: 2px dashed var(--md-sys-color-primary);
  outline-offset: 2px;
}

.ac-dock.animating {
  transition:
    width 0.24s cubic-bezier(0.2, 0, 0, 1),
    height 0.24s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.2s cubic-bezier(0.2, 0, 0, 1);
}

.ac-dock.hidden {
  visibility: hidden;
  pointer-events: none;
  left: -9999px !important;
}

.ac-dock-header {
  position: relative;
  z-index: 22;
  height: 36px;
  flex-shrink: 0;
  zoom: var(--ac-ui-scale, 1);
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
  flex: 1 1 auto;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  color: var(--md-sys-color-on-surface);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ac-dock-title-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-dock-title-input {
  flex: 1 1 auto;
  min-width: 64px;
  max-width: 240px;
  height: 22px;
  padding: 0 7px;
  border-radius: 6px;
  border: 1px solid var(--md-sys-color-primary);
  background: var(--md-sys-color-surface-container-low);
  color: var(--md-sys-color-on-surface);
  font-size: 12px;
  font-weight: 600;
  outline: none;
  user-select: text;
  -webkit-user-select: text;
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

.ac-dock-btns {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
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
  position: absolute;
  top: 36px;
  left: 0;
  right: 0;
  z-index: 21;
  zoom: var(--ac-ui-scale, 1);
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 10px;
  background: color-mix(in srgb, var(--md-sys-color-surface-container-high) 96%, transparent);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.36);
  opacity: 0;
  transform: translateY(-8px);
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity 0.16s cubic-bezier(0.2, 0, 0, 1),
    transform 0.18s cubic-bezier(0.2, 0, 0, 1),
    visibility 0.18s linear;
}

.ac-dock-render-bar.open {
  opacity: 1;
  transform: translateY(0);
  visibility: visible;
  pointer-events: auto;
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
