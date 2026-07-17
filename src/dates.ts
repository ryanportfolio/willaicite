/**
 * Timezone-stable date parsing. JS parses timezone-less date-times (and
 * month-name dates) in the machine's local zone, which makes freshness bands
 * and sitemap ordering differ across machines. Zone-less wall-clock times are
 * reinterpreted as UTC so the same fetched content scores identically
 * everywhere.
 */

const TZ_MARKED = /(?:Z|GMT|UTC|[+-]\d{2}:?\d{2})\s*$/i;
/** ISO date-only forms (YYYY, YYYY-MM, YYYY-MM-DD) already parse as UTC. */
const DATE_ONLY_ISO = /^\d{4}(-\d{2}(-\d{2})?)?$/;

export function parseDateUTC(raw: string): Date | null {
  const s = raw.trim();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  if (TZ_MARKED.test(s) || DATE_ONLY_ISO.test(s)) return d;
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
}
