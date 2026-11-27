<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: number;
    min: number;
    max: number;
    step?: number;
    width?: string;
    ariaLabel?: string;
    disabled?: boolean;
  }>(),
  {
    step: 0.01,
    width: '72px',
    ariaLabel: undefined,
    disabled: false,
  },
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void;
}>();

const inputEl = ref<HTMLInputElement | null>(null);
const pressed = ref(false);
let activePointerDrag = false;

const pct = computed(() => {
  const span = props.max - props.min;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, (props.modelValue - props.min) / span));
});

const sliderStyle = computed(() => ({
  width: props.width,
  '--pct': String(pct.value),
}));

function blurSliderInput() {
  const el = inputEl.value;
  if (el && document.activeElement === el) {
    el.blur();
  }
}

function cleanupPointerListeners() {
  window.removeEventListener('pointerup', onGlobalPointerEnd, true);
  window.removeEventListener('pointercancel', onGlobalPointerEnd, true);
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
  window.addEventListener('pointerup', onGlobalPointerEnd, true);
  window.addEventListener('pointercancel', onGlobalPointerEnd, true);
}

function onInput(e: Event) {
  const val = parseFloat((e.target as HTMLInputElement).value);
  if (Number.isFinite(val)) {
    emit('update:modelValue', val);
  }
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
    class="ac-md-slider"
    :class="{ pressed, disabled }"
    :style="sliderStyle"
    @pointerdown="onPointerDown"
  >
    <span class="ac-md-slider-active" aria-hidden="true" />
    <span class="ac-md-slider-inactive" aria-hidden="true">
      <span v-if="pct < 0.92" class="ac-md-slider-stop" />
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
      @blur="pressed = false"
    />
  </span>
</template>

<style scoped>
/* Material Design 3 Expressive Slider (--|-) */
.ac-md-slider {
  --pct: 0.5;
  --handle-x: calc(2px + var(--pct) * (100% - 4px));
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 24px;
  flex-shrink: 0;
  user-select: none;
  touch-action: pan-x;
  cursor: pointer;
}

.ac-md-slider.disabled {
  opacity: 0.38;
  pointer-events: none;
}

.ac-md-slider-active {
  position: absolute;
  top: 50%;
  left: 0;
  height: 10px;
  width: max(0px, calc(var(--handle-x) - 5px));
  transform: translateY(-50%);
  border-radius: 5px 2px 2px 5px;
  background: var(--md-sys-color-primary);
  pointer-events: none;
}

.ac-md-slider-inactive {
  position: absolute;
  top: 50%;
  right: 0;
  height: 10px;
  width: max(0px, calc(100% - var(--handle-x) - 5px));
  transform: translateY(-50%);
  border-radius: 2px 5px 5px 2px;
  background: var(--md-sys-color-secondary-container);
  pointer-events: none;
  overflow: hidden;
}

.ac-md-slider-stop {
  position: absolute;
  top: 50%;
  right: 3px;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  transform: translateY(-50%);
  background: var(--md-sys-color-primary);
  opacity: 0.7;
}

.ac-md-slider-handle {
  position: absolute;
  top: 50%;
  left: var(--handle-x);
  width: 4px;
  height: 18px;
  border-radius: 999px;
  transform: translate(-50%, -50%);
  background: var(--md-sys-color-primary);
  pointer-events: none;
  transition: width 0.12s cubic-bezier(0.2, 0, 0, 1);
}

/* Per MD3 Expressive slider spec: no glow/highlight halo on hover or click;
   handle simply narrows to 2dp while actively dragged. */
.ac-md-slider.pressed .ac-md-slider-handle {
  width: 2px;
}

/* Keyboard-only accessible focus indicator (never triggered on mouse/touch click) */
.ac-md-slider:has(.ac-md-slider-input:focus-visible) .ac-md-slider-handle {
  outline: 2px solid var(--md-sys-color-secondary);
  outline-offset: 1px;
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
