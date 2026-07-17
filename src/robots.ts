/**
 * robots.txt parser and matcher following the Google/RFC 9309 semantics that
 * matter for auditing: group selection by user-agent token, longest-match rule
 * precedence, allow wins ties, `*` and `$` wildcards.
 */

export interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
  line: number;
  raw: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export interface RobotsData {
  groups: RobotsGroup[];
  sitemaps: string[];
  raw: string;
}

export function parseRobots(text: string): RobotsData {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const noComment = rawLine.replace(/#.*$/, '');
    const m = noComment.match(/^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/);
    if (!m) {
      continue;
    }
    const field = m[1].toLowerCase();
    const value = m[2];

    if (field === 'user-agent') {
      if (!lastWasAgent || current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      if (current) {
        current.rules.push({ type: field, path: value, line: i + 1, raw: rawLine.trim() });
      }
    } else if (field === 'sitemap') {
      lastWasAgent = false;
      if (value) sitemaps.push(value);
    } else {
      lastWasAgent = false;
    }
  }
  return { groups, sitemaps, raw: text };
}

/**
 * Rules that apply to a crawler product token. The most specific matching
 * user-agent value wins (longest agent string that is a prefix of the token);
 * all groups naming that same value are merged. Falls back to `*` groups.
 */
export function rulesFor(robots: RobotsData, botToken: string): RobotsRule[] {
  const token = botToken.toLowerCase();
  let bestAgent: string | null = null;
  for (const group of robots.groups) {
    for (const agent of group.agents) {
      if (agent === '*') continue;
      if (token === agent || token.startsWith(agent)) {
        if (bestAgent === null || agent.length > bestAgent.length) bestAgent = agent;
      }
    }
  }
  const target = bestAgent ?? '*';
  const rules: RobotsRule[] = [];
  for (const group of robots.groups) {
    if (group.agents.includes(target)) rules.push(...group.rules);
  }
  return rules;
}

function patternToRegex(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') out += '.*';
    else if (ch === '$' && i === pattern.length - 1) out += '$';
    else out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out);
}

/**
 * RFC 9309 compares percent-decoded octets. Normalize both sides to one
 * canonical form instead: percent-encode non-ASCII (UTF-8) and uppercase
 * existing %XX escapes, so `Disallow: /café` matches a request for
 * `/caf%C3%A9` and vice versa. `*` and `$` survive encodeURI untouched.
 */
export function normalizeRobotsPath(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch.codePointAt(0)! > 126) {
      try {
        out += encodeURIComponent(ch); // UTF-8 percent-encoding; existing % stays untouched
      } catch {
        out += ch; // lone surrogate — keep raw
      }
    } else {
      out += ch;
    }
  }
  return out.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
}

export function pathMatches(pattern: string, path: string): boolean {
  if (pattern === '') return false;
  return patternToRegex(normalizeRobotsPath(pattern)).test(normalizeRobotsPath(path));
}

export interface AccessDecision {
  allowed: boolean;
  /** The rule that decided the outcome, if any. */
  rule: RobotsRule | null;
  /** Which user-agent group applied ('*' or the specific token). */
  viaGroup: string;
}

export function isAllowed(robots: RobotsData, botToken: string, path: string): AccessDecision {
  const token = botToken.toLowerCase();
  let bestAgent: string | null = null;
  for (const group of robots.groups) {
    for (const agent of group.agents) {
      if (agent === '*') continue;
      if (token === agent || token.startsWith(agent)) {
        if (bestAgent === null || agent.length > bestAgent.length) bestAgent = agent;
      }
    }
  }
  const viaGroup = bestAgent ?? '*';
  const rules = rulesFor(robots, botToken);

  // Longest-match precedence measured on the normalized (percent-encoded)
  // pattern, per the RFC's octet comparison.
  let winner: RobotsRule | null = null;
  let winnerLen = -1;
  for (const rule of rules) {
    if (rule.path === '') continue; // "Disallow:" (empty) permits everything
    if (!pathMatches(rule.path, path)) continue;
    const len = normalizeRobotsPath(rule.path).length;
    if (winner === null || len > winnerLen || (len === winnerLen && rule.type === 'allow' && winner.type === 'disallow')) {
      winner = rule;
      winnerLen = len;
    }
  }
  return { allowed: winner === null || winner.type === 'allow', rule: winner, viaGroup };
}
