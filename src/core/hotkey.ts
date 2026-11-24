export interface HotkeyBinding {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** Standard KeyboardEvent.code, e.g. 'KeyT', 'F8', 'Backquote' */
  code: string;
  /** Display label, e.g. 'Ctrl + Shift + T' */
  label: string;
}

export const DEFAULT_TOGGLE_HOTKEY: HotkeyBinding = {
  ctrl: true,
  shift: true,
  alt: false,
  meta: false,
  code: 'KeyT',
  label: 'Ctrl + Shift + T',
};

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

const SPECIAL_CODE_LABELS: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  Tab: 'Tab',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Pause: 'Pause',
  ScrollLock: 'ScrollLock',
};

export function isSupportedHotkeyCode(code: string): boolean {
  if (!code || MODIFIER_CODES.has(code)) return false;
  if (/^Key[A-Z]$/.test(code)) return true;
  if (/^Digit[0-9]$/.test(code)) return true;
  if (/^F([1-9]|1[0-2])$/.test(code)) return true;
  if (/^Numpad[0-9]$/.test(code)) return true;
  return code in SPECIAL_CODE_LABELS;
}

export function formatCodeName(code: string): string {
  if (/^Key([A-Z])$/.test(code)) return code.slice(3);
  if (/^Digit([0-9])$/.test(code)) return code.slice(5);
  if (/^Numpad([0-9])$/.test(code)) return `Num${code.slice(6)}`;
  return SPECIAL_CODE_LABELS[code] || code;
}

export function formatHotkeyLabel(hk: Omit<HotkeyBinding, 'label'> | null | undefined): string {
  if (!hk || !hk.code) return '未绑定';
  const parts: string[] = [];
  if (hk.ctrl) parts.push('Ctrl');
  if (hk.alt) parts.push('Alt');
  if (hk.shift) parts.push('Shift');
  if (hk.meta) parts.push('Meta');
  parts.push(formatCodeName(hk.code));
  return parts.join(' + ');
}

export function keyboardEventToHotkey(e: KeyboardEvent): HotkeyBinding | null {
  if (!isSupportedHotkeyCode(e.code)) return null;
  const base = {
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
    code: e.code,
  };
  // Single non-function letter/digit keys without any modifier conflict with Penpa+ input;
  // allow bare F1-F12 / Pause / ScrollLock / Insert / Backquote, require modifier otherwise.
  const hasModifier = base.ctrl || base.shift || base.alt || base.meta;
  const allowBare =
    /^F([1-9]|1[0-2])$/.test(e.code) ||
    e.code === 'Pause' ||
    e.code === 'ScrollLock' ||
    e.code === 'Insert' ||
    e.code === 'Backquote';
  if (!hasModifier && !allowBare) {
    return null;
  }
  return {
    ...base,
    label: formatHotkeyLabel(base),
  };
}

export function matchesHotkey(e: KeyboardEvent, hk: HotkeyBinding | null | undefined): boolean {
  if (!hk || !hk.code) return false;
  return (
    e.code === hk.code &&
    e.ctrlKey === hk.ctrl &&
    e.shiftKey === hk.shift &&
    e.altKey === hk.alt &&
    e.metaKey === hk.meta
  );
}
