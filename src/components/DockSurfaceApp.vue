<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import PenpaDockWindow from './PenpaDockWindow.vue';
import type { PenpaIframeBridge } from '../core/penpaBridge';
import type { BlendRenderMode } from '../core/webglOverlay';
import { getCurrentMd3Tokens } from '../core/theme';
import { messages } from '../core/i18n';
import { openExternalLink, getInitialIsDebugBuild, getIsDebugBuild } from '../core/platform';
import {
  endNativeSurfaceDrag,
  getSharedMultiMonitorHost,
  parseCurrentWindowRole,
  pushGridFrameRgba,
  relayWorldCommand,
  setNativeSurfaceBounds,
  startNativeSurfaceDrag,
} from '../core/multiMonitor';
import type { GridBoundsNormalized } from '../core/penpaBridge';
import type {
  PenpaInputMessage,
  SerializedGridElement,
  WorldCommand,
  WorldStateSnapshot,
} from '../core/worldSync';

const roleInfo = parseCurrentWindowRole();
const gridId = roleInfo.gridId || 'grid_primary';
const surfaceId = roleInfo.surfaceId || `dock-${gridId}`;

const snapshot = ref<WorldStateSnapshot | null>(null);
const bridgeRef = ref<PenpaIframeBridge | null>(null);
const logicalSize = ref({ w: 660, h: 420 });
const physOrigin = ref({ x: 80, y: 80 });

let frameSeq = 0;
let pushPending = false;
let pushInFlight = false;
let dirtyWhileInFlight = false;
let usingZeroCopySharedHost = false;
let lastPushAt = 0;
let pushTimer = 0;
let unsubscribeBridge: (() => void) | null = null;
let scratchCanvas: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;
let lastSentBounds: GridBoundsNormalized | null = null;
const NATIVE_SURFACE_PAD = 8;

const gridElement = computed<SerializedGridElement | null>(() => {
  const list = snapshot.value?.elements ?? [];
  const found = list.find((e): e is SerializedGridElement => e.kind === 'grid' && e.id === gridId);
  return found ?? null;
});

const visibleDockCount = computed(() => {
  const list = snapshot.value?.elements ?? [];
  return list.filter((e): e is SerializedGridElement => e.kind === 'grid' && e.dockVisible).length;
});

const isLinkedHighlight = computed(() => {
  if (visibleDockCount.value < 2 || !snapshot.value) return false;
  return snapshot.value.selectedTargetIds.includes(gridId);
});

watch(
  () => snapshot.value?.globalScale,
  (s) => {
    const clamped = Math.max(0.7, Math.min(1.5, Number.isFinite(s) ? (s as number) : 1));
    document.documentElement.style.setProperty('--ac-ui-scale', String(clamped));
  },
  { immediate: true },
);

function sendCmd(cmd: WorldCommand) {
  void relayWorldCommand(cmd);
}

function reportBoundsIfChanged(b: PenpaIframeBridge) {
  const bounds = b.getGridBoundsNormalized();
  const prev = lastSentBounds;
  if (
    !prev ||
    Math.abs(bounds.u0 - prev.u0) > 1e-4 ||
    Math.abs(bounds.v0 - prev.v0) > 1e-4 ||
    Math.abs(bounds.u1 - prev.u1) > 1e-4 ||
    Math.abs(bounds.v1 - prev.v1) > 1e-4 ||
    Math.abs(bounds.canvasCssW - prev.canvasCssW) > 0.5 ||
    Math.abs(bounds.canvasCssH - prev.canvasCssH) > 0.5
  ) {
    lastSentBounds = bounds;
    sendCmd({ type: 'dock-grid-bounds', gridId, bounds });
  }
}

async function captureAndPushFrameNow() {
  const b = bridgeRef.value;
  if (!b || !b.isReady()) return;
  reportBoundsIfChanged(b);
  // Zero-copy same-renderer mode: `main` and all `overlay-*` consume `b.getCanvas()` directly on GPU!
  // Zero `getImageData` CPU readback, zero IPC byte copies!
  if (usingZeroCopySharedHost) return;

  if (pushInFlight) {
    dirtyWhileInFlight = true;
    return;
  }
  const src = b.getCanvas();
  if (!src || src.width <= 0 || src.height <= 0) return;

  const w = src.width;
  const h = src.height;
  let rgba: Uint8Array | null = null;
  try {
    const srcCtx = src.getContext('2d', { willReadFrequently: true });
    if (srcCtx) {
      rgba = new Uint8Array(srcCtx.getImageData(0, 0, w, h).data.buffer);
    }
  } catch {
    rgba = null;
  }
  if (!rgba) {
    if (!scratchCanvas) {
      scratchCanvas = document.createElement('canvas');
      scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!scratchCtx) return;
    if (scratchCanvas.width !== w || scratchCanvas.height !== h) {
      scratchCanvas.width = w;
      scratchCanvas.height = h;
    }
    scratchCtx.clearRect(0, 0, w, h);
    scratchCtx.drawImage(src, 0, 0);
    rgba = new Uint8Array(scratchCtx.getImageData(0, 0, w, h).data.buffer);
  }

  frameSeq += 1;
  lastPushAt = performance.now();
  pushInFlight = true;
  try {
    await pushGridFrameRgba(gridId, frameSeq, w, h, rgba);
  } finally {
    pushInFlight = false;
    if (dirtyWhileInFlight) {
      dirtyWhileInFlight = false;
      scheduleDirtyFramePush();
    }
  }
}

// Event-driven dirty frame scheduler (never depends on rAF so hidden dock windows stay 60fps!)
function scheduleDirtyFramePush() {
  const b = bridgeRef.value;
  if (usingZeroCopySharedHost) {
    if (b && b.isReady()) reportBoundsIfChanged(b);
    return;
  }
  if (pushInFlight) {
    dirtyWhileInFlight = true;
    return;
  }
  if (pushPending) return;
  const elapsed = performance.now() - lastPushAt;
  if (elapsed >= 16) {
    pushPending = true;
    queueMicrotask(() => {
      pushPending = false;
      void captureAndPushFrameNow();
    });
    return;
  }
  pushPending = true;
  if (pushTimer) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    pushTimer = 0;
    pushPending = false;
    void captureAndPushFrameNow();
  }, Math.max(4, Math.round(16 - elapsed)));
}

function handleBridgeReady(b: PenpaIframeBridge) {
  bridgeRef.value = b;
  b.setMd3Tokens?.(getCurrentMd3Tokens());
  const sharedHost = getSharedMultiMonitorHost();
  usingZeroCopySharedHost = !!sharedHost;
  if (sharedHost) {
    sharedHost.registerDockBridge(gridId, b);
  }
  if (unsubscribeBridge) unsubscribeBridge();
  unsubscribeBridge = b.subscribe(() => {
    scheduleDirtyFramePush();
  });
  void captureAndPushFrameNow();
  sendCmd({ type: 'dock-ready', gridId });
}

function handlePenpaInput(msg: PenpaInputMessage) {
  const b = bridgeRef.value;
  if (!b) return;
  switch (msg.type) {
    case 'pointer':
      if (b.isReady()) {
        b.dispatchPointer(msg.eventType, msg.u, msg.v, msg.opts);
        scheduleDirtyFramePush();
      }
      break;
    case 'key':
      if (b.isReady()) {
        b.dispatchKey(msg.eventType, msg);
        scheduleDirtyFramePush();
      }
      break;
    case 'sync-theme':
      if (msg.tokens) {
        const rootStyle = document.documentElement.style;
        for (const [k, v] of Object.entries(msg.tokens)) {
          rootStyle.setProperty(k, v);
        }
      }
      b.setMd3Tokens?.(msg.tokens);
      b.setCustomCss?.(msg.customCss);
      b.setLanguage?.(msg.lang);
      break;
    case 'save-draft':
      b.saveDraftNow?.();
      break;
    case 'suppress-draft':
      b.suppressDraftSave?.();
      break;
    case 'force-redraw':
      b.forceRedraw?.();
      scheduleDirtyFramePush();
      break;
  }
}

async function syncInitialWindowPos() {
  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const win = getCurrentWebviewWindow();
    const pos = await win.outerPosition();
    physOrigin.value = { x: pos.x, y: pos.y };
  } catch {
    // ignore
  }
}

function handleNativeDragStart(w: number, h: number) {
  logicalSize.value = { w, h };
  void startNativeSurfaceDrag(surfaceId, w + NATIVE_SURFACE_PAD, h + NATIVE_SURFACE_PAD);
}

function handleNativeDragEnd() {
  void endNativeSurfaceDrag();
  void syncInitialWindowPos();
}

function handleNativeMoveDelta(dxCss: number, dyCss: number) {
  const scale = window.devicePixelRatio || 1;
  physOrigin.value = {
    x: Math.round(physOrigin.value.x + dxCss * scale),
    y: Math.round(physOrigin.value.y + dyCss * scale),
  };
  void setNativeSurfaceBounds({
    surfaceId,
    physX: physOrigin.value.x,
    physY: physOrigin.value.y,
    logicalW: logicalSize.value.w + NATIVE_SURFACE_PAD,
    logicalH: logicalSize.value.h + NATIVE_SURFACE_PAD,
  });
}

function handleNativeResizeTo(w: number, h: number) {
  logicalSize.value = { w, h };
  void setNativeSurfaceBounds({
    surfaceId,
    logicalW: w + NATIVE_SURFACE_PAD,
    logicalH: h + NATIVE_SURFACE_PAD,
  });
}

let isDebugBuild = getInitialIsDebugBuild();
window.__PENPAANYWHERE_IS_DEBUG__ = isDebugBuild;
function onWindowContextMenu(e: MouseEvent) {
  if (!isDebugBuild) e.preventDefault();
}

const unlisteners: Array<() => void> = [];

onMounted(async () => {
  window.addEventListener('contextmenu', onWindowContextMenu);
  isDebugBuild = await getIsDebugBuild();
  window.__PENPAANYWHERE_IS_DEBUG__ = isDebugBuild;
  await syncInitialWindowPos();

  window.__PENPAANYWHERE_ON_IFRAME_INTERACT__ = () => {
    sendCmd({ type: 'dock-activate', gridId });
  };
  window.__PENPAANYWHERE_CLONE_GRID__ = (_srcId: string, penpaParam: string) => {
    sendCmd({ type: 'dock-clone', gridId, penpaParam });
  };
  window.__PENPAANYWHERE_OPEN_EXTERNAL__ = (url: string) => {
    void openExternalLink(url);
  };
  window.__PENPAANYWHERE_DOWNLOAD__ = (filename: string, mimeType: string, base64Data: string) => {
    sendCmd({ type: 'dock-download', filename, mimeType, base64Data });
  };
  window.__PENPAANYWHERE_PREVIEW_IMAGE__ = (dataUrl: string, filename: string, mimeType: string) => {
    sendCmd({ type: 'dock-preview-image', dataUrl, filename, mimeType });
  };

  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const curWin = getCurrentWebviewWindow();
    const winLabel = curWin.label;

    unlisteners.push(
      await curWin.listen<WorldStateSnapshot>('world-state', (ev) => {
        if (ev.payload) snapshot.value = ev.payload;
      }),
    );
    unlisteners.push(
      await curWin.listen<PenpaInputMessage>('penpa-input', (ev) => {
        if (ev.payload) handlePenpaInput(ev.payload);
      }),
    );
    unlisteners.push(
      await curWin.listen<Record<string, string>>('app-theme-sync', (ev) => {
        if (ev.payload) {
          const rootStyle = document.documentElement.style;
          for (const [k, v] of Object.entries(ev.payload)) {
            rootStyle.setProperty(k, v);
          }
          bridgeRef.value?.setMd3Tokens?.(ev.payload);
        }
      }),
    );
    unlisteners.push(
      await curWin.listen('surface-drag-ended', () => {
        void syncInitialWindowPos();
      }),
    );

    sendCmd({ type: 'request-snapshot', fromLabel: winLabel });
  } catch {
    // ignore
  }
});

onBeforeUnmount(() => {
  getSharedMultiMonitorHost()?.unregisterDockBridge(gridId);
  window.removeEventListener('contextmenu', onWindowContextMenu);
  if (pushTimer) window.clearTimeout(pushTimer);
  if (unsubscribeBridge) unsubscribeBridge();
  for (const un of unlisteners) un();
});
</script>

<template>
  <main class="ac-root">
    <PenpaDockWindow
      :grid-id="gridId"
      :visible="gridElement?.dockVisible ?? true"
      :native-window-mode="true"
      :title="gridElement?.label || messages.stage.gridDefaultLabel"
      :label="gridElement?.label || ''"
      :dock-z-index="1"
      :dock-index="0"
      :is-focused-dock="snapshot?.focusedDockId === gridId"
      :linked-highlight="isLinkedHighlight"
      :backdrop-mode="snapshot?.backdropMode ?? 'overlay'"
      :blend-mode="(gridElement?.blendMode ?? 'alpha-minrgb') as BlendRenderMode"
      :board-opacity="gridElement?.opacity ?? 1"
      :enhance-opacity="gridElement?.enhanceOpacity ?? false"
      :show-unavailable-options="snapshot?.showUnavailableOptions ?? false"
      :global-scale="snapshot?.globalScale ?? 1"
      :penpa-scale="snapshot?.penpaScale ?? 1"
      :blur-opacity="snapshot?.penpaBlurOpacity ?? 0.85"
      @activate="sendCmd({ type: 'dock-activate', gridId })"
      @rename="(label) => sendCmd({ type: 'dock-rename', gridId, label })"
      @dock-state-change="(st) => sendCmd({ type: 'dock-state-change', gridId, state: st })"
      @native-drag-start="handleNativeDragStart"
      @native-drag-end="handleNativeDragEnd"
      @native-move-delta="handleNativeMoveDelta"
      @native-resize-to="handleNativeResizeTo"
      @update:visible="(v) => sendCmd({ type: 'dock-visible', gridId, visible: v })"
      @update:blend-mode="(v) => sendCmd({ type: 'dock-render-patch', gridId, patch: { blendMode: v } })"
      @update:board-opacity="(v) => sendCmd({ type: 'dock-render-patch', gridId, patch: { opacity: v } })"
      @update:enhance-opacity="(v) => sendCmd({ type: 'dock-render-patch', gridId, patch: { enhanceOpacity: v } })"
      @unavailable-click="(k) => sendCmd({ type: 'dock-unavailable', key: k })"
      @bridge-ready="handleBridgeReady"
    />
  </main>
</template>
