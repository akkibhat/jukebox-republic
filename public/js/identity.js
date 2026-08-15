// Every phone that joins a trip gets a stable random id stashed in
// localStorage, so refreshing the page (or a spotty connection dropping and
// reconnecting) doesn't lose your identity - it's how the fair-rotation
// "round" counter on the server stays tied to *you* specifically rather
// than resetting every time you reload.

const ID_KEY = 'cartunes_guest_id';
const NAME_KEY = 'cartunes_guest_name';

export function getOrCreateGuestId() {
  let id = localStorage.getItem(ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(ID_KEY, id);
  }
  return id;
}

export function getStoredName() {
  return localStorage.getItem(NAME_KEY) || '';
}

export function setStoredName(name) {
  localStorage.setItem(NAME_KEY, name);
}
