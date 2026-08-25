# Page audit — every view, every width

A running log of what each audit pass found and what was done about it. Kept in
the repository rather than in a chat window, because a finding nobody can look
up later is a finding that gets found again.

## How to reproduce a pass

```bash
node bin/live-ui.mjs &                  # bridges the local UI to the production API
node bin/render-audit.mjs               # every route, three widths, DOM-level checks
node bin/page-audit.mjs                 # every endpoint behind every view
node bin/live-audit.mjs                 # every arithmetic invariant
node test/smoke_views.mjs               # every route renders at all
```

`bin/render-audit.mjs` writes `docs/audit/render-<date>.json` — the raw
findings, so two passes can be diffed rather than re-read.

## What each harness can and cannot see

| harness | proves | blind to |
|---|---|---|
| `test/smoke_views.mjs` | the page renders without throwing | a page of empty panels |
| `bin/page-audit.mjs` | the endpoints answer | what the page does with the answer |
| `bin/live-audit.mjs` | the numbers add up | numbers that are absent |
| `bin/render-audit.mjs` | the page is legible and complete | whether the figures are right |

All four are needed. A view can pass the first three and still be a bad page:
four panels of which three say "no data", a table silently capped at forty rows
out of nine hundred, a column of dashes where money should be, or nine columns
running off the edge of a half-width panel.

## The checks `render-audit` applies

1. **bad-value** — `NaN`, `undefined`, `[object Object]`, `Invalid Date` reaching the screen as text.
2. **stuck-loading** — a panel still on its skeleton after the page settled.
3. **mostly-empty** / **empty-panel** — how much of a page has nothing in it.
4. **dead-column** / **sparse-column** — a table column that is em-dashes in every row.
5. **silent-cap** — a table ending on exactly a round number with no caption saying whether that is all of them.
6. **overflow** / **page-overflow** — content wider than the box holding it; the padding class of bug.
7. **clipped-text** — text cut off by its own box with no `title` to recover it.
8. **chartless-panel** — a panel named for a chart with no chart in it.
9. **silent-panel** — a heading with neither data nor an empty state under it.
10. **wrong-title** — a view titled after another view: the router failing while rendering perfectly.
11. **js-error** / **api-error** — thrown exceptions and 4xx/5xx from the page's own fetches.
12. **blank-page** — no KPI, no table, no chart, no panel.

---

## Pass log

### Pass 1 — 25 Aug 2026, infrastructure

Not a page finding, but the most visible error in the product: **every deploy
included five to six minutes of a dashboard that does not load.**

The API answers 503 while `migrate()` runs, and `migrate()` replayed all
thirty-one schema files in full on every boot. Three of them contain
`DELETE FROM insight a USING insight b` — a self-join over a table holding
thirty thousand rows, which is roughly nine hundred million row comparisons.
Each hit the two-minute statement timeout, failed, was logged, and was
swallowed. Every boot. For months.

That cost twice over:

- **Four to six minutes of 503 per deploy**, which is what the operator sees as
  "the site is broken again".
- **The de-duplication never once completed.** The `insight` table stayed 99.3%
  duplicates (29,634 rows describing 204 findings) while three separate places
  in this codebase claimed to be pruning it — and the unique indexes
  `schema_v15` creates immediately after its purge could never be built,
  because the rows they forbid were still there.

| # | finding | fix |
|---|---|---|
| 1 | `sql/schema_v15.sql` de-duplication is a quadratic self-join; times out every boot | rewritten as an anti-join against a `DISTINCT ON` keep-set — O(n log n) |
| 2 | `sql/schema_v31.sql` same statement, same outcome | same rewrite, same tiebreak so the two cannot disagree |
| 3 | `src/insights.js` prunes after every generation with the same self-join — so the prune that was supposed to stop the duplicates accumulating never ran | same rewrite |
| 4 | every schema file replayed in full on every boot, successful or not | `schema_applied` ledger keyed on the SHA-256 of each file's contents; a matching hash is skipped, an edited file re-runs exactly once, a failed file is not recorded and retries |
| 5 | `test/schema.mjs` recovered the schema list by regex over `src/db.js`'s `for (const f of [...])` — changing that loop's shape would have failed every database-backed test at once | list moved to `src/schema_files.js` and **imported** by both |
| 6 | `route_smoke` banned any test naming a schema file, which also banned asserting *about* one | narrowed to what it means: an array literal holding two or more schema filenames — that is a hand-maintained list; naming one file to assert about its SQL is not |

Guarded by `test/migrate.test.mjs` (16 assertions): no schema file or collector
path deletes a table by joining it to itself; the anti-join keeps exactly one
row per `(code, entity_type, entity_id)` and it is the newest; it is idempotent;
the unique indexes it exists to make possible are creatable afterwards; and the
ledger is keyed on content, writes only after success, and degrades to full
replay if the ledger table cannot be created.

### Pass 2 — 25 Aug 2026, two pages that had been 500ing in production

Probing every list endpoint against the live database for fields that are null
in **every** row turned up something worse than a null: two endpoints returning
`{"error":"internal"}`.

```
/api/insights   → 500      the Action list
/api/retention  → 500      Joiners & leavers
```

Both are the same root cause as Pass 1, and neither would have been found by a
harness that only checks whether a page renders — the page renders, it renders
its error box.

`sql/schema_v31.sql` adds three columns:

- `rollup_person_month.fleets` — which `/api/retention` filters on
- `insight.refs` — which `/api/insights` selects
- `provider_probe.described_n`

and it contains, between them, the quadratic `DELETE` from Pass 1. **A
migration file is one implicit transaction.** The `DELETE` hit the statement
timeout, the transaction aborted, and every `ALTER` in the file rolled back with
it. So the columns never existed, the two routes that read them 500ed on every
request, and `src/rollup.js` — which writes `fleets` — was failing the same way.

The two pages were not broken by anything on the pages. They were broken by a
`DELETE` seventy lines above the `ALTER` they depend on, in a file that reported
its own failure to a log nobody reads and carried on booting.

| # | finding | fix |
|---|---|---|
| 7 | `/api/insights` 500s — `insight.refs` does not exist | Pass 1's rewrite lets `schema_v31` commit |
| 8 | `/api/retention` 500s — `rollup_person_month.fleets` does not exist | same |
| 9 | `src/rollup.js` writes `fleets` into a column that is not there | same |

**The general lesson, worth stating because it will happen again:** a data
statement and a structural statement in the same migration file are coupled by
the transaction. A slow `DELETE` does not merely fail — it takes every `ALTER`
in the file down with it, silently, and the damage shows up somewhere else
entirely as a 500 on an unrelated page.

### Pass 3 — 25 Aug 2026, columns that are empty in every row

Probing the live endpoints for fields that are null in **every** row:

```
/api/drivers/directory   360 rows   rating   null on all 360
/api/roster              279 people rating, acceptance_rate, cancellation_rate,
                                    completion_rate, hours_online, earnings — all 0% filled
/api/compliance/drivers  114 rows   rating   null on all 114
```

**Why they are empty**, which is the part the page could not say: `stateRow()`
in `src/roster.js` — the builder every source writes `driver_platform_state`
through — sets state, reason, plate, vehicle and `can_earn`, and no score.
Uber's roster endpoint (`/v1/vehicle-suppliers/drivers/actions`) returns
onboarding status and a vehicle; its earnings breakdown returns trips, distance
and money. Nothing in the collector writes a rating because no channel this
fleet is connected to reports one.

360 em-dashes under a heading that says "Rating" is worse than no column. A dash
could mean this driver has no rating, or the fleet has none, or the collector is
broken, or the page is — and a column that is empty in every row has nothing to
compare against, so the reader cannot tell which.

| # | finding | fix |
|---|---|---|
| 10 | `rating` is null for all 360 drivers; the column renders 360 dashes | `tableFrom` columns may declare `absent`: the column is dropped and the reason printed under the table |
| 11 | six roster metrics (`rating`, three rates, `hours_online`, `earnings`) are structurally unwritable — `stateRow()` has no field for them | recorded below as collector work; the UI now states it rather than implying it |

The mechanism is **opt-in on purpose**. Dropping any column that happens to be
empty would hide a collection failure the day a source stops reporting; a column
with no `absent` keeps its dashes, because the caller has not said what an
absence there would mean. Zero is never empty — a rating of zero is a rating and
a count of zero is a finding.

Guarded by `test/absent_columns.test.mjs` (18 assertions, run in Chromium
against the real module rather than a DOM shim).

**Follow-up, not done here:** filling those six columns is collector work
against endpoints we have not proven exist. `REPORT_TYPE_PAYMENTS_ORDER` and
`analytics-data/query` are the two candidates already identified for fares and
hours. Until one is proven, the honest thing is the sentence, not a dash.

### Pass 4 — 25 Aug 2026, the full render sweep

`bin/render-audit.mjs` against production: **104 routes × 3 widths = 312
page-renders**, 471 findings.

```
page-overflow 105 · dead-column 85 · silent-cap 75 · sparse-column 53
bad-value 48 · empty-panel 44 · blank-page 18 · mostly-empty 15
clipped-text 8 · overflow 7 · js-error 6 · api-error 6 · stuck-loading 1
```

#### 12 — every page scrolled sideways on a phone

At an 820px viewport the document was **3,836px wider than the window** on 105
of the 312 renders — effectively the whole product. One cause: below 820px the
sidebar becomes a horizontal strip and `#nav` lays twenty-nine destinations out
in a `nowrap` row, 4,641px of it.

A grid item and a flex item both default to `min-width:auto` — "never narrower
than my content" — so that measurement propagated straight up: `.side` took
4,658px, the grid column took 4,658px, the body took 4,658px. The `overflow-x:auto`
already on `#nav` could not help, because `#nav` itself was never asked to be
narrow.

Fixed with `min-width:0` on `#app > *`, `.side` and `#nav`. Verified: `overview`,
`drivers`, `unit`, `day`, `reconcile` and `providers` all measure exactly 820 now.

#### 13 — `fleet=undefined`, and three panels of a healthy-looking lie

`#compare` reported **"No booking on either day"** across three panels, over a
database holding 293 bookings that day.

`URLSearchParams` stringifies whatever it is handed, so
`{ fleet: state.fleet || undefined }` went over the wire as `fleet=undefined`.
A route reading `req.query.fleet || null` sees a non-empty string and filters on
a fleet by that name. Nothing matches. Every layer below behaved correctly — the
request was well-formed, the query ran, the answer was an honest zero for the
filter it was given — and the page rendered a perfectly healthy empty state with
no error and no warning.

The worst class of front-end bug: no stack trace, no red, a page that looks like
an answer. Only a DOM-level audit finds it.

`params()` and `unfiltered()` now drop empty values once, rather than two hundred
call sites each remembering to. A legitimate zero survives — `offset=0` is the
first page, not "no offset".

| # | finding | fix |
|---|---|---|
| 12 | body 3,836px wider than an 820px window on 105 renders | `min-width:0` on the shell's grid and flex items |
| 13 | `fleet=undefined` emptied `#compare` | `params()`/`unfiltered()` drop null and empty; `#compare` stopped passing it |
| 14 | no test could catch a third occurrence | `test/query_params.test.mjs` bans `x \|\| undefined` inside any `q()`/`qAll()` argument |
| 15 | `/api/driver/trips` and `/api/vehicle/trips` returned a bare array capped at `limit` with no total — "the server sent the 500 newest" is unusable when the reader cannot know 500 of how many | both return `{rows, total, shown, offset, limit, truncated}`; both tabs say "500 of 1,247 loaded" and offer **Load the next 500** |

