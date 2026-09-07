# Fleet dashboard — read this before you touch anything

A live analytics dashboard over the Ecosine and Egari fleets. Six upstream
providers (Uber, a hotel corporate channel, Yango, Bolt, FMS/InfoTrack
telematics, CABMAN), one Postgres, one collector worker, one read API, one
static front end. Everything of consequence lives under `collector/`.

This file exists because the same questions were being re-measured every
session and the same traps were being re-discovered. **Read the standing notes
below before starting work, and write down anything new you learn about a
provider's API or about this codebase, in the file that owns that subject.**
A finding nobody can look up later is a finding that gets found again.

## The standing notes, and what each one owns

| file | what it answers |
|---|---|
| `collector/docs/COVERAGE.md` | What we actually hold per provider, measured — coverage by month, what each provider does **not** give us, credential shapes and lifetimes, when each collector runs, and a **"Traps that have cost time more than once"** section. **Read the traps section first.** |
| `collector/docs/AUDIT.md` | Every view at every width: what each rendering pass found and what was done. How to reproduce a pass. |
| `collector/docs/FIX-STATUS.md` | What is written vs. what is on production vs. what is *proven*, per fix. "Fixed" is four different states here. |
| `collector/docs/FIXLIST-2026-09-05.md` | The standing defect list — what is wrong. |
| `collector/README.md` | What each source gives, how to run the collector locally. |
| `docs/*.md` | Upstream API references (fleet tracking, analytics/reporting, unauthorized trips). |

When you fix something or learn something new about an upstream API, append it
to the right file **in the same commit as the fix**. Traps go in COVERAGE.md.

## Layout

```
collector/
  src/           collectors, one module per source under src/sources/
  api/           server.js (read API) + public/ (the front end, plain ESM)
  api/public/    one file per view; ui.js = shared components; charts.js = SVG
  sql/           schema_vNN.sql, replayed in order on every boot
  test/          212 .test.mjs files, run with `npm test`
  bin/           audit + local-serving tools
  docs/          the standing notes above
```

## Hard rules

**Never edit an existing `sql/schema_vNN.sql`.** Migrations replay from the
start on every boot and the ledger skips shas it has already seen, so an edit
to an old file silently does nothing on production. Add a new numbered file
**and** register it in `src/schema_files.js`.

*The one exception:* `sql/schema_v53.sql` is **generated** from
`api/identity_map.js` by `bin/gen-schema-v53.mjs` and is meant to be
regenerated whenever the merge register changes — it drops and re-adds the
`person_key` generated column and recreates its indexes, and its guard probes
the LAST alias id plus the WHEN count, so a column built from an older
register rebuilds instead of being skipped. Edit the register, run
`node bin/gen-schema-v53.mjs`, and never hand-edit the .sql.

**Who is one person lives in `api/identity_map.js`,** a hand-reviewed LIST of
verified pairs — never a name rule. It applies 93 entries over 90 people
(3 hand-checked, 45 from a shared-custody sweep, 45 on a phone number the
roster filed against both records) and deliberately holds back 5 that carry a
simultaneous trip in two cars. `docs/COVERAGE.md` carries the measurements.
`mergedIds`/`canonicalName` union across every entry on a key: three people are
on the list twice.

**`test/mount.mjs` slices `api/server.js` and injects globals.** Any new import
added to `server.js` must be added there too, or the whole API test suite dies
with an unhelpful error.

**A figure that cannot be measured renders ABSENT WITH A REASON** — never as
zero, and never with a reason that is not the true one. This is the house
principle the dashboard exists to uphold. If you cannot prove a number, say
what is missing and why, in the UI, in plain English.

**Credentials never enter the repository.** Not in code, not in tests, not in
docs, not in a commit message. Real tokens live outside the checkout. Quote at
most a few characters of one in any report.

**Verify on production before claiming a deployment works.** Screenshots, every
modal filled. The production API caches — always append `&_=$RANDOM`.

## Verifying

```bash
cd collector
npm test                        # all 212 suites; ONE run at a time (see traps)
node bin/live-ui.mjs            # :8100 — working-tree UI against production data
node bin/prod-mirror.mjs        # :8200 — production bytes, exactly as deployed
npm run audit:pages             # every endpoint behind every view, five windows
```

Chromium in this sandbox **has no route to the internet**. Point it at :8100 or
:8200 and launch with `executablePath: '/opt/pw-browsers/chromium'`.

## Deploying

DigitalOcean App Platform. `POST
https://api.digitalocean.com/v2/apps/$APP_ID/deployments`, then poll the
deployment's `phase` until `ACTIVE`. The app id and token are held outside the
repo. Both services are `basic-xxs` with ephemeral disk — nothing may be
written to local disk and expected to survive.

## Working style here

- Long explanatory block comments are the house style: state the defect, the
  measurement that proved it, and the reasoning. Not "fixes bug".
- Prove a fix by reverting it and watching the test fail. A test that passes
  against the unchanged file has proved nothing — this has produced a false
  "fixed" claim more than once.
- Before believing a green suite, `grep` the source to confirm the edit landed.
