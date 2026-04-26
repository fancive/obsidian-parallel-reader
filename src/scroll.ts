'use strict';

export type RafThrottledHandler = (() => void) & { cancel: () => void };

export function visibleTopProbeY(rect: { top?: number; height?: number } | null, maxOffset = 80, ratio = 0.1) {
  const top = Number(rect?.top) || 0;
  const height = Math.max(0, Number(rect?.height) || 0);
  const cappedOffset = Math.min(Number(maxOffset) || 0, height * ratio);
  return top + Math.max(0, cappedOffset);
}

function defaultSchedule(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return setTimeout(() => callback(Date.now()), 16) as unknown as number;
}

function defaultCancel(frameId: number) {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(frameId);
    return;
  }
  clearTimeout(frameId as unknown as ReturnType<typeof setTimeout>);
}

export function createRafThrottledHandler(
  callback: () => void,
  schedule: (callback: FrameRequestCallback) => number = defaultSchedule,
  cancel: (frameId: number) => void = defaultCancel,
): RafThrottledHandler {
  let frameId: number | null = null;

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
