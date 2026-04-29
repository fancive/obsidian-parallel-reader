const { assert, t } = require('./test-setup');

const plugin = new t.ParallelReaderPlugin();
const failedFile = { path: 'failed.md' };
const originalConsoleError = console.error;

plugin.cacheManager = { get: () => null };
plugin.jobs = {
  isRunning: () => false,
  start: async () => {
    throw new Error('backend down');
  },
};
plugin.t = (key) => key;

(async () => {
  console.error = () => {};
  try {
    await assert.doesNotReject(
      () => plugin.runForFile(failedFile, false),
      'single-file UI path should keep handling errors internally',
    );

    await assert.rejects(
      () => plugin.runForFile(failedFile, false, { rethrowErrors: true }),
      /backend down/,
      'batch path should be able to count failed generation attempts',
    );
  } finally {
    console.error = originalConsoleError;
  }

  console.log('plugin batch tests passed');
})();
