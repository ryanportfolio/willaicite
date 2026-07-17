# Deployment

> Deploy target, build output, asset paths, publish flow.

### 2026-07-17: Verify against production, never a local server

User rule: do not verify changes by running the site/preview server locally. Browser and HTTP verification must hit the real deployed site (https://willaicite.com) after deploy. Unit tests (`npm test`, vitest) remain fine locally. If a change can only be confirmed on production, say so and stop rather than substituting a local check.
