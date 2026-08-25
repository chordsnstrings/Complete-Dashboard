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

### Pass 5 — 25 Aug 2026, the page that could never find anything

`#unauthorized` and all seven `#segments/*` routes rendered the panel **"Vehicles
with unexplained occupancy"** empty. The empty state was honest — "No vehicle
carries an unexplained segment in this range" — and the reason it was empty was
not.

Live, over thirty days:

```
authorized   149      partial      232
stationary    61      unverifiable  41
unauthorized   0
```

Zero, on the page whose entire subject is unauthorized trips. That zero reads as
"no leakage". It was **the verdict being unreachable**, twice over.

**The channel guard.** A journey may only be called unauthorized once every
booking channel has been consulted, so channels that reported nothing in the
window block the verdict. It was computed against a hardcoded
`['uber','yango','bolt','hotel']` — and this fleet has **never had a single bolt
booking**: 0 bookings, 0 rows, ever. So `bolt` was permanently unavailable, the
guard fired on every segment, and the branch below it never ran.

**The clock guard.** Telemetry whose clock disagrees with wall time cannot be
matched against bookings, so a skewed feed refuses to judge. It measured
`now - captured_at` — which is how **old** a fix is, and every fix in a
thirty-day window is days old by construction. The median came out around a
fortnight, sailed past the sixty-minute threshold, and the second half of the
test ("the window ends near now") is true of every window ending today. So every
recent window declared the fleet's clock suspect.

Both are plausible expressions measuring the wrong thing, and both fail the same
way: an empty page rather than an error.

| # | finding | fix |
|---|---|---|
| 16 | `unavailable` computed from a hardcoded channel list; bolt has never produced a booking, so the unauthorized verdict was unreachable | `blockingChannels(everSeen, inWindow)` — a channel the fleet has never used is not a channel; one it has used but that is silent this window still blocks |
| 17 | clock skew measured as data age, condemning every window that ends today | `clockSkewMin(fixes)` — `polled_at − captured_at`, the device's clock against ours at the moment we asked |
| 18 | `channels_checked` reported bolt as consulted on a fleet with no bolt | reports the set the verdict was actually reached against |
| 19 | neither guard was testable — `reconcile()` needs a database, so "can this branch be reached" could only be read | both are pure exported functions; `test/verdict_guards.test.mjs` (17 assertions) |

The clock guard keeps the failure it was written for: a tracker running four
hours behind still reads as 240 minutes of skew and still refuses verdicts, and
it is a **median**, so one broken tracker cannot stop the fleet being judged.

### Pass 6 — 25 Aug 2026, the second sweep

Re-ran `bin/render-audit.mjs` against production after the first five passes.

| code | pass 1 | pass 2 | |
|---|---:|---:|---|
| page-overflow | 105 | 2 | −103 |
| dead-column | 85 | 27 | −58 |
| silent-cap | 75 | **0** | −75 |
| bad-value | 48 | **0** | −48 |
| mostly-empty | 15 | **0** | −15 |
| clipped-text | 8 | **0** | −8 |
| empty-panel | 44 | 21 | −23 |
| overflow | 7 | 3 | −4 |
| sparse-column | 53 | 54 | +1 |
| blank-page | 18 | 18 | 0 |
| js/api-error | 12 | 12 | 0 |
| **total** | **471** | **138** | **−333** |

Routes with any finding: **103 → 33**.

#### What the second pass found

| # | finding | fix |
|---|---|---|
| 20 | `#retention`'s cohort grid used `.tbl-wrap`, a class **defined nowhere in app.css** — so twelve month-columns pushed the panel 60px past its edge and the document 137px past the window | `.tscroll`, which is the class that actually scrolls, and the one every `tableFrom` table already gets |
| 21 | `.kpi .s` carries identifiers like `ecosine:getCompanyEarnings` — no spaces to break at, so it ran 18px past the tile and was clipped | `overflow-wrap:anywhere`; half an endpoint name is not an endpoint name |
| 22 | `over_15km` and `telematics_journeys` are counts of **zero**, rendered as em-dashes. On a column whose neighbours are all measurements, a dash reads "not measured" — the opposite of what a zero means | zero renders as `0`; `absent` never fires on it, deliberately |
| 23 | `Hrs online` on Platform performance records — null on all 300 | `absent`, naming the 9-of-241 measurement |
| 24 | `Avg fare`, `Fare`, `Cost`, `Room`, slot `Fares` still bare | `absent` with the reason each was empty |
| 25 | `V.sources` had **no `alive(gen)` guard** — the longest view in the product, five panels and six fetches, and an abandoned render went on writing into panels the reader had left | guarded after every await, like every other long view |
| 26 | the field-inventory panel is the heaviest read on the page and sat on a bare skeleton | says what it is doing after 1.2s, so a slow answer looks slow rather than broken |

#### Three findings that were the auditor's own fault

Worth recording, because a harness that cries wolf gets ignored:

- **`blank-page` ×18** — `#day/not-a-date`, `#slot/9/99`, `#action/nope/-` and friends render one explanation and nothing else. That is the page *working*. The check now passes when the page explains itself.
- **`js-error` / `api-error` ×12** — the `#segment/<plate>/<at>` address needs both halves from the *same* row, and the substitution took the plate from one row and the timestamp from another. Six findings of the auditor's own making, every pass.
- **`silent-cap` on 10- and 12-row tables** — twelve months and ten categories are far more often complete than a `LIMIT`. Twenty false positives were burying the real caps.

#### One finding that is the *harness's* fault, not the product's

`test/smoke_views.mjs` reports `#sources` — and sometimes `#providers` and
`#settings` — as "still loading after 20s". **The failing set moves between
runs** (3, then 1), and all four pages are clean in isolation at a 20-second
settle with zero findings. `bin/live-ui.mjs` proxies every request to production
through one Node process; 104 routes at roughly six requests each saturate it,
and whichever page is in flight at the tail is the one that reports slow.

`#sources` is genuinely the heaviest page — six fetches including a scan over
every stored raw record — so it is the first to suffer. That is why the slow
panel now says so, and why the missing `alive()` guard was worth fixing on its
own merits. But the smoke failure is the bridge, not the page.

### Pass 7 — 25 Aug 2026, columns that are *mostly* empty

`sparse-column` was the largest remaining category (54), and between "every row"
and "most rows" there is no difference to the reader: **330 dashes under Fares
out of 361 drivers looks exactly as broken as 361 would.**

But the column has to stay — thirty-one people *do* have a fare, and which ones
(the hotel and Yango drivers) is the finding. So the same `absent` sentence a
dead column prints is now printed with the count in front of it:

> **Fares** — 31 of 361 rows carry one; Uber's trip export carries no fare
> column at all, and Uber is most of this fleet's work.

One declaration serves both states. A quarter is the line: above it a column
reads as populated with gaps, which is ordinary; below it the gaps are the
story. A table of fewer than eight rows says nothing at all — one of five is not
a pattern.

| # | finding | fix |
|---|---|---|
| 27 | 18 distinct mostly-empty columns, each a wall of dashes with no explanation | `tableFrom` counts what is filled and prints "N of M rows carry one" plus the reason |
| 28 | `Licence` (220 of 247 empty), `Rain` (28 of 30), `Standing` (37 of 40), and reconciliation's `Tips` / `Salik` / `Cash collected` / `Δ bank − expected` (12 of 13 months each) | each declares why — the money columns share one constant, because four wordings for one absence read as four separate problems |

#### 29 — two database enums in a row of product names

The tier table on `#vehicles` builds its columns from whatever the channels call
their products, and the channels do not agree on a convention. Uber sends
`Comfort` and `Black`; the hotel channel sends `drop_off` and `pick_and_drop`.
The header row read:

```
Electric · UberX · Comfort · Black · pick_and_drop · drop_off
```

Four product names and two database enum values, side by side. `tierLabel()`
touches **only the raw shape** — re-casing `UberX` to `Uberx` would be the same
mistake in the other direction. The same enums reached the `#day` tier legend,
and `#day` and `#slot` were labelling their platform donuts with raw keys rather
than `sourceLabel()`.

