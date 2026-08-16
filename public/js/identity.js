// Every phone that joins a session gets a stable random id stashed in
// localStorage, so refreshing the page (or a spotty connection dropping and
// reconnecting) doesn't lose your identity - it's how the fair-rotation
// "round" counter on the server stays tied to *you* specifically rather
// than resetting every time you reload.

const ID_KEY = 'jukebox_republic_guest_id';
const NAME_KEY = 'jukebox_republic_guest_name';

/** This phone's stable id, minted once and reused on every rejoin. */
export function getOrCreateGuestId() {
  let id = localStorage.getItem(ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(ID_KEY, id);
  }
  return id;
}

/** The name this phone last joined under, or '' if they've never set one. */
export function getStoredName() {
  return localStorage.getItem(NAME_KEY) || '';
}

/** Remembers the name so returning guests skip the prompt. */
export function setStoredName(name) {
  localStorage.setItem(NAME_KEY, name);
}
