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
