// The pattern « Ignorer ce message » offers for a journal (homelab#379): its text as a regular expression (RE2, the syntax
// of the log server), the parts that change from one line to the next made generic, so that the rule still holds at the
// next one: an identifier (UUID), a long hexadecimal value (hash, address), any number (a date, an hour, a pid, rbd0). The
// rest is kept as it is written: the server finds the line through its words (no (?i), it would read every line).

const MAX_SOURCE = 200;

// in order: the longest first, so that a UUID is not cut into numbers
const VARIABLE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\b(?=[0-9a-fA-F]*\d)(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{8,}\b|\d+/g;

export const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const generic = (token: string) => (token.includes('-') ? '[0-9a-fA-F-]{36}' : /^\d+$/.test(token) ? '\\d+' : '[0-9a-fA-F]+');

export function suggestPattern(message: string) {
  // the beginning of a long message is enough to find it again (the pattern is not anchored)
  const text = message.trim().slice(0, MAX_SOURCE);
  let out = '';
  let last = 0;
  for (const m of text.matchAll(VARIABLE)) {
    out += escapeRegex(text.slice(last, m.index)) + generic(m[0]);
    last = m.index + m[0].length;
  }
  return out + escapeRegex(text.slice(last));
}
