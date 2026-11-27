<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ControlBar, { type UnavailableReasonKey } from './components/ControlBar.vue';
import CanvasStage from './components/CanvasStage.vue';
import MediaElementView from './components/MediaElementView.vue';
import PerspectiveOverlay from './components/PerspectiveOverlay.vue';
import TransformGizmo from './components/TransformGizmo.vue';
import PenpaDockWindow from './components/PenpaDockWindow.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import {
  isPointInQuad,
  quadToBoundingRect,
  rectToQuad,
  type Point2D,
  type Rect2D,
} from './core/homography';
import type { BlendRenderMode } from './core/webglOverlay';
import type { GridBoundsNormalized, PenpaIframeBridge } from './core/penpaBridge';
import { DEFAULT_PENPA_MD3_CSS } from './core/defaultPenpaCss';
import { getCurrentMd3Tokens } from './core/theme';
import { safeAreaInsets } from './core/safeArea';
import { beginGlobalDrag, endGlobalDrag, tryCapturePointer, tryReleasePointer } from './core/dragGuard';
import { currentLocale, formatMessage, getPenpaLangCode, messages } from './core/i18n';
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
  computeCombinedWorldQuad,
  computeInitialItemWorldRect,
  convertElementQuadMode,
  createCropDraft,
  createDefaultCrop,
  generateCanvasItemId,
  generateGroupId,
  getDescendantGroupIds,
  getDescendantLeafIds,
  getParentGroup,
  isElementPassThrough,
  isItemCropped,
  resetElementSizeCorners,
  resolveTopLevelTargetId,
  sanitizeCrop,
  sanitizeQuad,
  toCanvasImageMeta,
  type CropDraft,
  type ElementGroup,
  type GridElement,
  type GroupSelectionTarget,
  type ImageElement,
  type QuadMode,
  type ScreenElement,
  type SelectableTarget,
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
  getInitialIsDebugBuild,
  getIsDebugBuild,
  openExternalLink,
  saveDownloadedFile,
  setOsAlwaysOnTop,
  setOsClickThrough,
  setOsFullscreenOverlay,
  supportsNativeTransparentOverlay,
  supportsOverlaySwitch,
  supportsScreenCapture,
  switchAndroidToImageActivity,
  switchAndroidToOverlayService,
  toggleOsDevtools,
  type AndroidScreenshotCompositeStatus,
} from './core/platform';
import {
  flushPersistedStateNow,
  loadPersistedState,
  patchPersistedState,
  type ButtonDisplayMode,
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
    label: typeof savedState.gridLabel === 'string' ? savedState.gridLabel : '',
    corners: loadInitialWorldCorners(),
    quadMode: savedState.quadMode ?? 'rect',
    crop: sanitizeCrop(savedState.gridCrop),
    blendMode: resolveInitialBlendMode(),
    opacity:
      typeof savedState.opacity === 'number' && savedState.opacity >= 0.1 && savedState.opacity <= 1
        ? savedState.opacity
        : 1.0,
    enhanceOpacity: !!savedState.gridEnhanceOpacity,
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
const groups = ref<ElementGroup[]>([]);
const screenStreams = ref<Map<string, MediaStream>>(new Map());
let itemsHydrated = false;

const buttonDisplayMode = ref<ButtonDisplayMode>(
  savedState.buttonDisplayMode === 'icon-only' || savedState.buttonDisplayMode === 'text-only'
    ? savedState.buttonDisplayMode
    : 'icon-text',
);
const globalScale = ref<number>(
  typeof savedState.globalScale === 'number' &&
    savedState.globalScale >= 0.7 &&
    savedState.globalScale <= 1.5
    ? savedState.globalScale
    : 1,
);
const penpaScale = ref<number>(
  typeof savedState.penpaScale === 'number' &&
    savedState.penpaScale >= 0.5 &&
    savedState.penpaScale <= 1.25
    ? savedState.penpaScale
    : typeof savedState.dock?.scale === 'number' &&
        savedState.dock.scale >= 0.5 &&
        savedState.dock.scale <= 1.25
      ? savedState.dock.scale
      : 1,
);
const penpaBlurOpacity = ref<number>(
  typeof savedState.penpaBlurOpacity === 'number' &&
    savedState.penpaBlurOpacity >= 0.2 &&
    savedState.penpaBlurOpacity <= 1
    ? savedState.penpaBlurOpacity
    : 0.85,
);
const iframeInteractTick = ref(0);

watch(
  globalScale,
  (s) => {
    const clamped = Math.max(0.7, Math.min(1.5, Number.isFinite(s) ? s : 1));
    document.documentElement.style.setProperty('--ac-ui-scale', String(clamped));
  },
  { immediate: true },
);

const overlayFullCanvas = ref(savedState.overlayFullCanvas ?? false);
const fullCanvasEnabled = computed(
  () => backdropMode.value === 'canvas' || overlayFullCanvas.value,
);

const gridElements = computed<GridElement[]>(() =>
  elements.value.filter((e): e is GridElement => e.kind === 'grid'),
);
const primaryGrid = computed<GridElement>(() => gridElements.value[0]);

// Stable DOM insertion order for template v-for so zIndex / group reordering NEVER detaches
// live WebGL2 <canvas> or <video> elements (visual stacking is controlled via CSS zIndex).
const visibleElementsStable = computed<WorldElement[]>(() =>
  elements.value.filter((e) => e.visible && (fullCanvasEnabled.value || e.kind === 'grid')),
);

const sortedVisibleElements = computed<WorldElement[]>(() =>
  [...visibleElementsStable.value].sort((a, b) => a.zIndex - b.zIndex),
);

function getGroupForElement(elementId: string): ElementGroup | null {
  return getParentGroup(elementId, groups.value);
}

function resolveTargetId(id: string): string {
  return resolveTopLevelTargetId(id, groups.value);
}

function buildGroupTarget(g: ElementGroup): GroupSelectionTarget | null {
  const byId = new Map(elements.value.map((e) => [e.id, e]));
  const elementIdSet = new Set(byId.keys());
  const leafIds = getDescendantLeafIds(g.id, groups.value, elementIdSet);
  const members: WorldElement[] = [];
  for (const lid of leafIds) {
    const el = byId.get(lid);
    if (el) members.push(el);
  }
  if (members.length < 2) return null;
  let maxZ = -Infinity;
  let minZ = Infinity;
  let hasGrid = false;
  let dockVisible = false;
  for (const m of members) {
    if (m.zIndex > maxZ) maxZ = m.zIndex;
    if (m.zIndex < minZ) minZ = m.zIndex;
    if (m.kind === 'grid') {
      hasGrid = true;
      if (m.dockVisible) dockVisible = true;
    }
  }
  return {
    id: g.id,
    kind: 'group',
    label: g.label,
    memberIds: [...g.memberIds],
    members,
    corners: computeCombinedWorldQuad(members),
    zIndex: maxZ,
    minZIndex: minZ,
    visible: g.visible,
    locked: g.locked,
    passThrough: g.passThrough,
    hasGrid,
    dockVisible,
  };
}

// Top-level selectable targets (each top-level group is ONE indivisible entry; nested child groups stay inside)
const allLayerTargets = computed<SelectableTarget[]>(() => {
  const childIdSet = new Set<string>();
  for (const g of groups.value) {
    for (const mid of g.memberIds) childIdSet.add(mid);
  }
  const targets: SelectableTarget[] = [];
  for (const g of groups.value) {
    if (childIdSet.has(g.id)) continue; // nested inside a parent group
    const gt = buildGroupTarget(g);
    if (gt) {
      targets.push(gt);
    }
  }
  for (const el of elements.value) {
    if (!childIdSet.has(el.id)) {
      targets.push(el);
    }
  }
  return targets.sort((a, b) => a.zIndex - b.zIndex);
});

const activeLayerTargets = computed<SelectableTarget[]>(() => {
  if (fullCanvasEnabled.value) return allLayerTargets.value;
  // Overlay without full canvas: only grids are shown/selectable individually
  return elements.value.filter((e) => e.kind === 'grid');
});

// World -> Viewport transform (Overlay locked to identity; Canvas allows pan & zoom)
const canvasViewport = ref<WorldViewportTransform>(
  sanitizeViewportTransform(savedState.canvasViewport),
);
const effectiveViewportTransform = computed<WorldViewportTransform>(() =>
  backdropMode.value === 'canvas' ? canvasViewport.value : IDENTITY_VIEWPORT_TRANSFORM,
);

const selectedTargetIds = ref<string[]>(
  primaryGrid.value.visible && !primaryGrid.value.locked ? [primaryGrid.value.id] : [],
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
  if (fullCanvasEnabled.value && (getGroupForElement(id) || groups.value.some((g) => g.id === id))) {
    return;
  }
  const el = elements.value.find((e) => e.id === id);
  if (!el || el.locked || !el.visible) return;
  selectedTargetIds.value = [el.id];
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
      if (!target || target.kind !== 'grid') cancelCropDraft();
    }
    const validGridIds = new Set(gridElements.value.map((g) => g.id));
    const filtered = selectedTargetIds.value.filter((id) => validGridIds.has(id));
    if (filtered.length !== selectedTargetIds.value.length) {
      selectedTargetIds.value = filtered;
    }
    if (hoveredLockedId.value && !validGridIds.has(hoveredLockedId.value)) {
      clearHoverLocked();
    }
  }
});

const selectedTargets = computed<SelectableTarget[]>(() => {
  const map = new Map(activeLayerTargets.value.map((t) => [t.id, t]));
  const list: SelectableTarget[] = [];
  for (const id of selectedTargetIds.value) {
    const t = map.get(id);
    if (t && t.visible) list.push(t);
  }
  return list;
});

const singleSelectedTarget = computed<SelectableTarget | null>(() =>
  selectedTargets.value.length === 1 ? selectedTargets.value[0] : null,
);

const selectedElement = computed<WorldElement | null>(() =>
  singleSelectedTarget.value && singleSelectedTarget.value.kind !== 'group'
    ? singleSelectedTarget.value
    : null,
);

const selectedElementId = computed<string | null>(() => singleSelectedTarget.value?.id ?? null);

const hoveredLockedTarget = computed<SelectableTarget | null>(() => {
  if (!hoveredLockedId.value) return null;
  const t = activeLayerTargets.value.find((x) => x.id === hoveredLockedId.value) ?? null;
  if (!t || !t.visible || !t.locked) return null;
  return t;
});

function isElementVisuallySelected(elId: string): boolean {
  const targetId = fullCanvasEnabled.value ? resolveTargetId(elId) : elId;
  return selectedTargetIds.value.includes(targetId);
}

const showUnavailableOptions = ref(savedState.showUnavailableOptions ?? false);
const settingsOpen = ref(false);
const screenPickerOpen = ref(false);
const unavailableReasonKey = ref<UnavailableReasonKey | null>(null);
const screenshotPromptOpen = ref(false);
const screenshotPromptFile = ref('');
const androidScreenshotStatus = ref<AndroidScreenshotCompositeStatus | null>(null);
const imagePreview = ref<{ dataUrl: string; filename: string; mimeType: string } | null>(null);
const toastMessage = ref<string | null>(null);
let toastTimer = 0;

function showHostToast(msg: string) {
  toastMessage.value = msg;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastMessage.value = null;
    toastTimer = 0;
  }, 2600);
}

async function handleHostDownload(filename: string, mimeType: string, base64Data: string) {
  const savedName = await saveDownloadedFile(filename, mimeType, base64Data);
  // Android already shows a native system Toast; show a lightweight host toast on desktop Tauri
  if (platform === 'tauri') {
    if (savedName) {
      showHostToast(formatMessage(messages.value.downloadToast.saved, { name: savedName }));
    } else {
      showHostToast(messages.value.downloadToast.failed);
    }
  }
}

async function handleSavePreviewImage() {
  const preview = imagePreview.value;
  if (!preview) return;
  const commaIdx = preview.dataUrl.indexOf(',');
  const base64Data = commaIdx >= 0 ? preview.dataUrl.slice(commaIdx + 1) : preview.dataUrl;
  await handleHostDownload(preview.filename, preview.mimeType, base64Data);
  imagePreview.value = null;
}

const customCssEnabled = ref(savedState.customCssEnabled ?? true);
const customCss = ref(
  typeof savedState.customCss === 'string' ? savedState.customCss : DEFAULT_PENPA_MD3_CSS,
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
  const sel = singleSelectedTarget.value;
  if (sel && sel.kind === 'grid') {
    return gridBridges.value.get(sel.id) ?? gridBridges.value.get(PRIMARY_GRID_ID) ?? null;
  }
  if (sel && sel.kind === 'group') {
    const gridMember = sel.members.find((m) => m.kind === 'grid');
    if (gridMember) {
      return gridBridges.value.get(gridMember.id) ?? gridBridges.value.get(PRIMARY_GRID_ID) ?? null;
    }
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

function selectElement(id: string | null, additive = false) {
  if (id === null) {
    cancelCropDraft();
    selectedTargetIds.value = [];
    return;
  }
  const targetId = fullCanvasEnabled.value ? resolveTargetId(id) : id;
  if (!additive) {
    if (cropDraft.value && cropDraft.value.elementId !== targetId) {
      cancelCropDraft();
    }
    selectedTargetIds.value = [targetId];
    return;
  }

  // Ctrl / Command additive multi-selection: locked targets can NEVER participate in multi-selection!
  const clickedTarget = activeLayerTargets.value.find((t) => t.id === targetId);
  if (!clickedTarget || clickedTarget.locked) return;

  cancelCropDraft();
  const unlockedSelected = selectedTargetIds.value.filter((sid) => {
    const st = activeLayerTargets.value.find((t) => t.id === sid);
    return !!st && !st.locked;
  });

  if (unlockedSelected.includes(targetId)) {
    if (unlockedSelected.length > 1) {
      selectedTargetIds.value = unlockedSelected.filter((x) => x !== targetId);
    } else {
      selectedTargetIds.value = unlockedSelected;
    }
  } else {
    selectedTargetIds.value = [...unlockedSelected, targetId];
  }
}

function pruneInvalidGroups() {
  const validElementIds = new Set(elements.value.map((e) => e.id));
  let curGroups = groups.value.map((g) => ({ ...g, memberIds: [...g.memberIds] }));
  let anyChanged = false;

  for (let pass = 0; pass < 32; pass++) {
    const validGroupIds = new Set(curGroups.map((g) => g.id));
    const dissolvedPromote = new Map<string, string | null>();
    let passChanged = false;

    for (const g of curGroups) {
      const seen = new Set<string>();
      const kept: string[] = [];
      for (const mid of g.memberIds) {
        if (mid === g.id || seen.has(mid)) {
          passChanged = true;
          continue;
        }
        if (validElementIds.has(mid) || validGroupIds.has(mid)) {
          seen.add(mid);
          kept.push(mid);
        } else {
          passChanged = true;
        }
      }
      g.memberIds = kept;
      if (kept.length < 2) {
        dissolvedPromote.set(g.id, kept.length === 1 ? kept[0] : null);
        passChanged = true;
      }
    }

    if (dissolvedPromote.size > 0) {
      curGroups = curGroups
        .filter((g) => !dissolvedPromote.has(g.id))
        .map((g) => {
          const nextIds: string[] = [];
          for (const mid of g.memberIds) {
            if (dissolvedPromote.has(mid)) {
              const promoted = dissolvedPromote.get(mid);
              if (promoted) nextIds.push(promoted);
            } else {
              nextIds.push(mid);
            }
          }
          return { ...g, memberIds: nextIds };
        });
    }

    if (passChanged) anyChanged = true;
    else break;
  }

  if (anyChanged) {
    groups.value = curGroups;
  }
}

function applyLayerTargetOrder(orderedTargets: SelectableTarget[]) {
  const zById = new Map<string, number>();
  let nextZ = 1;
  for (const t of orderedTargets) {
    if (t.kind === 'group') {
      const sortedMembers = [...t.members].sort((a, b) => a.zIndex - b.zIndex);
      for (const m of sortedMembers) {
        zById.set(m.id, nextZ++);
      }
    } else {
      zById.set(t.id, nextZ++);
    }
  }
  elements.value = elements.value.map((el) => ({
    ...el,
    zIndex: zById.get(el.id) ?? el.zIndex,
  }));
}

function groupSelectedTargets() {
  if (!fullCanvasEnabled.value) return;
  const targets = selectedTargets.value;
  if (targets.length < 2) return;

  // True nested ("套娃") grouping: keep child groups intact instead of flattening!
  const sortedTargets = [...targets].sort((a, b) => a.zIndex - b.zIndex);
  const directMemberIds = sortedTargets.map((t) => t.id);

  cancelCropDraft();

  const newGroup: ElementGroup = {
    id: generateGroupId(),
    label: '',
    memberIds: directMemberIds,
    visible: true,
    locked: false,
    passThrough: false,
  };

  const descendantGroupIds = new Set<string>();
  const descendantLeafIds = new Set<string>();
  for (const t of sortedTargets) {
    if (t.kind === 'group') {
      for (const gid of getDescendantGroupIds(t.id, groups.value)) descendantGroupIds.add(gid);
      for (const m of t.members) descendantLeafIds.add(m.id);
    } else {
      descendantLeafIds.add(t.id);
    }
  }

  // Unlock & show all nested descendants without touching their corners, quadMode, or crop!
  elements.value = elements.value.map((el) =>
    descendantLeafIds.has(el.id)
      ? ({ ...el, visible: true, locked: false, passThrough: false } as WorldElement)
      : el,
  );
  groups.value = [
    ...groups.value.map((g) =>
      descendantGroupIds.has(g.id)
        ? { ...g, visible: true, locked: false, passThrough: false }
        : g,
    ),
    newGroup,
  ];

  // Make all grouped descendant leaves contiguous in zIndex at the group's slot
  const ordered = [...allLayerTargets.value];
  applyLayerTargetOrder(ordered);
  clearHoverLocked();
  selectedTargetIds.value = [newGroup.id];
}

function ungroupTarget(groupId: string) {
  const grp = groups.value.find((g) => g.id === groupId);
  if (!grp) return;
  if (cropDraft.value?.elementId === groupId) cancelCropDraft();

  // Remove ONLY the outer group modifier; every direct child (leaf or nested child group)
  // immediately restores 100% to its exact untouched original geometry & crop!
  const remainingGroups = groups.value.filter((g) => g.id !== groupId);
  groups.value = remainingGroups;

  const validElementIds = new Set(elements.value.map((e) => e.id));
  const validGroupIds = new Set(remainingGroups.map((g) => g.id));
  const released = grp.memberIds.filter(
    (mid) => validElementIds.has(mid) || validGroupIds.has(mid),
  );
  if (hoveredLockedId.value === groupId) clearHoverLocked();
  selectedTargetIds.value = grp.locked ? [] : released;
}

function handleLockElement(id: string) {
  const grp = groups.value.find((g) => g.id === id);
  if (grp) {
    const descGroupIds = new Set(getDescendantGroupIds(grp.id, groups.value));
    const descLeafIds = new Set(
      getDescendantLeafIds(grp.id, groups.value, new Set(elements.value.map((e) => e.id))),
    );
    if (
      cropDraft.value &&
      (descGroupIds.has(cropDraft.value.elementId) || descLeafIds.has(cropDraft.value.elementId))
    ) {
      cancelCropDraft();
    }
    groups.value = groups.value.map((g) => (descGroupIds.has(g.id) ? { ...g, locked: true } : g));
    elements.value = elements.value.map((el) =>
      descLeafIds.has(el.id) ? ({ ...el, locked: true } as WorldElement) : el,
    );
    if (selectedTargetIds.value.length > 1 && selectedTargetIds.value.includes(id)) {
      selectedTargetIds.value = selectedTargetIds.value.filter((x) => x !== id);
    }
    return;
  }
  const el = elements.value.find((e) => e.id === id);
  if (!el) return;
  if (cropDraft.value?.elementId === id) {
    cancelCropDraft();
  }
  updateElement(id, { locked: true });
  if (selectedTargetIds.value.length > 1 && selectedTargetIds.value.includes(id)) {
    selectedTargetIds.value = selectedTargetIds.value.filter((x) => x !== id);
  }
}

function handleUnlockElement(id: string) {
  const grp = groups.value.find((g) => g.id === id);
  if (grp) {
    const descGroupIds = new Set(getDescendantGroupIds(grp.id, groups.value));
    const descLeafIds = new Set(
      getDescendantLeafIds(grp.id, groups.value, new Set(elements.value.map((e) => e.id))),
    );
    groups.value = groups.value.map((g) =>
      descGroupIds.has(g.id) ? { ...g, locked: false, passThrough: false } : g,
    );
    elements.value = elements.value.map((el) =>
      descLeafIds.has(el.id) ? ({ ...el, locked: false, passThrough: false } as WorldElement) : el,
    );
    clearHoverLocked();
    selectedTargetIds.value = [id];
    return;
  }
  const el = elements.value.find((e) => e.id === id);
  if (!el) return;
  updateElement(id, { locked: false });
  clearHoverLocked();
  selectedTargetIds.value = [id];
}

function updateElement(id: string, patch: Partial<WorldElement>) {
  elements.value = elements.value.map((el) =>
    el.id === id ? ({ ...el, ...patch } as WorldElement) : el,
  );
}

function updateGroup(id: string, patch: Partial<ElementGroup>) {
  groups.value = groups.value.map((g) => (g.id === id ? { ...g, ...patch } : g));
}

// Session-baseline snapshot for drift-free group rect scaling applied directly to descendant leaves
let activeGroupResizeSnapshot: {
  groupId: string;
  baseRect: Rect2D;
  leafCorners: Map<string, [Point2D, Point2D, Point2D, Point2D]>;
} | null = null;

function handleResizeStart(id: string) {
  const grp = groups.value.find((g) => g.id === id);
  if (!grp) {
    activeGroupResizeSnapshot = null;
    return;
  }
  const gt = buildGroupTarget(grp);
  if (!gt) {
    activeGroupResizeSnapshot = null;
    return;
  }
  const leafCorners = new Map<string, [Point2D, Point2D, Point2D, Point2D]>();
  for (const m of gt.members) {
    leafCorners.set(m.id, cloneQuad(m.corners));
  }
  activeGroupResizeSnapshot = {
    groupId: id,
    baseRect: quadToBoundingRect(gt.corners, 1),
    leafCorners,
  };
}

function handleResizeEnd() {
  activeGroupResizeSnapshot = null;
}

function applyGroupRectScale(groupId: string, nextCorners: [Point2D, Point2D, Point2D, Point2D]) {
  if (!activeGroupResizeSnapshot || activeGroupResizeSnapshot.groupId !== groupId) {
    handleResizeStart(groupId);
  }
  const snap = activeGroupResizeSnapshot;
  if (!snap || snap.leafCorners.size === 0) return;

  const oldRect = snap.baseRect;
  const newRect = quadToBoundingRect(nextCorners, 48);
  const oldW = Math.max(1, oldRect.w);
  const oldH = Math.max(1, oldRect.h);
  const mapPt = (p: Point2D): Point2D => ({
    x: newRect.x + ((p.x - oldRect.x) / oldW) * newRect.w,
    y: newRect.y + ((p.y - oldRect.y) / oldH) * newRect.h,
  });

  elements.value = elements.value.map((el) => {
    const base = snap.leafCorners.get(el.id);
    if (!base) return el;
    return {
      ...el,
      corners: [mapPt(base[0]), mapPt(base[1]), mapPt(base[2]), mapPt(base[3])],
    } as WorldElement;
  });
}

function updateTarget(id: string, patch: Partial<WorldElement>) {
  const grp = groups.value.find((g) => g.id === id);
  if (grp) {
    if (patch.corners) {
      applyGroupRectScale(id, patch.corners);
    }
    if (typeof patch.label === 'string') {
      updateGroup(id, { label: patch.label });
    }
    return;
  }
  updateElement(id, patch);
}

function focusMultiMember(id: string) {
  const targetId = fullCanvasEnabled.value ? resolveTargetId(id) : id;
  if (!selectedTargetIds.value.includes(targetId)) return;
  if (selectedTargetIds.value[selectedTargetIds.value.length - 1] === targetId) return;
  selectedTargetIds.value = [
    ...selectedTargetIds.value.filter((x) => x !== targetId),
    targetId,
  ];
}

function renameTarget(id: string, nextLabel: string) {
  const grp = groups.value.find((g) => g.id === id);
  if (grp) {
    updateGroup(id, { label: nextLabel });
    return;
  }
  updateElement(id, { label: nextLabel });
}

// Session-baseline translation snapshot: translates descendant leaf elements directly with zero drift!
let activeMoveSnapshot: Map<string, [Point2D, Point2D, Point2D, Point2D]> | null = null;

function handleMoveStart(leafId: string) {
  const elMap = new Map<string, [Point2D, Point2D, Point2D, Point2D]>();

  const captureTarget = (t: SelectableTarget) => {
    if (t.locked) return;
    if (t.kind === 'group') {
      for (const m of t.members) {
        if (!m.locked) elMap.set(m.id, cloneQuad(m.corners));
      }
    } else {
      elMap.set(t.id, cloneQuad(t.corners));
    }
  };

  if (selectedTargetIds.value.length >= 2 && isElementVisuallySelected(leafId)) {
    for (const target of selectedTargets.value) {
      captureTarget(target);
    }
  } else {
    const targetId = fullCanvasEnabled.value ? resolveTargetId(leafId) : leafId;
    const target = activeLayerTargets.value.find((t) => t.id === targetId);
    if (target) captureTarget(target);
  }

  activeMoveSnapshot = elMap;
}

function handleTranslateBy(leafId: string, dxWorld: number, dyWorld: number) {
  if (!activeMoveSnapshot) handleMoveStart(leafId);
  if (!activeMoveSnapshot || activeMoveSnapshot.size === 0) return;

  const snap = activeMoveSnapshot;
  elements.value = elements.value.map((el) => {
    const b = snap.get(el.id);
    if (!b) return el;
    return {
      ...el,
      corners: [
        { x: b[0].x + dxWorld, y: b[0].y + dyWorld },
        { x: b[1].x + dxWorld, y: b[1].y + dyWorld },
        { x: b[2].x + dxWorld, y: b[2].y + dyWorld },
        { x: b[3].x + dxWorld, y: b[3].y + dyWorld },
      ],
    } as WorldElement;
  });
}

function handleMoveEnd() {
  activeMoveSnapshot = null;
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
  const targetId = resolveTargetId(id);
  const ordered = [...allLayerTargets.value];
  const idx = ordered.findIndex((t) => t.id === targetId);
  if (idx < 0 || idx === ordered.length - 1) return;
  const [moved] = ordered.splice(idx, 1);
  ordered.push(moved);
  applyLayerTargetOrder(ordered);
}

function sendElementBack(id: string) {
  const targetId = resolveTargetId(id);
  const ordered = [...allLayerTargets.value];
  const idx = ordered.findIndex((t) => t.id === targetId);
  if (idx <= 0) return;
  const [moved] = ordered.splice(idx, 1);
  ordered.unshift(moved);
  applyLayerTargetOrder(ordered);
}

function normalizeZIndices() {
  applyLayerTargetOrder([...allLayerTargets.value]);
}

function moveElementLayerOrder(id: string, dir: 'up' | 'down') {
  const targetId = resolveTargetId(id);
  const ordered = [...allLayerTargets.value];
  const idx = ordered.findIndex((t) => t.id === targetId);
  if (idx < 0) return;
  const swapIdx = dir === 'up' ? idx + 1 : idx - 1;
  if (swapIdx < 0 || swapIdx >= ordered.length) return;
  const [moved] = ordered.splice(idx, 1);
  ordered.splice(swapIdx, 0, moved);
  applyLayerTargetOrder(ordered);
}

function toggleElementVisible(id: string) {
  const grp = groups.value.find((g) => g.id === id);
  if (grp) {
    const nextVis = !grp.visible;
    const descGroupIds = new Set(getDescendantGroupIds(grp.id, groups.value));
    const descLeafIds = new Set(
      getDescendantLeafIds(grp.id, groups.value, new Set(elements.value.map((e) => e.id))),
    );
    groups.value = groups.value.map((g) =>
      descGroupIds.has(g.id) ? { ...g, visible: nextVis } : g,
    );
    elements.value = elements.value.map((el) =>
      descLeafIds.has(el.id) ? ({ ...el, visible: nextVis } as WorldElement) : el,
    );
    if (!nextVis) {
      if (cropDraft.value?.elementId === id) cancelCropDraft();
      selectedTargetIds.value = selectedTargetIds.value.filter((x) => x !== id);
    }
    return;
  }
  const el = elements.value.find((e) => e.id === id);
  if (!el) return;
  const nextVis = !el.visible;
  updateElement(id, { visible: nextVis });
  if (!nextVis) {
    if (cropDraft.value?.elementId === id) cancelCropDraft();
    selectedTargetIds.value = selectedTargetIds.value.filter((x) => x !== id);
  }
}

function toggleElementLock(id: string) {
  const grp = groups.value.find((g) => g.id === id);
  if (grp) {
    if (grp.locked) handleUnlockElement(id);
    else handleLockElement(id);
    return;
  }
  const el = elements.value.find((e) => e.id === id);
  if (!el) return;
  if (el.locked) {
    handleUnlockElement(id);
  } else {
    handleLockElement(id);
  }
}

function toggleElementPassThrough(id: string) {
  const grp = groups.value.find((g) => g.id === id);
  if (grp) {
    if (!grp.locked) return;
    const nextPt = !grp.passThrough;
    const descGroupIds = new Set(getDescendantGroupIds(grp.id, groups.value));
    const descLeafIds = new Set(
      getDescendantLeafIds(grp.id, groups.value, new Set(elements.value.map((e) => e.id))),
    );
    groups.value = groups.value.map((g) =>
      descGroupIds.has(g.id) ? { ...g, passThrough: nextPt } : g,
    );
    elements.value = elements.value.map((el) =>
      descLeafIds.has(el.id) ? ({ ...el, passThrough: nextPt } as WorldElement) : el,
    );
    return;
  }
  const el = elements.value.find((e) => e.id === id);
  if (!el || !el.locked) return;
  updateElement(id, { passThrough: !el.passThrough });
}

function toggleGridDock(id: string) {
  const grp = groups.value.find((g) => g.id === id);
  if (grp) {
    const descLeafIds = new Set(
      getDescendantLeafIds(grp.id, groups.value, new Set(elements.value.map((e) => e.id))),
    );
    const grids = elements.value.filter(
      (e): e is GridElement => e.kind === 'grid' && descLeafIds.has(e.id),
    );
    if (grids.length === 0) return;
    const nextDock = !grids.some((g) => g.dockVisible);
    const gridIdSet = new Set(grids.map((g) => g.id));
    elements.value = elements.value.map((el) =>
      gridIdSet.has(el.id) ? ({ ...el, dockVisible: nextDock } as WorldElement) : el,
    );
    return;
  }
  const el = elements.value.find((e) => e.id === id);
  if (!el || el.kind !== 'grid') return;
  updateElement(id, { dockVisible: !el.dockVisible });
}

function disposeMediaElementResources(el: WorldElement) {
  if (el.kind === 'image') {
    if (el.src.startsWith('blob:')) URL.revokeObjectURL(el.src);
    void deleteCanvasImageBlob(el.id);
  } else if (el.kind === 'screen') {
    const stream = screenStreams.value.get(el.streamId);
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      const nextStreams = new Map(screenStreams.value);
      nextStreams.delete(el.streamId);
      screenStreams.value = nextStreams;
    }
  }
}

function removeElement(id: string) {
  const grp = groups.value.find((g) => g.id === id);
  if (grp) {
    const descGroupIds = new Set(getDescendantGroupIds(grp.id, groups.value));
    const descLeafIds = new Set(
      getDescendantLeafIds(grp.id, groups.value, new Set(elements.value.map((e) => e.id))),
    );
    const members = elements.value.filter((e) => descLeafIds.has(e.id));
    // Never delete a group that contains a Penpa+ grid at any nesting depth
    if (members.some((m) => m.kind === 'grid')) return;
    if (
      cropDraft.value &&
      (descGroupIds.has(cropDraft.value.elementId) || descLeafIds.has(cropDraft.value.elementId))
    ) {
      cancelCropDraft();
    }
    for (const m of members) disposeMediaElementResources(m);
    groups.value = groups.value.filter((g) => !descGroupIds.has(g.id));
    elements.value = elements.value.filter((e) => !descLeafIds.has(e.id));
    pruneInvalidGroups();
    selectedTargetIds.value = selectedTargetIds.value.filter((x) => !descGroupIds.has(x));
    return;
  }

  const el = elements.value.find((e) => e.id === id);
  if (!el || el.kind === 'grid') return;
  if (cropDraft.value?.elementId === id) cancelCropDraft();
  disposeMediaElementResources(el);
  elements.value = elements.value.filter((e) => e.id !== id);
  pruneInvalidGroups();
  selectedTargetIds.value = selectedTargetIds.value.filter((x) => x !== id);
}

// --- Persistence ---
  watch(
    [
      elements,
      groups,
      canvasViewport,
      layersVisible,
      buttonDisplayMode,
      globalScale,
      penpaScale,
      penpaBlurOpacity,
      overlayFullCanvas,
      showUnavailableOptions,
      customCssEnabled,
      customCss,
    ],
    () => {
      const g = primaryGrid.value;
      const patch: Parameters<typeof patchPersistedState>[0] = {
        blendMode: g.blendMode,
        quadMode: g.quadMode,
        opacity: g.opacity,
        gridEnhanceOpacity: g.enhanceOpacity,
        gridLocked: g.locked,
        gridPassThrough: g.passThrough,
        gridCrop: { ...g.crop },
        gridZIndex: g.zIndex,
        gridLabel: g.label,
        calibrating: !g.locked,
        dockVisible: g.dockVisible,
        canvasVisible: g.visible,
        layersWindow: { xRatio: 0, yRatio: 0, open: layersVisible.value },
        buttonDisplayMode: buttonDisplayMode.value,
        globalScale: globalScale.value,
        penpaScale: penpaScale.value,
        penpaBlurOpacity: penpaBlurOpacity.value,
        overlayFullCanvas: overlayFullCanvas.value,
        showUnavailableOptions: showUnavailableOptions.value,
        worldCorners: cloneQuad(g.corners),
        canvasViewport: { ...canvasViewport.value },
        customCssEnabled: customCssEnabled.value,
        customCss: customCss.value,
      };
      if (itemsHydrated) {
        patch.canvasItems = elements.value
          .filter((e): e is ImageElement => e.kind === 'image')
          .map(toCanvasImageMeta);
        patch.elementGroups = groups.value.map((grp) => ({
          id: grp.id,
          label: grp.label,
          memberIds: [...grp.memberIds],
          visible: grp.visible,
          locked: grp.locked,
          passThrough: grp.passThrough,
        }));
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
  const modalBlocking =
    settingsOpen.value ||
    screenPickerOpen.value ||
    screenshotPromptOpen.value ||
    !!imagePreview.value ||
    !!unavailableReasonKey.value;
  const g = primaryGrid.value;
  const primaryDock =
    g.dockVisible && (dockRects.value.get(g.id)?.w ?? 0) > 0
      ? dockRects.value.get(g.id)!
      : { x: 0, y: 0, w: 0, h: 0 };

  const extraUiRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  if (selectedTargets.value.length > 0 && toolbarRect.value.w > 0 && toolbarRect.value.h > 0) {
    extraUiRects.push(toolbarRect.value);
  }
  if (hoveredLockedTarget.value && hoverToolbarRect.value.w > 0 && hoverToolbarRect.value.h > 0) {
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

  // Active unlocked transform/crop gizmo quad: gives its 4 edges & 4 corners an explicit OS touchable
  // border strip in Overlay mode (essential for Groups whose bounding corners/edges may lie outside
  // every individual child element), while keeping hollow interiors pass-through.
  let gizmoQuad: [Point2D, Point2D, Point2D, Point2D] | null = null;
  if (cropDraft.value) {
    gizmoQuad = worldQuadToViewport(
      rectToQuad(cropDraft.value.croppedRect),
      effectiveViewportTransform.value,
    );
  } else if (
    singleSelectedTarget.value &&
    singleSelectedTarget.value.visible &&
    !singleSelectedTarget.value.locked
  ) {
    gizmoQuad = worldQuadToViewport(
      singleSelectedTarget.value.corners,
      effectiveViewportTransform.value,
    );
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
        gizmoQuad,
      });
    } catch {
      // Non-fatal in web/dev fallback
    }
    return;
  }

  if (platform === 'android-overlay' && window.AndroidOverlay?.updateHitRegions) {
    let boardRect = { x: 0, y: 0, w: 0, h: 0 };
    const androidHandlePts: Point2D[] = [];
    const boundsQuads = gizmoQuad ? [...interactiveQuads, gizmoQuad] : interactiveQuads;
    if (boundsQuads.length > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const q of boundsQuads) {
        for (const p of q) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
      }
      const pad = gizmoQuad ? 26 : 10;
      if (isFinite(minX) && maxX > minX && maxY > minY) {
        boardRect = {
          x: Math.max(0, minX - pad),
          y: Math.max(0, minY - pad),
          w: maxX - minX + pad * 2,
          h: maxY - minY + pad * 2,
        };
      }
    }
    if (gizmoQuad) {
      androidHandlePts.push(
        ...gizmoQuad,
        { x: (gizmoQuad[0].x + gizmoQuad[1].x) * 0.5, y: (gizmoQuad[0].y + gizmoQuad[1].y) * 0.5 },
        { x: (gizmoQuad[1].x + gizmoQuad[2].x) * 0.5, y: (gizmoQuad[1].y + gizmoQuad[2].y) * 0.5 },
        { x: (gizmoQuad[2].x + gizmoQuad[3].x) * 0.5, y: (gizmoQuad[2].y + gizmoQuad[3].y) * 0.5 },
        { x: (gizmoQuad[3].x + gizmoQuad[0].x) * 0.5, y: (gizmoQuad[3].y + gizmoQuad[0].y) * 0.5 },
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
      gizmoQuad,
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
    screenPickerOpen,
    screenshotPromptOpen,
    imagePreview,
    unavailableReasonKey,
    layersVisible,
    selectedTargetIds,
    cropDraft,
    hoveredLockedId,
    barRect,
    toolbarRect,
    hoverToolbarRect,
    dockRects,
    elements,
    groups,
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
  }
  // Restore persisted nested element groups once all images are hydrated
  const savedGroups = savedState.elementGroups;
  if (Array.isArray(savedGroups) && savedGroups.length > 0) {
    const elById = new Map(elements.value.map((e) => [e.id, e]));
    const rawById = new Map<string, (typeof savedGroups)[number]>();
    for (const rawG of savedGroups) {
      if (rawG && typeof rawG.id === 'string' && Array.isArray(rawG.memberIds)) {
        rawById.set(rawG.id, rawG);
      }
    }

    const usedChildren = new Set<string>();
    const restoredMap = new Map<string, ElementGroup>();
    const visiting = new Set<string>();

    const restoreGroupRec = (gid: string): ElementGroup | null => {
      if (restoredMap.has(gid)) return restoredMap.get(gid)!;
      if (visiting.has(gid)) return null; // cycle guard
      const rawG = rawById.get(gid);
      if (!rawG) return null;
      visiting.add(gid);

      const memberIds: string[] = [];
      for (const mid of rawG.memberIds) {
        if (typeof mid !== 'string' || mid === gid || usedChildren.has(mid)) continue;
        if (elById.has(mid)) {
          memberIds.push(mid);
        } else if (rawById.has(mid)) {
          const childGrp = restoreGroupRec(mid);
          if (childGrp) {
            memberIds.push(mid);
          }
        }
      }
      visiting.delete(gid);
      if (memberIds.length < 2) return null;
      memberIds.forEach((mid) => usedChildren.add(mid));

      const grp: ElementGroup = {
        id: rawG.id,
        label: typeof rawG.label === 'string' ? rawG.label : '',
        memberIds,
        visible: rawG.visible !== false,
        locked: !!rawG.locked,
        passThrough: !!rawG.passThrough,
      };
      restoredMap.set(gid, grp);
      return grp;
    };

    for (const rawG of savedGroups) {
      if (rawG && typeof rawG.id === 'string') {
        restoreGroupRec(rawG.id);
      }
    }

    const restoredGroups = Array.from(restoredMap.values());
    if (restoredGroups.length > 0) {
      groups.value = restoredGroups;
      // Sync top-level group visible/locked/passThrough states down to all nested descendants
      const childIds = new Set<string>();
      for (const grp of restoredGroups) {
        for (const mid of grp.memberIds) childIds.add(mid);
      }
      const elementIdSet = new Set(elById.keys());
      const leafOverride = new Map<string, { visible: boolean; locked: boolean; passThrough: boolean }>();
      const groupOverride = new Map<string, { visible: boolean; locked: boolean; passThrough: boolean }>();
      for (const grp of restoredGroups) {
        if (childIds.has(grp.id)) continue;
        const st = { visible: grp.visible, locked: grp.locked, passThrough: grp.passThrough };
        for (const gid of getDescendantGroupIds(grp.id, restoredGroups)) groupOverride.set(gid, st);
        for (const lid of getDescendantLeafIds(grp.id, restoredGroups, elementIdSet)) {
          leafOverride.set(lid, st);
        }
      }
      groups.value = restoredGroups.map((g) => {
        const st = groupOverride.get(g.id);
        return st ? { ...g, ...st } : g;
      });
      elements.value = elements.value.map((el) => {
        const st = leafOverride.get(el.id);
        return st ? ({ ...el, ...st } as WorldElement) : el;
      });
    }
  }
  normalizeZIndices();
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

function probeVideoStreamDimensions(
  stream: MediaStream,
  track?: MediaStreamTrack,
): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    let settled = false;

    const finish = (w: number, h: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('resize', onMeta);
      video.pause();
      video.srcObject = null;
      resolve({ w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) });
    };

    const onMeta = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        finish(video.videoWidth, video.videoHeight);
      }
    };

    const timer = window.setTimeout(() => {
      const settings = track?.getSettings?.();
      const fw = settings?.width && settings.width > 0 ? settings.width : 1280;
      const fh = settings?.height && settings.height > 0 ? settings.height : 720;
      finish(fw, fh);
    }, 700);

    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('resize', onMeta);
    video.srcObject = stream;
    void video.play().catch(() => {});
  });
}

function handleMediaNaturalSizeChange(id: string, w: number, h: number) {
  if (w <= 0 || h <= 0) return;
  const el = elements.value.find((e) => e.id === id);
  if (!el || el.kind !== 'screen') return;
  if (el.naturalW === w && el.naturalH === h) return;

  // Update true source dimensions; if uncropped rect, preserve center & scale to match true source aspect
  const patch: Partial<ScreenElement> = { naturalW: w, naturalH: h };
  if (el.quadMode === 'rect' && !isItemCropped(el.crop)) {
    const rect = quadToBoundingRect(el.corners);
    const cx = rect.x + rect.w * 0.5;
    const cy = rect.y + rect.h * 0.5;
    const oldDiag = Math.hypot(rect.w, rect.h);
    const newDiag = Math.hypot(w, h);
    if (oldDiag > 16 && newDiag > 0) {
      const scale = oldDiag / newDiag;
      const nextW = Math.max(48, w * scale);
      const nextH = Math.max(48, h * scale);
      patch.corners = rectToQuad({
        x: cx - nextW * 0.5,
        y: cy - nextH * 0.5,
        w: nextW,
        h: nextH,
      });
    }
  }
  updateElement(id, patch);
}

async function addScreenProjection() {
  if (!canScreenCapture) {
    handleUnavailableClick('screenUnsupported');
    return;
  }
  screenPickerOpen.value = true;
  clearHoverLocked();
  // Ensure OS overlay click-through (WS_EX_TRANSPARENT) is disabled BEFORE the native screen picker opens!
  await syncOverlayHitRegions();
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' } as MediaTrackConstraints,
      audio: false,
    });
    const id = generateCanvasItemId('scr');
    const track = stream.getVideoTracks()[0];
    // Probe the actual decoded video source dimensions (window/tab/region size), NOT the monitor size!
    const { w: naturalW, h: naturalH } = await probeVideoStreamDimensions(stream, track);
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
  } finally {
    screenPickerOpen.value = false;
    await syncOverlayHitRegions();
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
  if (
    settingsOpen.value ||
    screenPickerOpen.value ||
    unavailableReasonKey.value ||
    screenshotPromptOpen.value
  ) {
    clearHoverLocked();
    return;
  }

  // 1. Keep current locked hover pinned while cursor is inside its floating toolbar
  //    or traveling through the tapered bridge corridor between the element and its toolbar.
  //    Leaving in any other direction hides immediately (0ms).
  const cur = hoveredLockedTarget.value;
  if (cur) {
    const usePrimaryTb = singleSelectedTarget.value?.id === cur.id;
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
    hoveredLockedId.value = fullCanvasEnabled.value ? resolveTargetId(hitLocked.id) : hitLocked.id;
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

function canScrollAncestorConsumeWheel(
  target: EventTarget | null,
  boundary: EventTarget | null,
  deltaX: number,
  deltaY: number,
): boolean {
  let el: Element | null = target instanceof Element ? target : null;
  while (el && el !== boundary && el !== document.body && el !== document.documentElement) {
    if (el instanceof HTMLElement) {
      const style = window.getComputedStyle(el);
      const canY =
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 1;
      if (canY && deltaY !== 0) {
        if (deltaY < 0 && el.scrollTop > 0) return true;
        if (deltaY > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
      }
      const canX =
        (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
        el.scrollWidth > el.clientWidth + 1;
      if (canX && deltaX !== 0) {
        if (deltaX < 0 && el.scrollLeft > 0) return true;
        if (deltaX > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

function onRootWheel(e: WheelEvent) {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    return;
  }
  if (
    backdropMode.value !== 'canvas' ||
    settingsOpen.value ||
    !!imagePreview.value ||
    unavailableReasonKey.value ||
    isUiControlTarget(e.target)
  ) {
    if (!canScrollAncestorConsumeWheel(e.target, e.currentTarget, e.deltaX, e.deltaY)) {
      e.preventDefault();
    }
    return;
  }
  e.preventDefault();
  const deltaY = Math.max(-180, Math.min(180, e.deltaY));
  const factor = Math.exp(-deltaY * 0.0014);
  canvasViewport.value = zoomViewportAt(
    canvasViewport.value,
    canvasViewport.value.zoom * factor,
    { x: e.clientX, y: e.clientY },
  );
}

function onWindowScrollGuard() {
  if (window.scrollX !== 0 || window.scrollY !== 0) {
    window.scrollTo(0, 0);
  }
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
  if (
    type === 'keydown' &&
    e.code === 'F12' &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.shiftKey &&
    !e.metaKey &&
    platform === 'tauri' &&
    isDebugBuild
  ) {
    if (!e.repeat) {
      void toggleOsDevtools();
    }
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  if (type === 'keydown' && e.code === 'Escape') {
    if (imagePreview.value) {
      e.preventDefault();
      imagePreview.value = null;
      return;
    }
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

  if (settingsOpen.value || !!imagePreview.value || unavailableReasonKey.value) return;

  const activeTag = (document.activeElement?.tagName || '').toLowerCase();
  if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') return;

  if (e.code === 'Space') {
    spacePanning.value = type === 'keydown' && backdropMode.value === 'canvas';
  }

  const sel = singleSelectedTarget.value;
  const canDeleteSel =
    !!sel &&
    !sel.locked &&
    (sel.kind === 'group' ? !sel.hasGrid : sel.kind !== 'grid');
  if (
    type === 'keydown' &&
    canDeleteSel &&
    sel &&
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
  if (selectedTargetIds.value.length > 0) {
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
let isDebugBuild = getInitialIsDebugBuild();
window.__PENPAANYWHERE_IS_DEBUG__ = isDebugBuild;

function onWindowContextMenu(e: MouseEvent) {
  if (!isDebugBuild) {
    e.preventDefault();
  }
}

// Unified click-outside deselection: clicking ANY surface outside the selected canvas element(s),
// their transform gizmo/toolbar, or the Layers table rows immediately cancels selection.
function onGlobalPointerDownDeselect(e: PointerEvent) {
  if (e.button === 1) return; // keep selection when middle-mouse panning
  if (selectedTargetIds.value.length === 0 && !cropDraft.value) return;
  const target = e.target instanceof Element ? e.target : null;
  if (!target) {
    selectElement(null);
    return;
  }
  if (
    target.closest(
      '.ac-gizmo-layer, .ac-canvas-item, .ac-crop-ghost, .ac-draw-hit-poly, .ac-layers-scroll',
    )
  ) {
    return;
  }
  selectElement(null);
}

onMounted(async () => {
  window.addEventListener('pointerdown', onGlobalPointerDownDeselect, true);
  window.addEventListener('paste', onPaste);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('contextmenu', onWindowContextMenu);
  window.addEventListener('pointermove', onWindowPointerMoveForHover, { passive: true });
  window.addEventListener('pointermove', onWindowMiddlePanMove);
  window.addEventListener('pointerup', onWindowMiddlePanUp);
  window.addEventListener('pointercancel', onWindowMiddlePanUp);
  document.addEventListener('mouseleave', onWindowPointerLeave);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('scroll', onWindowScrollGuard, { passive: true });
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
    if (key === 'penpaCloneUnsupported') {
      handleUnavailableClick(key);
    }
  };
  window.__PENPAANYWHERE_OPEN_EXTERNAL__ = (url: string) => {
    void openExternalLink(url);
  };
  window.__PENPAANYWHERE_DOWNLOAD__ = (filename: string, mimeType: string, base64Data: string) => {
    void handleHostDownload(filename, mimeType, base64Data);
  };
  window.__PENPAANYWHERE_PREVIEW_IMAGE__ = (dataUrl: string, filename: string, mimeType: string) => {
    if (!dataUrl) return;
    imagePreview.value = {
      dataUrl,
      filename: filename || 'penpa-image.png',
      mimeType: mimeType || 'image/png',
    };
  };
  window.__PENPAANYWHERE_TOGGLE_DEVTOOLS__ = (shouldToggle = true) => {
    if (platform !== 'tauri' || !isDebugBuild) return false;
    if (shouldToggle) {
      void toggleOsDevtools();
    }
    return true;
  };
  window.__PENPAANYWHERE_ON_IFRAME_INTERACT__ = () => {
    iframeInteractTick.value++;
    if (selectedTargetIds.value.length > 0 || cropDraft.value) {
      selectElement(null);
    }
  };

  isDebugBuild = await getIsDebugBuild();
  window.__PENPAANYWHERE_IS_DEBUG__ = isDebugBuild;

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
  delete window.__PENPAANYWHERE_TOGGLE_DEVTOOLS__;
  delete window.__PENPAANYWHERE_ON_IFRAME_INTERACT__;
  delete window.__PENPAANYWHERE_OPEN_EXTERNAL__;
  delete window.__PENPAANYWHERE_DOWNLOAD__;
  delete window.__PENPAANYWHERE_PREVIEW_IMAGE__;
  if (toastTimer) {
    window.clearTimeout(toastTimer);
    toastTimer = 0;
  }
  window.removeEventListener('pointerdown', onGlobalPointerDownDeselect, true);
  window.removeEventListener('paste', onPaste);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('contextmenu', onWindowContextMenu);
  window.removeEventListener('pointermove', onWindowPointerMoveForHover);
  window.removeEventListener('pointermove', onWindowMiddlePanMove);
  window.removeEventListener('pointerup', onWindowMiddlePanUp);
  window.removeEventListener('pointercancel', onWindowMiddlePanUp);
  document.removeEventListener('mouseleave', onWindowPointerLeave);
  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('scroll', onWindowScrollGuard);
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
      :button-display-mode="buttonDisplayMode"
      @select="(id) => selectElement(id, false)"
    />

    <!-- Unified World Elements rendered as direct siblings in stable DOM order (true shared zIndex via CSS!) -->
    <template v-for="el in visibleElementsStable" :key="el.id">
      <PerspectiveOverlay
        v-if="el.kind === 'grid'"
        :ref="(inst) => setOverlayRef(el.id, inst as InstanceType<typeof PerspectiveOverlay> | null)"
        :element="el"
        :bridge="gridBridges.get(el.id) ?? null"
        :has-dom-backdrop="hasDomBackdrop"
        :viewport-transform="effectiveViewportTransform"
        :world-bounded-to-viewport="backdropMode === 'overlay'"
        :selected="isElementVisuallySelected(el.id)"
        :multi-selected="selectedTargetIds.length >= 2 && isElementVisuallySelected(el.id)"
        :grouped="fullCanvasEnabled && !!getGroupForElement(el.id)"
        :crop-draft="cropDraft?.elementId === el.id ? cropDraft : null"
        :space-panning="backdropMode === 'canvas' && spacePanning"
        @select="selectElement"
        @focus-multi-member="focusMultiMember"
        @move-start="handleMoveStart"
        @translate-by="handleTranslateBy"
        @move-end="handleMoveEnd"
        @update-corners="updateElementCorners"
        @update-crop-draft="updateCropDraft"
        @toggle-crop="(id) => { if (fullCanvasEnabled && getGroupForElement(id)) return; cropDraft?.elementId === id ? cancelCropDraft() : startCropMode(id); }"
        @quad-geometry-change="(q) => setGridOuterQuad(el.id, q)"
        @bounds-change="(b) => setGridBounds(el.id, b)"
      />
      <MediaElementView
        v-else
        :element="el"
        :stream="el.kind === 'screen' ? (screenStreams.get(el.streamId) ?? null) : null"
        :viewport-transform="effectiveViewportTransform"
        :world-bounded-to-viewport="backdropMode === 'overlay'"
        :selected="isElementVisuallySelected(el.id)"
        :multi-selected="selectedTargetIds.length >= 2 && isElementVisuallySelected(el.id)"
        :grouped="fullCanvasEnabled && !!getGroupForElement(el.id)"
        :crop-draft="cropDraft?.elementId === el.id ? cropDraft : null"
        :space-panning="backdropMode === 'canvas' && spacePanning"
        @select="selectElement"
        @focus-multi-member="focusMultiMember"
        @move-start="handleMoveStart"
        @translate-by="handleTranslateBy"
        @move-end="handleMoveEnd"
        @update-corners="updateElementCorners"
        @update-crop-draft="updateCropDraft"
        @update-natural-size="handleMediaNaturalSizeChange"
        @toggle-crop="(id) => { if (fullCanvasEnabled && getGroupForElement(id)) return; cropDraft?.elementId === id ? cancelCropDraft() : startCropMode(id); }"
      />
    </template>

    <!-- Unified Transform / Crop / Lock / Group Gizmo + Floating Context Toolbar for ALL World Elements & Groups -->
    <TransformGizmo
      :selected-targets="selectedTargets"
      :crop-draft="cropDraft"
      :hovered-locked-target="hoveredLockedTarget"
      :viewport-transform="effectiveViewportTransform"
      :world-bounded-to-viewport="backdropMode === 'overlay'"
      :show-layer-order-actions="fullCanvasEnabled"
      :button-display-mode="buttonDisplayMode"
      :grid-bounds="selectedElement?.kind === 'grid' ? gridBoundsMap.get(selectedElement.id) : undefined"
      @resize-start="handleResizeStart"
      @resize-end="handleResizeEnd"
      @update-element="updateTarget"
      @update-quad-mode="updateElementQuadMode"
      @reset-size="resetElementSize"
      @start-crop="startCropMode"
      @update-crop-draft="updateCropDraft"
      @commit-crop="commitCropDraft"
      @cancel-crop="cancelCropDraft"
      @group-selected="groupSelectedTargets"
      @ungroup-target="ungroupTarget"
      @toggle-passthrough="toggleElementPassThrough"
      @toggle-dock="toggleGridDock"
      @bring-front="bringElementFront"
      @send-back="sendElementBack"
      @remove-element="removeElement"
      @lock-element="handleLockElement"
      @unlock-element="handleUnlockElement"
      @toolbar-bounds-change="(r) => (toolbarRect = r)"
      @hover-toolbar-bounds-change="(r) => (hoverToolbarRect = r)"
    />

    <!-- Independent Penpa+ Tool Windows (one per GridElement; carries per-grid Blend, Alpha Boost & Opacity) -->
    <PenpaDockWindow
      v-for="grid in gridElements"
      :key="`dock-${grid.id}`"
      :visible="grid.dockVisible"
      :title="grid.label || messages.stage.gridDefaultLabel"
      :backdrop-mode="backdropMode"
      :blend-mode="grid.blendMode"
      :board-opacity="grid.opacity"
      :enhance-opacity="grid.enhanceOpacity"
      :show-unavailable-options="showUnavailableOptions"
      :global-scale="globalScale"
      :penpa-scale="penpaScale"
      :blur-opacity="penpaBlurOpacity"
      :iframe-interact-tick="iframeInteractTick"
      @update:visible="(v) => updateElement(grid.id, { dockVisible: v })"
      @update:blend-mode="(v) => updateElement(grid.id, { blendMode: v })"
      @update:board-opacity="(v) => updateElement(grid.id, { opacity: v })"
      @update:enhance-opacity="(v) => updateElement(grid.id, { enhanceOpacity: v })"
      @unavailable-click="handleUnavailableClick"
      @bridge-ready="(b) => setGridBridge(grid.id, b)"
      @bounds-change="(r) => setDockRect(grid.id, r)"
    />

    <!-- Global MD3 Control Bar (with inline expandable Add picker & aligned Layers table) -->
    <ControlBar
      v-model:layers-visible="layersVisible"
      v-model:always-on-top="alwaysOnTop"
      :backdrop-mode="backdropMode"
      :platform="platform"
      :can-switch-overlay="canSwitchOverlay"
      :can-screen-capture="canScreenCapture"
      :can-pin-window="platform === 'tauri'"
      :full-canvas-enabled="fullCanvasEnabled"
      :elements="activeLayerTargets"
      :selected-ids="selectedTargetIds"
      :button-display-mode="buttonDisplayMode"
      :global-scale="globalScale"
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
      @rename-element="renameTarget"
      @open-settings="settingsOpen = true"
      @close-overlay="handleCloseOverlay"
      @bounds-change="(r) => (barRect = r)"
    />

    <!-- Settings Modal -->
    <SettingsDialog
      v-model:open="settingsOpen"
      v-model:custom-css-enabled="customCssEnabled"
      v-model:custom-css="customCss"
      v-model:button-display-mode="buttonDisplayMode"
      v-model:global-scale="globalScale"
      v-model:penpa-scale="penpaScale"
      v-model:penpa-blur-opacity="penpaBlurOpacity"
      v-model:overlay-full-canvas="overlayFullCanvas"
      v-model:show-unavailable-options="showUnavailableOptions"
      :platform="platform"
      :android-screenshot-status="androidScreenshotStatus"
      @unavailable-click="handleUnavailableClick"
      @toggle-android-screenshot-composite="handleToggleAndroidScreenshotComposite"
      @request-android-all-files="handleRequestAndroidAllFiles"
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

    <!-- In-App Exported Image Preview Dialog (non-Web saveimage_window) -->
    <div
      v-if="imagePreview"
      class="ac-prompt-backdrop ac-preview-backdrop"
      @pointerdown.self="imagePreview = null"
    >
      <section
        class="ac-prompt-card ac-preview-card"
        role="dialog"
        aria-modal="true"
        :aria-label="messages.imagePreview.ariaLabel"
      >
        <div class="ac-prompt-title">{{ messages.imagePreview.title }}</div>
        <div class="ac-preview-stage">
          <img :src="imagePreview.dataUrl" :alt="imagePreview.filename" class="ac-preview-img" />
        </div>
        <div class="ac-prompt-file">{{ imagePreview.filename }}</div>
        <div class="ac-prompt-actions">
          <button class="ac-btn" @click="imagePreview = null">
            {{ messages.imagePreview.close }}
          </button>
          <button class="ac-btn active" @click="handleSavePreviewImage">
            {{ messages.imagePreview.save }}
          </button>
        </div>
      </section>
    </div>

    <!-- Lightweight non-blocking host Toast (e.g. desktop Downloads feedback) -->
    <div v-if="toastMessage" class="ac-host-toast" role="status" aria-live="polite">
      {{ toastMessage }}
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

.ac-preview-backdrop {
  z-index: 1240;
}

.ac-preview-card {
  width: min(640px, 92vw);
  max-height: min(86vh, 720px);
}

.ac-preview-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  max-height: min(60vh, 520px);
  overflow: auto;
  overscroll-behavior: contain;
  padding: 10px;
  border-radius: 12px;
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
}

.ac-preview-img {
  display: block;
  max-width: 100%;
  max-height: min(56vh, 480px);
  object-fit: contain;
  border-radius: 6px;
}

/* Material Design 3 Snackbar (Inverse Surface + Extra-Small 4dp corners + Level 3 shadow) */
.ac-host-toast {
  position: fixed;
  left: 50%;
  bottom: calc(20px + var(--ac-safe-bottom, 0px));
  transform: translateX(-50%) scale(var(--ac-ui-scale, 1));
  transform-origin: bottom center;
  z-index: 1300;
  max-width: min(460px, calc(90vw / var(--ac-ui-scale, 1)));
  min-height: 40px;
  padding: 10px 16px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  background: var(--md-sys-color-inverse-surface);
  color: var(--md-sys-color-inverse-on-surface);
  font-size: 13px;
  font-weight: 400;
  line-height: 1.4;
  letter-spacing: 0.015em;
  box-shadow:
    0 4px 8px 3px color-mix(in srgb, var(--md-sys-color-shadow) 15%, transparent),
    0 1px 3px color-mix(in srgb, var(--md-sys-color-shadow) 30%, transparent);
  pointer-events: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ac-prompt-card {
  width: min(380px, calc((100vw - 32px) / var(--ac-ui-scale, 1)));
  transform: scale(var(--ac-ui-scale, 1));
  transform-origin: center center;
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
