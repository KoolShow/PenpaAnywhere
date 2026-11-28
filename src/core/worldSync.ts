import type { Point2D } from './homography';
import type { CropDraft, ElementGroup, GridElement, QuadMode, WorldElement } from './canvasItems';
import type { GridBoundsNormalized } from './penpaBridge';
import type { ButtonDisplayMode, PersistedDockState } from './storage';
import type { MonitorDescriptor, WorkspaceMode } from './world';
import type { UnavailableReasonKey } from '../components/ControlBar.vue';

export interface SerializedWorldElementBase {
  id: string;
  kind: WorldElement['kind'];
  worldId: string;
  label: string;
  corners: [Point2D, Point2D, Point2D, Point2D];
  quadMode: QuadMode;
  crop: WorldElement['crop'];
  zIndex: number;
  visible: boolean;
  locked: boolean;
  passThrough: boolean;
}

export interface SerializedGridElement extends SerializedWorldElementBase {
  kind: 'grid';
  blendMode: GridElement['blendMode'];
  opacity: number;
  enhanceOpacity: boolean;
  dockVisible: boolean;
}

export interface SerializedImageElement extends SerializedWorldElementBase {
  kind: 'image';
  naturalW: number;
  naturalH: number;
}

export interface SerializedScreenElement extends SerializedWorldElementBase {
  kind: 'screen';
  streamId: string;
  naturalW: number;
  naturalH: number;
  sourceWindowLabel: string;
}

export type SerializedWorldElement =
  | SerializedGridElement
  | SerializedImageElement
  | SerializedScreenElement;

export interface WorldStateSnapshot {
  rev: number;
  coordMode: 'physical' | 'dip';
  monitors: MonitorDescriptor[];
  mainMonitorId: string | null;
  activeControlBarMonitorId: string | null;
  modalMonitorId: string | null;
  settingsOpen: boolean;
  highlightSettingKey: 'overlayFullCanvas' | null;
  highlightSettingTick: number;
  customCssEnabled: boolean;
  customCss: string;
  unavailableReasonKey: UnavailableReasonKey | null;
  backdropMode: WorkspaceMode;
  fullCanvasEnabled: boolean;
  multiMonitorEnabled: boolean;
  layersVisible: boolean;
  alwaysOnTop: boolean;
  canScreenCapture: boolean;
  canSwitchOverlay: boolean;
  elements: SerializedWorldElement[];
  groups: ElementGroup[];
  selectedTargetIds: string[];
  activeDraggingElementIds: string[];
  hoveredLockedId: string | null;
  toolbarHiddenTargetIds: string[];
  cropDraft: CropDraft | null;
  focusedDockId: string | null;
  buttonDisplayMode: ButtonDisplayMode;
  globalScale: number;
  penpaScale: number;
  penpaBlurOpacity: number;
  showUnavailableOptions: boolean;
  gridBoundsById: Record<string, GridBoundsNormalized>;
}

export interface WorldGeometryDelta {
  rev: number;
  cornersById: Record<string, [Point2D, Point2D, Point2D, Point2D]>;
}

export interface RemoteGridFrame {
  rgba: Uint8Array;
  width: number;
  height: number;
  seq: number;
}

export type PenpaPointerType = 'down' | 'move' | 'up' | 'out' | 'contextmenu';

export interface PenpaPointerOpts {
  button?: number;
  buttons?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

export type PenpaInputMessage =
  | {
      type: 'pointer';
      eventType: PenpaPointerType;
      u: number;
      v: number;
      opts?: PenpaPointerOpts;
    }
  | {
      type: 'key';
      eventType: 'keydown' | 'keyup';
      key: string;
      code: string;
      keyCode: number;
      ctrlKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
      metaKey: boolean;
      repeat: boolean;
    }
  | {
      type: 'sync-theme';
      tokens: Record<string, string>;
      customCss: string;
      lang: 'ZH' | 'EN' | 'JP';
    }
  | { type: 'save-draft' }
  | { type: 'suppress-draft' }
  | { type: 'force-redraw' };

export type WorldCommand =
  | { type: 'request-snapshot'; fromLabel?: string }
  | { type: 'select'; id: string | null; additive?: boolean }
  | { type: 'focus-multi-member'; id: string }
  | { type: 'move-start'; leafId: string; startPhys?: Point2D }
  | { type: 'translate-by'; leafId: string; dxWorld: number; dyWorld: number }
  | { type: 'move-end' }
  | { type: 'resize-start'; id: string }
  | { type: 'resize-end' }
  | { type: 'update-target'; id: string; patch: Partial<WorldElement> }
  | { type: 'update-quad-mode'; id: string; mode: QuadMode }
  | { type: 'reset-size'; id: string }
  | { type: 'start-crop'; id: string }
  | { type: 'update-crop-draft'; draft: CropDraft }
  | { type: 'commit-crop' }
  | { type: 'cancel-crop' }
  | { type: 'group-selected' }
  | { type: 'ungroup-target'; id: string }
  | { type: 'toggle-visible'; ids: string[]; source: 'toolbar' | 'layers' }
  | { type: 'toggle-passthrough'; id: string }
  | { type: 'toggle-dock'; ids: string[] }
  | { type: 'bring-front'; ids: string[] }
  | { type: 'send-back'; ids: string[] }
  | { type: 'remove-targets'; ids: string[] }
  | { type: 'lock-targets'; ids: string[] }
  | { type: 'unlock-target'; id: string }
  | { type: 'draw-interact'; gridId: string }
  | { type: 'penpa-pointer'; gridId: string; eventType: PenpaPointerType; u: number; v: number; opts?: PenpaPointerOpts }
  | { type: 'penpa-key'; gridId?: string; eventType: 'keydown' | 'keyup'; key: string; code: string; keyCode: number; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; repeat: boolean }
  | { type: 'dock-ready'; gridId: string }
  | { type: 'dock-activate'; gridId: string }
  | { type: 'dock-rename'; gridId: string; label: string }
  | { type: 'dock-visible'; gridId: string; visible: boolean }
  | { type: 'dock-render-patch'; gridId: string; patch: Partial<Pick<GridElement, 'blendMode' | 'opacity' | 'enhanceOpacity'>> }
  | { type: 'dock-state-change'; gridId: string; state: PersistedDockState }
  | { type: 'dock-clone'; gridId: string; penpaParam: string }
  | { type: 'dock-grid-bounds'; gridId: string; bounds: GridBoundsNormalized }
  | { type: 'dock-unavailable'; key: UnavailableReasonKey }
  | { type: 'dock-preview-image'; dataUrl: string; filename: string; mimeType: string }
  | { type: 'dock-download'; filename: string; mimeType: string; base64Data: string }
  | { type: 'update-natural-size'; id: string; w: number; h: number }
  | { type: 'add-grid' }
  | { type: 'add-image' }
  | { type: 'add-screen' }
  | { type: 'set-layers-visible'; visible: boolean }
  | { type: 'set-always-on-top'; pinned: boolean }
  | { type: 'set-backdrop-mode'; mode: WorkspaceMode }
  | { type: 'move-layer-order'; id: string; dir: 'up' | 'down' }
  | { type: 'rename-target'; id: string; label: string }
  | { type: 'open-settings'; monitorId?: string; highlight?: 'overlayFullCanvas' | null }
  | { type: 'close-settings' }
  | {
      type: 'update-settings';
      patch: Partial<{
        customCssEnabled: boolean;
        customCss: string;
        buttonDisplayMode: ButtonDisplayMode;
        globalScale: number;
        penpaScale: number;
        penpaBlurOpacity: number;
        overlayFullCanvas: boolean;
        multiMonitorEnabled: boolean;
        showUnavailableOptions: boolean;
      }>;
    }
  | { type: 'close-unavailable' }
  | { type: 'bar-state-change'; monitorId?: string; state: { xRatio: number; yRatio: number; compact: boolean } }
  | { type: 'close-overlay' };
