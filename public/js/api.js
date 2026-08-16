// Tiny shared fetch wrapper - host.js and guest.js each independently
// look up their session over HTTP before handing off to the socket layer,
// and both want the same "throw if it didn't work" shape.

/** Fetches a URL and parses it as JSON, throwing if the response isn't ok. */
export async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('request failed');
  return res.json();
}
