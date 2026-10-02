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

Adding an upstream API is a few fields in the app form — name, base URL,
authentication type and credential, optionally the allowed routes — or a YAML
file, not code.

- Upstream: https://github.com/sausin/outpost
- Image: `ghcr.io/sausin/outpost-ts` (linux/amd64 + linux/arm64, SemVer tags)
- License: MIT

## Shape of the app

- Two long-lived containers: `outpost` and a sibling `outpost-redis`
  (`valkey/valkey`) for token storage, rate limiting and response caching.
- Both run as any non-root uid:gid, `cap_drop: [ALL]`, `no-new-privileges`.
- One config dataset at `/config` holding `hosts.yaml` and `providers/`; upstream
  seeds both with commented starters on first boot so a fresh install is not an
  empty directory, and watches the dataset so edits apply without a restart
  (as the Traefik app's config directory does).
- Hosts (who may call Outpost) and providers (what it can call) are structured
  lists in the app form, like the Traefik app's entry points. The template
  serialises them into environment variables; credentials typed into the form
  become their own variables and never land on the dataset.
- A **Dashboard** toggle (default on, like Traefik's) and the portal opens it: a
  read-only status page showing loaded providers, the host policy, config
  errors and the address the viewer arrives from. It never displays a
  credential value.
- Healthcheck runs the image's own entrypoint (no dependency on `curl`/`wget`
  being present).

## Status

The app definition is written and passing locally against `basic-values.yaml`. I
will open a draft PR shortly with the icon and a dashboard screenshot attached
for CDN upload.

Happy to adjust anything about the questions.yaml layout or the category choice
(`security`) before you spend review time on it.
