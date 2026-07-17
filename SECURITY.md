# Security

## Threat model

`geo-audit serve`, when exposed publicly, takes an attacker-controlled URL and fetches it server-side. Without mitigation that is a Server-Side Request Forgery (SSRF) primitive: an attacker points it at `http://169.254.169.254/…` (cloud metadata), `http://localhost:6379/` (an internal service), or any internal host and reads the response through the audit output.

The local CLI (`geo-audit <url>`) is single-user and intentionally *not* guarded — auditing your own `localhost:3000` is a legitimate use. The guard applies to the **server** path.

## Mitigations

Implemented in `src/safeFetch.ts` and `src/ipRules.ts`:

- **Scheme/port allow-list:** http/https only, ports 80/443 only.
- **Address validation, fail-closed:** every A/AAAA record for the host is resolved and checked; loopback, RFC 1918 private, link-local (incl. `169.254.169.254`), CGNAT (100.64/10), benchmarking (198.18/15), multicast, reserved, and unspecified addresses are refused. Unparseable input is treated as blocked. IPv6 forms that embed IPv4 (`::ffff:`, `2002::/16` 6to4, `64:ff9b::/96` NAT64) are decoded and the embedded v4 is re-checked — that embedding is the classic bypass.
- **DNS-rebinding resistant:** the connection is pinned to the validated IP via a custom `lookup`, so the socket connects to exactly the address that was checked (no TOCTOU between the check and the connect).
- **Redirect re-validation:** redirects are followed manually, max 4 hops, and every hop's scheme, port, and resolved IP is re-validated.
- **Resource bounds:** whole-request timeout, response body streamed and capped at `maxBytes` (aborted mid-stream, not buffered-then-sliced), per-IP rate limit, global concurrency cap.

## Not covered (operator's responsibility)

- Run the process as an unprivileged user with no route to an internal network you care about — network egress policy is defense-in-depth on top of the app-level guard.
- TLS termination, HSTS, and DDoS protection belong to the platform/proxy (Railway, a CDN), not this process.
- The guard blocks by IP class, not by an allow-list; it does not stop fetches of *public* URLs an operator might independently consider undesirable.
- `--local` and `WILLAICITE_TRUST_PROXY=1` are footguns if misused: never run `--local` on a public server, and only set `TRUST_PROXY` when a proxy you control sets `X-Forwarded-For` (otherwise clients can spoof their IP and evade the rate limit).

## Reporting a vulnerability

Email the maintainer (see `package.json`/repo contact). Please do not open a public issue for an unpatched vulnerability.
