# TrueNAS Apps catalog submission

`outpost/` is the app definition for the **community train** of the
[TrueNAS Apps catalog](https://github.com/truenas/apps). It lives here so it is
versioned alongside the runtime it pins; the catalog itself takes it by pull
request.

## Prerequisite: the pinned image must exist

`ix_values.yaml` pins `ghcr.io/sausin/outpost-ts:0.5.0` and `app.yaml` declares
`app_version: 0.5.0`. That tag is published by the release workflow when
`v0.5.0` is pushed — **do this before opening the PR**, or their CI will fail on
an unpullable image. The 0.5.0 image must include the dashboard, live config
reload, and `OUTPOST_HOSTS` / `OUTPOST_PROVIDERS` (the form's Hosts and
Providers lists are delivered through them), so tag from a `main` that has all
three:

```bash
git checkout main   # with the form-configuration work merged
git tag v0.5.0 && git push origin main v0.5.0
```

(`v0.4.0` predates the dashboard and `v0.4.1` predates the form support, so
neither works with this app definition.)

Separately, `ghcr.io/sausin/outpost-ts:0.3.2` is missing — the v0.3.2 release run
was cancelled after the Python image had pushed. Once the release workflow is on
`main`, backfill it from the Actions tab: **Release → Run workflow → tag
`v0.3.2`**. That rebuilds the exact-version tags without moving `latest`,
redeploying the Worker, or rewriting the release notes.

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
./.github/scripts/ci.py --app outpost --train community --test-file configured-values.yaml
./.github/scripts/port_validation.py
./.github/scripts/generate_metadata.py --app outpost --train community

# 4. Commit and open a DRAFT pull request using the app-addition template.
```

`ISSUE.md` is the announcement to file on truenas/apps first (their guide asks
for one before the PR, to avoid duplicate effort). `PULL_REQUEST.md` is their
app-addition template, filled in.

Attach `docs/assets/icon-512.png` and `docs/assets/dashboard.png` to the PR
description — a reviewer uploads them to the TrueNAS CDN and hands back the URLs
that replace the `icon:` placeholder in `app.yaml` and go into `screenshots:`
in `app.yaml` and `item.yaml`.

## How it lines up with the Traefik app

The catalog's Traefik app is the closest existing shape (a proxy with a
dashboard, a watched config directory, and credentials as env vars), so this
definition mirrors it deliberately:

| Traefik app                                   | Outpost app                                              |
| --------------------------------------------- | -------------------------------------------------------- |
| `TZ` question                                 | `TZ` question                                            |
| **Dashboard** toggle → `--api.dashboard`      | **Dashboard** toggle → `OUTPOST_DASHBOARD`               |
| **Entry Points** list → `--entrypoints.<n>.address` flags | **Hosts** and **Providers** lists → `OUTPOST_HOSTS` / `OUTPOST_PROVIDERS` (JSON) |
| `--providers.file.watch=true` on the config dir | `OUTPOST_CONFIG_WATCH=true` on the config dataset      |
| Form values validated, `tpl.funcs.fail` on conflicts (duplicate entry point, reserved flag) | Same: field regexes, then `fail` on duplicate names, missing credentials, empty allowlists |
| Portal on the API/dashboard port              | Portal on the web port, path `/dashboard`                |
| **Additional Environment Variables**          | Same field; credentials for file- or YAML-defined providers |
| `additional_args` (free-form CLI flags)       | **Advanced Settings (YAML)** per provider, and **Custom** authentication |
| Routes from Docker labels (needs the Docker socket) | Not used — see below                               |
| Plugins via a rebuilt image                   | `plugins/` on the config dataset, imported at runtime (`OUTPOST_PLUGINS_DIR`) |

### Why not labels?

Traefik reads routing rules from labels on *other* containers, which requires
mounting the Docker socket. Outpost's providers are not containers, so labels
would have to sit on Outpost's own container and be read back through that
same socket — root-equivalent access on the host, for a service whose whole
purpose is holding credentials. Form fields rendered into environment variables
give the same "configure it in the UI" experience with none of that exposure,
and they also work unchanged in plain Docker Compose.

### How the form reaches the runtime

- `OUTPOST_HOSTS` — the Hosts list as JSON, same shape as `hosts.yaml`.
- `OUTPOST_PROVIDERS` — the Providers list as JSON, same shape as a provider
  YAML. Custom authentication and Advanced Settings are passed as YAML strings
  (`auth`, `extra`) and validated by Outpost; a mistake there is shown on the
  dashboard with the rest of the configuration still running.
- A pre-shared key or credential typed into the form becomes its own variable
  (`OUTPOST_HOST_<NAME>_PSK`, `OUTPOST_PROVIDER_<NAME>_TOKEN`, `_USERNAME`,
  `_PASSWORD`) and the JSON references it by name.

Both variables are only set when the corresponding list is non-empty, and
Outpost merges them with the files on the dataset (an entry from the form wins
on a name clash). A deployment that uses only the files behaves exactly as
before.

## Checking the template locally without their CI image

`ci.py` needs `ghcr.io/truenas/apps_validation`. When that cannot be pulled,
the template can still be rendered with the library alone: clone `truenas/apps`
sparsely for `library/<lib_version>/`, import its modules as `ix_lib.base`, merge
`ix_values.yaml` with a test-values file, add `ix_context.app_metadata` from
`app.yaml`, and render `templates/docker-compose.yaml` with Jinja2 (`do`,
`loopcontrols` and `debug` extensions). The output is JSON. This catches every
template error and shows the notes and portal exactly as TrueNAS will.

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
environment contract. `lib_version` tracks the catalog's current render library
(`2.3.13`, the one the Traefik app is on); their CI fills in `lib_version_hash`.
