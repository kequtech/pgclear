import { spaces, nothing, prohibited, unassigned, randal, ltr } from './saslprep-tables.js';

/** Match PostgreSQL/libpq preparation, including its original-password fallback. */
export function preparePassword(password: string): string {
  if (/^[\x00-\x7f]*$/.test(password) || !password.isWellFormed()) return password;
  const mapped: string[] = [];
  for (const character of password) {
    if (spaces.test(character)) mapped.push(' ');
    else if (!nothing.test(character)) mapped.push(character);
  }
  // PostgreSQL checks the mapped input, not the normalized output. In particular, a character
  // unassigned in Unicode 3.2 must not become acceptable through a modern compatibility mapping.
  if (!mapped.length || mapped.some((c) => prohibited.test(c) || unassigned.test(c)))
    return password;
  if (
    mapped.some((c) => randal.test(c)) &&
    (mapped.some((c) => ltr.test(c)) || !randal.test(mapped[0]!) || !randal.test(mapped.at(-1)!))
  )
    return password;
  return mapped.join('').normalize('NFKC');
}
