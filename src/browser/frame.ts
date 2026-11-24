/**
 * Frames for a hidden page.
 *
 * A page whose Chrome window is covered by another app gets no frames: lazy
 * lists keep empty placeholder rows (IntersectionObserver never fires) and
 * menu animations never finish. Taking a screenshot makes Chrome draw one
 * frame, so a tiny capture after a scroll or a click lets the page catch up
 * without bringing anything to the front.
 */
import type { IPage } from '../types.js';

/** True when the page reports hidden (covered window, minimised, or inactive tab). */
export async function isHiddenPage(page: IPage): Promise<boolean> {
  try { return (await page.evaluate('document.visibilityState')) !== 'visible'; } catch { return false; }
}

/** Make Chrome draw one frame of this page. Never throws. */
export async function pumpFrame(page: IPage): Promise<void> {
  if (typeof page.cdp !== 'function') return;
  try {
    await page.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 1, clip: { x: 0, y: 0, width: 8, height: 8, scale: 1 } });
  } catch { /* backend without capture: the caller's own checks still apply */ }
}
