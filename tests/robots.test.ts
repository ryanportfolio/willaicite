import { describe, it, expect } from 'vitest';
import { parseRobots, isAllowed, rulesFor, pathMatches } from '../src/robots.js';
import { fixture } from './helpers.js';

describe('parseRobots', () => {
  it('parses groups, multi-agent groups, and sitemaps', () => {
    const robots = parseRobots(fixture('robots-blocking.txt'));
    expect(robots.groups).toHaveLength(4);
    expect(robots.groups[2].agents).toEqual(['claudebot', 'claude-searchbot']);
    expect(robots.sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });

  it('records line numbers and raw text for evidence', () => {
    const robots = parseRobots(fixture('robots-blocking.txt'));
    const gptbotRule = robots.groups[1].rules[0];
    expect(gptbotRule.raw).toBe('Disallow: /');
    expect(gptbotRule.line).toBe(5);
  });

  it('ignores comments and blank lines', () => {
    const robots = parseRobots('# hello\n\nUser-agent: * # inline\nDisallow: /x # comment\n');
    expect(robots.groups[0].rules[0].path).toBe('/x');
  });

  it('keeps a group open across Sitemap and unknown records between User-agent lines', () => {
    for (const between of ['Sitemap: https://x.test/s.xml', 'Crawl-delay: 5', 'Content-Signal: ai-train=no']) {
      const robots = parseRobots(`User-agent: GPTBot\n${between}\nUser-agent: ClaudeBot\nDisallow: /\n`);
      expect(robots.groups).toHaveLength(1);
      expect(isAllowed(robots, 'GPTBot', '/a').allowed).toBe(false);
    }
  });

  it('starts a new group at a User-agent line after rules, even past an unknown record', () => {
    const robots = parseRobots('User-agent: GPTBot\nDisallow: /\nCrawl-delay: 5\nUser-agent: ClaudeBot\nAllow: /\n');
    expect(robots.groups).toHaveLength(2);
    expect(isAllowed(robots, 'ClaudeBot', '/a').allowed).toBe(true);
  });

  it('accepts bare CR line endings', () => {
    const robots = parseRobots('User-agent: GPTBot\rDisallow: /\r');
    expect(isAllowed(robots, 'GPTBot', '/a').allowed).toBe(false);
  });

  it('reduces a User-agent value to its product token', () => {
    const robots = parseRobots('User-agent: GPTBot/1.1\nDisallow: /\n');
    expect(robots.groups[0].agents).toEqual(['gptbot']);
    expect(isAllowed(robots, 'GPTBot', '/a').allowed).toBe(false);
  });
});

describe('isAllowed', () => {
  const robots = parseRobots(fixture('robots-blocking.txt'));

  it('blocks a bot with its own Disallow: / group', () => {
    const d = isAllowed(robots, 'GPTBot', '/guide');
    expect(d.allowed).toBe(false);
    expect(d.rule?.raw).toBe('Disallow: /');
    expect(d.viaGroup).toBe('gptbot');
  });

  it('blocks every member of a multi-agent group', () => {
    expect(isAllowed(robots, 'ClaudeBot', '/').allowed).toBe(false);
    expect(isAllowed(robots, 'Claude-SearchBot', '/').allowed).toBe(false);
  });

  it('falls back to the wildcard group for unlisted bots', () => {
    expect(isAllowed(robots, 'Bingbot', '/guide').allowed).toBe(true);
    expect(isAllowed(robots, 'Bingbot', '/admin/panel').allowed).toBe(false);
    expect(isAllowed(robots, 'Bingbot', '/admin/panel').viaGroup).toBe('*');
  });

  it('longer path wins: Allow overrides broader Disallow', () => {
    expect(isAllowed(robots, 'PerplexityBot', '/private/data').allowed).toBe(false);
    expect(isAllowed(robots, 'PerplexityBot', '/private/press/release').allowed).toBe(true);
  });

  it('empty Disallow allows everything', () => {
    const allowAll = parseRobots(fixture('robots-allow-all.txt'));
    expect(isAllowed(allowAll, 'GPTBot', '/anything').allowed).toBe(true);
  });

  it('allows everything when there are no rules at all', () => {
    const empty = parseRobots('');
    expect(isAllowed(empty, 'GPTBot', '/x').allowed).toBe(true);
  });

  it('allow wins a specificity tie', () => {
    const robots2 = parseRobots('User-agent: *\nDisallow: /page\nAllow: /page\n');
    expect(isAllowed(robots2, 'GPTBot', '/page').allowed).toBe(true);
  });

  it('matches tokens exactly: an Applebot group does not govern Applebot-Extended', () => {
    const robots2 = parseRobots('User-agent: Applebot\nDisallow: /\n\nUser-agent: *\nAllow: /\n');
    expect(isAllowed(robots2, 'Applebot', '/a').allowed).toBe(false);
    const ext = isAllowed(robots2, 'Applebot-Extended', '/a');
    expect(ext.allowed).toBe(true);
    expect(ext.viaGroup).toBe('*');
  });

  it('treats /robots.txt itself as allowed', () => {
    const robots2 = parseRobots('User-agent: *\nDisallow: /\n');
    expect(isAllowed(robots2, 'GPTBot', '/robots.txt').allowed).toBe(true);
    expect(isAllowed(robots2, 'GPTBot', '/robots.txt.bak').allowed).toBe(false);
  });
});

describe('pathMatches wildcards', () => {
  it('supports * and $', () => {
    expect(pathMatches('/*.pdf$', '/docs/file.pdf')).toBe(true);
    expect(pathMatches('/*.pdf$', '/docs/file.pdfx')).toBe(false);
    expect(pathMatches('/private*', '/private/anything')).toBe(true);
    expect(pathMatches('/private', '/privateer')).toBe(true); // prefix match per spec
    expect(pathMatches('', '/x')).toBe(false);
  });

  it('escapes regex metacharacters in patterns', () => {
    expect(pathMatches('/a+b', '/a+b')).toBe(true);
    expect(pathMatches('/a+b', '/aab')).toBe(false);
  });

  it('normalizes percent-encoding: raw UTF-8 pattern matches encoded path and vice versa', () => {
    expect(pathMatches('/café', '/caf%C3%A9')).toBe(true);
    expect(pathMatches('/caf%C3%A9', '/café')).toBe(true);
    expect(pathMatches('/caf%c3%a9', '/caf%C3%A9')).toBe(true); // hex case-insensitive
    expect(pathMatches('/café', '/cafe')).toBe(false);
  });

  it('decodes escapes of unreserved characters only', () => {
    expect(pathMatches('/%7Euser', '/~user')).toBe(true);
    expect(pathMatches('/~user', '/%7euser')).toBe(true);
    expect(pathMatches('/a%2Fb', '/a/b')).toBe(false); // %2F is reserved; stays encoded
  });
});

describe('rulesFor group selection', () => {
  it('prefers the most specific agent token over wildcard', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /\nUser-agent: GPTBot\nAllow: /\n');
    const rules = rulesFor(robots, 'GPTBot');
    expect(rules).toHaveLength(1);
    expect(rules[0].type).toBe('allow');
  });

  it('merges multiple groups naming the same agent', () => {
    const robots = parseRobots('User-agent: GPTBot\nDisallow: /a\nUser-agent: GPTBot\nDisallow: /b\n');
    expect(rulesFor(robots, 'GPTBot')).toHaveLength(2);
  });
});
