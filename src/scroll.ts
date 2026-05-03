'use strict';

export type RafThrottledHandler = (() => void) & { cancel: () => void };

/** Default maximum pixel offset from the top of the visible area for scroll probing. */
const DEFAULT_MAX_OFFSET_PX = 80;
/** Default ratio of visible height used to cap the scroll probe offset. */
const DEFAULT_PROBE_RATIO = 0.1;
/** Fallback frame interval (ms) when requestAnimationFrame is unavailable. */
const FALLBACK_FRAME_MS = 16;

export function visibleTopProbeY(
  rect: { top?: number; height?: number } | null,
  maxOffset = DEFAULT_MAX_OFFSET_PX,
  ratio = DEFAULT_PROBE_RATIO,
) {
  const top = Number(rect?.top) || 0;
  const height = Math.max(0, Number(rect?.height) || 0);
  const cappedOffset = Math.min(Number(maxOffset) || 0, height * ratio);
  return top + Math.max(0, cappedOffset);
}

/**
 * Opaque frame/timer ID used by the schedule/cancel pair.
 * In Electron both RAF and setTimeout return numbers; in Node.js tests
 * setTimeout returns Timeout. We unify via a branded wrapper so callers
 * never use `as unknown as`.
 */
type ScheduleId = { readonly __brand: 'ScheduleId'; readonly raw: number | ReturnType<typeof setTimeout> };

function wrapId(raw: number | ReturnType<typeof setTimeout>): ScheduleId {
  return { __brand: 'ScheduleId', raw };
}

function defaultSchedule(callback: FrameRequestCallback): ScheduleId {
  if (typeof requestAnimationFrame === 'function') return wrapId(requestAnimationFrame(callback));
  return wrapId(activeWindow.setTimeout(() => callback(Date.now()), FALLBACK_FRAME_MS));
}

function defaultCancel(id: ScheduleId) {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(id.raw as number);
    return;
  }
  activeWindow.clearTimeout(id.raw as number);
}

export function createRafThrottledHandler(
  callback: () => void,
  schedule: (callback: FrameRequestCallback) => ScheduleId = defaultSchedule,
  cancel: (id: ScheduleId) => void = defaultCancel,
): RafThrottledHandler {
  let frameId: ScheduleId | null = null;

  const handler = (() => {
    if (frameId !== null) return;
    frameId = schedule(() => {
      frameId = null;
      callback();
    });
  }) as RafThrottledHandler;

  handler.cancel = () => {
    if (frameId === null) return;
    cancel(frameId);
    frameId = null;
  };

  return handler;
}
