# Fix status — what is written, what is on production, what is proven

Companion to `docs/FIXLIST-2026-09-05.md`, which says what is *wrong*. This says
what has been *done* about it, and — the column that matters — how the claim was
checked. Started 2026-09-05.

The point of this file is that "fixed" is four different states and conflating
them is how a dashboard ends up telling you something it stopped being able to
prove. So each row carries all four:

| state | what it means |
|---|---|
| **written** | the code is changed and the suite is green |
| **committed** | it is on `claude/ecosine-egari-tracking-apis-rf9ong` |
| **deployed** | it is running on `fleet-dashboard-wpeqb.ondigitalocean.app` |
| **proven** | re-measured on production *after* the deploy, by the same method that found it |

A row is only finished at **proven**. `written` on its own is a hypothesis; the
suite passing tells you the tests agree with the code, not that the code agrees
with the fleet.

---

## Batch 1 — anonymous callers were served driver identity documents

Commits `6bfe0e3`, `1084cbf`, `4304ad4`. **Proven on production 2026-09-05**, by
curl carrying no cookie, no header and no token — the same way the leak was found.

| # | what | proof |
|---|---|---|
| C1 | `/api/trip` served the hotel provider's record verbatim | bcrypt `$2b$10$…`, `784-1999-8885500-5` and `ExponentPushToken[…]` all absent; `raw._redacted` names the three paths taken |
| C16 | the same credentials were *stored*, not just served | `sql/schema_v59.sql` ran; stored rows scrubbed, `schema_once` row present |
| C12 | `/api/compliance/drivers` — 123 Emirates IDs, 94 licence numbers | both keys absent, `identity_withheld` names them, reason given |
| C12 | `/api/schema/raw-values` sampled provider records | clean on `driver` and `driverInfo` |
| C12 | `/api/export/trips.csv` — 265,739 rows with addresses | `(withheld)` in both address columns |
| — | `/api/probe/results` sampled secrets | withheld sentinel, distinct counts kept |
| — | **`/api/driver/profile` — a fifth route the audit missed** | keys absent, `identity_held` reports the papers exist |

The fifth route is the one worth remembering. It answers for **one named
person** rather than a list, which is the shape somebody actually wants, and it
survived the first fix because `IDENTITY_DOCS` lived inside a single route in
`api/server.js` while this route lives in `api/driver_routes.js`. The definition
now lives in `api/redact.js` and both import it. **If you add a route that
selects `licence_no` or `emirates_id`, import `stripIdentity` — do not re-derive
the list.**

What deliberately survives redaction, because the operator asked for it in as
many words: **phone, email, picture, name, licence expiry, days-left**. A
security fix that deletes those is a broken page wearing a badge.

Screenshots, desktop and mobile: driver card reads `LICENCE withheld · EMIRATES
ID withheld` beside the phone number; compliance table's two columns read
WITHHELD with the reason above; hotel trip page states "1 field withheld:
`car.licenseNumber`" over a record carrying `_redacted` and no values.

### Still open in this batch, by instruction

`api/admin_gate.js` fails **open** when `ADMIN_TOKEN` is unset, which is this
instance. Held that way deliberately — "don't bother with token, we need to test
everything before we create security fixes". The read side is redacted anyway, so
the cost is bounded. **To close it: set `ADMIN_TOKEN` on the API component
first, confirm it, then delete the `if (!configured)` branch. Variable first,
code second — the other order is a lockout.**

---

## Batch 2 — the eleven small criticals

Commits `c034bb1` (round one), `7971589` (the refutations), `a72e71b` (a page
that could not load). **Proven on production 2026-09-05**, each by the
measurement that found it.

| # | what it did | re-measured after the deploy |
|---|---|---|
| C2/C15 | dragging 240→300 days took fleet income from AED 2.75M to **8.89M**, silently changing the figure's meaning from net payout to gross fare | 300d now AED 2.99M, uber `basis=partial_payout` holding its real payout 2,319,203.89. The cliff is gone at 240, 300 and 365 |
| C3 | `/api/kpis` divided by calendar days, so the picker made "Money in" read AED 168,213 against a true 125,189 | kpis and revenue agree **to the cent** on both windows tested — 148,340.39 and 499,453.53 |
| C4 | 45 of 98 plates reported Uber's gross as the car's income, AED 64,548.64 above the ledger | 40 plates swept: **0** still report fares while holding a payout |
| C5 | `#causes` said FMS fell 97% into January when it rose 15%; the KPI tile and the cards below disagreed | 34 → **25** stored rows; tile and panel now both read +1,029% Mar 25 → Apr 25 |
| C6 | every chip read 25,907 online hours byte-identical; Bolt was called 99% idle on a feed that does not exist | ecosine 17,274 + egari 8,633 = 25,907 exactly; **Bolt renders an em-dash and "never collected here"** |
| C7 | the provenance page said "No provider sent a figure for this window" for 112s of every 900s | **176 consecutive samples across a live rebuild**, never once blank or partial |
| C8 | `#causes` and `#forecast` disagreed about Dec 2024, flipping the page's central conclusion | Dec 24 now partial with 13 days; the two telematics-only months report `days_in_record: null` |
| C9 | 31 working vehicles showed "0 per 100 km" in the tone reserved for good news | **26 of 26** untracked plates render absent with the reason |
| C10 | a Yango trip page printed AED 342.05 as Yango's net on a day whose Yango fares were AED 66.00 | yango, bolt and hotel all `statement_day: null`; uber keeps its own, now with `period_days: 7` |
| C11 | the headline read AED 384,266 over a Gap tile reading 117,766, on one screen | banner and tile agree — 6 months, delta 117,588.87, and the 2 excluded months are named |

18 of 18 pages render with no console error.

### What the adversarial verifiers were worth

Round one's eight lanes were each read by a verifier told to refute rather than
confirm. **Two succeeded**, and both had found a regression introduced *by a
fix*: C8's span narrowing made a `Math.max(1, …)` clamp reachable so a
telematics-only month claimed "1 of 31 days collected", and C10's new caption
asserted the provider filed nothing on 175,105 Uber bookings where the truth is
that we do not reach back that far. Neither was caught by any test.

Round two answered both, and its own verifiers found six more — almost all of
one kind: **a figure correctly made absent and then given a reason that is not
true.** A caption sending readers to `#reconcile` to see a comparison that page
deliberately does not perform. `?? 0` printing "0 of the 31 days Uber worked"
for coverage that is unknown. A future window told its days "cannot be
backfilled". `/payout/` matching the new `zero_payout` basis, so a channel paid
nothing was named among those that reported paying.

### And the one the tests could not have caught

`#supply?platform=bolt` — the exact page the chip fix was written for —
rendered **"COULD NOT LOAD THIS VIEW · noFeed is not defined"** while 30
assertions passed green. The tests drove the route; nothing drove the page.
Found by screenshotting production after the deploy. The file now carries a
thirty-first assertion that every local the module reads is declared in it,
verified by reintroducing the dangling name and watching it fail.

**A suite passing tells you the tests agree with the code. Only a screenshot
tells you the page renders.**

## Batch 3 — the medium and large criticals

Commit `d46af3d`. **Deployed and proven on production 2026-09-06**, except C18
and C24 — both named below with exactly what remains.

| # | before | after, re-measured |
|---|---|---|
| C13/C19/C25 | six August days on a 4/7 grid publishing AED 44,903 of gap nobody owed | **grid 7/7**; the days' `ontrip_net` 8,243 → **16,344.24**; delta_pct +169.0 → +34.6; **month delta 64,725.52 → 24,261.78, 19.0% → 6.4%**; Ecosine on-trip revenue 281,621.58 → **331,319.48** |
| C14 | 3,513 occupancy intervals where 1,409 journeys happened | **1,412 segments**; partial 1,632 → 572, authorized 1,178 → 522, and `unauthorized` 59 → **58** — exactly the "inflated by one, not 2.5x" the audit predicted |
| C23 | Egari shown owning **273** vehicles, 29 earning | Egari **40 / 33**, Ecosine **98 / 69**, unassigned 135 — and 40 + 98 + 135 = **273 exactly** |
| C17 | "Carried an authorisation 12.8%", 155 counted as authorised | `authorized_trips` **0**, `pending` **225**, `approval_required` **225**, pct **0** |
| C18 | 132 phantom plates in the fleet-size denominator | **PARTIAL — see below** |
| C24 | 62 of 171 drivers are one human twice | **STAGED, not live — see below** |

The two money predictions were made before the deploy and hit almost exactly:
the audit predicted August would land at "24,432.69 / 6.4%" and it reads
24,261.78 / 6.4%; the verifier independently derived Ecosine's on-trip revenue
at 331,319.47 and it reads **331,319.48**.

18 of 18 pages render. `#reconcile/2026-08` now headlines **AED 24,262** and
`#unauthorized` reports 5 unexplained journeys over 91 km rather than totals
built from 3,284 intervals.

### C18 is partial, and the remaining half is not verifiable today

The collector half landed: `src/sources/cabman.js` now keeps a roster in
`source_state`, admits a plate after `ADMIT_POLLS` (3) consecutive polls and
departs it after `DEPART_POLLS` (**288** — a full day at five-minute polls),
and raises an alarm when the payload collapses against the roster it holds.

But **no plate can be marked departed for roughly 24 hours by design**, and no
route reads the field yet. Measured after the deploy: `tracked_vehicles` still
**265**, `/api/live` still returns 175 CABMAN rows across four `polled_at`
cohorts, `departed` flagged on **0**. So the denominator has not moved.

Wiring the API side blind — while its input is provably empty — is exactly the
unverifiable change this whole exercise avoids, so it is not done. What it needs,
from the lane's own report: `api/server.js` (`tracked_vehicles`,
`silent_vehicles`), `api/vehicle_routes.js` (the directory and its cohort tiles),
`api/cohort_routes.js`, `api/economics_routes.js` and `api/playbook_routes.js`
must read the roster's departed set and **state the exclusion** rather than
silently dropping the plates. Re-check after the first departures land.

### C24 is staged, not live, and that is deliberate

The lane verified **50 additional merge pairs** with per-pair evidence (shared
plates, shared days, interleaving, channels) and **refused 3** with reasons —
including a pair with *"241 simultaneous trips in two different cars across 70
days"* and one marked UNDECIDABLE for having no shared vehicle at all. That
refusal list is the evidence the rule discriminates rather than merging anything
that rhymes.

They are exported as `PENDING` and are **inert**: `ALIAS_KEY` still holds the
original 3, and `identityCase()` still emits only those. Activating them is not
a code change — `person_key` is a **stored generated column** built by
`sql/schema_v53.sql`, so switching it on means a migration that recomputes the
column across 364,015 rows and changes who the product says drove what, for 50
named people, on pages that name them.

That is worth doing and worth doing **on its own**, with its own verification
and its own deploy, rather than buried in a batch of five other changes. Until
then the headcount still reads 171 and the register records why.

### What the verifiers caught this round

The same species as last time — a figure fixed and then given a reason that is
false — plus one genuinely dangerous gap:

- **The plate half of the segment `DELETE` was unpinned.** Removing
  `plate = ANY($1)` entirely left all 17 assertions passing, because the two
  fixture plates were separated by the *window*, not the plate list. The
  scenario it defends — a plate holding a segment in the window whose tracker
  has since gone dark — needed a second reporting plate to keep the pass
  non-empty. With that seeded, a plate-blind DELETE erases a real journey:
  `[] was [{L44307, 05:20→06:00, verdict partial, fixes 9}]`.
- **`stamp` let the last profile row win.** `vehicle_profile`'s key is
  `(platform, vehicle_ext_id)`, so a car known to two channels arrives twice; a
  plate stamped `ecosine` on its Uber row and unstamped on its CABMAN row
  resolved to null — dropping it from its own fleet and counting it as
  unplaceable. `unassigned` counted profile *rows*, not distinct plates.
- **The collector announced an effect the product had not implemented.**
  `departed_reason` ended "so they are no longer counted as fleet" while
  `/api/kpis` still reported `tracked_vehicles` 265 and the directory 273 rows,
  because no route reads the field yet.
- **A comment cited evidence its endpoint cannot give.** It claimed "/api/trip
  says each of those two bookings carries no partner_id" — `/api/trip` returns
  no `partner_id` at all. The property lives in `raw.hotel`.

## `docs/COVERAGE.md` — two corrections

Commit `80ddcad`. Both were mine, both written the day before, and both pointed
the same way: at giving up.

- **Retention is ~17.6 months, not ~12.** Measured, not read off documentation:
  `PAYMENTS_ORDER` accepts a window opening `2025-03-17` and refuses
  `2025-03-16`. The `~12mo` note at the head of `src/sources/uber.js` was where
  the wrong figure came from and is corrected there too.
- **Which makes Apr–Aug 2025 a bug, not a ceiling.** Those months are *inside*
  retention. The 60–97% fare coverage is eight payments weeks Uber generated
  successfully and we timed out downloading — `download timed out after 600s for
  report <uuid>`, `src/sources/uber.js:137`. The reportId is discarded inside
  the error string and the failure is not checkpointed, so **every Sunday
  backfill burns ~80 minutes and eight of its three-at-a-time report slots
  re-failing the same eight windows**. Roughly 13,800 Ecosine bookings and some
  AED 700k of fares are recoverable by a retry that keeps the reportId.

The row that read *"permanently | nothing — past retention"* is the sentence
that made this true for a year. Both corrections are marked as corrections
rather than quietly rewritten, for that reason.

---

## Not started

- **Batch 3** — the medium and large criticals: the `refreshStatements`
  `resolved`-CTE supersession (settles C13, C19 and C25 in one change), the
  phantom `occupancy_segment` rows (C14, 59.6% of the table), the unauthorised
  Yango veto (C17), the `#unit` asset-ledger fleet filter (C23), the identity
  fold (C24), and the CABMAN 132-phantom-plate denominator (C18).
- **Batch 4+** — the 118 highs, grouped by the seven root causes in
  `FIXLIST-2026-09-05.md`.
- **The latency work** — `POST /v1/vehicle-suppliers/transactions` is issued as
  a **GET** by all three probes, gets a 404, and is recorded as "the provider has
  nothing". It is the surface that publishes per-trip money at sub-minute
  freshness, on a scope `src/config.js:125` already requests.

---

## Online time — PROVEN ON PRODUCTION, 2026-09-09

| claim | state | the proof |
|---|---|---|
| The page exists under People, both shells | **proven** | `bin/prod-mirror.mjs` on :8200, desktop 1440px and phone 402px, screenshots taken |
| Every driver has one of six reasons, and they partition the page | **proven** | `/api/online-time?day=2026-09-09&start=06:00`: 83 + 0 + 0 + 41 + 30 + 3 = 157 = `people`; 54 + 29 + 74 = 157 |
| A person Uber dropped from the roster is on the page with their real time | **proven** | 157 people against 127 with an Uber standing that permits work; the extra rows come from the drove-ids union |
| Deactivated standings are not in the call list | **proven** | 30 `cannot_earn`, all `can_earn === false`, none with `late` set |
| No standing reaches the reader as a database key | **proven** | three distinct sentences on production, none containing `_` or `onboarding_status` |
| Every phone number dials | **proven** | 157 `tel:` hrefs on the desktop, 54 on the phone, all matching `^tel:\+\d{8,15}$` |
| No start time renders absent with a reason, never as zero | **proven** | `?start=half%20seven` → `expected_start: null`, no `late` key in `totals`, `start_why` naming what it was given |

**Not proven, and unprovable from here:** that the 41 `not_asked` people did or
did not come online. That is the point of the state. It closes only when
somebody runs `node src/index.js timeline-roster`, which has no cron.

## Bolt per-fleet collection health — PROVEN ON PRODUCTION, 2026-09-09

`/api/platforms` now carries one row per company rather than one for both:

- `bolt` / `ecosine` — `collection_status: "partial"`, `collection_error:
  "FI roster ecosine: BOLT_CLIENT_ID is not entitled to company_id 142868 —
  code=503 NOT_AUTHORIZED hint=COMPANIES_NOT_ALLOWED"`, 34,871 bookings held.
- `bolt` / `egari` — `collection_status: "ok"`, `collection_error: null`,
  13,575 bookings held.

Which is the whole of the fix: one fleet's refusal is reported against that
fleet. **The refusal itself is not ours to clear** — the same token reads
company 142897 (egari) successfully, so the secret is sound; company **142868**
has to be added to that fleet-integration app in the Bolt portal by whoever
administers it.

---

## The dropped online tail — PROVEN ON PRODUCTION, 2026-09-10

| claim | state | the proof |
|---|---|---|
| A dangling ONLINE is kept, not deleted | **proven** | `/api/driver/day` for 369dd9c1… on 2026-09-10 returns one span `{515 → 748, open_ended: true}`; before the fix, two spans totalling 84 min ending at 09:59 |
| Every trip now falls inside the online record | **proven** | trips at 515→551, 599→627, 644→663 all inside 515→748 |
| The span says which bound closed it | **proven** | `closed_by` ∈ `now` / `day` / `collection`, carried to the page and named in the hover |
| The page says when the day is still filling | **proven** | `collection: { last_run_at, collected_to_min 617, last_event_min 605, complete: false, why }` |
| The ratio refuses rather than exceeding 100% | **written, test-proven, not yet seen on a live 100%+ case** | the overlap fixture reproduces 167% and the guard refuses it; no production driver has been observed over 100% since the fix |
| `driver_day.online_min` is written long, not short | **written and deployed, not yet re-measured** | `src/rollup.js:1070` uses the shared builder; the nightly rollup has not run since the deploy |

**Not proven, and stated as such:** the ~84 driver-hours a day that closing at
`now()` would have invented across the 56 drivers dangling on today is
**derived from the cron cadence and the dangling count, not measured**. The
probe reports the tail that was dropped, not the tail that would have been
invented. Measuring it needs a second aggregate in
`/api/probe/uber/timeline` — last successful run against each dangling event.

**A residual that the ceiling does NOT close, kept visible rather than
claimed:** 4 of the 60 dangle on a day the collector has long since covered, so
the collection ceiling sits above that day and cannot bind. Those spans still
run to their own midnight, `closed_by: 'day'`, `open_ended: true`. Pinned as a
test rather than described as a caveat.

## One instant, one minute — PROVEN ON PRODUCTION, 2026-09-10

A bare `::int` cast rounds in Postgres; `collected_to_min` (`floor()`),
`last_event_min` (`hour*60+minute`) and `online_routes.js`'s `minsInto`
(`h*60+m`) all floor. The online spans were the only rounding figure, and
`closed_by: 'collection'` turned that into a same-page contradiction by
asserting the band's right edge IS the collection reach.

Measured on production before and after the deploy, same three drivers, same
day, same `collected_to_min` of 797 throughout:

| driver | Online Time page | band start before → after | band end before → after |
|---|---|---|---|
| `39042c26` | 645 | 646 → **645** | 798 → **797** |
| `3d3e3fa2` | 591 | 591 → 591 | 798 → **797** |
| `369dd9c1` | 514 | 515 → **514** | 798 → **797** |

| claim | state | the proof |
|---|---|---|
| The band and the Online Time page name one event with one minute | **proven** | the table above; two of three disagreed before, none after |
| A `closed_by: 'collection'` span ends exactly on the collection reach | **proven** | every band end is 797, and `collected_to_min` is 797 |
| The hover and the caption cannot print the same instant two ways | **proven** | both now derive 13:17 from minute 797 |

**Not fixed, and inherent rather than deferred:** a band drawn on a minute grid
can be up to a minute wider than the duration it represents — 514→797 draws 283
where the interval is 282.x minutes, and `driver_day.online_min` stores the
duration. They are different quantities. No surface prints both today
(`cohort.js` renders `online_min` in hours); a future one must say which is
which. In `docs/COVERAGE.md`.

---

## Tesla — REGISTERED, AND BLOCKED ON A HUMAN, 2026-09-10

| claim | state | the proof |
|---|---|---|
| The app's credentials are valid | **proven** | partner token issued, 8 h life, both `eu` and `na` audiences |
| The partner domain is registered | **proven** | `POST /api/1/partner_accounts` returned account `9cafefcf…`, tier `pay_as_you_go`; `GET /partner_accounts/public_key?domain=…` returns our key |
| Tesla can fetch our public key | **proven** | `https://…/.well-known/appspecific/com.tesla.3p.public-key.pem` serves it; Tesla accepted the registration on that basis |
| The fleet's Teslas are identified | **proven** | 82 — 72 Model Y, 10 Model 3; 78 carry a VIN, Tesla's own join key |
| Tesla will tell us anything about them | **NO — blocked** | a partner token answers `GET /api/1/vehicles` with 200 and **count 0**. It authenticates the application, not an account. |

**The one remaining step is not ours:** somebody signed into the Tesla account
that owns the cars must approve the app once, at the link
`/api/tesla/connect` mints. Until then every Tesla-native figure is absent with
that reason, which is what `/api/tesla/status` returns.

**Two facts that bound what this can ever become**, from Tesla's own docs:
there is **no per-trip, drive or odometer history in the Fleet API at all** —
history accrues only forward from the day streaming is switched on — and the
**UAE is not on Tesla's payment-supported country list**, with a default
billing limit of $0.

---

## How to re-check any row here without re-reading the audit

Every proof in the Batch 1 table is a single anonymous curl with `&_=$RANDOM`
appended (the API caches; without the buster you will read the answer from
before the deploy). The screenshots come from `bin/prod-mirror.mjs` on :8200 —
Chromium in this sandbox has no route to the internet, so a browser pointed at
production returns `ERR_CONNECTION_RESET` and the mirror is what makes a real
screenshot of production possible at all.
