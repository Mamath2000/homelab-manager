import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { config } from './config.js';

// Rules of a password the user chooses (homelab#291). Checked when it is set only: the passwords already in place
// are kept as they are.
export const PASSWORD_MIN_LENGTH = 12;

// Leaked passwords of 12 characters or more, lowercased, one per line: the union of the top 1 000 000 lists of
// xato-net and Pwdb and of the 100 000 of the NCSC, from SecLists (MIT, Passwords/Common-Credentials). The shorter
// ones are refused by the length already.
const LIST_FILE = 'common-passwords.txt.gz';

let common: Set<string> | undefined;

function commonPasswords() {
  common ??= new Set(gunzipSync(readFileSync(resolve(config.assetsDir, LIST_FILE))).toString('utf8').split('\n').filter(Boolean));
  return common;
}

export type PasswordProblem = 'password too short' | 'password too common' | 'password same as username';

export function passwordProblem(password: string, username: string, list: () => Set<string> = commonPasswords): PasswordProblem | null {
  // length in characters, not in UTF-16 units
  if ([...password].length < PASSWORD_MIN_LENGTH) return 'password too short';
  const lower = password.toLowerCase();
  if (lower === username.toLowerCase()) return 'password same as username';
  if (list().has(lower)) return 'password too common';
  return null;
}
