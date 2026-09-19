# App addition: Outpost (community train)

**Title:** `App addition: Outpost — credential-isolating proxy for AI agents`

---

I'd like to add [Outpost](https://github.com/sausin/outpost) to the community
train, and I'm opening this first per CONTRIBUTIONS.md so nobody duplicates the
work.

## What it is

Outpost sits between AI agents and the APIs they call. The agent sends its
request to Outpost with an `X-Provider` header; Outpost attaches the API
credential, applies a per-source-host policy and a per-provider path allowlist,
rate-limits, caches, and forwards it upstream. The agent gets the capability and
never holds the secret — so a prompt-injected agent can only make the calls the
YAML permits, and cannot exfiltrate a token it was never given.

Adding an upstream API is a YAML file, not code:

```yaml
name: github
base_url: https://api.github.com
auth: { type: bearer_static, env: GITHUB_TOKEN }
```

- Upstream: https://github.com/sausin/outpost
- Image: `ghcr.io/sausin/outpost-ts` (linux/amd64 + linux/arm64, SemVer tags)
- License: MIT

## Shape of the app

- Two long-lived containers: `outpost` and a sibling `outpost-redis`
  (`valkey/valkey`) for token storage, rate limiting and response caching.
- Both run as any non-root uid:gid, `cap_drop: [ALL]`, `no-new-privileges`.
- One config dataset at `/config` holding `hosts.yaml` and `providers/`; upstream
  seeds both with commented starters on first boot so a fresh install is not an
  empty directory.
- Provider credentials go in Additional Environment Variables, never on the
  dataset.
- Healthcheck runs the image's own entrypoint (no dependency on `curl`/`wget`
  being present); portal points at `/docs`.

## Status

The app definition is written and passing locally against `basic-values.yaml`. I
will open a draft PR shortly with the icon attached for CDN upload.

Happy to adjust anything about the questions.yaml layout or the category choice
(`security`) before you spend review time on it.
