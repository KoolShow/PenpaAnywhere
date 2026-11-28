import { detectPlatform } from './platform';
import type { PenpaIframeBridge } from './penpaBridge';
import type { MonitorDescriptor } from './world';
import type { ThemeMode } from './storage';
import type { AppLocale } from './i18n';

/**
 * Same-renderer shared host hub exposed by `main` (`window.__PENPA_SHARED_HOST__`).
 * Windows opened via `window.open()` + Tauri `on_new_window(NewWindowResponse::Create)`
 * share the exact same Chromium/WebKit renderer process & GPU context, enabling true
 * zero-copy `gl.texImage2D(liveCanvas)` and synchronous 0ms pointer dispatch across monitors!
 */
export interface SharedBarPositionState {
  xRatio: number;
  yRatio: number;
  compact: boolean;
}

export interface SharedThemeLocaleState {
  themeMode: ThemeMode;
  dynamicColorEnabled: boolean;
  customHue: number;
  locale: AppLocale;
}

export interface SharedMultiMonitorHost {
  registerDockBridge(gridId: string, bridge: PenpaIframeBridge): void;
  unregisterDockBridge(gridId: string): void;
  getDockBridge(gridId: string): PenpaIframeBridge | null;
  getAllDockBridges(): Map<string, PenpaIframeBridge>;
  subscribeDockBridges(fn: () => void): () => void;
  getAllScreenStreams(): Map<string, MediaStream>;
  subscribeScreenStreams(fn: () => void): () => void;
  getBarPosition(monitorId?: string): SharedBarPositionState | null;
  setBarPosition(state: SharedBarPositionState, monitorId?: string): void;
  getThemeAndLocale(): SharedThemeLocaleState;
  syncThemeAndLocaleFromChild(state: Partial<SharedThemeLocaleState>): void;
}

declare global {
  interface Window {
    __PENPA_SHARED_HOST__?: SharedMultiMonitorHost;
  }
}

export function getSharedMultiMonitorHost(): SharedMultiMonitorHost | null {
  if (typeof window === 'undefined') return null;
  try {
    const opener = window.opener as Window | null;
    if (opener && !opener.closed && opener.__PENPA_SHARED_HOST__) {
      return opener.__PENPA_SHARED_HOST__;
    }
  } catch {
    // cross-origin or detached opener
  }
  return window.__PENPA_SHARED_HOST__ ?? null;
}

export function openLinkedWindow(urlQuery: string, windowName: string): Window | null {
  if (typeof window === 'undefined') return null;
  const query = urlQuery.startsWith('?') ? urlQuery : `?${urlQuery}`;
  try {
    return window.open(`index.html${query}`, windowName);
  } catch (err) {
    console.warn('[PenpaAnywhere] window.open failed:', err);
    return null;
  }
}

export type FloatingSurfaceHostMode = 'inline' | 'native-window';

export interface FloatingSurfaceSpec {
  id: string;
  hostMode: FloatingSurfaceHostMode;
  keepAliveWhenHidden: boolean;
  resizable: boolean;
}

export interface GridFrameMeta {
  gridId: string;
  seq: number;
  width: number;
  height: number;
}

export type AppWindowRole = 'main' | 'viewport' | 'dock' | 'surface';

export interface ParsedWindowRole {
  role: AppWindowRole;
  monitorId: string | null;
  gridId: string | null;
  surfaceId: string | null;
}

export function parseCurrentWindowRole(): ParsedWindowRole {
  if (typeof window === 'undefined') {
    return { role: 'main', monitorId: null, gridId: null, surfaceId: null };
  }
  const params = new URLSearchParams(window.location.search);
  const rawRole = params.get('role');
  if (rawRole === 'viewport') {
    return {
      role: 'viewport',
      monitorId: params.get('monitorId'),
      gridId: null,
      surfaceId: null,
    };
  }
  if (rawRole === 'dock') {
    return {
      role: 'dock',
      monitorId: null,
      gridId: params.get('gridId'),
      surfaceId: params.get('surfaceId'),
    };
  }
  if (rawRole === 'surface') {
    return {
      role: 'surface',
      monitorId: null,
      gridId: null,
      surfaceId: params.get('surfaceId'),
    };
  }
  return { role: 'main', monitorId: null, gridId: null, surfaceId: null };
}

export async function getOsMonitors(): Promise<MonitorDescriptor[]> {
  if (detectPlatform() !== 'tauri') return [];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<MonitorDescriptor[]>('get_monitors');
  } catch (err) {
    console.warn('[PenpaAnywhere] get_monitors failed:', err);
    return [];
  }
}

export async function setOsMultiMonitorEnabled(enabled: boolean): Promise<MonitorDescriptor[]> {
  if (detectPlatform() !== 'tauri') return [];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<MonitorDescriptor[]>('set_multi_monitor_enabled', { enabled });
  } catch (err) {
    console.warn('[PenpaAnywhere] set_multi_monitor_enabled failed:', err);
    return [];
  }
}

export async function notifyOsViewportReady(): Promise<void> {
  if (detectPlatform() !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('viewport_ready');
  } catch {
    // non-fatal
  }
}

export async function ensureNativeSurfaceWindow(params: {
  surfaceId: string;
  urlQuery: string;
  physX: number;
  physY: number;
  logicalW: number;
  logicalH: number;
  visible: boolean;
}): Promise<string | null> {
  if (detectPlatform() !== 'tauri') return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string>('ensure_surface_window', {
      surfaceId: params.surfaceId,
      urlQuery: params.urlQuery,
      physX: Math.round(params.physX),
      physY: Math.round(params.physY),
      logicalW: params.logicalW,
      logicalH: params.logicalH,
      visible: params.visible,
    });
  } catch (err) {
    console.warn('[PenpaAnywhere] ensure_surface_window failed:', err);
    return null;
  }
}

export async function setNativeSurfaceBounds(params: {
  surfaceId: string;
  physX?: number;
  physY?: number;
  logicalW: number;
  logicalH: number;
}): Promise<void> {
  if (detectPlatform() !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_surface_bounds', {
      surfaceId: params.surfaceId,
      physX: typeof params.physX === 'number' ? Math.round(params.physX) : null,
      physY: typeof params.physY === 'number' ? Math.round(params.physY) : null,
      logicalW: params.logicalW,
      logicalH: params.logicalH,
    });
  } catch {
    // non-fatal
  }
}

export async function setNativeSurfaceVisible(surfaceId: string, visible: boolean): Promise<void> {
  if (detectPlatform() !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_surface_visible', { surfaceId, visible });
  } catch {
    // non-fatal
  }
}

export async function bringNativeSurfaceToFront(surfaceId: string): Promise<void> {
  if (detectPlatform() !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('bring_surface_to_front', { surfaceId });
  } catch {
    // non-fatal
  }
}

export async function setNativeSurfaceTitle(surfaceId: string, title: string): Promise<void> {
  if (detectPlatform() !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_surface_title', { surfaceId, title });
  } catch {
    // non-fatal
  }
}

export async function destroyNativeSurfaceWindow(surfaceId: string): Promise<void> {
  if (detectPlatform() !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('destroy_surface_window', { surfaceId });
  } catch {
    // non-fatal
  }
}

export async function pushGridFrameRgba(
  gridId: string,
  seq: number,
  width: number,
  height: number,
  rgba: Uint8Array,
): Promise<void> {
  if (detectPlatform() !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('push_grid_frame', rgba, {
      headers: {
        'x-grid-id': gridId,
        'x-frame-seq': String(seq),
        'x-frame-w': String(width),
        'x-frame-h': String(height),
      },
    });
  } catch {
    // non-fatal
  }
}

export async function getGridFrameRgba(gridId: string): Promise<Uint8Array | null> {
  if (detectPlatform() !== 'tauri') return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const buf = await invoke<ArrayBuffer>('get_grid_frame', { gridId });
    if (!buf || buf.byteLength === 0) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

export async function getAllGridFrameMetas(): Promise<GridFrameMeta[]> {
  if (detectPlatform() !== 'tauri') return [];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<GridFrameMeta[]>('get_all_grid_frame_metas');
  } catch {
    return [];
  }
}

export async function relayWorldCommand(payload: unknown): Promise<void> {
  if (detectPlatform() !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('relay_world_command', { payload });
  } catch {
    // non-fatal
  }
}

export async function broadcastWorldState(
  eventName: string,
  payload: unknown,
  targetLabel?: string,
): Promise<void> {
  if (detectPlatform() !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('broadcast_world_state', {
      eventName,
      payload,
      targetLabel: targetLabel ?? null,
    });
  } catch {
    // non-fatal
  }
}

export async function relayPenpaInput(targetLabel: string, payload: unknown): Promise<void> {
  if (detectPlatform() !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('relay_penpa_input', { targetLabel, payload });
  } catch {
    // non-fatal
  }
}

export async function isAnyAppWindowFocused(): Promise<boolean> {
  if (detectPlatform() !== 'tauri') return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('is_any_app_window_focused');
  } catch {
    return false;
  }
}

export async function startNativeSurfaceDrag(
  surfaceId: string,
  logicalW: number,
  logicalH: number,
): Promise<boolean> {
  if (detectPlatform() !== 'tauri') return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('start_surface_drag', { surfaceId, logicalW, logicalH });
  } catch {
    return false;
  }
}

export async function endNativeSurfaceDrag(): Promise<void> {
  if (detectPlatform() !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('end_surface_drag');
  } catch {
    // non-fatal
  }
}
