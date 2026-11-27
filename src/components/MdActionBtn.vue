<script setup lang="ts">
import { computed } from 'vue';
import type { ButtonDisplayMode } from '../core/storage';
import MdIcon, { type MdIconName } from './MdIcon.vue';

const props = withDefaults(
  defineProps<{
    icon?: MdIconName;
    label: string;
    mode: ButtonDisplayMode;
    variant?: 'toggle' | 'trigger';
    tone?: 'default' | 'primary' | 'tonal' | 'danger';
    active?: boolean;
    unavailable?: boolean;
    size?: 'md' | 'sm' | 'xs';
    iconSize?: number;
    title?: string;
    disabled?: boolean;
  }>(),
  {
    icon: undefined,
    variant: 'trigger',
    tone: 'default',
    active: false,
    unavailable: false,
    size: 'md',
    iconSize: undefined,
    title: undefined,
    disabled: false,
  },
);

// Buttons without an icon ALWAYS render text only in their original semantic style.
const effectiveMode = computed<ButtonDisplayMode>(() => (props.icon ? props.mode : 'text-only'));
const isIconOnly = computed(() => effectiveMode.value === 'icon-only');

const resolvedIconSize = computed(() => {
  if (props.iconSize) return props.iconSize;
  if (isIconOnly.value) {
    return props.size === 'xs' ? 16 : props.size === 'sm' ? 17 : 18;
  }
  return props.size === 'xs' ? 14 : props.size === 'sm' ? 15 : 16;
});

const buttonClass = computed(() => {
  if (isIconOnly.value) {
    return [
      'ac-icon-btn',
      props.size !== 'md' ? props.size : '',
      {
        active: props.active,
        danger: props.tone === 'danger',
        unavailable: props.unavailable,
      },
    ];
  }
  return [
    'ac-btn',
    props.variant === 'trigger' ? 'action' : '',
    props.tone !== 'default' ? props.tone : '',
    props.size === 'xs' ? 'xs' : props.size === 'sm' ? 'sm' : '',
    {
      active: props.active,
      unavailable: props.unavailable,
      'has-icon': effectiveMode.value === 'icon-text',
    },
  ];
});
</script>

<template>
  <button
    type="button"
    :class="buttonClass"
    :title="title || label"
    :aria-label="label"
    :disabled="disabled"
  >
    <MdIcon
      v-if="icon && (effectiveMode === 'icon-only' || effectiveMode === 'icon-text')"
      :name="icon"
      :size="resolvedIconSize"
    />
    <span v-if="effectiveMode !== 'icon-only'">{{ label }}</span>
  </button>
</template>
