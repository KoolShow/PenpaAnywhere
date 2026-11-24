<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  DEFAULT_TOGGLE_HOTKEY,
  formatHotkeyLabel,
  keyboardEventToHotkey,
  type HotkeyBinding,
} from '../core/hotkey';
import { DEFAULT_PENPA_MD3_CSS } from '../core/defaultPenpaCss';
import { setAndroidKeyboardFocusable, type RuntimePlatform } from '../core/platform';

const props = defineProps<{
  open: boolean;
  platform: RuntimePlatform;
  customCssEnabled: boolean;
  customCss: string;
  toggleHotkey: HotkeyBinding | null;
}>();

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'update:customCssEnabled', v: boolean): void;
  (e: 'update:customCss', v: string): void;
  (e: 'update:toggleHotkey', v: HotkeyBinding | null): void;
  (e: 'recording-change', recording: boolean): void;
}>();

const recording = ref(false);
const recordHint = ref('');
const cssDraft = ref(props.customCss);

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
      recordHint.value = '';
    }
  },
);

const hotkeyText = computed(() => formatHotkeyLabel(props.toggleHotkey));

function closeDialog() {
  stopRecording();
  emit('update:open', false);
}

function startRecording() {
  recording.value = true;
  recordHint.value = '请按下快捷键组合（支持 Ctrl/Alt/Shift/Win + 键，或单独 F1-F12 / `），Esc 取消';
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
    recordHint.value = '已取消录制';
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
    recordHint.value = '普通字母/数字请搭配 Ctrl、Alt 或 Shift 使用（功能键 F1-F12 可单键绑定）';
    return;
  }

  emit('update:toggleHotkey', parsed);
  recordHint.value = `已绑定：${parsed.label}`;
  stopRecording();
}

function resetDefaultHotkey() {
  stopRecording();
  emit('update:toggleHotkey', { ...DEFAULT_TOGGLE_HOTKEY });
  recordHint.value = `已恢复默认：${DEFAULT_TOGGLE_HOTKEY.label}`;
}

function clearHotkey() {
  stopRecording();
  emit('update:toggleHotkey', null);
  recordHint.value = '已清除穿透切换快捷键';
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
    <section class="ac-settings-card" role="dialog" aria-modal="true" aria-label="PenpaAnywhere 设置">
      <header class="ac-settings-header">
        <div class="ac-settings-title">设置</div>
        <button class="ac-btn" @click="closeDialog">关闭</button>
      </header>

      <div class="ac-settings-body">
        <!-- Section 1: Click-through Toggle Hotkey -->
        <div class="ac-setting-section">
          <div class="ac-setting-row">
            <div>
              <div class="ac-setting-label">切换穿透快捷键</div>
              <div class="ac-setting-desc">
                {{
                  platform === 'tauri'
                    ? '全局生效，穿透锁定时也可直接按快捷键恢复交互'
                    : '窗口聚焦时或外接键盘按下可切换题板穿透'
                }}
              </div>
            </div>
            <span class="ac-hotkey-pill" :class="{ recording }">
              {{ recording ? '按键中...' : hotkeyText }}
            </span>
          </div>

          <div class="ac-setting-actions">
            <button
              class="ac-btn"
              :class="{ active: recording }"
              @click="recording ? stopRecording() : startRecording()"
            >
              {{ recording ? '取消录制' : '录制快捷键' }}
            </button>
            <button class="ac-btn" @click="resetDefaultHotkey">恢复默认</button>
            <button class="ac-btn" @click="clearHotkey">清除</button>
          </div>

          <div v-if="recordHint" class="ac-setting-hint">{{ recordHint }}</div>
        </div>

        <div class="ac-divider" />

        <!-- Section 2: Custom CSS Injection into Penpa+ -->
        <div class="ac-setting-section">
          <div class="ac-setting-row">
            <div>
              <div class="ac-setting-label">注入 Penpa+ 自定义 CSS</div>
              <div class="ac-setting-desc">
                实时注入到 Penpa+ 工具窗内，支持直接引用宿主
                <code>--md-sys-color-*</code> 动态主题变量
              </div>
            </div>
            <button
              class="ac-btn"
              :class="{ active: customCssEnabled }"
              @click="emit('update:customCssEnabled', !customCssEnabled)"
            >
              {{ customCssEnabled ? '已启用' : '已关闭' }}
            </button>
          </div>

          <textarea
            class="ac-css-editor"
            :value="cssDraft"
            :disabled="!customCssEnabled"
            spellcheck="false"
            placeholder="在此输入要注入到 Penpa+ 工具栏的 CSS..."
            @input="onCssInput"
            @keydown="onCssKeyDown"
            @focus="setAndroidKeyboardFocusable(true)"
            @blur="setAndroidKeyboardFocusable(false)"
          />

          <div class="ac-setting-actions">
            <button class="ac-btn tonal" @click="resetDefaultCss">恢复默认 MD3 样式</button>
            <button class="ac-btn" @click="clearCss">清空</button>
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
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: color-mix(in srgb, var(--md-sys-color-scrim) 52%, transparent);
  backdrop-filter: blur(4px);
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
  align-items: center;
  justify-content: space-between;
  gap: 12px;
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
  flex-shrink: 0;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
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
