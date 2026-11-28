import type { Point2D } from './homography';
import type { BlendRenderMode } from './webglOverlay';
import type { AppLocale } from './i18n';
import type { WorldViewportTransform } from './world';
import type { CanvasImageItemMeta, MediaCrop } from './canvasItems';

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

export interface PersistedLayersWindowState {
  xRatio: number;
  yRatio: number;
  open: boolean;
}

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ButtonDisplayMode = 'icon-only' | 'icon-text' | 'text-only';

export interface PersistedElementGroup {
  id: string;
  label: string;
  memberIds: string[];
  visible: boolean;
  locked: boolean;
  passThrough: boolean;
}

export interface PersistedGridElement {
  id: string;
  worldId: string;
  label: string;
  corners: [Point2D, Point2D, Point2D, Point2D];
  quadMode: 'rect' | 'free';
  crop: MediaCrop;
  blendMode: BlendRenderMode;
  opacity: number;
  enhanceOpacity: boolean;
  dockVisible: boolean;
  visible: boolean;
  locked: boolean;
  passThrough: boolean;
  zIndex: number;
}

export interface PersistedAppState {
  /** Persisted Penpa+ Grid elements (multi-grid). Migrated from legacy top-level fields on first load. */
  gridItems?: PersistedGridElement[];
  /** Per-grid floating Penpa+ tool window geometry (keyed by grid.id). */
  gridDocks?: Record<string, PersistedDockState>;
  blendMode?: BlendRenderMode;
  alignTarget?: 'grid' | 'canvas';
  quadMode?: 'rect' | 'free';
  opacity?: number;
  gridEnhanceOpacity?: boolean;
  /** Legacy flag migrated to gridLocked = !calibrating on first load. */
  calibrating?: boolean;
  gridLocked?: boolean;
  gridPassThrough?: boolean;
  gridCrop?: MediaCrop;
  gridZIndex?: number;
  gridLabel?: string;
  dockVisible?: boolean;
  canvasVisible?: boolean;
  /** Absolute Root-World grid corners (CSS px). Preferred over legacy cornersNorm. */
  worldCorners?: [Point2D, Point2D, Point2D, Point2D];
  /** Legacy viewport-normalized corners kept for one-time migration. */
  cornersNorm?: [Point2D, Point2D, Point2D, Point2D];
  /** Persisted pan/zoom viewport transform for Canvas mode. */
  canvasViewport?: WorldViewportTransform;
  /** Persisted Canvas-mode image item metadata (binary blobs live in IndexedDB). */
  canvasItems?: CanvasImageItemMeta[];
  /** Persisted element groups (atomic selection & drag units). */
  elementGroups?: PersistedElementGroup[];
  bar?: PersistedBarState;
  barByMonitor?: Record<string, PersistedBarState>;
  dock?: PersistedDockState;
  layersWindow?: PersistedLayersWindowState;
  customCssEnabled?: boolean;
  customCss?: string;
  locale?: AppLocale;
  themeMode?: ThemeMode;
  dynamicColor?: boolean;
  customHue?: number;
  buttonDisplayMode?: ButtonDisplayMode;
  globalScale?: number;
  penpaScale?: number;
  penpaBlurOpacity?: number;
  overlayFullCanvas?: boolean;
  multiMonitorEnabled?: boolean;
  showUnavailableOptions?: boolean;
}

const STORAGE_KEY = 'penpaanywhere:ui_state_v1';
export const PRIMARY_GRID_ID = 'grid_primary';
const LEGACY_PENPA_DRAFT_KEY = 'penpaanywhere:penpa_draft_v1';

export function getPenpaDraftStorageKey(gridId: string): string {
  return gridId === PRIMARY_GRID_ID
    ? LEGACY_PENPA_DRAFT_KEY
    : `${LEGACY_PENPA_DRAFT_KEY}:${gridId}`;
}

export function deletePenpaDraftStorage(gridId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(getPenpaDraftStorageKey(gridId));
  } catch {
    // ignore storage errors
  }
}

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
