// The "election results" shown when a session ends: a short recap computed
// from the play history's frozen vote tallies (see addToPlayHistory) at the
// moment the host stops the session. Computed server-side and sent along
// with the session:ended event, since by the time clients render it the
// session itself has already been torn down.
import { findGoldenRecord } from './goldenRecord.js';
import { isSyntheticContributor } from './syntheticContributors.js';

/**
 * History is stored newest-first, so iterating in array order visits the
 * most recent plays first. Per-guest award ties are broken in favor of the
 * *earlier* play (first to reach the score keeps it), which with this
 * iteration order means a later array entry replaces an equal earlier one -
 * hence the >= comparisons below. Golden record uses the same rule, via
 * the shared findGoldenRecord (also used for the live badge in broadcast.js).
 */
export function buildSessionRecap(session) {
  const history = session.playHistory;

  const recap = {
    totalPlayed: history.length,
    // Everyone who ever joined, not just who's still connected at the end -
    // someone who left early still voted and contributed.
    guestCount: session.guests.size,
    goldenRecord: null,
    peoplesChampion: null,
    topContributor: null,
    impeached: null,
  };

  if (history.length === 0) return recap;

  recap.goldenRecord = findGoldenRecord(history);

  // --- Per-guest aggregates ---------------------------------------------
  // Keyed by guest id; synthetic contributors (Autopilot Mix, external
  // Spotify takeovers) are skipped - awards are for people. Their tracks
  // can still win golden record above, though.
  const byGuest = new Map();
  for (const entry of history) {
    const { id, name } = entry.addedBy;
    if (isSyntheticContributor(id)) continue;

    const stats = byGuest.get(id) || { name, played: 0, totalNetVotes: 0, votedOut: 0 };
    stats.name = name; // keep the latest name in case they renamed mid-session
    stats.played += 1;
    stats.totalNetVotes += entry.netVotes;
    if (entry.votedOut) stats.votedOut += 1;
    byGuest.set(id, stats);
  }

  for (const stats of byGuest.values()) {
    // The people's champion: whoever's picks earned the most net upvotes
    // overall. Same "must actually be positive" rule as the golden record.
    if (stats.totalNetVotes > 0 && stats.totalNetVotes >= (recap.peoplesChampion?.totalNetVotes ?? 0)) {
      recap.peoplesChampion = { name: stats.name, totalNetVotes: stats.totalNetVotes };
    }
    // Top contributor: most songs actually played (not just added - a
    // pick that got voted out before playing doesn't count here).
    if (stats.played >= (recap.topContributor?.played ?? 1)) {
      recap.topContributor = { name: stats.name, played: stats.played };
    }
    // Impeached: most picks voted out by the group. Only awarded if it
    // actually happened - a clean session has no impeachment.
    if (stats.votedOut > 0 && stats.votedOut >= (recap.impeached?.votedOut ?? 0)) {
      recap.impeached = { name: stats.name, votedOut: stats.votedOut };
    }
  }

  return recap;
}
