/**
 * Component-level tests for src/error-ui.ts's `showGenerationError`.
 *
 * These exist because the timeout/rate-limit/schema branches (and the unknown fallback)
 * previously offered no way to re-run a failed generation, even though main.ts always
 * supplies an `onRetry` callback. Only network/auth/config/cancelled had settled behavior
 * before this file existed; those are asserted here too so a future change to the shared
 * `retryAction` helper can't silently regress them.
 */
const { assert, t } = require('./test-setup');
const { takeNotices } = require('./obsidian-mock.mjs');

const { showGenerationError } = t;

function makeCtx(overrides = {}) {
  return {
    app: {},
    settings: { uiLanguage: 'en' },
    openSettings: () => {},
    ...overrides,
  };
}

// Walk a mocked Notice's messageEl tree (built by showActionableNotice via createDiv/createEl)
// to find every <button>, mirroring what a real Obsidian DOM query would return.
function findButtons(notice) {
  const buttons = [];
  const walk = (el) => {
    if (el.tagName === 'BUTTON') buttons.push(el);
    for (const child of el.children) walk(child);
  };
  walk(notice.messageEl);
  return buttons;
}

function retryButton(notice) {
  return findButtons(notice).find((b) => b.textContent === 'Retry');
}

function showOnce(kind, error, message, ctxOverrides) {
  takeNotices();
  showGenerationError(makeCtx(ctxOverrides), kind, error, message);
  const notices = takeNotices();
  assert.strictEqual(notices.length, 1, `${kind}: exactly one notice shown`);
  return notices[0];
}

function testRetryOfferedForReRollableKinds() {
  // The four kinds this task adds/preserves Retry for.
  for (const kind of ['timeout', 'rate-limit', 'schema', 'unknown']) {
    let retried = false;
    const notice = showOnce(kind, new Error('boom'), 'boom', {
      onRetry: () => {
        retried = true;
      },
    });
    const btn = retryButton(notice);
    assert.ok(btn, `${kind}: Retry action is present when onRetry is supplied`);
    btn.dispatch('click');
    assert.strictEqual(retried, true, `${kind}: clicking Retry invokes ctx.onRetry`);
  }
}

function testRetryOmittedWhenNoOnRetrySupplied() {
  for (const kind of ['timeout', 'rate-limit', 'schema', 'unknown']) {
    const notice = showOnce(kind, new Error('boom'), 'boom');
    assert.strictEqual(retryButton(notice), undefined, `${kind}: no Retry action without onRetry`);
  }
}

function testCancelledKeepsLegacyBareNotice() {
  // 'cancelled' shares the pre-T5 fallback path with 'unknown' in the underlying if-chain
  // structure, but must NOT pick up the new actionable-notice treatment: cancellation is not
  // a failure to retry, and this preserves the exact legacy quiet-notice behavior.
  const notice = showOnce('cancelled', new Error('boom'), 'boom', { onRetry: () => {} });
  assert.strictEqual(findButtons(notice).length, 0, 'cancelled: still a bare notice with no buttons');
}

function testPreExistingBranchesUnaffectedByHoisting() {
  // network already had retry before this task; confirm the hoisted helper preserved it.
  let retried = false;
  const netNotice = showOnce('network', new Error('ECONNREFUSED'), 'ECONNREFUSED', {
    onRetry: () => {
      retried = true;
    },
  });
  const netRetry = retryButton(netNotice);
  assert.ok(netRetry, 'network: retains its pre-existing Retry action');
  netRetry.dispatch('click');
  assert.strictEqual(retried, true, 'network: clicking Retry still invokes ctx.onRetry');

  // auth and config never offered retry and are out of scope for this task (S4); they must
  // still have none, even though onRetry is supplied.
  const authNotice = showOnce('auth', new Error('401'), '401', { onRetry: () => {} });
  assert.strictEqual(retryButton(authNotice), undefined, 'auth: still has no Retry action');

  const configNotice = showOnce('config', new Error('config missing'), 'config missing', { onRetry: () => {} });
  assert.strictEqual(retryButton(configNotice), undefined, 'config: still has no Retry action');
}

function testRateLimitHasNoCountdownOrAutoRetryTimer() {
  // Explicitly rejected by the task spec: notices auto-hide (~12s) before a countdown could
  // fire, so a rate-limit retry must be a plain manual button, not a timed/auto one.
  const notice = showOnce('rate-limit', new Error('429 too many requests'), '429 too many requests', {
    onRetry: () => {},
  });
  const btn = retryButton(notice);
  assert.ok(btn, 'rate-limit: has a Retry action');
  assert.strictEqual(btn.textContent, 'Retry', 'rate-limit: Retry button has no countdown text appended');
}

testRetryOfferedForReRollableKinds();
testRetryOmittedWhenNoOnRetrySupplied();
testCancelledKeepsLegacyBareNotice();
testPreExistingBranchesUnaffectedByHoisting();
testRateLimitHasNoCountdownOrAutoRetryTimer();

console.log('error-ui tests passed');
