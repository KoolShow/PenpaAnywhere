export interface GridBoundsNormalized {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  canvasCssW: number;
  canvasCssH: number;
}

export interface PenpaStatus {
  ready: boolean;
  gridtype?: string;
  nx?: number;
  ny?: number;
  qa?: string;
  editMode?: string;
  frameVersion?: number;
}

export interface PenpaPointerOpts {
  button?: number;
  buttons?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

export interface PenpaKeyOpts {
  key: string;
  code: string;
  keyCode: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
}

export interface PenpaIframeBridge {
  isReady(): boolean;
  getCanvas(): HTMLCanvasElement | null;
  getFrameVersion(): number;
  getGridBoundsNormalized(): GridBoundsNormalized;
  getStatus(): PenpaStatus;
  dispatchPointer(
    phase: 'down' | 'move' | 'up' | 'out' | 'contextmenu',
    u: number,
    v: number,
    opts?: PenpaPointerOpts,
  ): void;
  dispatchKey(type: 'keydown' | 'keyup', opts: PenpaKeyOpts): void;
  forceRedraw(): void;
  saveDraftNow?(): void;
  setMd3Tokens?(tokens: Record<string, string>): void;
  setCustomCss?(css: string): void;
  subscribe(fn: (version: number) => void): () => void;
}

export function getPenpaBridge(iframe: HTMLIFrameElement | null): PenpaIframeBridge | null {
  if (!iframe) return null;
  try {
    const win = iframe.contentWindow as (Window & { __PENPAANYWHERE_BRIDGE__?: PenpaIframeBridge }) | null;
    return win?.__PENPAANYWHERE_BRIDGE__ ?? null;
  } catch {
    return null;
  }
}
