import { onBeforeUnmount, onMounted } from 'vue';
import type { Point2D, Rect2D } from './homography';
import type { WorldViewportTransform } from './world';
import {
  applyCropBackgroundPanDrag,
  type CropDraft,
  type MediaCrop,
  type WorldElement,
} from './canvasItems';
import { beginGlobalDrag, endGlobalDrag, tryCapturePointer, tryReleasePointer } from './dragGuard';

interface MoveDragSession {
  mode: 'move';
  pointerId: number;
  captureEl: Element | null;
  startClient: { x: number; y: number };
  baseCorners: [Point2D, Point2D, Point2D, Point2D];
}

interface CropBgPanSession {
  mode: 'crop-bg-pan';
  pointerId: number;
  captureEl: Element | null;
  startClient: { x: number; y: number };
  elementId: string;
  baseFullRect: Rect2D;
  baseCrop: MediaCrop;
}

type DragSession = MoveDragSession | CropBgPanSession;

/**
 * Shared whole-element translation & crop-preview background-pan drag composable
 * reused by ALL WorldElement views (PerspectiveOverlay for grids & MediaElementView for images/screens).
 */
export function useWholeElementDrag(options: {
  getElement: () => WorldElement;
  getCropDraft: () => CropDraft | null;
  getViewport: () => WorldViewportTransform;
  isWorldBounded: () => boolean;
  onUpdateCorners: (id: string, corners: [Point2D, Point2D, Point2D, Point2D]) => void;
  onUpdateCropDraft: (draft: CropDraft) => void;
}) {
  let session: DragSession | null = null;

  function endSession() {
    if (!session) return;
    tryReleasePointer(session.captureEl, session.pointerId);
    session = null;
    endGlobalDrag();
  }

  function clampDelta(dx: number, dy: number): { dx: number; dy: number } {
    // Elements are allowed to move freely outside the viewport in all modes
    return { dx, dy };
  }

  function beginDrag(e: PointerEvent) {
    if (session) endSession();
    const c = options.getElement().corners;
    const targetEl = e.currentTarget instanceof HTMLElement ? e.currentTarget : document.documentElement;
    const captureEl = tryCapturePointer(targetEl, e.pointerId);
    beginGlobalDrag();
    session = {
      mode: 'move',
      pointerId: e.pointerId,
      captureEl,
      startClient: { x: e.clientX, y: e.clientY },
      baseCorners: [{ ...c[0] }, { ...c[1] }, { ...c[2] }, { ...c[3] }],
    };
  }

  function beginCropPan(e: PointerEvent) {
    const draft = options.getCropDraft();
    if (!draft) return;
    if (session) endSession();
    const targetEl = e.currentTarget instanceof HTMLElement ? e.currentTarget : document.documentElement;
    const captureEl = tryCapturePointer(targetEl, e.pointerId);
    beginGlobalDrag();
    session = {
      mode: 'crop-bg-pan',
      pointerId: e.pointerId,
      captureEl,
      startClient: { x: e.clientX, y: e.clientY },
      elementId: draft.elementId,
      baseFullRect: { ...draft.fullRect },
      baseCrop: { ...draft.crop },
    };
  }

  function onPointerMove(e: PointerEvent) {
    if (!session || e.pointerId !== session.pointerId) return;
    e.preventDefault();
    const z = options.getViewport().zoom || 1;
    const rawDx = (e.clientX - session.startClient.x) / z;
    const rawDy = (e.clientY - session.startClient.y) / z;

    if (session.mode === 'crop-bg-pan') {
      const res = applyCropBackgroundPanDrag(session.baseFullRect, session.baseCrop, rawDx, rawDy);
      options.onUpdateCropDraft({
        elementId: session.elementId,
        fullRect: res.fullRect,
        crop: res.crop,
        croppedRect: res.croppedRect,
      });
      return;
    }

    const { dx, dy } = clampDelta(rawDx, rawDy);
    const b = session.baseCorners;
    options.onUpdateCorners(options.getElement().id, [
      { x: b[0].x + dx, y: b[0].y + dy },
      { x: b[1].x + dx, y: b[1].y + dy },
      { x: b[2].x + dx, y: b[2].y + dy },
      { x: b[3].x + dx, y: b[3].y + dy },
    ]);
  }

  function onPointerUp(e: PointerEvent) {
    if (!session || e.pointerId !== session.pointerId) return;
    endSession();
  }

  function onWindowBlur() {
    endSession();
  }

  onMounted(() => {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('blur', onWindowBlur);
  });

  onBeforeUnmount(() => {
    endSession();
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('blur', onWindowBlur);
  });

  return { beginDrag, beginCropPan };
}
