import { ref } from 'vue';

export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const safeAreaInsets = ref<SafeAreaInsets>({
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
});

let nativeOverrideActive = false;

function sanitizeInset(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 400 ? Math.round(v) : 0;
}

function applyInsetsToDom(insets: SafeAreaInsets) {
  if (typeof document === 'undefined') return;
  const s = document.documentElement.style;
  s.setProperty('--ac-safe-top', `${insets.top}px`);
  s.setProperty('--ac-safe-right', `${insets.right}px`);
  s.setProperty('--ac-safe-bottom', `${insets.bottom}px`);
  s.setProperty('--ac-safe-left', `${insets.left}px`);
}

export function applySafeAreaInsets(raw: Partial<SafeAreaInsets> | string | null | undefined, fromNative = false): void {
  if (!raw) return;
  let obj: Partial<SafeAreaInsets>;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw) as Partial<SafeAreaInsets>;
    } catch {
      return;
    }
  } else {
    obj = raw;
  }
  if (fromNative) {
    nativeOverrideActive = true;
  }
  const next: SafeAreaInsets = {
    top: sanitizeInset(obj.top),
    right: sanitizeInset(obj.right),
    bottom: sanitizeInset(obj.bottom),
    left: sanitizeInset(obj.left),
  };
  const prev = safeAreaInsets.value;
  if (
    prev.top !== next.top ||
    prev.right !== next.right ||
    prev.bottom !== next.bottom ||
    prev.left !== next.left
  ) {
    safeAreaInsets.value = next;
  }
  applyInsetsToDom(next);
}

/**
 * Fallback probe for standard Web / iOS Safari browsers using CSS env(safe-area-inset-*).
 */
function readCssEnvSafeArea(): SafeAreaInsets {
  if (typeof document === 'undefined' || !document.body) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;z-index:-1;' +
    'padding-top:env(safe-area-inset-top,0px);' +
    'padding-right:env(safe-area-inset-right,0px);' +
    'padding-bottom:env(safe-area-inset-bottom,0px);' +
    'padding-left:env(safe-area-inset-left,0px);';
  document.body.appendChild(probe);
  const cs = window.getComputedStyle(probe);
  const res: SafeAreaInsets = {
    top: sanitizeInset(parseFloat(cs.paddingTop)),
    right: sanitizeInset(parseFloat(cs.paddingRight)),
    bottom: sanitizeInset(parseFloat(cs.paddingBottom)),
    left: sanitizeInset(parseFloat(cs.paddingLeft)),
  };
  document.body.removeChild(probe);
  return res;
}

export function initSafeAreaBridge(): void {
  if (typeof window === 'undefined') return;

  window.__PENPAANYWHERE_APPLY_SAFE_INSETS__ = (raw) => {
    applySafeAreaInsets(raw, true);
  };

  // 1. Synchronous read from Android native bridge if available
  try {
    const nativeRaw = window.AndroidOverlay?.getSafeAreaInsets?.();
    if (nativeRaw) {
      applySafeAreaInsets(nativeRaw, true);
      return;
    }
  } catch {
    // ignore
  }

  // 2. Tauri Desktop (Windows / macOS): read work-area taskbar/dock insets & subscribe to updates
  if (window.__TAURI_INTERNALS__) {
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const initial = await invoke<SafeAreaInsets>('get_safe_area_insets');
        if (initial) {
          applySafeAreaInsets(initial, true);
        }
      } catch {
        // ignore if command unavailable
      }
      try {
        const { listen } = await import('@tauri-apps/api/event');
        await listen<SafeAreaInsets>('safe-area-insets-changed', (ev) => {
          if (ev.payload) {
            applySafeAreaInsets(ev.payload, true);
          }
        });
      } catch {
        // ignore if listener unavailable
      }
    })();
    return;
  }

  // 3. Fallback to CSS env(safe-area-inset-*) on Web / mobile browsers
  const refreshEnv = () => {
    if (nativeOverrideActive) return;
    applySafeAreaInsets(readCssEnvSafeArea(), false);
  };
  if (document.body) {
    refreshEnv();
  } else {
    window.addEventListener('DOMContentLoaded', refreshEnv, { once: true });
  }
  window.addEventListener('resize', refreshEnv);
  window.addEventListener('orientationchange', refreshEnv);
}
