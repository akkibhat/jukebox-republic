// The heart of "musical democracy": turns a pile of submitted tracks into a
// play order that (a) stops any one person from dominating the queue and
// (b) lets the group vote a bad pick down and out. Every function here is
// pure (state in, state out) so it can be tested and reasoned about without
// touching sockets, Spotify, or timers.

/**
 * Fair ordering ("round-robin by contributor"):
 *
 * Instead of playing tracks in the order they were added (which lets
 * whoever mashes "add" fastest fill the whole queue), every track is
 * tagged with a `round` number: it's the Nth track *this particular guest*
 * has ever submitted in the session (1st, 2nd, 3rd track from them...).
 *
 * The queue is sorted by round first, then by when it was added. That
 * means everybody's 1st pick plays before anybody's 2nd pick, everybody's
 * 2nd before anybody's 3rd, and so on - like dealing cards around a table
 * instead of handing the whole deck to one player. A friend who joins
 * halfway through the trip still gets their first song up next, ahead of
 * songs 2+ from people who joined earlier.
 *
 * `round` is assigned once, at add-time, from a monotonically increasing
 * per-guest counter that never resets or reuses a number - even if a track
 * is later removed or skipped, that guest's *next* track still becomes
 * round N+1, not round N again. That keeps "how many turns have I had"
 * meaningful over the life of the session.
 */
export function nextRoundForGuest(guest) {
  guest.submissionCount += 1;
  return guest.submissionCount;
}

/**
 * Net votes (upvotes minus downvotes) don't jump a track ahead in the
 * rotation - fairness of *whose* song plays next takes priority over
 * popularity. What votes DO control is survival: enough downvotes and a
 * track sinks within its own round, and past a threshold it's pulled
 * entirely. This function produces a single sort key per track that
 * captures both rules in one comparison.
 *
 * netVotes is subtracted as a fractional nudge (netVotes * 0.01) so it can
 * only ever reorder tracks *within* the same round - it can never be large
 * enough to jump a track into an earlier round. A track needs roughly 100
 * net downvotes within one round to leapfrog the next round, which will
 * never happen in a car full of friends; this is purely a same-round tiebreaker.
 */
function sortKey(item) {
  return item.round - item.netVotes * 0.01;
}

/** Sorts a queue (array of track items) into fair play order. Does not mutate the input. */
export function sortQueue(queue) {
  return [...queue].sort((a, b) => {
    const keyDiff = sortKey(a) - sortKey(b);
    if (keyDiff !== 0) return keyDiff;
    // Stable tiebreaker for same round + same net votes: first added, first played.
    return a.addedAt - b.addedAt;
  });
}

/**
 * How many downvotes it takes for the group to skip/remove a track: simple
 * majority, half the connected car rounded up. Two people means either one
 * can veto a song outright (1 of 2 - there's no meaningful "majority" of
 * two, so one objection is enough). Three needs two people to agree.
 * Five needs three. It scales the same way regardless of how many people
 * are actually in the car - a fixed number (Apollo's old "3 votes")
 * either takes forever to hit with 2 people or gets curb-stomped by a
 * vocal minority once you're at 8, whereas "does more than half the room
 * agree" means the same thing at any size.
 */
export function downvoteThreshold(connectedGuestCount) {
  return Math.max(1, Math.ceil(connectedGuestCount / 2));
}

/**
 * Applies one guest's vote to a track. A guest can only hold one vote per
 * track at a time (voting the other way replaces it; voting the same way
 * again retracts it - tap to toggle). Returns the updated track and
 * whether it just crossed the skip/remove threshold.
 *
 * A guest can't downvote their own submission - without this, someone
 * could add a song and immediately downvote it themselves to fake progress
 * toward the skip threshold, which defeats the point of a *group* vote.
 */
export function applyVote(item, guestId, direction, connectedGuestCount) {
  if (direction === 'down' && item.addedBy.id === guestId) {
    return { item, shouldRemove: false, rejected: true, reason: "You can't downvote your own song." };
  }

  const already = item.votes.get(guestId);

  if (already === direction) {
    // Tapping the same button again retracts the vote.
    item.votes.delete(guestId);
  } else {
    item.votes.set(guestId, direction);
  }

  item.netVotes = 0;
  let downvotes = 0;
  for (const v of item.votes.values()) {
    item.netVotes += v === 'up' ? 1 : -1;
    if (v === 'down') downvotes += 1;
  }

  const threshold = downvoteThreshold(connectedGuestCount);
  const shouldRemove = downvotes >= threshold;

  return { item, shouldRemove, threshold, downvotes, rejected: false };
}
