// Tests for the rule that picks which Spotify device a session plays on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDevice } from './playbackEngine.js';

const phone = { id: 'phone', type: 'Smartphone', isActive: false };
const airplay = { id: 'airplay', type: 'AudioDongle', isActive: false };

test('an active device wins, so a speaker the host chose keeps playing', () => {
  assert.deepEqual(pickDevice([phone, { ...airplay, isActive: true }]), { deviceId: 'airplay', otherDevices: 0 });
});

test('with nothing active, the phone is picked over a speaker listed first', () => {
  assert.deepEqual(pickDevice([airplay, phone]), { deviceId: 'phone', otherDevices: 0 });
});

test('with no phone and nothing active, nothing is picked and the others are counted', () => {
  assert.deepEqual(pickDevice([airplay]), { deviceId: null, otherDevices: 1 });
});

test('no devices at all', () => {
  assert.deepEqual(pickDevice([]), { deviceId: null, otherDevices: 0 });
});
