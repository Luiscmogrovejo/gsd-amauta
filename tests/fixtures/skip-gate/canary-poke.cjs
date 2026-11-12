'use strict';
/**
 * A test file that writes to the live-store canary's watched `data/tasks.json`
 * (plan 88-19). Not named *.test.cjs, so the default glob never runs it.
 *
 * SAFETY: it writes to `$GSD_LIVE_CHECKOUT/data/tasks.json`, and the driving test
 * sets `GSD_LIVE_CHECKOUT` to a throwaway directory it created. It refuses to run
 * at all when that variable is unset or when the target is the operator's real
 * checkout, so it can never poke the live store even if it is run by hand.
 */

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

test('88-19 fixture: write to the fake live store, so the canary fires', () => {
  const live = process.env.GSD_LIVE_CHECKOUT;
  assert.ok(live, 'GSD_LIVE_CHECKOUT must be set to a throwaway directory');
  assert.ok(
    /88-19-canary|gsd-19-/.test(path.basename(live)),
    'refusing to write: ' + live + ' does not look like this test\'s throwaway directory'
  );
  const file = path.join(live, 'data', 'tasks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ id: 'TK-8819', title: 'canary poke' }] }));
});

test('88-19 fixture: and skip something unlisted at the same time', (t) => {
  t.skip('deliberate 88-19 mutation: an unlisted skip beside a canary finding');
});
