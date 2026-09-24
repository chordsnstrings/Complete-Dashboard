# Page audit — every view, every width

A running log of what each audit pass found and what was done about it. Kept in
the repository rather than in a chat window, because a finding nobody can look
up later is a finding that gets found again.

## How to reproduce a pass

```bash
node bin/live-ui.mjs &                  # bridges the local UI to the production API
node bin/render-audit.mjs               # every route, three widths, DOM-level checks
node bin/page-audit.mjs                 # every endpoint behind every view, five windows
node bin/live-audit.mjs                 # every arithmetic invariant
node bin/numbers-audit.mjs              # every figure fetched reached the screen
node bin/cap-audit.mjs                  # every server LIMIT that is biting
node bin/slice-audit.mjs                # every list the PAGE cut
node bin/link-audit.mjs                 # every internal link is a well-formed address
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
| `bin/numbers-audit.mjs` | a figure the page fetched reached the screen | a figure nothing fetched |
| `bin/cap-audit.mjs` | a server `LIMIT` is or is not biting | a cut the PAGE made |
| `bin/slice-audit.mjs` | a list the page cut says so | a cut made in the query |
| `bin/link-audit.mjs` | every link is a well-formed address | whether it leads anywhere useful |

All eight are needed. A view can pass the first three and still be a bad page:
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
13. **slow-panel** — a skeleton that fills only after a second settle: not broken, but the reader waits.
14. **index-pinned** — a scrolling table whose pinned first column is a rank rather than the row's identity (`bin/numbers-audit.mjs`).
15. **window-drift** — an identity fact that changes with the range selector under a label that does not name a window (`bin/numbers-audit.mjs`).

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

### Pass 8 — 25 Aug 2026, the third sweep

| code | pass 1 | pass 3 |
|---|---:|---:|
| page-overflow | 105 | **0** |
| dead-column | 85 | **0** |
| silent-cap | 75 | **0** |
| bad-value | 48 | **0** |
| empty-panel | 44 | **3** |
| blank-page | 18 | **0** |
| mostly-empty | 15 | **0** |
| clipped-text | 8 | **0** |
| overflow | 7 | **0** |
| js-error / api-error | 12 | **0** |
| sparse-column | 53 | 54 |
| stuck-loading | 1 | 1 |
| **total** | **471** | **58** |

Routes with any finding: **103 → 15**. Ten of thirteen categories are at zero.

The 54 remaining `sparse-column` findings are from a pass that ran *before* the
sparse disclosure shipped — every one of those columns now prints "N of M rows
carry one" and the reason. The next sweep measures that.

| # | finding | fix |
|---|---|---|
| 30 | `#vehicle/<plate>/movement` — an empty segment table fell through to `tableFrom`'s default, "No data for this range yet", on a page that has just drawn a map of that vehicle's parking | says what IS held: "5 days of fixes are stored and 44 stationary periods were found — the tracker was reporting; it never saw a run of fixes with the seat occupied" |
| 31 | `/api/live` picked one row per plate with `ORDER BY plate, polled_at DESC`. CABMAN returns the last known position of **every** vehicle on **every** cycle, so all 130 rows in a cycle tie on `polled_at` — and which one Postgres keeps under a tie is arbitrary. The map could show a position older than one already in the table, and the staleness banner would agree with it, because it read the chosen row's own `captured_at` | orders on `captured_at`, the only column that orders *positions*; a fix captured in the future is a tracker whose clock runs ahead rather than a newer position, so those sort last; `polled_at` breaks the remaining ties so the result is deterministic. `test/live_fix.test.mjs`, 10 assertions |

#### The one finding that stays unreproducible

`stuck-loading` on `#driver/<id>/earnings` at 820px — one render out of 312, and
not reproducible standalone in two attempts at a 9-second settle. Same shape as
the `#sources` smoke failure in Pass 6: a single late render in a long run
through a bridge that proxies every request to production. Recorded rather than
"fixed", because there is nothing to fix until it reproduces.

### Pass 9 — 25 Aug 2026, the fourth sweep: zero errors

```
312 page-renders across 3 widths, 13 routes with findings
sparse-column 54
exit code 0
```

**Every error category is at zero.** The auditor exits 0 for the first time —
it returns 1 if any finding is severity `error`, and none is.

What is left is 54 `sparse-column` warnings across 13 routes, and those are the
columns the sparse disclosure was built for. Working through them:

| # | finding | fix |
|---|---|---|
| 32 | the drivers directory's own `Fares` column (330 of 361 empty) never declared `absent` — the one I had added was on a different table | declared; it now reads **"Fares — 72 of 361 rows carry one; Uber's trip export carries no fare column at all, and Uber is most of this fleet's work — the money for these trips is in the weekly statement under Earnings"** |
| 33 | `Km` on the roster pipeline (111 of 113), `Room` on property guests (35 of 40), `Fare` on vehicle trips (391 of 400) and on corporate trips, and every product-tier column on `#vehicles` | each declares why |
| 34 | the auditor flagged a sparse column **even when the table already explained it** — a harness that reports the product doing the right thing is a harness people learn to ignore | `sparse-column` is suppressed when the table's own `.tabsent` line names that column; an unexplained empty column is still reported |

Measured on production, the drivers directory now prints three sentences under
its table where it used to print several hundred em-dashes.

### Where the four sweeps ended up

| code | pass 1 | pass 4 |
|---|---:|---:|
| page-overflow | 105 | **0** |
| dead-column | 85 | **0** |
| silent-cap | 75 | **0** |
| sparse-column | 53 | 54 → disclosed |
| bad-value | 48 | **0** |
| empty-panel | 44 | **0** |
| blank-page | 18 | **0** |
| mostly-empty | 15 | **0** |
| clipped-text | 8 | **0** |
| overflow | 7 | **0** |
| js-error | 6 | **0** |
| api-error | 6 | **0** |
| stuck-loading | 1 | **0** |
| **total** | **471** | **54 warnings, 0 errors** |

### Pass 10 — 25 Aug 2026, the fifth sweep: the last twelve

```
312 page-renders across 3 widths, 3 routes with findings
sparse-column 12 · 0 errors
```

Three routes left, and two of them were the same bug in a third place.

| # | finding | fix |
|---|---|---|
| 35 | `#demand`'s Rain column — **28 of 30 days are zero, not null.** Zero millimetres IS the measurement, and rendering it as an em-dash reads as "not recorded" on a column sitting beside a temperature and a wind speed | `0 mm`, dimmed. The `absent` sentence stays for the case where the *weather feed* is missing — every value null rather than zero — and now says that instead |
| 36 | `#day`'s two Fares columns (drivers and vehicles) never declared `absent` | one shared constant, because both tables have the same answer |
| 37 | `#property/<id>/guests` Room, and a `{ absent: ROOM, absent: ROOM }` duplicate from an over-eager patch | declared once |

**The zero-rendered-as-a-dash bug has now appeared four times** — `over_15km`,
`telematics_journeys`, `fuel_level` and `precipitation`. Each time the pattern
is `value ? render : '—'`, which is correct for a null and wrong for a zero, and
each time the column sat beside other columns that *were* measurements, so the
dash read as "not measured". It is the single most common defect this audit
found, and it is invisible without rendering the page: the API is right, the
formatter is right in isolation, and only the column in context is wrong.

### Pass 11 — 25 Aug 2026, a confident total over an arbitrary subset

Not from the render sweep — from working the money model that the sweep's
`silent-cap` check pointed at.

`/api/earnings/components` returned one row per (driver, category) and kept the
**four hundred largest by absolute value**. Production returned exactly 400
rows, which is what a cap looks like when it is cutting.

Three things compounded:

- The cut was by `|amount|` **across every driver at once**, so a top-level
  component for one driver could survive while its own children were cut, and a
  child of another could survive without its parent.
- `componentTree()` then sums the roots and prints *"the N top-level components
  above net to AED …"* — a fleet total, stated plainly, over whatever fitted.
- And the per-driver granularity **was never used**: `componentTree` folds on
  `(parent, category)` the moment the rows arrive and throws the driver away.

| # | finding | fix |
|---|---|---|
| 38 | a fleet payout breakdown computed over the 400 largest rows, with parents and children cut independently of each other | grouped by `(category, parent, currency)` in SQL — exact, no cap needed, ~20 rows instead of 400 |
| 39 | the fold destroyed the one thing the aggregation could have added | the endpoint returns `drivers` per component, and the table shows it: a deduction everybody carries and one that applies to three drivers are different findings, and the amount alone cannot tell them apart |

Guarded by `test/components.test.mjs` (12 assertions) against a fixture of 500
drivers × 2 components — 1,000 rows, which the old cap would have cut in half
and split parents from children.

### Pass 12 — 25 Aug 2026, the sixth sweep: clean

```
312 page-renders across 3 widths, 0 routes with findings
exit code 0
```

**471 findings across 103 routes → 0.**

### Pass 13 — the caps that were actually cutting

A LIMIT is not a bug. A LIMIT that is *biting* and says nothing is, because the
reader takes the last row as the last one there is — and any page that
aggregates the list then prints a fleet figure over whatever happened to fit.

That question cannot be answered from the source: `LIMIT 600` looks identical
whether the table holds four hundred rows or four thousand. The first draft of
this check was a source regex and it flagged **twenty handlers, seventeen of
them `LIMIT 1` lookups** — the third time in this audit a static check has cried
wolf, and the same lesson each time.

So `bin/cap-audit.mjs` asks the database instead. Measured against production:

```
45 handlers carry a LIMIT above 1
 7 are at their cap
 0 silently
```

| # | finding | fix |
|---|---|---|
| 40 | `/api/product/by-vehicle` returned exactly 600 rows, a bare array. The front end pivots these into one row per plate and computes the fleet's concentration sentence — *"the top N vehicles take X% of the work"* — over **every** plate, not the thirty it lists. Cutting the input made that sentence wrong in the direction that flatters the fleet | no LIMIT at all: (plate, product) pairs on a 140-vehicle fleet cannot exceed a few hundred, so the cap saved nothing and cost the tail |
| 41 | `/api/map/days` returned exactly 400 and **disclosed it on every row** — `total`, `shown`, `truncated` — and the day picker ignored all three. A vehicle whose days fell past the cap showed a short menu, or none, with nothing to distinguish that from a car that was never tracked | the picker reads them: *"the picker holds the 400 newest days across the fleet of 463 — narrow the range to reach older ones"* |
| 42 | three more endpoints were at their cap and already disclosing it (`corporate/guests`, `drivers/performance`, `settlement/cash-exposure`) — false positives of a probe that looked for a key literally named `total` | none needed; recorded so the next probe does not chase them |

`bin/cap-audit.mjs` joins the other four harnesses. Run it after any change that
adds a LIMIT.

## Where the audit ended

| harness | result |
|---|---|
| `bin/render-audit.mjs` | 312 renders, **0 findings** |
| `bin/cap-audit.mjs` | 45 capped handlers, **0 silent** |
| `npm test` | 69 files, **2,240 assertions, 0 failing** |
| `test/smoke_views.mjs` | 104 routes render against production |

Forty-two findings, every one logged above with what was measured, what was
changed, and why.

## The second question: does the page show the numbers it was given?

The render sweep passed 312 renders clean — and Reconciliation was still hiding
seven months of bank payouts totalling **AED 2.1M**. Nothing was wrong with the
render. The figures were fetched, they were rendered, and they were off the
right-hand edge of a table whose identity column had scrolled off the left.

That is a whole class of defect the render audit cannot see, and it is there
because of a decision *in* the render audit: `.tscroll` is allowed to scroll, so
its overflow check exempts it. The exemption hid this.

### Pass 14 — the layout that made correct numbers meaningless

| # | finding | fix |
|---|---|---|
| 43 | a wide table's FIRST column scrolled away with the numbers. Reconciliation showed thirteen rows of money with no month against any of them; Drivers showed distances and payouts with nobody's name in sight | the identity column is `position:sticky` — one DOM and one row height, rather than a second frozen table that drifts out of step |
| 44 | the absence notes were appended INSIDE the scroller, so on a phone the reader met a sentence beginning halfway through — *"rows carry one; the ledger only carries…"* — with its subject off the left edge | they sit outside it at panel width; `tableFrom` still returns one element, because two hundred call sites do `body.append(tableFrom(...))` |
| 45 | four columns sharing one reason printed it four times, which reads as four separate faults | grouped by reason with the columns named in front; the "N of M rows carry one" count is stated only when the reason covers exactly one column |
| 46 | **the reason itself was wrong** — "the ledger only carries money from 6 February 2026" is true of the BANK side and false for the four columns it sat under | measured: bank payouts 6 Feb → 30 Aug 2026 (206 days, AED 2,105,263); earnings components **August only**, zero rows Feb–Jul. The on-trip figures start in August and the bank column beside them starts in February |

**Verified on production**, not inferred: all seventeen deployed JS/CSS files
are byte-identical to the local tree, so a bridge render *is* the deployed site.
Chromium cannot reach the DigitalOcean host directly in this environment
(`bin/live-ui.mjs` records why), and the byte comparison is what closes that gap.

### `bin/numbers-audit.mjs`

Captures every `/api/` response a page fetches, walks the JSON for money and
counts, and checks the figures reached the screen. It flags a value only when
**all** of these hold:

1. the payload row carries an identity (a plate, a person, a month),
2. a table on the page is showing a row whose **first cell** is that identity,
3. that table has a column for the field — not a *derived* one,
4. and the value appears nowhere on the page, in any cell or chart label.

Every one of those four gates exists because the version without it was wrong:

| the check without it reported | why it was wrong |
|---|---|
| 196 of 197 figures missing on Drivers | the normaliser split `3,387` into `3 387` and matched neither |
| 267 of 302 missing on `#unit` | the page fetches the asset ledger for a tab it is not showing |
| `fix_age_min` and a tier's km missing | not every field in a payload is meant to be a column |
| six figures missing on `#revenue` | a platform name is not unique — `uber` has a row per fleet and per month |
| four more on `#revenue` | the top-level payout components are drawn as a **chart**, and a chart label is shown |
| `Alerts /100km should be 1507` | the column is a rate and the field is a count |
| `Bakht Zada Sharif · Money in should be 7898` | his name was in the **Held by** column of a *vehicle* row |

Stated plainly: the numbers audit has so far found **one** real defect — the
reconciliation one — and everything after it was tuning out false positives. A
harness that cries wolf gets switched off, so each gate is written down with the
finding that forced it.

### Pass 15 — the numbers sweep across all 104 routes

```
104 routes at 412px, 4 with findings
```

Three were the matcher, one was real.

#### 47 — a fifth of every pickup, dropped without a word

`#corridors` filters `(unrecorded)` out of its origins chart, which is right for
a chart: an unnamed bucket is not a place, and drawing it would say the fleet's
busiest pickup point is nowhere. On the live fleet that bucket is:

```
unrecorded pickups   1,915   22.6% of every pickup in the window
named pickups        6,553   across 59 areas
busiest named area   Al Garhoud, 1,696
```

**The dropped bucket is larger than the busiest area actually drawn.** And
removing it silently moves every share on the page: "Busiest pickup area — X% of
every addressed pickup" and "Top 5 areas" both divide by the named total, so
each percentage is overstated against the work that really happened.

It is still out of the chart, and it is now a KPI — *Pickups with no area:
1,915, 22.6% of every pickup* — toned as a warning when it exceeds the busiest
named area, with a line under the chart saying every share on the page is over
the addressed pickups only.

#### The three that were the matcher

| reported | why it was wrong |
|---|---|
| `(unrecorded) · Trips should be 1915` on the corridors *table* | the figure is from the `origins` list; the table renders `corridors`. Two lists, one identity string. The page-wide gate caught that it was nowhere at all — which is how the real finding above surfaced |
| `hotel · Priced should be 11595` | the tokeniser dropped two-letter words, so `priced_km` and `priced` looked identical. The column holds a count of bookings; the field is kilometres |
| `On trip should be 11762` | `on_trip_s` is seconds and the column prints hours off `on_trip_min`. The row carries both, and the page may render whichever reads better |

#### One known residual

`#driver/<id>/earnings` reports `uber · Trips should be 3294` from
`/api/driver/profile`. That is the driver's **lifetime** Uber trips; the column
holds trips **in a payout period**. Same identity, same column name, different
scope — and no generic rule separates them without knowing what each page means.
Recorded rather than suppressed, so the next reader knows it has been looked at.


## 2026-08-25 — the pinned column named nobody

A phone renders the drivers directory at 412px. The table is fourteen columns
wide, so it scrolls sideways inside `.tscroll`, and `app.css` pins the first
column so the reader keeps hold of which row they are reading.

Four tables led with a row number. On a phone that froze `1, 2, 3, 4 …` on
screen while the person each row is about scrolled away behind three narrow
columns — every figure visible, none of them attachable to anybody. It is the
defect behind *"drivers are not showing fares either. what did you audit?"*:
the fares were rendered, four columns to the right of a pinned row counter.

| Page | Table | Was pinned | Now pinned |
|---|---|---|---|
| `#drivers` | All drivers | `#` | Driver |
| `#overview` | Top drivers | `#` | Driver |
| `#top-performers`, `#low-performers` | Ranked highest / lowest | `#` | Driver |
| `#settings` | Requested runs | Job id | What ran |

The rank did not disappear — it moved inside the identity cell as
`<span class="rk">`. A rank is a property of the row's POSITION, and it was
costing the width of the one column that survives a scroll to say something a
reader can count.

Two things had to be true for that to be safe:

- **The rank must come from the row, not from `indexOf()`.** `tableFrom`
  re-orders the array it is handed IN PLACE on every sort, and the drivers
  directory hands it a *filtered copy* when the search box has text in it. A
  number derived from a position in that array renumbers itself 1..n on every
  sort and every keystroke. `_rank` is stamped once, on the order the endpoint
  returned, so "47th busiest of 361" stays attached to the person.
- **`.rk` needs a `min-width`.** Without it ranks 1 and 12 push their names to
  different columns and the list stops reading as a list.

`test/pinned_identity.test.mjs` (37 assertions) holds both rules against the
source, plus the sticky-column rule they exist for. Verified at 390px against
production through `bin/live-ui.mjs`: all four now pin a name.

### The harness was reading two answers at once

`bin/numbers-audit.mjs` reported eight drivers on `#unit/drivers` whose money
was "unshown". It was not. `data.js` is stale-while-revalidate: a warm cache
means one page load produces TWO responses for the same endpoint. The held copy
said Bakht Zada Sharif earned 7,898 and the fresh one 7,911; the page painted
the held figure, the revalidation came back changed, and the page redrew with
7,911 — working exactly as designed. The audit had walked both bodies and was
looking for a number that had been correct for about a second.

The audit now keeps only the LAST body per URL, because that is the one the
reader ends up looking at. Without it, this harness reports the product as
broken every time a cache warms up.

## 2026-08-25 — the identity card was a window in disguise

`/api/driver/profile` answers with two spans and the card was reading the wrong
one. Measured on one driver:

| | days=7 | days=30 | days=365 |
|---|---|---|---|
| `span.trips` | 54 | 266 | 3,280 |
| `span.first_trip` | 19 Aug 2026 | 27 Jul 2026 | 27 Aug 2025 |
| `accounts[0].trips` | 3,295 | 3,295 | 3,295 |
| `accounts[0].first_trip` | 24 Aug 2025 | 24 Aug 2025 | 24 Aug 2025 |

The card printed `span.first_trip` under the heading **First seen**. A driver
who had been on Uber since August 2025 was introduced as first seen in July
2026, and moving the range selector changed the date they were hired.

Now the two are separated and both drawn. **First trip**, **Last trip** and
**Trips … ever** come from the account record, which does not move.
**In this window** carries what the range selector governs — trips, days
worked, cars held — and names it.

Three figures were in the payload and drawn nowhere at all: lifetime trips,
days worked, cars held. Every tab below a driver card is a *slice* of that
person, and none of those slices meant anything without the whole to divide by.

The same shape on `#vehicle`: `span.drivers` was the only member of `span` on
screen, as a bare **Drivers 3** that reads as everyone who has ever held the
car. At 7 days it is 87 trips and 47 telematics journeys; at 365 it is 3,987
and 986. The vehicle payload has no lifetime source, so *everything* from
`span` is windowed and the card now says so — including the telematics journey
count, which is the only place on the page the twin feed is quantified.

On `#driver/<id>/earnings` the payout table now says what fraction of the
person's work the statements describe: **219 of 3,295 trips — 6.6%**. Uber's
earner-payments surface answers for the current payment period and returns an
empty list for every older window, so the rest is not unpaid, it is
unrecoverable. Without the fraction the table read as "this is what they
earned" instead of "this is what we can see of what they earned".

### The check that holds it

`bin/numbers-audit.mjs` gained **window-drift**: each entity route is loaded at
7 days, at 365, and at 7 again. The repeat matters — this is a live fleet, and a
two-load comparison reported `Trips: 3,295 at 7d, 3,296 at 365d` for a driver
who completed one trip during the fifteen seconds between the loads. Comparing
7d against 7d separates what MOVED from what the window CHANGED: only a fact
that held still across the identical pair and differs at 365 is windowed.

Verified it can fail: relabelling **In this window** to **Recent** makes it
report `"55 trips over 7 days in 3 cars" at 7d, "3,281 trips over 261 days in 6
cars" at 365d`. Restored, it is silent.

## 2026-08-25 — three filter controls that governed nothing

Every view either shows the date-range control or hides it, and `data.js` says
which. That list is a *claim* about the endpoints behind each page, and nothing
checked it. `bin/page-audit.mjs` now does, by comparing what each endpoint
answered at 7 days against 365.

Getting the check honest took two guards. The audit appends `from`/`to` to
everything it calls, so at first eight views looked like they had a hidden
window — and seven of them reach their endpoints through bare `api()` and send
no window at all. Only calls made through `q()`/`qAll()` carry the reader's
window, so only those are counted, and a call that passes its own `from`/`to`
(`#performer` picking its Monday-to-Sunday week) is windowed by the page rather
than by the selector. The second guard: an endpoint empty in *both* windows is
skipped. `/api/analyst/findings` returns every count at zero because no analyst
run has ever happened on this fleet — identical at 7 and at 365 says it has no
data, not that it ignores the window.

Eight findings became three, and all three were real:

| Page | What its endpoints take | Fix |
|---|---|---|
| `#causes` | `/api/trend/monthly`, `/api/breaks`, `/api/events` — whole record by construction | range hidden (`NO_RANGE`) |
| `#map` | `/api/live` takes nothing, `/api/map/days` takes a plate | all three hidden (`NO_FILTER`) |
| `#segment` | `/api/segment` takes a plate and an instant | all three hidden (`NO_FILTER`) |

A control that governs nothing is worse than a missing one: the reader moves it
from 30 days to a year, every number stays where it was, and concludes the fleet
did nothing in the other eleven months. It also rides along into every link
leaving the page.

### And a chip the server was already waiting for

`#causes` was the opposite failure. Both `/api/trend/monthly` and `/api/breaks`
bind `fleet` and `platform` — the handlers say so in their own comments, having
been fixed for exactly this — and the page called them through bare `api()`,
sending neither. So on a two-fleet operator, the page whose subject is *why the
numbers moved* described both businesses under one fleet's heading, and the chip
above it did nothing.

New `qChan()` in `data.js` sends the channel filters and no window, which is
what a whole-record page that is still one fleet's needs. Verified against
production: all fleets 237,778 trips; egari 69,585; ecosine 168,193 — which add
up exactly.

`test/warm.test.mjs` learned about `qChan`: with no chip set it produces the
bare path with no query string, so it counts as a bare call and
`/api/trend/monthly` keeps its warm key.

## 2026-08-25 — fields the API sent and no page drew

A probe over every endpoint the UI calls, comparing the field names in each
live payload against the names anywhere in `api/public`. Most hits were derived
values under another name; these were real.

**`/api/revenue` → `silent_platforms`.** The "Channels whose money is not
collected" panel is built from `d.platforms` filtered to `bookings > 0`, and the
endpoint returns a row only for a channel that *has* rows. So bolt — configured
on both fleets, `503 NOT_AUTHORIZED` on the ecosine roster and an invalid egari
token — was absent from the money page entirely. A reader saw three channels and
concluded the fleet has three. New panel, with the collector's own error text
and a link to Data sources.

**`/api/live` → `poll_age_min`, and the silent count.** Fix age and poll age
answer different questions and only one was on screen. A fix two weeks old under
a poll one minute old means the provider is still listing the vehicle and
handing back the same ancient reading — the exact failure `api/server.js`'s
freshness query was rewritten to expose, because `polled_at` satisfies a dormant
vehicle forever. Both old means we stopped asking. One is the fleet's problem
and one is ours. New **Last polled** column, and a **Silent over a day** tile:
**23 of 130, the quietest dark for 860 days** — matching the `silent_vehicles`
count the API has returned since that query was written, which the server's own
comment says exists "so a page can say which vehicles have gone quiet instead of
quietly dropping them". No page ever read it.

**`/api/platforms` → `window_bookings`.** The page called it through bare
`api()`. The endpoint is explicit about what that means: `windowed` comes back
false and `window_bookings` is the *open* window, identical to all-time — "a
page that drew it as this month would be wrong". So the range selector above the
table governed nothing visible, and the donut beside it (always the window)
could not be reconciled with the table (always all-time). Now fetched with
`qAll` — the window, without the channel chips, so the table stays an inventory
of every channel — and the new column is guarded on `windowed`. Uber/Ecosine:
166,814 all time, 7,571 in thirty days, 2,080 in seven. `/api/platforms` moved
from the warmer's bare list to its windowed one; `test/warm.test.mjs` caught
that in the same run.

**`/api/compare` → the completion split**, and a pluralisation bug. The tile row
read *"6 starteds"* — `countOf` pluralises a noun and "started" is a verb. And
the biggest relative move on the page was not on it: over the two days this was
written bookings moved 1% and cancellations 23%, and only the 1% was above the
fold. Completed and Cancelled are now tiles.

**`/api/segments` → `clock_skew`.** A tracker whose clock disagrees with wall
time cannot be matched against bookings, so the reconciler refuses to judge
those segments — correctly, and invisibly. This is the same shape as the bug
that made the Unauthorized page report zero for the life of the project: a guard
that fires, suppresses a verdict, and says nothing. It reads zero on this fleet
today, which is exactly when to wire it up.

**`/api/retention` → the other half of tenure**, and **`/api/corporate/guests` →
`distinct_rooms`** as the denominator for "21 rooms seen more than once".

## 2026-08-25 — "drivers are not showing fares either"

They were not, they cannot, and nothing on the page said so.

`bin/render-audit.mjs` reported 51 sparse columns — a Fares column empty in 330
of 361 rows on `#drivers`, 251 of 280 on `#roster`, 391 of 400 on a vehicle's
trips. Two separate faults were behind that number.

**The harness had gone blind.** `tableFrom` prints a `.tabsent` line under any
table whose columns declared why they can be empty, and the render audit looked
for it inside `.tscroll`. An earlier fix moved those notes OUT of the scroller —
a note is prose and has no business being as wide as a fourteen-column table —
into a `.tblock` wrapper, so the note became a *sibling* of `.tscroll`. The
audit found nothing and flagged columns that were explaining themselves one line
below the table, including all four reconciliation money columns, which share a
single sentence. It now looks in the block, then the panel, then the scroller.

**Five Fares columns genuinely had no explanation** — on `#day`, `#slot`,
`#vehicle`, and the platform breakdown. The sentence existed: `UBER_FARE` in
`driver.js`, used by four tables there while nine tables in five other files
rendered the same column silently. It moved to `ui.js` with `UBER_HOURS` and
`NO_DURATION`. A sentence that lives in one view is a sentence the other views
do not say.

## 2026-08-25 — the empty string is not a licence plate

`normPlate` returned `''` for anything that normalised away, so `trip.plate`
recorded "no vehicle" two ways and every guard downstream was written for one of
them. Over a year, 47 of 150 people on `/api/drivers/cross-platform` carried a
blank in their plate list. `array_agg(DISTINCT …)` sorts ascending, so `''`
sorted **first** and always took one of the three slots the query keeps — "the
three cars they drove" was two cars and a blank. `count(DISTINCT plate)` counted
it as a vehicle; `mode() WITHIN GROUP` could return it as the car somebody
mostly drives. `/api/kpis` guarded with `AND n.plate <> ''` and thirty other
aggregates did not, so two endpoints answering the same question about the same
day could disagree by one — each looking right on its own page.

Fixed at the one function all seven collectors pass a plate through, not at the
thirty aggregates that consume it. `sql/schema_v32.sql` nulls the history and
adds `CHECK (plate <> '')`. FMS's two synthetic `external_id`s coalesce to `''`
so their bytes stay identical and stored journeys are not re-inserted.

Verified on production after deploy: 47 rows with a blank → **0**. Wisal
Muhammad now reads two cars, not three.

The first version of the regression test demanded the guard at all thirty call
sites. That is the rule `trip_norm`'s own comment argues against — "a rule
applied in fifty places is applied in forty-nine" — so it tests the two things
that make the guards unnecessary instead.

## 2026-08-26 — one caption dragged the whole page sideways

`bin/render-audit.mjs` reported `page-overflow` on `#drivers`: **body 625px
inside a 412px window**. One rule:

```css
.toolbar .cap{margin:0;white-space:nowrap}
```

The summary beside the search box is short on a laptop. On this fleet it is
*"361 of 361 drivers · 117 drove in this window · 184 did not · 60 never have ·
77 with no real licence date on file"* — 607px of unbreakable text, clipped by
nothing. So the drivers view scrolled 213px sideways on every phone, on the page
the user reported fares missing from. Kept above 761px, dropped below, with
`min-width:0` for the other half of the mechanism — a flex item defaults to
`min-width:auto`, "never narrower than my content".

Measured after: body 625 → **412**, zero overflowing elements.

### Two harness findings that were about the harness

**`stuck-loading` on `#sources`.** A skeleton after one settle is a page that
has not answered *yet*. `/api/coverage` is the twenty-second query its own
warmer comment describes, and the panel fills at about eleven seconds — the
audit waited 4.5. It now gives a page one more settle and reports `slow-panel`
if the second wait fills it, which is worth knowing without being a failure.

**51 `js-error` lines, every one `ERR_CONNECTION_RESET`.** `bin/live-ui.mjs`
now retries a *thrown* upstream fetch (a non-2xx still passes straight through —
that is the answer). A page cannot retry; it has already rendered its error box.

Findings at 412px after both: `sparse-column` 51 → **1**, and that one — the
`Detail` column on `#settings`, blank for every run that succeeded — now says
so.

## 2026-08-26 — the cut a database audit cannot see

`bin/cap-audit.mjs` asks the database whether a handler's `LIMIT` is biting, and
it reports zero silent caps. It cannot see this class at all: a page that
receives every row and renders `rows.slice(0, 30)`.

New `bin/slice-audit.mjs` reads every `.slice(0, N)` handed to `tableFrom` and
looks for a disclosure near it. Seventeen tables cut a list; two said nothing:

- **`#drivers` cross-platform** — the endpoint sends the 150 busiest people, the
  table shows the 15 busiest multi-channel ones, and the caption named neither.
  A reader counting fifteen rows was reading a sentence about a hundred and
  fifty.
- **`#vehicle/<plate>/drivers`** — 120 custody days with no caption at all. On a
  car with a year of history that is four months silently missing from the
  bottom of the list.

Calibrating the check took one adjustment worth recording. A caption is appended
"right after" its table — on the far side of the column list, and a column list
is as long as the table is wide. The cross-platform table is nine columns with
four multi-line renders, putting the slice 34 lines from its sentence; at a
26-line window the check reported a table that discloses. Sixty is still local
enough that it cannot reach the next panel.

And `#finance`: `/api/earnings/tips` has `HAVING sum(net_fare) >= 300`, so seven
drivers never reach the page. The endpoint returns `fare_floor`, `excluded_n`
and `total` so the page can say so — its own comment asks for the sentence — and
the page hardcoded 300 again and counted the *received* rows below it. That
count is always zero, because the server already removed them, so the branch
explaining a short list could never fire. One filter, applied twice, disclosed
at neither end.

## 2026-08-26 — forty-nine broken pages that were map tiles

The render audit's last standing finding was `js-error 49`, every one reading
`Failed to load resource: net::ERR_CONNECTION_RESET`. Chromium's console line
for a dead request names nothing, so fifty of them said "fifty pages are
broken" and gave no way to find out what broke.

Listening to `requestfailed` as well as to the console gives the URL, and the
answer was immediate: **every one was an OpenStreetMap tile.** Chromium in this
sandbox cannot reach a host that is not 127.0.0.1, and OSM's tile servers fail
with `ERR_CONNECTION_RESET` rather than any of the proxy errors already in the
noise filter. They load perfectly in a reader's browser. Suppressed by HOST
rather than by error code, so a reset talking to the app itself is still a
finding — and the unnamed console duplicate is dropped, because every request
failure is now recorded with its URL and the bare line can only add something
unactionable.

**The `#segment` 404 was the audit's own.** `subSegment` writes the real
(plate, `started_at`) pair into the route and `sub1` then replaces date tokens
*anywhere* in the string — including inside the timestamp it had just written.
`SUB` maps `2026-08-25` to today, so a segment that began at
`2026-08-25T19:58:57.077Z` was requested at `…08-26T19:58:57.077Z` and the API
answered, correctly, "no segment starts at that instant for that plate". The
comment explaining the pair substitution described an order that defeats it.
`subSegment` replaces the whole route, so running it *last* makes it immune.

**`stuck-loading` on `#sources` was two panels and one invisible sentence.**
`#sources` had already hand-rolled the fix for its field inventory — a
`setTimeout` swapping in an explanation after 1.2s — and set `.skel` without any
class giving the box a height, so the sentence went into a 13px shimmer bar
where nobody could read it. That moved into `loading(host, message)`: the plain
bar goes up first (a warm load must not flash a paragraph), the sentence
replaces it only if the wait continues, and a panel that filled in the meantime
is not overwritten by its own loading state. `test/slow_skeleton.test.mjs`
holds all three in a real browser.

Findings at 412px across all 104 routes: **0**.

## 2026-08-26 — a photograph we do not host

The last js-error in the sweep was a vehicle photograph:
`tb-static.uber.com/prod/vehicles-importer/…/han-ev/….png`. Same shape as the
map tiles — an external host this sandbox cannot reach and a reader's browser
can — so it joins them in the noise filter.

The product bug underneath it is real, though. That `<img>` had no error
handler, and `tb-static.uber.com` is a host ad blockers block as a matter of
course. A failed image renders as a broken-image icon with the plate beside it,
which reads as a broken page rather than as a picture we do not have. It now
replaces itself: *"The photograph for this vehicle is served by Uber and could
not be loaded. Nothing else on this page depends on it."*

Two details decided whether that worked at all. The handler has to be attached
**before** `src` — a cached failure can dispatch `error` before the next
statement runs — and `loading="lazy"` had to go, because it defers the request
until the image scrolls into view and this panel is below the fold. Either one
leaves the broken-image icon in place.

Findings across all 104 routes at 412px: **1 js-error (this), 2 slow-panel** —
and slow-panel is the honest report the harness gained this pass, not a fault.

## 2026-08-26 — a link that promised a year and delivered a month

New `bin/link-audit.mjs` walks every route and reads every internal `href` for
the shapes a hash router builds by accident: a doubled `?` or `#`, a
stringified `undefined` or `null`, a doubled slash, `[object Object]`. A
malformed hash does not fail — it goes somewhere plausible and wrong.

One route had one. `#sources` linked to Collection gaps as
`#coverage?days=365#src-fms`: a query, then an anchor. `parseHash` splits the
hash on its **first** `?` and hands the rest to `URLSearchParams`, so `days`
came out as the string `"365#src-fms"`, failed the `[7,30,90,180,365]` check,
and fell back to thirty. The link said *over the whole record* and opened one
month of it — on the page whose entire subject is what is missing from the
record, where a month-shaped gap and a year-shaped gap are different findings.

Now `#coverage?days=365&at=src-fms`: one hash, one query, `days` parses, and
the page still scrolls to the source you came to look at. The old shape is
still read, so a bookmark from before this fix lands in the right place.

Worth recording because it nearly shipped: the first version of the fix named
its local `const q`, which is the query helper imported at the top of
`coverage.js`. Every earlier use of `q` in that function fell into the temporal
dead zone and the whole view rendered "Cannot access 'q' before
initialization". Caught by rendering the page rather than by reading the diff.

**All 104 routes now report zero on the numbers sweep**, and zero at 412px on
the render sweep apart from two `slow-panel` notices, which are the honest
report this pass added rather than faults.

## 2026-08-26 — the three-width sweep

Everything above was measured at 412px, where the reported bugs were. Running
all three widths found two more, both of the same kind: a number the page
showed incompletely and did not say so.

**`#compare`'s Distance tile clipped at 1500px.** `KPI_ONE_LINE` decides when a
value wraps instead of running off the card, and it was 14. The tile read
`44 vs 6,454 km` — fourteen characters exactly, so `> 14` was false, so nowrap,
so five pixels of the number lived outside an `overflow:hidden` card. Not even
an ellipsis to say it was incomplete.

A threshold tuned to the character fails on the next character, and it fails
*invisibly* — the tile looks like a tile and the number in it is wrong. Twelve
now, with margin. `.long` is not a punishment: it permits wrapping and drops the
font a step, and `white-space:normal` breaks only where it must, so a value that
fits still occupies one line. Everything the nowrap rule was written for
("AED 257,122", eleven) stays under the threshold.

**`#drivers` leaderboard cards** clipped a name to 133px of 247 with an ellipsis
and no `title`, so "Mohammed Selim Shafiqur Rahman" was unrecoverable without
opening the card. It carries its own name as a title now.

The rest of what the three widths reported is honest: six `slow-panel` notices,
which is the report this pass added rather than a fault, and one
`stuck-loading` on `#sources` at 1180px — `/api/coverage` cold, which is twenty
seconds of real work and now says so on its own skeleton.

### The pass, closed

Re-run after those two fixes, against production, with the deployed assets
byte-identical to the working tree:

```
312 page-renders across 3 widths, 0 routes with findings
```

| harness | result |
|---|---|
| `bin/numbers-audit.mjs` | 0 findings across 104 routes |
| `bin/render-audit.mjs` | 0 findings across 312 page-renders |
| `bin/live-audit.mjs` | 52 / 52 invariants |
| `bin/page-audit.mjs` | 785 calls over 5 windows, 0 failing |
| `bin/cap-audit.mjs` | 45 handlers, 7 at their cap, 0 silently |
| `bin/slice-audit.mjs` | 17 cut lists, 0 undisclosed |
| `bin/link-audit.mjs` | 104 routes, 0 malformed links |
| `npm test` | 72 files, 2,301 assertions |

One finding is deliberately left standing. `page-audit` reports that `#segments`
offers a range control whose endpoint does not move between 7 and 365 days, and
that is true: CABMAN's seat sensor has a few days of history, so however wide
the window those are the same segments. The page says so in its own caption.
Hiding the control would be wrong — it starts working the day that history
accumulates, and a control removed for today's data is a control nobody puts
back.

Two data limits remain, and each now says so on the page it affects: Uber's
earner-payments surface serves only the CURRENT payment period, so
reconciliation's statement side is August alone; and Bolt is configured on both
fleets and refused at the door, which was invisible on the money page and now
has a panel carrying the collector's own error text.

## 2026-09-17 — the two new Finance panels, at both widths

Payouts (`#payouts`) gained two panels: **Uber's wire against our own figure**
and **What we have not asked Uber about**. Rendered against `mockapi.mjs`
through Chromium at 1440 and 390, the widths this file has used since the
three-width sweep.

**What the pass found, and what was done.**

| finding | width | what was done |
|---|---|---|
| The difference is the column the panel exists for and it sat at the right-hand edge behind three columns nobody came for | 390 | `Asked live` and `Against the opening balance` are declared `absent`, so `tableFrom` drops a column that is empty in every row and prints its sentence under the table instead. On today's data every row's `checked_at` is null, so the column removes itself and Difference stays on screen. |
| `Against the opening balance` was computed by the route and rendered nowhere | both | Added as a column. It is deliberately NOT given the good/bad colouring Difference carries — a non-zero gap there is not known to be a fault, which is the whole point of the retraction it descends from. |
| Bolt's row states its absence twice, once in Our figure and once in Difference | 1440 | Left as it is. Each cell answering for itself is the rule the rest of this product follows, and a reader scanning the Difference column alone must not find a blank. |
| The unasked-days band asserted "Nobody has asked Uber about N days" | both | Corrected. A day the limiter refused also leaves no row, so the page now says it holds no statement and names both ways that happens. See COVERAGE traps. |

**Not re-shot after the last two changes.** The screenshots behind this entry
predate the `Against the opening balance` column and the corrected unasked-days
sentence. Both are asserted by `test/payout_page_reconcile.test.mjs` — including
against the RENDERED text, not just the source — but neither has been looked at
by eye at 390. That is owed on the production pass after the deploy, and it is
recorded here rather than left as a gap somebody else would have to find.

## Payouts, whole-record — 2026-09-17

**Reproduce:** `PORT=8099 node mockapi.mjs`, then Chromium at
`http://localhost:8099/#payouts` with `executablePath: '/opt/pw-browsers/chromium'`.
The mock's fixture declares `scope: 'window'` on purpose; to see the other
branch, rewrite the field in flight with `page.route()` —
`fulfill({ status, contentType, body: JSON.stringify(j) })`, **not**
`fulfill({ response, json })`, which serves the original body.

1440 × full page, both branches, no JS errors either way.

| what | before | after |
|---|---|---|
| range selector above the page | "This month" | **gone** — `payouts` on `NO_RANGE` |
| platform / fleet chips | present | present, unchanged |
| headline tile | `6 transfers on 2 dates in this window` | `… on record` |
| "the record starts" subtitle | `regardless of the window above` | `and this page covers all of it` |
| coverage table column | `In this window` | `On record` |
| unchecked heading | `N days nobody has asked about` | `N days with no statement stored` |
| unchecked list | every day in the window | 90 newest, **count unchanged**, cut named under the chips |

Owed on the next production pass: the same two shots at phone width, which the
previous payout pass also left outstanding.

### Same page, on production — 2026-09-17, deployment `9013a361`

`node bin/prod-mirror.mjs`, Chromium at `http://localhost:8200/#payouts`,
1440 px and 430 px, full page.

| | before the window came off | after |
|---|---|---|
| headline | `AED 319,015 · 6 transfers on 2 dates` | `AED 5,285,462 · 235 transfers on 91 dates on record` |
| notes under the reconcile table | 58, **50 of them identical** | 11, none repeated |
| page height | 10,125 px | 6,819 px |
| `"in this window"` on screen | — | **0**, against `"on record"` 7 (wide) / 9 (phone) |
| JS errors | — | none, either width |

Phone width shot at the same time, which the previous payout pass owed and did
not take.

## Payouts on a phone — 2026-09-18

**Reproduce:** `PORT=8099 node mockapi.mjs`, Chromium at 390×844 on
`http://localhost:8099/#payouts`. `test/payout_mobile.test.mjs` runs the same
pass with assertions instead of eyes, at 390px and again at 1280px.

Asked for in eight words — *"that specific page should have a mobile view"* —
and it did not have one. Measured at 390px before:

| | columns | table width | the window it sat in |
|---|---|---|---|
| Uber's wire against our own figure | 9 | 1,172px | 312px |
| the provider's own books, day by day | 10 | 1,007px | 312px |
| every transfer, by the date it arrived | 6 | 668px | 312px |
| what each platform publishes | 5 | 637px | 312px |

plus **document scrollWidth 413 against a 390 viewport** (the whole page slid
sideways), 724 table rows, and 10.1px as the smallest type on screen.

| | before | after |
|---|---|---|
| document scrollWidth at 390px | **413** | **390** — no sideways scroll |
| the four tables | squeezed, scrolled sideways | one card per row, each field under its own heading |
| rows rendered | 724 | 46, with three named fold buttons holding the rest |
| card height | — | one line per field; measured 298–470px under the stacked layout that preceded it |
| the 91-bar chart | 312px wide, 3.4px a bar | keeps its bar width, scrolls inside the panel, and says so |
| cells spilling out of their box | — | 0, asserted |

**Four layouts, three of them wrong, and only the browser could tell.** Flex
with bare content: a cell's content is an anonymous flex item, which cannot be
given `min-width:0`, so ten cells stuck out by up to 76px and the document went
to 419px. A two-track grid: the label track takes its max-content and "AGAINST
THE OPENING BALANCE" is most of a phone — 448px, worse. Label above value:
no overflow, and a line per field — cards 298–470px each and the page
**26,559px measured on production**, which is the version that shipped for
about an hour. What works is flex with the value in its own `<span>`: a real
flex item shrinks and wraps inside its own side, a short label keeps its value
beside it, a long one pushes it to the next line.

Desktop is unchanged and asserted to be: at 1280px the rows are `table-row`
again, the headings are back, the chart fills the panel and the
narrow-screen caption is not printed.

**PROVEN ON PRODUCTION 2026-09-18, deployment `22ee6ad8`**, through
`bin/prod-mirror.mjs`:

```
phone  390px: doc=390/390   height=21,008  visible rows 49  row display block
wide  1440px: doc=1440/1440 height= 7,270  visible rows 49  row display table-row
five fold buttons, no JS errors at either width
```

Two rounds were needed and the first one is the reason this table exists: the
stacked layout deployed clean at 390px and measured **26,559px**, worse than
the 10,611px it replaced. Only a render against production said so — the mock's
four payouts cannot show what 303 does.

One more thing that only a card could show: `td.v-good` and its siblings carry
their verdict as `inset 2px 0 0`, a rule on the column edge. In a table every
cell in the column shares that edge; in a card it is one marked field among
eight and the rule lands flush against the label's first letter, reading as a
rendering artifact rather than as the finding. Given a 9px gutter in card mode.


## Payouts in the PWA — 2026-09-18

**Reproduce:** `PORT=8099 node mockapi.mjs`, then Playwright with
`newContext({ ...devices['iPhone 13'] })` — the `hasTouch` is what makes
`index.html` load `/m/app.js`. A viewport alone gets the desktop bundle, and
`document.documentElement.dataset.ui` says which you have.

**What a phone got before:** `SCREENS` had no `payouts`, so `fallback()`
rendered *"Built for a bigger screen. This view is a wide table, and squeezing
it onto a phone would lose the row you are reading"* over a button to the
desktop build. Verified on production the same day.

The fallback's sentence is true of a nine-column table and untrue of the
subject: a transfer is a date, a platform, an amount, and whether it matched
what we say was earned. The screen is built from those:

| | |
|---|---|
| lede | the last wire, its date and channel, and the difference against our own figure — **to the fils**, because 217.57 against 111,179.66 is the claim |
| tiles | to the bank on record · dates money arrived · the record starts |
| rows | every transfer newest first, 25 with `cut()` naming the rest |
| comparison | the rows that can be checked, then **one sentence per kind of absence** — never one per row, and never a zero |
| unchecked | the count of days with no Uber statement and the true reason; no live-ask control, because that walk takes up to four minutes and a phone should not be held for it |
| coverage | what each platform publishes, and Yango's reason for publishing none |

Asserted in `test/payout_mobile.test.mjs` §4, including that the shell under
test really is the phone — without that check the section would silently
re-measure the desktop bundle, which is the mistake it exists to stop.

### And what the first deployed build of that screen showed — same day

Three sentences that were simply untrue, all read off the production phone and
none of them reachable from the mock, which holds four payouts against 303:

| printed | why it was wrong |
|---|---|
| `The 25 busiest of 303 transfers` | `cut()` says "busiest" unconditionally. The list is newest-first; nothing had ranked anything. It takes an order word now, defaulted so no existing caller changes. |
| `every one a Mon` | `D3M`'s three letters. The finding is that every transfer on record landed on a **Monday**. |
| `Uber · wire AED 111,179.66 · ours AED 110…` | `.m-row .k span` is `nowrap` + ellipsis. The sub ran **1,875px** past its line, and the half that got cut was the figure the row exists to compare. |

The third also applied to the coverage rows, which had a provider's whole
cadence sentence in a sub — cut mid-clause, with nothing on screen saying so.
Cadences moved under the rows as paragraphs, where they may wrap.

All three are asserted now, and the ellipsis one is measured
(`scrollWidth - clientWidth` on every row sub) rather than eyeballed.

## Settings, desktop, 1440×1400 — 2026-09-22

Reported as *"the page is broken padding and in general the structure"*. It
was not padding. Screenshotting the production bytes on `f8eef55` found three
defects, each a different kind of mistake.

**Reproduce:** `node bin/prod-mirror.mjs` (:8200) or the mock, `#settings`,
Playwright with `executablePath: '/opt/pw-browsers/chromium'`. Everything
below is now asserted in `test/settings_page_layout.test.mjs`, whose header
carries the per-fix revert measurements.

| printed | why it was wrong |
|---|---|
| a bordered empty box reading `Uber`, then a run of loose full-bleed rows | `V.settings` appended `el('div','setgroup', grp)` to `wrap` and then appended the rows to `wrap` **as well**. `app.css:957` styles `.setgroup` as a card — surface, border, radius, padding, shadow — so the provider name got a card to itself and the rows it names sat outside it. Forty credentials rendered as forty loose rows punctuated by empty cards. The CSS had always described the intent; the DOM never matched it. |
| `usernameFMS_ECOSINE_USER` | `.lab` and `.lab small` had **no rule anywhere in app.css**, and `<small>` is inline by default, so label and key concatenated into one word. The key is the string an operator matches against a provider's own docs, so it has to be separable by eye — and monospaced, because it is an identifier. |
| `UBER_WEB_COOKIE · Paste from a logged-in supplier.uber.com session` | key and hint were joined with `' · '` inside one `<small>`, which set a sentence in a monospace identifier's typeface and wrapped it to three cramped lines in a 220px column. They are different kinds of thing and no longer share a line or a face. |
| **Admin access — Changes require the admin token configured on the server** | flatly false here. `api/admin_gate.js:63` runs the write gate **OPEN** when `ADMIN_TOKEN` is unset — it warns once and calls `next()` — which is this deployment's deliberate state. An operator who believed that sentence and saw a paste fail would hunt for a token problem that does not exist. |

The fourth is the one that matters beyond this page. A figure that cannot be
measured renders absent with a reason, and a **reason that is not the true one
is worse than no reason at all** — the page was asserting a server behaviour
instead of asking about it. It asks now: `GET /api/admin-mode` reports the
mode (never the value), and deliberately does not sit behind the gate, because
a page that cannot say whether writes are open until it is authorised to write
cannot tell an operator why their write was refused.

The two panels also took `data-panel` keys (`adminmode`, `credentials`) for
the reason `ui.js:27` gives: a panel a test must find should not be found by
matching prose against its `<h3>`.

## Payouts, the morning Bolt's 21 Sep payout arrived — 2026-09-23

Production at `d8b77f3` (deployment `1276e564`), through `bin/prod-mirror.mjs`,
`node bin/prod-shot.mjs payouts` at 1440. The payout itself is right: Bolt ·
Ecosine AED 1,275.14 and Bolt · Egari AED 619.18 on Monday 21 Sep, marked
`ledger` and "first seen Sep 23 10:10" (Dubai), Bolt's own balance and next
payout (Mon 28 Sep) in the "Bolt says" box, no missing-Monday warning, the
cadence counted live at 179 of 179. Two things around it were wrong:

| printed | why it was wrong |
|---|---|
| first row of **Uber's wire against our own figure** = `Sep 21, 2026 · Bolt · Ecosine · AED 1,275.14` | the panel was named when only Uber rows reached it and kept the name after Bolt's did. Now **Each wire against our own figure** — the route's own name for itself. |
| `No comparison is made for 91 transfers (Bolt)` beside `…88 transfers (Bolt)` (and `45`/`44` for Uber) | the notes are grouped by platform **and fleet** and printed with the platform only, so two notes differed by a number nobody could attribute. Now `(Bolt · Ecosine)`, `(Bolt · Egari)`. |

Before either, the same morning's first deploy (`942f255`) had printed, for
both fleets: *"No Bolt payout … has been seen for Monday 2026-09-21, in either
of Bolt's books … check the bank statement"* — while Bolt's ledger held the
payout and the collector had failed to store it (a JS array bound to JSONB;
COVERAGE.md traps). A reason that was not the true one. The sentence now
consults the stored ledger day and names a collection gap as one.
`test/payout_page_reconcile.test.mjs` §5 and `test/bolt_ledger_payout.test.mjs`
carry the checks; each was run against the unfixed file and failed first.

## Reskin STEP 3 — the colour law in render-audit, and #overview under the contract — 2026-09-23

Branch `reskin-foundation`, not deployed. `bin/render-audit.mjs` gained the
four checks the plan names (docs/UI-REDESIGN-PLAN.md §3, "Tests that pin what
changes"), each SPEC §3A clause read from the COMPUTED style of what the
reader sees:

| code | SPEC | what it reports |
|---|---|---|
| `highlight-budget` | L4 | more than 3 `.hl` on a page or 1 in a band; a highlight inside an `<svg>`, a `<tbody>` or on an absent figure |
| `grey2-text` | L5.7 | text (HTML, SVG `<text>`, or a pseudo-element's text) painted in `--grey-2` (2.90:1) |
| `off-token-colour` | L1 | a painted colour (text, background, border, SVG fill/stroke, `::before`/`::after`) that no custom property on `:root` resolves to; a token at reduced alpha counts as the token |
| `semantic-no-glyph` | L3, L5.5 | text in `--sem-pos`/`--sem-neg` with no ▲/▼ and no sign on it or its `.dlt` chip; a semantic dot with no word (the `content: "" / "…"` alternative, a `.sr` child or an `aria-label`) |

The three colour checks run only where `--pg-contract` is 1 (the Arkiv skin);
the old skin predates the law. To reproduce:

    node bin/live-ui.mjs &
    SKIN=arkiv ONLY=overview WIDTHS=1440,390 node bin/render-audit.mjs

**The pass, production data through live-ui, under the skin.** #overview at
1440 and 390: 0 findings, 3 highlights (the hero, the busiest day, the
absence band's sized figure). #sources, #payouts, #unit, #safety, #drivers at
1440: none of the four. #insights: `semantic-no-glyph 14` — "AED 389.01",
"AED 1,680.00 *" and the other impact figures in the ranked list are painted
in the negative red (the old `--critical`/`--warn`, re-pointed) with no ▼ and
no sign. That is the #insights plan entry's "Row AED loses its
--critical/--warn colour", left for its page. `test/audit_tools_detect.test.mjs`
drives each check against a stub carrying the fault, a stub carrying the legal
form, and the faulty stub under `--pg-contract:0`.

Screenshots of #overview, both skins, at 1440 and 390, light (and dark under
the skin): scratchpad `reskin/step3/shots/`.

## Reskin STEP 4 — the shell under the colour law, and a pass under the new shell — 2026-09-24

Branch `reskin-foundation`, not deployed. The Arkiv shell (shell.js,
docs/UI-REDESIGN-PLAN.md §3 "Shell") put the masthead, the section and view
rows, the banner, the control bar, the livebar and the title block OUTSIDE
#view, and render-audit's colour checks read only #view and #pageFoot — so
none of the new chrome was being checked. The scope now includes every child
of `#app.ak-shell > .main` except #view and #pageFoot (the class shell.js
stamps once it has built the shell; the old skin's rail predates the law).
`test/audit_tools_detect.test.mjs` drives it with a masthead date in grey-2
(reported) and in grey (not); with the chrome taken out of the scope that
check fails.

    node bin/live-ui.mjs &
    SKIN=arkiv ONLY=overview,settings,payouts,drivers,live,unit WIDTHS=1440,390 node bin/render-audit.mjs

**The pass.** Production data through live-ui, six routes at 1440 and 390
(12 renders): no error, the chrome clean under `grey2-text`,
`off-token-colour`, `semantic-no-glyph` and the highlight budget; two warnings
that are page content (#settings' "Restarts" column empty in 39 of 40 rows,
#live's slow panel). The mock, all 125 routes at 1440 under the skin: no
js-error, no finding in the chrome; the in-page findings are the ones STEP 3
recorded (#compare's ▲/▼ with no sign ×5 routes, #coverage's red counts,
#receipts' "−AED" with no glyph, #insights' impact figure, the browser-grey
inputs on #online-time/#trips/#playbook, #retention's cell backgrounds) —
each page's own plan entry.

**Measured with the shell in place** (#overview, production data, 1440×900):
masthead 61px, section row 38, view row 38, the three-row banner production
carries 252, control bar 56, livebar 119, title block 71 — #view at 635px and
the first tile at 897. Without the banner, #view would be at ~383. The fold is
the banner's (FIX-STATUS "Arkiv reskin, STEP 4", NOT DONE).

Screenshots of #overview, #drivers, a driver's page, #payouts, #settings and
#live under the skin at 1440 and 390, light and dark: scratchpad
`reskin/step4/shots/`.

## Arkiv page phase — desktop — 2026-09-24

The page phase (plan STEP 6) converts each desktop page to the contract under
`?skin=arkiv`. Each page's pass is recorded below: the widths and themes it
was looked at in, against production data through `bin/live-ui.mjs` (on
:8611; the phone branch uses :8711), what was found and what was done.

**How the old skin is held.** `node test/arkiv_classic_frozen.test.mjs`
renders every route in the old skin with both clocks frozen and compares each
page's normalised DOM with the base's; a route whose hash moved has its HTML
written to `$TMPDIR` for a diff. It replaces the per-step pixel harness for
the DOM half of "the old skin did not move"; a pixel pass is still the proof
for CSS, and the page phase changes no old-skin CSS.

### #insights — 2026-09-24

Production data through live-ui :8611, `?skin=arkiv` and `?skin=classic`, at
1440 and 390, light and dark (8 full-page shots, scratchpad
`pagephase/shots/insights/`). No page error, no sideways scroll, two
highlights (the hero, the priced share). Found and fixed before commit: the
ranked rows three to a line under the skin (the list sat in `.hbars`, which
the skin makes hbars' grid); at 390 the "No cost model exists" sentence in
the cost chart's value column squeezed every bar to a stub (the column is
shared by every row); and against a server without `.by_code` the absence
band said "None open" about a cancellation cost it could not see — a reason
that was not the true one. On production today the list is not capped (197
open), so the by-kind and cost charts are complete even before the server
change deploys; the page says so either way.

### #playbook — 2026-09-24

Production data, both skins, 1440 and 390, light and dark (scratchpad
`pagephase/shots/playbook/`): no error, no sideways scroll, two highlights.
Found by looking and fixed before commit: the 01 caption printed "(0 journeys
in the window)" against a server that does not send the count yet — a figure
that was never measured, printed as 0; it now prints the count only when the
answer carries one. The caveat said "expect roughly a third of the ceiling"
directly after "about 5% of it" (production: 12 bookings against a median of
224): the contract's copy prints the measured share.

### #compare — 2026-09-24

Production data (today against yesterday, cut at the Dubai minute), both
skins, 1440 and 390, light and dark (scratchpad `pagephase/shots/compare/`):
no error, no sideways scroll, two highlights. Found by looking and fixed
before commit: the hour chart kept its "Loading…" line above the drawn rows;
gapBars' caption counted the unreached hours as "17 of 24 days" (the shared
`bucketNoun`, S1); the driver table printed "— vs — – 0.0 h" for two
unmeasured waiting times; By channel's Trips column still used the old
unsigned arrow. The render-audit finding STEP 3 logged here ("▲/▼ with no
sign", ×5 routes) is the old delta, which the contract no longer draws.

### #analyst — 2026-09-24

Production data, the default tab and Rules in both skins at 1440 and 390,
light and dark; refuted, immaterial and unsupported at 1440 light (scratchpad
`pagephase/shots/analyst/`). No error, no sideways scroll, two highlights
(one on Rules). The old skin's default tab is 61,996 characters of text
against 20,293 under the contract: the same judgements, the older ones of
each claim folded into a closed disclosure. Found and fixed before commit:
segment labels printed the raw platform key ("bolt") where the cut is a
platform; they use the channel's name.

### #action — 2026-09-24

Production data, an idle-vehicle finding and a silent-tracker finding, both
skins, 1440 and 390, light and dark (scratchpad `pagephase/shots/action/`).
No error, no sideways scroll, one highlight (the hero; no † cell carries a
figure to size). The silent-tracker page draws all 17 open findings of its
rule with this one marked, which the old page could say only as a table.

### #unit — 2026-09-24

Production data, the three tabs in both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/unit/`). No error, no sideways scroll; three
highlights on Money in (the hero, the busiest band, the measured hours), one
on each list tab. Found by looking and fixed before commit: the hours bars'
first label ran out of its column ("Online, with someone in t…"); the
drivers-least list printed "availability has not been collected for anyone in
this window" beside a verdict counting 100 people with measured availability
(the pruned column's reason, now the list's own); the reference line on Every
vehicle, once drawn, had the wrong slope (S2).

### #playbook, again — 2026-09-24

Re-shot after P2a at 1440 and 390, light and dark (scratchpad
`pagephase/shots/playbook/`): the verdict carries the measured total, the
glance starts at Things to do, two highlights, no sideways scroll. The pass
that found it checked every converted page for a tile printing the verdict's
figure (#insights, #compare, #analyst, #action, #unit, #overview: none on the
mock; #playbook: always; #revenue: on production, where the verdict is the
accounted total).

### #revenue — 2026-09-24

Production data, both skins at 1440 and 390, light and dark (scratchpad
`pagephase/shots/revenue/`). No error, no sideways scroll, two highlights.
Found by looking and fixed before commit: the verdict's AED figure was
printed again by the Accounted for tile (ruling 7 — S4, and P2a for
#playbook, which had the same fault); the channel swatch in the table sat
flush against the name; at 390 the table's second line scrolled off with the
table, and now holds to the visible width.

### #corporate — 2026-09-24

Production data, all five tabs in both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/corporate/`, 40 shots): no error, no sideways
scroll; two highlights on the overview. Production has no named property
(the one booker carries no partner id), so the overview shows the index as
absent, the unnamed bar unlinked and "None named" in the † band. Found by
looking and fixed before commit: the verdict's AED figure repeated by the
Billed tile (ruling 7); booked ahead drawn as "Other (1)"; the leak list's
rows 132px tall; the no-scope reason only in a tooltip.

### #property — 2026-09-24

No property resolves on production (the one booker has no partner id, so
`#property` shows "No property chosen" in both skins, unchanged). Rendered
against the mock's `h-palm` at 1440 and 390 (scratchpad
`pagephase/shots/corporate/prop-mock*.png`): no error, no sideways scroll,
one highlight (the hero).

### #import-sheet — 2026-09-24

Production, both skins at 1440 and 390, light and dark (scratchpad
`pagephase/shots/importsheet/`): no error, no sideways scroll, no highlight
(a form has no figure to emphasise).

### #opening — 2026-09-24

Production (347 people across 810 accounts, 0 openings stated), both skins
at 1440 and 390, light and dark (scratchpad `pagephase/shots/opening/`): no
error, no sideways scroll, two highlights. The ceiling: AED 3,440,115.08 over
276 of 347 drivers, 71 with no cash fare, reaching back 644 days. Found by
looking and fixed before commit: the † "what each driver owes" cell's
fallback claimed everyone had a book row when none did; "347 of 347 unknown"
wrapped at 1440 (the word moved to the label).

### #salary — 2026-09-24

Production (347 on the payroll; no salary ever recorded; 149 with a
generated figure, 73 exactly 0.00, 125 none), both skins at 1440 and 390,
light and dark (scratchpad `pagephase/shots/salary/`): no error, no sideways
scroll, two highlights. Found by looking and fixed before commit: the
spread's band labels were cut ("30,000–40,…"); they are named by the lower
edge and the width is said in the caption.

### #advances — 2026-09-24

Production, both skins at 1440 and 390, light and dark (scratchpad
`pagephase/shots/advances/`): no error, no sideways scroll, two highlights.
215 of 347 people have both a cash fare and a generated figure; 61 have cash
fares and no generated figure; 71 have no cash fare.

### #charging — 2026-09-24

Production through live-ui (whose API is production's, so the register still
answers with the whole record until S5 deploys), both skins at 1440 and 390,
light and dark (scratchpad `pagephase/shots/charging/`): no error, no
sideways scroll. No charging advance has ever been recorded (0 of 347), so
the hero is absent with its reason and no highlight is drawn. Found by
looking and fixed before commit: the head note read "This month" over a
whole-record answer; the sessions row printed "0" for a count that does not
exist.

### #policy — 2026-09-24

Production (no line ever stored; 347 people, 0 measurable), both skins at
1440 and 390, light and dark (scratchpad `pagephase/shots/policy/`): no
error, no sideways scroll, one highlight. 215 people carry both halves of
the ratio, 61 cash only, 7 earnings only, 64 neither.

### #deposits — 2026-09-24

Production, both skins at 1440 and 390, light and dark (scratchpad
`pagephase/shots/deposits/`): no error, no sideways scroll, two highlights.
58 of 276 drivers carry half the ceiling; the last-cash-fare months show
cash still coming in this month for about a hundred drivers. Found by
looking and fixed before commit: "347 of 347 unknown" wrapped at 1440.

### #finance — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/finance/`): no error, no sideways scroll, two
highlights (the hero and the fare-coverage absence). The open week (Uber, 21
to 27 Sept) is three hatched bars at the end of 01, worked out at 74.7% of
that week's own fares; Money in's change (+20.7%) is over 14 to 20 Sept
against the week before — closed statement days only — while Platform
payouts' and Trip value's run to 16 Sept, each saying which week it
compared. The sixth tile (The open week) wraps to a second row at 1440; left
as it is, not reflowed.

### #receipts — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/receipts/`): no error, no sideways scroll. 230
filings from 9 source-and-channel combinations, 207 of them one day, 23 a
week; every row carries ONE stamp (24 Sept 08:45, the register's last
rebuild), so the arrival tile is absent and the First seen column is dropped
with its reason. 40 filings are superseded (AED 488,609.03 set aside, all
payout). The open Uber week (25 to 27 Sept) is claimed ahead of today and
drawn hatched in 01. Found by looking and fixed before commit: 03 drew a
zero axis in the middle of four positive sums (signed bars now only when a
kind nets negative).

### #payouts — 2026-09-24

Production (the whole record — the page takes no window), both skins at
1440 and 390, light and dark (scratchpad `pagephase/shots/payouts/`): no
error, no sideways scroll. AED 10,804,335.95 over 333 transfers on 92 dates,
every one a Monday, from 23 Dec 2024; 65 of 333 can be checked against our
own figure, +AED 362,992.41 over those, most of it three February
transfers (named in 02's caption). Found by looking and fixed before commit:
02 printed "−+AED 103.05" — hbars prints the minus itself and hands
valueFmt the magnitude.

### #reconcile, #reconcile/2026-08 — 2026-09-24

Production (the whole record), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/reconcile/`): no error, no sideways scroll.
5 months of 24 can be reconciled; AED 73,861.06 more wired than owed
(+4.7%, deltaPill); the latest comparable month is August (+4.5%, 1.1
points narrower than July). Sixteen months before February 2026 carry
neither side (outside the statement window) and draw as outlines;
September is hatched in 04 as a period the window cuts.

### #settlement, #settlement/cash, #settlement/receivables — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/settlement/`): no error, no sideways scroll.
Cash: 22% of 3,296 cash bookings carry no fare; the platforms report AED
111,974.42 against AED 139,366.61 we can see, so the tile now says "the
smaller of the two" where the old one said "the larger"; 116 of 196 rows
carry both readings and the scatter shows the two agreeing along a line
with a cluster of statement-heavy rows at low fare value. Receivables: AED
32,577.06 over 352 bookings, every one priced (no-fare 0), ageing 0–30 /
31–60 / 61–90 / over 90 with the last a measured nought.

### #provenance — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/provenance/`): no error, no sideways scroll.
AED 674,676.46 headline; 9 calls, 14 channel-and-kind combinations; 26,667
figures, 7.3% restating (all of them the two Uber GraphQL breakdown rows,
72–77%); 4 of 4 channels answering. 4 of 14 calls are counted; Uber's
statement basis matches none of the listed calls, which the hero's sub now
says.

### #demand — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/demand/`): no error, no sideways scroll. The
busiest hour is 15:00 (67.7 bookings on an average day, 9% of the day,
17.6× 03:00); Friday leads per occurrence at 856 a day over three Fridays;
an average Saturday or Sunday carries 754 against 832 on a weekday.

### #trips — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/trips/`): no error, no sideways scroll. 16,242
of 18,006 bookings carry a fare; 1,697 cancelled never charged, 90 completed
with the fare not filed yet, 8 recovered from earnings, none charged-but-
unpriced. The settlement bars list the 24 payment types the answer names.

### #supply — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/supply/`): no error, no sideways scroll. 70% of
23,036 online hours idle; 12,031.4 h of waiting between jobs over 12,224
waits in 214 areas; the week's online hours peak 16:00–19:00 while an hour
buys the most at 15:00.

### #platforms, /tiers, /funnel — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/platforms/`): no error, no sideways scroll.
Uber is 91% of 17,936 bookings; Hotel completes 99.4% (+11.0 points on the
fleet's 88.4%), Bolt 52.5% (−35.9); 168 offers declined. Found by looking
and fixed before commit: completion by channel carried hbars' "added /
deducted" legend over bars that mean above / below the fleet.

### #corridors — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/corridors/`): no error, no sideways scroll.
Al Garhoud → Dubai Int'l Airport leads at 279 trips; 1,742 trips (32.4% of
the 119 routes sent) never leave their area; 89 of 90 named routes carry a
priced trip, their fares rising with distance.

### #causes — 2026-09-24

Production (the whole record), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/causes/`): no error, no sideways scroll. The
largest real move is +1,029%, Mar → Apr 2025, and the headcount explains 6%
of it — bookings per driver the rest. Found by looking and fixed before
commit: 02 carried hbars' "added / deducted" legend; it says "added
bookings / took bookings away" now.

### #forecast — 2026-09-24

Production, both skins at 1440 and 390, light and dark (scratchpad
`pagephase/shots/forecast/`): no error, no sideways scroll. Oct 2026 is
16,000 – 31,900 — the straight line against the scaled year-ago month, 99%
apart with ranges that do not overlap; September is running at 23,377
against a 14,700 forecast, outside its range.

### #optimise — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/optimise/`): no error, no sideways scroll. Al
Garhoud runs +1,201 bookings over arrivals while Dubai Int'l Airport piles
up −483 — the same Terminal 3 written two ways, which the caption names.

### #capacity — 2026-09-24

Production (for Oct 2026), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/capacity/`): no error, no sideways scroll. 7
hours of the week are short, 4 driver-hours in a week; the weekday columns
now add to that. Wednesday 15:00 is the busiest single hour.

### #day/2026-09-23 — 2026-09-24

Production, both skins at 1440 and 390, light and dark (scratchpad
`pagephase/shots/day/`): no error, no sideways scroll. 895 bookings, +1.0%
on the fortnight median of 886. Found by looking and fixed before commit:
the hero printed its fortnight change twice (delta and sub).

### #slot/2/19 — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/slot/`): no error, no sideways scroll. 238
trips on Tuesdays at 19:00; per occurrence Tuesday carries 59.5 against a
50.2 mean of the other weekdays (+19%); the busiest person holds 7 (2.9%).

### #trip — 2026-09-24

Production, a hotel booking and an Uber booking of the day, both skins at
1440 and 390, light and dark (scratchpad `pagephase/shots/trip/`): no
error, no sideways scroll. The hotel booking: fare AED 108.96, 33.9 km, 40
min request to end, 6 of 10 fixes with the seat occupied; FMS telematics
drew 10 fixes (4 stationary), and Uber's driver-status feed contributed 2
rows with no speed and no position. The Uber booking: fare and earnings
absent with Uber's own reasons. Found by looking and fixed before commit:
both feeds labelled "provider not recorded"; every FMS fix read as no seat
reading; the occupancy count doubled by two FMS providers; the hotel
earnings' reason naming a payments report that channel does not have; the
Uber fare's reason drawn at display size at 390.

### #drivers — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/drivers/`): no error, no sideways scroll (the
roster scrolls inside its own frame). 146 cannot legally work — the verdict —
over 347 on the books (252 Ecosine, 95 Egari), 114 drove with a median of
163 bookings each, and the top 20 ran 30.0% of the work. Found by looking
and fixed before commit: in six columns the wrapped name ran into the trip
count on every card; the count now sits on its own line.

### #driver/overview — 2026-09-24

Production (This month), a busy multi-channel driver, both skins at 1440
and 390, light and dark (scratchpad `pagephase/shots/driver-overview/`): no
error, no sideways scroll. 288 trips, +131 against the fleet median of 157,
97th percentile of 121. Found by looking and fixed before commit: the rank
row's value line sat in the label's column and wrapped; it spans the row.

### #driver/activity — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/driver-activity/`): no error, no sideways
scroll. 206.5 h online and not dispatched — 70% of 296.8 h online over 24
days with availability — beside 90.3 h on job and 278 jobs, 23 with no
dropoff. The first attempt, on the busiest driver in the fleet with three
page loads at once, did not finish: see the trap in COVERAGE.md.

### #driver/day — 2026-09-24

Production, 23 Sept for a multi-channel driver, both skins at 1440 and 390,
light and dark (scratchpad `pagephase/shots/driver-day/`): no error, no
sideways scroll in the new skin. 4h 14m carrying someone, 33% of online
time; 11 trips, ▼ 0.6 against 11.6 a working day this month; 128.4 km, trip
value AED 695.45. The old skin scrolls 15px sideways at 390 on this page
(unchanged by this work — the frozen skin). The month comparison arrives
after the first paint, so a screenshot needs a longer settle (WAITMS=5000).

### #driver/territory — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/driver-territory/`): no error, no sideways
scroll. 84 waiting spots drawn filled and grey; 2 of 223 pickups carry
coordinates, the rest have an address and no position, which the caption
under the map already says. Found by looking and fixed before commit: the
key under the map still showed the dashed ring for waiting spots.

### #driver/earnings — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/driver-earnings/`): no error, no sideways
scroll. Booked revenue AED 14,113.32 over 253 of 278 trips; riders paid
38.1% braintree, 20.9% apple_pay, 16.5% offline, 14.0% cash. Found by
looking and fixed before commit: a hand-picked --seq-N ramp printed the
shares dark on dark (stackedBar's label ink is measured for the --cat-N
slots, not for the ramp); the bar now takes the slots.

### #driver/quality — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/driver-quality/`): no error, no sideways
scroll. Completion 91.7%, ▼ 3.3 pts to 95%; 94.8 alerts per 100 km, ▲ 26.6
against the fleet median of 68.2 (worse); acceptance absent — no channel
here publishes one.

### #driver/record — 2026-09-24

Production (week by week), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/driver-record/`): no error, no sideways
scroll. "Within their usual range", 82 jobs over 7 active days; 7th of 116
on jobs, 12th of 113 on value. The Trip value tile's sub-line says 0 of 82
completed trips priced beneath AED 4,923.29 — in both skins; recorded in
FIX-STATUS as found, not changed.

### #driver/money — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/driver-money/`): no error, no sideways scroll.
Every position absent with the ledger's own reasons (no opening cash
position; nothing on the advance or deduction books; no stored threshold);
over the month, income at least AED 9,448.85 and AED 1,636.82 of cash fares.
Found by looking and fixed before commit: the in-panel hero drew the income
at display size across two lines, and the advance and deduction tiles would
have printed their definitions as reasons.

### #driver/trips — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/driver-trips/`): no error, no sideways scroll;
the first cold load took 63 s (the trip list for a busy driver), later ones
4 s.

### #driver/unauthorized — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/driver-unauthorized/`): no error, no sideways
scroll. Named beside 4 journeys (2 by time, 2 by the car's last trip),
44.1 km, AED 199.95 forgone — AED 186.77 of it narrowed by time.

### #online-time — 2026-09-24

Production (today, start 06:00), both skins at 1440 and 390, light and
dark (scratchpad `pagephase/shots/online-time/`): no error, no sideways
scroll. 48 late, 29 on time, 83 cannot be judged, 71 drove of 134 allowed;
the median wait to a first job 47 min over 62 people, 11 online with none
yet. The latest starter came online at 10:09, ▲ 249 min late.

### #performer — 2026-09-24

Production (week of 14–20 Sept), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/performer/`): no error, no sideways scroll.
AED 3,669.89, ▲ 1,983.37 against AED 1,686.52 — the mean of the 151 who
earned; 11th of 151 by money; per day worked AED 524.27, ▲ 252.49 against
the fleet mean; 84 bookings, 31.9 h carrying someone, 49.3 h waiting.

### #cohort — 2026-09-24

Production, unit-licence-due and roster-blocked, both skins at 1440 and
390, light and dark (scratchpad `pagephase/shots/cohort/`): no error, no
sideways scroll. The truth fix on real data: 60 people, "licence expired or
expiring", every one of the 60 already lapsed and 0 due within 30 days —
where the old skin reads "Licences due 60 · expiring within 30 days". 44
of the 60 carry the same expiry date, 1 Jan 2026; 59 of 60 are still
marked able to earn; 235 of the 308 in the source have no licence date.

### #cancellations — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/cancellations/`): no error, no sideways scroll,
no whole-dirham amount in either skin. 2,092 cancellations, 11.9% of the
17,560 bookings the 117 drivers took; 124 dropped jobs (96 Uber after
accepting, 28 Bolt after accepting), 168 Bolt offers not taken, 1,781 by
the rider, 19 nobody said who — all 19 from one channel, so that bar wears
its colour. Dropped after accepting: 85 of 12,240 accepted (0.7%) by the 83
who work Bolt, 39 of 5,152 (0.8%) by the 34 who do not. 19 of 117 carry no
rating. Found by looking and fixed before commit: at 390 the bar labels were
cut off mid-word, so the four bars now carry the tiles' own short names; the
rank columns were drawn in --ink, and are now the job token.

### #roster, /pipeline, /idle, /blocked, /states — 2026-09-24

Production (This month), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/roster/`): no error, no sideways scroll on
any tab. 360 on the books, 128 drove, 98 able to earn and earning nothing,
91 recruited and never driven, 11 waiting to start, 32 stopped everywhere
(the verdict), 31 of them holding a car across 25 plates. Recency: 101
booked today, 21 within a week, 9 within a month, 21 within 90 days, 19
within 180, 92 longer ago; 97 never took one. Found by looking and fixed
before commit: the standings' counts caption was wiped by the bar's own
redraw on layout, and at an 18ch floor driver names still wrapped to three
lines — 24ch holds them to two.

### #top-performers, #low-performers — 2026-09-24

Production (week of 14–20 Sept), both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/performers/`): no error, no sideways scroll, no
whole-dirham amount. 98 ranked of 155 who drove (▲ +8 on the week before);
fleet AED 319.13 per day worked (▲ +44.91); the ends 4.4× apart, AED 638.60
at the top and AED 145.87 at the bottom; 75 of 155 worked all seven days;
the 39 who ran least ran 1.7% of the week's 5,865 bookings; the top 10 ran
16.2%, the top 20 29.7% against an even 12.9%. Found by looking and fixed
before commit: the concentration drawn as a scatter carried its even-fleet
line past 100%.

### #performance, #performance?grain=month — 2026-09-24

Production, both grains, both skins at 1440 and 390, light and dark
(scratchpad `pagephase/shots/performance/`): no error, no sideways scroll,
no whole-dirham amount. Week of 14 Sept: 116 active (the verdict), 5,193
jobs (▲ +722 on the week of 7 Sept), AED 331,057.35 of trip value
(▲ +57,330.47), 7.2 a day, 1 changed of 107 tested at 3.5σ; 113 drivers
placed on the scatter. August: 115 active, 12,340 jobs (▲ +2,854 on July
2026), 4 changed of 101. Found by looking and fixed before commit: the
month delta read "on the July 2026", and the period chips sat under the
band whose verdict they choose.

### #retention — 2026-09-24

Production, both skins at 1440 and 390, light and dark (scratchpad
`pagephase/shots/retention/`): no error, no sideways scroll, no whole-dirham
amount. 170 earning in Aug 2026 (▲ +16 on the month before), against the
peak of 265 in Oct 2025, the low 92 in Dec 2024; 20 stopped (▲ +6 on Jul
2026, read as worse), 8 started (▼ −1); 132 of 324 recruits still working;
a typical run of 8 months over 246 leavers, the 170 still working 14 months
in. Seen and not changed: the flow chart's axis text is drawn in a fixed
viewBox and scales up at 1440 in both skins.

### #compliance — 2026-09-24

Production, both skins at 1440 and 390, light and dark (scratchpad
`pagephase/shots/compliance/`): no error, no sideways scroll, no
whole-dirham amount. 50 people with a lapsed licence (the verdict; 275
people over 438 records): none drove this week, within 30 or 90 days; 15
longer ago; 35 with no driving we can see. 0 vehicle papers expired, 3 in
7 days (the hero), 23 in 45; 4 people expiring in 45 days; 2 whose records
disagree. By channel: Uber 160 records, none dated; Yango 146, all dated;
Hotel 132 — 94 on the default date, 38 undated. 232 people carry a date
that can be checked, 50 of them lapsed.

### #hr-roster — 2026-09-24

Production (the export of 23 Sept), both skins at 1440 and 390, light and
dark (scratchpad `pagephase/shots/hr-roster/`): no error, no sideways
scroll. 143 on HR's list (Ecosine 100, Egari 43), 60 with anything expiring
in 90 days, 134 matched to a platform account (112 by id, 22 by phone, 9
not matched), 0 off the list. The import form was not exercised (no upload
against production).
