// The two non-guest "who added this" sources a track can have - the
// Autopilot Mix cycling in a pick, or the app adopting whatever's already
// playing directly on Spotify. Centralized here because the ids are
// load-bearing in several places (the self-downvote guard, the recap's
// per-guest filter, sessionRecap.js, sessionStore.js) that all need to
// agree these can never collide with a real guestId (a crypto.randomUUID()).

export const FALLBACK_CONTRIBUTOR = { id: 'fallback', name: 'Autopilot Mix' };
export const EXTERNAL_CONTRIBUTOR = { id: 'external', name: 'Playing on Spotify' };

/** True if this addedBy id is one of the synthetic sources above, not a real guest. */
export function isSyntheticContributor(id) {
  return id === FALLBACK_CONTRIBUTOR.id || id === EXTERNAL_CONTRIBUTOR.id;
}
