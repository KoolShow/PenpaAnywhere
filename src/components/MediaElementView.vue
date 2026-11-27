<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  computeHomography,
  homographyToCssMatrix3d,
  rectToQuad,
  type Point2D,
} from '../core/homography';
import {
  isElementPassThrough,
  type CropDraft,
  type MediaElement,
} from '../core/canvasItems';
import {
  worldQuadToViewport,
  type WorldViewportTransform,
} from '../core/world';
import { useWholeElementDrag } from '../core/useWholeElementDrag';
import { messages } from '../core/i18n';

const props = defineProps<{
  element: MediaElement;
  stream: MediaStream | null;
  viewportTransform: WorldViewportTransform;
  worldBoundedToViewport: boolean;
  selected: boolean;
  multiSelected?: boolean;
  grouped?: boolean;
  cropDraft: CropDraft | null;
  spacePanning: boolean;
}>();

const emit = defineEmits<{
  (e: 'select', id: string, additive: boolean): void;
  (e: 'focus-multi-member', id: string): void;
  (e: 'move-start', id: string): void;
  (e: 'translate-by', id: string, dxWorld: number, dyWorld: number): void;
  (e: 'move-end'): void;
  (e: 'update-corners', id: string, corners: [Point2D, Point2D, Point2D, Point2D]): void;
  (e: 'update-crop-draft', draft: CropDraft): void;
  (e: 'update-natural-size', id: string, w: number, h: number): void;
  (e: 'toggle-crop', id: string): void;
}>();

const videoEl = ref<HTMLVideoElement | null>(null);
const ghostVideoEl = ref<HTMLVideoElement | null>(null);

watch(
  [videoEl, ghostVideoEl, () => props.stream],
  ([el, gEl, stream]) => {
    for (const v of [el, gEl]) {
      if (!v) continue;
      if (v.srcObject !== stream) {
        v.srcObject = stream;
        if (stream) v.play().catch(() => {});
      }
    }
  },
  { immediate: true },
);

const effectivePassThrough = computed(
  () => isElementPassThrough(props.element) || props.spacePanning,
);

const isCropping = computed(() => !!props.cropDraft);

const activeCrop = computed(() => props.cropDraft?.crop ?? props.element.crop);

const displayWorldCorners = computed<[Point2D, Point2D, Point2D, Point2D]>(() => {
  if (props.cropDraft) {
    return rectToQuad(props.cropDraft.croppedRect);
  }
  return props.element.corners;
});

const viewportCorners = computed(() =>
  worldQuadToViewport(displayWorldCorners.value, props.viewportTransform),
);

const usePerspectiveMatrix = computed(
  () => props.element.quadMode === 'free' && !isCropping.value,
);

const containerStyle = computed(() => {
  const vp = viewportCorners.value;
  const baseZ = props.element.zIndex;

  if (!usePerspectiveMatrix.value) {
    const minX = Math.min(vp[0].x, vp[1].x, vp[2].x, vp[3].x);
    const maxX = Math.max(vp[0].x, vp[1].x, vp[2].x, vp[3].x);
    const minY = Math.min(vp[0].y, vp[1].y, vp[2].y, vp[3].y);
    const maxY = Math.max(vp[0].y, vp[1].y, vp[2].y, vp[3].y);
    return {
      left: `${minX}px`,
      top: `${minY}px`,
      width: `${Math.max(1, maxX - minX)}px`,
      height: `${Math.max(1, maxY - minY)}px`,
      transform: 'none',
      zIndex: baseZ,
    };
  }

  // Exact GPU-accelerated CSS matrix3d homography from reference box [0..refW]x[0..refH] -> vp corners
  const refW = Math.max(64, props.element.naturalW || 400);
  const refH = Math.max(64, props.element.naturalH || 300);
  const src: [Point2D, Point2D, Point2D, Point2D] = [
    { x: 0, y: 0 },
    { x: refW, y: 0 },
    { x: refW, y: refH },
    { x: 0, y: refH },
  ];
  const H = computeHomography(src, vp);
  return {
    left: '0px',
    top: '0px',
    width: `${refW}px`,
    height: `${refH}px`,
    transform: H ? homographyToCssMatrix3d(H) : 'none',
    transformOrigin: '0 0',
    zIndex: baseZ,
  };
});

const mediaInnerStyle = computed(() => {
  const c = activeCrop.value;
  const cw = Math.max(0.02, c.right - c.left);
  const ch = Math.max(0.02, c.bottom - c.top);
  return {
    left: `${-(c.left / cw) * 100}%`,
    top: `${-(c.top / ch) * 100}%`,
    width: `${(1 / cw) * 100}%`,
    height: `${(1 / ch) * 100}%`,
  };
});

const ghostStyle = computed(() => {
  if (!props.cropDraft) return null;
  const r = props.cropDraft.fullRect;
  const v = props.viewportTransform;
  return {
    left: `${(r.x - v.offsetX) * v.zoom}px`,
    top: `${(r.y - v.offsetY) * v.zoom}px`,
    width: `${r.w * v.zoom}px`,
    height: `${r.h * v.zoom}px`,
    zIndex: Math.max(0, props.element.zIndex - 1),
  };
});

let pendingSingleSelectOnClick = false;

// Shared whole-body drag & crop-preview background-pan composable
const { beginDrag, beginCropPan } = useWholeElementDrag({
  getElement: () => props.element,
  getCropDraft: () => props.cropDraft,
  getViewport: () => props.viewportTransform,
  isWorldBounded: () => props.worldBoundedToViewport,
  onMoveStart: (id) => emit('move-start', id),
  onTranslateBy: (id, dx, dy) => emit('translate-by', id, dx, dy),
  onUpdateCorners: (id, corners) => emit('update-corners', id, corners),
  onUpdateCropDraft: (draft) => emit('update-crop-draft', draft),
  onMoveFinish: (moved) => {
    emit('move-end');
    if (pendingSingleSelectOnClick) {
      pendingSingleSelectOnClick = false;
      if (!moved) {
        emit('select', props.element.id, false);
      }
    }
  },
});

function onVideoMetadataOrResize() {
  const v = videoEl.value;
  if (!v || props.element.kind !== 'screen') return;
  const w = v.videoWidth;
  const h = v.videoHeight;
  if (w > 0 && h > 0 && (w !== props.element.naturalW || h !== props.element.naturalH)) {
    emit('update-natural-size', props.element.id, w, h);
  }
}

function onPointerDown(e: PointerEvent) {
  if (effectivePassThrough.value) return;
  if (e.button === 1) return; // allow middle-mouse canvas pan to bubble
  if (e.button !== 0 && e.pointerType === 'mouse') return;

  e.stopPropagation();
  const additive = e.ctrlKey || e.metaKey;
  if (additive) {
    pendingSingleSelectOnClick = false;
    emit('select', props.element.id, true);
    e.preventDefault();
    return;
  }

  if (props.multiSelected && !props.element.locked && !isCropping.value) {
    pendingSingleSelectOnClick = true;
    emit('focus-multi-member', props.element.id);
    e.preventDefault();
    beginDrag(e);
    return;
  }

  pendingSingleSelectOnClick = false;
  emit('select', props.element.id, false);
  if (props.element.locked) return;

  e.preventDefault();
  if (isCropping.value) {
    beginCropPan(e);
    return;
  }
  beginDrag(e);
}

function onDoubleClick(e: MouseEvent) {
  if (effectivePassThrough.value || props.element.locked || props.grouped) return;
  e.stopPropagation();
  emit('select', props.element.id, false);
  emit('toggle-crop', props.element.id);
}
</script>

<template>
  <!-- 30% translucent full-media crop preview behind active crop frame (draggable to pan background!) -->
  <div
    v-if="ghostStyle"
    class="ac-crop-ghost"
    :style="ghostStyle"
    @pointerdown="onPointerDown"
  >
    <img
      v-if="element.kind === 'image'"
      :src="element.src"
      class="ac-crop-ghost-media"
      draggable="false"
      alt=""
    />
    <video
      v-else
      ref="ghostVideoEl"
      class="ac-crop-ghost-media"
      autoplay
      muted
      playsinline
    />
  </div>

  <!-- Media element container at its unified world zIndex -->
  <div
    class="ac-canvas-item"
    :class="{
      selected,
      locked: element.locked,
      'pass-through': effectivePassThrough,
    }"
    :style="containerStyle"
    @pointerdown="onPointerDown"
    @dblclick="onDoubleClick"
  >
    <img
      v-if="element.kind === 'image'"
      :src="element.src"
      :alt="element.label || messages.stage.imageAlt"
      class="ac-canvas-item-media"
      :style="mediaInnerStyle"
      draggable="false"
    />
    <video
      v-else
      ref="videoEl"
      class="ac-canvas-item-media"
      :style="mediaInnerStyle"
      autoplay
      muted
      playsinline
      @loadedmetadata="onVideoMetadataOrResize"
      @resize="onVideoMetadataOrResize"
    />
  </div>
</template>

<style scoped>
.ac-crop-ghost {
  position: absolute;
  pointer-events: auto;
  cursor: move;
  opacity: 0.3;
  border: 1px dashed var(--md-sys-color-outline);
  user-select: none;
  touch-action: none;
}

.ac-crop-ghost-media {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: fill;
}

.ac-canvas-item {
  position: absolute;
  overflow: hidden;
  user-select: none;
  touch-action: none;
  pointer-events: auto;
  cursor: move;
}

.ac-canvas-item.locked {
  cursor: default;
}

.ac-canvas-item.pass-through {
  pointer-events: none;
}

.ac-canvas-item-media {
  position: absolute;
  display: block;
  object-fit: fill;
  pointer-events: none;
  user-select: none;
}
</style>
