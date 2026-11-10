# Codex Skill Compatibility

`.claude/skills/` remains Claude's source. An adapter exposes a workflow; it does not prove every runtime capability exists.

- **Native**: direct mapping.
- **Adapted**: Codex paths, approvals, or UI substitutions.
- **Capability-gated**: requires a currently exposed tool.
- **Claude-only**: no faithful Codex implementation.
- **Dangerous**: explicit authorization required for Git, deploy, migration, publish, or persistent side effects.

| Status | Skills |
|---|---|
| Native | `babysit-ci`, `brainstorming`, `bro`, `caveman`, `enhance-prompt`, `forge-repo-ui-skill`, `handoff-audit`, `recall`, `refine`, `servers`, `session-hub`, `showpiece`, `wrapup`, `writing`, `writing-plans` |
| Adapted | `addskill`, `apply-firmware`, `astra-review`, `claude-review`, `codex-review`, `deep-plan`, `fable-mode`, `init-project`, `lab`, `optimize-context`, `sync-starter`, `writing-skills` |
| Capability-gated | `advocate`, `arena`, `cache-loop`, `climb-loop`, `conversion-ux`, `dare`, `design-prototypes`, `design-study`, `impartial-review`, `long-horizon`, `motion-design`, `perf-loop`, `product-walkthrough`, `redesign-concepts`, `security-loop`, `seo-loop`, `ui-quality`, `untangle`, `why`, `wow-animation`, `wow-loop` |
| Dangerous | `adopt-repo`, `deploy-site`, `merge` |
| Claude-only | `astra-fullreview`, `codex-fullreview`, `codex-image-gen`, `coordinate`, `gauntlet`, `long-horizon-workflows` |

`advocate`, `impartial-review`, and `why` require fresh independent context; do not replace them with self-review and call it equivalent. `merge` becomes session-wide only after explicit `$merge` or an unambiguous auto-merge request. Current system, developer, sandbox, approval, and user instructions win. Resolve canonical resources from `.claude/skills/<name>/` and never claim a gated workflow ran unless its tools were used.

`node .claude/scripts/test-codex-contract.mjs` checks each active skill's frontmatter and reports the Codex catalog size. A skill with no classification, or more than one, is a warning, not a failure.
