import { detectPlatform } from './platform';

let activeDragCount = 0;

function syncNativeDragActive(active: boolean) {
  if (detectPlatform() !== 'tauri') return;
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('set_drag_active', { active }))
    .catch(() => {});
}

/**
 * Tracks active pointer drags across the entire app:
 * 1. Toggles `body.ac-dragging` so embedded iframes (Penpa+) get `pointer-events: none`
 *    and can NEVER steal pointermove/pointerup events during fast drags.
 * 2. Notifies Tauri native overlay poller so Windows never flips WS_EX_TRANSPARENT mid-drag.
 */
export function beginGlobalDrag() {
  activeDragCount += 1;
  if (activeDragCount === 1) {
    document.body?.classList.add('ac-dragging');
    syncNativeDragActive(true);
  }
}

export function endGlobalDrag() {
  if (activeDragCount <= 0) return;
  activeDragCount -= 1;
  if (activeDragCount === 0) {
    document.body?.classList.remove('ac-dragging');
    syncNativeDragActive(false);
  }
}

export function tryCapturePointer(el: Element | null | undefined, pointerId: number): Element | null {
  if (!el || typeof (el as HTMLElement).setPointerCapture !== 'function') return null;
  try {
    (el as HTMLElement).setPointerCapture(pointerId);
    return el;
  } catch {
    return null;
  }
}

export function tryReleasePointer(el: Element | null | undefined, pointerId: number) {
  if (!el || typeof (el as HTMLElement).releasePointerCapture !== 'function') return;
  try {
    if ((el as HTMLElement).hasPointerCapture?.(pointerId)) {
      (el as HTMLElement).releasePointerCapture(pointerId);
    }
  } catch {
    // ignore
  }
}
