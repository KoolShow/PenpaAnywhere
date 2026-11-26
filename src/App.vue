<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ControlBar, {
  type BackdropMode,
  type UnavailableReasonKey,
} from './components/ControlBar.vue';
import PerspectiveOverlay, { type AlignTarget, type QuadMode } from './components/PerspectiveOverlay.vue';
import PenpaDockWindow from './components/PenpaDockWindow.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import { isConvexQuad, type Point2D } from './core/homography';
import type { BlendRenderMode } from './core/webglOverlay';
import type { PenpaIframeBridge } from './core/penpaBridge';
import { DEFAULT_PENPA_MD3_CSS } from './core/defaultPenpaCss';
import {
  DEFAULT_TOGGLE_HOTKEY,
  formatHotkeyLabel,
  matchesHotkey,
  type HotkeyBinding,
} from './core/hotkey';
import { getCurrentMd3Tokens } from './core/theme';
import { safeAreaInsets } from './core/safeArea';
import { getPenpaLangCode, messages, type AppLocale } from './core/i18n';
import {
  closeOverlayApp,
  detectPlatform,
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

// Default mode: transparent overlay on Tauri/Android-overlay; image upload on pure web / android app
const backdropMode = ref<BackdropMode>(canNativeOverlay ? 'overlay' : 'image');

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

const blendMode = ref<BlendRenderMode>(resolveInitialBlendMode());
const calibrating = ref(savedState.calibrating ?? true);
const alignTarget = ref<AlignTarget>(savedState.alignTarget ?? 'grid');
const quadMode = ref<QuadMode>(savedState.quadMode ?? 'rect');
const opacity = ref(
  typeof savedState.opacity === 'number' && savedState.opacity >= 0.1 && savedState.opacity <= 1
    ? savedState.opacity
    : 1.0,
);
const dockVisible = ref(savedState.dockVisible ?? true);
const canvasVisible = ref(savedState.canvasVisible ?? true);
const showUnavailableOptions = ref(savedState.showUnavailableOptions ?? false);
const clickThrough = ref(false);
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
const hotkeyLabel = computed(() =>
  formatHotkeyLabel(toggleHotkey.value, messages.value.settings.hotkeyUnbound),
);

const overlayRef = ref<InstanceType<typeof PerspectiveOverlay> | null>(null);
const bridge = ref<PenpaIframeBridge | null>(null);
const fileInputEl = ref<HTMLInputElement | null>(null);
const screenVideoEl = ref<HTMLVideoElement | null>(null);

const imageUrl = ref<string | null>(null);
const screenStream = ref<MediaStream | null>(null);
const screenError = ref<string | null>(null);

// Default centered/right-shifted square quad inside safe area so it doesn't collide with system bars or Penpa dock
function makeDefaultCorners(): [Point2D, Point2D, Point2D, Point2D] {
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
    { x: cx - half, y: cy - half },
    { x: cx + half, y: cy - half },
    { x: cx + half, y: cy + half },
    { x: cx - half, y: cy + half },
  ];
}

function loadInitialCorners(): [Point2D, Point2D, Point2D, Point2D] {
  const norm = savedState.cornersNorm;
  if (Array.isArray(norm) && norm.length === 4) {
    const valid = norm.every(
      (p) => p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y),
    );
    if (valid) {
      const safe = safeAreaInsets.value;
      const w = window.innerWidth || 1280;
      const h = window.innerHeight || 800;
      const minX = safe.left + 8;
      const maxX = Math.max(minX + 48, w - safe.right - 8);
      const minY = safe.top + 8;
      const maxY = Math.max(minY + 48, h - safe.bottom - 8);
      const pts: [Point2D, Point2D, Point2D, Point2D] = [
        { x: Math.max(minX, Math.min(maxX, norm[0].x * w)), y: Math.max(minY, Math.min(maxY, norm[0].y * h)) },
        { x: Math.max(minX, Math.min(maxX, norm[1].x * w)), y: Math.max(minY, Math.min(maxY, norm[1].y * h)) },
        { x: Math.max(minX, Math.min(maxX, norm[2].x * w)), y: Math.max(minY, Math.min(maxY, norm[2].y * h)) },
        { x: Math.max(minX, Math.min(maxX, norm[3].x * w)), y: Math.max(minY, Math.min(maxY, norm[3].y * h)) },
      ];
      if (isConvexQuad(pts)) {
        return pts;
      }
    }
  }
  return makeDefaultCorners();
}

const corners = ref<[Point2D, Point2D, Point2D, Point2D]>(loadInitialCorners());
const outerQuad = ref<[Point2D, Point2D, Point2D, Point2D]>(corners.value);
const barRect = ref({ x: 0, y: 0, w: 0, h: 0 });
const dockRect = ref({ x: 0, y: 0, w: 0, h: 0 });
let lastViewport = { w: window.innerWidth || 1280, h: window.innerHeight || 800 };

function rescaleCornersOnResize() {
  const nw = window.innerWidth;
  const nh = window.innerHeight;
  if (nw < 120 || nh < 120) return;
  const ow = lastViewport.w;
  const oh = lastViewport.h;
  if (nw === ow && nh === oh) return;
  lastViewport = { w: nw, h: nh };

  const sx = nw / Math.max(1, ow);
  const sy = nh / Math.max(1, oh);
  const safe = safeAreaInsets.value;
  const minX = safe.left + 8;
  const minY = safe.top + 8;
  const maxX = Math.max(minX + 48, nw - safe.right - 8);
  const maxY = Math.max(minY + 48, nh - safe.bottom - 8);

  const cur = corners.value;
  if (quadMode.value === 'rect') {
    let left = Math.max(minX, Math.min(maxX - 48, Math.min(cur[0].x, cur[3].x) * sx));
    let right = Math.max(left + 48, Math.min(maxX, Math.max(cur[1].x, cur[2].x) * sx));
    let top = Math.max(minY, Math.min(maxY - 48, Math.min(cur[0].y, cur[1].y) * sy));
    let bottom = Math.max(top + 48, Math.min(maxY, Math.max(cur[2].y, cur[3].y) * sy));
    if (right - left < 48) left = Math.max(minX, right - 48);
    if (bottom - top < 48) top = Math.max(minY, bottom - 48);
    corners.value = [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ];
    return;
  }

  const scaled: [Point2D, Point2D, Point2D, Point2D] = [
    { x: Math.max(minX, Math.min(maxX, cur[0].x * sx)), y: Math.max(minY, Math.min(maxY, cur[0].y * sy)) },
    { x: Math.max(minX, Math.min(maxX, cur[1].x * sx)), y: Math.max(minY, Math.min(maxY, cur[1].y * sy)) },
    { x: Math.max(minX, Math.min(maxX, cur[2].x * sx)), y: Math.max(minY, Math.min(maxY, cur[2].y * sy)) },
    { x: Math.max(minX, Math.min(maxX, cur[3].x * sx)), y: Math.max(minY, Math.min(maxY, cur[3].y * sy)) },
  ];
  corners.value = isConvexQuad(scaled) ? scaled : makeDefaultCorners();
}

watch(
  [
    blendMode,
    alignTarget,
    quadMode,
    opacity,
    calibrating,
    dockVisible,
    canvasVisible,
    showUnavailableOptions,
    corners,
    customCssEnabled,
    customCss,
    toggleHotkey,
  ],
  () => {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    const cornersNorm: [Point2D, Point2D, Point2D, Point2D] = [
      { x: corners.value[0].x / w, y: corners.value[0].y / h },
      { x: corners.value[1].x / w, y: corners.value[1].y / h },
      { x: corners.value[2].x / w, y: corners.value[2].y / h },
      { x: corners.value[3].x / w, y: corners.value[3].y / h },
    ];
    patchPersistedState({
      blendMode: blendMode.value,
      alignTarget: alignTarget.value,
      quadMode: quadMode.value,
      opacity: opacity.value,
      calibrating: calibrating.value,
      dockVisible: dockVisible.value,
      canvasVisible: canvasVisible.value,
      showUnavailableOptions: showUnavailableOptions.value,
      cornersNorm,
      customCssEnabled: customCssEnabled.value,
      customCss: customCss.value,
      toggleHotkey: toggleHotkey.value,
    });
  },
  { deep: true },
);

function syncPenpaThemeAndCss() {
  const b = bridge.value;
  if (!b) return;
  b.setMd3Tokens?.(getCurrentMd3Tokens());
  b.setCustomCss?.(customCssEnabled.value ? customCss.value : '');
}

watch([bridge, customCssEnabled, customCss], () => {
  syncPenpaThemeAndCss();
});

async function syncNativeToggleHotkey() {
  if (platform !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const active = hotkeyRecording.value ? null : toggleHotkey.value;
    await invoke('set_toggle_hotkey', {
      hotkey: active
        ? {
            ctrl: active.ctrl,
            shift: active.shift,
            alt: active.alt,
            meta: active.meta,
            code: active.code,
          }
        : null,
    });
  } catch {
    // non-fatal
  }
}

watch([toggleHotkey, hotkeyRecording], () => {
  syncNativeToggleHotkey();
});

function flushAllStateNow() {
  flushPersistedStateNow();
  bridge.value?.saveDraftNow?.();
}

async function handleCloseOverlay() {
  flushAllStateNow();
  await closeOverlayApp();
}

const hasDomBackdrop = computed(() => {
  if (backdropMode.value === 'image') return true;
  if (backdropMode.value === 'screen') return true;
  return false;
});

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
  }
});

function handleUnavailableClick(key: UnavailableReasonKey) {
  unavailableReasonKey.value = key;
}

function handleBackdropModeUpdate(next: BackdropMode) {
  if (next === backdropMode.value) return;
  if (platform === 'android-overlay' && next === 'image') {
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
    if (blendMode.value === 'multiply') {
      blendMode.value = 'alpha-minrgb';
    } else if (blendMode.value === 'multiply-inv') {
      blendMode.value = 'alpha-minrgb-inv';
    }
    await setOsFullscreenOverlay(true);
  } else {
    clickThrough.value = false;
    await setOsClickThrough(false);
    await setOsFullscreenOverlay(false);
  }
  if (mode !== 'screen') {
    stopScreenCapture();
  }
});

watch(clickThrough, async (val) => {
  await setOsClickThrough(val);
});

// Sync interactive regions to Windows (Tauri 2) and Android (OverlayService TouchProxy windows)
// so all transparent areas outside control bar, Penpa dock, and board quad pass touches through!
async function syncOverlayHitRegions() {
  const modalBlocking = settingsOpen.value || screenshotPromptOpen.value || !!unavailableReasonKey.value;
  if (platform === 'tauri') {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const dock =
        dockVisible.value && dockRect.value.w > 0 && dockRect.value.h > 0
          ? dockRect.value
          : { x: 0, y: 0, w: 0, h: 0 };
      await invoke('update_hit_regions', {
        enabled: backdropMode.value === 'overlay' && !modalBlocking,
        forceClickThrough: backdropMode.value === 'overlay' && clickThrough.value && !modalBlocking,
        barRect: barRect.value,
        dockRect: dock,
        quad: canvasVisible.value ? outerQuad.value : [],
      });
    } catch {
      // Non-fatal in web/dev fallback
    }
    return;
  }

  if (platform === 'android-overlay' && window.AndroidOverlay?.updateHitRegions) {
    let boardRect = { x: 0, y: 0, w: 0, h: 0 };
    let androidHandlePts: Point2D[] = [];
    if (canvasVisible.value) {
      // Compute padded bounding box covering both corners (handles) and outerQuad
      const allPts = [...corners.value, ...outerQuad.value];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of allPts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      const pad = calibrating.value ? 26 : 10;
      if (isFinite(minX) && maxX > minX && maxY > minY) {
        boardRect = {
          x: Math.max(0, minX - pad),
          y: Math.max(0, minY - pad),
          w: maxX - minX + pad * 2,
          h: maxY - minY + pad * 2,
        };
      }
      const c = corners.value;
      androidHandlePts = [
        ...c,
        { x: (c[0].x + c[1].x) * 0.5, y: (c[0].y + c[1].y) * 0.5 },
        { x: (c[1].x + c[2].x) * 0.5, y: (c[1].y + c[2].y) * 0.5 },
        { x: (c[2].x + c[3].x) * 0.5, y: (c[2].y + c[3].y) * 0.5 },
        { x: (c[3].x + c[0].x) * 0.5, y: (c[3].y + c[0].y) * 0.5 },
      ];
    }

    const payload = {
      passthroughEnabled: backdropMode.value === 'overlay' && !modalBlocking,
      forceClickThrough: backdropMode.value === 'overlay' && clickThrough.value && !modalBlocking,
      calibrating: calibrating.value && canvasVisible.value,
      viewportW: window.innerWidth || 1,
      viewportH: window.innerHeight || 1,
      barRect: barRect.value,
      dockRect: dockVisible.value ? dockRect.value : { x: 0, y: 0, w: 0, h: 0 },
      boardRect,
      quad: canvasVisible.value ? outerQuad.value : [],
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
  if (open) {
    refreshAndroidScreenshotStatus();
  }
});

watch(
  [
    backdropMode,
    clickThrough,
    settingsOpen,
    screenshotPromptOpen,
    unavailableReasonKey,
    calibrating,
    dockVisible,
    canvasVisible,
    barRect,
    dockRect,
    corners,
    outerQuad,
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
  } catch {
    // ignore parse errors
  }
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

function handleSyncPenpaLanguage(locale: AppLocale) {
  bridge.value?.setLanguage?.(getPenpaLangCode(locale));
}

function handleQuadModeChange(next: QuadMode) {
  if (next === quadMode.value) return;
  quadMode.value = next;
  corners.value = makeDefaultCorners();
}

function triggerImagePicker() {
  if (window.AndroidOverlay?.pickImage) {
    window.AndroidOverlay.pickImage();
    return;
  }
  fileInputEl.value?.click();
}

function loadImageBlob(file: File | Blob) {
  if (imageUrl.value && imageUrl.value.startsWith('blob:')) {
    URL.revokeObjectURL(imageUrl.value);
  }
  imageUrl.value = URL.createObjectURL(file);
  backdropMode.value = 'image';
}

function onFileSelected(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    loadImageBlob(file);
  }
  input.value = '';
}

function onDrop(e: DragEvent) {
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type.startsWith('image/')) {
    e.preventDefault();
    loadImageBlob(file);
  }
}

function onDragOver(e: DragEvent) {
  if (e.dataTransfer?.types.includes('Files')) {
    e.preventDefault();
  }
}

function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      if (blob) {
        loadImageBlob(blob);
        break;
      }
    }
  }
}

async function startScreenCapture() {
  screenError.value = null;
  if (!canScreenCapture) {
    screenError.value = messages.value.stage.screenUnsupported;
    return;
  }
  try {
    stopScreenCapture();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
      } as MediaTrackConstraints,
      audio: false,
    });
    screenStream.value = stream;
    backdropMode.value = 'screen';
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      stopScreenCapture();
    });
    requestAnimationFrame(() => {
      if (screenVideoEl.value) {
        screenVideoEl.value.srcObject = stream;
        screenVideoEl.value.play().catch(() => {});
      }
    });
  } catch (err) {
    screenError.value = err instanceof Error ? err.message : messages.value.stage.screenCancelled;
  }
}

function stopScreenCapture() {
  if (screenStream.value) {
    screenStream.value.getTracks().forEach((t) => t.stop());
    screenStream.value = null;
  }
  if (screenVideoEl.value) {
    screenVideoEl.value.srcObject = null;
  }
}

// Forward keyboard shortcuts (digits, arrow keys, Ctrl+Z, Space, Delete...) to Penpa iframe
function onWindowKey(type: 'keydown' | 'keyup', e: KeyboardEvent) {
  if (hotkeyRecording.value) return;

  if (type === 'keydown' && matchesHotkey(e, toggleHotkey.value)) {
    if (canNativeOverlay && backdropMode.value === 'overlay') {
      e.preventDefault();
      // On Tauri, the Rust global poller is the single source of truth so we don't double-toggle
      if (platform !== 'tauri') {
        clickThrough.value = !clickThrough.value;
      }
      return;
    }
  }

  if (type === 'keydown' && e.code === 'Escape' && unavailableReasonKey.value) {
    e.preventDefault();
    unavailableReasonKey.value = null;
    return;
  }

  if (settingsOpen.value || unavailableReasonKey.value) return;

  const activeTag = (document.activeElement?.tagName || '').toLowerCase();
  if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') return;
  if (!bridge.value || !bridge.value.isReady()) return;

  bridge.value.dispatchKey(type, {
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

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    flushAllStateNow();
  }
}

onMounted(async () => {
  window.addEventListener('paste', onPaste);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('resize', rescaleCornersOnResize);
  window.addEventListener('pagehide', flushAllStateNow);
  window.addEventListener('beforeunload', flushAllStateNow);
  window.addEventListener('penpaanywhere-md3-updated', syncPenpaThemeAndCss);
  document.addEventListener('visibilitychange', onVisibilityChange);

  window.__PENPAANYWHERE_ON_ANDROID_IMAGE__ = (dataUrl: string) => {
    imageUrl.value = dataUrl;
    backdropMode.value = 'image';
  };
  window.__PENPAANYWHERE_ON_CLICK_THROUGH__ = (enabled: boolean) => {
    clickThrough.value = enabled;
  };
  window.__PENPAANYWHERE_FLUSH_STORAGE__ = flushAllStateNow;
  window.__PENPAANYWHERE_CAPTURE_OVERLAY__ = () => ({
    active: backdropMode.value === 'overlay' && canvasVisible.value,
    dataUrl: canvasVisible.value ? (overlayRef.value?.captureOverlayPng() ?? '') : '',
  });
  window.__PENPAANYWHERE_ON_SCREENSHOT_PROMPT__ = (fileName: string) => {
    screenshotPromptFile.value = fileName || '';
    screenshotPromptOpen.value = true;
  };
  window.__PENPAANYWHERE_ON_SCREENSHOT_STATUS__ = (status: AndroidScreenshotCompositeStatus) => {
    androidScreenshotStatus.value = status;
  };

  // Listen to Tauri global shortcut event even when window is click-through
  if (platform === 'tauri') {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      await listen<boolean>('click-through-toggled', (ev) => {
        clickThrough.value = ev.payload;
      });
    } catch {
      // ignore if listener unavailable
    }
    syncNativeToggleHotkey();
    syncOverlayHitRegions();
  }
  if (platform === 'android-overlay') {
    refreshAndroidScreenshotStatus();
    requestAnimationFrame(() => syncOverlayHitRegions());
  }
});

onBeforeUnmount(() => {
  flushAllStateNow();
  window.removeEventListener('paste', onPaste);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('resize', rescaleCornersOnResize);
  window.removeEventListener('pagehide', flushAllStateNow);
  window.removeEventListener('beforeunload', flushAllStateNow);
  window.removeEventListener('penpaanywhere-md3-updated', syncPenpaThemeAndCss);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  stopScreenCapture();
  if (imageUrl.value && imageUrl.value.startsWith('blob:')) {
    URL.revokeObjectURL(imageUrl.value);
  }
});
</script>

<template>
  <main
    class="ac-root"
    :class="{ 'has-backdrop': hasDomBackdrop }"
    @drop="onDrop"
    @dragover="onDragOver"
  >
    <!-- Hidden file picker (available in all modes) -->
    <input
      ref="fileInputEl"
      type="file"
      accept="image/*"
      style="display: none"
      @change="onFileSelected"
    />

    <!-- Backdrop stage (Image Upload or Web Screen Capture) -->
    <div v-if="hasDomBackdrop" class="ac-backdrop-stage">
      <img
        v-if="backdropMode === 'image' && imageUrl"
        :src="imageUrl"
        class="ac-backdrop-media"
        :alt="messages.stage.imageAlt"
      />
      <video
        v-else-if="backdropMode === 'screen'"
        v-show="!!screenStream"
        ref="screenVideoEl"
        class="ac-backdrop-media"
        autoplay
        muted
        playsinline
      />
    </div>

    <!-- Floating guidance card when no screenshot / stream is loaded yet -->
    <div v-if="backdropMode === 'image' && !imageUrl" class="ac-backdrop-placeholder">
      <div style="font-size: 13px; font-weight: 600; color: var(--md-sys-color-on-surface)">
        {{ messages.stage.imageTitle }}
      </div>
      <div style="font-size: 11px">
        {{ messages.stage.imageDesc }}
      </div>
      <button class="ac-btn active" @click="triggerImagePicker">
        {{ messages.stage.chooseImage }}
      </button>
    </div>

    <div v-if="backdropMode === 'screen' && !screenStream" class="ac-backdrop-placeholder">
      <div style="font-size: 13px; font-weight: 600; color: var(--md-sys-color-on-surface)">
        {{ messages.stage.screenTitle }}
      </div>
      <div style="font-size: 11px">
        {{ messages.stage.screenDesc }}
      </div>
      <div v-if="screenError" style="font-size: 11px; color: var(--md-sys-color-error)">
        {{ screenError }}
      </div>
      <button class="ac-btn active" @click="startScreenCapture">
        {{ messages.stage.startScreen }}
      </button>
    </div>

    <!-- WebGL2 4-point Perspective Overlay Canvas (Multiply / Alpha=1-Luma / Color-to-Alpha) -->
    <PerspectiveOverlay
      v-show="canvasVisible"
      ref="overlayRef"
      v-model:corners="corners"
      :visible="canvasVisible"
      :bridge="bridge"
      :blend-mode="blendMode"
      :has-dom-backdrop="hasDomBackdrop"
      :opacity="opacity"
      :calibrating="calibrating"
      :align-target="alignTarget"
      :quad-mode="quadMode"
      @quad-geometry-change="(q) => (outerQuad = q)"
    />

    <!-- Independent Floating Window with 100% Original Penpa+ UI & Controls -->
    <PenpaDockWindow
      v-model:visible="dockVisible"
      @bridge-ready="(b) => (bridge = b)"
      @bounds-change="(r) => (dockRect = r)"
    />

    <!-- Top MD3 Floating Control Bar -->
    <ControlBar
      v-model:blend-mode="blendMode"
      v-model:calibrating="calibrating"
      v-model:align-target="alignTarget"
      v-model:opacity="opacity"
      v-model:dock-visible="dockVisible"
      v-model:canvas-visible="canvasVisible"
      v-model:click-through="clickThrough"
      :backdrop-mode="backdropMode"
      :quad-mode="quadMode"
      :platform="platform"
      :can-native-overlay="canNativeOverlay"
      :can-switch-overlay="canSwitchOverlay"
      :can-screen-capture="canScreenCapture"
      :show-unavailable-options="showUnavailableOptions"
      :hotkey-label="hotkeyLabel"
      :has-screen-stream="!!screenStream"
      :has-image="!!imageUrl"
      @update:backdrop-mode="handleBackdropModeUpdate"
      @update:quad-mode="handleQuadModeChange"
      @unavailable-click="handleUnavailableClick"
      @pick-image="triggerImagePicker"
      @start-screen-capture="startScreenCapture"
      @stop-screen-capture="stopScreenCapture"
      @open-settings="settingsOpen = true"
      @close-overlay="handleCloseOverlay"
      @bounds-change="(r) => (barRect = r)"
    />

    <!-- Settings Modal (Language + Theme + Dynamic Color + Show Unavailable + Hotkey + Custom CSS + Links) -->
    <SettingsDialog
      v-model:open="settingsOpen"
      v-model:custom-css-enabled="customCssEnabled"
      v-model:custom-css="customCss"
      v-model:toggle-hotkey="toggleHotkey"
      v-model:show-unavailable-options="showUnavailableOptions"
      :platform="platform"
      :android-screenshot-status="androidScreenshotStatus"
      @unavailable-click="handleUnavailableClick"
      @toggle-android-screenshot-composite="handleToggleAndroidScreenshotComposite"
      @request-android-all-files="handleRequestAndroidAllFiles"
      @recording-change="(r) => (hotkeyRecording = r)"
      @sync-penpa-language="handleSyncPenpaLanguage"
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
  z-index: 95;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(16px + var(--ac-safe-top, 0px)) calc(16px + var(--ac-safe-right, 0px))
    calc(16px + var(--ac-safe-bottom, 0px)) calc(16px + var(--ac-safe-left, 0px));
  background: color-mix(in srgb, var(--md-sys-color-scrim) 52%, transparent);
  pointer-events: auto;
}

.ac-unavailable-backdrop {
  z-index: 105;
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
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
