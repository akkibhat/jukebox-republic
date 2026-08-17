import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDuplicate, makeQueueItem, addToFallbackTracks } from './sessionStore.js';

function session({ nowPlaying = null, queue = [], playHistory = [], fallbackTracks = [] } = {}) {
  return { nowPlaying, queue, playHistory, fallbackTracks };
}

test('detectDuplicate finds a match against what is currently playing', () => {
  const s = session({ nowPlaying: { uri: 'spotify:track:playing' } });
  assert.equal(detectDuplicate(s, 'spotify:track:playing'), 'playing');
});

test('detectDuplicate finds a match already in the queue', () => {
  const s = session({ queue: [{ uri: 'spotify:track:queued' }] });
  assert.equal(detectDuplicate(s, 'spotify:track:queued'), 'queued');
});

test('detectDuplicate finds a match in play history', () => {
  const s = session({ playHistory: [{ uri: 'spotify:track:played' }] });
  assert.equal(detectDuplicate(s, 'spotify:track:played'), 'played');
});

test('detectDuplicate returns null for a genuinely new track', () => {
  const s = session();
  assert.equal(detectDuplicate(s, 'spotify:track:fresh'), null);
});

test('detectDuplicate checks now-playing before queue before history, in that order', () => {
  // Same uri in all three places at once - nowPlaying must win.
  const uri = 'spotify:track:everywhere';
  const s = session({
    nowPlaying: { uri },
    queue: [{ uri }],
    playHistory: [{ uri }],
  });
  assert.equal(detectDuplicate(s, uri), 'playing');
});

test('makeQueueItem carries the track fields, the contributor, and starts with zero votes', () => {
  const track = { uri: 'spotify:track:x', name: 'Song', artist: 'Artist', albumArt: null, durationMs: 1000, explicit: false };
  const guest = { id: 'g1', name: 'Alex' };
  const item = makeQueueItem({ track, guest, round: 2 });

  assert.equal(item.uri, track.uri);
  assert.equal(item.name, track.name);
  assert.deepEqual(item.addedBy, { id: 'g1', name: 'Alex' });
  assert.equal(item.round, 2);
  assert.equal(item.netVotes, 0);
  assert.equal(item.votes.size, 0);
  assert.equal(item.duplicateReason, null);
});

test('addToFallbackTracks skips uris already in the pool', () => {
  const s = session({ fallbackTracks: [{ uri: 'spotify:track:already-in' }] });
  addToFallbackTracks(s, [{ uri: 'spotify:track:already-in' }, { uri: 'spotify:track:new' }]);
  assert.equal(s.fallbackTracks.length, 2);
});

test('addToFallbackTracks stops adding once the pool hits its 600-track cap', () => {
  const s = session({ fallbackTracks: Array.from({ length: 600 }, (_, i) => ({ uri: `spotify:track:${i}` })) });
  addToFallbackTracks(s, [{ uri: 'spotify:track:overflow' }]);
  assert.equal(s.fallbackTracks.length, 600, 'pool must not grow past the Firestore-doc-size cap');
});
