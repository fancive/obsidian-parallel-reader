'use strict';

export type RafThrottledHandler = (() => void) & { cancel: () => void };

export function visibleTopProbeY(rect: { top?: number; height?: number } | null, maxOffset = 80, ratio = 0.1) {
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
  return { __brand: 'ScheduleId', raw } as ScheduleId;
}

function defaultSchedule(callback: FrameRequestCallback): ScheduleId {
  if (typeof requestAnimationFrame === 'function') return wrapId(requestAnimationFrame(callback));
  return wrapId(setTimeout(() => callback(Date.now()), 16));
}

function defaultCancel(id: ScheduleId) {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(id.raw as number);
    return;
  }
  clearTimeout(id.raw as ReturnType<typeof setTimeout>);
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
