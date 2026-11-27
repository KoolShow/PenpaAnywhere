export type RuntimePlatform = 'tauri' | 'android-overlay' | 'android-app' | 'web';

export interface AndroidScreenshotCompositeStatus {
  state: 'unset' | 'enabled' | 'disabled';
  enabled: boolean;
  hasReadPermission: boolean;
  hasWritePermission: boolean;
}

interface AndroidOverlayInterface {
  isOverlayMode?: () => boolean;
  setClickThrough?: (enabled: boolean) => void;
  setFocusable?: (focusable: boolean) => void;
  updateHitRegions?: (payloadJson: string) => void;
  getDynamicColorTokens?: () => string;
  getDynamicColorBundle?: () => string;
  getSafeAreaInsets?: () => string;
  getScreenshotCompositeStatus?: () => string;
  setScreenshotCompositeEnabled?: (enabled: boolean) => void;
  respondScreenshotPrompt?: (choice: 'enable' | 'dismiss' | 'later') => void;
  requestAllFilesPermission?: () => void;
  switchToImageActivity?: () => void;
  switchToOverlayService?: () => void;
  openExternalUrl?: (url: string) => void;
  closeOverlay?: () => void;
  pickImage?: () => void;
}

export interface AndroidThemeBundle {
  dark: Record<string, string>;
  light: Record<string, string>;
  systemDark?: boolean;
  available?: boolean;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    AndroidOverlay?: AndroidOverlayInterface;
    __PENPAANYWHERE_ON_ANDROID_IMAGE__?: (dataUrl: string) => void;
    __PENPAANYWHERE_ON_CLICK_THROUGH__?: (enabled: boolean) => void;
    __PENPAANYWHERE_APPLY_MD3_TOKENS__?: (tokens: Record<string, string> | string) => void;
    __PENPAANYWHERE_APPLY_ANDROID_THEME_BUNDLE__?: (bundle: AndroidThemeBundle | string) => void;
    __PENPAANYWHERE_APPLY_SAFE_INSETS__?: (
      insets: { top: number; right: number; bottom: number; left: number } | string,
    ) => void;
    __PENPAANYWHERE_FLUSH_STORAGE__?: () => void;
    __PENPAANYWHERE_CAPTURE_OVERLAY__?: () => { active: boolean; dataUrl: string };
    __PENPAANYWHERE_ON_SCREENSHOT_PROMPT__?: (fileName: string) => void;
    __PENPAANYWHERE_ON_SCREENSHOT_STATUS__?: (status: AndroidScreenshotCompositeStatus) => void;
    __PENPAANYWHERE_ON_UNAVAILABLE__?: (key: string) => void;
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

export function supportsOverlaySwitch(platform: RuntimePlatform): boolean {
  return platform === 'tauri' || platform === 'android-overlay' || platform === 'android-app';
}

export function supportsOsDynamicColor(platform: RuntimePlatform): boolean {
  return platform === 'tauri' || platform === 'android-overlay' || platform === 'android-app';
}

export async function setOsWindowTheme(dark: boolean): Promise<void> {
  if (detectPlatform() !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_window_theme', { dark });
  } catch {
    // non-fatal
  }
}

export function switchAndroidToImageActivity(): boolean {
  if (detectPlatform() !== 'android-overlay') return false;
  try {
    if (window.AndroidOverlay?.switchToImageActivity) {
      window.AndroidOverlay.switchToImageActivity();
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

export function switchAndroidToOverlayService(): boolean {
  if (detectPlatform() !== 'android-app') return false;
  try {
    if (window.AndroidOverlay?.switchToOverlayService) {
      window.AndroidOverlay.switchToOverlayService();
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

export async function openExternalLink(url: string): Promise<void> {
  const platform = detectPlatform();
  if (platform === 'tauri') {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_external_url', { url });
      return;
    } catch {
      // fall through
    }
  } else if (platform === 'android-overlay' || platform === 'android-app') {
    try {
      if (window.AndroidOverlay?.openExternalUrl) {
        window.AndroidOverlay.openExternalUrl(url);
        return;
      }
    } catch {
      // fall through
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
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
  } else if (platform === 'android-overlay' || platform === 'android-app') {
    window.AndroidOverlay?.closeOverlay?.();
  }
}
