<script setup lang="ts">
import { computed, ref } from 'vue';
import { hslToHex } from '../core/theme';

const props = defineProps<{
  modelValue: number;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', hue: number): void;
}>();

const ringEl = ref<HTMLDivElement | null>(null);
const dragging = ref(false);

const SIZE = 124;
const RING_RADIUS = 50; // center of the 18px ring track

const normalizedHue = computed(() => ((Math.round(props.modelValue) % 360) + 360) % 360);
const thumbHex = computed(() => hslToHex(normalizedHue.value, 0.82, 0.56));

// Angle 0deg is at top (12 o'clock), matching CSS conic-gradient(from 0deg, ...)
const thumbPos = computed(() => {
  const rad = ((normalizedHue.value - 90) * Math.PI) / 180;
  return {
    x: SIZE / 2 + Math.cos(rad) * RING_RADIUS,
    y: SIZE / 2 + Math.sin(rad) * RING_RADIUS,
  };
});

function updateFromPointer(e: PointerEvent) {
  if (!ringEl.value || props.disabled) return;
  const rect = ringEl.value.getBoundingClientRect();
  const cx = rect.left + rect.width * 0.5;
  const cy = rect.top + rect.height * 0.5;
  const dx = e.clientX - cx;
  const dy = e.clientY - cy;
  if (Math.hypot(dx, dy) < 4) return;
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  if (deg < 0) deg += 360;
  emit('update:modelValue', Math.round(deg) % 360);
}

function onPointerDown(e: PointerEvent) {
  if (props.disabled) return;
  e.preventDefault();
  dragging.value = true;
  try {
    (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId);
  } catch {
    // ignore
  }
  updateFromPointer(e);
}

function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return;
  e.preventDefault();
  updateFromPointer(e);
}

function onPointerUp(e: PointerEvent) {
  if (!dragging.value) return;
  dragging.value = false;
  try {
    (e.currentTarget as HTMLElement)?.releasePointerCapture?.(e.pointerId);
  } catch {
    // ignore
  }
}
</script>

<template>
  <div class="ac-hue-wrap" :class="{ disabled }">
    <div
      ref="ringEl"
      class="ac-hue-ring"
      role="slider"
      tabindex="0"
      aria-label="Hue"
      :aria-valuemin="0"
      :aria-valuemax="359"
      :aria-valuenow="normalizedHue"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown.left.prevent="emit('update:modelValue', (normalizedHue + 355) % 360)"
      @keydown.right.prevent="emit('update:modelValue', (normalizedHue + 5) % 360)"
    >
      <div class="ac-hue-hole">
        <span class="ac-hue-swatch" :style="{ background: 'var(--md-sys-color-primary)' }" />
        <span class="ac-hue-deg">{{ normalizedHue }}°</span>
      </div>
      <div
        class="ac-hue-thumb"
        :class="{ dragging }"
        :style="{
          left: `${thumbPos.x}px`,
          top: `${thumbPos.y}px`,
          background: thumbHex,
        }"
      />
    </div>
  </div>
</template>

<style scoped>
.ac-hue-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.ac-hue-wrap.disabled {
  opacity: 0.45;
  pointer-events: none;
}

.ac-hue-ring {
  position: relative;
  width: 124px;
  height: 124px;
  border-radius: 50%;
  background: conic-gradient(
    from 0deg,
    hsl(0 85% 58%),
    hsl(60 85% 55%),
    hsl(120 75% 50%),
    hsl(180 80% 50%),
    hsl(240 85% 62%),
    hsl(300 82% 58%),
    hsl(360 85% 58%)
  );
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--md-sys-color-outline) 35%, transparent);
  cursor: pointer;
  touch-action: none;
  user-select: none;
  outline: none;
}

.ac-hue-ring:focus-visible {
  box-shadow: 0 0 0 2px var(--md-sys-color-primary);
}

.ac-hue-hole {
  position: absolute;
  inset: 22px;
  border-radius: 50%;
  background: var(--md-sys-color-surface-container);
  border: 1px solid var(--md-sys-color-outline-variant);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  pointer-events: none;
}

.ac-hue-swatch {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 1px solid var(--md-sys-color-outline-variant);
}

.ac-hue-deg {
  font-size: 11px;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--md-sys-color-on-surface-variant);
}

.ac-hue-thumb {
  position: absolute;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  border: 2.5px solid #ffffff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.55);
  pointer-events: none;
  transition: transform 0.1s ease;
}

.ac-hue-thumb.dragging {
  transform: translate(-50%, -50%) scale(1.16);
}
</style>
