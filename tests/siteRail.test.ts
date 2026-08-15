// Verify harness for the site's retrieval gauge (the custom scrollbar in
// site/src/layouts/Base.astro). Checks the constraint contract that the
// gauge was designed under; a violation here is a bug, not a taste call.
// Render-level verification happens against production after deploy.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const base = readFileSync('site/src/layouts/Base.astro', 'utf8');
const pages = ['index', 'about', 'crawlers', 'example'].map((name) => ({
  name,
  html: readFileSync(`site/src/pages/${name}.astro`, 'utf8'),
}));

const railCss = (() => {
  const start = base.indexOf('/* ---------- retrieval gauge ---------- */');
  const end = base.indexOf('</style>', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return base.slice(start, end);
})();

describe('retrieval gauge contract', () => {
  it('rail markup exists, is presentational, and starts hidden', () => {
    expect(base).toContain('class="scrollrail" id="scrollrail" aria-hidden="true" hidden');
  });

  it('accent appears exactly once in the rail CSS: the active section tick', () => {
    const uses = railCss.match(/var\(--accent\)/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(railCss).toContain('.tick.active::before { background: var(--accent)');
  });

  it('rail CSS introduces no new colors beyond the shared paper-grain texture', () => {
    expect(railCss.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    const grain = 'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(128,116,90,0.025) 3px, rgba(128,116,90,0.025) 4px)';
    // Any rgba in the rail block must be the body's existing grain, verbatim.
    const rgbaCount = (railCss.match(/rgba\(/g) ?? []).length;
    expect(railCss).toContain(grain);
    expect(rgbaCount).toBe(2); // both inside the one grain gradient
    expect(base.indexOf(grain)).toBeLessThan(base.indexOf(railCss.slice(0, 40))); // grain predates the rail
  });

  it('ticks are generated from the real section rules, one per h2.rulelabel', () => {
    expect(base).toContain("querySelectorAll<HTMLElement>('h2.rulelabel')");
    for (const p of pages) {
      const rules = p.html.match(/class="rulelabel"/g) ?? [];
      expect(rules.length, `${p.name} should have section rules to tick`).toBeGreaterThanOrEqual(3);
    }
  });

  it('only the literals "top", "eof" and the eof verdict are invented; everything else is measured', () => {
    expect(base).toContain("let label = 'top'");
    expect(base).toContain("'eof · 100% · retrieved in full'");
    // Percent readouts are zero-padded to echo the page's numbered rules.
    expect(base).toContain("padStart(2, '0')");
  });

  it('marks stay distinct and attributable: halo punch-through, ticks above bracket, readout rides the bracket', () => {
    expect(railCss).toContain('box-shadow: 0 0 0 2px var(--paper)');
    expect(railCss).toContain('.rail-ticks { position: absolute; inset: 0; pointer-events: none; z-index: 2; }');
    expect(railCss).toContain('top: calc(100% + 14px)');
    // Caption placement is measured, never overrunning the rail.
    expect(base).toContain('below + capLen <= g ? below : Math.max(0, tpx - 14 - capLen)');
  });

  it('scroll metrics are self-calibrated and delivered twice: scroll listener plus per-frame mirror loop', () => {
    expect(base).toContain('docEl.scrollHeight / Math.max(1, docEl.offsetHeight)');
    expect(base).toContain('requestAnimationFrame(mirror)');
    expect(base).toContain("window.addEventListener('scroll'");
  });

  it('tick and bracket positions snap to the device pixel grid under zoom', () => {
    expect(base).toContain('Math.round(v * zoomF) / zoomF');
  });

  it('rail height self-corrects where fixed elements are mis-sized under zoom', () => {
    expect(base).toContain('(window.innerHeight * lay) / rb.height');
  });

  it('margin guard measures in one coordinate space (visual px divided by zoom)', () => {
    expect(base).toContain('(window.innerWidth - sheet.getBoundingClientRect().width) / 2 / zoom');
  });

  it('native scrolling is mirrored, never intercepted', () => {
    expect(base).not.toContain("addEventListener('wheel'");
    expect(base).not.toContain("addEventListener('keydown'");
    expect(base).not.toContain("addEventListener('touchmove'");
  });

  it('gauge motion stands down under prefers-reduced-motion', () => {
    expect(railCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(railCss).toContain('transition: none');
  });

  it('gauge disappears in print and on narrow viewports', () => {
    expect(railCss).toContain('@media print { .scrollrail { display: none; } }');
    expect(railCss).toContain('@media (max-width: 1063px) { .scrollrail { display: none; } }');
  });

  it('no em dashes anywhere in the layout', () => {
    expect(base).not.toContain('—');
  });
});
