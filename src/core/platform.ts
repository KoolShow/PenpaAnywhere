export type RuntimePlatform = 'tauri' | 'android-overlay' | 'android-app' | 'web';

export interface AndroidScreenshotCompositeStatus {
  state: 'unset' | 'enabled' | 'disabled';
  enabled: boolean;
  hasReadPermission: boolean;
  hasWritePermission: boolean;
}

interface AndroidOverlayInterface {
  isOverlayMode?: () => boolean;
  isDebugBuild?: () => boolean;
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
  saveDownloadFile?: (filename: string, mimeType: string, base64Data: string) => string;
  copyText?: (text: string) => boolean;
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
    __PENPAANYWHERE_OPEN_EXTERNAL__?: (url: string) => void;
    __PENPAANYWHERE_DOWNLOAD__?: (filename: string, mimeType: string, base64Data: string) => void;
    __PENPAANYWHERE_PREVIEW_IMAGE__?: (dataUrl: string, filename: string, mimeType: string) => void;
    __PENPAANYWHERE_IS_DEBUG__?: boolean;
    __PENPAANYWHERE_TOGGLE_DEVTOOLS__?: (shouldToggle?: boolean) => boolean;
    __PENPAANYWHERE_ON_IFRAME_INTERACT__?: () => void;
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

export async function setOsWindowTheme(
  mode: 'auto' | 'dark' | 'light',
  dark: boolean,
): Promise<void> {
  if (detectPlatform() !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_window_theme', { mode, dark });
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

export function isAllowedExternalHttpUrl(rawUrl: string): boolean {
  const url = (rawUrl || '').trim();
  if (!url || url.length > 32768 || /[\s\u0000-\u001F\u007F]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.host;
  } catch {
    return false;
  }
}

export async function openExternalLink(url: string): Promise<void> {
  const trimmed = (url || '').trim();
  if (!isAllowedExternalHttpUrl(trimmed)) return;
  const platform = detectPlatform();
  if (platform === 'tauri') {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_external_url', { url: trimmed });
      return;
    } catch {
      // fall through
    }
  } else if (platform === 'android-overlay' || platform === 'android-app') {
    try {
      if (window.AndroidOverlay?.openExternalUrl) {
        window.AndroidOverlay.openExternalUrl(trimmed);
        return;
      }
    } catch {
      // fall through
    }
  }
  window.open(trimmed, '_blank', 'noopener,noreferrer');
}

export async function saveDownloadedFile(
  filename: string,
  mimeType: string,
  base64Data: string,
): Promise<string | null> {
  const platform = detectPlatform();
  if (platform === 'tauri') {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const savedName = await invoke<string>('save_download_file', {
        filename,
        base64Data,
      });
      return savedName || filename;
    } catch (err) {
      console.warn('[PenpaAnywhere] Tauri save_download_file failed:', err);
      return null;
    }
  }
  if (platform === 'android-overlay' || platform === 'android-app') {
    try {
      const savedName = window.AndroidOverlay?.saveDownloadFile?.(
        filename,
        mimeType || 'application/octet-stream',
        base64Data,
      );
      return savedName || null;
    } catch (err) {
      console.warn('[PenpaAnywhere] Android saveDownloadFile failed:', err);
      return null;
    }
  }
  return null;
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

let cachedDebugBuild: boolean | null = null;

export function getInitialIsDebugBuild(): boolean {
  if (cachedDebugBuild !== null) return cachedDebugBuild;
  const platform = detectPlatform();
  if (platform === 'android-overlay' || platform === 'android-app') {
    try {
      if (typeof window.AndroidOverlay?.isDebugBuild === 'function') {
        cachedDebugBuild = Boolean(window.AndroidOverlay.isDebugBuild());
        return cachedDebugBuild;
      }
    } catch {
      // fall through
    }
    return false;
  }
  if (platform === 'web') {
    cachedDebugBuild = Boolean(import.meta.env.DEV);
    return cachedDebugBuild;
  }
  return Boolean(import.meta.env.DEV);
}

export async function getIsDebugBuild(): Promise<boolean> {
  if (cachedDebugBuild !== null) return cachedDebugBuild;
  const platform = detectPlatform();
  if (platform === 'tauri') {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      cachedDebugBuild = Boolean(await invoke<boolean>('is_debug_build'));
      return cachedDebugBuild;
    } catch {
      cachedDebugBuild = false;
      return false;
    }
  }
  if (platform === 'android-overlay' || platform === 'android-app') {
    try {
      cachedDebugBuild = Boolean(window.AndroidOverlay?.isDebugBuild?.());
      return cachedDebugBuild;
    } catch {
      cachedDebugBuild = false;
      return false;
    }
  }
  cachedDebugBuild = Boolean(import.meta.env.DEV);
  return cachedDebugBuild;
}

export async function toggleOsDevtools(): Promise<boolean> {
  if (detectPlatform() !== 'tauri') return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return Boolean(await invoke<boolean>('toggle_devtools'));
  } catch {
    return false;
  }
}
