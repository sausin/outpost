# Outpost — X launch post

Two formats below. Replace `github.com/<you>/outpost` with the real URL before posting.

---

## Option A — Thread (8 posts)

**1/**
```
AI agents have a quiet security problem.

Every API key they need — Stripe, OpenAI, brokerages, anything —
lives in agent memory.

One prompt injection or log leak and it's gone.

Built Outpost to fix that.
```

**2/**
```
Outpost is an open-source HTTP sidecar.

Your agent calls localhost. The sidecar injects auth,
enforces rate limits, caches responses, and allowlists which
endpoints the agent can reach.

The agent never sees a secret.
```

**3/**
```
Three lines of YAML to add any API:

  name: stripe
  base_url: https://api.stripe.com
  auth: {type: bearer_static, env: STRIPE_SECRET_KEY}

Drop in builtin_providers/, restart.
Your agent now reaches Stripe via X-Provider: stripe.
```

**4/**
```
Auth covers ~95% of APIs out of the box. Ten modules ship in:

bearer_static
bearer_redis
api_key_header
api_key_query
basic_auth
hmac_signed   (Binance, Coinbase)
oauth2_client_credentials   (auto-refresh)
custom_headers
none
plugin   (escape hatch)
```

**5/**
```
Two forwarding modes:

Transparent — forward everything. Writes flagged sensitive
by default.

Allowlist — only listed paths pass; the rest 404.

Production trading? Allowlist.
Quick experiment? Transparent.
Either way: full auth + caching + rate limits.
```

**6/**
```
Rate limiter that doesn't fall over.

Multi-window token buckets (10/sec + 250/min + 2000/30min —
match whatever the upstream documents). Atomic Lua in Redis.

When upstream returns 429, the sidecar cool-downs ALL workers.
No thundering herd on retry.
```

**7/**
```
Host-based access via source IP.

hosts.yaml maps CIDRs to permission flags. Your read-only
research agent hits /quotes but not /order/place. Enforced
at the proxy. Out of agent code entirely.

"Sensitive" is the gate. Default: every write is sensitive.
```

**8/**
```
Built right:

FastAPI + Redis + httpx (HTTP/2)
uv + ruff
Multi-stage Alpine image. Runs as UID 10001.
Apache 2.0.
Sidecar-ready for Docker and k8s.

Outpost — the edge sidecar for AI agents.

→ github.com/<you>/outpost
```

---

## Option B — Single banger

```
AI agents leak API keys.

Stripe, OpenAI, brokerage tokens — every secret lives in
agent memory. One prompt injection and it's gone.

Outpost is an open-source sidecar that holds the keys for you.
3 lines of YAML per API.

→ github.com/<you>/outpost
```

---

## Posting notes

- Tweet 1 is the hook — strongest single line. Alt: swap "Built Outpost to fix that" → "So I built Outpost." (punchier).
- Tweet 3 with the 3-line YAML is the screenshot-worthy one. Consider attaching a styled code-image (Carbon, Ray) for reshares.
- Tweet 8 is the CTA. Kinder alternate: replace `→` with `Star it, fork it, add your favorite API:`.
- Best timing: 9–11am ET on Tue/Wed/Thu. Quote-RT yourself ~4 hours later with one line from the body.

## Variants to consider later

- Long-form X Article (~800 words): the problem, design philosophy, three opinionated choices, screenshots.
- LinkedIn: same arc, less terse, more "here's why this matters for engineering teams."
- Hacker News: lead with the engineering tradeoffs (transparent vs allowlist, multi-window limiter, Lua atomicity, why uv+ruff).
