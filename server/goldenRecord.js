// The "golden record" - the play history's most net-upvoted entry - is
// needed in two places: the live badge in the History tab (broadcast.js)
// and the end-of-session election results (sessionRecap.js). Shared here
// so there's one definition of "golden" instead of two that could drift.

/**
 * History is stored newest-first; ties go to whichever played EARLIER
 * (first to reach a score keeps it), which with this iteration order
 * means a later array entry only replaces an equal earlier one - hence
 * the >= comparison. Nothing qualifies until something is genuinely
 * net-positive; a badge for "least disliked at zero" would be no honor.
 */
export function findGoldenRecord(history) {
  let golden = null;
  for (const entry of history || []) {
    if (entry.netVotes > 0 && entry.netVotes >= (golden?.netVotes ?? 0)) {
      golden = entry;
    }
  }
  return golden;
}
