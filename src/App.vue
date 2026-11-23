<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ControlBar, { type BackdropMode } from './components/ControlBar.vue';
import PerspectiveOverlay, { type AlignTarget } from './components/PerspectiveOverlay.vue';
import PenpaDockWindow from './components/PenpaDockWindow.vue';
import type { Point2D } from './core/homography';
import type { BlendRenderMode } from './core/webglOverlay';
import type { PenpaIframeBridge } from './core/penpaBridge';
import {
  closeOverlayApp,
  detectPlatform,
  setOsClickThrough,
  setOsFullscreenOverlay,
  supportsNativeTransparentOverlay,
  supportsScreenCapture,
} from './core/platform';

const platform = detectPlatform();
const canNativeOverlay = supportsNativeTransparentOverlay(platform);
const canScreenCapture = supportsScreenCapture();

// Default mode: transparent overlay on Tauri/Android-overlay; image upload on pure web / android app
const backdropMode = ref<BackdropMode>(canNativeOverlay ? 'overlay' : 'image');
const blendMode = ref<BlendRenderMode>(canNativeOverlay ? 'alpha-luma' : 'multiply');
const calibrating = ref(true);
const alignTarget = ref<AlignTarget>('grid');
const opacity = ref(1.0);
const dockVisible = ref(true);
const clickThrough = ref(false);

const bridge = ref<PenpaIframeBridge | null>(null);
const fileInputEl = ref<HTMLInputElement | null>(null);
const screenVideoEl = ref<HTMLVideoElement | null>(null);

const imageUrl = ref<string | null>(null);
const screenStream = ref<MediaStream | null>(null);
const screenError = ref<string | null>(null);

// Default centered/right-shifted square quad so it doesn't collide with the Penpa tool dock
function makeDefaultCorners(): [Point2D, Point2D, Point2D, Point2D] {
  const w = window.innerWidth || 1280;
  const h = window.innerHeight || 800;
  const isPortrait = h > w;
  const side = isPortrait ? Math.min(w, h) * 0.72 : Math.min(w, h) * 0.52;
  const cx = isPortrait
    ? w * 0.5
    : w >= 1150
      ? Math.min(w - side * 0.56, w * 0.68)
      : w * 0.5;
  const cy = isPortrait ? Math.max(side * 0.5 + 122, h * 0.39) : h * 0.53;
  const half = side * 0.5;
  return [
    { x: cx - half, y: cy - half },
    { x: cx + half, y: cy - half },
    { x: cx + half, y: cy + half },
    { x: cx - half, y: cy + half },
  ];
}

const corners = ref<[Point2D, Point2D, Point2D, Point2D]>(makeDefaultCorners());
const outerQuad = ref<[Point2D, Point2D, Point2D, Point2D]>(corners.value);
const barRect = ref({ x: 0, y: 0, w: 0, h: 0 });
const dockRect = ref({ x: 0, y: 0, w: 0, h: 0 });

const hasDomBackdrop = computed(() => {
  if (backdropMode.value === 'image') return true;
  if (backdropMode.value === 'screen') return true;
  return false;
});

// Only enable CSS mix-blend-mode: multiply when a real image or screen capture video is rendered below
const hasActiveMediaBackdrop = computed(() => {
  if (backdropMode.value === 'image') return !!imageUrl.value;
  if (backdropMode.value === 'screen') return !!screenStream.value;
  return false;
});

watch(backdropMode, async (mode) => {
  if (mode === 'overlay') {
    if (blendMode.value === 'multiply') {
      blendMode.value = 'alpha-luma';
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
  if (platform === 'tauri') {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const dock =
        dockVisible.value && dockRect.value.w > 0 && dockRect.value.h > 0
          ? dockRect.value
          : { x: 0, y: 0, w: 0, h: 0 };
      await invoke('update_hit_regions', {
        enabled: backdropMode.value === 'overlay',
        forceClickThrough: backdropMode.value === 'overlay' && clickThrough.value,
        barRect: barRect.value,
        dockRect: dock,
        quad: outerQuad.value,
      });
    } catch {
      // Non-fatal in web/dev fallback
    }
    return;
  }

  if (platform === 'android-overlay' && window.AndroidOverlay?.updateHitRegions) {
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
    const boardRect =
      isFinite(minX) && maxX > minX && maxY > minY
        ? {
            x: Math.max(0, minX - pad),
            y: Math.max(0, minY - pad),
            w: maxX - minX + pad * 2,
            h: maxY - minY + pad * 2,
          }
        : { x: 0, y: 0, w: 0, h: 0 };

    const payload = {
      passthroughEnabled: backdropMode.value === 'overlay',
      forceClickThrough: backdropMode.value === 'overlay' && clickThrough.value,
      viewportW: window.innerWidth || 1,
      viewportH: window.innerHeight || 1,
      barRect: barRect.value,
      dockRect: dockVisible.value ? dockRect.value : { x: 0, y: 0, w: 0, h: 0 },
      boardRect,
    };
    try {
      window.AndroidOverlay.updateHitRegions(JSON.stringify(payload));
    } catch {
      // ignore bridge errors
    }
  }
}

watch(
  [backdropMode, clickThrough, calibrating, dockVisible, barRect, dockRect, corners, outerQuad],
  () => {
    syncOverlayHitRegions();
  },
  { deep: true },
);

function resetCorners() {
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
    screenError.value = '当前环境不支持 getDisplayMedia 屏幕捕获 API。';
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
    screenError.value = err instanceof Error ? err.message : '用户取消了屏幕捕获';
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
  // Global hotkey inside window: Ctrl/Cmd+Shift+T toggles click-through
  if (type === 'keydown' && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't') {
    if (canNativeOverlay && backdropMode.value === 'overlay') {
      e.preventDefault();
      clickThrough.value = !clickThrough.value;
      return;
    }
  }
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

onMounted(async () => {
  window.addEventListener('paste', onPaste);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  window.__PENPACANVAS_ON_ANDROID_IMAGE__ = (dataUrl: string) => {
    imageUrl.value = dataUrl;
    backdropMode.value = 'image';
  };
  window.__PENPACANVAS_ON_CLICK_THROUGH__ = (enabled: boolean) => {
    clickThrough.value = enabled;
  };

  // Listen to Tauri global shortcut event (Ctrl+Shift+T) even when window is click-through
  if (platform === 'tauri') {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      await listen<boolean>('click-through-toggled', (ev) => {
        clickThrough.value = ev.payload;
      });
    } catch {
      // ignore if listener unavailable
    }
    syncOverlayHitRegions();
  }
  if (platform === 'android-overlay') {
    requestAnimationFrame(() => syncOverlayHitRegions());
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('paste', onPaste);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
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
        alt="Uploaded puzzle screenshot"
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
        上传题目截图 / 粘贴 (Ctrl+V) / 拖拽图片
      </div>
      <div style="font-size: 11px">
        背景棋盘格用于预览透明效果；上传截图后将按正片叠底 / Alpha=1-亮度 叠加 Penpa+ 画布
      </div>
      <button class="ac-btn active" @click="triggerImagePicker">选择截图文件</button>
    </div>

    <div v-if="backdropMode === 'screen' && !screenStream" class="ac-backdrop-placeholder">
      <div style="font-size: 13px; font-weight: 600; color: var(--md-sys-color-on-surface)">
        Web 屏幕捕获叠加模式
      </div>
      <div style="font-size: 11px">
        通过 Screen Capture API 实时捕获屏幕或窗口作为底图
      </div>
      <div v-if="screenError" style="font-size: 11px; color: var(--md-sys-color-error)">
        {{ screenError }}
      </div>
      <button class="ac-btn active" @click="startScreenCapture">开始屏幕捕获</button>
    </div>

    <!-- WebGL2 4-point Perspective Overlay Canvas (Multiply / Alpha=1-Luma) -->
    <PerspectiveOverlay
      v-model:corners="corners"
      :bridge="bridge"
      :blend-mode="blendMode"
      :has-dom-backdrop="hasActiveMediaBackdrop"
      :opacity="opacity"
      :calibrating="calibrating"
      :align-target="alignTarget"
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
      v-model:backdrop-mode="backdropMode"
      v-model:blend-mode="blendMode"
      v-model:calibrating="calibrating"
      v-model:align-target="alignTarget"
      v-model:opacity="opacity"
      v-model:dock-visible="dockVisible"
      v-model:click-through="clickThrough"
      :platform="platform"
      :can-native-overlay="canNativeOverlay"
      :can-screen-capture="canScreenCapture"
      :has-screen-stream="!!screenStream"
      :has-image="!!imageUrl"
      @pick-image="triggerImagePicker"
      @start-screen-capture="startScreenCapture"
      @stop-screen-capture="stopScreenCapture"
      @reset-corners="resetCorners"
      @close-overlay="closeOverlayApp"
      @bounds-change="(r) => (barRect = r)"
    />
  </main>
</template>
