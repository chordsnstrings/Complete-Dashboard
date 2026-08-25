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

