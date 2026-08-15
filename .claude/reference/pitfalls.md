# Pitfalls

> Accumulated project-specific gotchas. Dated entries, newest at the bottom. If this file exceeds ~200 lines, split by area (`pitfalls-<area>.md`) and update the CLAUDE.md index.

## Starter safety

This starter must not ship maintainer-only checkout paths, private workflow
rules, secrets, or local-machine assumptions. Put those in untracked personal
instructions or in a private fork-specific memory file instead.

Worktree changes are isolated. Before claiming a template change is available
somewhere else, verify the exact branch or checkout the user asked about. Do not
merge, pull into another checkout, or touch paths outside the current workspace
unless the user explicitly asks in the current session.

## Copy style (2026-07-17)

Em dashes ("—") are banned in all prose and site copy, permanently. Restructure
with a colon, comma, period, or parentheses instead.

## html zoom 1.4 coordinate chaos (2026-08-14)

The site applies `html { zoom: 1.4 }` at >=1064px. Engines disagree about
every coordinate space around it, and headless Chromium (Playwright) behaves
differently from real Chrome, so local-looking-correct is not proof:

- Root `clientWidth`/`innerWidth`/`scrollTop`/`scrollHeight` may be visual
  px while `offsetTop`/`offsetWidth` chains are always layout px. Never mix
  the families; convert via self-calibration (`scrollHeight / offsetHeight`)
  or `getComputedStyle(html).zoom`.
- A `position: fixed; top: 0; bottom: 0` element renders one viewport tall
  in headless Chromium but zoom-times taller in real Chrome, spilling below
  the fold. Measure `getBoundingClientRect().height` against
  `window.innerHeight` and set an explicit corrected height (see the
  retrieval gauge in `site/src/layouts/Base.astro`).
- Scroll events can be dropped for programmatic `scrollTo` in some builds,
  and rAF can be throttled to ~2fps in headless contexts: state that must
  track scrolling needs both an event listener and a per-frame mirror loop.
- 2px marks at zoomed fractional offsets render 2px vs 3px inconsistently;
  snap positions to the device grid (`Math.round(v * zoom) / zoom`).
- Rotated (writing-mode) text gets chromatic subpixel fringes; fractional
  opacity (0.999) plus `transform: translateZ(0)` forces grayscale AA.
