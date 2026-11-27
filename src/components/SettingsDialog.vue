<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  DEFAULT_TOGGLE_HOTKEY,
  formatHotkeyLabel,
  keyboardEventToHotkey,
  type HotkeyBinding,
} from '../core/hotkey';
import { DEFAULT_PENPA_MD3_CSS } from '../core/defaultPenpaCss';
import HueRingPicker from './HueRingPicker.vue';
import MdIcon from './MdIcon.vue';
import type { UnavailableReasonKey } from './ControlBar.vue';
import {
  openExternalLink,
  setAndroidKeyboardFocusable,
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
  formatMessage,
  LOCALE_OPTIONS,
  messages,
  setLocale,
  type AppLocale,
} from '../core/i18n';

const GITHUB_REPO_URL = 'https://github.com/KoolShow/PenpaAnywhere';
const GITHUB_ISSUES_URL = 'https://github.com/KoolShow/PenpaAnywhere/issues';

const props = defineProps<{
  open: boolean;
  platform: RuntimePlatform;
  customCssEnabled: boolean;
  customCss: string;
  toggleHotkey: HotkeyBinding | null;
  buttonDisplayMode: ButtonDisplayMode;
  overlayFullCanvas: boolean;
  showUnavailableOptions: boolean;
  androidScreenshotStatus?: AndroidScreenshotCompositeStatus | null;
}>();

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'update:customCssEnabled', v: boolean): void;
  (e: 'update:customCss', v: string): void;
  (e: 'update:toggleHotkey', v: HotkeyBinding | null): void;
  (e: 'update:buttonDisplayMode', v: ButtonDisplayMode): void;
  (e: 'update:overlayFullCanvas', v: boolean): void;
  (e: 'update:showUnavailableOptions', v: boolean): void;
  (e: 'unavailable-click', key: UnavailableReasonKey): void;
  (e: 'toggle-android-screenshot-composite', enabled: boolean): void;
  (e: 'request-android-all-files'): void;
  (e: 'recording-change', recording: boolean): void;
}>();

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

function handleAndroidShotUnavailable() {
  emit('unavailable-click', 'androidShotUnavailable');
}

function handleOpenExternal(url: string) {
  void openExternalLink(url);
}

type RecordHintState =
  | null
  | { kind: 'prompt' | 'cancelled' | 'needModifier' | 'cleared' }
  | { kind: 'bound' | 'resetDone'; label: string };

const recording = ref(false);
const recordStatus = ref<RecordHintState>(null);
const cssDraft = ref(props.customCss);

const recordHintText = computed(() => {
  const s = recordStatus.value;
  if (!s) return '';
  const m = messages.value.settings;
  switch (s.kind) {
    case 'prompt':
      return m.hotkeyPrompt;
    case 'cancelled':
      return m.hotkeyCancelled;
    case 'needModifier':
      return m.hotkeyNeedModifier;
    case 'cleared':
      return m.hotkeyCleared;
    case 'bound':
      return formatMessage(m.hotkeyBound, { label: s.label });
    case 'resetDone':
      return formatMessage(m.hotkeyResetDone, { label: s.label });
  }
});

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
      stopRecording();
      setAndroidKeyboardFocusable(false);
    } else {
      cssDraft.value = props.customCss;
      recordStatus.value = null;
    }
  },
);

const hotkeyText = computed(() =>
  formatHotkeyLabel(props.toggleHotkey, messages.value.settings.hotkeyUnbound),
);

const shortcutRows = computed<Array<{ action: string; keys: string }>>(() => {
  const s = messages.value.settings;
  return [
    { action: s.scTogglePassThrough, keys: hotkeyText.value },
    { action: s.scPasteImage, keys: s.scPasteImageKey },
    { action: s.scMultiSelect, keys: s.scMultiSelectKey },
    { action: s.scDeleteSelected, keys: s.scDeleteSelectedKey },
    { action: s.scPanCanvas, keys: s.scPanCanvasKey },
    { action: s.scZoomCanvas, keys: s.scZoomCanvasKey },
    { action: s.scAspectResize, keys: s.scAspectResizeKey },
    { action: s.scCenterResize, keys: s.scCenterResizeKey },
    { action: s.scDoubleClickCrop, keys: s.scDoubleClickCropKey },
    { action: s.scEscape, keys: s.scEscapeKey },
  ];
});

function selectLanguage(loc: AppLocale) {
  setLocale(loc);
}

function closeDialog() {
  stopRecording();
  emit('update:open', false);
}

function startRecording() {
  recording.value = true;
  recordStatus.value = { kind: 'prompt' };
  emit('recording-change', true);
  window.addEventListener('keydown', onRecordKeyDown, true);
}

function stopRecording() {
  if (!recording.value) return;
  recording.value = false;
  emit('recording-change', false);
  window.removeEventListener('keydown', onRecordKeyDown, true);
}

function onRecordKeyDown(e: KeyboardEvent) {
  e.preventDefault();
  e.stopPropagation();

  if (e.code === 'Escape') {
    recordStatus.value = { kind: 'cancelled' };
    stopRecording();
    return;
  }

  // Ignore bare modifier press while waiting for main key
  if (
    e.code.startsWith('Control') ||
    e.code.startsWith('Shift') ||
    e.code.startsWith('Alt') ||
    e.code.startsWith('Meta')
  ) {
    return;
  }

  const parsed = keyboardEventToHotkey(e);
  if (!parsed) {
    recordStatus.value = { kind: 'needModifier' };
    return;
  }

  emit('update:toggleHotkey', parsed);
  recordStatus.value = { kind: 'bound', label: parsed.label };
  stopRecording();
}

function resetDefaultHotkey() {
  stopRecording();
  emit('update:toggleHotkey', { ...DEFAULT_TOGGLE_HOTKEY });
  recordStatus.value = { kind: 'resetDone', label: DEFAULT_TOGGLE_HOTKEY.label };
}

function clearHotkey() {
  stopRecording();
  emit('update:toggleHotkey', null);
  recordStatus.value = { kind: 'cleared' };
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
  stopRecording();
});
</script>

<template>
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
        <div class="ac-setting-section">
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

          <div
            v-if="dynamicColorSupported || showUnavailableOptions"
            class="ac-setting-row"
          >
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

          <div v-if="!dynamicColorEnabled || !dynamicColorSupported" class="ac-setting-row ac-hue-row">
            <div class="ac-setting-label">{{ messages.settings.hueLabel }}</div>
            <HueRingPicker :model-value="customHue" @update:model-value="setCustomHue" />
          </div>

          <div class="ac-setting-row">
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
        </div>

        <div class="ac-divider" />

        <!-- Section 0.8: Workspace & Visibility Options -->
        <div class="ac-setting-section">
          <div class="ac-setting-row">
            <div>
              <div class="ac-setting-label">{{ messages.settings.overlayFullCanvasLabel }}</div>
              <div class="ac-setting-desc">{{ messages.settings.overlayFullCanvasDesc }}</div>
            </div>
            <button
              type="button"
              role="switch"
              class="ac-md3-switch"
              :aria-checked="overlayFullCanvas"
              :aria-label="messages.settings.overlayFullCanvasLabel"
              :class="{ checked: overlayFullCanvas }"
              @click="emit('update:overlayFullCanvas', !overlayFullCanvas)"
            >
              <span class="ac-md3-switch-thumb">
                <MdIcon
                  v-if="overlayFullCanvas"
                  name="check"
                  :size="14"
                  class="ac-md3-switch-check"
                />
              </span>
            </button>
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

        <div class="ac-divider" />

        <!-- Section 1: Click-through Toggle Hotkey -->
        <div class="ac-setting-section">
          <div class="ac-setting-row">
            <div class="ac-setting-label">{{ messages.settings.hotkeyLabel }}</div>
            <span class="ac-hotkey-pill" :class="{ recording }">
              {{ recording ? messages.settings.hotkeyRecordingPill : hotkeyText }}
            </span>
          </div>

          <div class="ac-setting-actions">
            <button
              class="ac-btn"
              :class="{ active: recording }"
              @click="recording ? stopRecording() : startRecording()"
            >
              {{ recording ? messages.settings.hotkeyCancelBtn : messages.settings.hotkeyRecordBtn }}
            </button>
            <button class="ac-btn action" @click="resetDefaultHotkey">
              {{ messages.settings.hotkeyResetBtn }}
            </button>
            <button class="ac-btn action" @click="clearHotkey">
              {{ messages.settings.hotkeyClearBtn }}
            </button>
          </div>

          <div v-if="recordHintText" class="ac-setting-hint">{{ recordHintText }}</div>
        </div>

        <!-- Android Compatibility Section: Auto-Composite Overlay onto System Screenshots -->
        <template v-if="platform === 'android-overlay' || showUnavailableOptions">
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
            <div v-if="platform === 'android-overlay' && androidScreenshotStatus" class="ac-setting-actions">
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
        </template>

        <div class="ac-divider" />

        <!-- Section 2: Custom CSS Injection into Penpa+ -->
        <div class="ac-setting-section">
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

          <template v-if="customCssEnabled">
            <textarea
              class="ac-css-editor"
              :value="cssDraft"
              spellcheck="false"
              :placeholder="messages.settings.cssPlaceholder"
              @input="onCssInput"
              @keydown="onCssKeyDown"
              @focus="setAndroidKeyboardFocusable(true)"
              @blur="setAndroidKeyboardFocusable(false)"
            />

            <div class="ac-setting-actions">
              <button class="ac-btn action tonal" @click="resetDefaultCss">
                {{ messages.settings.cssResetDefault }}
              </button>
              <button class="ac-btn action" @click="clearCss">
                {{ messages.settings.cssClear }}
              </button>
            </div>
          </template>
        </div>

        <div class="ac-divider" />

        <!-- Section 2.5: Shortcut Reference Table -->
        <div class="ac-setting-section">
          <div class="ac-setting-label">{{ messages.settings.shortcutsTitle }}</div>
          <table class="ac-shortcuts-table">
            <tbody>
              <tr v-for="row in shortcutRows" :key="row.action">
                <td class="ac-sc-action">{{ row.action }}</td>
                <td class="ac-sc-keys">
                  <kbd class="ac-kbd">{{ row.keys }}</kbd>
                </td>
              </tr>
            </tbody>
          </table>
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
</template>

<style scoped>
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
  width: min(560px, 100%);
  max-height: min(82vh, 640px);
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
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ac-setting-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ac-setting-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 12px;
}

.ac-setting-row > div:first-child {
  flex: 1 1 220px;
  min-width: 0;
}

.ac-hue-row {
  padding-top: 4px;
  align-items: center;
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
  transition: background 0.15s ease, color 0.15s ease;
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
    border-color 0.18s cubic-bezier(0.2, 0, 0, 1);
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

.ac-hotkey-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--md-sys-color-surface-container-highest);
  border: 1px solid var(--md-sys-color-outline-variant);
  color: var(--md-sys-color-primary);
}

.ac-shortcuts-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0 4px;
}

.ac-shortcuts-table td {
  padding: 5px 10px;
  background: var(--md-sys-color-surface-container-low);
  border-top: 1px solid var(--md-sys-color-outline-variant);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  vertical-align: middle;
}

.ac-shortcuts-table td:first-child {
  border-left: 1px solid var(--md-sys-color-outline-variant);
  border-top-left-radius: 9px;
  border-bottom-left-radius: 9px;
}

.ac-shortcuts-table td:last-child {
  border-right: 1px solid var(--md-sys-color-outline-variant);
  border-top-right-radius: 9px;
  border-bottom-right-radius: 9px;
}

.ac-sc-action {
  font-size: 12px;
  color: var(--md-sys-color-on-surface);
}

.ac-sc-keys {
  width: 1%;
  text-align: right;
  white-space: nowrap;
}

.ac-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--md-sys-color-surface-container-highest);
  border: 1px solid var(--md-sys-color-outline-variant);
  color: var(--md-sys-color-primary);
}

.ac-hotkey-pill.recording {
  background: var(--md-sys-color-primary-container);
  border-color: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary-container);
}

.ac-setting-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.ac-setting-hint {
  font-size: 11px;
  color: var(--md-sys-color-primary);
}

.ac-divider {
  height: 1px;
  background: var(--md-sys-color-outline-variant);
}

.ac-css-editor {
  width: 100%;
  min-height: 220px;
  max-height: 320px;
  resize: vertical;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
  color: var(--md-sys-color-on-surface);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  outline: none;
  user-select: text;
  -webkit-user-select: text;
  touch-action: pan-y;
}

.ac-css-editor:focus {
  border-color: var(--md-sys-color-primary);
}

.ac-css-editor:disabled {
  opacity: 0.5;
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
