# TrueNAS Apps catalog submission

`outpost/` is the app definition for the **community train** of the
[TrueNAS Apps catalog](https://github.com/truenas/apps). It lives here so it is
versioned alongside the runtime it pins; the catalog itself takes it by pull
request.

## Submitting it

```bash
# 1. Fork https://github.com/truenas/apps, then:
git clone https://github.com/<you>/apps.git && cd apps
git checkout -b add-outpost

# 2. Drop the app in. Nothing outside ix-dev/ is touched.
cp -r /path/to/outpost/catalog/truenas-apps/outpost ix-dev/community/outpost

# 3. Run their CI locally (devbox provides the toolchain).
devbox shell
./.github/scripts/ci.py --app outpost --train community --test-file basic-values.yaml
./.github/scripts/port_validation.py
./.github/scripts/generate_metadata.py --app outpost --train community

# 4. Commit and open a DRAFT pull request using the app-addition template.
```

`ISSUE.md` is the announcement to file on truenas/apps first (their guide asks
for one before the PR, to avoid duplicate effort). `PULL_REQUEST.md` is their
app-addition template, filled in.

Attach `docs/assets/icon-512.png` to the PR description — a reviewer uploads it
to the TrueNAS CDN and hands back the URL that replaces the `icon:` placeholder
in `app.yaml`.

## What is deliberately not here

- `templates/library/` — the render library, copied in by
  `apps_catalog_hash_generate`. Auto-generated; the contribution guide asks for
  it to be left out of the PR.
- `lib_version_hash` in `app.yaml` is empty for the same reason: their CI fills
  it in to match whichever `lib_version` is current.
- `templates/rendered/` — build output, gitignored upstream.

## Keeping it in sync

`ix_values.yaml` pins `ghcr.io/sausin/outpost-ts` to an exact version, and
`app.yaml`'s `app_version` must match that tag. Once merged, TrueNAS's update
bot bumps both on each new SemVer release, so nothing here needs touching for a
routine release — only for changes to the form, the template, or the
environment contract.
