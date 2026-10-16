// localStorage can throw (private window, blocked site data, quota). Every access goes
// through these two helpers so a storage failure never breaks the app.

export function loadString(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveString(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the URL still carries the state.
  }
}
