import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGoldenRecord } from './goldenRecord.js';

test('findGoldenRecord returns null for empty or missing history', () => {
  assert.equal(findGoldenRecord([]), null);
  assert.equal(findGoldenRecord(undefined), null);
});

test('findGoldenRecord returns null when nothing is net-positive', () => {
  const history = [{ id: 'a', netVotes: 0 }, { id: 'b', netVotes: -2 }];
  assert.equal(findGoldenRecord(history), null);
});

test('findGoldenRecord picks the highest net-upvoted entry', () => {
  const history = [{ id: 'a', netVotes: 1 }, { id: 'b', netVotes: 5 }, { id: 'c', netVotes: 3 }];
  assert.equal(findGoldenRecord(history).id, 'b');
});

test('findGoldenRecord ties go to whichever appears earlier in history (played earlier keeps it)', () => {
  // History is stored newest-first, so index 0 is the most recent play.
  const history = [{ id: 'newer', netVotes: 4 }, { id: 'older', netVotes: 4 }];
  assert.equal(findGoldenRecord(history).id, 'older');
});
