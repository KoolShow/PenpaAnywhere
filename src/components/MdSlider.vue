<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: number;
    min: number;
    max: number;
    step?: number;
    width?: string;
    size?: 'sm' | 'md';
    ariaLabel?: string;
    disabled?: boolean;
    showValueIndicator?: boolean;
    formatValue?: (value: number) => string;
  }>(),
  {
    step: 0.01,
    width: '140px',
    size: 'md',
    ariaLabel: undefined,
    disabled: false,
    showValueIndicator: true,
    formatValue: undefined,
  },
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void;
}>();

const rootEl = ref<HTMLSpanElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
const pressed = ref(false);
const keyboardFocused = ref(false);
const indicatorPos = ref<{ x: number; y: number }>({ x: 0, y: 0 });
let activePointerDrag = false;

const pct = computed(() => {
  const span = props.max - props.min;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, (props.modelValue - props.min) / span));
});

const formattedValue = computed(() => {
  if (props.formatValue) return props.formatValue(props.modelValue);
  const step = props.step || 0.01;
  const decimals = step >= 1 ? 0 : Math.min(3, Math.max(0, Math.ceil(-Math.log10(step))));
  return Number(props.modelValue.toFixed(decimals)).toString();
});

const indicatorVisible = computed(
  () => props.showValueIndicator && !props.disabled && (pressed.value || keyboardFocused.value),
);

const sliderStyle = computed(() => ({
  width: props.width,
  '--pct': String(pct.value),
}));

function updateIndicatorPosition() {
  const el = rootEl.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const handleMargin = Math.min(rect.width * 0.5, 2);
  const handleX = rect.left + handleMargin + pct.value * Math.max(0, rect.width - handleMargin * 2);
  const clampedX = Math.max(28, Math.min((window.innerWidth || 1280) - 28, handleX));
  const clampedY = Math.max(40, rect.top - 8);
  indicatorPos.value = { x: clampedX, y: clampedY };
}

watch(
  [() => props.modelValue, indicatorVisible],
  ([, visible]) => {
    if (visible) {
      updateIndicatorPosition();
    }
  },
  { flush: 'post' },
);

function blurSliderInput() {
  const el = inputEl.value;
  if (el && document.activeElement === el) {
    el.blur();
  }
}

function cleanupPointerListeners() {
  window.removeEventListener('pointerup', onGlobalPointerEnd, true);
  window.removeEventListener('pointercancel', onGlobalPointerEnd, true);
  window.removeEventListener('blur', onGlobalPointerEnd);
}

function onGlobalPointerEnd() {
  cleanupPointerListeners();
  pressed.value = false;
  if (activePointerDrag) {
    activePointerDrag = false;
    blurSliderInput();
    // Some engines focus <input type="range"> on click/mouseup right after pointerup
    requestAnimationFrame(() => {
      if (!activePointerDrag) {
        blurSliderInput();
      }
    });
  }
}

function onPointerDown() {
  if (props.disabled) return;
  activePointerDrag = true;
  pressed.value = true;
  updateIndicatorPosition();
  window.addEventListener('pointerup', onGlobalPointerEnd, true);
  window.addEventListener('pointercancel', onGlobalPointerEnd, true);
  window.addEventListener('blur', onGlobalPointerEnd);
}

function onInput(e: Event) {
  const val = parseFloat((e.target as HTMLInputElement).value);
  if (Number.isFinite(val)) {
    emit('update:modelValue', val);
    requestAnimationFrame(updateIndicatorPosition);
  }
}

function onFocus() {
  if (!activePointerDrag && inputEl.value?.matches(':focus-visible')) {
    keyboardFocused.value = true;
    updateIndicatorPosition();
  }
}

function onBlur() {
  pressed.value = false;
  keyboardFocused.value = false;
}

function onChange() {
  if (!activePointerDrag && pressed.value) {
    pressed.value = false;
  }
  if (!activePointerDrag && inputEl.value && !inputEl.value.matches(':focus-visible')) {
    blurSliderInput();
  }
}

onBeforeUnmount(() => {
  cleanupPointerListeners();
});
</script>

<template>
  <span
    ref="rootEl"
    class="ac-md-slider"
    :class="[`size-${size}`, { pressed, disabled }]"
    :style="sliderStyle"
    @pointerdown="onPointerDown"
  >
    <span class="ac-md-slider-active" aria-hidden="true" />
    <span class="ac-md-slider-inactive" aria-hidden="true">
      <span v-if="pct < 0.94" class="ac-md-slider-stop" />
    </span>
    <span class="ac-md-slider-handle" aria-hidden="true" />
    <input
      ref="inputEl"
      class="ac-md-slider-input"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      :disabled="disabled"
      :aria-label="ariaLabel"
      @input="onInput"
      @change="onChange"
      @focus="onFocus"
      @blur="onBlur"
    />
  </span>

  <!-- Material Design 3 Floating Value Indicator Pill (teleported to body so parent overflow never clips it) -->
  <Teleport to="body">
    <Transition name="ac-md-slider-tip">
      <div
        v-if="indicatorVisible"
        class="ac-md-slider-indicator"
        :style="{ left: `${indicatorPos.x}px`, top: `${indicatorPos.y}px` }"
        role="status"
        aria-live="polite"
      >
        {{ formattedValue }}
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* Material Design 3 Expressive Slider */
.ac-md-slider {
  --pct: 0.5;
  --track-h: 16px;
  --track-r: 8px;
  --handle-h: 28px;
  --handle-gap: 6px;
  --stop-size: 4px;
  --handle-x: calc(2px + var(--pct) * (100% - 4px));
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 32px;
  flex-shrink: 0;
  user-select: none;
  touch-action: pan-x;
  cursor: pointer;
}

.ac-md-slider.size-sm {
  --track-h: 12px;
  --track-r: 6px;
  --handle-h: 22px;
  --handle-gap: 5px;
  --stop-size: 3px;
  height: 24px;
}

.ac-md-slider.disabled {
  opacity: 0.38;
  pointer-events: none;
}

.ac-md-slider-active {
  position: absolute;
  top: 50%;
  left: 0;
  height: var(--track-h);
  width: max(0px, calc(var(--handle-x) - var(--handle-gap)));
  transform: translateY(-50%);
  border-radius: var(--track-r) 2px 2px var(--track-r);
  background: var(--md-sys-color-primary);
  pointer-events: none;
}

.ac-md-slider-inactive {
  position: absolute;
  top: 50%;
  right: 0;
  height: var(--track-h);
  width: max(0px, calc(100% - var(--handle-x) - var(--handle-gap)));
  transform: translateY(-50%);
  border-radius: 2px var(--track-r) var(--track-r) 2px;
  background: var(--md-sys-color-secondary-container);
  pointer-events: none;
  overflow: hidden;
}

.ac-md-slider-stop {
  position: absolute;
  top: 50%;
  right: 4px;
  width: var(--stop-size);
  height: var(--stop-size);
  border-radius: 50%;
  transform: translateY(-50%);
  background: var(--md-sys-color-primary);
  opacity: 0.72;
}

.ac-md-slider-handle {
  position: absolute;
  top: 50%;
  left: var(--handle-x);
  width: 4px;
  height: var(--handle-h);
  border-radius: 999px;
  transform: translate(-50%, -50%);
  background: var(--md-sys-color-primary);
  pointer-events: none;
  transition:
    width 0.12s cubic-bezier(0.2, 0, 0, 1),
    height 0.12s cubic-bezier(0.2, 0, 0, 1);
}

/* MD3 Expressive handle narrows to 2dp while actively pressed/dragged */
.ac-md-slider.pressed .ac-md-slider-handle {
  width: 2px;
}

/* Keyboard-only accessible focus indicator */
.ac-md-slider:has(.ac-md-slider-input:focus-visible) .ac-md-slider-handle {
  outline: 2px solid var(--md-sys-color-secondary);
  outline-offset: 2px;
}

.ac-md-slider-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
</style>

<style>
/* Global styles for Teleported MD3 Value Indicator Pill (Inverse Surface + Level 2 shadow) */
.ac-md-slider-indicator {
  position: fixed;
  z-index: 3000;
  transform: translate(-50%, -100%) scale(var(--ac-ui-scale, 1));
  transform-origin: bottom center;
  min-width: 44px;
  height: 30px;
  padding: 0 11px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--md-sys-color-inverse-surface);
  color: var(--md-sys-color-inverse-on-surface);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  box-shadow:
    0 2px 6px 2px color-mix(in srgb, var(--md-sys-color-shadow) 15%, transparent),
    0 1px 2px color-mix(in srgb, var(--md-sys-color-shadow) 30%, transparent);
  pointer-events: none;
  user-select: none;
  white-space: nowrap;
}

.ac-md-slider-tip-enter-active,
.ac-md-slider-tip-leave-active {
  transition:
    opacity 0.14s cubic-bezier(0.2, 0, 0, 1),
    transform 0.14s cubic-bezier(0.2, 0, 0, 1);
}

.ac-md-slider-tip-enter-from,
.ac-md-slider-tip-leave-to {
  opacity: 0;
  transform: translate(-50%, calc(-100% + 6px)) scale(calc(var(--ac-ui-scale, 1) * 0.86));
}
</style>
