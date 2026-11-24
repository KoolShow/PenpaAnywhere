export type RuntimePlatform = 'tauri' | 'android-overlay' | 'android-app' | 'web';

interface AndroidOverlayInterface {
  isOverlayMode?: () => boolean;
  setClickThrough?: (enabled: boolean) => void;
  setFocusable?: (focusable: boolean) => void;
  updateHitRegions?: (payloadJson: string) => void;
  getDynamicColorTokens?: () => string;
  closeOverlay?: () => void;
  pickImage?: () => void;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    AndroidOverlay?: AndroidOverlayInterface;
    __PENPAANYWHERE_ON_ANDROID_IMAGE__?: (dataUrl: string) => void;
    __PENPAANYWHERE_ON_CLICK_THROUGH__?: (enabled: boolean) => void;
    __PENPAANYWHERE_APPLY_MD3_TOKENS__?: (tokens: Record<string, string> | string) => void;
    __PENPAANYWHERE_FLUSH_STORAGE__?: () => void;
  }
}

export function detectPlatform(): RuntimePlatform {
  if (typeof window === 'undefined') return 'web';
  if (window.__TAURI_INTERNALS__) return 'tauri';
  if (window.AndroidOverlay) {
    try {
      return window.AndroidOverlay.isOverlayMode?.() ? 'android-overlay' : 'android-app';
    } catch {
      return 'android-app';
    }
  }
  return 'web';
}

export function supportsNativeTransparentOverlay(platform: RuntimePlatform): boolean {
  return platform === 'tauri' || platform === 'android-overlay';
}

export function supportsScreenCapture(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function'
  );
}

let lastIgnoreCursorState: boolean | null = null;

/**
 * Enable or disable OS-level click-through on Windows (Tauri 2) and Android (Overlay WebView).
 */
export async function setOsClickThrough(ignore: boolean): Promise<void> {
  if (lastIgnoreCursorState === ignore) return;
  lastIgnoreCursorState = ignore;

  const platform = detectPlatform();
  if (platform === 'tauri') {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_click_through', { ignore });
    } catch (err) {
      console.warn('[PenpaAnywhere] Tauri set_click_through failed:', err);
    }
  } else if (platform === 'android-overlay') {
    try {
      window.AndroidOverlay?.setClickThrough?.(ignore);
    } catch (err) {
      console.warn('[PenpaAnywhere] Android setClickThrough failed:', err);
    }
  }
}

export async function setOsAlwaysOnTop(alwaysOnTop: boolean): Promise<void> {
  if (detectPlatform() !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_always_on_top', { alwaysOnTop });
  } catch (err) {
    console.warn('[PenpaAnywhere] Tauri set_always_on_top failed:', err);
  }
}

export async function setOsFullscreenOverlay(overlay: boolean): Promise<void> {
  if (detectPlatform() !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_overlay_window_mode', { overlay });
  } catch (err) {
    console.warn('[PenpaAnywhere] Tauri set_overlay_window_mode failed:', err);
  }
}

export async function setAndroidKeyboardFocusable(focusable: boolean): Promise<void> {
  if (detectPlatform() !== 'android-overlay') return;
  try {
    window.AndroidOverlay?.setFocusable?.(focusable);
  } catch (err) {
    console.warn('[PenpaAnywhere] Android setFocusable failed:', err);
  }
}

export async function closeOverlayApp(): Promise<void> {
  const platform = detectPlatform();
  if (platform === 'tauri') {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('close_app');
    } catch (err) {
      console.warn('[PenpaAnywhere] Tauri close_app failed:', err);
    }
  } else if (platform === 'android-overlay') {
    window.AndroidOverlay?.closeOverlay?.();
  }
}
