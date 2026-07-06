'use strict';
// Identity fallback filter. The ONLY filter Phase 72 ships; the six real
// filters land in Phase 73. Must never throw and must return a string.
function transform(stdout /* , stderr, code */) {
  return typeof stdout === 'string' ? stdout : '';
}
module.exports = { id: '_passthrough', match: () => true, transform };
