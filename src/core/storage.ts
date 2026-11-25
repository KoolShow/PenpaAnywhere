import type { Point2D } from './homography';
import type { BlendRenderMode } from './webglOverlay';
import type { HotkeyBinding } from './hotkey';
import type { AppLocale } from './i18n';

export interface PersistedBarState {
  xRatio: number;
  yRatio: number;
  compact: boolean;
}

export interface PersistedDockState {
  xRatio: number;
  yRatio: number;
  w: number;
  h: number;
  scale: number;
  opacity: number;
  collapsed: boolean;
}

export interface PersistedAppState {
  blendMode?: BlendRenderMode;
  alignTarget?: 'grid' | 'canvas';
  quadMode?: 'rect' | 'free';
  opacity?: number;
  calibrating?: boolean;
  dockVisible?: boolean;
  cornersNorm?: [Point2D, Point2D, Point2D, Point2D];
  bar?: PersistedBarState;
  dock?: PersistedDockState;
  customCssEnabled?: boolean;
  customCss?: string;
  toggleHotkey?: HotkeyBinding | null;
  locale?: AppLocale;
}

const STORAGE_KEY = 'penpaanywhere:ui_state_v1';
let cachedState: PersistedAppState | null = null;
let saveTimer = 0;

export function loadPersistedState(): PersistedAppState {
  if (cachedState) return cachedState;
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cachedState = {};
      return cachedState;
    }
    const parsed = JSON.parse(raw) as PersistedAppState;
    cachedState = parsed && typeof parsed === 'object' ? parsed : {};
    return cachedState;
  } catch {
    cachedState = {};
    return cachedState;
  }
}

export function flushPersistedStateNow(): void {
  if (saveTimer) {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
  }
  if (!cachedState || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedState));
  } catch {
    // ignore quota / privacy errors
  }
}

export function patchPersistedState(partial: Partial<PersistedAppState>): void {
  const current = loadPersistedState();
  cachedState = { ...current, ...partial };
  if (typeof window === 'undefined') return;
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    flushPersistedStateNow();
  }, 200);
}
