# Deployment

> Deploy target, build output, asset paths, publish flow.

### 2026-07-17: Deploys are manual `railway up`, not GitHub-linked

Merging to main does NOT deploy: the Railway project (willaicite, service willaicite → https://willaicite.com) has no GitHub integration. Deploy by running `railway up --detach` from an up-to-date main checkout at the repo root (CLI already linked + authed on this machine). Build ≈ 15 min (NIXPACKS, per railway.json). Poll with `railway deployment list --json` until SUCCESS, then verify on the live site. Symptom when forgotten: production serves a stale version (v1.2 stayed live for hours after the v1.3 merge).

### 2026-07-19: `railway up` archives the PRIMARY worktree, not your branch

Working in a git worktree (`.claude/worktrees/*`) where `.git` is a `gitdir:` pointer file? `railway up` resolves the repo root through that pointer and tars the **primary** worktree (`C:/Users/Home/CoreWise/willaicite`), NOT the current branch's files. If the primary checkout is behind `origin/main`, you deploy stale source and Docker cache-hits the old `COPY . /app` layer, so even a fresh `astro build` regenerates old HTML. Symptom: SUCCESS build, no CDN cache, but production keeps serving old content across repeated redeploys. Fix: fast-forward the primary checkout to `origin/main` first (`git -C C:/Users/Home/CoreWise/willaicite merge --ff-only origin/main`), then `railway up`. The `deploy-site` skill encodes this order.

### 2026-07-17: Verify against production, never a local server

User rule: do not verify changes by running the site/preview server locally. Browser and HTTP verification must hit the real deployed site (https://willaicite.com) after deploy. Unit tests (`npm test`, vitest) remain fine locally. If a change can only be confirmed on production, say so and stop rather than substituting a local check.
