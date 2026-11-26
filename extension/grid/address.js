/** Turns typed text into an http(s) URL, or null if it isn't a plausible address. */
export function parseAddress(text) {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  let candidate = t;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    const host = t.split(/[/?#:]/)[0];
    const local = host.toLowerCase() === 'localhost';
    if (!local && !host.includes('.')) return null;
    candidate = `${local ? 'http' : 'https'}://${t}`;
  }
  try {
    const u = new URL(candidate);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}
