const { assert, t } = require('./test-setup');

assert.strictEqual(t.visibleTopProbeY({ top: 0, height: 0 }), 0, 'zero rect');
assert.strictEqual(t.visibleTopProbeY(null), 0, 'null rect');
assert.strictEqual(t.visibleTopProbeY({ top: 50, height: 500 }), 100, 'standard rect: min(80, 500*0.1)=50, 50+50=100');
assert.strictEqual(t.visibleTopProbeY({ top: 100, height: 300 }), 130, 'small rect offset 10%');
assert.strictEqual(t.visibleTopProbeY({ top: 100, height: 1200 }), 180, 'large rect capped at 80');

const frames = [];
const throttled = t.createRafThrottledHandler(
  () => {},
  (cb) => {
    frames.push(cb);
    return frames.length;
  },
);
throttled();
assert.strictEqual(frames.length, 1);
throttled.cancel();
throttled();
assert.strictEqual(frames.length, 2, 'new frame after cancel');

console.log('scroll tests passed');
