---
description: Deploy willaicite to Railway production and verify it live. Use when the user says /deploy-site, asks to deploy, ship, or push the site, or asks why a merged change is not live yet. Handles the git-worktree gotcha that ships stale source.
---

# deploy-site — ship willaicite to Railway and prove it live

Railway is NOT GitHub-linked: merging to `main` does not deploy. Deploy is a manual `railway up`, and there is a worktree trap that silently ships stale source. This skill runs the correct order and verifies against production.

## Step 0: Preconditions

- The change is committed and merged to `origin/main` (use `/merge` first if not). Railway only ever ships what `railway up` archives, so unmerged branch work must at least be pushed and the primary checkout synced (Step 2).
- Railway CLI is linked and authed on this machine (`railway status` shows project `willaicite`, service `willaicite`, url `https://willaicite.com`). If not, stop and tell the user to run `railway login` / `railway link` themselves.

## Step 1: Know what markers you are verifying

Before deploying, note 1-2 exact strings that should change on production (the new footer link, a removed sentence, a version bump). You will `curl` for these after deploy. "SUCCESS build" is not proof; serving the new HTML is.

## Step 2: Sync the PRIMARY worktree (the trap)

`railway up` tars the **primary** worktree (`C:/Users/Home/CoreWise/willaicite`), NOT your current `.claude/worktrees/*` branch. If that primary checkout is behind `origin/main`, you deploy old files and Docker cache-hits the stale `COPY . /app` layer, so production keeps serving old content no matter how many times you redeploy.

Fast-forward the primary checkout to the merged commit first:

```bash
git -C C:/Users/Home/CoreWise/willaicite fetch origin main --quiet
git -C C:/Users/Home/CoreWise/willaicite merge --ff-only origin/main
```

If it will not fast-forward (the primary checkout has diverging local commits or is on another branch), stop and surface that to the user — do not force it.

## Step 3: Deploy from the primary checkout

```bash
cd C:/Users/Home/CoreWise/willaicite && railway up --ci
```

`--ci` streams build logs and waits for completion (NIXPACKS build, per `railway.json`; the site is rebuilt via `astro build` and served by `node dist/cli.js serve`). Confirm the log shows `generating static routes` and `Deploy complete`. Do not use `railway redeploy` to ship new code — it re-runs the last deployment's snapshot, not your latest source.

## Step 4: Verify on production (never a local server)

Give Railway a moment to route, then curl the live site for your Step 1 markers. Windows sandbox: `curl` needs `--ssl-no-revoke`; `sleep` is broken, use `ping -n N+1 127.0.0.1` as a timer.

```bash
ping -n 8 127.0.0.1 >/dev/null
curl -s --ssl-no-revoke https://willaicite.com/ | grep -o '<your marker>'
```

If the marker is still absent after SUCCESS: the primary checkout was stale (re-check Step 2) or Railway is still routing (wait and re-curl). Only report done once the live HTML contains the change.

## Anti-patterns

- Don't `railway up` from the feature worktree assuming it ships your branch's files — it ships the primary checkout's files. Sync Step 2 first.
- Don't trust a SUCCESS build as "deployed." Confirm the live HTML changed.
- Don't verify with a local dev/preview server. HTTP/browser checks hit https://willaicite.com only; vitest stays local.
- Don't use `railway redeploy` to push new code — it redeploys the old snapshot.
- Don't force a non-fast-forward merge into the primary checkout to unblock a deploy.
