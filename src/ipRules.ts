import { isIP } from 'node:net';

/**
 * Pure classification of an IP-address string as unsafe for a public-facing
 * fetcher to connect to (loopback, private, link-local, CGNAT, reserved,
 * multicast, unspecified). IPv6 forms that embed an IPv4 address
 * (::ffff:x mapped, 2002::/16 6to4, 64:ff9b::/96 NAT64) are decomposed and the
 * embedded v4 is re-classified — that embedding is the standard SSRF bypass.
 *
 * Fails CLOSED: anything unparseable returns `true` (blocked).
 */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIPv4(parseIPv4(ip));
  if (kind === 6) {
    const bytes = expandIPv6(ip);
    if (!bytes) return true;
    return isBlockedIPv6(bytes);
  }
  return true; // not a valid IP literal
}

function parseIPv4(ip: string): number[] {
  return ip.split('.').map((o) => Number(o));
}

function isBlockedIPv4(o: number[]): boolean {
  if (o.length !== 4 || o.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return true;
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 unspecified
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255 broadcast
  return false;
}

/** Expand any IPv6 literal (with `::` compression and optional trailing v4) to 16 octets, or null. */
function expandIPv6(ip: string): number[] | null {
  let head = ip;
  const embeddedV4: number[] = [];
  const lastColon = head.lastIndexOf(':');
  const tail = head.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4.length !== 4 || v4.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
    embeddedV4.push(...v4);
    head = head.slice(0, lastColon + 1) + '0:0'; // replace trailing v4 with two 16-bit placeholder groups
  }
  const parts = head.split('::');
  if (parts.length > 2) return null;
  const toGroups = (s: string) => (s === '' ? [] : s.split(':'));
  const left = toGroups(parts[0]);
  const right = parts.length === 2 ? toGroups(parts[1]) : [];
  const explicit = left.length + right.length;
  const groups: string[] =
    parts.length === 2 ? [...left, ...Array(8 - explicit).fill('0'), ...right] : left;
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (let i = 0; i < 8; i++) {
    if (i >= 6 && embeddedV4.length === 4) {
      // the last two groups were the placeholder — substitute the real embedded v4 octets
      bytes.push(embeddedV4[(i - 6) * 2], embeddedV4[(i - 6) * 2 + 1]);
      continue;
    }
    const g = groups[i];
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

function isBlockedIPv6(b: number[]): boolean {
  // Unspecified :: and loopback ::1
  if (b.slice(0, 15).every((x) => x === 0) && (b[15] === 0 || b[15] === 1)) return true;
  // IPv4-mapped ::ffff:0:0/96 -> classify embedded v4
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff)
    return isBlockedIPv4(b.slice(12, 16));
  // IPv4-compatible (deprecated) ::/96 with non-zero tail -> classify embedded v4
  if (b.slice(0, 12).every((x) => x === 0) && !(b[12] === 0 && b[13] === 0 && b[14] === 0))
    return isBlockedIPv4(b.slice(12, 16));
  // NAT64 64:ff9b::/96 -> classify embedded v4
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0))
    return isBlockedIPv4(b.slice(12, 16));
  // 6to4 2002::/16 -> next 32 bits are the embedded v4
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIPv4(b.slice(2, 6));
  // fc00::/7 ULA
  if ((b[0] & 0xfe) === 0xfc) return true;
  // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;
  // ff00::/8 multicast
  if (b[0] === 0xff) return true;
  return false;
}
