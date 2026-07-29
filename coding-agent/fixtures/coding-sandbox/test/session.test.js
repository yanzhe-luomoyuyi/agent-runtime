import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSession, getUserName } from '../src/session.js';

test('getUserName returns the user name for a valid session', () => {
  const session = createSession({ name: 'ada' });
  assert.equal(getUserName(session), 'ada');
});

test('getUserName returns anonymous when session is null', () => {
  assert.equal(getUserName(null), 'anonymous');
});
