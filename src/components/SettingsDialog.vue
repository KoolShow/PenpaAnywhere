<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { DEFAULT_PENPA_MD3_CSS } from '../core/defaultPenpaCss';
import HueRingPicker from './HueRingPicker.vue';
import MdIcon from './MdIcon.vue';
import MdSlider from './MdSlider.vue';
import type { UnavailableReasonKey } from './ControlBar.vue';
import {
  openExternalLink,
  setAndroidKeyboardFocusable,
  supportsOverlaySwitch,
  type AndroidScreenshotCompositeStatus,
  type RuntimePlatform,
} from '../core/platform';
import {
  customHue,
  dynamicColorEnabled,
  dynamicColorSupported,
  setCustomHue,
  setDynamicColorEnabled,
  setThemeMode,
  themeMode,
} from '../core/theme';
import type { ButtonDisplayMode, ThemeMode } from '../core/storage';
import {
  currentLocale,
  LOCALE_OPTIONS,
  messages,
  setLocale,
  type AppLocale,
} from '../core/i18n';
import { beginGlobalDrag, endGlobalDrag, tryCapturePointer, tryReleasePointer } from '../core/dragGuard';

const GITHUB_REPO_URL = 'https://github.com/KoolShow/PenpaAnywhere';
const GITHUB_ISSUES_URL = 'https://github.com/KoolShow/PenpaAnywhere/issues';

const props = defineProps<{
  open: boolean;
  platform: RuntimePlatform;
  customCssEnabled: boolean;
  customCss: string;
  buttonDisplayMode: ButtonDisplayMode;
  globalScale: number;
  penpaScale: number;
  penpaBlurOpacity: number;
  overlayFullCanvas: boolean;
  multiMonitorEnabled: boolean;
  showUnavailableOptions: boolean;
  highlightKey?: 'overlayFullCanvas' | null;
  highlightTick?: number;
  androidScreenshotStatus?: AndroidScreenshotCompositeStatus | null;
}>();

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'update:customCssEnabled', v: boolean): void;
  (e: 'update:customCss', v: string): void;
  (e: 'update:buttonDisplayMode', v: ButtonDisplayMode): void;
  (e: 'update:globalScale', v: number): void;
  (e: 'update:penpaScale', v: number): void;
  (e: 'update:penpaBlurOpacity', v: number): void;
  (e: 'update:overlayFullCanvas', v: boolean): void;
  (e: 'update:multiMonitorEnabled', v: boolean): void;
  (e: 'update:showUnavailableOptions', v: boolean): void;
  (e: 'unavailable-click', key: UnavailableReasonKey): void;
  (e: 'toggle-android-screenshot-composite', enabled: boolean): void;
  (e: 'request-android-all-files'): void;
}>();

function formatPercent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

const canOverlayMode = computed(() => supportsOverlaySwitch(props.platform));
const canMultiMonitor = computed(() => props.platform === 'tauri');
const showDynamicColorRow = computed(() => dynamicColorSupported.value || props.showUnavailableOptions);
const showHueRow = computed(() => !dynamicColorEnabled.value || !dynamicColorSupported.value);
const showOverlayFullCanvasRow = computed(() => canOverlayMode.value || props.showUnavailableOptions);
const showMultiMonitorRow = computed(() => canMultiMonitor.value || props.showUnavailableOptions);
const showAndroidShotSection = computed(
  () => props.platform === 'android-overlay' || props.showUnavailableOptions,
);

const themeModeOptions = computed<Array<{ value: ThemeMode; label: string }>>(() => [
  { value: 'auto', label: messages.value.settings.themeAuto },
  { value: 'light', label: messages.value.settings.themeLight },
  { value: 'dark', label: messages.value.settings.themeDark },
]);

const buttonDisplayOptions = computed<Array<{ value: ButtonDisplayMode; label: string }>>(() => [
  { value: 'icon-only', label: messages.value.settings.buttonDisplayIconOnly },
  { value: 'icon-text', label: messages.value.settings.buttonDisplayIconText },
  { value: 'text-only', label: messages.value.settings.buttonDisplayTextOnly },
]);

function handleDynamicColorToggle() {
  if (!dynamicColorSupported.value) {
    emit('unavailable-click', 'dynamicColorUnavailable');
    return;
  }
  setDynamicColorEnabled(!dynamicColorEnabled.value);
}

function handleOverlayFullCanvasToggle() {
  if (!canOverlayMode.value) {
    emit('unavailable-click', 'overlayWeb');
    return;
  }
  emit('update:overlayFullCanvas', !props.overlayFullCanvas);
}

function handleMultiMonitorToggle() {
  if (!canMultiMonitor.value) {
    emit('unavailable-click', 'multiMonitorUnavailable');
    return;
  }
  emit('update:multiMonitorEnabled', !props.multiMonitorEnabled);
}

function handleAndroidShotUnavailable() {
  emit('unavailable-click', 'androidShotUnavailable');
}

function handleOpenExternal(url: string) {
  void openExternalLink(url);
}

const cssDraft = ref(props.customCss);
const cssEditorHeight = ref(220);
const cssResizing = ref(false);
const overlayFullCanvasRowEl = ref<HTMLElement | null>(null);
const flashingKey = ref<'overlayFullCanvas' | null>(null);
let flashTimer = 0;

function clearHighlightFlash() {
  if (flashTimer) {
    window.clearTimeout(flashTimer);
    flashTimer = 0;
  }
  flashingKey.value = null;
}

function triggerHighlightFlash() {
  if (!props.open || props.highlightKey !== 'overlayFullCanvas') return;
  clearHighlightFlash();
  void nextTick(() => {
    overlayFullCanvasRowEl.value?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    requestAnimationFrame(() => {
      flashingKey.value = 'overlayFullCanvas';
      flashTimer = window.setTimeout(() => {
        flashTimer = 0;
        flashingKey.value = null;
      }, 1900);
    });
  });
}

watch(
  [() => props.open, () => props.highlightTick],
  ([isOpen]) => {
    if (!isOpen) {
      clearHighlightFlash();
    } else if (props.highlightKey) {
      triggerHighlightFlash();
    }
  },
);

let resizeSession: {
  pointerId: number;
  captureEl: Element | null;
  startY: number;
  startHeight: number;
} | null = null;

function finishCssResize() {
  if (!resizeSession) return;
  tryReleasePointer(resizeSession.captureEl, resizeSession.pointerId);
  resizeSession = null;
  cssResizing.value = false;
  window.removeEventListener('pointermove', onCssResizeMove);
  window.removeEventListener('pointerup', onCssResizeEnd);
  window.removeEventListener('pointercancel', onCssResizeEnd);
  window.removeEventListener('blur', finishCssResize);
  endGlobalDrag();
}

function startCssResize(e: PointerEvent) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  e.preventDefault();
  e.stopPropagation();
  if (resizeSession) finishCssResize();
  const captureEl = tryCapturePointer(e.currentTarget as HTMLElement, e.pointerId);
  resizeSession = {
    pointerId: e.pointerId,
    captureEl,
    startY: e.clientY,
    startHeight: cssEditorHeight.value,
  };
  cssResizing.value = true;
  beginGlobalDrag();
  window.addEventListener('pointermove', onCssResizeMove);
  window.addEventListener('pointerup', onCssResizeEnd);
  window.addEventListener('pointercancel', onCssResizeEnd);
  window.addEventListener('blur', finishCssResize);
}

function onCssResizeMove(e: PointerEvent) {
  if (!resizeSession || e.pointerId !== resizeSession.pointerId) return;
  e.preventDefault();
  const nextH = resizeSession.startHeight + (e.clientY - resizeSession.startY);
  cssEditorHeight.value = Math.round(Math.max(120, Math.min(480, nextH)));
}

function onCssResizeEnd(e: PointerEvent) {
  if (!resizeSession || e.pointerId !== resizeSession.pointerId) return;
  finishCssResize();
}

watch(
  () => props.customCss,
  (val) => {
    if (val !== cssDraft.value) {
      cssDraft.value = val;
    }
  },
);

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      finishCssResize();
      setAndroidKeyboardFocusable(false);
    } else {
      cssDraft.value = props.customCss;
    }
  },
);

function selectLanguage(loc: AppLocale) {
  setLocale(loc);
}

function closeDialog() {
  finishCssResize();
  emit('update:open', false);
}

function onCssInput(e: Event) {
  const val = (e.target as HTMLTextAreaElement).value;
  cssDraft.value = val;
  emit('update:customCss', val);
}

function onCssKeyDown(e: KeyboardEvent) {
  if (e.key === 'Tab') {
    e.preventDefault();
    const el = e.target as HTMLTextAreaElement;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = cssDraft.value.slice(0, start) + '  ' + cssDraft.value.slice(end);
    cssDraft.value = next;
    emit('update:customCss', next);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + 2;
    });
  }
}

function resetDefaultCss() {
  cssDraft.value = DEFAULT_PENPA_MD3_CSS;
  emit('update:customCss', DEFAULT_PENPA_MD3_CSS);
  if (!props.customCssEnabled) {
    emit('update:customCssEnabled', true);
  }
}

function clearCss() {
  cssDraft.value = '';
  emit('update:customCss', '');
}

onBeforeUnmount(() => {
  clearHighlightFlash();
  finishCssResize();
});
</script>

<template>
  <Transition name="ac-settings-modal">
    <div v-if="open" class="ac-settings-backdrop" @pointerdown.self="closeDialog">
      <section
        class="ac-settings-card"
        role="dialog"
        aria-modal="true"
        :aria-label="messages.settings.ariaLabel"
      >
        <header class="ac-settings-header">
          <div class="ac-settings-title">{{ messages.settings.title }}</div>
          <button
            type="button"
            class="ac-icon-btn ac-dialog-close-btn"
            :title="messages.settings.close"
            :aria-label="messages.settings.close"
            @click="closeDialog"
          >
            <MdIcon name="close" :size="18" />
          </button>
        </header>

        <div class="ac-settings-body">
          <!-- Section 0: Interface Language (CN / EN / JP) - Auto one-way syncs to Penpa+ -->
          <div class="ac-setting-section">
            <div class="ac-setting-row">
              <div class="ac-setting-label">{{ messages.settings.languageLabel }}</div>
              <div class="ac-lang-segmented" role="group" :aria-label="messages.settings.languageLabel">
                <button
                  v-for="opt in LOCALE_OPTIONS"
                  :key="opt.value"
                  class="ac-lang-seg-btn"
                  :class="{ active: currentLocale === opt.value }"
                  @click="selectLanguage(opt.value)"
                >
                  {{ opt.label }}
                </button>
              </div>
            </div>
          </div>

          <div class="ac-divider" />

          <!-- Section 0.5: Appearance (Light / Dark / Auto) & Dynamic Color + Hue Ring -->
          <div class="ac-setting-section ac-setting-section-animated">
            <div class="ac-setting-row">
              <div class="ac-setting-label">{{ messages.settings.themeLabel }}</div>
              <div class="ac-lang-segmented" role="group" :aria-label="messages.settings.themeLabel">
                <button
                  v-for="opt in themeModeOptions"
                  :key="opt.value"
                  class="ac-lang-seg-btn"
                  :class="{ active: themeMode === opt.value }"
                  @click="setThemeMode(opt.value)"
                >
                  {{ opt.label }}
                </button>
              </div>
            </div>

            <div class="ac-collapse" :class="{ open: showDynamicColorRow }" :inert="!showDynamicColorRow">
              <div class="ac-collapse-inner ac-collapse-pad-top">
                <div class="ac-setting-row">
                  <div class="ac-setting-label">{{ messages.settings.dynamicColorLabel }}</div>
                  <button
                    type="button"
                    role="switch"
                    class="ac-md3-switch"
                    :aria-checked="dynamicColorSupported && dynamicColorEnabled"
                    :aria-label="messages.settings.dynamicColorLabel"
                    :class="{
                      checked: dynamicColorSupported && dynamicColorEnabled,
                      unavailable: !dynamicColorSupported,
                    }"
                    @click="handleDynamicColorToggle"
                  >
                    <span class="ac-md3-switch-thumb">
                      <MdIcon
                        v-if="dynamicColorSupported && dynamicColorEnabled"
                        name="check"
                        :size="14"
                        class="ac-md3-switch-check"
                      />
                    </span>
                  </button>
                </div>
              </div>
            </div>

            <div class="ac-collapse" :class="{ open: showHueRow }" :inert="!showHueRow">
              <div class="ac-collapse-inner ac-collapse-pad-top">
                <div class="ac-setting-row ac-hue-row">
                  <div class="ac-setting-label">{{ messages.settings.hueLabel }}</div>
                  <HueRingPicker :model-value="customHue" @update:model-value="setCustomHue" />
                </div>
              </div>
            </div>

            <div class="ac-setting-row ac-row-gap-top">
              <div class="ac-setting-label">{{ messages.settings.buttonDisplayLabel }}</div>
              <div class="ac-lang-segmented" role="group" :aria-label="messages.settings.buttonDisplayLabel">
                <button
                  v-for="opt in buttonDisplayOptions"
                  :key="opt.value"
                  class="ac-lang-seg-btn"
                  :class="{ active: buttonDisplayMode === opt.value }"
                  @click="emit('update:buttonDisplayMode', opt.value)"
                >
                  {{ opt.label }}
                </button>
              </div>
            </div>

            <div class="ac-setting-row ac-row-gap-top ac-slider-setting-row">
              <div class="ac-setting-label">{{ messages.settings.globalScaleLabel }}</div>
              <div class="ac-setting-slider-ctrl">
                <MdSlider
                  :model-value="globalScale"
                  :min="0.7"
                  :max="1.5"
                  :step="0.05"
                  width="156px"
                  :format-value="formatPercent"
                  :aria-label="messages.settings.globalScaleLabel"
                  @update:model-value="emit('update:globalScale', $event)"
                />
                <span class="ac-setting-slider-val">{{ formatPercent(globalScale) }}</span>
              </div>
            </div>

            <div class="ac-setting-row ac-row-gap-top ac-slider-setting-row">
              <div class="ac-setting-label">{{ messages.settings.penpaScaleLabel }}</div>
              <div class="ac-setting-slider-ctrl">
                <MdSlider
                  :model-value="penpaScale"
                  :min="0.5"
                  :max="1.25"
                  :step="0.05"
                  width="156px"
                  :format-value="formatPercent"
                  :aria-label="messages.settings.penpaScaleLabel"
                  @update:model-value="emit('update:penpaScale', $event)"
                />
                <span class="ac-setting-slider-val">{{ formatPercent(penpaScale) }}</span>
              </div>
            </div>

            <div class="ac-setting-row ac-row-gap-top ac-slider-setting-row">
              <div class="ac-setting-label">{{ messages.settings.penpaBlurOpacityLabel }}</div>
              <div class="ac-setting-slider-ctrl">
                <MdSlider
                  :model-value="penpaBlurOpacity"
                  :min="0.2"
                  :max="1"
                  :step="0.05"
                  width="156px"
                  :format-value="formatPercent"
                  :aria-label="messages.settings.penpaBlurOpacityLabel"
                  @update:model-value="emit('update:penpaBlurOpacity', $event)"
                />
                <span class="ac-setting-slider-val">{{ formatPercent(penpaBlurOpacity) }}</span>
              </div>
            </div>
          </div>

          <div class="ac-divider" />

          <!-- Section 0.8: Workspace & Visibility Options -->
          <div class="ac-setting-section ac-setting-section-animated">
            <div class="ac-collapse" :class="{ open: showOverlayFullCanvasRow }" :inert="!showOverlayFullCanvasRow">
              <div class="ac-collapse-inner ac-collapse-pad-bottom">
                <div
                  ref="overlayFullCanvasRowEl"
                  class="ac-setting-row ac-setting-row-highlightable"
                  :class="{ 'ac-setting-row-flash': flashingKey === 'overlayFullCanvas' }"
                >
                  <div>
                    <div class="ac-setting-label">{{ messages.settings.overlayFullCanvasLabel }}</div>
                    <div class="ac-setting-desc">{{ messages.settings.overlayFullCanvasDesc }}</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    class="ac-md3-switch"
                    :aria-checked="canOverlayMode && overlayFullCanvas"
                    :aria-label="messages.settings.overlayFullCanvasLabel"
                    :class="{
                      checked: canOverlayMode && overlayFullCanvas,
                      unavailable: !canOverlayMode,
                    }"
                    @click="handleOverlayFullCanvasToggle"
                  >
                    <span class="ac-md3-switch-thumb">
                      <MdIcon
                        v-if="canOverlayMode && overlayFullCanvas"
                        name="check"
                        :size="14"
                        class="ac-md3-switch-check"
                      />
                    </span>
                  </button>
                </div>
              </div>
            </div>

            <div class="ac-collapse" :class="{ open: showMultiMonitorRow }" :inert="!showMultiMonitorRow">
              <div class="ac-collapse-inner ac-collapse-pad-bottom">
                <div class="ac-setting-row">
                  <div>
                    <div class="ac-setting-label">{{ messages.settings.multiMonitorLabel }}</div>
                    <div class="ac-setting-desc">{{ messages.settings.multiMonitorDesc }}</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    class="ac-md3-switch"
                    :aria-checked="canMultiMonitor && multiMonitorEnabled"
                    :aria-label="messages.settings.multiMonitorLabel"
                    :class="{
                      checked: canMultiMonitor && multiMonitorEnabled,
                      unavailable: !canMultiMonitor,
                    }"
                    @click="handleMultiMonitorToggle"
                  >
                    <span class="ac-md3-switch-thumb">
                      <MdIcon
                        v-if="canMultiMonitor && multiMonitorEnabled"
                        name="check"
                        :size="14"
                        class="ac-md3-switch-check"
                      />
                    </span>
                  </button>
                </div>
              </div>
            </div>

            <div class="ac-setting-row">
              <div>
                <div class="ac-setting-label">{{ messages.settings.showUnavailableLabel }}</div>
                <div class="ac-setting-desc">{{ messages.settings.showUnavailableDesc }}</div>
              </div>
              <button
                type="button"
                role="switch"
                class="ac-md3-switch"
                :aria-checked="showUnavailableOptions"
                :aria-label="messages.settings.showUnavailableLabel"
                :class="{ checked: showUnavailableOptions }"
                @click="emit('update:showUnavailableOptions', !showUnavailableOptions)"
              >
                <span class="ac-md3-switch-thumb">
                  <MdIcon
                    v-if="showUnavailableOptions"
                    name="check"
                    :size="14"
                    class="ac-md3-switch-check"
                  />
                </span>
              </button>
            </div>
          </div>

          <!-- Android Compatibility Section: Auto-Composite Overlay onto System Screenshots -->
          <div
            class="ac-collapse ac-section-collapse"
            :class="{ open: showAndroidShotSection }"
            :inert="!showAndroidShotSection"
          >
            <div class="ac-collapse-inner">
              <div class="ac-section-collapse-body">
                <div class="ac-divider" />
                <div class="ac-setting-section">
                  <div class="ac-setting-row">
                    <div>
                      <div class="ac-setting-label">{{ messages.settings.androidShotLabel }}</div>
                      <div class="ac-setting-desc">{{ messages.settings.androidShotDesc }}</div>
                    </div>
                    <button
                      v-if="platform === 'android-overlay'"
                      type="button"
                      role="switch"
                      class="ac-md3-switch"
                      :aria-checked="!!androidScreenshotStatus?.enabled"
                      :aria-label="messages.settings.androidShotLabel"
                      :class="{ checked: !!androidScreenshotStatus?.enabled }"
                      @click="emit('toggle-android-screenshot-composite', !androidScreenshotStatus?.enabled)"
                    >
                      <span class="ac-md3-switch-thumb">
                        <MdIcon
                          v-if="androidScreenshotStatus?.enabled"
                          name="check"
                          :size="14"
                          class="ac-md3-switch-check"
                        />
                      </span>
                    </button>
                    <button
                      v-else
                      type="button"
                      role="switch"
                      class="ac-md3-switch unavailable"
                      aria-checked="false"
                      :aria-label="messages.settings.androidShotLabel"
                      @click="handleAndroidShotUnavailable"
                    >
                      <span class="ac-md3-switch-thumb" />
                    </button>
                  </div>
                  <div
                    class="ac-collapse"
                    :class="{ open: platform === 'android-overlay' && !!androidScreenshotStatus }"
                    :inert="!(platform === 'android-overlay' && !!androidScreenshotStatus)"
                  >
                    <div class="ac-collapse-inner">
                      <div v-if="androidScreenshotStatus" class="ac-setting-actions">
                        <span class="ac-setting-desc">
                          <template v-if="androidScreenshotStatus.enabled">
                            {{
                              androidScreenshotStatus.hasWritePermission
                                ? messages.settings.androidPermGranted
                                : messages.settings.androidPermMissing
                            }}
                          </template>
                          <template v-else-if="!androidScreenshotStatus.hasReadPermission">
                            {{ messages.settings.androidReadMissing }}
                          </template>
                          <template v-else>
                            {{ messages.settings.androidReadReady }}
                          </template>
                        </span>
                        <button
                          v-if="androidScreenshotStatus.enabled && !androidScreenshotStatus.hasWritePermission"
                          class="ac-btn action tonal"
                          @click="emit('request-android-all-files')"
                        >
                          {{ messages.settings.grantPermission }}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="ac-divider" />

          <!-- Section 2: Custom CSS Injection into Penpa+ -->
          <div class="ac-setting-section ac-setting-section-animated">
            <div class="ac-setting-row">
              <div>
                <div class="ac-setting-label">{{ messages.settings.cssLabel }}</div>
                <div class="ac-setting-desc">
                  {{ messages.settings.cssDescBefore }}
                  <code>--md-sys-color-*</code>
                  {{ messages.settings.cssDescAfter }}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                class="ac-md3-switch"
                :aria-checked="customCssEnabled"
                :aria-label="messages.settings.cssLabel"
                :class="{ checked: customCssEnabled }"
                @click="emit('update:customCssEnabled', !customCssEnabled)"
              >
                <span class="ac-md3-switch-thumb">
                  <MdIcon
                    v-if="customCssEnabled"
                    name="check"
                    :size="14"
                    class="ac-md3-switch-check"
                  />
                </span>
              </button>
            </div>

            <div class="ac-collapse" :class="{ open: customCssEnabled }" :inert="!customCssEnabled">
              <div class="ac-collapse-inner ac-collapse-pad-top">
                <div class="ac-css-editor-block">
                  <div class="ac-css-editor-wrap" :class="{ resizing: cssResizing }">
                    <textarea
                      class="ac-css-editor"
                      :style="{ height: `${cssEditorHeight}px` }"
                      :value="cssDraft"
                      spellcheck="false"
                      :placeholder="messages.settings.cssPlaceholder"
                      @input="onCssInput"
                      @keydown="onCssKeyDown"
                      @focus="setAndroidKeyboardFocusable(true)"
                      @blur="setAndroidKeyboardFocusable(false)"
                    />
                    <div
                      class="ac-css-resize-handle"
                      aria-hidden="true"
                      @pointerdown="startCssResize"
                    />
                  </div>

                  <div class="ac-setting-actions">
                    <button class="ac-btn action tonal" @click="resetDefaultCss">
                      {{ messages.settings.cssResetDefault }}
                    </button>
                    <button class="ac-btn action" @click="clearCss">
                      {{ messages.settings.cssClear }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="ac-divider" />

          <!-- Section 3: About & External Links (GitHub & Issues) -->
          <div class="ac-setting-section">
            <div class="ac-setting-row">
              <div class="ac-setting-label">{{ messages.settings.linksLabel }}</div>
              <div class="ac-setting-actions">
                <button class="ac-btn action tonal" @click="handleOpenExternal(GITHUB_REPO_URL)">
                  <span>{{ messages.settings.githubLink }}</span>
                  <MdIcon name="open_in_new" :size="14" />
                </button>
                <button class="ac-btn action" @click="handleOpenExternal(GITHUB_ISSUES_URL)">
                  <span>{{ messages.settings.issueLink }}</span>
                  <MdIcon name="open_in_new" :size="14" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
/* Dialog open / close MD3 emphasized transition */
.ac-settings-modal-enter-active,
.ac-settings-modal-leave-active {
  transition: opacity 0.2s cubic-bezier(0.2, 0, 0, 1);
}

.ac-settings-modal-enter-active .ac-settings-card,
.ac-settings-modal-leave-active .ac-settings-card {
  transition:
    transform 0.24s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.2s cubic-bezier(0.2, 0, 0, 1);
}

.ac-settings-modal-enter-from,
.ac-settings-modal-leave-to {
  opacity: 0;
}

.ac-settings-modal-enter-from .ac-settings-card,
.ac-settings-modal-leave-to .ac-settings-card {
  transform: scale(calc(var(--ac-ui-scale, 1) * 0.96)) translateY(8px);
  opacity: 0;
}

.ac-settings-backdrop {
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

.ac-settings-card {
  width: min(560px, calc((100vw - 32px) / var(--ac-ui-scale, 1)));
  max-height: calc(min(84vh, 680px) / var(--ac-ui-scale, 1));
  transform: scale(var(--ac-ui-scale, 1));
  transform-origin: center center;
  display: flex;
  flex-direction: column;
  border-radius: 20px;
  overflow: hidden;
  background: var(--md-sys-color-surface-container);
  border: 1px solid var(--md-sys-color-outline-variant);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.56);
  color: var(--md-sys-color-on-surface);
}

.ac-settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--md-sys-color-surface-container-high);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.ac-settings-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface);
}

.ac-settings-body {
  padding: 14px 16px 16px;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ac-setting-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ac-setting-section-animated {
  gap: 0;
}

.ac-row-gap-top {
  margin-top: 10px;
}

/* Smooth MD3 height + opacity collapse/expand for dynamic settings rows & sections */
.ac-collapse {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  pointer-events: none;
  transition:
    grid-template-rows 0.24s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.18s cubic-bezier(0.2, 0, 0, 1);
}

.ac-collapse.open {
  grid-template-rows: 1fr;
  opacity: 1;
  pointer-events: auto;
}

.ac-collapse-inner {
  overflow: hidden;
  min-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  transition:
    padding-top 0.24s cubic-bezier(0.2, 0, 0, 1),
    padding-bottom 0.24s cubic-bezier(0.2, 0, 0, 1);
}

.ac-collapse.open > .ac-collapse-pad-top {
  padding-top: 10px;
}

.ac-collapse.open > .ac-collapse-pad-bottom {
  padding-bottom: 10px;
}

/* Collapse section inside .ac-settings-body (gap: 14px) without leaving extra gap when closed */
.ac-section-collapse {
  margin-top: -14px;
  transition:
    grid-template-rows 0.24s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.18s cubic-bezier(0.2, 0, 0, 1),
    margin-top 0.24s cubic-bezier(0.2, 0, 0, 1);
}

.ac-section-collapse.open {
  margin-top: 0;
}

.ac-section-collapse-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ac-setting-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 12px;
}

.ac-setting-row-highlightable {
  padding: 6px 8px;
  margin: -6px -8px;
  border-radius: 12px;
}

.ac-setting-row-flash {
  animation: ac-setting-attention-pulse 0.6s cubic-bezier(0.2, 0, 0, 1) 3;
}

@keyframes ac-setting-attention-pulse {
  0%,
  100% {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px transparent;
  }
  45% {
    background: color-mix(in srgb, var(--md-sys-color-primary-container) 78%, transparent);
    box-shadow: inset 0 0 0 1.5px var(--md-sys-color-primary);
  }
}

.ac-setting-row > div:first-child {
  flex: 1 1 220px;
  min-width: 0;
}

.ac-hue-row {
  padding-top: 2px;
  align-items: center;
}

.ac-slider-setting-row {
  align-items: center;
}

.ac-setting-slider-ctrl {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.ac-setting-slider-val {
  min-width: 40px;
  text-align: right;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--md-sys-color-on-surface-variant);
}

.ac-lang-segmented {
  display: inline-flex;
  align-items: stretch;
  height: 30px;
  border-radius: 999px;
  border: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-high);
  overflow: hidden;
  flex-shrink: 0;
}

.ac-lang-seg-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 0 12px;
  border: none;
  border-right: 1px solid var(--md-sys-color-outline-variant);
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.16s cubic-bezier(0.2, 0, 0, 1), color 0.16s cubic-bezier(0.2, 0, 0, 1);
}

.ac-lang-seg-btn:last-child {
  border-right: none;
}

@media (hover: hover) {
  .ac-lang-seg-btn:hover {
    background: var(--md-sys-color-surface-container-highest);
    color: var(--md-sys-color-on-surface);
  }
}

.ac-lang-seg-btn.active {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  font-weight: 600;
}

/* Authentic Material Design 3 Switch */
.ac-md3-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  width: 48px;
  height: 28px;
  padding: 0;
  border-radius: 999px;
  border: 2px solid var(--md-sys-color-outline);
  background: var(--md-sys-color-surface-container-highest);
  cursor: pointer;
  transition:
    background-color 0.18s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.18s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.18s ease;
}

.ac-md3-switch-thumb {
  position: absolute;
  left: 5px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--md-sys-color-outline);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    transform 0.2s cubic-bezier(0.2, 0, 0, 1),
    width 0.18s cubic-bezier(0.2, 0, 0, 1),
    height 0.18s cubic-bezier(0.2, 0, 0, 1),
    background-color 0.18s cubic-bezier(0.2, 0, 0, 1),
    box-shadow 0.15s ease;
}

@media (hover: hover) {
  .ac-md3-switch:hover .ac-md3-switch-thumb {
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent);
  }
  .ac-md3-switch.checked:hover .ac-md3-switch-thumb {
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--md-sys-color-primary) 16%, transparent);
  }
}

.ac-md3-switch:active .ac-md3-switch-thumb {
  width: 20px;
  height: 20px;
}

.ac-md3-switch.checked {
  background: var(--md-sys-color-primary);
  border-color: var(--md-sys-color-primary);
}

.ac-md3-switch.checked .ac-md3-switch-thumb {
  width: 20px;
  height: 20px;
  transform: translateX(17px);
  background: var(--md-sys-color-on-primary);
}

.ac-md3-switch-check {
  color: var(--md-sys-color-on-primary-container);
}

.ac-md3-switch.unavailable {
  opacity: 0.45;
  border-style: dashed;
  cursor: help;
}

.ac-setting-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface);
}

.ac-setting-desc {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--md-sys-color-on-surface-variant);
}

.ac-setting-desc code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-primary);
}

.ac-setting-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.ac-divider {
  height: 1px;
  flex-shrink: 0;
  background: var(--md-sys-color-outline-variant);
}

.ac-css-editor-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ac-css-editor-wrap {
  position: relative;
  width: 100%;
  border-radius: 12px;
  border: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
  overflow: hidden;
  transition: border-color 0.16s ease;
}

.ac-css-editor-wrap:focus-within,
.ac-css-editor-wrap.resizing {
  border-color: var(--md-sys-color-primary);
}

.ac-css-editor {
  display: block;
  width: 100%;
  min-height: 120px;
  max-height: 480px;
  resize: none;
  padding: 10px 12px 16px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--md-sys-color-on-surface);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  outline: none;
  overscroll-behavior: contain;
  user-select: text;
  -webkit-user-select: text;
  touch-action: pan-y;
}

.ac-css-editor::-webkit-resizer {
  display: none;
}

.ac-css-editor::-webkit-scrollbar-corner {
  background: transparent;
}

.ac-css-editor:disabled {
  opacity: 0.5;
}

/* MD3 themed bottom-right resize grip for multiline CSS editor (works on mouse & touch) */
.ac-css-resize-handle {
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 16px;
  height: 16px;
  border-bottom-right-radius: 8px;
  cursor: ns-resize;
  touch-action: none;
  background: linear-gradient(
    135deg,
    transparent 44%,
    var(--md-sys-color-outline) 44%,
    var(--md-sys-color-outline) 54%,
    transparent 54%,
    transparent 70%,
    var(--md-sys-color-outline) 70%,
    var(--md-sys-color-outline) 80%,
    transparent 80%
  );
  opacity: 0.72;
  transition: opacity 0.15s ease, background 0.15s ease;
}

@media (hover: hover) {
  .ac-css-resize-handle:hover {
    opacity: 1;
    background: linear-gradient(
      135deg,
      transparent 44%,
      var(--md-sys-color-primary) 44%,
      var(--md-sys-color-primary) 54%,
      transparent 54%,
      transparent 70%,
      var(--md-sys-color-primary) 70%,
      var(--md-sys-color-primary) 80%,
      transparent 80%
    );
  }
}

.ac-css-editor-wrap.resizing .ac-css-resize-handle {
  opacity: 1;
  background: linear-gradient(
    135deg,
    transparent 44%,
    var(--md-sys-color-primary) 44%,
    var(--md-sys-color-primary) 54%,
    transparent 54%,
    transparent 70%,
    var(--md-sys-color-primary) 70%,
    var(--md-sys-color-primary) 80%,
    transparent 80%
  );
}

.ac-css-editor::-webkit-scrollbar,
.ac-settings-body::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.ac-css-editor::-webkit-scrollbar-track,
.ac-settings-body::-webkit-scrollbar-track {
  background: transparent;
}

.ac-css-editor::-webkit-scrollbar-thumb,
.ac-settings-body::-webkit-scrollbar-thumb {
  background: var(--md-sys-color-outline-variant);
  border-radius: 999px;
}

.ac-css-editor::-webkit-scrollbar-thumb:hover,
.ac-settings-body::-webkit-scrollbar-thumb:hover {
  background: var(--md-sys-color-outline);
}
</style>
