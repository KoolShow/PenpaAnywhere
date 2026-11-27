<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ControlBar, { type UnavailableReasonKey } from './components/ControlBar.vue';
import CanvasStage from './components/CanvasStage.vue';
import MediaElementView from './components/MediaElementView.vue';
import PerspectiveOverlay from './components/PerspectiveOverlay.vue';
import TransformGizmo from './components/TransformGizmo.vue';
import PenpaDockWindow from './components/PenpaDockWindow.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import { isPointInQuad, rectToQuad, type Point2D } from './core/homography';
import type { BlendRenderMode } from './core/webglOverlay';
import type { GridBoundsNormalized, PenpaIframeBridge } from './core/penpaBridge';
import { DEFAULT_PENPA_MD3_CSS } from './core/defaultPenpaCss';
import { DEFAULT_TOGGLE_HOTKEY, type HotkeyBinding } from './core/hotkey';
import { getCurrentMd3Tokens } from './core/theme';
import { safeAreaInsets } from './core/safeArea';
import { beginGlobalDrag, endGlobalDrag, tryCapturePointer, tryReleasePointer } from './core/dragGuard';
import { currentLocale, getPenpaLangCode, messages } from './core/i18n';
import {
  IDENTITY_VIEWPORT_TRANSFORM,
  ROOT_WORLD_ID,
  panViewportBy,
  sanitizeViewportTransform,
  viewportToWorld,
  worldQuadToViewport,
  zoomViewportAt,
  type WorkspaceMode,
  type WorldViewportTransform,
} from './core/world';
import {
  cloneQuad,
  computeInitialItemWorldRect,
  convertElementQuadMode,
  createCropDraft,
  createDefaultCrop,
  generateCanvasItemId,
  isElementPassThrough,
  isItemCropped,
  resetElementSizeCorners,
  sanitizeCrop,
  sanitizeQuad,
  toCanvasImageMeta,
  type CropDraft,
  type GridElement,
  type ImageElement,
  type QuadMode,
  type ScreenElement,
  type WorldElement,
} from './core/canvasItems';
import {
  deleteCanvasImageBlob,
  loadCanvasImageBlob,
  pruneCanvasImageBlobs,
  saveCanvasImageBlob,
} from './core/canvasMediaDb';
import {
  closeOverlayApp,
  detectPlatform,
  setOsAlwaysOnTop,
  setOsClickThrough,
  setOsFullscreenOverlay,
  supportsNativeTransparentOverlay,
  supportsOverlaySwitch,
  supportsScreenCapture,
  switchAndroidToImageActivity,
  switchAndroidToOverlayService,
  type AndroidScreenshotCompositeStatus,
} from './core/platform';
import {
  flushPersistedStateNow,
  loadPersistedState,
  patchPersistedState,
} from './core/storage';

const PRIMARY_GRID_ID = 'grid_primary';

const platform = detectPlatform();
const canNativeOverlay = supportsNativeTransparentOverlay(platform);
const canSwitchOverlay = supportsOverlaySwitch(platform);
const canScreenCapture = supportsScreenCapture();
const savedState = loadPersistedState();

const VALID_BLEND_MODES: ReadonlySet<BlendRenderMode> = new Set([
  'multiply',
  'multiply-inv',
  'alpha-luma',
  'alpha-luma-inv',
  'alpha-minrgb',
  'alpha-minrgb-inv',
]);

// Window presentation mode: 'overlay' = transparent always-on-top window; 'canvas' = normal window/web page
const backdropMode = ref<WorkspaceMode>(canNativeOverlay ? 'overlay' : 'canvas');

function resolveInitialBlendMode(): BlendRenderMode {
  let mode: BlendRenderMode =
    savedState.blendMode && VALID_BLEND_MODES.has(savedState.blendMode)
      ? savedState.blendMode
      : 'alpha-minrgb';
  if (canNativeOverlay) {
    if (mode === 'multiply') mode = 'alpha-minrgb';
    else if (mode === 'multiply-inv') mode = 'alpha-minrgb-inv';
  }
  return mode;
}

function makeDefaultCorners(
  vp: WorldViewportTransform = IDENTITY_VIEWPORT_TRANSFORM,
): [Point2D, Point2D, Point2D, Point2D] {
  const safe = safeAreaInsets.value;
  const w = window.innerWidth || 1280;
  const h = window.innerHeight || 800;
  const safeW = Math.max(120, w - safe.left - safe.right);
  const safeH = Math.max(120, h - safe.top - safe.bottom);
  const isPortrait = safeH > safeW;
  const side = isPortrait ? Math.min(safeW, safeH) * 0.72 : Math.min(safeW, safeH) * 0.52;
  const cx = isPortrait
    ? safe.left + safeW * 0.5
    : safeW >= 1150
      ? Math.min(w - safe.right - side * 0.56, safe.left + safeW * 0.68)
      : safe.left + safeW * 0.5;
  const cy = isPortrait
    ? Math.max(safe.top + side * 0.5 + 96, safe.top + safeH * 0.39)
    : safe.top + safeH * 0.53;
  const half = side * 0.5;
  return [
    viewportToWorld({ x: cx - half, y: cy - half }, vp),
    viewportToWorld({ x: cx + half, y: cy - half }, vp),
    viewportToWorld({ x: cx + half, y: cy + half }, vp),
    viewportToWorld({ x: cx - half, y: cy + half }, vp),
  ];
}

function loadInitialWorldCorners(): [Point2D, Point2D, Point2D, Point2D] {
  const fromWorld = sanitizeQuad(savedState.worldCorners);
  if (fromWorld) return fromWorld;

  // One-time migration from legacy viewport-normalized cornersNorm
  const norm = savedState.cornersNorm;
  if (Array.isArray(norm) && norm.length === 4) {
    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 800;
    const safe = safeAreaInsets.value;
    const minX = safe.left + 8;
    const maxX = Math.max(minX + 48, w - safe.right - 8);
    const minY = safe.top + 8;
    const maxY = Math.max(minY + 48, h - safe.bottom - 8);
    const scaled = norm.map((p) => ({
      x: Math.max(minX, Math.min(maxX, p.x * w)),
      y: Math.max(minY, Math.min(maxY, p.y * h)),
    }));
    const valid = sanitizeQuad(scaled);
    if (valid) return valid;
  }
  return makeDefaultCorners();
}

function createPrimaryGridElement(): GridElement {
  const initialLocked =
    typeof savedState.gridLocked === 'boolean'
      ? savedState.gridLocked
      : savedState.calibrating === undefined
        ? false
        : !savedState.calibrating;
  return {
    id: PRIMARY_GRID_ID,
    kind: 'grid',
    worldId: ROOT_WORLD_ID,
    label: '',
    corners: loadInitialWorldCorners(),
    quadMode: savedState.quadMode ?? 'rect',
    crop: sanitizeCrop(savedState.gridCrop),
    blendMode: resolveInitialBlendMode(),
    opacity:
      typeof savedState.opacity === 'number' && savedState.opacity >= 0.1 && savedState.opacity <= 1
        ? savedState.opacity
        : 1.0,
    dockVisible: savedState.dockVisible ?? true,
    visible: savedState.canvasVisible ?? true,
    locked: initialLocked,
    passThrough: !!savedState.gridPassThrough,
    zIndex: typeof savedState.gridZIndex === 'number' && Number.isFinite(savedState.gridZIndex)
      ? savedState.gridZIndex
      : 10,
  };
}

// ONE unified store for ALL World Elements (grids, images, screen projections) sharing one zIndex axis!
const elements = ref<WorldElement[]>([createPrimaryGridElement()]);
const screenStreams = ref<Map<string, MediaStream>>(new Map());
let itemsHydrated = false;

const overlayFullCanvas = ref(savedState.overlayFullCanvas ?? false);
const fullCanvasEnabled = computed(
  () => backdropMode.value === 'canvas' || overlayFullCanvas.value,
);

const gridElements = computed<GridElement[]>(() =>
  elements.value.filter((e): e is GridElement => e.kind === 'grid'),
);
const primaryGrid = computed<GridElement>(() => gridElements.value[0]);

const sortedVisibleElements = computed<WorldElement[]>(() =>
  [...elements.value]
    .filter((e) => e.visible && (fullCanvasEnabled.value || e.kind === 'grid'))
    .sort((a, b) => a.zIndex - b.zIndex),
);

// World -> Viewport transform (Overlay locked to identity; Canvas allows pan & zoom)
const canvasViewport = ref<WorldViewportTransform>(
  sanitizeViewportTransform(savedState.canvasViewport),
);
const effectiveViewportTransform = computed<WorldViewportTransform>(() =>
  backdropMode.value === 'canvas' ? canvasViewport.value : IDENTITY_VIEWPORT_TRANSFORM,
);

const selectedElementId = ref<string | null>(
  primaryGrid.value.visible && !primaryGrid.value.locked ? primaryGrid.value.id : null,
);
const hoveredLockedId = ref<string | null>(null);
const cropDraft = ref<CropDraft | null>(null);
const alwaysOnTop = ref(false);
const spacePanning = ref(false);
const layersVisible = ref(savedState.layersWindow?.open ?? false);

watch(alwaysOnTop, (pinned) => {
  void setOsAlwaysOnTop(pinned);
});

function startCropMode(id: string) {
  const el = elements.value.find((e) => e.id === id);
  if (!el || el.locked || !el.visible) return;
  selectedElementId.value = id;
  cropDraft.value = createCropDraft(el);
}

function updateCropDraft(draft: CropDraft) {
  if (!cropDraft.value || cropDraft.value.elementId !== draft.elementId) return;
  cropDraft.value = draft;
}

function commitCropDraft() {
  const draft = cropDraft.value;
  if (!draft) return;
  const el = elements.value.find((e) => e.id === draft.elementId);
  cropDraft.value = null;
  if (!el) return;
  if (el.quadMode === 'free') {
    updateElement(el.id, { crop: { ...draft.crop } });
  } else {
    updateElement(el.id, {
      crop: { ...draft.crop },
      corners: rectToQuad(draft.croppedRect),
    });
  }
}

function cancelCropDraft() {
  cropDraft.value = null;
}

watch(fullCanvasEnabled, (enabled) => {
  if (!enabled) {
    layersVisible.value = false;
    if (cropDraft.value) {
      const target = elements.value.find((e) => e.id === cropDraft.value?.elementId);
      if (target && target.kind !== 'grid') cancelCropDraft();
    }
    if (selectedElementId.value) {
      const sel = elements.value.find((e) => e.id === selectedElementId.value);
      if (sel && sel.kind !== 'grid') selectElement(null);
    }
    if (hoveredLockedId.value) {
      const hov = elements.value.find((e) => e.id === hoveredLockedId.value);
      if (hov && hov.kind !== 'grid') clearHoverLocked();
    }
  }
});

const selectedElement = computed<WorldElement | null>(() => {
  if (!selectedElementId.value) return null;
  const el = elements.value.find((e) => e.id === selectedElementId.value) ?? null;
  if (!el || !el.visible || (!fullCanvasEnabled.value && el.kind !== 'grid')) return null;
  return el;
});

const hoveredLockedElement = computed<WorldElement | null>(() => {
  if (!hoveredLockedId.value) return null;
  const el = elements.value.find((e) => e.id === hoveredLockedId.value) ?? null;
  if (!el || !el.visible || !el.locked || (!fullCanvasEnabled.value && el.kind !== 'grid')) return null;
  return el;
});

const showUnavailableOptions = ref(savedState.showUnavailableOptions ?? false);
const settingsOpen = ref(false);
const unavailableReasonKey = ref<UnavailableReasonKey | null>(null);
const hotkeyRecording = ref(false);
const screenshotPromptOpen = ref(false);
const screenshotPromptFile = ref('');
const androidScreenshotStatus = ref<AndroidScreenshotCompositeStatus | null>(null);

const customCssEnabled = ref(savedState.customCssEnabled ?? true);
const customCss = ref(
  typeof savedState.customCss === 'string' ? savedState.customCss : DEFAULT_PENPA_MD3_CSS,
);
const toggleHotkey = ref<HotkeyBinding | null>(
  savedState.toggleHotkey === undefined ? { ...DEFAULT_TOGGLE_HOTKEY } : savedState.toggleHotkey,
);

// Per-grid runtime references (keyed by grid.id)
const overlayRefs = new Map<string, InstanceType<typeof PerspectiveOverlay>>();
const gridBridges = ref<Map<string, PenpaIframeBridge>>(new Map());
const gridBoundsMap = ref<Map<string, GridBoundsNormalized>>(new Map());
const gridOuterQuads = ref<Map<string, [Point2D, Point2D, Point2D, Point2D]>>(new Map());
const dockRects = ref<Map<string, { x: number; y: number; w: number; h: number }>>(new Map());

const fileInputEl = ref<HTMLInputElement | null>(null);
const barRect = ref({ x: 0, y: 0, w: 0, h: 0 });
const toolbarRect = ref({ x: 0, y: 0, w: 0, h: 0 });
const hoverToolbarRect = ref({ x: 0, y: 0, w: 0, h: 0 });

function setOverlayRef(gridId: string, inst: InstanceType<typeof PerspectiveOverlay> | null) {
  if (inst) overlayRefs.set(gridId, inst);
  else overlayRefs.delete(gridId);
}

function setGridBridge(gridId: string, b: PenpaIframeBridge) {
  const next = new Map(gridBridges.value);
  next.set(gridId, b);
  gridBridges.value = next;
  syncPenpaThemeAndCssForBridge(b);
}

function setGridBounds(gridId: string, bounds: GridBoundsNormalized) {
  const next = new Map(gridBoundsMap.value);
  next.set(gridId, bounds);
  gridBoundsMap.value = next;
}

function setGridOuterQuad(gridId: string, q: [Point2D, Point2D, Point2D, Point2D]) {
  const next = new Map(gridOuterQuads.value);
  next.set(gridId, q);
  gridOuterQuads.value = next;
}

function setDockRect(gridId: string, r: { x: number; y: number; w: number; h: number }) {
  const next = new Map(dockRects.value);
  next.set(gridId, r);
  dockRects.value = next;
}

const activeBridge = computed<PenpaIframeBridge | null>(() => {
  const sel = selectedElement.value;
  if (sel && sel.kind === 'grid') {
    return gridBridges.value.get(sel.id) ?? gridBridges.value.get(PRIMARY_GRID_ID) ?? null;
  }
  return gridBridges.value.get(PRIMARY_GRID_ID) ?? null;
});

// --- Unified Operations Shared by ALL Elements (Grid, Image, Screen) ---
function nextZIndex(): number {
  let maxZ = 0;
  for (const el of elements.value) {
    if (el.zIndex > maxZ) maxZ = el.zIndex;
  }
  return maxZ + 1;
}

function cancelHoverHideTimer() {
  // No-op: locked element hover now hides immediately on leave
}

function clearHoverLocked() {
  hoveredLockedId.value = null;
}

function scheduleHoverHide() {
  hoveredLockedId.value = null;
}

function selectElement(id: string | null) {
  if (selectedElementId.value !== id) {
    cancelCropDraft();
  }
  selectedElementId.value = id;
}

function handleLockElement(id: string) {
  const el = elements.value.find((e) => e.id === id);
  if (!el) return;
  if (cropDraft.value?.elementId === id) {
    cancelCropDraft();
  }
  updateElement(id, { locked: true });
}

function handleUnlockElement(id: string) {
  const el = elements.value.find((e) => e.id === id);
  if (!el) return;
  updateElement(id, { locked: false });
  clearHoverLocked();
  selectedElementId.value = id;
}

function updateElement(id: string, patch: Partial<WorldElement>) {
  elements.value = elements.value.map((el) =>
    el.id === id ? ({ ...el, ...patch } as WorldElement) : el,
  );
}

function updateElementCorners(id: string, corners: [Point2D, Point2D, Point2D, Point2D]) {
  updateElement(id, { corners });
}

function updateElementQuadMode(id: string, nextMode: QuadMode) {
  const el = elements.value.find((e) => e.id === id);
  if (!el) return;
  updateElement(id, convertElementQuadMode(el, nextMode));
}

function resetElementSize(id: string) {
  const el = elements.value.find((e) => e.id === id);
  if (!el) return;
  let natW = 440;
  let natH = 440;
  if (el.kind === 'grid') {
    const gb = gridBoundsMap.value.get(el.id);
    if (gb && gb.canvasCssW > 16 && gb.canvasCssH > 16) {
      natW = gb.canvasCssW;
      natH = gb.canvasCssH;
    }
  } else {
    natW = el.naturalW;
    natH = el.naturalH;
  }
  const nextCorners = resetElementSizeCorners(
    el,
    natW,
    natH,
    effectiveViewportTransform.value,
    window.innerWidth || 1280,
    window.innerHeight || 800,
    safeAreaInsets.value,
  );
  updateElement(id, { corners: nextCorners });
}

function bringElementFront(id: string) {
  updateElement(id, { zIndex: nextZIndex() });
}

function sendElementBack(id: string) {
  let minZ = Infinity;
  for (const el of elements.value) {
    if (el.zIndex < minZ) minZ = el.zIndex;
  }
  updateElement(id, { zIndex: Math.max(1, (Number.isFinite(minZ) ? minZ : 2) - 1) });
  // Normalize all zIndices >= 1 cleanly so nothing ever drops below checkerboard zIndex 0
  normalizeZIndices();
}

function normalizeZIndices() {
  const sorted = [...elements.value].sort((a, b) => a.zIndex - b.zIndex);
  const zById = new Map<string, number>();
  sorted.forEach((el, idx) => zById.set(el.id, idx + 1));
  elements.value = elements.value.map((el) => ({
    ...el,
    zIndex: zById.get(el.id) ?? el.zIndex,
  }));
}

function moveElementLayerOrder(id: string, dir: 'up' | 'down') {
  const sorted = [...elements.value].sort((a, b) => a.zIndex - b.zIndex);
  const idx = sorted.findIndex((e) => e.id === id);
  if (idx < 0) return;
  const swapIdx = dir === 'up' ? idx + 1 : idx - 1;
  if (swapIdx < 0 || swapIdx >= sorted.length) return;
  const reordered = [...sorted];
  const [moved] = reordered.splice(idx, 1);
  reordered.splice(swapIdx, 0, moved);
  const zById = new Map<string, number>();
  reordered.forEach((el, i) => zById.set(el.id, i + 1));
  elements.value = elements.value.map((el) => ({
    ...el,
    zIndex: zById.get(el.id) ?? el.zIndex,
  }));
}

function toggleElementVisible(id: string) {
  const el = elements.value.find((e) => e.id === id);
  if (!el) return;
  const nextVis = !el.visible;
  updateElement(id, { visible: nextVis });
  if (!nextVis && selectedElementId.value === id) selectElement(null);
}

function toggleElementLock(id: string) {
  const el = elements.value.find((e) => e.id === id);
  if (!el) return;
  if (el.locked) {
    handleUnlockElement(id);
  } else {
    handleLockElement(id);
  }
}

function toggleElementPassThrough(id: string) {
  const el = elements.value.find((e) => e.id === id);
  if (!el || !el.locked) return;
  updateElement(id, { passThrough: !el.passThrough });
}

function toggleGridDock(id: string) {
  const el = elements.value.find((e) => e.id === id);
  if (!el || el.kind !== 'grid') return;
  updateElement(id, { dockVisible: !el.dockVisible });
}

function removeElement(id: string) {
  const el = elements.value.find((e) => e.id === id);
  if (!el || el.kind === 'grid') return;
  if (el.kind === 'image') {
    if (el.src.startsWith('blob:')) URL.revokeObjectURL(el.src);
    void deleteCanvasImageBlob(el.id);
  } else {
    const stream = screenStreams.value.get(el.streamId);
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      const nextStreams = new Map(screenStreams.value);
      nextStreams.delete(el.streamId);
      screenStreams.value = nextStreams;
    }
  }
  elements.value = elements.value.filter((e) => e.id !== id);
  if (selectedElementId.value === id) selectElement(null);
}

// --- Persistence ---
  watch(
    [
      elements,
      canvasViewport,
      layersVisible,
      overlayFullCanvas,
      showUnavailableOptions,
      customCssEnabled,
      customCss,
      toggleHotkey,
    ],
    () => {
      const g = primaryGrid.value;
      const patch: Parameters<typeof patchPersistedState>[0] = {
        blendMode: g.blendMode,
        quadMode: g.quadMode,
        opacity: g.opacity,
        gridLocked: g.locked,
        gridPassThrough: g.passThrough,
        gridCrop: { ...g.crop },
        gridZIndex: g.zIndex,
        calibrating: !g.locked,
        dockVisible: g.dockVisible,
        canvasVisible: g.visible,
        layersWindow: { xRatio: 0, yRatio: 0, open: layersVisible.value },
        overlayFullCanvas: overlayFullCanvas.value,
        showUnavailableOptions: showUnavailableOptions.value,
        worldCorners: cloneQuad(g.corners),
        canvasViewport: { ...canvasViewport.value },
        customCssEnabled: customCssEnabled.value,
        customCss: customCss.value,
        toggleHotkey: toggleHotkey.value,
      };
      if (itemsHydrated) {
        patch.canvasItems = elements.value
          .filter((e): e is ImageElement => e.kind === 'image')
          .map(toCanvasImageMeta);
      }
      patchPersistedState(patch);
    },
    { deep: true },
  );

function syncPenpaThemeAndCssForBridge(b: PenpaIframeBridge) {
  b.setMd3Tokens?.(getCurrentMd3Tokens());
  b.setCustomCss?.(customCssEnabled.value ? customCss.value : '');
  b.setLanguage?.(getPenpaLangCode(currentLocale.value));
}

function syncAllPenpaThemeAndCss() {
  for (const b of gridBridges.value.values()) {
    syncPenpaThemeAndCssForBridge(b);
  }
}

watch([customCssEnabled, customCss], () => {
  syncAllPenpaThemeAndCss();
});

watch(currentLocale, (loc) => {
  const code = getPenpaLangCode(loc);
  for (const b of gridBridges.value.values()) {
    b.setLanguage?.(code);
  }
});

function flushAllStateNow() {
  flushPersistedStateNow();
  for (const b of gridBridges.value.values()) {
    b.saveDraftNow?.();
  }
}

async function handleCloseOverlay() {
  flushAllStateNow();
  await closeOverlayApp();
}

const hasDomBackdrop = computed(() => backdropMode.value === 'canvas');

const unavailableDialogInfo = computed<{ title: string; body: string } | null>(() => {
  const key = unavailableReasonKey.value;
  if (!key) return null;
  const u = messages.value.unavailable;
  switch (key) {
    case 'multiplyOverlay':
      return { title: u.multiplyOverlayTitle, body: u.multiplyOverlayBody };
    case 'overlayWeb':
      return { title: u.overlayWebTitle, body: u.overlayWebBody };
    case 'screenUnsupported':
      return { title: u.screenUnsupportedTitle, body: u.screenUnsupportedBody };
    case 'clickThroughUnavailable':
      return { title: u.clickThroughUnavailableTitle, body: u.clickThroughUnavailableBody };
    case 'androidShotUnavailable':
      return { title: u.androidShotUnavailableTitle, body: u.androidShotUnavailableBody };
    case 'dynamicColorUnavailable':
      return { title: u.dynamicColorUnavailableTitle, body: u.dynamicColorUnavailableBody };
    case 'penpaCloneUnsupported':
      return { title: u.penpaCloneUnsupportedTitle, body: u.penpaCloneUnsupportedBody };
  }
});

function handleUnavailableClick(key: UnavailableReasonKey) {
  unavailableReasonKey.value = key;
}

function handleBackdropModeUpdate(next: WorkspaceMode) {
  if (next === backdropMode.value) return;
  if (platform === 'android-overlay' && next === 'canvas') {
    flushAllStateNow();
    if (switchAndroidToImageActivity()) return;
  }
  if (platform === 'android-app' && next === 'overlay') {
    flushAllStateNow();
    if (switchAndroidToOverlayService()) return;
  }
  backdropMode.value = next;
}

watch(backdropMode, async (mode) => {
  if (mode === 'overlay') {
    for (const g of gridElements.value) {
      if (g.blendMode === 'multiply') {
        updateElement(g.id, { blendMode: 'alpha-minrgb' });
      } else if (g.blendMode === 'multiply-inv') {
        updateElement(g.id, { blendMode: 'alpha-minrgb-inv' });
      }
    }
    await setOsFullscreenOverlay(true);
  } else {
    await setOsClickThrough(false);
    await setOsFullscreenOverlay(false);
  }
});

// Sync interactive regions to Windows (Tauri 2) and Android (OverlayService)
// ALL visible non-passing elements (grids, images, screens) register their viewport quad!
// ALL UI floating windows (ControlBar, PenpaDockWindow(s), LayersWindow, ElementToolbar) never pass through!
async function syncOverlayHitRegions() {
  const modalBlocking = settingsOpen.value || screenshotPromptOpen.value || !!unavailableReasonKey.value;
  const g = primaryGrid.value;
  const primaryDock =
    g.dockVisible && (dockRects.value.get(g.id)?.w ?? 0) > 0
      ? dockRects.value.get(g.id)!
      : { x: 0, y: 0, w: 0, h: 0 };

  const extraUiRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  if (selectedElement.value && toolbarRect.value.w > 0 && toolbarRect.value.h > 0) {
    extraUiRects.push(toolbarRect.value);
  }
  if (hoveredLockedElement.value && hoverToolbarRect.value.w > 0 && hoverToolbarRect.value.h > 0) {
    extraUiRects.push(hoverToolbarRect.value);
  }
  for (const grid of gridElements.value) {
    if (grid.id === g.id) continue;
    const dr = dockRects.value.get(grid.id);
    if (grid.dockVisible && dr && dr.w > 0 && dr.h > 0) {
      extraUiRects.push(dr);
    }
  }

  const interactiveQuads: Array<[Point2D, Point2D, Point2D, Point2D]> = [];
  for (const el of sortedVisibleElements.value) {
    if (isElementPassThrough(el)) continue;
    if (el.kind === 'grid') {
      const q =
        gridOuterQuads.value.get(el.id) ??
        worldQuadToViewport(el.corners, effectiveViewportTransform.value);
      interactiveQuads.push(q);
    } else {
      interactiveQuads.push(worldQuadToViewport(el.corners, effectiveViewportTransform.value));
    }
  }

  if (platform === 'tauri') {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('update_hit_regions', {
        enabled: backdropMode.value === 'overlay' && !modalBlocking,
        forceClickThrough: false,
        barRect: barRect.value,
        dockRect: primaryDock,
        uiRects: extraUiRects,
        quads: interactiveQuads,
      });
    } catch {
      // Non-fatal in web/dev fallback
    }
    return;
  }

  if (platform === 'android-overlay' && window.AndroidOverlay?.updateHitRegions) {
    let boardRect = { x: 0, y: 0, w: 0, h: 0 };
    const androidHandlePts: Point2D[] = [];
    if (interactiveQuads.length > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const q of interactiveQuads) {
        for (const p of q) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
      }
      const pad = selectedElement.value && !selectedElement.value.locked ? 26 : 10;
      if (isFinite(minX) && maxX > minX && maxY > minY) {
        boardRect = {
          x: Math.max(0, minX - pad),
          y: Math.max(0, minY - pad),
          w: maxX - minX + pad * 2,
          h: maxY - minY + pad * 2,
        };
      }
    }
    if (selectedElement.value && !selectedElement.value.locked && !isElementPassThrough(selectedElement.value)) {
      const c = worldQuadToViewport(selectedElement.value.corners, effectiveViewportTransform.value);
      androidHandlePts.push(
        ...c,
        { x: (c[0].x + c[1].x) * 0.5, y: (c[0].y + c[1].y) * 0.5 },
        { x: (c[1].x + c[2].x) * 0.5, y: (c[1].y + c[2].y) * 0.5 },
        { x: (c[2].x + c[3].x) * 0.5, y: (c[2].y + c[3].y) * 0.5 },
        { x: (c[3].x + c[0].x) * 0.5, y: (c[3].y + c[0].y) * 0.5 },
      );
    }

    const payload = {
      passthroughEnabled: backdropMode.value === 'overlay' && !modalBlocking,
      forceClickThrough: false,
      calibrating: androidHandlePts.length > 0,
      viewportW: window.innerWidth || 1,
      viewportH: window.innerHeight || 1,
      barRect: barRect.value,
      dockRect: primaryDock,
      uiRects: extraUiRects,
      boardRect,
      quads: interactiveQuads,
      corners: androidHandlePts,
    };
    try {
      window.AndroidOverlay.updateHitRegions(JSON.stringify(payload));
    } catch {
      // ignore bridge errors
    }
  }
}

watch(settingsOpen, (open) => {
  if (open) refreshAndroidScreenshotStatus();
});

watch(
  [
    backdropMode,
    overlayFullCanvas,
    settingsOpen,
    screenshotPromptOpen,
    unavailableReasonKey,
    layersVisible,
    selectedElementId,
    hoveredLockedId,
    barRect,
    toolbarRect,
    hoverToolbarRect,
    dockRects,
    elements,
    gridOuterQuads,
  ],
  () => {
    syncOverlayHitRegions();
  },
  { deep: true },
);

function refreshAndroidScreenshotStatus() {
  if (platform !== 'android-overlay') return;
  try {
    const raw = window.AndroidOverlay?.getScreenshotCompositeStatus?.();
    if (raw) {
      androidScreenshotStatus.value = JSON.parse(raw) as AndroidScreenshotCompositeStatus;
    }
  } catch {}
}

function handleToggleAndroidScreenshotComposite(enabled: boolean) {
  window.AndroidOverlay?.setScreenshotCompositeEnabled?.(enabled);
  refreshAndroidScreenshotStatus();
}

function handleRequestAndroidAllFiles() {
  window.AndroidOverlay?.requestAllFilesPermission?.();
}

function handleRespondScreenshotPrompt(choice: 'enable' | 'dismiss' | 'later') {
  screenshotPromptOpen.value = false;
  window.AndroidOverlay?.respondScreenshotPrompt?.(choice);
  refreshAndroidScreenshotStatus();
}

// --- Adding & Hydrating Media Elements (Identical in BOTH Overlay & Canvas modes!) ---
function measureImageDimensions(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 800, h: img.naturalHeight || 600 });
    img.onerror = () => resolve({ w: 800, h: 600 });
    img.src = src;
  });
}

async function hydratePersistedImages() {
  const metas = savedState.canvasItems;
  if (!Array.isArray(metas) || metas.length === 0) {
    itemsHydrated = true;
    void pruneCanvasImageBlobs(new Set());
    return;
  }

  const restored: ImageElement[] = [];
  const keepIds = new Set<string>();
  for (const meta of metas) {
    if (!meta || meta.kind !== 'image' || typeof meta.id !== 'string') continue;
    const blob = await loadCanvasImageBlob(meta.id);
    if (!blob) continue;
    keepIds.add(meta.id);
    const src = URL.createObjectURL(blob);
    const fallbackRect = {
      x: typeof meta.x === 'number' && Number.isFinite(meta.x) ? meta.x : 120,
      y: typeof meta.y === 'number' && Number.isFinite(meta.y) ? meta.y : 120,
      w: typeof meta.w === 'number' && Number.isFinite(meta.w) ? meta.w : 480,
      h: typeof meta.h === 'number' && Number.isFinite(meta.h) ? meta.h : 360,
    };
    const corners = sanitizeQuad(meta.corners, fallbackRect) ?? rectToQuad(fallbackRect);
    restored.push({
      id: meta.id,
      kind: 'image',
      worldId: meta.worldId || ROOT_WORLD_ID,
      label: typeof meta.label === 'string' ? meta.label : '',
      corners,
      quadMode: meta.quadMode === 'free' ? 'free' : 'rect',
      naturalW: typeof meta.naturalW === 'number' && meta.naturalW > 0 ? meta.naturalW : 480,
      naturalH: typeof meta.naturalH === 'number' && meta.naturalH > 0 ? meta.naturalH : 360,
      crop: sanitizeCrop(meta.crop),
      zIndex: typeof meta.zIndex === 'number' && Number.isFinite(meta.zIndex) ? meta.zIndex : restored.length + 1,
      visible: meta.visible !== false,
      locked: !!meta.locked,
      passThrough: !!meta.passThrough,
      src,
    });
  }

  if (restored.length > 0) {
    elements.value = [...elements.value, ...restored];
    normalizeZIndices();
  }
  itemsHydrated = true;
  void pruneCanvasImageBlobs(
    new Set([
      ...keepIds,
      ...elements.value.filter((e): e is ImageElement => e.kind === 'image').map((e) => e.id),
    ]),
  );
}

function triggerImagePicker() {
  if (window.AndroidOverlay?.pickImage) {
    window.AndroidOverlay.pickImage();
    return;
  }
  fileInputEl.value?.click();
}

async function addImageBlob(blob: Blob, label = '') {
  const id = generateCanvasItemId('img');
  const src = URL.createObjectURL(blob);
  const { w: naturalW, h: naturalH } = await measureImageDimensions(src);
  const safe = safeAreaInsets.value;
  const rect = computeInitialItemWorldRect(
    naturalW,
    naturalH,
    effectiveViewportTransform.value,
    window.innerWidth || 1280,
    window.innerHeight || 800,
    safe.top,
    safe.right,
    safe.bottom,
    safe.left,
    elements.value.length - 1,
  );
  const item: ImageElement = {
    id,
    kind: 'image',
    worldId: ROOT_WORLD_ID,
    label,
    corners: rectToQuad(rect),
    quadMode: 'rect',
    naturalW,
    naturalH,
    crop: createDefaultCrop(),
    zIndex: nextZIndex(),
    visible: true,
    locked: false,
    passThrough: false,
    src,
  };
  elements.value = [...elements.value, item];
  selectElement(id);
  void saveCanvasImageBlob(id, blob);
}

async function addImageDataUrl(dataUrl: string, label = '') {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    await addImageBlob(blob, label);
  } catch {
    const id = generateCanvasItemId('img');
    const { w: naturalW, h: naturalH } = await measureImageDimensions(dataUrl);
    const safe = safeAreaInsets.value;
    const rect = computeInitialItemWorldRect(
      naturalW,
      naturalH,
      effectiveViewportTransform.value,
      window.innerWidth || 1280,
      window.innerHeight || 800,
      safe.top,
      safe.right,
      safe.bottom,
      safe.left,
      elements.value.length - 1,
    );
    const item: ImageElement = {
      id,
      kind: 'image',
      worldId: ROOT_WORLD_ID,
      label,
      corners: rectToQuad(rect),
      quadMode: 'rect',
      naturalW,
      naturalH,
      crop: createDefaultCrop(),
      zIndex: nextZIndex(),
      visible: true,
      locked: false,
      passThrough: false,
      src: dataUrl,
    };
    elements.value = [...elements.value, item];
    selectElement(id);
  }
}

function onFileSelected(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  for (const file of files) {
    if (file.type.startsWith('image/') || !file.type) {
      void addImageBlob(file, file.name);
    }
  }
  input.value = '';
}

function onDrop(e: DragEvent) {
  if (!fullCanvasEnabled.value) return;
  const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
  if (files.length === 0) return;
  e.preventDefault();
  for (const file of files) {
    void addImageBlob(file, file.name);
  }
}

function onDragOver(e: DragEvent) {
  if (!fullCanvasEnabled.value) return;
  if (e.dataTransfer?.types.includes('Files')) {
    e.preventDefault();
  }
}

function onPaste(e: ClipboardEvent) {
  if (!fullCanvasEnabled.value) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      if (blob) void addImageBlob(blob);
    }
  }
}

async function addScreenProjection() {
  if (!canScreenCapture) {
    handleUnavailableClick('screenUnsupported');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' } as MediaTrackConstraints,
      audio: false,
    });
    const id = generateCanvasItemId('scr');
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings?.();
    const naturalW = settings?.width && settings.width > 0 ? settings.width : 1280;
    const naturalH = settings?.height && settings.height > 0 ? settings.height : 720;
    const safe = safeAreaInsets.value;
    const rect = computeInitialItemWorldRect(
      naturalW,
      naturalH,
      effectiveViewportTransform.value,
      window.innerWidth || 1280,
      window.innerHeight || 800,
      safe.top,
      safe.right,
      safe.bottom,
      safe.left,
      elements.value.length - 1,
    );

    const nextStreams = new Map(screenStreams.value);
    nextStreams.set(id, stream);
    screenStreams.value = nextStreams;

    const item: ScreenElement = {
      id,
      kind: 'screen',
      worldId: ROOT_WORLD_ID,
      label: track?.label || '',
      streamId: id,
      corners: rectToQuad(rect),
      quadMode: 'rect',
      naturalW,
      naturalH,
      crop: createDefaultCrop(),
      zIndex: nextZIndex(),
      visible: true,
      locked: false,
      passThrough: false,
    };
    elements.value = [...elements.value, item];
    selectElement(id);

    track?.addEventListener('ended', () => {
      removeElement(id);
    });
  } catch {
    // User cancelled capture dialog
  }
}

function stopAllScreenStreams() {
  for (const stream of screenStreams.value.values()) {
    stream.getTracks().forEach((t) => t.stop());
  }
  screenStreams.value = new Map();
}

function isBlockingUiAt(x: number, y: number): boolean {
  const topEl = document.elementFromPoint(x, y);
  if (!topEl) return false;
  return !!topEl.closest(
    '.ac-control-bar, .ac-dock, .ac-settings-backdrop, .ac-prompt-backdrop, .ac-viewport-hud',
  );
}

function pointInPaddedRect(
  x: number,
  y: number,
  r: { x: number; y: number; w: number; h: number },
  pad: number,
): boolean {
  return (
    r.w > 0 &&
    r.h > 0 &&
    x >= r.x - pad &&
    x <= r.x + r.w + pad &&
    y >= r.y - pad &&
    y <= r.y + r.h + pad
  );
}

function evaluateLockedHoverAt(x: number, y: number) {
  if (settingsOpen.value || unavailableReasonKey.value || screenshotPromptOpen.value) {
    clearHoverLocked();
    return;
  }

  // 1. Keep current locked hover pinned while cursor is inside its floating toolbar
  //    or traveling through the tapered bridge corridor between the element and its toolbar.
  //    Leaving in any other direction hides immediately (0ms).
  const cur = hoveredLockedElement.value;
  if (cur) {
    const usePrimaryTb = selectedElement.value?.id === cur.id;
    const tbRect = usePrimaryTb ? toolbarRect.value : hoverToolbarRect.value;
    if (pointInPaddedRect(x, y, tbRect, 6)) {
      return;
    }
    if (tbRect.w > 0 && tbRect.h > 0 && !isBlockingUiAt(x, y)) {
      const vp = worldQuadToViewport(cur.corners, effectiveViewportTransform.value);
      const elMinX = Math.min(vp[0].x, vp[1].x, vp[2].x, vp[3].x);
      const elMaxX = Math.max(vp[0].x, vp[1].x, vp[2].x, vp[3].x);
      const elMinY = Math.min(vp[0].y, vp[1].y, vp[2].y, vp[3].y);
      const elMaxY = Math.max(vp[0].y, vp[1].y, vp[2].y, vp[3].y);
      const tbAbove = tbRect.y + tbRect.h <= elMinY + 6;
      const tbBelow = tbRect.y >= elMaxY - 6;
      if (tbAbove && y >= tbRect.y + tbRect.h - 4 && y <= elMinY + 4) {
        const span = Math.max(1, elMinY - (tbRect.y + tbRect.h));
        const t = Math.max(0, Math.min(1, (elMinY - y) / span));
        const baseL = Math.max(elMinX, tbRect.x - 44);
        const baseR = Math.min(elMaxX, tbRect.x + tbRect.w + 44);
        const corrL = baseL + (tbRect.x - 6 - baseL) * t;
        const corrR = baseR + (tbRect.x + tbRect.w + 6 - baseR) * t;
        if (x >= corrL && x <= corrR) return;
      } else if (tbBelow && y >= elMaxY - 4 && y <= tbRect.y + 4) {
        const span = Math.max(1, tbRect.y - elMaxY);
        const t = Math.max(0, Math.min(1, (y - elMaxY) / span));
        const baseL = Math.max(elMinX, tbRect.x - 44);
        const baseR = Math.min(elMaxX, tbRect.x + tbRect.w + 44);
        const corrL = baseL + (tbRect.x - 6 - baseL) * t;
        const corrR = baseR + (tbRect.x + tbRect.w + 6 - baseR) * t;
        if (x >= corrL && x <= corrR) return;
      }
    }
  }

  // 2. If cursor is over an obstructing UI window (ControlBar, PenpaDock, HUD, modals), schedule hide
  if (isBlockingUiAt(x, y)) {
    scheduleHoverHide();
    return;
  }

  // 3. Geometric top-to-bottom hit test across ALL visible elements (detects locked & pass-through elements,
  //    while properly stopping if occluded by any higher non-pass-through element!)
  const desc = [...sortedVisibleElements.value].sort((a, b) => b.zIndex - a.zIndex);
  let hitLocked: WorldElement | null = null;
  for (const el of desc) {
    const vpQuad =
      el.kind === 'grid' && el.locked && !isItemCropped(el.crop)
        ? (gridOuterQuads.value.get(el.id) ??
          worldQuadToViewport(el.corners, effectiveViewportTransform.value))
        : worldQuadToViewport(el.corners, effectiveViewportTransform.value);
    if (!isPointInQuad({ x, y }, vpQuad)) continue;

    if (isElementPassThrough(el)) {
      hitLocked = el;
      break;
    }
    // Non-pass-through element blocks everything beneath it
    if (el.locked) {
      hitLocked = el;
    }
    break;
  }

  if (hitLocked) {
    cancelHoverHideTimer();
    hoveredLockedId.value = hitLocked.id;
  } else {
    scheduleHoverHide();
  }
}

function onWindowPointerMoveForHover(e: PointerEvent) {
  if (e.pointerType === 'touch') return;
  evaluateLockedHoverAt(e.clientX, e.clientY);
}

function onWindowPointerLeave() {
  scheduleHoverHide();
}

// --- Viewport Wheel Zoom & Middle-Mouse Pan (Canvas window mode only) ---
function isUiControlTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  return !!el.closest(
    '.ac-control-bar, .ac-dock, .ac-element-toolbar, .ac-settings-backdrop, .ac-prompt-backdrop, .ac-viewport-hud',
  );
}

function onRootWheel(e: WheelEvent) {
  if (backdropMode.value !== 'canvas') return;
  if (settingsOpen.value || unavailableReasonKey.value) return;
  if (isUiControlTarget(e.target)) return;
  e.preventDefault();
  const deltaY = Math.max(-180, Math.min(180, e.deltaY));
  const factor = Math.exp(-deltaY * 0.0014);
  canvasViewport.value = zoomViewportAt(
    canvasViewport.value,
    canvasViewport.value.zoom * factor,
    { x: e.clientX, y: e.clientY },
  );
}

let middlePanSession: {
  pointerId: number;
  captureEl: Element | null;
  startClient: { x: number; y: number };
  baseTransform: WorldViewportTransform;
} | null = null;

function endMiddlePan() {
  if (!middlePanSession) return;
  tryReleasePointer(middlePanSession.captureEl, middlePanSession.pointerId);
  middlePanSession = null;
  endGlobalDrag();
}

function onRootPointerDown(e: PointerEvent) {
  if (backdropMode.value !== 'canvas') return;
  if (e.button !== 1) return;
  if (isUiControlTarget(e.target)) return;
  e.preventDefault();
  if (middlePanSession) endMiddlePan();
  const captureEl = tryCapturePointer(e.currentTarget as HTMLElement | null, e.pointerId);
  beginGlobalDrag();
  middlePanSession = {
    pointerId: e.pointerId,
    captureEl,
    startClient: { x: e.clientX, y: e.clientY },
    baseTransform: { ...canvasViewport.value },
  };
}

function onWindowMiddlePanMove(e: PointerEvent) {
  if (!middlePanSession || e.pointerId !== middlePanSession.pointerId) return;
  e.preventDefault();
  const dx = e.clientX - middlePanSession.startClient.x;
  const dy = e.clientY - middlePanSession.startClient.y;
  canvasViewport.value = panViewportBy(middlePanSession.baseTransform, dx, dy);
}

function onWindowMiddlePanUp(e: PointerEvent) {
  if (!middlePanSession || e.pointerId !== middlePanSession.pointerId) return;
  endMiddlePan();
}

// Forward keyboard shortcuts to active Penpa+ instance
function onWindowKey(type: 'keydown' | 'keyup', e: KeyboardEvent) {
  if (hotkeyRecording.value) return;

  if (type === 'keydown' && e.code === 'Escape') {
    if (unavailableReasonKey.value) {
      e.preventDefault();
      unavailableReasonKey.value = null;
      return;
    }
    if (cropDraft.value) {
      e.preventDefault();
      cancelCropDraft();
      return;
    }
  }

  if (settingsOpen.value || unavailableReasonKey.value) return;

  const activeTag = (document.activeElement?.tagName || '').toLowerCase();
  if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') return;

  if (e.code === 'Space') {
    spacePanning.value = type === 'keydown' && backdropMode.value === 'canvas';
  }

  const sel = selectedElement.value;
  if (
    type === 'keydown' &&
    sel &&
    sel.kind !== 'grid' &&
    !sel.locked &&
    (e.code === 'Delete' || e.code === 'Backspace')
  ) {
    e.preventDefault();
    removeElement(sel.id);
    return;
  }

  const b = activeBridge.value;
  if (!b || !b.isReady()) return;

  b.dispatchKey(type, {
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    repeat: e.repeat,
  });
}

function onKeyDown(e: KeyboardEvent) {
  onWindowKey('keydown', e);
}
function onKeyUp(e: KeyboardEvent) {
  onWindowKey('keyup', e);
}
function handleWindowFocusLost() {
  spacePanning.value = false;
  endMiddlePan();
  cancelCropDraft();
  if (selectedElementId.value !== null) {
    selectElement(null);
  }
  clearHoverLocked();
}

function onWindowBlur() {
  spacePanning.value = false;
  endMiddlePan();
  // Defer 1 tick so clicking inside our own Penpa+ Dock iframe (where document.hasFocus() stays true)
  // does NOT falsely cancel selection, while leaving the app window immediately deselects.
  window.setTimeout(() => {
    if (!document.hasFocus()) {
      handleWindowFocusLost();
    }
  }, 0);
}
function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    handleWindowFocusLost();
    flushAllStateNow();
  }
}

let unlistenOverlayCursor: (() => void) | null = null;
let unlistenWindowFocus: (() => void) | null = null;

onMounted(async () => {
  window.addEventListener('paste', onPaste);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('pointermove', onWindowPointerMoveForHover, { passive: true });
  window.addEventListener('pointermove', onWindowMiddlePanMove);
  window.addEventListener('pointerup', onWindowMiddlePanUp);
  window.addEventListener('pointercancel', onWindowMiddlePanUp);
  document.addEventListener('mouseleave', onWindowPointerLeave);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('pagehide', flushAllStateNow);
  window.addEventListener('beforeunload', flushAllStateNow);
  window.addEventListener('penpaanywhere-md3-updated', syncAllPenpaThemeAndCss);
  document.addEventListener('visibilitychange', onVisibilityChange);

  void hydratePersistedImages();

  window.__PENPAANYWHERE_ON_ANDROID_IMAGE__ = (dataUrl: string) => {
    void addImageDataUrl(dataUrl);
  };
  window.__PENPAANYWHERE_ON_CLICK_THROUGH__ = (enabled: boolean) => {
    updateElement(PRIMARY_GRID_ID, { locked: true, passThrough: enabled });
  };
  window.__PENPAANYWHERE_FLUSH_STORAGE__ = flushAllStateNow;
  window.__PENPAANYWHERE_CAPTURE_OVERLAY__ = () => ({
    active: backdropMode.value === 'overlay' && primaryGrid.value.visible,
    dataUrl: primaryGrid.value.visible
      ? (overlayRefs.get(PRIMARY_GRID_ID)?.captureOverlayPng() ?? '')
      : '',
  });
  window.__PENPAANYWHERE_ON_SCREENSHOT_PROMPT__ = (fileName: string) => {
    screenshotPromptFile.value = fileName || '';
    screenshotPromptOpen.value = true;
  };
  window.__PENPAANYWHERE_ON_SCREENSHOT_STATUS__ = (status: AndroidScreenshotCompositeStatus) => {
    androidScreenshotStatus.value = status;
  };
  window.__PENPAANYWHERE_ON_UNAVAILABLE__ = (key: string) => {
    if (key === 'penpaCloneUnsupported') handleUnavailableClick(key);
  };

  if (platform === 'tauri') {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      unlistenOverlayCursor = await listen<[number, number]>('overlay-cursor-pos', (ev) => {
        if (backdropMode.value === 'overlay' && Array.isArray(ev.payload)) {
          evaluateLockedHoverAt(ev.payload[0], ev.payload[1]);
        }
      });
    } catch {
      // ignore if listener unavailable
    }
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      unlistenWindowFocus = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (!focused) handleWindowFocusLost();
      });
    } catch {
      // ignore if window focus listener unavailable
    }
    syncOverlayHitRegions();
  }
  if (platform === 'android-overlay') {
    refreshAndroidScreenshotStatus();
    requestAnimationFrame(() => syncOverlayHitRegions());
  }
});

onBeforeUnmount(() => {
  flushAllStateNow();
  endMiddlePan();
  cancelHoverHideTimer();
  unlistenOverlayCursor?.();
  unlistenOverlayCursor = null;
  unlistenWindowFocus?.();
  unlistenWindowFocus = null;
  window.removeEventListener('paste', onPaste);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('pointermove', onWindowPointerMoveForHover);
  window.removeEventListener('pointermove', onWindowMiddlePanMove);
  window.removeEventListener('pointerup', onWindowMiddlePanUp);
  window.removeEventListener('pointercancel', onWindowMiddlePanUp);
  document.removeEventListener('mouseleave', onWindowPointerLeave);
  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('pagehide', flushAllStateNow);
  window.removeEventListener('beforeunload', flushAllStateNow);
  window.removeEventListener('penpaanywhere-md3-updated', syncAllPenpaThemeAndCss);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  stopAllScreenStreams();
  for (const el of elements.value) {
    if (el.kind === 'image' && el.src.startsWith('blob:')) {
      URL.revokeObjectURL(el.src);
    }
  }
});
</script>

<template>
  <main
    class="ac-root"
    @drop="onDrop"
    @dragover="onDragOver"
    @wheel="onRootWheel"
    @pointerdown="onRootPointerDown"
  >
    <!-- Hidden multi-file picker -->
    <input
      ref="fileInputEl"
      type="file"
      accept="image/*"
      multiple
      style="display: none"
      @change="onFileSelected"
    />

    <!-- Canvas Window Backdrop (checkerboard + symmetric origin crosshair + zoom HUD; omitted in transparent Overlay mode) -->
    <CanvasStage
      v-if="backdropMode === 'canvas'"
      v-model:viewport-transform="canvasViewport"
      :selected-id="selectedElementId"
      @select="selectElement"
    />

    <!-- Unified World Elements rendered as direct siblings in true shared zIndex order (BOTH Overlay & Canvas modes!) -->
    <template v-for="el in sortedVisibleElements" :key="el.id">
      <PerspectiveOverlay
        v-if="el.kind === 'grid'"
        :ref="(inst) => setOverlayRef(el.id, inst as InstanceType<typeof PerspectiveOverlay> | null)"
        :element="el"
        :bridge="gridBridges.get(el.id) ?? null"
        :has-dom-backdrop="hasDomBackdrop"
        :viewport-transform="effectiveViewportTransform"
        :world-bounded-to-viewport="backdropMode === 'overlay'"
        :selected="selectedElementId === el.id"
        :crop-draft="cropDraft?.elementId === el.id ? cropDraft : null"
        :space-panning="backdropMode === 'canvas' && spacePanning"
        @select="selectElement"
        @update-corners="updateElementCorners"
        @update-crop-draft="updateCropDraft"
        @toggle-crop="(id) => { cropDraft?.elementId === id ? cancelCropDraft() : startCropMode(id); }"
        @quad-geometry-change="(q) => setGridOuterQuad(el.id, q)"
        @bounds-change="(b) => setGridBounds(el.id, b)"
      />
      <MediaElementView
        v-else
        :element="el"
        :stream="el.kind === 'screen' ? (screenStreams.get(el.streamId) ?? null) : null"
        :viewport-transform="effectiveViewportTransform"
        :world-bounded-to-viewport="backdropMode === 'overlay'"
        :selected="selectedElementId === el.id"
        :crop-draft="cropDraft?.elementId === el.id ? cropDraft : null"
        :space-panning="backdropMode === 'canvas' && spacePanning"
        @select="selectElement"
        @update-corners="updateElementCorners"
        @update-crop-draft="updateCropDraft"
        @toggle-crop="(id) => { cropDraft?.elementId === id ? cancelCropDraft() : startCropMode(id); }"
      />
    </template>

    <!-- Unified Transform / Crop / Lock Gizmo + Floating Context Toolbar for ALL World Elements -->
    <TransformGizmo
      :element="selectedElement"
      :crop-draft="cropDraft"
      :hovered-locked-element="hoveredLockedElement"
      :viewport-transform="effectiveViewportTransform"
      :world-bounded-to-viewport="backdropMode === 'overlay'"
      :show-layer-order-actions="fullCanvasEnabled"
      :grid-bounds="selectedElement?.kind === 'grid' ? gridBoundsMap.get(selectedElement.id) : undefined"
      @update-element="updateElement"
      @update-quad-mode="updateElementQuadMode"
      @reset-size="resetElementSize"
      @start-crop="startCropMode"
      @update-crop-draft="updateCropDraft"
      @commit-crop="commitCropDraft"
      @cancel-crop="cancelCropDraft"
      @bring-front="bringElementFront"
      @send-back="sendElementBack"
      @remove-element="removeElement"
      @lock-element="handleLockElement"
      @unlock-element="handleUnlockElement"
      @toolbar-bounds-change="(r) => (toolbarRect = r)"
      @hover-toolbar-bounds-change="(r) => (hoverToolbarRect = r)"
    />

    <!-- Independent Penpa+ Tool Windows (one per GridElement; carries per-grid Blend & Opacity; never passes through) -->
    <PenpaDockWindow
      v-for="grid in gridElements"
      :key="`dock-${grid.id}`"
      :visible="grid.dockVisible"
      :title="grid.label || 'Penpa+'"
      :backdrop-mode="backdropMode"
      :blend-mode="grid.blendMode"
      :board-opacity="grid.opacity"
      :show-unavailable-options="showUnavailableOptions"
      @update:visible="(v) => updateElement(grid.id, { dockVisible: v })"
      @update:blend-mode="(v) => updateElement(grid.id, { blendMode: v })"
      @update:board-opacity="(v) => updateElement(grid.id, { opacity: v })"
      @unavailable-click="handleUnavailableClick"
      @bridge-ready="(b) => setGridBridge(grid.id, b)"
      @bounds-change="(r) => setDockRect(grid.id, r)"
    />

    <!-- Global MD3 Control Bar (with inline expandable "+ Add" picker & aligned "Layers" table) -->
    <ControlBar
      v-model:layers-visible="layersVisible"
      v-model:always-on-top="alwaysOnTop"
      :backdrop-mode="backdropMode"
      :platform="platform"
      :can-switch-overlay="canSwitchOverlay"
      :can-screen-capture="canScreenCapture"
      :can-pin-window="platform === 'tauri'"
      :full-canvas-enabled="fullCanvasEnabled"
      :elements="elements"
      :selected-id="selectedElementId"
      :show-unavailable-options="showUnavailableOptions"
      @update:backdrop-mode="handleBackdropModeUpdate"
      @unavailable-click="handleUnavailableClick"
      @add-image="triggerImagePicker"
      @add-screen="addScreenProjection"
      @select-element="selectElement"
      @toggle-visible="toggleElementVisible"
      @toggle-lock="toggleElementLock"
      @toggle-passthrough="toggleElementPassThrough"
      @toggle-dock="toggleGridDock"
      @move-up="(id) => moveElementLayerOrder(id, 'up')"
      @move-down="(id) => moveElementLayerOrder(id, 'down')"
      @remove-element="removeElement"
      @open-settings="settingsOpen = true"
      @close-overlay="handleCloseOverlay"
      @bounds-change="(r) => (barRect = r)"
    />

    <!-- Settings Modal -->
    <SettingsDialog
      v-model:open="settingsOpen"
      v-model:custom-css-enabled="customCssEnabled"
      v-model:custom-css="customCss"
      v-model:toggle-hotkey="toggleHotkey"
      v-model:overlay-full-canvas="overlayFullCanvas"
      v-model:show-unavailable-options="showUnavailableOptions"
      :platform="platform"
      :android-screenshot-status="androidScreenshotStatus"
      @unavailable-click="handleUnavailableClick"
      @toggle-android-screenshot-composite="handleToggleAndroidScreenshotComposite"
      @request-android-all-files="handleRequestAndroidAllFiles"
      @recording-change="(r) => (hotkeyRecording = r)"
    />

    <!-- Unavailable Option Explanation Dialog -->
    <div
      v-if="unavailableDialogInfo"
      class="ac-prompt-backdrop ac-unavailable-backdrop"
      @pointerdown.self="unavailableReasonKey = null"
    >
      <section
        class="ac-prompt-card"
        role="dialog"
        aria-modal="true"
        :aria-label="messages.unavailable.ariaLabel"
      >
        <div class="ac-prompt-title">{{ unavailableDialogInfo.title }}</div>
        <p class="ac-prompt-body">{{ unavailableDialogInfo.body }}</p>
        <div class="ac-prompt-actions">
          <button class="ac-btn active" @click="unavailableReasonKey = null">
            {{ messages.unavailable.ok }}
          </button>
        </div>
      </section>
    </div>

    <!-- First-time Android Screenshot Auto-Composite Prompt -->
    <div
      v-if="screenshotPromptOpen"
      class="ac-prompt-backdrop"
      @pointerdown.self="handleRespondScreenshotPrompt('later')"
    >
      <section
        class="ac-prompt-card"
        role="dialog"
        aria-modal="true"
        :aria-label="messages.screenshotPrompt.ariaLabel"
      >
        <div class="ac-prompt-title">{{ messages.screenshotPrompt.title }}</div>
        <p class="ac-prompt-body">{{ messages.screenshotPrompt.body }}</p>
        <div v-if="screenshotPromptFile" class="ac-prompt-file">{{ screenshotPromptFile }}</div>
        <div class="ac-prompt-actions">
          <button class="ac-btn" @click="handleRespondScreenshotPrompt('dismiss')">
            {{ messages.screenshotPrompt.dismiss }}
          </button>
          <button class="ac-btn" @click="handleRespondScreenshotPrompt('later')">
            {{ messages.screenshotPrompt.later }}
          </button>
          <button class="ac-btn active" @click="handleRespondScreenshotPrompt('enable')">
            {{ messages.screenshotPrompt.enable }}
          </button>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.ac-prompt-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(16px + var(--ac-safe-top, 0px)) calc(16px + var(--ac-safe-right, 0px))
    calc(16px + var(--ac-safe-bottom, 0px)) calc(16px + var(--ac-safe-left, 0px));
  background: color-mix(in srgb, var(--md-sys-color-scrim) 52%, transparent);
  pointer-events: auto;
}

.ac-unavailable-backdrop {
  z-index: 1250;
}

.ac-prompt-card {
  width: min(380px, 100%);
  padding: 16px 18px;
  border-radius: 20px;
  background: var(--md-sys-color-surface-container);
  border: 1px solid var(--md-sys-color-outline-variant);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.56);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ac-prompt-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface);
}

.ac-prompt-body {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--md-sys-color-on-surface-variant);
}

.ac-prompt-file {
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--md-sys-color-primary);
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 8px;
  padding: 5px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-prompt-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
