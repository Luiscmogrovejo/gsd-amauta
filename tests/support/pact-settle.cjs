'use strict';
/**
 * Let the mock server finish recording a request before PactV3 asks it for mismatches (88-07).
 *
 * PactV3.executeTest calls mockServerMismatches() the moment the test callback returns. On the CI
 * Linux runners that call ran while the mock server had already answered the client but not yet
 * recorded the match, so a passing interaction was reported as "request expected but not received".
 * After the callback, poll mockServerMatchedSuccessfully() (bounded) so the verdict is read once the
 * server has settled; an interaction that really was never received still fails, after the bound.
 */

const SETTLE_MS = Number(process.env.GSD_PACT_SETTLE_MS) || 2000;

/**
 * @param {import('@pact-foundation/pact').PactV3} provider
 * @returns {import('@pact-foundation/pact').PactV3} the same provider, with executeTest wrapped
 */
function settle(provider) {
  const original = provider.executeTest.bind(provider);
  provider.executeTest = (testFn) => original(async (server) => {
    const value = await testFn(server);
    const deadline = Date.now() + SETTLE_MS;
    while (Date.now() < deadline && !provider.pact.mockServerMatchedSuccessfully(server.port)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return value;
  });
  return provider;
}

module.exports = { settle };
