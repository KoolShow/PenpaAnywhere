<script setup lang="ts">
import { computed, ref } from 'vue';

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

const pressed = ref(false);

const pct = computed(() => {
  const span = props.max - props.min;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, (props.modelValue - props.min) / span));
});

const sliderStyle = computed(() => ({
  width: props.width,
  '--pct': String(pct.value),
}));

function onInput(e: Event) {
  const val = parseFloat((e.target as HTMLInputElement).value);
  if (Number.isFinite(val)) {
    emit('update:modelValue', val);
  }
}
</script>

<template>
  <span
    class="ac-md-slider"
    :class="{ pressed, disabled }"
    :style="sliderStyle"
    @pointerdown="pressed = true"
    @pointerup="pressed = false"
    @pointercancel="pressed = false"
    @pointerleave="pressed = false"
  >
    <span class="ac-md-slider-active" aria-hidden="true" />
    <span class="ac-md-slider-inactive" aria-hidden="true">
      <span v-if="pct < 0.92" class="ac-md-slider-stop" />
    </span>
    <span class="ac-md-slider-handle" aria-hidden="true" />
    <input
      class="ac-md-slider-input"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      :disabled="disabled"
      :aria-label="ariaLabel"
      @input="onInput"
      @blur="pressed = false"
    />
  </span>
</template>

<style scoped>
/* Material Design 3 Expressive Slider (--|-) */
.ac-md-slider {
  --pct: 0.5;
  --handle-x: calc(3px + var(--pct) * (100% - 6px));
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 22px;
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
  left: calc(var(--handle-x) + 5px);
  right: 0;
  height: 10px;
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
  transition: width 0.12s ease, height 0.12s ease, box-shadow 0.14s ease;
}

@media (hover: hover) {
  .ac-md-slider:hover .ac-md-slider-handle {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--md-sys-color-primary) 16%, transparent);
  }
}

.ac-md-slider.pressed .ac-md-slider-handle,
.ac-md-slider:focus-within .ac-md-slider-handle {
  width: 3px;
  height: 20px;
  box-shadow: 0 0 0 5px color-mix(in srgb, var(--md-sys-color-primary) 22%, transparent);
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
