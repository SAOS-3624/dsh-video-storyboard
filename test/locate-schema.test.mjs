import test from 'node:test';
import assert from 'node:assert/strict';

import { locateToolSpec } from '../src/tool-spec.js';

test('video_locate schema exposes cookies and allowAnonymous', () => {
  const parameters = locateToolSpec().parameters;

  assert.equal(parameters.cookies.type, 'string');
  assert.equal(parameters.allowAnonymous.type, 'boolean');
});
