---
description: Study admired reference websites into a persistent design-learnings file future design work must consult. Use when the user says /design-study, sends links to study for design inspiration, or asks what prior site studies found.
---

# Design study — turn admired sites into reusable design intelligence

Produces and maintains `.claude/reference/design-learnings.html` — a self-contained, renderable dossier of every reference site studied, plus a running synthesis of principles to apply to CoreWise Academy. Any session doing visual/design work on this repo must read that file first.

Input: one or more URLs in `$ARGUMENTS` or in the user's message. If a URL is missing or ambiguous, ask once.

## Step 1: Visit and capture each site

For each URL, in a real browser (not just an HTTP fetch — these sites are usually animation- and JS-heavy):

1. Load the page. Let it settle; many reference sites reveal themselves through load animations.
2. Screenshot the initial viewport, then scroll through the full page capturing each distinct section or state change.
3. Interact where the design invites it: hover states, scroll-driven sequences, menus, page transitions to one or two secondary pages.
4. Inspect the substance behind the surface:
   - Typography: actual font families (computed styles), sizes, weights, letter-spacing, line-height, how the scale is used.
   - Color: extract the working palette as hex values (background layers, text, accents), how many colors, where saturation lives.
   - Layout: grid structure, density vs whitespace, alignment system, container widths.
   - Motion: what animates, triggers (load/scroll/hover), duration and easing character, whether motion carries meaning or decoration.
   - Advanced technique: WebGL/canvas/3D, shaders, masking, blend modes, scroll-jacking, custom cursors, noise/grain, view transitions. Name the technique, not just the effect.
5. If a site fails to load or blocks automation, say so and ask the editor for screenshots or a different URL — never fabricate observations.

## Step 2: Write the per-site entry

For each site, record in the learnings file:

- **What I see** — concrete observables from Step 1. Font names, hex values, timings, techniques. Never vague adjectives alone ("clean", "modern") — every adjective must be anchored to an observable.
- **Why the editor likely likes it** — a stated hypothesis connecting the site to the editor's known taste and goals (editorial quality, anti-AI-slop, recruiter audience). Mark it as hypothesis; invite correction.
- **What makes it stand out** — the one to three moves that separate it from a template site. Be specific about the craft.
- **Look and feel in one line** — a quotable summary.
- Embed 1–3 captured screenshots (compressed, as data URIs or repo-relative paths) and a swatch row of the extracted palette.

## Step 3: Refresh the synthesis section

The file ends with a synthesis that is rewritten (not appended) every run:

- Recurring principles across all studied sites so far.
- A "steal this / skip this" table: techniques worth adapting to CoreWise Academy vs. ones that conflict with its editorial identity.
- Open questions for the editor.

Principles, not clones: the synthesis must translate observations into rules for this project's own identity. Copying a studied site's look wholesale is failure.

## Step 4: Persist and confirm

1. Save/update `.claude/reference/design-learnings.html`. It must be self-contained (inline CSS, no external requests) and readable both as rendered HTML and as source.
2. Entries are cumulative — never delete a prior site's entry; update it if the same URL is re-studied.
3. Commit the updated file on the working branch with the rest of the session's work.
4. Reply with the distilled findings and the hypothesis ("why I think you like these") for the editor to confirm or correct — the correction is part of the learning loop; fold it back into the file.

## Consumption rule

Before any design, visual, or front-end aesthetic work in this repo: read `.claude/reference/design-learnings.html` if it exists. Treat its synthesis as design requirements, its per-site entries as evidence.

## Anti-patterns

- Don't fetch HTML and pretend you saw the design — motion and 3D only show in a real browser.
- Don't write taste-words without observables ("elegant", "premium" with nothing measurable behind them).
- Don't clone a studied site; extract principles and re-express them in CoreWise Academy's own identity.
- Don't overwrite or trim prior entries when adding new sites — only the synthesis section is rewritten.
- Don't skip the "why you like it" hypothesis — it's the part that makes the file a model of the editor's taste rather than a scrapbook.
