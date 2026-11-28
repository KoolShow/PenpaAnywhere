<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import PerspectiveOverlay from './PerspectiveOverlay.vue';
import MediaElementView from './MediaElementView.vue';
import TransformGizmo from './TransformGizmo.vue';
import ControlBar from './ControlBar.vue';
import SettingsDialog from './SettingsDialog.vue';
import {
  customHue,
  dynamicColorEnabled,
  setCustomHue,
  setDynamicColorEnabled,
  setThemeMode,
  themeMode,
} from '../core/theme';
import { currentLocale, messages, setLocale } from '../core/i18n';
import {
  computeCombinedWorldQuad,
  getDescendantLeafIds,
  getParentGroup,
  isElementPassThrough,
  isItemCropped,
  resolveTopLevelTargetId,
  type GridElement,
  type GroupSelectionTarget,
  type ImageElement,
  type ScreenElement,
  type SelectableTarget,
  type WorldElement,
} from '../core/canvasItems';
import { isPointInQuad, rectToQuad, type Point2D } from '../core/homography';
import { loadCanvasImageBlob } from '../core/canvasMediaDb';
import {
  getAllGridFrameMetas,
  getGridFrameRgba,
  getOsMonitors,
  getSharedMultiMonitorHost,
  notifyOsViewportReady,
  parseCurrentWindowRole,
  relayWorldCommand,
  type GridFrameMeta,
} from '../core/multiMonitor';
import type { PenpaIframeBridge } from '../core/penpaBridge';
import {
  IDENTITY_VIEWPORT_TRANSFORM,
  findOwnerMonitorForPhysicalQuad,
  monitorToViewportTransform,
  quadIntersectsMonitor,
  worldQuadToViewport,
  type MonitorDescriptor,
  type WorldViewportTransform,
} from '../core/world';
import type {
  PenpaPointerOpts,
  PenpaPointerType,
  RemoteGridFrame,
  SerializedImageElement,
  WorldCommand,
  WorldGeometryDelta,
  WorldStateSnapshot,
} from '../core/worldSync';
import { getInitialIsDebugBuild, getIsDebugBuild } from '../core/platform';

const roleInfo = parseCurrentWindowRole();
const targetMonitorId = ref<string>(roleInfo.monitorId ?? '');
const monitors = ref<MonitorDescriptor[]>([]);
const snapshot = ref<WorldStateSnapshot | null>(null);
const localHoveredTargetId = ref<string | null>(null);

const imageSrcMap = ref<Map<string, string>>(new Map());
const loadingImageIds = new Set<string>();
const sharedBridges = ref<Map<string, PenpaIframeBridge>>(new Map());
const sharedScreenStreams = ref<Map<string, MediaStream>>(new Map());
const remoteFrames = ref<Map<string, RemoteGridFrame>>(new Map());
const gridOuterQuads = ref<Map<string, [Point2D, Point2D, Point2D, Point2D]>>(new Map());
const barRect = ref({ x: 0, y: 0, w: 0, h: 0 });
const toolbarRect = ref({ x: 0, y: 0, w: 0, h: 0 });
const hoverToolbarRect = ref({ x: 0, y: 0, w: 0, h: 0 });

const myMonitor = computed<MonitorDescriptor | null>(() => {
  const list = monitors.value.length > 0 ? monitors.value : (snapshot.value?.monitors ?? []);
  if (!targetMonitorId.value) return list[0] ?? null;
  return list.find((m) => m.id === targetMonitorId.value) ?? null;
});

const viewportTransform = computed<WorldViewportTransform>(() =>
  myMonitor.value ? monitorToViewportTransform(myMonitor.value) : IDENTITY_VIEWPORT_TRANSFORM,
);

const worldElements = computed<WorldElement[]>(() => {
  const snap = snapshot.value;
  if (!snap) return [];
  const out: WorldElement[] = [];
  for (const raw of snap.elements) {
    if (raw.kind === 'grid') {
      out.push(raw);
    } else if (raw.kind === 'image') {
      const src = imageSrcMap.value.get(raw.id) ?? '';
      out.push({ ...raw, src } as ImageElement);
    } else if (raw.kind === 'screen') {
      out.push(raw as ScreenElement);
    }
  }
  return out;
});

const groups = computed(() => snapshot.value?.groups ?? []);
const fullCanvasEnabled = computed(() => snapshot.value?.fullCanvasEnabled ?? false);
const buttonDisplayMode = computed(() => snapshot.value?.buttonDisplayMode ?? 'icon-text');
const toolbarHiddenSet = computed(() => new Set(snapshot.value?.toolbarHiddenTargetIds ?? []));
const showControlBarOnThisViewport = computed<boolean>(() => {
  const mon = myMonitor.value;
  if (!mon || !snapshot.value) return false;
  return snapshot.value.activeControlBarMonitorId === mon.id;
});
const isModalOnThisViewport = computed<boolean>(() => {
  const mon = myMonitor.value;
  if (!mon || !snapshot.value) return false;
  return snapshot.value.modalMonitorId === mon.id;
});
const settingsOpenOnThisViewport = computed<boolean>(
  () => !!snapshot.value?.settingsOpen && isModalOnThisViewport.value,
);
const unavailableDialogInfoOnThisViewport = computed<{ title: string; body: string } | null>(() => {
  if (!isModalOnThisViewport.value) return null;
  const key = snapshot.value?.unavailableReasonKey ?? null;
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
    case 'multiMonitorUnavailable':
      return { title: u.multiMonitorUnavailableTitle, body: u.multiMonitorUnavailableBody };
  }
});
const modalBlockingOnThisViewport = computed<boolean>(
  () => settingsOpenOnThisViewport.value || !!unavailableDialogInfoOnThisViewport.value,
);
const localBarOverride = ref<{ xRatio: number; yRatio: number; compact: boolean } | null>(null);
function getInitialBarOverride() {
  return (
    localBarOverride.value ??
    getSharedMultiMonitorHost()?.getBarPosition(myMonitor.value?.id) ??
    null
  );
}

function handleSecondaryBarStateChange(st: { xRatio: number; yRatio: number; compact: boolean }) {
  localBarOverride.value = { xRatio: st.xRatio, yRatio: st.yRatio, compact: !!st.compact };
  const monId = myMonitor.value?.id;
  const host = getSharedMultiMonitorHost();
  if (host) {
    host.setBarPosition(st, monId);
  } else {
    sendCmd({ type: 'bar-state-change', monitorId: monId, state: st });
  }
}

let syncingThemeFromHost = false;
function pullThemeLocaleFromHost() {
  const host = getSharedMultiMonitorHost();
  if (!host) return;
  const st = host.getThemeAndLocale();
  syncingThemeFromHost = true;
  try {
    if (st.themeMode !== themeMode.value) setThemeMode(st.themeMode);
    if (st.dynamicColorEnabled !== dynamicColorEnabled.value) {
      setDynamicColorEnabled(st.dynamicColorEnabled);
    }
    if (st.customHue !== customHue.value) setCustomHue(st.customHue);
    if (st.locale !== currentLocale.value) setLocale(st.locale);
  } finally {
    syncingThemeFromHost = false;
  }
}

function pushThemeLocaleToHost() {
  if (syncingThemeFromHost) return;
  getSharedMultiMonitorHost()?.syncThemeAndLocaleFromChild({
    themeMode: themeMode.value,
    dynamicColorEnabled: dynamicColorEnabled.value,
    customHue: customHue.value,
    locale: currentLocale.value,
  });
}

watch([themeMode, dynamicColorEnabled, customHue, currentLocale], () => {
  if (settingsOpenOnThisViewport.value) {
    pushThemeLocaleToHost();
  }
});

watch(modalBlockingOnThisViewport, (open) => {
  if (open) {
    localHoveredTargetId.value = null;
    pullThemeLocaleFromHost();
    void import('@tauri-apps/api/webviewWindow')
      .then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().setFocus())
      .catch(() => {});
  }
});

watch(
  () => snapshot.value?.globalScale,
  (s) => {
    const clamped = Math.max(0.7, Math.min(1.5, Number.isFinite(s) ? (s as number) : 1));
    document.documentElement.style.setProperty('--ac-ui-scale', String(clamped));
  },
  { immediate: true },
);

async function ensureImageBlobsLoaded(images: SerializedImageElement[]) {
  const validIds = new Set(images.map((i) => i.id));
  for (const [id, src] of imageSrcMap.value.entries()) {
    if (!validIds.has(id)) {
      if (src.startsWith('blob:')) URL.revokeObjectURL(src);
      const next = new Map(imageSrcMap.value);
      next.delete(id);
      imageSrcMap.value = next;
    }
  }
  for (const img of images) {
    if (imageSrcMap.value.has(img.id) || loadingImageIds.has(img.id)) continue;
    loadingImageIds.add(img.id);
    try {
      const blob = await loadCanvasImageBlob(img.id);
      if (blob) {
        const url = URL.createObjectURL(blob);
        const next = new Map(imageSrcMap.value);
        next.set(img.id, url);
        imageSrcMap.value = next;
      }
    } finally {
      loadingImageIds.delete(img.id);
    }
  }
}

const fetchInFlightIds = new Set<string>();
const pendingFetchMetaById = new Map<string, GridFrameMeta>();

async function fetchRemoteFrame(meta: GridFrameMeta) {
  // Zero-copy same-renderer bridge already supplies live GPU canvas directly
  if (sharedBridges.value.has(meta.gridId)) return;
  // Skip pulling frames for grids not intersecting this monitor
  if (!visibleIntersectingElements.value.some((e) => e.id === meta.gridId)) return;
  const existing = remoteFrames.value.get(meta.gridId);
  if (existing && existing.seq >= meta.seq) return;
  if (fetchInFlightIds.has(meta.gridId)) {
    pendingFetchMetaById.set(meta.gridId, meta);
    return;
  }
  fetchInFlightIds.add(meta.gridId);
  try {
    const rgba = await getGridFrameRgba(meta.gridId);
    if (!rgba || rgba.byteLength < meta.width * meta.height * 4) return;
    const next = new Map(remoteFrames.value);
    next.set(meta.gridId, {
      rgba,
      width: meta.width,
      height: meta.height,
      seq: meta.seq,
    });
    remoteFrames.value = next;
  } finally {
    fetchInFlightIds.delete(meta.gridId);
    const nextMeta = pendingFetchMetaById.get(meta.gridId);
    if (nextMeta) {
      pendingFetchMetaById.delete(meta.gridId);
      void fetchRemoteFrame(nextMeta);
    }
  }
}

const visibleIntersectingElements = computed<WorldElement[]>(() => {
  const mon = myMonitor.value;
  if (!mon) return [];
  const margin = Math.round(160 * (mon.scale || 1));
  const dragging = new Set(snapshot.value?.activeDraggingElementIds ?? []);
  return worldElements.value.filter(
    (el) => el.visible && (dragging.has(el.id) || quadIntersectsMonitor(el.corners, mon, margin)),
  );
});

function buildGroupTarget(g: (typeof groups.value)[number]): GroupSelectionTarget | null {
  const byId = new Map(worldElements.value.map((e) => [e.id, e]));
  const leafIds = getDescendantLeafIds(g.id, groups.value, new Set(byId.keys()));
  const members: WorldElement[] = [];
  for (const lid of leafIds) {
    const el = byId.get(lid);
    if (el) members.push(el);
  }
  if (members.length < 2) return null;
  let maxZ = -Infinity;
  let minZ = Infinity;
  let hasGrid = false;
  let gridCount = 0;
  let dockVisible = false;
  for (const m of members) {
    if (m.zIndex > maxZ) maxZ = m.zIndex;
    if (m.zIndex < minZ) minZ = m.zIndex;
    if (m.kind === 'grid') {
      hasGrid = true;
      gridCount++;
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
    gridCount,
    dockVisible,
  };
}

const activeLayerTargets = computed<SelectableTarget[]>(() => {
  const childIds = new Set<string>();
  for (const g of groups.value) {
    for (const mid of g.memberIds) childIds.add(mid);
  }
  const targets: SelectableTarget[] = [];
  for (const g of groups.value) {
    if (childIds.has(g.id)) continue;
    const gt = buildGroupTarget(g);
    if (gt) targets.push(gt);
  }
  for (const el of worldElements.value) {
    if (!childIds.has(el.id)) targets.push(el);
  }
  return targets.sort((a, b) => a.zIndex - b.zIndex);
});

const globalSelectedTargets = computed<SelectableTarget[]>(() => {
  const snap = snapshot.value;
  if (!snap) return [];
  const map = new Map(activeLayerTargets.value.map((t) => [t.id, t]));
  const list: SelectableTarget[] = [];
  for (const id of snap.selectedTargetIds) {
    const t = map.get(id);
    if (t && t.visible) list.push(t);
  }
  return list;
});

const selectedTargets = computed<SelectableTarget[]>(() => {
  const mon = myMonitor.value;
  if (!mon) return [];
  const margin = Math.round(180 * (mon.scale || 1));
  return globalSelectedTargets.value.filter((t) => quadIntersectsMonitor(t.corners, mon, margin));
});

// Show the floating selection toolbar ONLY on the single monitor owning the selection's center!
const showSelectionToolbarOnThisViewport = computed<boolean>(() => {
  const mon = myMonitor.value;
  const list = monitors.value.length > 0 ? monitors.value : (snapshot.value?.monitors ?? []);
  if (!mon || list.length < 2) return true;
  if (globalSelectedTargets.value.length === 0) return false;
  let combinedQuad: [Point2D, Point2D, Point2D, Point2D];
  if (globalSelectedTargets.value.length === 1) {
    combinedQuad = globalSelectedTargets.value[0].corners;
  } else {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const t of globalSelectedTargets.value) {
      for (const p of t.corners) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    combinedQuad = rectToQuad({ x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) });
  }
  const owner = findOwnerMonitorForPhysicalQuad(combinedQuad, list);
  return owner?.id === mon.id;
});

const singleSelectedTarget = computed<SelectableTarget | null>(() =>
  selectedTargets.value.length === 1 ? selectedTargets.value[0] : null,
);

const hoveredTarget = computed<SelectableTarget | null>(() => {
  if (!localHoveredTargetId.value) return null;
  const t = activeLayerTargets.value.find((x) => x.id === localHoveredTargetId.value) ?? null;
  if (!t) return null;
  if (t.visible ? !t.locked : !toolbarHiddenSet.value.has(t.id)) return null;
  return t;
});

const linkedHighlightGridQuad = computed<[Point2D, Point2D, Point2D, Point2D] | null>(() => {
  const snap = snapshot.value;
  const mon = myMonitor.value;
  if (!snap || !mon || !snap.focusedDockId) return null;
  const visGrids = worldElements.value.filter((e): e is GridElement => e.kind === 'grid' && e.visible);
  if (visGrids.length < 2) return null;
  const grid = visGrids.find((g) => g.id === snap.focusedDockId);
  if (!grid || !quadIntersectsMonitor(grid.corners, mon, 64)) return null;
  return grid.corners;
});

function isElementVisuallySelected(elId: string): boolean {
  const snap = snapshot.value;
  if (!snap) return false;
  const tid = fullCanvasEnabled.value ? resolveTopLevelTargetId(elId, groups.value) : elId;
  return snap.selectedTargetIds.includes(tid);
}

function sendCmd(cmd: WorldCommand) {
  void relayWorldCommand(cmd);
}

function setGridOuterQuad(gridId: string, q: [Point2D, Point2D, Point2D, Point2D]) {
  const next = new Map(gridOuterQuads.value);
  next.set(gridId, q);
  gridOuterQuads.value = next;
}

function handleRemotePointer(
  gridId: string,
  eventType: PenpaPointerType,
  u: number,
  v: number,
  opts?: PenpaPointerOpts,
) {
  sendCmd({ type: 'penpa-pointer', gridId, eventType, u, v, opts });
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

function evaluateHoverAt(x: number, y: number) {
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  if (x < -40 || y < -40 || x > vw + 40 || y > vh + 40) {
    localHoveredTargetId.value = null;
    return;
  }
  const cur = hoveredTarget.value;
  if (cur) {
    const usePrimaryTb = singleSelectedTarget.value?.id === cur.id;
    const tbRect = usePrimaryTb ? toolbarRect.value : hoverToolbarRect.value;
    if (pointInPaddedRect(x, y, tbRect, 6)) return;
  }

  const topEl = document.elementFromPoint(x, y);
  if (topEl?.closest('.ac-control-bar, .ac-dock')) {
    localHoveredTargetId.value = null;
    return;
  }

  const mon = myMonitor.value;
  if (!mon) {
    localHoveredTargetId.value = null;
    return;
  }
  const margin = Math.round(160 * (mon.scale || 1));
  const candidates = worldElements.value
    .filter((el) => {
      if (!quadIntersectsMonitor(el.corners, mon, margin)) return false;
      if (el.visible) return true;
      const tid = fullCanvasEnabled.value ? resolveTopLevelTargetId(el.id, groups.value) : el.id;
      return toolbarHiddenSet.value.has(tid);
    })
    .sort((a, b) => b.zIndex - a.zIndex);

  let hit: WorldElement | null = null;
  for (const el of candidates) {
    const vpQuad =
      el.visible && el.kind === 'grid' && el.locked && !isItemCropped(el.crop)
        ? (gridOuterQuads.value.get(el.id) ?? worldQuadToViewport(el.corners, viewportTransform.value))
        : worldQuadToViewport(el.corners, viewportTransform.value);
    if (!isPointInQuad({ x, y }, vpQuad)) continue;
    if (!el.visible || isElementPassThrough(el)) {
      hit = el;
      break;
    }
    if (el.locked) hit = el;
    break;
  }
  localHoveredTargetId.value = hit
    ? fullCanvasEnabled.value
      ? resolveTopLevelTargetId(hit.id, groups.value)
      : hit.id
    : null;
}

async function syncHitRegions() {
  const extraUiRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  if (selectedTargets.value.length > 0 && toolbarRect.value.w > 0 && toolbarRect.value.h > 0) {
    extraUiRects.push(toolbarRect.value);
  }
  if (hoveredTarget.value && hoverToolbarRect.value.w > 0 && hoverToolbarRect.value.h > 0) {
    extraUiRects.push(hoverToolbarRect.value);
  }

  const interactiveQuads: Array<[Point2D, Point2D, Point2D, Point2D]> = [];
  for (const el of visibleIntersectingElements.value) {
    if (isElementPassThrough(el)) continue;
    if (el.kind === 'grid') {
      interactiveQuads.push(
        gridOuterQuads.value.get(el.id) ?? worldQuadToViewport(el.corners, viewportTransform.value),
      );
    } else {
      interactiveQuads.push(worldQuadToViewport(el.corners, viewportTransform.value));
    }
  }

  let gizmoQuad: [Point2D, Point2D, Point2D, Point2D] | null = null;
  const cd = snapshot.value?.cropDraft ?? null;
  if (cd) {
    gizmoQuad = worldQuadToViewport(rectToQuad(cd.croppedRect), viewportTransform.value);
  } else if (
    singleSelectedTarget.value &&
    singleSelectedTarget.value.visible &&
    !singleSelectedTarget.value.locked
  ) {
    gizmoQuad = worldQuadToViewport(singleSelectedTarget.value.corners, viewportTransform.value);
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('update_hit_regions', {
      enabled: !modalBlockingOnThisViewport.value,
      forceClickThrough: false,
      barRect: showControlBarOnThisViewport.value ? barRect.value : { x: 0, y: 0, w: 0, h: 0 },
      dockRect: { x: 0, y: 0, w: 0, h: 0 },
      uiRects: extraUiRects,
      quads: interactiveQuads,
      gizmoQuad,
    });
  } catch {
    // ignore
  }
}

watch(
  [
    visibleIntersectingElements,
    selectedTargets,
    hoveredTarget,
    showControlBarOnThisViewport,
    modalBlockingOnThisViewport,
    barRect,
    toolbarRect,
    hoverToolbarRect,
    gridOuterQuads,
    () => snapshot.value?.cropDraft,
  ],
  () => {
    void syncHitRegions();
  },
  { deep: true },
);

let isDebugBuild = getInitialIsDebugBuild();
function onWindowContextMenu(e: MouseEvent) {
  if (!isDebugBuild) e.preventDefault();
}

function onGlobalPointerDownDeselect(e: PointerEvent) {
  if (modalBlockingOnThisViewport.value) return;
  if (e.button === 1) return;
  const target = e.target instanceof Element ? e.target : null;
  if (
    target?.closest(
      '.ac-gizmo-layer, .ac-canvas-item, .ac-crop-ghost, .ac-draw-hit-poly, .ac-layers-scroll, .ac-layers-add-row',
    )
  ) {
    return;
  }
  sendCmd({ type: 'select', id: null });
}

function onKey(type: 'keydown' | 'keyup', e: KeyboardEvent) {
  if (type === 'keydown' && e.code === 'Escape') {
    if (unavailableDialogInfoOnThisViewport.value) {
      e.preventDefault();
      sendCmd({ type: 'close-unavailable' });
      return;
    }
    if (settingsOpenOnThisViewport.value) {
      e.preventDefault();
      sendCmd({ type: 'close-settings' });
      return;
    }
  }
  if (modalBlockingOnThisViewport.value) return;
  const activeTag = (document.activeElement?.tagName || '').toLowerCase();
  if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') return;
  sendCmd({
    type: 'penpa-key',
    eventType: type,
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

const onKeyDown = (e: KeyboardEvent) => onKey('keydown', e);
const onKeyUp = (e: KeyboardEvent) => onKey('keyup', e);
const unlisteners: Array<() => void> = [];

onMounted(async () => {
  window.addEventListener('pointerdown', onGlobalPointerDownDeselect, true);
  window.addEventListener('contextmenu', onWindowContextMenu);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  isDebugBuild = await getIsDebugBuild();
  monitors.value = await getOsMonitors();

  // Connect directly to `main`'s same-renderer zero-copy GPU bridge & MediaStream registry if available
  const sharedHost = getSharedMultiMonitorHost();
  if (sharedHost) {
    const refreshSharedBridges = () => {
      sharedBridges.value = new Map(sharedHost.getAllDockBridges());
    };
    const refreshSharedStreams = () => {
      sharedScreenStreams.value = new Map(sharedHost.getAllScreenStreams());
    };
    refreshSharedBridges();
    refreshSharedStreams();
    unlisteners.push(sharedHost.subscribeDockBridges(refreshSharedBridges));
    unlisteners.push(sharedHost.subscribeScreenStreams(refreshSharedStreams));
  }

  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const curWin = getCurrentWebviewWindow();
    const winLabel = curWin.label;

    unlisteners.push(
      await curWin.listen<MonitorDescriptor[]>('monitors-changed', (ev) => {
        if (Array.isArray(ev.payload)) monitors.value = ev.payload;
      }),
    );
    unlisteners.push(
      await curWin.listen<WorldStateSnapshot>('world-state', (ev) => {
        if (!ev.payload) return;
        snapshot.value = ev.payload;
        if (Array.isArray(ev.payload.monitors) && ev.payload.monitors.length > 0) {
          monitors.value = ev.payload.monitors;
        }
        const imgs = ev.payload.elements.filter(
          (e): e is SerializedImageElement => e.kind === 'image',
        );
        void ensureImageBlobsLoaded(imgs);
      }),
    );
    unlisteners.push(
      await curWin.listen<WorldGeometryDelta>('world-geometry-delta', (ev) => {
        if (!ev.payload || !snapshot.value) return;
        const map = ev.payload.cornersById;
        snapshot.value = {
          ...snapshot.value,
          rev: ev.payload.rev,
          elements: snapshot.value.elements.map((el) =>
            map[el.id] ? { ...el, corners: map[el.id] } : el,
          ),
        };
      }),
    );
    unlisteners.push(
      await curWin.listen<GridFrameMeta>('grid-frame-ready', (ev) => {
        if (ev.payload) void fetchRemoteFrame(ev.payload);
      }),
    );
    unlisteners.push(
      await curWin.listen<[number, number]>('overlay-cursor-pos', (ev) => {
        if (Array.isArray(ev.payload)) {
          evaluateHoverAt(ev.payload[0], ev.payload[1]);
        }
      }),
    );
    unlisteners.push(
      await curWin.listen<Record<string, string>>('app-theme-sync', (ev) => {
        if (ev.payload) {
          const rootStyle = document.documentElement.style;
          for (const [k, v] of Object.entries(ev.payload)) {
            rootStyle.setProperty(k, v);
          }
        }
      }),
    );

    const existingMetas = await getAllGridFrameMetas();
    for (const meta of existingMetas) {
      void fetchRemoteFrame(meta);
    }

    sendCmd({ type: 'request-snapshot', fromLabel: winLabel });
  } catch {
    // ignore
  }

  await syncHitRegions();
  await notifyOsViewportReady();
});

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onGlobalPointerDownDeselect, true);
  window.removeEventListener('contextmenu', onWindowContextMenu);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  for (const un of unlisteners) un();
  for (const src of imageSrcMap.value.values()) {
    if (src.startsWith('blob:')) URL.revokeObjectURL(src);
  }
});
</script>

<template>
  <main class="ac-root">
    <template v-for="el in visibleIntersectingElements" :key="el.id">
      <PerspectiveOverlay
        v-if="el.kind === 'grid'"
        :element="el"
        :bridge="sharedBridges.get(el.id) ?? null"
        :remote-frame="sharedBridges.has(el.id) ? null : (remoteFrames.get(el.id) ?? null)"
        :remote-bounds="snapshot?.gridBoundsById[el.id] ?? null"
        :has-dom-backdrop="false"
        :viewport-transform="viewportTransform"
        :world-bounded-to-viewport="false"
        :selected="isElementVisuallySelected(el.id)"
        :multi-selected="(snapshot?.selectedTargetIds.length ?? 0) >= 2 && isElementVisuallySelected(el.id)"
        :grouped="fullCanvasEnabled && !!getParentGroup(el.id, groups)"
        :crop-draft="snapshot?.cropDraft?.elementId === el.id ? snapshot.cropDraft : null"
        :space-panning="false"
        @select="(id, additive) => sendCmd({ type: 'select', id, additive })"
        @focus-multi-member="(id) => sendCmd({ type: 'focus-multi-member', id })"
        @draw-interact="(id) => sendCmd({ type: 'draw-interact', gridId: id })"
        @remote-pointer="handleRemotePointer"
        @move-start="(id) => sendCmd({ type: 'move-start', leafId: id })"
        @translate-by="(id, dx, dy) => sendCmd({ type: 'translate-by', leafId: id, dxWorld: dx, dyWorld: dy })"
        @move-end="sendCmd({ type: 'move-end' })"
        @update-corners="(id, corners) => sendCmd({ type: 'update-target', id, patch: { corners } })"
        @update-crop-draft="(draft) => sendCmd({ type: 'update-crop-draft', draft })"
        @toggle-crop="(id) => sendCmd({ type: 'start-crop', id })"
        @quad-geometry-change="(q) => setGridOuterQuad(el.id, q)"
      />
      <MediaElementView
        v-else-if="(el.kind === 'image' && el.src) || (el.kind === 'screen' && sharedScreenStreams.has(el.streamId))"
        :element="el"
        :stream="el.kind === 'screen' ? (sharedScreenStreams.get(el.streamId) ?? null) : null"
        :viewport-transform="viewportTransform"
        :world-bounded-to-viewport="false"
        :selected="isElementVisuallySelected(el.id)"
        :multi-selected="(snapshot?.selectedTargetIds.length ?? 0) >= 2 && isElementVisuallySelected(el.id)"
        :grouped="fullCanvasEnabled && !!getParentGroup(el.id, groups)"
        :crop-draft="snapshot?.cropDraft?.elementId === el.id ? snapshot.cropDraft : null"
        :space-panning="false"
        @select="(id, additive) => sendCmd({ type: 'select', id, additive })"
        @focus-multi-member="(id) => sendCmd({ type: 'focus-multi-member', id })"
        @move-start="(id) => sendCmd({ type: 'move-start', leafId: id })"
        @translate-by="(id, dx, dy) => sendCmd({ type: 'translate-by', leafId: id, dxWorld: dx, dyWorld: dy })"
        @move-end="sendCmd({ type: 'move-end' })"
        @update-corners="(id, corners) => sendCmd({ type: 'update-target', id, patch: { corners } })"
        @update-crop-draft="(draft) => sendCmd({ type: 'update-crop-draft', draft })"
        @update-natural-size="(id, w, h) => sendCmd({ type: 'update-natural-size', id, w, h })"
        @toggle-crop="(id) => sendCmd({ type: 'start-crop', id })"
      />
    </template>

    <TransformGizmo
      :selected-targets="selectedTargets"
      :show-selection-toolbar="showSelectionToolbarOnThisViewport"
      :crop-draft="snapshot?.cropDraft ?? null"
      :hovered-target="hoveredTarget"
      :linked-highlight-quad="linkedHighlightGridQuad"
      :viewport-transform="viewportTransform"
      :world-bounded-to-viewport="false"
      :show-layer-order-actions="fullCanvasEnabled"
      :allow-delete="fullCanvasEnabled"
      :button-display-mode="buttonDisplayMode"
      :grid-bounds="
        singleSelectedTarget?.kind === 'grid'
          ? snapshot?.gridBoundsById[singleSelectedTarget.id]
          : undefined
      "
      @resize-start="(id) => sendCmd({ type: 'resize-start', id })"
      @resize-end="sendCmd({ type: 'resize-end' })"
      @update-element="(id, patch) => sendCmd({ type: 'update-target', id, patch })"
      @update-quad-mode="(id, mode) => sendCmd({ type: 'update-quad-mode', id, mode })"
      @reset-size="(id) => sendCmd({ type: 'reset-size', id })"
      @start-crop="(id) => sendCmd({ type: 'start-crop', id })"
      @update-crop-draft="(draft) => sendCmd({ type: 'update-crop-draft', draft })"
      @commit-crop="sendCmd({ type: 'commit-crop' })"
      @cancel-crop="sendCmd({ type: 'cancel-crop' })"
      @group-selected="sendCmd({ type: 'group-selected' })"
      @ungroup-target="(id) => sendCmd({ type: 'ungroup-target', id })"
      @toggle-visible="(ids) => sendCmd({ type: 'toggle-visible', ids, source: 'toolbar' })"
      @toggle-passthrough="(id) => sendCmd({ type: 'toggle-passthrough', id })"
      @toggle-dock="(ids) => sendCmd({ type: 'toggle-dock', ids })"
      @bring-front="(ids) => sendCmd({ type: 'bring-front', ids })"
      @send-back="(ids) => sendCmd({ type: 'send-back', ids })"
      @remove-element="(ids) => sendCmd({ type: 'remove-targets', ids })"
      @lock-element="(ids) => sendCmd({ type: 'lock-targets', ids })"
      @unlock-element="(id) => sendCmd({ type: 'unlock-target', id })"
      @toolbar-bounds-change="(r) => (toolbarRect = r)"
      @hover-toolbar-bounds-change="(r) => (hoverToolbarRect = r)"
    />

    <!-- Active-cursor-monitor Main Control Bar -->
    <ControlBar
      v-if="showControlBarOnThisViewport && snapshot"
      :layers-visible="snapshot.layersVisible"
      :always-on-top="snapshot.alwaysOnTop"
      :backdrop-mode="snapshot.backdropMode"
      platform="tauri"
      :can-switch-overlay="snapshot.canSwitchOverlay"
      :can-screen-capture="snapshot.canScreenCapture"
      :can-pin-window="true"
      :full-canvas-enabled="fullCanvasEnabled"
      :elements="activeLayerTargets"
      :selected-ids="snapshot.selectedTargetIds"
      :button-display-mode="buttonDisplayMode"
      :global-scale="snapshot.globalScale"
      :show-unavailable-options="snapshot.showUnavailableOptions"
      :initial-bar-override="getInitialBarOverride()"
      :delegate-persistence="true"
      @update:layers-visible="(v) => sendCmd({ type: 'set-layers-visible', visible: v })"
      @update:always-on-top="(v) => sendCmd({ type: 'set-always-on-top', pinned: v })"
      @update:backdrop-mode="(m) => sendCmd({ type: 'set-backdrop-mode', mode: m })"
      @unavailable-click="(k) => sendCmd({ type: 'dock-unavailable', key: k })"
      @add-grid="sendCmd({ type: 'add-grid' })"
      @add-image="sendCmd({ type: 'add-image' })"
      @add-screen="sendCmd({ type: 'add-screen' })"
      @select-element="(id, additive) => sendCmd({ type: 'select', id, additive })"
      @toggle-visible="(id) => sendCmd({ type: 'toggle-visible', ids: [id], source: 'layers' })"
      @toggle-lock="(id) => { const t = activeLayerTargets.find((x) => x.id === id); if (t?.locked) sendCmd({ type: 'unlock-target', id }); else sendCmd({ type: 'lock-targets', ids: [id] }); }"
      @toggle-passthrough="(id) => sendCmd({ type: 'toggle-passthrough', id })"
      @toggle-dock="(id) => sendCmd({ type: 'toggle-dock', ids: [id] })"
      @move-up="(id) => sendCmd({ type: 'move-layer-order', id, dir: 'up' })"
      @move-down="(id) => sendCmd({ type: 'move-layer-order', id, dir: 'down' })"
      @remove-element="(id) => sendCmd({ type: 'remove-targets', ids: [id] })"
      @rename-element="(id, label) => sendCmd({ type: 'rename-target', id, label })"
      @open-settings="sendCmd({ type: 'open-settings', monitorId: myMonitor?.id })"
      @close-overlay="sendCmd({ type: 'close-overlay' })"
      @bar-state-change="handleSecondaryBarStateChange"
      @bounds-change="(r) => (barRect = r)"
    />

    <!-- Settings Modal (opens directly on this monitor when triggered from this monitor!) -->
    <SettingsDialog
      v-if="snapshot"
      :open="settingsOpenOnThisViewport"
      :custom-css-enabled="snapshot.customCssEnabled"
      :custom-css="snapshot.customCss"
      :button-display-mode="snapshot.buttonDisplayMode"
      :global-scale="snapshot.globalScale"
      :penpa-scale="snapshot.penpaScale"
      :penpa-blur-opacity="snapshot.penpaBlurOpacity"
      :overlay-full-canvas="snapshot.fullCanvasEnabled"
      :multi-monitor-enabled="snapshot.multiMonitorEnabled"
      :show-unavailable-options="snapshot.showUnavailableOptions"
      platform="tauri"
      :highlight-key="snapshot.highlightSettingKey"
      :highlight-tick="snapshot.highlightSettingTick"
      @update:open="(v) => { if (!v) sendCmd({ type: 'close-settings' }); }"
      @update:custom-css-enabled="(v) => sendCmd({ type: 'update-settings', patch: { customCssEnabled: v } })"
      @update:custom-css="(v) => sendCmd({ type: 'update-settings', patch: { customCss: v } })"
      @update:button-display-mode="(v) => sendCmd({ type: 'update-settings', patch: { buttonDisplayMode: v } })"
      @update:global-scale="(v) => sendCmd({ type: 'update-settings', patch: { globalScale: v } })"
      @update:penpa-scale="(v) => sendCmd({ type: 'update-settings', patch: { penpaScale: v } })"
      @update:penpa-blur-opacity="(v) => sendCmd({ type: 'update-settings', patch: { penpaBlurOpacity: v } })"
      @update:overlay-full-canvas="(v) => sendCmd({ type: 'update-settings', patch: { overlayFullCanvas: v } })"
      @update:multi-monitor-enabled="(v) => sendCmd({ type: 'update-settings', patch: { multiMonitorEnabled: v } })"
      @update:show-unavailable-options="(v) => sendCmd({ type: 'update-settings', patch: { showUnavailableOptions: v } })"
      @unavailable-click="(k) => sendCmd({ type: 'dock-unavailable', key: k })"
    />

    <!-- Unavailable Option Explanation Dialog -->
    <div
      v-if="unavailableDialogInfoOnThisViewport"
      class="ac-prompt-backdrop ac-unavailable-backdrop"
      @pointerdown.self="sendCmd({ type: 'close-unavailable' })"
    >
      <section
        class="ac-prompt-card"
        role="dialog"
        aria-modal="true"
        :aria-label="messages.unavailable.ariaLabel"
      >
        <div class="ac-prompt-title">{{ unavailableDialogInfoOnThisViewport.title }}</div>
        <p class="ac-prompt-body">{{ unavailableDialogInfoOnThisViewport.body }}</p>
        <div class="ac-prompt-actions">
          <button class="ac-btn active" @click="sendCmd({ type: 'close-unavailable' })">
            {{ messages.unavailable.ok }}
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

.ac-prompt-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
