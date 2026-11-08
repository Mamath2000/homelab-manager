import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { closeStreams } from '../src/events.js';

test('closeStreams without an open stream does nothing', () => {
  assert.doesNotThrow(() => closeStreams({ userId: new ObjectId(), sessionId: 'x', apiKeyId: new ObjectId() }));
});
