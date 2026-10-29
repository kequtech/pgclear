/** PostgreSQL has no year zero; ECMAScript ISO strings use astronomical year numbering. */
export function postgresTemporal(text: string): string {
  const match = /^([+-]?\d{4,6})(-\d{2}-\d{2}.*)$/.exec(text);
  if (!match) return text;
  const year = Number(match[1]);
  return year > 0
    ? String(year).padStart(4, '0') + match[2]
    : String(1 - year).padStart(4, '0') + match[2] + ' BC';
}

/** Normalize PostgreSQL ISO output for Date/Temporal parsers without choosing a local timezone. */
export function isoTemporal(text: string): string {
  const match = /^(\d{4,})(-\d{2}-\d{2}.*?)( BC)?$/.exec(text);
  if (!match) return text;
  const year = match[3] ? 1 - Number(match[1]) : Number(match[1]);
  const isoYear =
    year >= 0 && year <= 9999
      ? String(year).padStart(4, '0')
      : (year < 0 ? '-' : '+') + String(Math.abs(year)).padStart(6, '0');
  const iso = (isoYear + match[2]).replace(' ', 'T');
  return iso.includes('T') ? iso.replace(/([+-]\d{2})$/, '$1:00') : iso;
}

export function dateText(value: Date): string {
  return postgresTemporal(Date.prototype.toISOString.call(value));
}

export function dateFromText(value: string): Date {
  const iso = isoTemporal(value);
  const offset = /([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(iso);
  if (!offset) throw new TypeError('Expected an ISO timestamptz value.');
  const seconds = Number(offset[2]) * 3600 + Number(offset[3]) * 60 + Number(offset[4] ?? 0);
  const date = new Date(
    Date.parse(iso.slice(0, offset.index) + 'Z') - (offset[1] === '-' ? -seconds : seconds) * 1000,
  );
  if (!Number.isFinite(date.getTime()))
    throw new TypeError('Timestamp cannot be represented as Date.');
  return date;
}
