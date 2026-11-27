<script setup lang="ts">
import { computed } from 'vue';
import addSvg from '@material-symbols/svg-400/rounded/add.svg?raw';
import arrowDownwardSvg from '@material-symbols/svg-400/rounded/arrow_downward.svg?raw';
import arrowUpwardSvg from '@material-symbols/svg-400/rounded/arrow_upward.svg?raw';
import buildSvg from '@material-symbols/svg-400/rounded/build.svg?raw';
import castSvg from '@material-symbols/svg-400/rounded/cast.svg?raw';
import checkSvg from '@material-symbols/svg-400/rounded/check.svg?raw';
import chevronLeftSvg from '@material-symbols/svg-400/rounded/chevron_left.svg?raw';
import chevronRightSvg from '@material-symbols/svg-400/rounded/chevron_right.svg?raw';
import closeSvg from '@material-symbols/svg-400/rounded/close.svg?raw';
import contrastSvg from '@material-symbols/svg-400/rounded/contrast.svg?raw';
import cropSvg from '@material-symbols/svg-400/rounded/crop.svg?raw';
import deleteSvg from '@material-symbols/svg-400/rounded/delete.svg?raw';
import doNotTouchSvg from '@material-symbols/svg-400/rounded/do_not_touch.svg?raw';
import dragIndicatorSvg from '@material-symbols/svg-400/rounded/drag_indicator.svg?raw';
import gridOnSvg from '@material-symbols/svg-400/rounded/grid_on.svg?raw';
import imageSvg from '@material-symbols/svg-400/rounded/image.svg?raw';
import keepSvg from '@material-symbols/svg-400/rounded/keep.svg?raw';
import keyboardArrowDownSvg from '@material-symbols/svg-400/rounded/keyboard_arrow_down.svg?raw';
import keyboardArrowUpSvg from '@material-symbols/svg-400/rounded/keyboard_arrow_up.svg?raw';
import layersSvg from '@material-symbols/svg-400/rounded/layers.svg?raw';
import lockSvg from '@material-symbols/svg-400/rounded/lock.svg?raw';
import lockOpenSvg from '@material-symbols/svg-400/rounded/lock_open.svg?raw';
import logoutSvg from '@material-symbols/svg-400/rounded/logout.svg?raw';
import openInNewSvg from '@material-symbols/svg-400/rounded/open_in_new.svg?raw';
import recenterSvg from '@material-symbols/svg-400/rounded/recenter.svg?raw';
import removeSvg from '@material-symbols/svg-400/rounded/remove.svg?raw';
import settingsSvg from '@material-symbols/svg-400/rounded/settings.svg?raw';
import stackSvg from '@material-symbols/svg-400/rounded/stack.svg?raw';
import stackGroupSvg from '@material-symbols/svg-400/rounded/stack_group.svg?raw';
import verticalAlignBottomSvg from '@material-symbols/svg-400/rounded/vertical_align_bottom.svg?raw';
import verticalAlignTopSvg from '@material-symbols/svg-400/rounded/vertical_align_top.svg?raw';
import visibilitySvg from '@material-symbols/svg-400/rounded/visibility.svg?raw';
import visibilityOffSvg from '@material-symbols/svg-400/rounded/visibility_off.svg?raw';

const ICONS = {
  add: addSvg,
  arrow_downward: arrowDownwardSvg,
  arrow_upward: arrowUpwardSvg,
  build: buildSvg,
  cast: castSvg,
  check: checkSvg,
  chevron_left: chevronLeftSvg,
  chevron_right: chevronRightSvg,
  close: closeSvg,
  contrast: contrastSvg,
  crop: cropSvg,
  delete: deleteSvg,
  do_not_touch: doNotTouchSvg,
  drag_indicator: dragIndicatorSvg,
  grid_on: gridOnSvg,
  image: imageSvg,
  keep: keepSvg,
  keyboard_arrow_down: keyboardArrowDownSvg,
  keyboard_arrow_up: keyboardArrowUpSvg,
  layers: layersSvg,
  lock: lockSvg,
  lock_open: lockOpenSvg,
  logout: logoutSvg,
  open_in_new: openInNewSvg,
  recenter: recenterSvg,
  remove: removeSvg,
  settings: settingsSvg,
  stack: stackSvg,
  stack_group: stackGroupSvg,
  vertical_align_bottom: verticalAlignBottomSvg,
  vertical_align_top: verticalAlignTopSvg,
  visibility: visibilitySvg,
  visibility_off: visibilityOffSvg,
} as const;

export type MdIconName = keyof typeof ICONS;

const props = withDefaults(
  defineProps<{
    name: MdIconName;
    size?: number;
  }>(),
  {
    size: 16,
  },
);

const svgMarkup = computed(() => ICONS[props.name]);
const iconStyle = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
}));
</script>

<template>
  <span class="ac-md-icon" :style="iconStyle" aria-hidden="true" v-html="svgMarkup" />
</template>

<style scoped>
.ac-md-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  line-height: 0;
}

.ac-md-icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  fill: currentColor;
}
</style>
