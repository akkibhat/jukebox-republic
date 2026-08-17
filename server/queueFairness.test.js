import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRoundForGuest, sortQueue, downvoteThreshold, applyVote } from './queueFairness.js';

function track({ round, netVotes = 0, addedAt = 0, addedById = 'guest-x' }) {
  return {
    id: `${round}-${addedAt}-${addedById}`,
    round,
    netVotes,
    addedAt,
    addedBy: { id: addedById },
    votes: new Map(),
  };
}

test('nextRoundForGuest counts up per-guest and never resets', () => {
  const guest = { submissionCount: 0 };
  assert.equal(nextRoundForGuest(guest), 1);
  assert.equal(nextRoundForGuest(guest), 2);
  assert.equal(nextRoundForGuest(guest), 3);
});

test('sortQueue fair mode: everyone plays their round-1 pick before anyone plays round 2', () => {
  const queue = [
    track({ round: 2, addedAt: 1, addedById: 'a' }),
    track({ round: 1, addedAt: 2, addedById: 'b' }),
    track({ round: 1, addedAt: 1, addedById: 'a' }),
  ];
  const sorted = sortQueue(queue, 'fair');
  assert.deepEqual(
    sorted.map((t) => t.id),
    ['1-1-a', '1-2-b', '2-1-a']
  );
});

test('sortQueue fair mode: net votes reorder within a round but do not cross round boundaries at realistic magnitudes', () => {
  // The round unit is worth 100 vote units (round - netVotes * 0.01), so
  // this only holds under ~100 net votes either way - see queueFairness.js's
  // own comment on sortKey. 20 is a realistic ceiling for a car full of
  // friends, nowhere near that crossover.
  const queue = [
    track({ round: 2, netVotes: 20, addedAt: 1 }),
    track({ round: 1, netVotes: -20, addedAt: 1 }),
  ];
  const sorted = sortQueue(queue, 'fair');
  assert.equal(sorted[0].round, 1, 'round 1 must play before round 2 at realistic vote magnitudes');
});

test('sortQueue crowd mode: higher net votes play first', () => {
  const queue = [track({ round: 1, netVotes: 1 }), track({ round: 1, netVotes: 5 })];
  const sorted = sortQueue(queue, 'crowd');
  assert.equal(sorted[0].netVotes, 5);
});

test('downvoteThreshold is a simple majority, minimum 1', () => {
  assert.equal(downvoteThreshold(0), 1);
  assert.equal(downvoteThreshold(1), 1);
  assert.equal(downvoteThreshold(2), 1);
  assert.equal(downvoteThreshold(3), 2);
  assert.equal(downvoteThreshold(5), 3);
  assert.equal(downvoteThreshold(8), 4);
});

test('applyVote rejects a guest downvoting their own song', () => {
  const item = track({ round: 1, addedById: 'author' });
  const result = applyVote(item, 'author', 'down', 4);
  assert.equal(result.rejected, true);
  assert.equal(item.votes.size, 0);
});

test('applyVote toggles: voting the same way twice retracts the vote', () => {
  const item = track({ round: 1, addedById: 'author' });
  applyVote(item, 'voter', 'up', 4);
  assert.equal(item.netVotes, 1);
  applyVote(item, 'voter', 'up', 4);
  assert.equal(item.netVotes, 0);
  assert.equal(item.votes.has('voter'), false);
});

test('applyVote crosses the skip threshold at simple majority of connected guests', () => {
  const item = track({ round: 1, addedById: 'author' });
  const r1 = applyVote(item, 'v1', 'down', 4); // threshold = 2
  assert.equal(r1.shouldRemove, false);
  const r2 = applyVote(item, 'v2', 'down', 4);
  assert.equal(r2.shouldRemove, true);
});
