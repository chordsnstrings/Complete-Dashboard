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

## Tesla — PAGE REMOVED 2026-09-15; INTEGRATION REGISTERED AND STILL BLOCKED

**The #tesla page no longer exists.** It was removed on the operator's
instruction after the stored access token expired on 2026-09-10 and this server
proved unable to mint a new one: Tesla's auth edge refuses DigitalOcean egress
(measured below), so the page had been rendering the vehicle register and no
live Tesla data for five days. A page whose every live figure is absent, with
the same reason each time, is a page that has stopped earning its rail row.

**What was removed:** `api/public/tesla.js`, its nav entry, its view binding,
its stylesheet block and its entry in the no-window-control list. Nothing else.

**What was deliberately kept, and why:** `api/tesla_routes.js` and all four of
its routes, `src/auth/tesla.js`, `bin/tesla-token.mjs`, the Tesla settings keys,
and the `/.well-known/appspecific/com.tesla.3p.public-key.pem` route and file.
Tesla re-fetches that key to verify this domain still owns it, so deleting it
would break the partner registration — which is not a code change that can be
reverted. `/api/tesla/connect` and `/teslaredirect` are the OAuth handshake by
which a token is renewed; they are the browser route back to a working
integration and they still answer.

The three `/api/tesla/*` routes are now exempted in
`test/endpoint_coverage.test.mjs` with that reason written out. The exemption
was wrong once before — it claimed a page rendered from the routes when no page
existed — so it now says plainly that the page was removed and that the routes
are kept for renewal, not for a view that is coming back.

**The 82 Teslas are untouched.** They remain in the vehicle register and appear
on #fleet, #vehicles and everywhere else exactly as before. Nothing was migrated
and no schema changed.

### The registration, as it stood — still true, 2026-09-10

| claim | state | the proof |
|---|---|---|
| The app's credentials are valid | **proven** | partner token issued, 8 h life, both `eu` and `na` audiences |
| The partner domain is registered | **proven** | `POST /api/1/partner_accounts` returned account `9cafefcf…`, tier `pay_as_you_go`; `GET /partner_accounts/public_key?domain=…` returns our key |
| Tesla can fetch our public key | **proven** | `https://…/.well-known/appspecific/com.tesla.3p.public-key.pem` serves it; Tesla accepted the registration on that basis |
| The fleet's Teslas are identified | **proven** | 82 — 72 Model Y, 10 Model 3; 78 carry a VIN, Tesla's own join key |
| Tesla will tell us anything about them | **NO — blocked** | a partner token answers `GET /api/1/vehicles` with 200 and **count 0**. It authenticates the application, not an account. |

**The approval has now happened, and it was not the blocker.** The operator
completed the sign-in on 2026-09-10; Tesla accepted it and issued a valid code.
The code exchange was then refused by Tesla's **edge** — HTTP 403 with an
Akamai "Access Denied" page rather than an OAuth refusal.

`/api/probe/tesla/egress` measured the shape of that refusal from production:

| claim | state | the proof |
|---|---|---|
| The account approval works | **proven** | Tesla redirected back with a code; the state check passed |
| The refusal is of the CALLER, not the credential | **proven** | HTML block page, not a JSON `error`; identical request from another network reaches OAuth |
| It is not the User-Agent | **proven** | a real UA was deployed and the answer did not change; `user-agent: node` also passes from another network |
| Tesla's **auth** host refuses this server | **proven** | 403 + Akamai ref `#18.ccd5ce17.1789035013.1637d0b9` from 164.92.186.179 |
| Tesla's **data** host does **not** | **proven** | 401 with no block page — a normal unauthenticated answer |
| It is the egress address, not the request shape | **proven** | four header sets from production — ours, no-UA, curl-like, full browser with sec-ch-ua/origin/referer — all 403 with the block page |
| It is the hostname, not the range | **DISPROVEN** | both documented auth hosts — `auth.tesla.com` and `fleet-auth.prd.vn.cloud.tesla.com` — answer 403 with the block page from production, while both answer JSON off-network |
| A single IP allowlist would fix it | **DISPROVEN** | the egress is per-container: 164.92.186.179, then 165.232.77.209 after a redeploy, then that one five times running. Both DigitalOcean ranges — the next deploy moves off any address Tesla allows |

**What that means for the design, and it is not a detail:** a token minted
elsewhere does not fix this. Access tokens last about eight hours and the
`refresh_token` renewal posts to the same blocked host, so the refresh has to
happen somewhere Tesla accepts and be written back into `app_setting`.

**Superseded.** This said "ask Tesla to allow 164.92.186.179". The egress
address changes on every deploy, so allowlisting one is useless. The realistic
routes are a stable dedicated egress for the app and then a Tesla allowlist for
that durable address, or moving only the auth half — minting and refreshing —
to a host Tesla answers. The data host is reachable from production, so the
auth half is all that has to move.

**CORRECTED 2026-09-10, having been checked against Tesla's documentation
rather than recalled.** This paragraph read: *"there is no per-trip, drive or
odometer history in the Fleet API at all"*. That is wrong twice, and it was
stated confidently enough to plan around:

- **The odometer is a live field**, read on every `vehicle_data` call and
  streamed with a 0.1-mile delta. There is no historical *series*, but two
  reads a day apart bound a day's distance — an independent check on the
  tracker-derived kilometres this dashboard already draws.
- **Charging history exists.** `GET /api/1/dx/charging/history` is paginated
  past sessions; `/api/1/dx/charging/sessions` carries pricing and energy and
  is restricted to business fleet owners, which this fleet is; and
  `/api/1/dx/charging/invoice/{id}` returns the invoice PDF.

What is genuinely absent is a per-**drive** history — Tesla will not say where
a car went last Tuesday. "No history" and "no trip history" lead to entirely
different build decisions, which is why the imprecision mattered.

**The cost constraint stands and is sharper than recorded.** The UAE is not on
Tesla's payment-supported country list and the default spend limit is $0. Every
response below a 500 is billable, including refusals. And exceeding the limit
does not merely pause billing: Tesla suspends access **and deletes the Fleet
Telemetry configuration**, which its documentation says "will not be restored"
— so an overrun costs the per-vehicle pairings, not just the month.

---

## Driver performance — better or worse, against their own record

The operator's ask, in their words: performance "week by week, and month by
month, a comparison of what they used to do, out of the active drivers what was
their position, and whether it got better or worse" — and the subject of it:
"it's a performance difference of the solo driver not comparison between the
fleet drivers."

Two surfaces: a **Record** tab on every driver's own page (`#driver/<id>/record`)
and a fleet page, **Better or worse** (`#performance`), both served by
`/api/performance/driver` and `/api/performance/fleet` over one query.

| # | what | state | proof |
|---|---|---|---|
| P1 | `api/performance_sql.js` — per person per period, two positions, active-day denominator | written | `test/performance_record.test.mjs`, 31 assertions; the row-multiplication defect reintroduced and the suite fails on 3 of them |
| P2 | the comparison arithmetic — symmetric split, fleet term, overdispersed z, Wilson, Bonferroni | written | `test/performance_math.test.mjs`, 45 assertions; the split identity swept over 400 combinations |
| P3 | the fleet term — a driver who falls WITH the fleet is not marked down | written | removed from `judge()` and the same suite fails: MOVER goes from "within range" to z = −3.29 |
| P4 | `test/sql_module_names.test.mjs` — the `api/*_sql.js` export-collision guard | written | rename reverted, guard goes red on `GRAINS` |
| P5 | Record tab and Better-or-worse page render at 1500 / 820 / 400 px | written | `bin/render-audit.mjs`-style pass against the mock: 0 overflow at 1500 and 820, 24px at 400 which is the product-wide nav figure |
| P6 | `/api/performance/fleet` warmed at both grains | written | `test/warm.test.mjs` — which also forced the page's default request to be a literal, because the guard can only check what it can read in the source |
| — | deployed and re-measured on production | **proven** | see below |

**Proven on production 2026-09-14**, deployment `0998fae`, phase ACTIVE.

The check that matters is that the new surface cannot disagree with the old
one. For Zubair Khan Shaukat Ali (`6616229`) in the week beginning 2026-09-07,
`/api/performance/driver` returns **completed 79, accepted 83, dropped 0,
declined 5, bookings 88** — and `/api/cancellations?from=2026-09-07&to=2026-09-13`
returns the same five numbers for the same person. They are the same
expressions out of `api/cancellation_sql.js`, so this is agreement by
construction rather than by coincidence, which is the property worth having.

Measured at the same time, cold (cache miss):

| endpoint | time | size |
|---|---|---|
| `/api/performance/fleet?grain=week` | 4.4s | 114 KB |
| `/api/performance/driver?id=…&grain=week` | 3.7s | 22 KB |

The fleet endpoint is now in `api/warm.js`'s BARE_PATHS at both grains, so the
first reader of the People section does not pay for it. The per-driver one is
deliberately not warmed: it is keyed on a person nobody has opened yet.

**A fourth comparison view and a performance fix, proven 2026-09-14 on
`f71a5d0`.**

| # | what | state | proof |
|---|---|---|---|
| P7 | "Where they stood" — percentile among active drivers, period by period, jobs as the bar and trip value as the outline behind it | **proven** | rendered against production through `bin/live-ui.mjs`; Zubair Khan Shaukat Ali's value outline sits above his jobs bar through July and converges in September |
| P8 | one scan per grain per data version, not one per period chip | **proven** | the measurements below |

The period picker is thirteen addresses so a reader can send somebody the exact
week they are looking at, and the response cache keys on the whole URL — so
every chip was its own key over an identical query. The shaped context is now
held in the route module against the same data version `api/cache.js` uses.
Measured on production, five month chips in a row:

| | before the fix | with the version inside the key (568e675) | fixed (f71a5d0) |
|---|---|---|---|
| chip 1 | 18.7s | 24.9s | 20.2s |
| chip 2 | 18.7s | 1.1s | 0.85s |
| chip 3 | 18.7s | 0.7s | 0.62s |
| chip 4 | 18.7s | 28.4s | 0.67s |
| chip 5 | 18.7s | 27.9s | 0.58s |

The middle column is the bug the first version shipped: the version was part of
the key and the store cleared the whole map, so `api/warm.js` — which asks for
BOTH grains on every version change — threw away the month context a reader had
just waited twenty-eight seconds for. Week chips after the fix: 0.56s, 0.64s,
0.68s, 0.67s. The first month chip is still the cold scan, and it is cold only
until the warm pass reaches it.

What the page found on its first real week, which is the argument for it
existing: **3 drivers of 112 did something different**, all three of them
UP, and all three because of ATTENDANCE rather than pace — baselines of 0.8,
1.3 and 4.3 active days a week rising to 5, 7 and 7. None of them is near the
top of either ranking, so neither `#top-performers` nor `#low-performers` would
have shown them. The two positions also disagree where they should: Nalini
Chakrapani is 1st of 112 on jobs and 6th on value, and Zeeshan Ahmad Ur Rahman
is 13th on jobs and 3rd on value — one is working short hops and the other long
ones, which is the finding a blended score would have hidden.

**Three things this pair deliberately refuses to do**, each of which was a
measurement before it was a rule (`api/performance_sql.js` carries them):

* No blended score. Jobs done and trip value are ranked separately, on the
  operator's instruction and because `api/income_sql.js`'s two money bases make
  a blend meaningless.
* No position for a rate at week grain. Consecutive-week rank correlation is
  0.71–0.83 for completed jobs and 0.15–0.53 (median 0.29) for completion
  percentage, so counts get a position and rates get an interval.
* No verdict on a period that has not finished, and none on a driver's first
  period. Both render absent **with the true reason**, not as zero.

---

## Live driver status, and the same-person queue — 2026-09-14

The operator's question was *"some drivers are apparently online and it shows
online on uber as well, but not on our site"*, and the answer turned out not to
be about the feed or the cadence at all: the status had been arriving every two
minutes and being discarded. `docs/COVERAGE.md` carries the measurement. The
second half of the same instruction — *"names can be different it needs to be
automatically merged … if you need human involvement create a page in people"* —
is the identity work beside it.

| # | what | state | how it was checked |
|---|---|---|---|
| L1 | the live `drivers/actions` status was written only as a plate-keyed telemetry row, so 11 of 152 drivers had one | written | `sql/schema_v70.sql` + `driverStatusFrom()`; `test/driver_status_live.test.mjs` |
| L2 | `/api/status/driver` and `/api/status/fleet`, night shifts included via the opening-state CTE | written | `test/status_routes.test.mjs`, with a Dubai wall-clock fixture helper |
| L3 | the driver page strip, and the fleet line on `#online-time` | written | four rendered variants read back off the DOM — online, absent, stale, fleet |
| L4 | email as a second conclusive merge key | written | `test/identity_proposals.test.mjs`; **reverting the `full_name` guard fails 1** |
| L5 | similar names become PROPOSALS and fold nothing | written | **reverting the gate in `api/identity_links.js` fails 1** |
| L6 | the simultaneous-trip disproof matched on `driver_ext_id` alone | written | **reverting the platform predicate fails 3** |
| L7 | `/api/same-person` was cached 30s against a version a verdict never bumps | written | **reverting the NEVER entry fails 2** (`8 then 8` — the same body) |
| L8 | the report-types probe called a **rate-limited** type invalid | written | shown on production: `REPORT_TYPE_PAYMENTS_ORDER` returned 399 rows. **Note the corrected scope** — this did NOT cause the old "only four types are valid" belief (that was sixteen invented names, already fixed), and that report is already collected |

### The three that were only found by reverting

L5, L6 and L7 are the reason this file has a "proven" column at all.

**L5 is the worst of them, because the first test PASSED with the fix removed.**
The assertion "a similar-name proposal folds nothing" named an alias that had
been *rejected* a few lines earlier in the same file — so `NOT rejected`
excluded it and the gate was never exercised. The suite was green, the feature
looked proved, and the whole safety property of the queue rested on a predicate
no test touched. It surfaced only by deleting the predicate and watching the
suite stay green. The fix names a pair the file first asserts is excluded by
nothing else:

```
✗ a similar-name proposal folds NOTHING while it sits unanswered ["b-named","shared-id"]
```

**A guard with several exclusion paths needs the row under test to be excluded
by none of the others** — otherwise the test asserts a true sentence about the
wrong row, which is indistinguishable from a passing test until the day it
matters.

### Proven on production, 2026-09-14 — and what the proving found

Deployed `c24e9bd`, then measured. Two rows reached **proven**; one found a new
defect, which is what the column is for.

| # | proof |
|---|---|
| L1/L2 | `/api/status/fleet`: **158** drivers carrying a status against a pre-deploy baseline of **13** (`/api/live`, ONLINE 8 / ONTRIP 3 / OFFLINE 2). 63 working — 26 on a trip, 37 waiting. **66 of the 158 have no plate**, so were unreachable by the plate-keyed row by construction. Collector log: `[uber] driver status {"fleet":"ecosine","drivers":114,…,"contacts":114}` and `{"fleet":"egari","drivers":44,…,"contacts":44}` |
| L8 | `?only=REPORT_TYPE_PAYMENTS_ORDER,REPORT_TYPE_DRIVER_STATUS` → **both `accepted`**, `limit_note: null`. Both were reported invalid by the unfixed probe; the 3-in-flight limit and the list order were the whole of it. `PAYMENTS_ORDER` was already collected — `DRIVER_STATUS` is not, and whether it adds anything to the live feed is unmeasured |

**And the defect the first production read found.** 66 of those 158 rows carry
`statusEntries: []` — a row present, status null — a case no fixture had. The
`absent` flag keyed on the row being missing, so those answered `status: null,
absent: null` and the strip reported **sixty-six drivers Uber had said nothing
about as "Offline"**. The fix for a false figure had introduced a false figure
of the same kind, in the same file, within the hour. `docs/COVERAGE.md` carries
the measurement and the three traps. Fixed, proven by revert (`[null,null]` —
the production symptom exactly), and the mock now carries both absences.

### Still not proven

The identity half. `refreshIdentityLinks` runs inside the incremental job, so
proposals appear on the next pass. Proven will be: a `similar_name` row in
`driver_identity_link` that `/api/drivers/identity-links` does **not** list, and
`/api/same-person` showing it as pending.

### One thing an operator has to be told

`POST /api/same-person/decide` is **not** admin-gated, unlike most writes in
this product. That is deliberate — it is the one write the reviewer this page
exists for has to be able to make — but it means anybody who can reach the API
can record a verdict. It refuses a conclusive basis with 409, and it can never
merge on its own; the worst it can do is fold or split a pair a name rule
already proposed, reversibly. Worth a decision rather than a default.

---

## How to re-check any row here without re-reading the audit

Every proof in the Batch 1 table is a single anonymous curl with `&_=$RANDOM`
appended (the API caches; without the buster you will read the answer from
before the deploy). The screenshots come from `bin/prod-mirror.mjs` on :8200 —
Chromium in this sandbox has no route to the internet, so a browser pointed at
production returns `ERR_CONNECTION_RESET` and the mirror is what makes a real
screenshot of production possible at all.

## Unauthorized-trip attribution — the three-lens audit — WRITTEN AND TESTED, NOT DEPLOYED

Three independent lenses (accusation safety, SQL correctness, integration and
rendered pages) audited the attribution feature. What follows is what is now in
the working tree. **None of it is on production** — the endpoints themselves
have not been deployed yet — so every claim below is "proven against a real
Postgres in `test/`" and "rendered in Chromium against `mockapi.mjs`", never
"verified on production".

**Accusation honesty, in `api/unauthorized_sql.js`.**

* The `sole_custodian` and `ambiguous` evidence sentences no longer assert a
  measurement the SQL never made. A new `gaps` CTE emits `nearest_before`,
  `nearest_after`, how many people have each side, and how many have both, and
  the sentence is built per cause — including the handover branch, where trips
  sit either side and belong to DIFFERENT people, which is the strongest
  available evidence that the car changed hands during the journey and which
  the old fixed string flatly denied.
* The bracket's exclusion runs over a new `others` CTE — every channel, no
  driver-id requirement — and tests interval overlap rather than the
  intervening booking's request instant. The evidence sentence states the scope
  it actually checked.
* `near`, `last_near` and `ever` require a non-blank `driver_name`; `near` is
  completed-only, matching `src/reconcile.js` `findMatch`.
* The clock-skew gate is derived per PLATE (a neighbouring `unverifiable`
  segment, or three or more unauthorized segments whose `nearest_gap_min`
  cluster within `RULES.matchToleranceMin`), because the row's own
  `verdict_reason` can never carry it. `clock_skew_basis` travels on the row.
* Custody ranges over both Dubai days a journey touches; unnamed custody
  records are counted separately and block the `sole_custodian` rung.
* A candidate the provider never numbered gets `'name:' || person_key` as its
  id, so the link resolves.

**Both halves of a response now describe one population, in
`api/unauthorized_routes.js`.** `?fleet=` is bound to the driver endpoint's
rows as well as to its coverage note and its AED/km; `?verdict=` is validated
against the reconciler's own vocabulary and an unrecognised value is reported
rather than served as a clean page; coverage on a driver route is counted over
the cars that person held, not fleet-wide; the two per-person totals are
counted over the window rather than measured off a 400-row cap.

**`/api/unauthorized/list` folds on the person** (`custodyRefs`/`custodyNames`),
so the three shells that read it stop listing one man as two suspects.

**The pages.** `#segments` and both driver tabs treat a 200 carrying the wrong
body as a failure rather than as a measured emptiness — the three false
exonerations this produced were reproduced in Chromium and are gone. The tier
tone ramp is removed; the per-person table is four never-summed columns sorted
by name with money only on the by-time rung; the segment page carries the tier
and the evidence sentence above its custody line; the driver page no longer
prints the nearest booking's driver name beside a candidate list; the rung is
on screen on both tabs rather than in a tooltip; the revenue tile states its
split. `mockapi.mjs` has fixtures for both endpoints, one row per rung.

**Proof.** `test/unauthorized_attribution.test.mjs` is 160 assertions; each
accusation-honesty fix carries the reversion that fails it, and eight of them
were run. `test/unauthorized_attribution_page.test.mjs` is 26, including the
tone ramp and the withheld name, both proved by reversion.

---

## A money figure nobody measured, drawn as AED 0 (driver Earnings, Finance)

**Status: WRITTEN and PROVEN in the working tree. NOT deployed, NOT verified on
production.** The measurements that diagnosed it were taken read-only against
production; nothing in this fix has been through a deployment.

**What was wrong.** `api/public/driver.js` Cash collected tile read
`v ? money(v) : (cashTrips ? 'not reported' : money(0))`. `cashTrips === 0` has
two causes — the driver worked and took no cash (a real AED 0), and the driver
did not work at all (nothing measured) — and the expression collapsed them. The
same collapse sat on the Finance page at `api/public/app.js`'s
"Cash collected — measured portion". Both are guardable on the window's own
booking count, which each already had in scope.

**What changed.** `api/public/driver.js` and `api/public/app.js` only.

- Cash collected, both shells: absent with the WIDER reason where nothing was
  measured; still `AED 0` where the population exists and settled no cash.
- "What made up the pay": components carrying no amount are named in a sentence
  instead of drawn as zero-length bars; components the platform published AT
  nought are stated as a sentence that says the platform published them, which
  is the one honest nought on that tab. The child table renders a null amount as
  a dash and prunes the column when no child carries one.
- The statement total: summed over the rows that carry `counted`, null where
  none does; three branches for no statement / nothing resolved / a real total.
  The Counted column no longer borrows the Statement column's number.
- `startScatter()` null-tests before coercion, so thirteen unmeasured days stop
  being plotted as a midnight shift pattern.
- The distance-per-day chart gains the three-way treatment its sibling revenue
  chart already had, and a caption.
- "No cancellations on any of the 0 days this driver worked" gains a zero branch.
- A standing sentence under the tab bar, from `emptyWindowNote()` in the shell,
  with a different sentence for "no trip in this window" and "never had a trip"
  and a per-tab tail. A third sentence — worked, and none of it carries money —
  lives on the Earnings tab, which is the only place that can see it.
- `api/public/app.js`: `componentTree()` tracks whether anything behind a
  category was valued; the Finance ledger chart charts only valued categories;
  the funnel's Platform commission tile is absent where no record reports one.

**Proof.** `test/driver_empty_window_page.test.mjs`, 37 assertions in Chromium
against the shipped modules with the production payloads as fixtures. Thirteen
reversions were applied one at a time and each failed the assertions written
beside it: the cash tile value, the cash tile reason, the measured-zero branch,
the components chart, the counted reduce, the Counted column, the banner, the
two-case split, the per-tab tail, the banner tone, `startScatter`'s filter, the
distance chart, and the cancellations sentence — plus four on `app.js`.

**Not done here.** The same defect class was swept and found at 20 further sites
in files this task was not allowed to touch (`charts.js hbars()`/`barChart()`,
`m/screens.js`, `vehicle.js`, `performance.js`, `economics.js`, `payouts.js`,
`playbook.js`, `revenue.js`, `corridors`/`corporate.js`, `receipts.js`,
`driverrecord.js`). `charts.js hbars()` is the shared root cause under most of
the chart hits and is the single highest-value one left.

### Second pass: what two verifiers found in that repair, and what was done

State: **written, tested, NOT deployed.** Nothing below has been to production.
Every production read that produced it was a GET through `bin/live-ui.mjs` with
the window pinned `from=2026-09-01&to=2026-09-16`.

Two over-corrections, in the repair's own edited lines:

- **The Cash tile printed "not reported" for a figure the platform reported.**
  `if (v) return money(v)` — a truthiness test on the end of a `??` chain — so
  a published `0.00` fell through. Now `if (v != null)`, and the cash components
  are split into valued and unvalued rather than summed from a zero seed.
- **The `Counted` column and the statement caption stated a cause the payload
  disproves.** `days_used` and `counted` are computed over the SAME
  `driver_payout_day` rows already restricted to the window, so `counted` null
  with `days_used` positive means the days resolved and carry no earnings.
  Both sentences now branch on `days_used`, and the caption's pronoun agrees
  with the count (it said "none of them" over one statement).

Six reasons that were true but not the whole truth, or true of the wrong
population:

- Cash collected now requires COVERAGE as well as population: the AED 0 branch
  is gated on the bookings whose payment method was recorded, and a window whose
  every booking is `unknown` is a third absence with its own sentence. Same on
  `#finance`, where the denominator now comes from
  `settle.total_trips - settle.unlabelled_trips` instead of `k.trips`.
- The cancellations panel no longer tells a working driver they worked no day;
  it distinguishes "no work in the window" from "no row carries an outcome".
- Harsh events is absent with a reason where `telematics_journeys` is null — no
  custody row, so nothing for an alert to attribute to — and stays a digit
  wherever the feed did see the driver.
- `moneyMeasured` now consults `e.fare`, `e.statement_cash`, `e.statement_gross`
  and the periods' `cash_earnings`; the empty statement caption names the
  PAYOUT-PERIOD feed rather than denying every feed.
- The statement total is stated across the statements that contributed, not
  across every period; the rows that carry no figure are named; and the
  reconciliation sentence gained its agreement branch, which had silently
  vanished once the two figures started agreeing.
- `componentTree()`'s children table in `app.js` carries an unvalued category
  through as null with an `absent:` reason, which is where the first fix stopped.
- The Rating sub-line states `over_trips === 0`, which is what makes a delta of
  nought readable. It names the PLATFORM'S COUNTER, not the driver's work:
  `over_trips` is the difference between the lifetime trip counts on the two
  rating rows, and MEASURED on production `68e368e3ff76a73626e0720e` did 96
  trips in this window while Uber's counter read 792 on all five readings. The
  first draft said "no trip of theirs between the two readings" and would have
  told a working driver they did not drive.
- The Average fare sub-line uses `UBER_FARE_WHY` rather than a sixteenth
  hand-written copy of it. `test/fare_reason_shared.test.mjs` exists for exactly
  that and caught the first draft, which said "the Uber trip export has no fare
  column at all" and stopped — the unqualified form that reads as "and
  therefore never will".

Seven panels that read as a broken page rather than an answered one:

- Overview "Trips per day" drew a 1090x327 axis holding 13 zero-height rects and
  no caption. Three states now, and a sentence where every day is nought.
- "How they rank in the fleet" printed the generic box AND the true sentence
  under it; the box is gone. `startScatter` uses `note()` rather than
  `empty()`'s bold "Nothing to show".
- "Which days and hours they work", "How the day was spent", "Vehicle custody",
  "Cars they have held", "Busiest pickup areas", "Trip distance mix" and "How
  riders paid" each state their own reason instead of "No data for this range
  yet".
- The **Record** tab rendered four headings over 92/110/92/92px of whitespace
  when `/api/performance/driver` 404s. Every emptied body now carries the reason,
  and the shell banner no longer claims the record is intact on the one tab that
  is not measured over the window at all.
- The Activity day-by-day table says how many days of the window carry no feed
  row, so 13 rows in a 16-day window is accounted for.
- The Money column's `AED 0 · 1/7` tooltip distinguishes a share of a nought
  period (the platform published it) from an apportioned figure.
- The ONLINE column's provenance marker reads "· from spans" rather than
  "· spans", which parsed as a count with its number missing.
- `.sectabs .tabs a` no longer shrinks (`flex:0 0 auto`), so the strip scrolls
  instead of clipping "One person, two records" to "One perso", and a 22px mask
  on the right edge is the affordance that hidden scrollbar removed.

**Proof.** `test/driver_empty_window_page.test.mjs` is now 63 assertions, run in
Chromium against the shipped modules. Every new one was proved by reversion in
four batches — the Counted reason, the truthiness guard, the coverage gate, the
harsh-event branch, the cancellations gate, the trips-per-day branch, the rank
panel, the Record tab's four bodies, the banner's record clause, `moneyMeasured`,
the payout-period caption, `componentTree`'s children table, the settlement
denominator, the statement count, and `moneyInTile`'s nought branch — and each
reversion failed exactly the assertions written beside it.

**Disputed, and why.** The Rating delta of `– 0` is a real measurement: Uber
published 4.97 on five readings and the delta between two published figures is
not a figure nobody took. The Activity Money column's `AED 0 · 1/7` cells are
the same money the platform filed for that week, and the tag and its tooltip are
the disclosure — the tooltip now says which kind of nought it is. The
`Distance per day` panel sitting shorter than its row-mate is `.grid{align-
items:start}` working as the stylesheet intends; stretching it would produce an
empty box rather than a short one. The Trips tab's handling of a 404 from
`/api/driver/unauthorized` was already correct.

---

## A driver is a human, an account is a record — the person-vs-account sweep

**Written 2026-09-16. Not committed by this pass, not deployed, not proven on
production.** The suite is green; that means the tests agree with the code, not
that the code agrees with the fleet. Every figure below is re-measurable on
production with a pinned `from=2026-06-01&to=2026-09-16` and `&_=$RANDOM`, and
nothing here is finished until somebody has done that.

The class: one human holds an Uber record, a Bolt record, a Yango record and a
hotel record. `api/identity_map.js` is the register of which are one person and
`api/custody_sql.js` folds on it. 23 sites in `api/*.js` computed
`count(DISTINCT … driver_ext_id)`; the sweep classified each by **what the
consumer calls the number**, not by the SQL alias.

**The ruler.** `/api/drivers/cross-platform` reports 151 people across 265
platform accounts over that window, so a raw id count is **+75.5%** fleet-wide.

| # | site | was | now | how it was proved |
|---|---|---|---|---|
| P1 | `api/server.js` `/api/unauthorized/by-vehicle` | `string_agg(DISTINCT driver_name)` — three spellings of one accused man on a bar label, plus a leading comma from a blank-named row | folded on `PERSON_OF`, `NAMED()` guard, `driver_refs` + `driver_n` beside it | reversion → test §1 fails |
| P2 | `api/server.js` `/api/product/by-vehicle` | `GROUP BY (plate, driver_name, driver_ext_id)`; 63/109 plates printed one man 2–3× and duplicates evicted the real second driver at `rn<=3`; `sum(driver_n)` 394 over 247 people | grouped on the stored person key; `driver_n` people, `driver_accounts` accounts | reversion → §2 fails |
| P3 | `api/analytics_routes.js` `/api/tiers/by-vehicle` | the same CTE, copied; 63/101 plates | same fix, moved together | reversion → §2 fails |
| P4 | `api/server.js` `/api/alerts/by-driver` | rows grouped on the raw name while `km` grouped on `person_key` — **numerator and denominator folded on different keys**, so one man read 87.8 / 2.66 / 1.39 per 100 km against a true 91.9 | grouped on the stored key, `mode()` for the surviving spelling, `accounts` on the row | reversion → §3 fails |
| P5 | `api/server.js` `/api/alerts/by-vehicle` | `count(DISTINCT driver_name)`; `top` picked the largest SLICE of a split person — the wrong-person-coached defect its own comment says it fixed | custody CTE selects `person_key`; `per_driver` groups on it | reversion → §3b fails |
| P6 | `api/day_routes.js` `/api/day` ×3 | **the divisor.** 2026-09-15: 124 names → 100 people, so the tile read "8.0 bookings each" against a true 9.9 | `peopleCount()` (trip_ext cannot reach the stored key — see COVERAGE traps); list grouped on `personKey()`; per-vehicle count folded beside its folded list | reversion → §4 fails |
| P7 | `api/segment_routes.js` `/api/slot` ×2 | the page contradicted itself: folded `head.drivers` 110 beside raw `drivers_total` 126, the raw one rendered under the word "people"; list `GROUP BY driver_ext_id` filled 3 of 40 rota rows with one man | both folded; `driver_accounts_total` beside them | reversion → §5 fails |
| P8 | `api/income_sql.js` + `api/server.js` `/api/kpis` | `payout_drivers` 247 printed as "247 drivers" beside the same response's folded 151 — **and the per-platform rows were then SUMMED**, so a man paid on two platforms counted twice however well each row folded | `platformPayouts()` folds; new `payoutPeople()` answers the fleet question once; `payout_accounts` beside it | reversion → §6, §6e fail |
| P9 | `api/revenue_routes.js` `/api/revenue` | second copy of P8 over the same rows; uber 235 | `peopleCountStored`, `payout_accounts` | reversion → §6c fails |
| P10 | `api/income_sql.js` `platformStatements` | folded on `name_key` — lower()+whitespace only, so it folded nothing measurable and could never reach the register | folded on `person_key`, `name_key` kept as last-resort fallback; `statement_accounts` beside it | covered by §6 shape |
| P11 | `api/revenue_routes.js` `/api/finance/receipts` ×2 | a column headed, literally, **"People"**, counting accounts, at both grains | `money_event.person_key`; both grains moved together; `driver_accounts` beside | reversion → §6b |
| P12 | `api/analytics_routes.js` `/api/settlement/cash-exposure` | tile "Drivers holding cash" = 252 rows; of 200 listed rows only 126 are people; AED 233,665 of AED 361,489 sits on split people | `driver_count` = people, `driver_rows` = rows, `person_rows` on each row; `api/public/settlement.js` says which is which | reversion → §7 fails |
| P13 | `api/playbook_routes.js` `/api/playbook` | the card said "cash held by 252 drivers" — more than the 151 who drove at all — and LINKS to P12 | folded; the card and the page it opens are now one number | reversion → §9 fails |
| P14 | `api/compare_routes.js` `/api/compare` ×2 | cut and uncut "Drivers out" both raw over `trip_norm` | `JOIN_TRIP` + `peopleCountStored`, both moved together | shape asserted §8b |
| P15 | `api/vehicle_routes.js` `/api/vehicle/kpis` | phone tile "Drivers · held this car" raw while the DESKTOP tile for the same car was folded — two shells, two answers | `api/attribution_sql.js` brings `d.person_key` up; **weighting untouched, a payout is filed per account** | — |
| P16 | `api/economics_routes.js`, `api/attribution_sql.js` | `payout_drivers` and `unattributedEarnings.drivers` raw | same one-column change; the unattributed half uses `peopleCount()` because `driver_payout` is a view with no key and the two halves must partition ONE set of periods | — |
| P17 | `api/vehicle_routes.js` `/api/vehicle/daily` | `string_agg(DISTINCT driver_name)` beside a folded count, no empty-name guard | `custodyNames()` | — |
| P18 | `api/export_routes.js` `/api/export/trips.csv?grain=day` | one column `drivers` holding accounts, in a file Finance reconciles against the pages | `drivers` folded via `JOIN_TRIP`, **`driver_accounts` added as its own column** so the header says which is which | reversion → §10 fails |
| P19 | `api/server.js` `/api/drivers/performance`, `/api/reconcile/periods` | raw over `driver_payout_day`, which the same handlers already fold 8 lines away; one 7-day grain claimed 243 "Drivers" against a 108-day fleet headcount of 151 | `peopleCountStored` + `driver_accounts` | — |

**Left raw on purpose, with the reason in the code:**

| site | why |
|---|---|
| `api/server.js` `/api/earnings/components`, `api/revenue_routes.js` component tree | `driver_earnings_component` has **no person key** and cannot cheaply be given one without regenerating `sql/schema_v53.sql` — see COVERAGE traps. Returned as `driver_accounts` and named; `api/public/revenue.js` relabelled **"Accounts"** |
| `api/supply_routes.js` `/api/supply/balance` | built from `driver_timeline_event`, no person key, and the fold would sit inside a `generate_series` expansion for a figure **nothing renders**. Field renamed `accounts`; the cheap route (fold in the `spans` CTE, before the expansion) is written down |
| `api/analytics_routes.js` `/api/settlement/receivables` | genuinely an ACCOUNTS reading — it is the size of the `driver_ids` array beside it, and the grouping already puts one counterparty per row. Renamed `driver_accounts` |
| `api/probe.js` `/api/probe/zero-distance` | a diagnostic counting RECORDS. Returns **both** — `accounts` and `people` |

**Left alone entirely, and checked that the label really says accounts:**
`server.js:808` (`driver_accounts`, beside a `basis` string that says so),
`server.js:1355` and `server.js:1524` (both computed INSIDE `GROUP BY
t.person_key`, so they answer "how many accounts does this ONE person hold"; the
column on screen is headed **"Accounts"**), `server.js:1617` (counts FILINGS),
`vehicle_routes.js:193`, `reconcile_routes.js:190`, `cancellation_sql.js:172`,
`online_routes.js:175`, `retention_routes.js:60`, `probe.js:1255`. **Folding any
of these would be the same defect facing the other way, and worse, because it
hides a real distinction.** Two of them are pinned against exactly that by
`test/person_vs_account_counts.test.mjs` §8 and §8a.

**Proof method.** `test/person_vs_account_counts.test.mjs`, 64 assertions
against a real PGlite database through `mountAll`. The population is the
register's own: `MERGES[0]`'s verified Aliyan Khalil pair — *the same words in
the opposite order*, so **no spelling rule reaches them and only the register
does** — plus a case variant, a fourth account on the SAME platform (without
which no per-platform fold is measurable), a genuine second human, and two
records with no name at all. **18 reversions were run, one per expression, and
every one broke an assertion**; the list is in the test's header beside the
block it proves.


---

## The attribution endpoints were unusable on production, and it was not the ladder

Found by the post-deploy verification of the last deployment rather than by a
report — the endpoints answered correctly and took 78–99 s doing it, and one
16-day window returned HTTP 500 after 121 s. `/api/unauthorized/list`, over the
same table, answered in 1.2 s throughout.

**The wrong suspect, named honestly.** The first diagnosis in this session was
the attribution ladder: `api/unauthorized_sql.js` issues ten correlated
per-plate reads on `trip` per segment, four of them unbounded in time, and
`attributionJoin()` is materialised three times in one `Promise.all` (the rows,
the total, the tier distribution). That is all true and it was **not the cause**.
Four curls settled it:

| window | segments | response |
|---|---|---|
| `days=1` | 5 | 98.6 s |
| `days=3` | 16 | 78.2 s |
| `days=30` | 123 | 84.1 s |
| `from=2020-01-01&to=2020-01-02` | **0** | **67.0 s** |
| `from=2019-01-01&to=2019-01-02` | **0** | **109.1 s** |

Flat against segment count, and 67 s on a window where the ladder never runs at
all. The one query in the route that does not read `$1`/`$2` is
`statusHistoryFrom()` — `SELECT min(at) FROM driver_status_event`, no `WHERE` —
called by these two endpoints and by nothing else in the codebase.

| # | what | fix | state |
|---|---|---|---|
| — | `min(at)` over `driver_status_event` was a sequential scan: the table's only index mentioning `at` (`dse_driver_idx`) has it in **second** position, which a whole-table `min()` cannot use | `sql/schema_v73.sql` — plain ascending `(at)` | written, committed, deployed, **proven** |
| — | the heap it scanned was mostly dead tuples: `src/sources/uber.js:1919` re-upserts every status entry of every driver every `LIVE_STATUS_SECONDS` (120 s), and `upsertMany` rewrote each row whether or not a byte had changed | `src/db.js` — both writers guard `DO UPDATE` with `WHERE (tbl.cols) IS DISTINCT FROM (EXCLUDED.cols)` | written, committed, deployed, **proven** |

**Proof method.** Two reversions, both run:

* Comment `schema_v73.sql` out of `src/schema_files.js` →
  `test/status_event_index.test.mjs` goes red with the production plan verbatim,
  `Seq Scan on driver_status_event`. The test asserts the **plan**, not the
  index's existence: an index the planner declines has fixed nothing.
* Drop the `WHERE` from either writer in `src/db.js` →
  `test/upsert.test.mjs` goes red on two `xmin` assertions. It has to be `xmin`:
  the defect is invisible in the data, since the rows and their bytes are
  identical before and after. Every value assertion in that file stays green
  across the reversion, which is the point.

### The floor was JIT, and the first two fixes were not it

Re-measured after deploying `sql/schema_v73.sql`: the same empty window went
from 67.0 s to **86.1 s**, and `days=1` to 113.3 s. The index is right and the
no-op-upsert guard is right; neither was the floor. The API's own slow-query
log then named the rows query at 79,906 ms on a window with zero segments,
which the plan on a local PGlite says is impossible — so the production plan
was fetched, by making the service explain its own statement
(`/api/unauthorized/attributed/plan`, built from the same
`attributedStatements()` the route runs, so it cannot explain a copy):

```
Limit … (actual time=92208.833..92209.316 rows=0 loops=1)
  ->  Nested Loop Left Join … (actual time=24.255..24.738 rows=0 loops=1)
Planning Time: 150.308 ms
JIT:
  Functions: 2153
  Timing: Generation 368.210 ms, Inlining 314.023 ms,
          Optimization 50213.092 ms, Emission 41657.475 ms, Total 92552.800 ms
Execution Time: 92636.076 ms
```

**The query executes in 24.7 ms.** The other 92.55 seconds is LLVM compiling
2,153 functions, because the planner's ESTIMATED cost for 143,000 characters of
SQL is 10,536,749 against a `jit_above_cost` of 100,000 — an estimate that does
not care whether a single row qualifies. On `basic-xxs`, one vCPU.

| # | what | fix | state |
|---|---|---|---|
| — | JIT compiled every wide statement on a one-vCPU box and charged more for the compile than the query | `src/db.js` sets `jit = off` on every pooled connection, `PG_JIT=on` restores the default | written, committed, deployed, **proven** |

Off for the whole pool rather than for one route, because the same boot's
slow-query log carries statements at 18.7 s, 17.4 s, 12.9 s and 11.1 s across
the driver, vehicle and roster pages — all wide expression-heavy scans, the
shape that clears `jit_above_cost`. JIT repays its compile over millions of
rows; the largest table here is 175,000.

**What the global setting is NOT yet proven to have done, stated rather than
glossed.** Every page measured after it is healthy — `drivers/directory` 3.6 s,
`platforms` 2.8 s, `reconcile` 2.5 s, `vehicles` 1.8 s, `unauthorized/list`
0.9 s, `unauthorized/summary` 0.9 s, `finance/payouts` 0.5 s. The one page
heavy enough for JIT to have been earning its compile is `/api/kpis`, and five
consecutive samples of `days=30` with JIT off came back **13.3, 16.2, 13.5,
9.1, 9.6 s**. The single reading taken before the change was 9.4 s, which sits
inside that spread — so **this does not establish either a regression or its
absence**, and it is not reported as one. Settling it needs the A/B: set
`PG_JIT=on` in the app's environment, re-sample the same endpoint, set it back.
That is what the escape hatch is for, and it is why the setting is an env var
rather than a constant.

**Proven on production 2026-09-16**, by the same measurement that found it —
the empty-window curl, which separates fixed cost from per-row cost in one
request. All three rows above are now `deployed, proven`:

| window | before | after JIT off |
|---|---|---|
| empty window, 0 segments | 67.0–109.1 s | **0.93 s** |
| `days=1`, 6 segments | 98.6 s | **4.14 s** |
| `days=3`, 17 segments | 78.2 s | **3.51 s** |
| `days=30`, 124 segments | 84.1 s | **2.42 s** |

**With the floor gone, the ladder's real cost is finally measurable**, and it is
not the four unbounded per-plate reads either. A 16-day window at the page's own
`limit=200` took 55.5 s, and the plan says where:

```
-> Index Only Scan using trip_econ_day_idx on trip t3
   (actual time=692.331..1770.390 rows=1842 loops=28)
```

1.77 s per execution × 28 = 49.6 s of 55.1 s — **90% of the response in one
subquery**, the candidate→Uber-account lookup in `statusJoin()`, whose own
comment says it was made sargable. It was: the `coalesce()` became two arms.
But the two arms are joined by **OR** across two different columns, and the
planner declined a BitmapOr because the second arm's
`coalesce(btrim(person_key),'') = ''` is an expression no index covers — so it
scanned an unrelated index end to end instead, which is the same work under a
better name.

| # | what | fix | state |
|---|---|---|---|
| — | `statusJoin()`'s person→accounts lookup scanned an index end to end, once per candidate per segment | `api/unauthorized_sql.js` — the two arms UNIONed so each gets its own index (`trip_person_key_idx`, `trip_driver_requested_idx`), plus the `person_key <> ''` the PARTIAL index needs to be applicable | written, committed, deployed, **proven** |

**Proven on production 2026-09-16.** The same node in the same plan:

```
before  -> Index Only Scan using trip_econ_day_idx on trip t3
           (actual time=692.331..1770.390 rows=1842 loops=28)   49.6 s total
after   -> Index Scan using trip_person_key_idx on trip t3
           (actual time=0.493..19.352 rows=1897 loops=27)         0.52 s total
```

End to end, at the page's own `limit=200` — every row the operator actually
receives, not `limit=1`:

| request | before this session | after |
|---|---|---|
| `attributed?days=1` (6 rows) | 98.6 s | **1.34 s** |
| `attributed?days=16` (71 rows) | HTTP 500 after 121 s | **10.04 s** |
| `attributed?days=30` (124 rows) | 84.1 s @ limit=1 | **11.82 s** |
| `attributed?days=30&tier=last_trip` (70 rows) | 37.1 s | **7.15 s** |
| `driver/unauthorized?days=30` | 99.1 s | **28.3 s** |

**Proof method.** `test/status_join_arms.test.mjs` runs the OLD form and the
NEW form side by side over a fixture carrying every shape the column can be in
— a person on two accounts, a nameless account standing in for a missing key, a
row with no id at all, a key nobody holds, `''` and NULL — and asserts they
agree key by key, then asserts the answers are the RIGHT answers rather than
merely the same ones. A rewrite for a plan is only safe if it returns the same
rows, and "the suite still passes" is not that proof. Removing the
`person_key <> ''` turns the file red.

See `docs/COVERAGE.md` traps.

**Still open, and no longer a guess — this is where the remaining 11.8 s is.**
Re-profiled after all three fixes, `days=30` at `limit=200`, Execution Time
11,929 ms:

```
9085 ms  loops=124  -> Aggregate (actual time=73.265..73.266 rows=1 loops=124)
4357 ms  loops=124     -> Index Scan using trip_plate_idx on trip t
                          (actual time=0.258..35.140 rows=2210 loops=124)
 675 ms  loops=31   -> Index Scan using trip_plate_idx on trip t_7  (rows=0)
 420 ms  loops=39   -> Index Scan using trip_plate_idx on trip t_16 (rows=0)
 523 ms  loops=27   -> Index Scan using trip_person_key_idx on trip t3   <- the fixed one
```

**76% of what is left is the `hist` CTE** — the whole plate's history across
every channel, 2,210 rows fetched and aggregated once per SEGMENT rather than
once per PLATE, 124 times over perhaps twenty distinct cars. The two `rows=0`
scans beneath it are `later_other` and the `other_platform` probe, each also
unbounded on the plate.

Two routes out, neither of them free, both now measurable rather than argued:

1. **Scan each plate once, not each segment.** Most of `hist` is per-plate
   (`uber_trips`, `other_trips`, `other_people`); the rest is genuinely keyed on
   `o.started_at` (`uber_prior`, `uber_running`, `uber_first_at`,
   `uber_nameless`, `uber_uncompleted`, `uber_noend`). Splitting it costs a
   second scan unless the time-dependent half can be derived from a grouped
   pre-pass, so this needs designing rather than doing.
2. **One pass instead of three.** `attributionJoin()` is still materialised
   three times per request — the rows, the total and the tier distribution —
   over the same segments. Computing the ladder once into a CTE and deriving all
   three from it is a 3× cut in database work with an unchanged response shape.

**Do not bound the per-plate reads in time to buy this.**
`sql/schema_v72.sql`'s header records the measurement that rejects it: "this
plate has Uber trips but none before the journey" was 1 of 120 under a lookback
bounded at 2026-06-01 and 0 of 120 once it reached 2025-10-01 — a lookback
artefact printed as a fact about a car. A date hard-coded in SQL rots into
exactly that defect.

---

## Payouts to the bank — the live per-day ask, and two false claims retracted — WRITTEN AND TESTED, DEPLOY AND PROOF PENDING — 2026-09-17

**Nothing in this section is proven.** Every line below is at *written* and
*committed*. The word **proven** is reserved, as this file's header says, for a
re-measurement on production *after* the deploy — and the header's own sentence
is the reason it matters here: the suite passing tells you the tests agree with
the code, not that the code agrees with the fleet. The two headline figures in
this work were read live from Uber, but the routes and the page that print them
have never served a request on production.

### What was wrong — three things, and the second was the expensive one

**1. The Payouts page could show almost no Uber history, and could not say why.**
`platform_account_day` held 4 statement days for `uber/ecosine` (2026-08-17 ..
08-20) and 1 payout; 19 days for `uber/egari` (08-17 .. 09-09) and 2 payouts;
Bolt held 175 payouts over 2024-12-23 .. 2026-09-07; Yango publishes no transfer
at all. The cause was not a broken collector. `collect()` in
`src/sources/uber_payout.js` opens `if (mode === 'incremental') return;`, so it
runs only on the 21:00 UTC catch-up and the Sunday backfill; `missingDays()`
filled strictly **oldest first**, 24 days per fleet per run, and Uber's report
limiter cut the night of 2026-09-16 to 4 of the 8 days asked for Ecosine.
**Monday 2026-09-14 — the wire that settles the only fully closed week the
product can talk about — was the 25th missing day for Ecosine, one past the
budget.** The most valuable day in the backlog was last in the queue.

**2. The page printed a 7.1% discrepancy that does not exist.** It said this
register and Bank reconciliation were "7.1% apart", citing AED 110,962.09 against
AED 103,567.54. 110,962.09 is Ecosine's week of Mon 7 – Sun 13 Sep 2026;
103,567.54 is the wire paid on **Mon 7 Sep**, which settles **31 Aug – 6 Sep**.
It compared a week against the previous week's wire. 7,394.55 / 103,567.54 =
7.14%, which is where the printed 7.1% came from. The wire that settles 7–13 Sep
is **111,179.66**, paid Mon 14 Sep, and against that one the difference is **AED
217.57 — 0.20%**. An operator was being told their books were out by seven
percent when they agree to a fifth of one percent.

**3. "The Monday transfer equals the previous week's closing balance, to the
fils, proven over two consecutive weeks" was not proven.** It was stated in
`settlesWeek()`'s comment in `src/sources/uber_payout.js`, on the page, and in
`docs/COVERAGE.md`. Three Ecosine Mondays are now measurable:

| Monday | opening balance | wire | wire − opening |
|---|---|---|---|
| 2026-08-17 | 57,791.73 | 57,810.41 | **+18.68** |
| 2026-09-07 | 103,567.54 | 103,567.54 | **0.00** |
| 2026-09-14 | 111,279.92 | 111,179.66 | **−100.26** |

The **cadence** — a Monday wire settling the preceding Mon–Sun week — holds on
all three and is what the code now relies on. The **equality** holds on one of
three and has stopped being asserted anywhere.

### What was built, and the state of each

| what | where | state |
|---|---|---|
| `POST /api/finance/payouts/verify` — asks Uber LIVE, one day at a time, 1–5 days per call, stores what Uber said, answers with the wire, the week it settles, our own figure and the difference | `api/payout_routes.js` | **written, in the working tree — not yet committed, deployed or proven** |
| `GET /api/finance/payouts/reconcile` — read-only, no live ask; wire against `sum(driver_payout_day.earnings)` over the period each transfer names, plus `unchecked` for the days nobody has asked about | `api/payout_routes.js` | **written, in the working tree — not yet committed, deployed or proven** |
| `checked_at` on `platform_account_day` — when a HUMAN last put this day to Uber, nullable, written only by the live path; `collected_at` cannot answer it because a day is asked once and never rewritten | `sql/schema_v74.sql`, registered in `src/schema_files.js` | **written, in the working tree — not yet committed, and not yet replayed on production** |
| Mondays-first collection ordering, so the wires are discovered before the rest of the backlog rather than after it | `src/sources/uber_payout.js` | **written, in the working tree — not yet committed, deployed or proven** |
| The page panel: the difference first, the week each wire settles beside it, the balance difference shown as a difference and never as a check that should come out at zero, and the unasked days named as unasked | `api/public/payouts.js` | **written, in the working tree — not yet committed, deployed or proven** |
| The wrong-week comparison retracted, the ordering argument kept | `api/public/app.js` (Finance nav), `api/public/payouts.js`, `api/payout_routes.js` (comment and the note string it serves), `src/sources/uber_payout.js`, `docs/COVERAGE.md`, `api/probe.js` (corrected during integration), `mockapi.mjs` (corrected during integration — it SERVES both retracted sentences as rendered copy, so every mock render and screenshot pass printed them), and `src/schema_files.js`. `sql/schema_v71.sql:9` carries a seventh copy which **must not be edited** — an old schema file is replayed by sha and editing it silently does nothing on production — so its correction lives in that file's registration comment in `src/schema_files.js` | **written, in the working tree — not yet committed, deployed or proven** |
| The no-date-column constraint and the wrong-period trap written down | `docs/COVERAGE.md` — Uber section and the standing traps list | **written, in the working tree** |

### The one fact under all of it, now written down

Uber's `REPORT_TYPE_PAYMENTS_ORGANIZATION` **has no date column.** A multi-day
window returns one aggregate row for the window, so the only way to learn which
day a transfer landed on is to ask for a one-day window. That is why the report
is asked one day at a time, why a year of history is 365 report builds per fleet,
why the limiter sets the fill rate, and why a day with no row is a day nobody
asked about rather than a day with no transfer. It was the unstated assumption
under the whole collector and it was nowhere in the documentation until today.

### What still has to happen before any of this is "proven"

1. Deploy both services and let `sql/schema_v74.sql` replay.
2. `POST /api/finance/payouts/verify` on production for `ecosine`,
   `2026-09-14` — the wire must come back **111,179.66**, `settles` must read
   **2026-09-07 .. 2026-09-13**, and the delta against our 110,962.09 must be
   **217.57 / 0.20%**.
3. `GET /api/finance/payouts/reconcile` on production, cache-busted, and read
   the Bolt rows: `calculated`, `delta` and `delta_pct` must be **null** with
   `calculated_basis` naming the reason, because Bolt states no period. A zero
   there is the defect this whole batch exists to stop.
4. Screenshot the page with the panel filled, and confirm the Finance nav no
   longer carries a seven-percent claim anywhere.

Until all four are done, every row in the table above stays at **written,
committed**.


---

## The payout register verified against Uber, and past payments filled

Deployed 2026-09-17. **Proven on production**, by asking Uber through the new
route and reading the answer back out of the register.

`POST /api/finance/payouts/verify` for `ecosine 2026-09-14`, live, 2.3 s:

```
wire        111179.66
settles     2026-09-07 .. 2026-09-13
before      {wire: null, had_statement: false}     <- we held nothing for that day
our figure  110962.09   (1,148 driver-days)
DIFFERENCE  {value: 217.57, pct: 0.2}
balance     opening 111279.92, wire 111179.66, difference -100.26
uber row    opening 111279.92 | earnings 20816.90 | cash -4183.10
            | bank -111179.66 | closing 18024.34
```

`GET /api/finance/payouts/reconcile` answers in **0.80 s** over 112 transfers,
Bolt rows carrying a stated absence rather than a zero.

Past payments: seven Uber wires now carry the full comparison, against one
before this change. The table is in `docs/COVERAGE.md` — largest gap 0.72%,
signs in both directions.

| # | what | fix | state |
|---|---|---|---|
| — | the page could show no Uber payout history and could not ask for any | `POST /api/finance/payouts/verify`, `GET /api/finance/payouts/reconcile`, the page panel | written, committed, deployed, **proven** |
| — | the collector reached a wire 25th of 27 missing days, outside its nightly budget | Mondays-first ordering in `missingDays()` | written, committed, deployed — **not yet proven**: the first nightly walk under it runs at 21:00 UTC tonight |
| — | "7.1% apart" and "equals the previous week's closing balance to the fils" | retracted in seven files; see COVERAGE | written, committed, deployed, **proven** |
| — | a five-day ask was cut by the platform at 300 s with no response, after storing three days | `PAYOUT_VERIFY_BUDGET_MS`, checked before each day, un-reached days reported as refused with the true reason | written, committed — **deploy and proof pending** |

**Found by using it, not by reviewing it.** The 300-second ceiling is not in any
document and no test could have found it: it is a property of the platform, not
of the code, and it only appears on a request that actually walks a slow
provider. It is now a trap in `docs/COVERAGE.md`.


---

## Both fleets, and a backfill that runs without somebody driving it

The operator's follow-up, verbatim: "the numbers match the actual amount but
ecosine and egari both should be fetched. not just ecosine. And backfill as
much as possible."

**Both fleets, done and measured.** Ten Uber wires now carry the full
comparison, against one before this work — and they settle the "7.1%" question
in both directions and on both fleets:

| Monday | fleet | wire | ours | difference | |
|---|---|---|---|---|---|
| 2026-09-14 | Ecosine | 111,179.66 | 110,962.09 | +217.57 | +0.20% |
| 2026-09-14 | Egari | 50,614.03 | 50,717.08 | −103.05 | −0.20% |
| 2026-09-07 | Ecosine | 103,567.54 | 103,768.44 | −200.90 | −0.19% |
| 2026-09-07 | Egari | 50,769.48 | 50,681.39 | +88.09 | +0.17% |
| 2026-08-31 | Ecosine | 77,796.52 | 78,057.58 | −261.06 | −0.34% |
| 2026-08-24 | Ecosine | 66,863.51 | 66,544.64 | +318.87 | +0.48% |
| 2026-08-24 | Egari | 29,856.60 | 29,681.86 | +174.74 | +0.59% |
| 2026-08-17 | Ecosine | 57,810.41 | 57,977.77 | −167.36 | −0.29% |
| 2026-08-17 | Egari | 23,873.79 | 23,701.73 | +172.06 | +0.72% |
| 2026-08-03 | Ecosine | 50,213.19 | 50,306.45 | −93.26 | −0.19% |

**The backfill could not be driven through the page, and that is the finding.**
A three-day ask was cut at 300 s by the platform, on top of the five-day ask
cut earlier. Uber's report takes 10–40 s and the limiter adds minutes, so
synchronous HTTP is the wrong mechanism for hundreds of days however the button
is bounded. The live ask stays for checking ONE day, which is what it is good
at; the backfill belongs in the collector.

| # | what | fix | state |
|---|---|---|---|
| — | `missingDays()` re-asked every day the provider has no statement for, for ever — invisible at 30 days, fatal at 390 | `sql/schema_v75.sql` `payout_ask`: stored / empty / refused, and only refused is retried | written, committed — **deploy and proof pending** |
| — | the walk inherited the nightly catch-up's 30-day window, so the record could never grow backwards | it reads its own floor — the fleet's first Uber trip, from `trip`, rather than a date that rots | written, committed — **deploy and proof pending** |
| — | it ran once a night at 24 days per fleet: sixteen perfect nights to reach the history | its own cadence, `20 */2 * * *`, off the single-collection queue and between the incrementals | written, committed — **deploy and proof pending** |
| — | the page could only say "either nobody asked, or the ask was refused" about every absent day | `unchecked` splits: outstanding days, and days Uber has answered it holds nothing for, counted and named separately | written, committed — **deploy and proof pending** |

**Proof owed.** The four rows above are asserted by
`test/uber_payout_history.test.mjs` — including that an `empty` day is never
asked again and a `refused` day always is, which is the pair that decides
whether a backfill converges or stalls. None of it is proven until the walk has
run on production under the new cadence and the unasked counts have come down.
The first run is within two hours of the deploy; the counts to beat are
**ecosine 390** and **egari 378**.


---

## Option C: the Mondays-first register, checked by the dated report

The operator picked C after the probe. A is the register, B is the audit, and
they are different questions asked of different reports.

**A is deployed and PROVEN.** The Mondays-first ordering and the history floor
(the fleet's first Uber trip, rather than the catch-up's 30 days) took the wire
register from **1 transfer** to **30**, spanning **2025-04-07 to 2026-09-14** —
seventeen months — in about three hours of two-hourly walking. The walk log
shows it reaching 2025: ecosine 2025-06-16 (49,500.96), 06-23 (57,333.98),
06-30 (49,922.20), 07-07 (49,283.65), 07-14 (45,362.26); egari 2025-04-28
(42,476.60), 05-05 (45,542.30), 05-12 (36,676.26). **All twenty payout dates
are Mondays.**

**B is what makes that a check rather than an expectation.** The probe
established, on production, that `REPORT_TYPE_PAYMENTS_ORDER` is per
transaction (399+ rows for one day), that the wire is a row of it
(`Description` = `so.payout`, holding exactly −111,179.66 on 2026-09-14), and
that every row is dated by `vs reporting` (399/399 date-like; range = the
window's day). So one report over a month names every wire in it, on any
weekday.

| # | what | fix | state |
|---|---|---|---|
| — | the register could not show past payments at all | Mondays-first ordering + the fleet's-first-trip floor | deployed, **proven**: 1 → 30 wires, 17 months |
| — | "every wire is a Monday" was an expectation the walk could not check | `src/sources/uber_payout_orders.js` reads the dated report; `payout_audit` (sql/schema_v76.sql) records which windows were read | written, committed — **deploy and proof pending** |
| — | two Uber reports could disagree about one transfer and the later write would win | `platform_payout.audit_amount` beside `amount`, never over it; the page prints both | written, committed — **deploy and proof pending** |
| — | the page could not distinguish "checked" from "expected" | a band naming the audited windows, and saying plainly that an unaudited period is not a clean one | written, committed — **deploy and proof pending** |

**Why B is not used for the backfill.** Generation cost scales with the
transactions in the window, not the number of requests: an eight-day ORDER
report took ~13 minutes (~1.6 min per day of data) against ~1.7–2.4 min per day
for a one-day ORGANIZATION ask. A year of ORDER means generating a year of
transaction rows however it is chunked; a year of Mondays asks for 56 days of
data. **Asking less beats asking less often** — which is why A is the collector
and B runs once a day, off the hot path, at 23:40 UTC.

**Proof owed.** The audit's first run is 23:40 UTC tonight. What would prove it:
a `payout_audit` row with `outcome = 'audited'`, and either `wires_new = 0`
across the audited window — the Monday cadence confirmed by a report that could
have contradicted it — or a wire it found that the register did not hold, which
is the audit earning its keep on the first night.

---

## The page showed 6 transfers over a register of 217 — 2026-09-17

Reported in four words, over a screenshot: **"it doesn't show it. why?"** The
live Payouts page read

```
TRANSFERRED TO THE BANK   AED 319,015
6 transfers on 2 dates in this window
THE RECORD STARTS         23 Dec 2024
```

and every number on it was correct. The shell's window selector was on "This
month", `api/public/data.js` `params()` puts `period=month` on every call a
page makes through `q()`, and `api/payout_routes.js` honoured the month it was
sent. **The route was never the problem** — the first diagnosis written into
the code said it was, and the production measurement retired that before it
was committed:

| request, production 2026-09-17 | transfers | total |
|---|---|---|
| `?period=month` — what the page sent | 6 | AED 319,015.37 |
| `?from=2024-01-01&to=2026-12-31` | 216 | AED 3,460,166.93 |
| no window at all | 217 | — |

| # | what | fix | state |
|---|---|---|---|
| — | the page scoped a register of sparse weekly events to a rolling window | `qChan()` not `q()`, and `payouts` on `NO_RANGE` so the selector comes off the page rather than being ignored | written, **proven by revert** (`test/payout_scope.test.mjs` §5 goes red) |
| — | asked with no window the routes fell to `winDays()`'s `2000-01-01` sentinel, so the unchecked band counted 9,721 days from the year 2000 in a 359 KB response | floor measured from the register itself (`least(min(paid_on), min(day))`), never a constant | written, **proven by revert** (the count comes back 9,756 in PGlite) |
| — | whole-record turned the unchecked list into 19,450 date strings | list capped at 90 per fleet, newest first, **count left complete**, and the cut named in the response and on the page | written, **proven by revert** |
| — | the per-pair heading still said "N days nobody has asked about" — the claim the lead sentence above it was corrected for | "N days with no statement stored" | written, **proven by revert** |

Both halves are needed and each was reverted on its own to check it: the server
change alone leaves the page still sending `period=month`, and the client
change alone produces the 9,721-day backlog above.

**PROVEN ON PRODUCTION 2026-09-17, 15:18 UTC**, deployment
`31251292`, `GET /api/finance/payouts?_=$RANDOM` with no window at all:

```
scope record | window 2024-12-23 -> ...
transfers 235 | dates 91 | total AED 5,285,461.64
uber/ecosine 40 · uber/egari 20 · bolt/ecosine 89 · bolt/egari 86

reconcile, same request:  119,328 bytes in 0.89 s   (was 359,254)
  unchecked uber/ecosine  count 590, listed 90      (was 9,721 / 9,721)
  unchecked uber/egari    count 596, listed 90      (was 9,729 / 9,729)
  totals.basis  "wire totals all 235 transfers on record…"
```

**One defect that first production reading caught**, and it is the reason to
read the whole response rather than the number you went looking for: the window
came back `2024-12-23 -> 2100-01-01`. The floor was measured and the ceiling
was still `winDays()`'s upper sentinel — a field that is the route's own
account of what it answered over, half read from the register and half from
nothing. Now `greatest(max(paid_on), max(day), today)`; `greatest` and not
`today` so a wire dated ahead of today is not clamped out of a page whose
subject is every transfer there is. Asserted, and the assertion watched go red
with the ceiling reverted.

### And what the whole-record render then exposed — same day

Read off the first production page after the window came off, not off the
response field I went looking for:

| what | measured | after |
|---|---|---|
| `window` in the response | `2024-12-23 -> 2100-01-01` — floor measured, ceiling still `winDays()`'s sentinel | `greatest(max(paid_on), max(day), today)` |
| Bolt's coverage row | *"One payout per date, with no fixed weekday"* — written from a month | 175 of 175 Bolt transfers are Mondays, 60 of 60 Uber, 91 of 91 dates; the row now states the **count** and says it is a count |
| "no comparison is made" notes | **58 notes, 50 of them identical** ("1 transfer (Uber)"), page 10,125 px tall | **11 notes, none repeated**, page 6,819 px |

The third was the grouping key being the reason *sentence*, which names the
week — so Bolt's 175 identical reasons collapsed to one note as designed and
Uber's 50 each became a group of one. Rows now carry `calculated_absent`
(`provider_states_no_period` / `uber_period_not_derived` / `no_driver_day_rows`
/ null) and the page groups on the kind, naming the **span** of the weeks
rather than the first row's week.

**Proven on production 2026-09-17, deployment `9013a361`**, `#payouts` at
1440 px and 430 px through `bin/prod-mirror.mjs`: no range selector, no JS
errors at either width, `"in this window"` x0 against `"on record"` x7 / x9,
`AED 5,285,462 · 235 transfers on 91 dates on record`, `unchecked` 590 / 596
with 90 listed each, reconcile 119 KB in 0.89 s.

**Still owed on this page, unchanged by any of the above:** only 10 of 235
transfers can be compared against our own figure at all — the other 225 are 175
Bolt rows that state no period and 50 Uber weeks with no `driver_payout_day`
rows stored. The page now says so in three notes instead of fifty; collecting
those weeks is its own piece of work.

## The Payouts page had no mobile view — 2026-09-18

Asked for in eight words: **"that specific page should have a mobile view."**
It had a desktop layout shrunk to fit — and the whole-record change the day
before is what made that unmissable, since the tables went from a month of rows
to the register.

| # | what | fix | state |
|---|---|---|---|
| — | four tables 637–1,172px wide inside a 312px window, read by scrolling sideways through 239 rows | `cards` opt-in on `tableFrom`: each cell carries its own column heading in `data-label`, and under 560px the rows become cards | written, **proven by revert** (`test/payout_mobile.test.mjs`) |
| — | the document scrolled sideways: scrollWidth 413 against a 390 viewport | the cells stopped spilling; measured 390 at 390 | written, **proven by revert** |
| — | 724 rows rendered on a phone, page 10,611px | `foldRows` on the three long tables — 12, 20 and 14 shown, the rest behind a button that names how many | written, **proven by revert** |
| — | 91 bars in 312px, 3.4px each | a floor bar width below 560px, scrolling inside the panel, with a caption that only prints where it is true | written, **proven by revert** |
| — | every even card shaded, because the zebra override lost on specificity | selector matched to the rule it overrides | written, **proven by revert** |

**Three wrong layouts before the right one, and the files say so.** Flex with
bare content (an anonymous flex item cannot take `min-width:0` — 419px), a
two-track grid (the label track takes its max-content — 448px), then
label-above-value, which fixed the overflow and cost a line per field: cards
298–470px and the page **26,559px, measured on production after deploying it**.
The fourth is what shipped — flex with the value in its own `<span>`, a real
flex item that shrinks and wraps inside its own side. All four passed a
source-reading test; only a browser told them apart, and only a production
render caught the third.

**One claim retracted before it was committed:** the comment on
`.chartscroll{min-width:0}` said that line fixed the 419px scroll. It did not —
that was the card cells. Measured with the line removed, the document is 390px
either way; it is kept as a guard and now says that it is one.

**PROVEN ON PRODUCTION 2026-09-18, deployment `22ee6ad8`:**

```
phone  390px: doc=390/390   height=21,008  49 cards  row display block
wide  1440px: doc=1440/1440 height= 7,270  49 rows   row display table-row
five fold buttons, no JS errors at either width
```

**And the first deploy of it was wrong in a way only production showed.** The
stacked layout went out clean — no overflow, 22 assertions green against the
mock — and measured **26,559px at 390px**, two and a half times the 10,611px it
replaced. The mock holds four payouts; production holds 303, and a layout whose
cost is per field per card cannot be judged on four. The `.cardval` span
replaced it the same hour.

Also corrected in that round: `td.v-good` carries its verdict as `inset 2px 0 0`
— a rule on the column edge, which is right in a table and reads as a rendering
artifact in a card, where it lands flush against the label's first letter. Given
a gutter.


## The phone had no payouts screen at all — 2026-09-18

Three words: **"we have a pwa."** And the register's mobile view had been built
in the wrong app.

`api/public/index.html` loads a separate phone bundle on `max-width:760px` AND
`pointer:coarse`. Playwright with a 390px viewport and no `hasTouch` fails the
second test and gets the desktop bundle, so the card layout, the folds and the
chart scroller of the pass before this were all measured against an app no
phone loads. On a real phone `#payouts` had no entry in `SCREENS` and rendered
`fallback()`: *"Built for a bigger screen."*

| # | what | fix | state |
|---|---|---|---|
| — | a phone opening the payout register was refused it | a `payouts` screen in `api/public/m/screens.js`, built from the phone's own components | written, **proven by revert** (`test/payout_mobile.test.mjs` §4 — six assertions go red) |
| — | the route was unreachable from the tab bar | `payouts` added to the Money tab's `owns`, and a row under More | written, **proven by revert** |
| — | a header would have read "payouts", the router's word | `titleFor` entry: **To the bank** — not "Payouts", since a payout is a *driver's* payout everywhere else here | written, asserted |
| — | the comparison rounded to whole dirhams | two decimals through the lede, as the desktop panel does: 217.57 against 111,179.66 | written, **proven by revert** |

**A test that claimed more than it proved, caught by reverting the thing it
guarded.** The fils assertion matched against the whole page, and the
comparison rows further down print the same figures — so it stayed green with
the lede rounded. It now reads the lede's own text.

**The earlier pass is not wasted and is not the phone.** The desktop bundle at
390px is a narrow window, a tablet, and the `?ui=desktop` build the phone's own
fallback button opens. Both are asserted, in the same file, and the file now
says which is which.

**PROVEN ON PRODUCTION 2026-09-18, deployment `144b0dd7`**, through
`bin/prod-mirror.mjs` with `devices['iPhone 13']`:

```
shell phone · refused false · sideways false · no JS errors
lede     "AED 111,179.66 on Sep 14"
cut      "The 25 most recent of 303 transfers"
weekday  "every one a Monday"
```

**Three sentences shipped untrue in the first build of it**, all read off the
deployed phone and none of them reachable from the mock: `The 25 busiest of 303
transfers` (`cut()` claims a ranking that nothing ranked), `every one a Mon`
(three letters of a weekday), and a comparison sub cut to `ours AED 110…` by
`.m-row .k span`'s nowrap ellipsis — losing the figure the row exists to
compare. The coverage rows had the same clip on a provider's whole cadence
sentence.

**And the guard against the last one passed with its own fix reverted, twice**,
because the fixture's `111,179.66` fits 390px by a hair where production's
`103,567.54` does not — a proportional `1` is narrow. The mock now carries a
row whose amounts have no leading 1s, which reproduces at +18px and turns the
assertion red when the rule is removed.


## The same-person queue could not see same-channel duplicates — 2026-09-19

Asked for as "merge the duplicate drivers … we had about 90 active drivers".
A driver report built on `personOf()` counted **238 people over 260 accounts**;
the operator's roster is about ninety.

| # | what | fix | state |
|---|---|---|---|
| — | `nameCandidates()` skips same-platform pairs, so one driver's two Uber accounts were never proposed | `sharedCarShapes()` proposes them when the two accounts **drove the same car** — the evidence the forty-Muhammads argument is missing | written, **proven by revert** (`test/identity_shared_car.test.mjs`) |
| — | transliteration variants (Rehman/Rahman, Ahmed/Ahmad) matched nothing | `spellingFolder()` folds tokens one edit apart, 4+ characters only, before the existing subset/reorder test | written, **proven by revert** |
| — | nothing in the file could say *no* | trips overlapping **in different cars** refuse the pair outright, with the moment and both plates logged | written, **proven by revert** |

**Nothing merges anybody.** Every row lands in `driver_identity_link`
unconfirmed under basis `shared_car_name`, which is not in `CONCLUSIVE`, so it
appears on **#same-person** for a human to rule on. `api/identity_map.js` is
untouched — it stays a hand-reviewed list, per the hard rule.

**A test that proved nothing, caught by reverting the guard it named.** The
short-word assertion used "ali"/"alam" — two edits apart, so it stayed green
with the length guard removed. It uses "ali"/"ala" now and goes red.

### And the queue was emptying itself, which the deploy exposed

| # | what | fix | state |
|---|---|---|---|
| — | every refresh after the one that proposed a pair **withdrew it** — 123 pending before the deploy, 0 after | `keep` now spares pending proposals the rules still support | written, **proven by revert** (`test/identity_queue_persists.test.mjs`) |
| — | the first version of that spared a `shared_phone` link that had genuinely lost its evidence | exemption scoped to the proposal bases only | written, caught by `test/identity_link.test.mjs` |

Pre-existing, not introduced here — reproduced by calling `refreshIdentityLinks`
three times against a fixture, which oscillates 1 → 0 → 1. The restart that
followed this deploy is what made it visible.

**PROVEN ON PRODUCTION 2026-09-19, deployment `8879f5ad`.** `GET /api/same-person`
polled once a minute across several collector cycles:

```
06:46  pending  20 | shared_car 17 | decided 124
06:48  pending  20 | shared_car 17 | decided 124
06:49  pending 148 | shared_car 25 | decided 124   <- a fuller refresh
06:50 … 06:55   pending 148 | shared_car 25 | decided 124   (stable, 7 reads)
```

Both halves are in that trace. **25 `shared_car_name` proposals** the queue could
not previously make — among them `ALI REHMAN RIAZ KARIM` ⇐ `Ali Rahman Karim`,
`Arslan Arif Muhammad Arif` ⇐ `Arslan Arif Arif`, `Abdul Hannan Momin Humayun
Habib Momin` ⇐ `Abdul Hannan Momin` on plate L78475. And **the count stops
falling**: 148 held across seven consecutive reads and several refreshes, where
before the fix the next pass took it to 0. The 124 decided rows were never
touched.

---

## Batch — the money ledger could not be started, and the line could not be set

2026-09-21. Three defects that only existed together, and none of which any of
the 270 test files could see, because every ledger fixture seeds a person before
it asks anything. **A fixture that begins by creating the thing under test
cannot detect that nothing in the product creates it.** That is the general
lesson and it is now a trap in `docs/COVERAGE.md`.

| # | what | fix | state |
|---|---|---|---|
| — | **the closed loop.** People are minted by the first entry; every picker listed drivers from `/api/ledger/exposure`, which reads `driver`; `driver` is empty until an entry exists. Live on production as five zeroes | `GET /api/ledger/people` — the minted people UNION the unclaimed platform roster. Every picker reads it through `loadPeople()` | written, **proven by two reverts** (`test/ledger_people.test.mjs`) |
| — | **`api/ledger_person.js` selected `driver_name` from `driver_platform_state`,** a column that table has never had. The statement threw, the transaction rolled back, and the FIRST entry against anybody the merge register knows wrote nothing — 130 entries over 124 people | `full_name`, in both roster tables | written, **proven by revert** (4 assertions red) |
| — | **no write route for `ledger_policy`.** Every exposure figure in the product read "no threshold has been stored, so no exposure can be judged" | `GET`/`POST /api/ledger/policy` and `#policy` | written, **proven by revert** (dry-run rollback: 5 red; in-force: 2 red; invented placeholder: 1 red) |
| — | `/api/ledger/import/commit` took person ids only, so a historical sheet could not be imported into the ledger an import exists to OPEN | an account is also an address; a NAME is still refused at the boundary, held by 3 assertions | written, proven |
| — | the import preview matched against `driver` alone — four hundred rows of "not on the roster" on the first sheet anybody loads | matches the union | written |
| — | **`$N::bigint IS NULL OR person_id = $N` on the driver Money tab.** An account nobody has recorded against resolves to null, which the filter reads as NO FILTER — the whole fleet's entries, summed, under one driver's name on their page | empty with a reason, before the query | written, **proven by revert** (register returned 2 people, `advance: 14999`) |

### What was removed rather than kept

One clause in the `in_force` computation read as a guard and was dead — the
subquery already restricts to rows in force, so a future-dated row fails the id
comparison by construction. Reverting it left the suite green, which is how it
was found. Removed, for the reason `api/import_routes.js` gives about its own
dead 2000-row cap: **a check that cannot fire is worse than none, because it
reads as a considered one.**

### And a fixture caught by the fixture-checker

`test/mockapi.test.mjs` compares the mock's shape against the live API across
124 routes and failed on `/api/ledger/exposure: fixture lacks person_id,
resolved_from, absent_reason`. That is the failure mode it exists for — a mock
answering a narrower shape than production lets a page ship reading a field the
mock never had, and the browser tests stay green all the way to a deploy.

**NOT YET PROVEN.** Everything above is `written` and `committed`. Nothing here
is proven until it has been re-measured on production after the deploy — in
particular the thing that started it: `/api/ledger/people` returning a non-empty
roster on the live database, and a policy row actually stored so exposure stops
refusing for want of one.

---

## Batch — a driver page was addressed by an account that only represents them

2026-09-21. One defect, and it was the address rather than anything on the page.
Every driver page in this product was `#driver/<provider account id>` — an Uber
UUID, a Yango number, a hotel ObjectId — while the page itself is a PERSON:
`src/persons.js` folds a human's accounts onto one `driver` row and
`api/driver_routes.js` answers every panel over all of them. So the identity a
reader bookmarked and pasted was one of the folded records, chosen by whichever
row they happened to click, and **which account represents somebody moves** —
a merge reviewed, a wrongly merged account detached. Measured on production
2026-09-21: **810 platform accounts over ~349 people.** The person id never
moves; `driver_ledger.person_id` already keys money on it.

| # | what | fix | state |
|---|---|---|---|
| — | the canonical address is the person | `#driver/p412`, parsed by `personIdOf` in `api/public/data.js` | written, **proven by revert** (8 assertions red) |
| — | every `#driver/<ext_id>` link ever made must keep working | resolved to its person, renders the identical page, then `rewriteParam` puts the canonical address in the bar **in place** — `history.replaceState`, so no second render and no history entry | written, **proven by revert** (3 assertions red) |
| — | the profile is resolvable by person id | `?person=` on `/api/driver/profile`, its own parameter; the response's `resolved_by` says which one answered | written |
| — | an account the spine has not placed | renders exactly as before and states WHICH not-placed state it is in — register unreadable / register never built / this account unreviewed | written |
| — | the header never said who the page is | `identityCard` now carries the person id and every account with its platform, its join basis, and a mark on the one the address named | written |

### The two ids that are live on that page at once

`renderDriver` keeps them apart deliberately and the block comment above it says
so: **`id` is the provider account every tab ENDPOINT is asked about; `canon` is
what the page LINKS by.** They are not interchangeable and the route will not
guess between them — Yango and Bolt both issue digits-only account ids, so
`?id=412` is a plausible Yango account and a plausible person at the same time.
A route that guessed would, the day those collide, answer one person's page
under another person's address.

### What was deliberately NOT changed

`/api/drivers/directory` still answers a **bare array**. Several consumers read
it that way, wrapping it to carry a person id would break every one of them
silently, and the redirect makes it unnecessary — a directory row links by its
account and the page rewrites the address on arrival. Held by an assertion in
`test/person_address.test.mjs`.

**NOT YET PROVEN.** Everything above is `written`. Nothing is proven until
`#driver/p<id>` has been opened on production, an account link watched to
rewrite itself, and an unplaced account's page screenshotted with its reason.

---

## Batch — #compliance counted accounts and called them drivers

2026-09-21. The last surface still answering "how many drivers" with a count of
`driver_compliance` ROWS. Measured on production the same day: **437 rows over
810 accounts belonging to ~349 people**, under the banner *"140 drivers cannot
legally work — the licence has expired"* — which is the single most
consequential sentence this product prints. A man with a hotel record and an
Uber record was two of that 140.

| # | what | fix | state |
|---|---|---|---|
| — | the response is grouped by person | `/api/compliance/drivers` returns `people`, one row per human carrying every account's documents within it, beside the unchanged `drivers` (accounts) | written, **proven by revert** (15 assertions red) |
| — | a person is headed by their SOONEST expiry | `soonest_account` names the record it came from, so "expired 247 days ago" has somewhere to act on | written |
| — | two accounts of one person that disagree | `conflicts[]` names the field, the count of distinct values and the accounts — **never the values**; compared server-side on the unredacted rows | written, **proven by revert** (3 assertions red) |
| — | a person whose licence cannot be checked | `licence_status: 'unknown'` with one of three true reasons — all defaulted, none filed, or one of each with the counts — never zero and never "valid" | written |
| — | an account the spine has not placed | its own row, `person_placed: false`, and `person_basis` says the total is people *plus* unplaced accounts | written |
| — | a spine that could not be READ | `person_basis: 'unreadable'` and a sentence naming it a failure to measure; the page must not fall back to counting rows | written |
| — | the page | tiles say "people" in as many words and carry the record count beside them; the table is one row per person with each record's documents inside | written |

### What was deliberately NOT changed

**`drivers` still holds the ACCOUNT rows**, unrenamed. They are the evidence the
person rows were folded from — "which record carries which paper" cannot be
answered from a list that has already been folded — and three suites pin
different properties of them (`test/server_redaction.test.mjs`,
`test/driver_photo.test.mjs`, `test/held_fields.test.mjs`). `totals` likewise
still counts records, and the page reads it only where the subject really is a
record. `counts` names each population in words so the two can never be read as
the same number again.

**The person totals are counted in JS, not in SQL**, which the comment above
`totals` in that route otherwise forbids. It is safe here for one reason that
must stay true: the row query asks for `COMPLIANCE_LIMIT + 1` and **throws**
rather than serving part of a roster, so `rows` is either all of it or a 500.
If that cap ever gains a paging shape, these totals move with it.

**NOT YET PROVEN.** Everything above is `written`: 50 assertions in
`test/compliance_person.test.mjs` (two proved by revert), plus
`mockapi`, `endpoint_coverage`, `redact`, `server_redaction`, `nav_sections`,
`interlinking`, `type_scale`, `routes`, `held_fields`, `driver_photo`,
`server_audit`, `hotel_licence_date`, `driver_identity`, `assets`,
`persons_spine`, `route_smoke` and the 124-view `smoke_views` pass, all green.
Nothing is proven until `#compliance` has been opened on production with
`&_=$RANDOM`, the headline read as a count of people, and a conflicting pair
screenshotted.

---

## PROVEN ON PRODUCTION — 21 September 2026, deployment `b35b76ab`, commit `f9bdd18`

Everything in the two batches above was `written`. This is the production pass
that moves them, taken after the deployment's OWN id polled to `ACTIVE` — not
`deployments[0]`, which reads `ACTIVE` for an auto-rollback and has produced a
false "deployed" claim in this repo before. Both services report `f9bdd18`.

| claim | how it was checked | result |
|---|---|---|
| compliance counts people, not records | `GET /api/compliance/drivers` | `people` 267 over `drivers` 437; `person_basis: spine`; `unplaced_accounts: 0` |
| …and says so on the page | `#compliance` screenshotted at 1440 | "The driver figure counts 267 people, not 437 platform records — one person can hold several." |
| a person address resolves | `GET /api/driver/profile?person=202` | `resolved_by: person_id`, six accounts over bolt ×2 / hotel / uber / yango ×2 |
| an account address reaches the same page | `?id=6616272` | `resolved_by: ext_id` → person 202 |
| a bad person address refuses correctly | `?person=not-a-person` | **HTTP 400**, not 404 |
| the address rewrites in the bar | `#driver/6616272` in Chromium | → `#driver/p202`, card shows `PERSON p202 the stable address` |
| **the Activity tab renders** | `#driver/p202/activity` | renders; `0610eac` fixed the `prof` ReferenceError `4325c67` introduced |
| the spine folds on confirm | `/api/same-person?counts=1` | 407 → 349 → **347** across two collector passes; `pending: 0` |
| the identity surfaces agree | directory / ledger / same-person | **347 / 347 / 347** |

**A METHOD NOTE, because it nearly produced a false pass.** The first browser
check asserted `!/Could not load this view/` and slept 9s. It went green on a
page still showing "Loading…" — an assertion that cannot fail on a blank page is
not evidence. Re-run waiting on the content selector (`.idfacts`, `#view .tabs`,
`[data-panel]`) and asserting the text the page exists to show. Prefer a
`waitForSelector` on real content over any fixed sleep; the first paint after a
deployment is a cold container and is slower than any timeout you will guess.

**STILL NOT PROVEN:** a conflicting pair has not been screenshotted on the
person it belongs to — only the count (2) has been read, from the tile and from
`people_totals.with_conflicts`. And `with_conflicts` is a floor, not a total:
`licence_no` and `emirates_id` are withheld from an anonymous GET, so a
number-level conflict cannot be seen from outside and the real figure is ≥ 2.

---

## THE PER-PERSON REGISTER — written 2026-09-22, NOT YET ON PRODUCTION

The operator's ask: "everything that a person earns and spends in a ledger that
looks similar to a bank statement which has specific transaction history",
later exportable as a payslip. Their rule for the cash column, same day: **"Cash
trips are cash to the driver unless they give it to the company."**

| claim | state |
|---|---|
| `trip.raw` survives the next export, so per-trip cash and fee exist at all | **proven by revert** (3 red), `44ac23b` |
| one definition of what a cash fare is worth, read by exposure AND the register | **proven by revert** (3 red), `3106041` |
| nothing-recorded renders absent, not 0 | **proven by revert** (9 red), `53e592f` |
| a stray `?id=` refuses instead of returning 347 people | **proven by revert**, same |
| four receipt states, each with the true reason | **proven by revert** (4 red), same |
| `GET /api/driver/register` — three kinds of line, two running balances | written, 25 assertions, carry-in **proven by revert** (2 red) |
| the statement renders on `#driver/p<id>/money` | written, `driver_money_tab` 34/34 |

### What is deliberately NOT in it

**No aggregate is ever a dated line.** `driver_payout_day` is a weekly statement
divided across days, so the money did not move on those dates;
`driver_statement_day` is daily totals; `money_event` is period figures;
`platform_payout` is a real wire but to the **company**. Only `trip` and
`driver_ledger` hold events, and only they become lines.

**The commission is per trip, not per period.** An early draft of the plan
asserted "no per-trip fee exists anywhere in this database" and built a
period-grain architecture on that. It is false: `src/sources/uber.js:649` files
a `service_fee` on every Uber trip whose payments week has been walked,
measured at exactly 25%. A platform that files none — Bolt, Yango, the hotel
channel — gets **no invented fee**, because allocating a period figure across
trips would state a number the platform never filed.

**`earned` is not a book and not a balance.** `driver_ledger` has four books and
they are never netted. The register adds `earning` and `fee` for things that are
not ledger entries, flagged `ledger: false` so nothing sums them into a book. An
earlier draft admitted only `service_fee` rows into a book called `earned`,
which would have printed a column headed *earned to date* reading **-1,878.39**.

### NOT PROVEN

Nothing above has been seen on production. `driver_ledger` and `ledger_policy`
both hold **zero rows** there, so every running balance renders absent-with-a-
reason and the cash rule cannot be demonstrated on real data until the accounts
team files the first `cash_opening`. The browser assertions run against
`mockapi.mjs`, whose fixture is deliberately shaped so a page that got the cash
rule wrong renders visibly wrong against it.

### Still open, and named rather than implied

- **The toll question.** A cash trip's `cash_collected` exceeds its fare — +5.00
  on 32 of 51 sampled trips (a Salik gate the rider paid in cash at the window)
  and +37.30 on one measured trip. The register credits the driver with what
  they took. Whether they then owe the toll back belongs to the `salik`
  deduction type, against the person, on a date — it is deliberately not netted
  per trip. **The operator has not yet answered this.**
- **Which gross a payslip uses.** 11,461.61 (fares) / 10,353.98 (statement
  gross) / 7,614.21 (statement periods) — and whether that figure is already net
  of the driver's cash, since Uber deducts `cash_collected` from what it wires
  the fleet. Get it wrong and a driver is charged twice for one sum.
- **Step 7, the issued document**, is not started. It is last on purpose: it is
  the only permanent piece, and it should not be written until the fee model and
  the cash amount have stopped moving.

---

## Batch — #forecast compares with the same month a year earlier

Commits `371a7f8` (model + Dubai tourism table), `d0dd4f1` (route + two
suites), `09cd228` (page + browser suite). The operator's words: *"ensure that
it does forecast properly, by incorporating total tourist coming in dubai, how
that changed the number of trips last year … It should always compare month
with the previous year month, active vehicle that month, with active vehicle
this month, and then average trip number per vehicle etc."*

### THE DEFECT, measured on production 2026-09-22 before any change

`/api/forecast` fitted one straight line to the months since the March 2026
break. That refusal is correct and is untouched. What the line cannot do is
know that October is Dubai's high season, because the regime it is fitted to is
six months old and has never contained an October.

| | |
|---|---|
| September 2026, forecast by the line | **14,700** (11,100–18,300) |
| September 2026, first 21 whole days | 16,095 |
| the same 21 days of September 2025 | 19,867 |
| September 2026 completing on last year's shape | **~23,975** |

39% low, and the month sat outside the interval the page published for it —
`in_progress.within_interval` had been answering `false` and nothing read it.

### A SECOND DEFECT, found while fixing the first

`days_so_far` came from `spanTo`, the latest day carrying **any** booking. On
2026-09-22 that was the 22nd, which held **71** bookings because the collector
had run once that morning against a trailing norm near 766. Production
published **734.8/day** where the whole days give **766.4**, and "on track for
22,045" where they give 22,992. That figure is the page's only score of its own
forecast, so understating it flatters a forecast that is too low.

### Status

| # | what | state | proof |
|---|---|---|---|
| F1 | year-on-year per month: bookings, **active vehicles**, **bookings per active vehicle**, both sides | **proven** | production `/api/forecast` 2026-09-22 after deploy: 2026-08 vs 2025-08 = 14,021/14,234, vehicles 98/114 (−14.0%), per-vehicle 143.1/124.9 (**+14.6%**) |
| F2 | a pair that is not a comparison is refused, with the channel named | **proven** | 2026-01/02/03 come back `comparable:"no"`, *"uber, yango carried 84.5% of this month and carried nothing in 2025-01"* |
| F3 | year-on-year projection with its interval | **proven** | 2026-10 = **31,900** [25,100–38,600] on a 2025-10 base of 35,703, ratio 0.8707, t = 4.30 on 2 df |
| F4 | Dubai visitors as a regressor with r² stated | **proven** | per-vehicle r² **0.668**, bookings 0.641, active vehicles **0.281**, n = 11 |
| F5 | the hand-transcribed visitor table reconciles to DET's own totals | **proven** | H1 2025 delta **0**, Jan–Nov −2,000, FY2025 −2,000, recomputed per request |
| F6 | run rate over whole days only | **proven** | `days_so_far` 21, `per_day` **767.0**, `basis` names the rule, `trips_including_today` 16,231 kept beside 16,108 |
| F7 | month in progress scored against the same days a year earlier | **proven** | `same_days_year_ago` = 16,108 vs 19,867, ratio 0.811, projected **23,995** |
| F8 | every method scored one step ahead, published whichever way it falls | **proven** | `model_scores.mean_abs_pct` = line 12.2%, **seasonal 30.5%**, flat 18.4% |
| F9 | the page renders all of it | **written, committed** | `test/forecast_page.test.mjs` 36 assertions against the mock, 5 reverts |

**F1–F8 are proven on production** because `d0dd4f1` was an ancestor of the
deploy that went out on 2026-09-22 and the figures above were re-measured from
the live endpoint afterwards. **F9 is not**: the page ships in `09cd228`, which
is not deployed at the time of writing. Verify it with the modals filled before
claiming it.

### THE SCOREBOARD DOES NOT FLATTER THE NEW MODEL, and the page says so

One step ahead, using only the months before each target:

| month | actual | line | year on year | flat |
|---|---|---|---|---|
| 2026-07 | 10,883 | **+14.6%** | −40.3% | −13.0% |
| 2026-08 | 14,021 | **−9.8%** | −20.8% | −23.8% |
| mean \|err\| | | **12.2%** | 30.5% | 18.4% |

The straight line wins both, and it wins for a reason: both months sit inside
the recovery, where a year-on-year ratio taken from earlier months is biased
low by construction because the ratio was still climbing. September is the
opposite case and the line is the one that misses by 39%. **Two scored months
cannot settle that**, so both models are served, the page prints all three
errors, and it ends *"this page does not tell you which to believe, because it
cannot demonstrate it."* The assertion that the losing number stays on the page
is in `test/forecast_page.test.mjs`.

### Proved by revert — eight of them

| revert | result |
|---|---|
| channel-mix comparability test removed | 56 passed, **5 failed** |
| `sqrt(1 + 1/n)` dropped from the interval | 59 passed, **2 failed** |
| `base_regime` back to the original test | 60 passed, **1 failed** |
| tourism mix filter removed | 58 passed, **3 failed** — r² 0.668 → **0.135** |
| `lastWholeDay` ignored | 57 passed, **4 failed** |
| the route stops fetching the per-platform grain | 32 passed, **6 failed** |
| the run rate goes back to `spanTo` | 34 passed, **4 failed** |
| the same-days-a-year-ago query dropped | 34 passed, **4 failed** |

Plus five on the page: the year-on-year panel (22/13), the comparable-table
filter (34/1), the scoreboard's losing error (32/3), the calendar warning
(32/3), the whiskers (34/1).

Two of the eight behaved differently from the prediction and **both are
recorded as they happened** in the test headers rather than as intended. One of
those is worth carrying forward: removing the channel-mix test left *"the
refusal names the channel and its share"* PASSING, because the softer verdict
names the same channel and the same 84.5%. Only the assertion on the **verdict**
caught it. A guard whose failure mode is invisible to the assertion aimed at it
is not guarded.

### What the test found that the code review did not

The comparable table filtered on `r.ratio != null`. A refused pair still
**carries** its ratio — the route computes it before deciding the pair is not a
comparison, and serves it so the refusal can quote the number it declined to
publish. So January and February 2026 rendered at +601% and +559% directly
above the note explaining that those months cannot be compared. Every other
assertion on that panel was green with both months in it.

### NOT DONE, and named rather than implied

- **`sql/schema_v81.sql` was not written.** Dubai's visitor figures live in
  `src/dubai_tourism.js`, a reviewed list, not a table. Nothing collects them —
  there is no feed and `dubaidet.gov.ae` answers this platform's egress with
  403 — and this file already records two traps that a table would walk into: a
  seeded lookup with `ON CONFLICT DO NOTHING` never receives a correction, and
  a lazily-minted table cannot seed itself. A reviewed list is the shape
  `api/identity_map.js` already uses for hand-checked facts, and the
  reconciliation test is what keeps it honest.
- **February–July 2026 have no monthly visitor figure.** DET published the year
  to date and August alone. They are kept as one aggregate and render absent
  with that reason. **They are not interpolated**, so the tourism fit runs on
  11 months rather than 17.
- **The 2027-03 onward projections are built on post-break base months** and
  are flagged `base_post_break` on the row and in the table. The ratio was
  measured as post-break over PRE-break, so applying it to a base that already
  carries the collapse subtracts it twice. Those rows are almost certainly too
  low, are shown because a plan wants a shape for the year, and are labelled.
  Correcting them needs a second ratio nobody has the months to measure yet.
- **The daily rota still spreads the STRAIGHT LINE's total**, not the
  year-on-year one, and the caption says so and gives the scale factor. Moving
  it would pick a winner between the two models, which the scoreboard does not
  support.

---

## The credential paste flow takes several files, each keeping its own name — 2026-09-22

The operator's request, verbatim: *"run an agent and update the settings page
where we paste tokens and curls data to ensure we get updated. Also, allow
multiple text files upload just like I did here for ease of usage."* Five .txt
files had been dropped into that conversation minutes earlier.

| # | what | state | proof |
|---|---|---|---|
| P1 | the file picker took **one** file of a multi-selection and dropped the rest silently | written, committed | `file.multiple = true`; `test/paste_files_page.test.mjs` asserts `input.multiple`, and removing it makes Playwright refuse the set outright |
| P2 | a drop zone, so the gesture is the one the operator already makes | written, committed | staged chips assert by name in the browser test |
| P3 | files go up **as files**, with their names, never concatenated | written, committed | `test/paste_multifile.test.mjs`; reverting to the concatenating form fails 16 of 43 |
| P4 | every verdict says which file it came out of | written, committed | the `From` column; removing it fails 2 browser assertions |
| P5 | the same credential in two files is one candidate, one write, both names | written, committed | 4 assertions; the revert writes the same key twice |
| P6 | a filename claiming a fleet its contents cannot serve is named, with the owner id a real one would need | written, committed | 4 assertions route-side, 3 page-side |
| P7 | a Bolt paste says **check the other fleet**, never "capture a fresh one" | written, committed | 4 assertions incl. the negative one |
| P8 | a file nothing was read from is reported absent **with a reason**, never as a zero | written, committed | `nothing_read` finding + the `ent-off` cell |
| P9 | the paste table's verdict pills had no tone at all (`good`/`critical` are kpiRow's words, not `.pill` classes) | written, committed | `.pill.ok/.warn/.bad` are the four app.css defines |
| P10 | `/api/settings/paste` was never reachable from any test — five identifiers missing from `test/mount.mjs`'s injection set | written, committed | the route is now driven end to end against PGlite |

**Not deployed and not proven, by instruction and by access.** The work was
asked for without a deploy, and `/api/settings/paste` is `requireAdmin` — no
agent on this branch holds an admin token, so **no part of this has been
exercised against production**. What is proven is: 43 assertions through
`test/mount.mjs` against PGlite, 19 in Chromium against `mockapi.mjs` running
the real recogniser and the real cross-file rules, and eight surgical reverts
whose measured failures are recorded in the two test headers.

The one thing that cannot be tested anywhere here is the live provider check
itself — `src/credcheck.js`'s Bolt path mints an access token against the
portal, and this sandbox has no route to the internet. It is stubbed in both
suites, and stubbed to the contract `checkCandidate` already implements.

---

## Batch — the Settings page's structure

Commit `a1ef14c`. The operator's request, verbatim: *"https://fleet-dashboard-wpeqb.ondigitalocean.app/#settings
the page is broken padding and in general the structure"*.

It was not padding. Three defects, found by screenshotting the production bytes
on `f8eef55` — which is the point worth keeping: the suite was green at 294
files with all three of these shipped, because nothing had ever looked at the
page.

| # | what | state | proof |
|---|---|---|---|
| S1 | every `.setgroup` rendered as an **empty bordered card** with the rows it named loose underneath it — `el('div','setgroup', grp)` was appended to `wrap` as a *sibling* of the rows, and `app.css:957` styles `.setgroup` as a card | written, committed | `test/settings_page_layout.test.mjs`; the revert measures `{"groups":5,"rows":5,"inside":0,"loose":5,"empty":["Uber","Yango","CABMAN","Hotel","Collection"]}` |
| S2 | label and key concatenated into one word — `usernameFMS_ECOSINE_USER`. `.lab` and `.lab small` had **no rule anywhere in app.css** and `<small>` is inline | written, committed | the revert measures the key's computed `display` as `inline`; note the geometry check alone does *not* catch it, since a long label wraps and pushes an inline `<small>` down a line anyway |
| S3 | the hint — a sentence — was welded to the key inside the same `<small>` with `' · '`, so prose rendered in the monospace an identifier needs, wrapped to three lines in a 220px column | written, committed | the revert fails 4: no `.labhint` exists and the key reads `UBER_WEB_COOKIE · Paste from a logged-in supplier.uber.com session` |
| S4 | **"Admin access — Changes require the admin token configured on the server" is false on this deployment.** `api/admin_gate.js:63` runs the write gate OPEN when `ADMIN_TOKEN` is unset: it warns once and calls `next()` | written, committed | `GET /api/admin-mode` + the panel that reads it; the revert fails 2 |

S4 is the one that generalises. The page was **asserting** a server behaviour
instead of **asking** about it, and it asserted the wrong one — which is the
house rule inverted: a figure that cannot be measured renders absent with a
reason, and a reason that is not the true one is worse than no reason at all.
The new route reports the *mode*, never the value, and deliberately does not
sit behind the gate: a page that cannot say whether writes are open until it is
authorised to write cannot tell an operator why their write was refused.

Proved by revert, per fix, with the measured counts in the test header — plus
one proof the other way: flipping the fixture to `open: false` turns the panel
to the other sentence and the suite stays 16/16, so the page reads the server
rather than printing a constant.

## Bolt's Monday 21 Sep payout, and everything that hid it — 2026-09-23

The operator: "monday 21st had bolt payout as well." It had — Ecosine AED
1,275.14, Egari AED 619.18 — and the Payouts page showed nothing for that
Monday. `getPayouts` runs days late (on 23 Sep it still ended at 14 Sep);
Bolt's balance ledger (`getFleetBalanceDetails`, one day per call) carries the
"Weekly payout" line the day the money leaves. Measured on production before
any fix, by deploy `86d2e21`'s probe.

| # | what | state | proof |
|---|---|---|---|
| B1 | the page read Bolt's payouts from `getPayouts` only | **proven** — `942f255` + `8f390b5`, deployment `1276e564` | on production, `/api/finance/payouts`: 2026-09-21 ecosine 1275.14 / egari 619.18, `basis: balance-ledger`; totals 5,896.65 / 2,205.53 = the three Mondays summed; 179 rows over the whole record, zero (fleet, day) pairs twice |
| B2 | cadence printed the literal "175 of 175" | **proven** — `942f255` | production prints "179 of 179", counted from both books on every request |
| B3 | no word when a Monday behind Bolt's next payout date had no payout | **proven** — `942f255`, `8f390b5` | Bolt's balance and next payout (2026-09-28) shown per fleet; with the 21st stored the warning list is empty |
| B4 | **every ledger write failed on production**: a JS array bound to JSONB (`payout_lines`), which PGlite accepted and node-postgres sends as an array literal | **proven** — `8f390b5` | first run at `942f255` logged "invalid input syntax for type json" for both fleets; at `d8b77f3` the rows landed at 06:10 UTC. Test runs the row through `pg`'s own `prepareValue`; the revert fails it |
| B5 | that failure was reported as "payouts ecosine" and the page told the operator no payout was "in either of Bolt's books … check the bank statement" — a reason that was not the true one | **proven** — `8f390b5` | the store failure is now named "balance … read but not stored"; the warning consults the stored ledger day and names a collection gap as one. Reverts fail 1 each |
| B6 | the next payout date printed "Mon Sep 28" (raw DATE through `String()`) | **proven** — `8f390b5` | production returns `2026-09-28` |
| B7 | "first seen" must keep the first insert while each run re-reads the day | **proven** | run at 06:27 UTC: `checked_at` moved 06:10 → 06:27, `collected_at` of both 21 Sep rows held at 06:10 |
| B8 | reconcile panel titled "Uber's wire" over Bolt rows; its no-comparison notes printed "(Bolt)" twice with no fleet | **proven** — `cc34a21`, deployment `667a1604` | production renders "Each wire against our own figure" and "(Bolt · Ecosine)" 91 / "(Bolt · Egari)" 88 / "(Uber · Egari)" 45 / "(Uber · Ecosine)" 44 |

B4 is the one to remember: the whole suite was green over a write production
could not do, because every test runs on PGlite. COVERAGE.md carries it as a
trap. Not done here: the Ecosine FI roster entitlement (`142868`
COMPANIES_NOT_ALLOWED) is unchanged and is Bolt's to grant, not ours to fix.

## The credential banner after a Settings save — 2026-09-23

The operator saved a new `UBER_WEB_COOKIE_EGARI` at 08:30:22Z and asked why the
banner still showed it as stopped. The saved cookie worked: production's paste
check passed the same capture at 08:40:51Z, and a report request made with the
stored value answered "accepted" at 08:41:07Z. The red row came from a collector
run that had loaded its settings at 08:30:00Z. It asked Uber with the old cookie
and recorded the refusal at 08:31:28Z, a minute after the save. The operator's
ruling on the fix: re-check "when settings refresh only", never on a page view.

| # | what | state | proof |
|---|---|---|---|
| S1 | an observation about a replaced value was written as the current state | **written** | `noteCredential` writes only when the version the process holds is the one stored now (`schema_v82` `value_version`). The replay of the day's sequence in `test/credential_save_check.test.mjs` §2 fails 3 when the guard is reverted |
| S2 | nothing tested a value saved through the per-key field until the next run | **written** | `PUT /api/settings` → `recordSaved` → `checkStored`, once per fleet the check depends on. The revert fails 3 |
| S3 | the paste box's Apply did not touch the banner rows | **written** | Apply records the verdicts it already had, with no second Uber report. The revert fails 3 |
| S4 | a row about a replaced value, from before S1 or a save S2 did not reach, was shown as current | **written** | `/api/auth` scores it `pending` with `superseded: true` and keeps the old words under `observed_*`. The revert fails 6 |
| S5 | the banner redraw after a save was served from a cache (server: version keys on runs and rollups only; browser: SWR) | **written** | `/api/auth` is on both never-cache lists. Reverts fail 1 each (`cache.test`, `credential_save_check` §8) |
| S6 | Apply did not redraw the banner; nothing drew "saved, not tested" | **written** | `test/auth_banner_pending_ui.test.mjs` in Chromium: quiet tone, counted per credential, "saved 12:30", red kept for a real refusal. Reverts fail 3 and a timeout |

### What an independent review of the first commit (`a988eb1`) found

The suite was green on `a988eb1`: 301 files, 9,492 assertions. A reviewer then
read the diff against the collector's real concurrency and found that S1 did
not close the incident it was written for. All of the following were fixed
before anything deployed, and each is proved by reverting it (17 reverts, each
failing its test; the first 10 re-run against the new code, all failing too).

| # | what | state | proof |
|---|---|---|---|
| S7 | **S1 read the version at note time from the SHARED cache**, while `uber.collect` holds its cookie for the whole pass and `liveStatusTick` refreshes that cache every 120s. The old cookie's refusal was still filed under the new version whenever a tick landed in the 88s gap | **written** | `withPinnedSettings`: each source in a run, and each tick, reads values and versions from one AsyncLocalStorage snapshot. §13 replays the save plus a mid-run refresh; the reverts of `get`, `settingVersion` and the run-loop pin fail 1 each |
| S8 | a save of the unsuffixed `BOLT_REFRESH_TOKEN` would have overwritten `BOLT_REFRESH_TOKEN_<FLEET>`, the token the collector uses: `checkBolt` names the per-fleet key on every pass | **written** | a successor is carried only if it differs, and only under the key tested. Reverts fail 2 and 1 |
| S9 | a passing save repainted `moved`/`blocked` rows as accepted, hiding real faults until the surface next ran | **written** | kept and re-stamped. The revert fails 3 |
| S10 | a check's verdict answers "should this be stored?", not "is this credential good?": the Yango symmetric refusal (not about the cookie) went red, and the asymmetric one (session read) went amber while the collector says ok | **written** | `stateOf()` by what was established. `checkYango` says `blames` / `authenticates`; the stand-in portal in §11. Reverts fail 5, 5 and 2 |
| S11 | the Uber OAuth token cache was keyed on the client id alone, so a replaced secret went unused for the old grant's 30 days | **written** | keyed on id plus a secret digest; the stand-in token server in §11. The revert fails 1 |
| S12 | S4's time comparison for unversioned rows would, at deploy, have made the weekly profile rows pending for a week over a working cookie | **written** | unversioned rows are taken at their word. The revert fails 1 |
| S13 | CABMAN rows said `CABMAN_PASSWORD`, which is no Settings key (it is `CABMAN_ECOSINE_PASS`); a save could never reach them | **written** | named by the real key; `schema_v82` drops the old rows; §12 checks every banner credential name against the Settings catalogue. The revert fails 1 |
| S14 | the paste box could file a refused duplicate's verdict; a cleared key was tested against the API's own environment and called "nothing configured" | **written** | verdicts from admitted candidates only; a cleared key is recorded, not tested. Reverts fail 1 and 3 |

### On production — deployment `1c20e231` (commit `13731f6`), ACTIVE 09:42:03Z

Re-measured after the deploy, by the same reads that found the fault:

- **S1/S7 proven on real Postgres.** The collector's first observations after
  the restart landed at 09:42:32Z (`UBER_WEB_COOKIE`) and 09:42:34Z
  (`UBER_WEB_COOKIE_EGARI`). Both keys are stored on the Settings page, so the
  version guard compared a loaded version with the stored one and accepted
  them. A precision or type mismatch would have frozen those rows instead.
- **S12 proven.** `/api/auth` answered `pending: 0` with `superseded: false` on
  all 26 rows, so the deploy made no week-long pending lines.
- **S13 proven.** A `CABMAN_ECOSINE_PASS` row was written at 09:41:11Z, and
  `CABMAN_PASSWORD` is gone, so schema_v82 ran.
- **S5 proven.** Two identical GETs of `/api/auth` carried no `x-cache`, so the
  cache skips it.
- The banner rendered through bin/prod-mirror.mjs at 1440 and 390 wide showed
  the three standing rows (Bolt Ecosine FI entitlement, Bolt Ecosine token,
  Yango console) and not the Egari cookie.
- **S2, S3, S6, S8, S10, S11, S14 are deployed, not yet proven.** They act on a
  Settings save, and nobody here saves a credential on the operator's behalf.
  The first real save proves them: its banner rows should read "accepted when
  saved" (or "refused when saved") within the save's own response.

Not done, and named: inside the collector, a value saved while a source is
running is used from that source's next pass. The pin is retaken between
sources, so a save made mid-run now reaches the later sources in the same run,
which it did not before.

## The HR roster export: import, #hr-roster, HR's licence date first — 2026-09-23, NOT ON PRODUCTION

The operator's HR system exports `active-drivers-YYYY-MM-DD.xlsx`. Nothing
could read it, and the product held no source at all for passport, Emirates
ID, visa or RTA-permit expiry. Its only licence expiries came from Yango, and
`/api/compliance/drivers` said 88 people could not legally drive on Yango's
dates alone. What the file holds, and the dry run of the real file, are in
docs/COVERAGE.md ("The operator's HR roster export").

The operator's decisions, each built as stated. The document numbers are
stored. Passport and RTA-permit numbers are returned by no route. The Emirates
ID and the UAE licence number are returned only by `/api/driver/profile`, and
the driver page shows them. The visa number is not stored. Expiry dates are
visible to everyone. HR's licence date wins, and Yango's is kept beside it as a
disagreement. Only this exact export is accepted. Import is an admin-gated
preview, then a commit. Rows match by platform id, then by phone, never by
name. HR's groupings become proposals on the same-person queue under basis
`hr_roster`, never merges.

| # | what | state | proof |
|---|---|---|---|
| H1 | only this export: sheet `Drivers`, the 44 headings in order; anything else refused with what differs | **written** | `test/hr_roster_format.test.mjs` 63. Reverts: reorder check fails 2, rename sentence fails 1, second-sheet check fails 2 |
| H2 | preview writes nothing; commit writes one immutable snapshot (sha256, export date from the filename or entered, who); both admin-gated | **written** | `test/hr_roster_import.test.mjs` 88. Removing the gate fails 1; a preview that commits fails 34 |
| H3 | the same file twice is refused | **written** | without the check the UNIQUE constraint answers a 500: fails 3 |
| H4 | a newer export: "off the HR list since", a blanked column reported with the earlier value kept, renewals shown, nothing deleted | **written** | reverts fail 1 (off-list) and 1 (carry-forward) |
| H5 | matched by platform id, then phone, never by name | **written** | a name fallback fails 1 (same name, other phone); phone beside an id match fails 1 |
| H6 | HR groupings are proposals on #same-person (basis `hr_roster`, their own table), and a verdict folds nothing | **written** | writing them to `driver_identity_link` fails 6; a verdict that writes a link fails 1 |
| H7 | a contradiction with a link already held surfaces in the preview AND in the queue | **written** | the refused-partner shape: revert fails 5; the real export's shape (a link HR splits, touching a refused pair, stamped with no reviewer): revert fails 1 |
| H8 | every JSONB value valid on node-postgres's wire, not only PGlite's | **written** | through `pg/lib/utils` `prepareValue`; binding the array unstringified fails 2 |
| H9 | no route returns a passport or RTA number; the Emirates ID and licence number only on `/api/driver/profile` | **written** | `test/hr_roster_numbers.test.mjs` 19, by value over every declared GET route, the raw-values sampler (10 keys × 5 tables), the CSV export, both write routes and the admin compliance body. A passport number put on the roster row fails 3, an Emirates ID there fails 3, the profile without them fails 2 |
| H10 | the visa number is not stored; an Emirates ID is its digits however written | **written** | storing it fails 3; keeping the dashes fails 3 |
| H11 | `/api/compliance/drivers` counts HR's licence date first and keeps Yango's as a disagreement; HR's document expiries on each person; an HR-only person is not an "unplaced account" | **written** | `test/hr_compliance.test.mjs` 19 (expired 1 → 0 on HR's date). Leading with the platform's date fails 3 |
| H12 | `#hr-roster` (People), and the HR parts of #compliance, #same-person and #driver, render in Chromium | **written** | `test/hr_roster_page.test.mjs` 52 against the mock: the roster, both filters, preview then commit, a refused file, phone width. Unregistering the view fails |
| H13 | the mock carries every HR shape the real routes return | **written** | `test/mockapi.test.mjs` green; row-level HR parity in `hr_roster_numbers` (a real HR upload there), 4 assertions |

Existing suites touched and green: `server_redaction` 56 (its own slice of the
compliance route needed `hrForCompliance` injected: see the COVERAGE trap on
two injection sets), `compliance_person` 50, `route_smoke` 59, `mockapi` 10,
`nav_sections` 17, the same-person and identity suites.

**The full suite ran once, as instructed:** 306 files, 9,776 assertions,
1 file failing. That file was `interlinking`: "a hand-rolled entity link guards
against a missing id", triggered by the account pills in
`api/public/hrroster.js`. The pill now degrades to text without an id. After
the fix, that file (11) and `hr_roster_page` (52) were re-run and are green.
The full suite was not run a second time.

**The dry run of the real file** used a local PGlite seeded from production's
public reads, and ran through the real routes. 143 rows. Matched by platform id
112, by phone 22, not matched 9. 20 proposals, 1 contradiction. 39 licence dates
differ from Yango's, 37 of them older by over a year. People with an expired
licence went from 88 to 50. Checked by value, no response carried a document
number, apart from the two numbers the driver page is meant to show. Full
figures are in COVERAGE.

### NOT PROVEN, and named

- **Not deployed.** `schema_v83` has run on PGlite only. To prove it on
  production: upload the export on `#hr-roster` with the admin token. Then
  `/api/hr-roster` should read 143 on the list. `/api/compliance/drivers`
  `people_totals.expired` should fall from 88 to about 50, with
  `licence_from_hr` and `licence_disagreements` set. `/api/same-person` should
  show 20 HR proposals and 1 contradiction. `/api/driver/profile` for a matched
  driver should carry `hr.emirates_id`. Take screenshots with every modal
  filled.
- **The Emirates ID and licence number reach any caller of
  `/api/driver/profile`.** The operator decided this, and the product has no
  sign-in. It is a deliberate, narrow exception to Batch 1. Making it
  admin-only is one `isAdmin(req)` check in the profile route.
- **A "Yes" on an HR proposal folds nobody.** It is recorded on
  `hr_roster_proposal`, and nothing promotes it: `bin/promote-links.mjs` reads
  `driver_identity_link` only. The page and the verdict's effect sentence both
  say so.
- **`/api/driver/profile` is response-cached.** Its `hr` block shows a new
  upload after the next collection run. `/api/hr-roster` and the compliance
  route are uncached.
- **One employee can attach to two person rows.** An HR row matched to accounts
  the spine keeps apart puts HR's documents on both rows (155 rows from 134
  matched employees on the dry run). It is flagged by `hr.employees` and by
  the proposal.
- **The payroll bridge is recorded, not used.** `hr_roster_row.matched_accounts`
  holds the accounts each row matched. The `hr_employee_account` view explodes
  it for the latest export as (fleet, employee_id) ↔ (platform, ext_id). The
  salary import that would join on it is not built.

## FMS seat data — 2026-09-23

| # | what | state | proof |
|---|---|---|---|
| F1 | FMS's live `Seatcount` collected (GetVehicleCurrentDetails, vehicleno=ALL) into `telemetry_snapshot.seat_count`, schema_v84 | **proven** — `e98d5f4`, deployment `9f6ec597` (ACTIVE 12:32Z) | at 12:37Z, 66 Uber-active cars (Ecosine 42, Egari 24) had an FMS seat reading ≤10 min old, the same 66 that had a live FMS fix ≤10 min old; per-trip counts lag ≥27 min, so these can only be the live count. The FMS seat column rose from 68 to 75 receiving, equal to FMS data. | test/fms_seat_count.test.mjs (16). Reverts fail: "0 is a reading" 2, "refusal off the banner" 1, "vehicleno=ALL" 1, "rows carry the count" 1, "probe params" 1. Proven only when the first real poll after the deploy stores a count |
| F2 | The Fleet tab's FMS seat column reads the live count as well as the per-journey count | **proven** — same deployment | test/vehicle_feeds.test.mjs (51); reverting the live half fails 2 |
| F3 | The nightly probe called GetVehicleCurrentDetails without vehicleno and reported "Authentication failed" | **written** | test/fms_seat_count.test.mjs; proven when the next probe run shows fields rather than an error |
| F4 | FMS is a second seat-sensor provider in unauthorized-trip detection: `occupancy_segment.source` (`cabman` / `fms_live` / `fms_trip`) in the key, schema_v85; FMS live segments through the same classifier (1+ occupied, in memory); each FMS journey with a Seat Count is a segment (`classifyJourney`: stationary / sensor_suspect over 8 h / never partial); writes per (source, plate); clock skew per provider; FMS never authorizes | **proven** — `008f48e`, deployment `89154e9` (ACTIVE 15:13:59Z) | test/occupancy_sources.test.mjs (95). Reverts fail, one per guard: migration key 3, 1+ occupied 3, journey average speed 2, eight hours 2, overlapping journeys one ride 4, FMS never authorizes 3, delete per source 3, sweep per source 2, skew per provider 1 |
| F5 | FMS journeys: overlapping records on one car (FMS's provisional + final record of one ride, measured — docs/COVERAGE.md trap) are one segment, built from the record first stored last | **proven** — `008f48e`, deployment `89154e9` (ACTIVE 15:13:59Z) | same file; the grouping revert fails 4. On production: 0 overlapping FMS-trip pairs on one plate among the 500 newest segments |
| F6 | Combined totals count a ride once across providers (`occCountsOnce`, same verdict, order FMS trip → CABMAN → FMS live), with per-provider figures and the rule on #unauthorized, #segments, the driver tab, the vehicle page, the day and cohort readers and the phone; rows carry `counts_once` | **proven** — `008f48e`, deployment `89154e9` (ACTIVE 15:13:59Z) | same file. Reverts fail: rule off 10, same-verdict 6, stuck-pad bound 1, rows without counts_once 1 |
| F7 | Sensor health per provider: CABMAN unchanged; FMS live dead = count on fixes + bookings + never 1; FMS trip dead = live fixes + bookings + no journey with a seat count; each row states its reason | **on production, not separately checked** — same deployment | same file. Reverts fail: live needs bookings 1, trip needs bookings 1, CABMAN suspect is CABMAN only 1 |
| F8 | Wording: every "only CABMAN carries a seat sensor" / "no seat sensor for Egari" sentence replaced on the routes, #unauthorized, #segments, #segment, #live, #map, driver, vehicle, day, cohort, trip, phone screens, insights and docs; /api/live and /api/map/journey read FMS's live count and name the provider | **proven** — `008f48e`, deployment `89154e9` (ACTIVE 15:13:59Z) | same file (wording 3 blocks). Reverts fail: coverage wording 2, page wording 1, live seat reading 1, passenger km not added 1, CABMAN over Egari 1, segment by provider 1 |
| F9 | Booking matching through a per-plate time index (`findMatchIndexed`) — identical answers to `findMatch`, ~0.5 s instead of 100–340 s of synchronous work for a twelve-month pass at production volume | **on production** — same deployment; its time not measured on production | same file: 2,100 random segments, 0 differ. Reverts fail: tie order 1, overlap order 1, scan bound 1. Local PGlite, synthetic, production volume: the whole twelve-month reconcile 17–19 s (journeys read 2.3 s, bookings 4.6 s, match ~0.7 s, write 130,722 rows 9.4 s) |

### NOT PROVEN, and named

- **On production, 2026-09-23.** Deployment `89154e9` (commit `008f48e`) went
  ACTIVE at 15:13:59Z. Before any FMS row existed, the migration had tagged every
  old segment `cabman`. At 15:14Z the 30-day figures were 2,928 segments, 136
  unauthorized and 2,936 km, exactly the pre-deploy baseline. The boot pass then
  added one new CABMAN ride, making 2,929. The FMS providers showed ABSENT
  with their reason, not 0. The boot pass wrote the first FMS segments by
  15:18Z. For 2026-09-20..23:
  - CABMAN DT: 383 segments, 13 unauthorized
  - FMS live: 103 segments, 1 unauthorized
  - FMS trip: 1,490 segments, 104 unauthorized
  - combined: 1,924 segments, 117 unauthorized. 52 rides were seen by two
    providers and are counted once.
  - Egari: 65 unauthorized, all from FMS. Before this it had no seat evidence.
  - `matched_platform = 'fms'`: 0, so FMS never matches itself.
  - Rows missing a source or a start: 0.
  - Both dual-tracker cars keep every provider's segments with their own
    times. On L44251 at 14:13, the FMS live segment folds into the FMS trip
    segment of the same ride.
  - The 104 FMS-trip flags are not near-misses. 2 have a booking within 15 min;
    most are hours from any booking. Median 6.4 km and 16.5 min, over 28
    plates. L64172 has 16 and L65945 has 11.
  - Screens through bin/prod-mirror.mjs (assets byte-identical), at 1440 and
    390 wide. #unauthorized is ready in 2.1 s and shows the "By seat-sensor
    provider" table and the count-once rule. #segments is ready in 5.2 s and
    names the provider and fleet on each row.
  - Still to come: the nightly 21:00Z catch-up fills 30 days, and Sunday's
    22:00Z backfill fills `BACKFILL_MONTHS`. Until then, an FMS-trip figure
    covers only the days it names.
- **The reconcile time on production** is estimated from PGlite, not measured:
  17–19 s locally for the twelve-month pass. Production's `basic-xxs` and
  managed Postgres may differ either way.
- **Page cost.** Locally, at ~1,400 unexplained segments in 30 days (the FMS
  scale) against ~130 (CABMAN today): `/api/unauthorized/attributed` 0.57 →
  0.95 s, `/api/driver/unauthorized` 0.58 → 2.1 s. Summary and segments stay
  under 0.1 s. Re-measure on production after the first backfill.
- **FMS live thresholds** were not changed; the live seat count has less than a
  day of history. Re-read the stored gaps once it has a week.
- **The CABMAN device on L44251 and L45243** may be filed under the wrong plate
  (docs/COVERAGE.md); both providers' segments are kept as ruled, and their
  overlapping segments count once in combined totals.

### HR roster — on production 2026-09-23

- **Deployed and committed.** Deployment `77abc6b4` (commit `9717fd7`, ACTIVE at 12:16Z). The production preview of the operator's file matched the local dry run exactly: 143 rows, 112 matched by platform id, 22 by phone, 9 unmatched, 20 proposals, 1 contradiction, and no document number in the response. Committed at 12:24Z as upload 1.
- **Compliance.** `/api/compliance/drivers` now counts 50 expired licences, down from 88. 152 people are valid on HR's date, and 41 show a disagreement with the platform's date.
- **Same-person queue.** `/api/same-person` carries the HR proposals and 1 contradiction.

## Arkiv reskin, STEP 0 — one colour source, no visual change — 2026-09-23, NOT ON PRODUCTION

Branch `reskin-foundation`. The plan is `docs/UI-REDESIGN-PLAN.md` §3 ("Colour
tokens", "Order of work" STEP 0, and the review's "Also required"). Not
deployed, not pushed, and the default skin is not flipped, by instruction.

| # | what | state | proof |
|---|---|---|---|
| T1 | `api/public/tokens.js`: the design's tokens.mjs ported, values untouched, plus `cssDeclarations()`, `bridgeDeclarations()` and a `BRIDGE` map | **written** | `test/tokens.test.mjs` §1: `lintTokens()` is `[]`, 43 hexes, and `cssTokens()` hashes to `b46907d2…`, the md5 of the one `:root` block all 65 mockups carry. Changing Bolt's hex in tokens.js fails 5 |
| T2 | `bin/gen-tokens-css.mjs` writes those values into app.css between `BEGIN/END GENERATED TOKENS`, under `:root[data-skin="arkiv"]`, after the old dark blocks | **written** | §2–3: a hand-edited hex in the block fails 2; a generator that writes a bare `:root` fails 1. `--check` mode for CI |
| T3 | The `--ink-2` collision. Old `--ink-3` → `--grey` (the plan's step 1). Old `--ink-2` → `--grey-strong`, which Arkiv folds onto `--grey` through `BRIDGE`. Then `--ink-2` is declared as Arkiv's `#2E2E31`, under the skin only. Covers 67 + 86 uses in app.css, 7 + 14 in m.css, 4 `var(--ink-2)` and 10 `var(--ink-3)` in JS, 11 bare `'--ink-3'` arguments, and m/screens.js's `'ink-3'` | **written** | §4. The old values are pinned in all three theme states. A `var(--ink-3)` put back in m.css fails 2. A `var(--ink-2)` in driver.js fails 1. Moving the light `--grey` value fails 1. Dropping `--grey-strong` from the dark block fails 1 |
| T4 | `SOURCE_TOKEN` names `--c-*`, built from `CHANNEL_ORDER`. The old `:root` aliases each `--c-*` to its `--ch-*`. `.sw` and `.domb-seg` fill with `--c-*`. `dominantBar` strips `--c-` as well as `--ch-` | **written** | §5. `SOURCE_TOKEN` back on `--ch-*` fails 6. A missing alias fails 1. The old strip (`/^--ch-/`) fails 1, because it turned `--c-uber` into the class `ch---c-uber`, which no rule matches |
| T5 | **Live defect:** `--card`, `--line`, `--sunken`, `--muted` and `--bad` were used by 24 rules of the money form (9 in app.css, 15 in m.css) and declared nowhere. The inputs, the amount field and the chips drew with no border and no ground. They are now aliases of the tokens the rest of the sheet uses for the same jobs | **written** | §6 checks that every `var()` and every token string in app.css, m.css and the JS resolves to a declaration (95 names). Deleting the five aliases fails 6. Screenshots of #deposits at 1440, light, `before-dep/` and `after-dep/`: the inputs gain their border |
| T6 | Literal whites. `.depchip.on` and the phone's `.m-btn.primary` now use `--on-accent`: white measured 2.94:1 on the dark accent. The plan named `--paper`, but that would have turned light-mode white into linen `#f4f2ed`. The map pin ring (map.js) and the pickup ring (driver.js) use `css('--paper')` | **written** | §7. `#fff` put back on the chip fails 2, and on the pin fails 2. **This one is visible in the old skin:** in dark mode the pin ring is now `#14171a`, not white, on the always-light OSM tiles. In light mode it is `#f4f2ed`, not `#fff` |
| T7 | `sw.js` `SHELL_FILES` gains `/tokens.js`, plus **three modules the phone has imported for a long time and the list never had**: `/deposit_core.js`, `/today.js` and `/onlinetime.js`. Without them a cold offline open fails `m/screens.js`'s import, and with it every screen | **written** | §8 walks the static imports from `/m/app.js` (13 modules). With `/tokens.js` removed, it fails 2. With the three removed (the state before this commit), it fails 1 |

**Pixel identity of the old look.** `#overview`, `#drivers` and `#settings`
were shot at 1440×900 and 390×844, light and dark, on the desktop build and
the phone build: 18 shots from the HEAD tree (`git archive` e98d5f4, served on
:8101) and 18 from the working tree (live-ui on :8100). To make any difference
a front-end one, every `/api/` response came from one recorded fixture (a miss
was fetched once from production through live-ui), the clock was frozen at
2026-09-23T08:00Z, sticky elements were pinned in flow, and the caret was
hidden. Two runs of the UNCHANGED tree were compared first, to measure the
noise: 3 files differed. Two were phone shots with a channel difference of at
most 2, in one text row. One was a 390 dark shot with a difference of at most
39, at the textarea's resize corner. Result: **every after shot is
pixel-identical to at least one of the two before runs.** Against the first
run, 17 of 18 match exactly. The 18th differs by 32 pixels, of at most 2
levels, in the same noisy row, and is byte-identical to the second run.
Harness and shots: scratchpad `reskin/step0/` (`shoot.mjs`, `cmp.py`,
`shots/before|before2|after`).

**Under the attribute** (`skinprobe.mjs`), the resolved values are Arkiv's in
every theme state. With the OS light or dark, and theme system, light or dark,
`--paper` is #ffffff, `--grey` and `--grey-strong` are #6d6d72, and `--c-uber`
is #2362d3. Without the attribute they are the old values in all six states.

Suites run, all green: tokens 83, type_scale 9, today_band 38, routes 65,
phone 140, nav_sections 17, assets 40, driver_standing 37, formatters 34,
kpi_one_tile 20, fold_rows 8, phone_clock 12, timezone 19, consistency 67,
interlinking 11, cohorts 74, export_csv 31, fare_reason_shared 8,
driver_money_tiles 82, deposit_ui 43, online_time 74, signed 14,
platform_share_once 8, chart_fit 27, chart_geometry 17, kpi_pill 10,
pinned_identity 72, sticky_header 9, settings_page_layout 20,
capacity_headline 22, driver_photo 39, uber_profile 41, payout_mobile 39,
phone_today_only 19, absent_columns 25, spacing 2 (125 routes), calendar_range
22, calendar_window 82, charging_page 30, driver_empty_window_page 63,
driver_money_tab 56, driver_reconcile 35, dubai_day_window 25,
endpoint_coverage 4, money_contradictions 49, person_address 32,
today_trip_breakdown 28, unauthorized_attribution 221,
unauthorized_attribution_page 26, unit_ranking_gate 10, phone_render 8,
audit_tools_detect 27. The browser suites used a private mock on :8497. The
full suite was not run: this step's instructions say not to.

### NOT DONE in STEP 0, and named

- **No dark Arkiv values yet** (ruling 3). Under `data-skin="arkiv"` the
  light values win in dark mode too. That is deliberate: two colour laws must
  never mix on one page. But the old dark `--surface`, `--rule` and so on still
  show through wherever arkiv.css has not re-pointed them. The dark set, with
  its contrast and CVD validation, belongs to its own step, before the flip.
- **`sourceToken(unknown)` still returns `null`**, not `'--grey'`. Every caller
  falls back to the categorical palette on null, so changing it now would
  repaint the old skin. STEP 2 changes it together with the chart callers.
- **The theme-color metas and the manifest** stay on the old paper and ink
  until the flip (STEP 5). They set the browser chrome on production.
- **The old-skin names Arkiv has not yet re-pointed** (`--surface*`, `--rule*`,
  `--accent*`, `--s1..--s8`, `--b100..--b700`, the severity set, and so on)
  are STEP 1's job, in arkiv.css. The generated block re-points only
  `--grey-strong`.

## Money precise to the fils — ruling 2, both skins — 2026-09-23, NOT ON PRODUCTION

Branch `reskin-foundation`. The operator ruled that every money figure is
printed to the fils (AED 1,275.14) on every page, tile, table and chart label,
in both skins (`docs/UI-REDESIGN-PLAN.md` §1, ruling 2). This is the one change
on the branch that is not behind the skin switch. Not deployed, not pushed.

| # | what | state | proof |
|---|---|---|---|
| P1 | `ui.js` `money()`: always two decimals, separators, U+2212 before the currency, and '—' for absent. The third argument (`d`, default 0) is gone. A caller that still passes `'AED', 0` gets the fils anyway. `fils()` is the same figure without the currency | **written** | `test/money_precise.test.mjs` §1. Putting back 0 decimals fails 4 checks ("AED 1,234"). Honouring a third argument again fails 1 |
| P2 | Hand-built renders routed through `money()`: `'AED ' + fmt(x)`, `AED ${fmt(x, 0)}` and `AED ${fmt(Math.round(x))}`, in app.js (overview tiles and verdict, #finance's excluded payout, #insights' tiles and impact, #unauthorized's forgone), causes, optimise, provenance (4), reconcile, trips, segments (7), driver (3), playbook (2) and today.js. `today.js` halves print through `fils()`, and the wired note through `money()`. Money charts that printed a bare `fmt()` now print `money()`: #vehicle/earnings (2) and #unit's scatter | **written** | §3 scans every page. Restoring `'AED ' + fmt(k.revenue)` fails 1 and names the line. §3's chart scan: dropping `valueFmt` from vehicle.js's fares chart fails 1, and dropping `yFmt` from economics' scatter fails 1 |
| P3 | `deposit_core.js` `aed()` is `money()`. It had its own locale ('en-AE') and its own minus ("AED -600.00"). Absent is still `null` | **written** | §2 parity. The old formatter fails 2. `driver_money_tab`'s repayment check now reads "−AED 1,000.00" |
| P4 | **The API sent whole dirhams.** 34 SQL roundings to 0 on revenue, payout, money, amount, earnings and impact now round to 2: server.js 13, driver_routes 8, segment_routes (/api/slot) 5, playbook_routes 4, vehicle_routes 3 and forecast_routes 1. So do the JS `round(v, 0)` calls on money: analytics 27, day 8, roster 2 and economics 1. The playbook's `aed_measured` and `aed_modelled` were `Math.round`ed, and are now rounded to the fils. Without this, a page could only print ".00" behind a figure whose fils had been thrown away | **written** | §4 scans `api/*.js`. Restoring `::numeric,0) revenue` in /api/kpis fails 1. Route tests (analytics_routes 164, aggregates 89, day_routes, route_smoke 59, …) are green |
| P5 | Server sentences go through `src/util.js` `aedText`. They are the ledger's "book moves from … to …" (was `toFixed(2)`, no separator), the playbook's "Chase AED … owed" (was `Math.round`), the idle-cost assumption, and two insight details. One of those had printed "At an average fare of 45.23" with no currency. `server.js` imports it, and `test/mount.mjs` injects it | **written** | §2 parity: `toFixed(2)` fails 1. `ledger_write` pins "AED 4,500.00", and the old sentence fails it. §4 pins the playbook title |
| P6 | **#charging** fell back to the literal `'AED 0.00'` when no charging row existed in the window. It now shows '—', with "no record, not a measured nought" | **written** | `charging_page` renders that window (route-stubbed). Putting the fallback back fails 1 |
| P7 | **#settlement/receivables** answered `total: 0` when receivable bookings existed and none was priced, so the page printed "Outstanding AED 0.00". It is now `null`. A nought stays only when there is no receivable booking at all | **written** | `receivables_ageing` gained 2 checks. `: 0` put back fails 1 |
| P8 | Phone: `m/ui.js` `row()` lets a sub-line wrap when the row's figure is over 11 characters. The longer figures had taken 5px from "settles Aug 31–Sep 6" on #payouts at 390px | **written** | `payout_mobile` failed 1 on the fils change and passes with the fix. Removing the line fails 1 again |

**Tests changed deliberately, each with a one-line why in the file:**
formatters (1), caption_matches_figure (2), driver_empty_window_page (3 values,
and the `MONEY_ZERO` guard plus 2 more nought guards WIDENED so they still see
money(0) = "AED 0.00". Reverting the cash tile to `money(0)` fails 3 again),
driver_money_tab (1), driver_money_tiles (8), ledger_write (1),
money_contradictions (8, plus its local `aed` helper), reconcile_headline (1),
today_band (1: `moneyHalves(t)`, no fmt), and vehicle_directory (its frozen
"before" query is the oracle for a rewrite, so its revenue column now keeps the
fils too, and every other column must still match). segment_routes pins the
forgone tile's source shape, so that expression kept its shape. insight_dates
pins `import { dubaiIso } from './util.js'` exactly, so `aedText` has its own
import line in src/insights.js.

**Suites run.** All 311 test files ran one at a time, in two sequential
batches. The runner was not concurrent, and the browser suites used a private
mock on :18099. 13 files failed during the run. One of them, charging_page, failed on the new check's own fixture shape. The other 12 are listed above.
Every one passes now, re-run after its edit. No other file failed. The step's
instruction was to run what the change touches, and a formatter that every
page calls touches nearly everything.

**Screenshots at 1440** (live-ui against production, working tree): #finance,
#payouts, #revenue, and a driver's Money tab. They are in the scratchpad at
`reskin/money/shots/`. There are no clipped tiles and no "AED n" without fils
on any of the four. Production still rounds in the API until this deploys, so
figures it rounded show ".00" (#finance "AED 135,718.00 was collected in
cash", the revenue-per-km sub "AED 923,165.00 over 204,024 km"). After deploy
they carry their real fils.

### Open, and named

- **For the operator: the ≈ estimate.** The Today strip's estimated trip
  value is rounded to the nearest 100 on purpose (today.js `roughly()`: "an
  estimate printed to the dirham claims a precision it does not have"), and it
  now prints as "≈ AED 36,500.00". Kept as it is. Either the estimate keeps
  its rounding and its ".00", or it prints the model's own fils beside the ≈.
  That is the operator's call.
- **Left for the unauthorized-trips branch, to merge cleanly:** four server
  basis sentences print `AED ${rate}/km` from `Number(rate)`, so a 3.10 rate
  reads "AED 3.1/km". They are in server.js (2, in the unauthorized block),
  unauthorized_routes.js:193 and segment_routes.js:307. And driver.js (5 call
  sites) and m/screens.js:572 still pass an inert `'AED', 0` to `money()`. It
  prints the fils regardless. Tidy both after the merge.
- Insight rows already stored keep the detail text they were written with
  until the rule next rewrites them.

## Arkiv reskin, STEP 1 — the skin switch and the component restyle — 2026-09-23, NOT ON PRODUCTION

Branch `reskin-foundation`. The plan is `docs/UI-REDESIGN-PLAN.md` §3 (Order of
work STEP 1, Typography, Components, "Review corrections" and "Also required")
and the operator's rulings in §1. Not deployed, not pushed. The default skin is
not flipped, so production keeps its look. A reader sees Arkiv only after
opening `?skin=arkiv`.

| # | what | state | proof |
|---|---|---|---|
| K1 | **The switch.** `?skin=arkiv` / `?skin=classic` / `?skin=auto`, stored as `fleet.skin`. index.html's pre-paint script stamps `<html data-skin="arkiv">`, and the URL's word wins even where storage is refused. A second inline script `document.write`s `<link href="/arkiv.css">` directly after app.css, so the parser inserts it: it blocks the first paint and wins ties by order. A page on the old skin never requests the file | **written** | `test/arkiv_skin.test.mjs` §3. With the write removed, 46 checks fail. With the link placed before app.css, 7 fail, including the old DARK `--surface` (#1c2024) showing through under OS dark. With `appendChild` instead of `document.write`, 4 fail, including `renderBlockingStatus` = `non-blocking` |
| K2 | `sw.js` `SHELL_FILES` gains `/arkiv.css`, so a phone switched to the skin still has it on a cold offline open | **written** | §3. With it removed, 1 fails |
| K3 | **The token values.** arkiv.css's `:root[data-skin="arkiv"]` re-points every old-skin colour name onto an Arkiv token with `var()`: surfaces → paper/paper-2/faint, rules → hair/grey-2, the accent → ink, severity → the two semantics (no amber: `--warn`/`--serious` → `--sem-neg`), `--b100..--b700` → the steps `sequentialOf(i/6)` picks, `--s1..--s8` → distinct neutral steps (the review's correction, not ink), radii → 0, shadows → none, and `color-scheme:light` | **written** | §2 finds all 49 names the old skin paints with a hex. It fails on any that is not generated or re-pointed, and it resolves 41 in a browser in three theme states (OS light, OS dark, theme dark), each to an Arkiv token value. With `--warn` not re-pointed, 5 fail: old amber #7d5b05 in light and #d0a553 in dark. With `color-scheme:light` dropped, 3 fail |
| K4 | **No hex, and every rule scoped.** arkiv.css has no hex, no `rgb()` and no named colour, and all 391 selectors start with `:root[data-skin="arkiv"]` | **written** | §1. A hex added fails 1. One rule unscoped fails 1. tokens.test §6 now resolves arkiv.css's `var()`s too: `var(--ink-3)` put in fails 1 there |
| K5 | **Typography.** Plex Mono for labels, controls, table figures and headings of sections; Karla for prose, titles, names and tile values (proportional figures); Fraunces on the wordmark only. Body `--t7` → `--t6` (desktop only; the phone keeps m.css's size). Every size is a scale step; the one new step `--d6` (3.15rem, the hero tile) is declared in app.css's scale and used by `.kpi.is-hero .n`, which STEP 3's `glanceTile()` will emit | **written** | type_scale now scans arkiv.css: taking it out of the scan fails 1 ("--d6 unused"). §1 checks no literal size. §5 checks the faces in a browser |
| K6 | **Every component, restyled in place (no DOM change):** panel (a ruled section, 1.5px ink rule, mono title numbered by a CSS counter), g2/g3/g23 hairline column rules, kpi tiles (hairline rules, clipped first column, ink digits), tables (mono heading over an ink rule, no zebra, mono figures, separate borders), pills/tags/chips (3px, wash + dot + ink text, absence outline for `.dim`), notes, verdict band, tabs and the section strip, buttons and inputs, the credential banner, the today strip, the range panel, the rail and title block, plus links, fold, export line, skeleton, empty, modal, tooltip, identity card and avatar, rows that were cards, settings groups, the deposit form | **written** | §4: no module reads the skin (a module reading `dataset.skin` fails 1), and panel, tiles, notes, pills, verdict, table, tabs, buttons and the dominance bar render byte-identical markup under both skins. §5 measures each component in a browser |
| K7 | **Ruling 1, one rule everywhere:** a HOLLOW negative dot is a warning, a SOLID one critical, a solid green one good. Each dot has a screen-reader word (`content:"" / "warning: "`). Used by tiles, pills, tags, chips, notes, verdict band, banner, table verdict cells and #freshness | **written** | §5. The warning dot drawn solid fails 6. The toned digits left coloured fail 1. The banner, from the real `authBanner()` with a stubbed `/api/auth`: stopped (wash, 3px rule, solid dot), at-risk (paper, 3px rule, hollow), pending (sunken, grey, never red) |
| K8 | **The review's correction:** err and warn notes keep INK text as well as the dot | **written** | §5. Put back to grey, it fails 1 |
| K9 | **Namespace, don't paste.** b.css and viz.css are not imported, and `.cap` stays a grey Karla sentence | **written** | §1 and §5. A `.cap` in mono capitals fails 2 |
| K10 | Collapsed borders + a sticky first column lost every other row rule on #hr-roster at 1440 (122.95px rows); the old skin's zebra stripes had hidden it. Under the skin tables use `border-collapse:separate; border-spacing:0` | **written** | §5. Collapsed again, it fails 1 |
| K11 | The dominance bar keeps its labels INSIDE the segments (rule 1: the leader's share is printed nowhere else), in paper or ink per fill, named per class because the old dark rules name them at (0,4,0). This deviates from the plan's "labels move into .domb-keys" | **written** | §5 measures all 12 fills (six channels, six neutral slots) at ≥ 4.5:1. Bolt, Hotel and FMS given paper text fail 1 (3.38–3.42:1) |
| K12 | A verdict cell's dot is a background layer, so it moves no digit and takes no pseudo-element (phone cards use `::before` for the label). The first cut lost it on every EVEN card at 390px: app.css clears those with a `background:none` shorthand at (0,3,4) | **written** | §6 renders a 4-row card table at 390px. Without the row-path selector, it fails 1 |
| K13 | #freshness writes "N sources need attention" with an INLINE `color:var(--warn)`, which is red words and no glyph under the skin. arkiv.css outranks it (one of the file's two `!important`s — only that beats an inline style) and gives it a hollow dot | **written** | §5 with a stubbed `/api/status`. Removed, it fails 1 |
| K13b | #unit's car map bleeds into the card padding with an INLINE `margin:0 -18px` (economics.js). A ruled panel has no padding, so under the skin the map stuck out 18px on each side: render-audit reported `panel mapwrap +18px` at 1500, 1180 and 820, under the skin only. The other `!important` cancels that one declaration | **written** | §6 runs render-audit's overflow check on #unit (mock). Removed, it fails 1. render-audit `SKIN=arkiv ONLY=unit` against production data: 0 findings |
| K14 | `class="btn sec"` on #settings also matches `.sec`, the mono section label, whose `margin:6px 0 -6px` drops the button 6px. The old skin keeps that. Under the skin a button is a button | **written** | screenshot `settings-1440-arkiv.png` |
| K15 | **Both skins, a caption that named a colour.** #sources said a dead source wore "the same amber" as a working one. The Status column draws every non-ok run as `tag bad`: crimson in the old skin, a solid negative dot in Arkiv, and never amber. It now says "the same "partial"", which is true in both | **written** | visible text change on #sources, both skins |
| K16 | `bin/render-audit.mjs` takes `SKIN=arkiv` | **written** | used below |
| K17 | **Found wrong in STEP 0:** `test/payout_page_reconcile.test.mjs` §3 had timed out on every run since 25734ca (a probe racing the shell's first render; see Tests below). The test now waits for the shell's render to begin | **written** | unchanged test: fails at 25734ca ×2 and at HEAD; passes at e98d5f4 ×2. Fixed test: 55/55, three runs |

**Measurements.**

- *The old skin did not move.* #overview, #drivers, #settings and #payouts,
  at 1440 and 390, light and dark, on the desktop and the phone builds: 24
  shots from HEAD (`d00202f`, `git archive`, :8101) and 24 from the working
  tree (live-ui :8100). The data came from STEP 0's recorded fixture, with the
  clock frozen, sticky elements pinned and the caret hidden. 22 of 24 are
  byte-identical. `payouts-desk-1440-light` is identical to a second HEAD run.
  `drivers-phone-390` differs from HEAD by 15 pixels of at most one level in
  one text row, the phone header. The same row differs by the same amount
  between two runs of the working tree in light, so this is the noise STEP 0
  recorded there. Harness in scratchpad `reskin/step1/pixel/`.
- *Screenshots*, on live-ui against production data, `?ui=desktop`, with a
  fresh profile per skin: #overview, #drivers, #payouts, #settings, #feeds and
  #hr-roster at 1440 and 390, with and without `?skin=arkiv` (24, in scratchpad
  `reskin/step1/shots/final/`). Under the skin no page scrolls sideways at
  either width. The old skin's #settings is 2px wider than a 390 window, and
  that was already so. Also shot under the skin: the range panel open, a
  driver page (identity card, tabs, live status), #sources, and the phone
  build (`states1/`).
- *render-audit* (`SKIN=arkiv`, and without, on 12 routes at 1500/1180/820,
  production data). Under the skin the only new finding was the #unit map
  bleed (K13b), and it is fixed. The old skin has three findings the skin
  does not: #drivers' body is 83px wider than a 1180 window (also on
  production bytes, where it is 94px at 820), #overview has a panel +7px at
  1180, and #finance clips "AED 4,832.05" at 820. Those three are outside
  STEP 1, which moves no pixel of the old skin.

**Tests.** New: `test/arkiv_skin.test.mjs`, 86 checks (static, and browser on
the mock). Extended: `type_scale` scans arkiv.css (11). `tokens` lets
arkiv.css use `--ink-2` and resolves its `var()`s (83). Green file by file:
tokens, type_scale, arkiv_skin, today_band 38, routes 65, nav_sections 17,
phone 141, assets 40, query_params 12, calendar_window 82,
auth_banner_pending_ui 18, credential_errand 23, settings_page_layout 20.
Full suite, run once with `npm test` (browser suites on a private mock at :18199): 312 files, 10,034 assertions, 311 green. The one failure was `payout_page_reconcile`, §3, which timed out waiting for the live-ask panel. **It was broken by STEP 0, not by this step.** It passed at e98d5f4 twice, timed out at 25734ca twice, and timed out at HEAD d00202f. The cause is a test race: the shell's first `render()` now lands after the probe paints, the probe's generation goes stale, and payouts.js's `alive(gen)` drops the answer. See COVERAGE.md traps. The test now waits for `#nav a` before rendering its probe, and has passed 55/55 three runs out of three. The product was never affected.

**Revert proofs** (each mutation applied, the test run, the file restored from
a copy, and the md5 checked): no `document.write` → 46 fail · the link
before app.css → 7 (the old dark `--surface` shows through) · `appendChild` →
4 (`non-blocking`) · a hex → 1 · an unscoped rule → 1 · `--warn` not
re-pointed → 5 (amber #7d5b05 / #d0a553) · no `color-scheme:light` → 3 ·
the warning dot solid → 6 · toned digits left coloured → 1 · warn/err notes
grey → 1 · `.cap` in mono capitals → 2 · the `.pill.bad` dot not drawn → 1 ·
collapsed borders → 1 · paper text on Bolt/Hotel/FMS → 1 · the verdict dot
without the row path → 1 (phone cards) · #freshness not outranked → 1 · the
#unit bleed not cancelled → 1 · a module reading `dataset.skin` → 1 ·
`#fRangeLabel` dropped → 1 · `/arkiv.css` off `SHELL_FILES` → 1 · arkiv.css
out of type_scale's token use → 1 (`--d6`) · a literal font-size in
arkiv.css → 1 (type_scale) · `var(--ink-3)` in arkiv.css → 1 (tokens). Two
mutations proved nothing, and are recorded as such. Removing `.pill.bad::after`
from the solid group only left the base rule painting it solid. Removing
arkiv.css from type_scale's literal-size scan with no literal present changes
nothing. Each was replaced by the one above that does fail.

### NOT DONE in STEP 1, and named

- **No dark Arkiv values** (ruling 3). Under the skin the page is light in
  every theme state (`color-scheme:light`, every old dark value outranked). The
  theme button still cycles and still changes the old skin; under Arkiv it
  changes nothing visible. The dark set — neutrals, channels, washes, ramps,
  semantics, hatch — and its contrast and CVD runs are their own step, before
  the flip.
- **The shell's structure** (masthead, section row, view row, sticky control
  bar with the `.applies` sentence, livebar grid with its scope caption and
  note row, authbar grid with swatch/surface/as-of) is STEP 4. STEP 1 only
  restyles the existing rail, topbar, banner and strip.
- **Charts** (colour by name, marks, the outline/hatch swap with its captions,
  donut as bars, graphite heatmap, the hbars track) are STEP 2. Until then
  the charts repaint only through the re-pointed tokens: `--b400` bars are
  graphite, and the categorical `--s*` series are neutral steps. So under the
  skin an 8-slice donut has two identical slices (s2/s5), and the live map's
  pins are shades of grey. Both are replaced caller by caller in STEP 2.
- `.pill.plat` is neutral: `chanChip(key)` needs the channel key (page work).
- The Fraunces → Plex Mono preload swap and the theme-color metas and
  manifest are both-skin changes, so they wait for the flip.
- The phone repaints through the tokens only. Its figures are still Fraunces
  (m.css `.m-stat`/`.m-lede`), and its m.css pass is STEP 5.

## Arkiv reskin, dark mode (ruling 3) — 2026-09-23, NOT ON PRODUCTION

Branch `reskin-foundation`. The operator's ruling 3 (docs/UI-REDESIGN-PLAN.md
§1): a dark mode for the new UI, with dark values for every neutral, channel
identity, wash, ramp, semantic and hatch, validated as PALETTE-EVIDENCE.md
validated light, and the system/light/dark toggle kept working. Not deployed,
not pushed, default skin not flipped. Visible only under `?skin=arkiv` with a
dark OS or the theme button on dark. The evidence, with every validator run
verbatim, is `docs/ARKIV-DARK.md`.

| # | what | state | proof |
|---|---|---|---|
| DK1 | **The dark set** in tokens.js: `NEUTRAL_DARK` (paper `#111113`, ink `#F0F0F1`, grey `#8D8D92` 5.71:1, grey-2/abs-outline `#68686D` 3.40:1…), `CHANNEL_DARK` (each within 2.3° of its light hue), `RAMP_DARK` (lighter from the identity, dL 0.065), `WASH_DARK` (the same 14% form on the dark paper), `SEMANTIC_DARK` (`#008E60` 4.52:1, `#D65044` 4.57:1), `SEQUENTIAL_DARK` (anchor flipped: 2.22 → 14.91:1), `HATCH` (0.45 light, 0.53 dark), `ON_CHANNEL` (the label ink on each fill, per theme). Accessors take an optional theme; the light defaults are unchanged | **written** | `cssTokens()` still hashes to the mockups' `b46907d2…`. tokens.test §9 |
| DK2 | **Validated as light was.** Rerun of the dataviz validator, `--mode dark --surface "#111113"`: A1 PASS 12.0 · A2 (all pairs) PASS 8.1, normal 15.4, tritan 10.9 · A3 PASS 8.1 · A4 (collision) **WARN 7.0** (Hotel × negative) · B1–B7 ramps all PASS · C1/C2: ramps toward the paper fail 12 of 36 (Hotel × negative 3.1), ramps running lighter 0 of 36. The light A4 rerun on this validator build reproduces the design's published output | **measured** | docs/ARKIV-DARK.md §A–§C, verbatim |
| DK3 | **The validator's measures, ported into tokens.js** (`deltaE`, `cvdSeparation`: OKLab ΔE ×100, Machado 2009 at severity 1.0) and `lintTokens()` extended to BOTH themes: text 4.5:1 (and grey on paper-2), marks 3:1, dark grey-2 3 ≤ x < 4.5, ordinal 2:1, band and chroma, wash = 14% of its token, ink on every wash, label on every fill, hatch no fainter than light's, A2/A3/A4/C2 and tritan. `CVD_GATE` holds dark channel × semantic at 7.0, a ratchet on what was measured | **written** | tokens.test §9 calibrates the port against six numbers PALETTE-EVIDENCE.md printed from the validator (A2, A3, E1, E5b, F3): all reproduce to the printed decimal. Thresholds in the test are literals, independent of `CVD_GATE` |
| DK4 | **Generated under the existing theme mechanism, only under the skin.** `bin/gen-tokens-css.mjs` writes three rules: the light block (unchanged, plus `--hatch-a` and `--on-c-*`), `@media (prefers-color-scheme: dark){:root[data-skin="arkiv"]:not([data-theme="light"]){…}}` and `:root[data-skin="arkiv"][data-theme="dark"]{…}`, both (0,3,0) and both with `color-scheme:dark`. The form tokens are declared once, in light | **written** | tokens.test §2–3 parse the block with nesting, and check every light colour name is redeclared in dark, with dark hexes only. arkiv_skin §2 resolves 41 old names in a browser in four states: OS light, OS dark, dark chosen on a light OS, and light chosen on a dark OS (the `:not()` guard) |
| DK5 | **arkiv.css stays theme-free.** The dominance bar's channel labels are `var(--on-c-<channel>)` (paper and ink swap lightness in dark, and so must the name); the neutral slots keep paper/ink because graphite flips with the paper. Header and slot comments carry the dark numbers | **written** | arkiv_skin §1 (static) and §7: 12 fills × 2 dark states, every label ≥ 4.5:1, every fill a dark token |
| DK6 | **Found wrong, both skins:** index.html stamped the stored theme before the first paint for the PHONE only. The desktop waited for app.js's `applyTheme()`, a module appended by the pre-paint script, so it ran after the first paint: a reader who chose dark on a light OS saw a white frame on every load. Both builds now stamp `data-theme` pre-paint (only `light`/`dark`, as `applyTheme()` accepts) | **written** | arkiv_skin §7 refuses `/app.js` and still finds `data-theme="dark"` and the dark paper. With HEAD's index.html, it fails 1 |
| DK7 | `bin/arkiv-dark-evidence.mjs` reprints every table in ARKIV-DARK.md §D from tokens.js | **written** | exits 1 if the lint is not clean |

**Measurements.**

- *The old skin did not move, nor did light Arkiv.* The STEP 1 pixel harness
  (data recorded, clock frozen, sticky pinned, caret hidden): HEAD `0fc5d29`
  on :8101 against the working tree on :8102, #overview, #payouts and
  #settings, desktop 1440/390 and phone, light and dark. Old skin: 16 of 18
  byte-identical; the two that differ (10 px at level 1 on #payouts' right
  edge, 646 px in one band of #settings at 390) differ by the same pixels
  between two runs of the SAME tree. Arkiv light: 8 of 9 identical; the 9th is
  13 px at level 1 in the phone header row, the noise STEP 1 recorded there.
  Arkiv dark: every shot differs, as it should.
- *Screenshots* (live-ui :8100, production data, `?ui=desktop&skin=arkiv`):
  #overview, #payouts and #feeds at 1440 and 390, dark by the OS and dark by
  the toggle, full page and fold. No page scrolls sideways. Scratchpad
  `reskin/dark/shots/v1/`.

**Tests.** `tokens` 144 (was 83), `arkiv_skin` 103 (was 86). Green file by
file: type_scale 11, today_band 38, routes 65, platform_share_once 8,
nav_sections 17, assets 40, phone 141, query_params 12, phone_render 8 and
phone_today_only 19 (private mock :18199), phone_clock 12, capacity_headline
22, chart_fit 27, chart_geometry 17, driver_photo 39, kpi_pill 10,
payout_mobile 39, pinned_identity 72, settings_page_layout 20, sticky_header
9, uber_profile 41, payout_page_reconcile 55. The full suite was not run.

**Revert proofs** (each mutation applied, the generator rerun, the test run,
every file restored and md5-checked): dark grey `#6E6E73` (3.72:1) → tokens
fails 3 · the positive back on the light hue (`#298D54`) → 2 (A3 6.78) ·
CABMAN at its light identity → 4 (2.15:1, band, A2 5.82, hatch) · a vivid
Uber `#0957D8` → 4 (Uber × CABMAN 2.37) · Hotel's ramp run toward the paper
→ 3 (C2 3.13, normal 13.80) · dark hatch 0.45 → 2 · dark grey-2 `#5A5A5F`
(2.75:1) → 2 · generator without the `:not([data-theme="light"])` guard →
tokens 1, arkiv_skin 4 (a light choice on a dark OS drew dark) · no
chosen-dark block → tokens 5, arkiv_skin 8 · dark blocks without the skin
prefix → tokens 3 · no `color-scheme:dark` → tokens 2, arkiv_skin 5 · Uber's
label back to `--paper` → arkiv_skin 3 (3.31:1) · HEAD's index.html →
arkiv_skin 1 · the whole step reverted (HEAD's tokens.js, app.css, arkiv.css
and generator under the new tests) → tokens fails and throws on the missing
`THEMES`, arkiv_skin fails at least 4.

### NOT DONE, and named

- **Hotel × negative is CVD 7.0 in dark**, in the validator's WARN band. It
  is legal because of encodings the law already requires, and STEP 3's
  render-audit checks (a semantic with no glyph) are what will enforce them
  page by page. docs/ARKIV-DARK.md §E5 records what was tried.
- **Semantic text on paper-2 is 4.13/4.17:1 in dark** (light 4.78/8.15). Under
  the skin that is only text in a hovered table row. Holding 4.5 there drops
  the collision run to a FAIL (§E3).
- **The theme-color metas and the manifest** still carry the old skin's
  colours; they move with the flip (STEP 5), in both themes.
- **The hatch opacity is emitted (`--hatch-a`) but not yet used**: charts.js
  adopts SPEC §5's hatch in STEP 2. Today's gapBars pattern draws in paper-2
  and grey-2, which the dark set already covers.
- **The phone** repaints through the tokens in dark as in light; its m.css
  pass is STEP 5.
- Found, not fixed (not dark, and not this step's): #payouts §04's date ticks
  collide at 1440 in both themes of the skin ("23 Dec 2024Feb 2025…"); the
  chart is STEP 2's. `.sh-track>i.o` in app.css paints a literal
  `rgba(74,124,166,.42)` blue under the skin; it is a chart colour for STEP 2.

## Arkiv reskin, STEP 2 — the charts — 2026-09-23, NOT ON PRODUCTION

Branch `reskin-foundation`. docs/UI-REDESIGN-PLAN.md §3 "Charts", SPEC §4-§5,
the review's corrections, and the operator's rulings in §1. Not deployed, not
pushed, default skin not flipped. One commit per chart function. The old skin
must draw what production draws; everything below shows only under
`?skin=arkiv`, except where a row says "both skins".

**How one charts.js draws two skins.** Colour already followed the skin
(every fill is a `var()`). FORM could not: which element a mark is, how thick
it may be, whether an uncollected day is a hatch or an outline, and the
caption that names it. So the form is a token too: app.css declares the old
skin's `--mk-*` (today's forms, value for value), the Arkiv block declares
SPEC's (generated from tokens.js `MARK`), and `charts.js markForm()` reads
whichever is in force — a token, never the skin attribute. `drawnAs(kind)`
gives the caption the word for the treatment actually drawn.

| # | what | state | proof |
|---|---|---|---|
| CH1 | **The mark form as tokens, and barChart to SPEC §4.** tokens.js `MARK` + `markDeclarations()` (fit, 24px ceiling, 4px data end, square base, 2px gap, 6 steps, absent = outline, unfinished = hatch, projected = hatch, 4px/45° hatch); the generator writes them into the Arkiv light block; app.css's old `:root` declares today's forms. `markForm()`, `drawnAs()`, `hatches()` (SPEC §5: the series' own colour at `--hatch-a`, 45°, 1px every 4px, over the paper). barChart: under Arkiv a bar is a path with its data end rounded and its baseline square, ≤ 24px, 2px apart; a new `projected` option hatches a projection. `sequentialIndex()` is the step `sequentialOf()` picks. `channelKey()` learns the labels readers see (`FMS telematics`, `Uber fleet`, `uber_fleet`). arkiv.css §17: the grid in `--faint`, the baseline in `--hair`, ticks mono `--t1` grey, a hatched key swatch (`sw-proj`) | **written** | chart_marks §0-§1 (48). Old skin in a browser: nine bars 1,090px wide are `<rect>` rx ≤ 3 and > 60px; forecast bars solid |
| CH1b | **Both skins — a caption that named a treatment the chart did not draw.** #forecast said "Hatched bars are forecast" over bars drawn SOLID in a colour of their own. The caption now asks `drawnAs('projected')`: Arkiv hatches them and says so; the old skin keeps them solid and says "the bars after the last observed month are forecast, in the colours the key names". A text change on production's skin, made because the old sentence was untrue (CLAUDE.md: never a reason that is not the true one) | **written** | chart_marks §1b renders #forecast in both skins on the mock |
| CH2 | **gapBars: the hatch/outline swap, with every sentence that names it.** Under Arkiv (SPEC §5): an uncollected day is an OUTLINE (1px `--abs-outline`, no fill, the bar's width and data end, the full plot height, hoverable inside); today's bar and a clipped week are a HATCH in the series' own colour with a 1px edge; the second measure behind a bar (telematics journeys, occupancy intervals, the fleet median) is a WASH (the series' colour at 14%), because under Arkiv an outline means "not measured" and these are measurements — a new `--mk-behind` (old skin `outline`, Arkiv `wash`). Drawn at the measured box under `--mk-fit:1`. The old skin: the hatched band, the hollow dashed bar and the outline behind, exactly. Captions rewritten through `drawnAs` / `drawnNoun`: gapBars' own three; #overview 922 and 1064; #demand 1339, 1410, 1434; #causes 230; the driver Record 309, 401, 477-480, 514. Comments that named the old treatment fixed in charts.js, app.js, causes.js, driverrecord.js, performance.js and m/ui.js | **written** | chart_marks §2 (both skins, one render each), §2b (#overview, #demand, #causes on the mock, both skins), and a scan for the 14 old phrases |
| CH2b | **Both skins — #causes named the wrong mark.** Its caption said "Hatched columns are months we hold no data for"; the chart draws those months as OUTLINES and hatches the PARTIAL months, so a reader looking for the hole was sent to the month that is only short. It now reads "Outlined columns are months we hold no data for; hatched ones are partial months…", true in both skins. Under Arkiv the no-data outline is SPEC's (1px solid, no fill) and so is its key swatch | **written** | chart_marks §2b |
| CH2c | **Not changed: vehicle.js:215.** The plan listed it; it is a code COMMENT ("absent days are hatched"), not a caption, and vehicle.js is being edited on the concurrent unauthorized-trips branch. No visible sentence on #vehicle names the treatment. Left for the page phase | **named** | — |
| CH3 | **barChart and gapBars under Arkiv: drawn at the size they are seen at, with ticks that fit.** The dark step found #payouts §04's date ticks running together ("17 Feb 2025Apr 2025…") in the skin. Measured cause, in BOTH skins: payouts.js draws the chart and only then appends its panel, so the host measured 0 and the chart was drawn at chartBox's 720-unit fallback and stretched to 1,090px — ticks and gutter at 1.5×. Under `--mk-fit:1` a chart drawn into a host with no width is drawn again once it has one (a ResizeObserver, stamped so a stale one is dropped), and the x-tick count follows the widest label and the plot width (it was twelve at every width). The old skin keeps its fallback and its twelve, as production draws them | **written** | chart_marks §1c: detached draws in both skins, 91 weekly labels at 1,090 and 515px with no overlap under Arkiv. Screenshot #payouts at 1440 and 390 |
| CH4 | **areaChart to SPEC §4-§5 under Arkiv.** Drawn at the measured box (and redrawn once a detached host has a width); the area a flat 10% wash (the old 30% → 0 gradient restyled in arkiv.css by class, `.ar-wash stop`); a hole in the series a GAP — the dashed bridge the old skin draws across it is not shown (SPEC §5: "not a dotted bridge, not a straight segment across the hole"; the plan read this line, charts.js:581, as a "dashed reference line" to be made solid — it is the gap connector); markers r 4 in their 2px ring; the ENDPOINT carries its value (a new `.ar-end` text, hidden by app.css in the old skin); x ticks fitted. The rating spark on a driver's tiles is a 2px non-scaling line (arkiv.css only; driver.js untouched) | **written** | chart_marks §3 (both skins, computed styles). Screenshot #demand's hourly curve, both skins, light and dark |
| CH5 | **hbars to plan §3 under Arkiv.** No track ground (the midpoint rule stays as the ruler); a 12px bar with its 4px DATA end (the left end for a deduction, which runs the other way); the default fill INK and a deduction GREY with its − sign (plan §1: "ink for added, grey for deducted, with signs"), through two job tokens, `--mk-fill` and `--mk-neg`, that the old skin paints `--b400` and `--s2` as before; a channel row (its colour a channel token, or its label a channel) carries SPEC §4's 3px marker in the gutter beside an ink label (`.hb-mk`, hidden by app.css in the old skin). The five keys drawn over default bars (app.js ×3, revenue.js, driver.js — a token name only there) now name `--mk-fill` / `--mk-neg`, or under the skin the key would have been graphite beside ink bars | **written** | chart_marks §4 (computed colours, radii, track, marker, label colour, keys) |
| CH5b | **Found in BOTH skins: the bars in one hbars were lengths of different tracks.** Each row was its own grid with an `auto` value column, so a row printing "−AED 136,901.32" had a shorter track than one printing "AED 70.00", and the midpoint rule sat at a different x on every row (#revenue: 728 to 746px). Under Arkiv the rows share one set of columns (CSS subgrid), so every track is one width. The old skin keeps the defect until the flip | **written** (Arkiv) · **open** (old skin) | chart_marks §4: four rows with values from 20 to 123,456,789.5 share one track box |
| CH6 | **donut: colour BY NAME, distinct slots, and ranked bars or a 100% bar on request (ruling 6).** charts.js `CAT` is eight SLOTS, `--cat-1..--cat-8`: the old skin paints each with the `--s` colour it always had in that position (app.css), Arkiv with a distinct graphite step chosen for how the slots meet (arkiv.css; neighbours ≥ 21 apart in OKLab L×100 on white, ≥ 20 in dark, rings closing ≥ 12 / ≥ 10, the grey fold 22 and 34 from its neighbours) — the review's correction, so an unconverted donut or stacked bar is never one ink. `byName()`: a datum whose label names a channel takes `--chan-<key>`, which only arkiv.css declares, with its slot as the `var()` fallback — so Arkiv colours channels by name on every donut (#slot, #vehicle, #day, #overview) while the old skin keeps the slot it painted by position; a channel the caller could not map is `--chan-none`, grey under Arkiv. `donut(…, { as: 'bars' })` draws ranked hbars with the count AND the share on each row (a new hbars `shareOf`), channel rows in their identity with their marker, the rest ink, the fold grey, clicks kept and the fold inert; `as: 'bar100'` draws one stackedBar. No caller is converted: each page's plan entry does that in the page phase, and the ring stays the default, so chart_fit's and platform_share_once's `svg.donut` queries are unchanged | **written** | chart_marks §5 (both skins: slot colours unchanged in the old skin, channel identities and six distinct steps in Arkiv, the fold, an unmapped channel, the keys, both `as` forms, clicks) |
| CH7 | **heatmap: graphite, the outline for no reading, a strip for a key.** Under Arkiv (`--mk-steps:6`, `--mk-absent:outline`): the six graphite steps as `--seq-<i>`, picked by `sequentialIndex()` — the pick `sequentialOf()` makes, now shared — so the theme toggle repaints them; an hour with NO READING is the absence outline (1px `--abs-outline`, no fill), never step 0; an hour measured at NOUGHT is a third thing, an empty paper-2 cell with a hair edge (the old skin drew it identically to "nothing recorded"); the key one strip of the six steps labelled at its two ends, with the empty and the unrecorded cells keyed in words only where the grid has one; drawn at the measured width. A new `gapLabel` puts the caller's true reason for an absent cell in the tooltip and the key. The old skin: seven blue steps, floor buckets, the shared "none" cell, its key, its 760 box | **written** | chart_marks §6 (both skins, light and dark, and the caller's reason in the key) |
| CH7b | **Both skins — two callers handed an unmeasured cell to the heatmap as a nought.** #capacity passed `drivers_needed ?? 0` (null where the cell has no driver count or no projection to scale, capacity_routes.js) and #optimise `Number(jobs_per_online_h)` (null where nobody was online, supply_routes.js): the old skin's tooltip read "0 drivers needed" / "0.00 jobs per online hour" for hours nothing was measured in. They pass null, with a `gapLabel` that says why. Same look in the old skin (it drew both alike); the tooltip now tells the truth | **written** | chart_marks §6 scan |
| CH7c | **Both skins — "Darker = busier".** #demand, #capacity and #optimise named the shade: "darker". In dark mode the ramp runs the other way in both skins (the busiest cell is the lightest), so the sentence was false for every dark-mode reader. They say "the stronger the shade", and #capacity's "the pale ones" is "the faintest ones" | **written** | chart_marks §6 scan |
| CH8 | **scatter to SPEC §4 under Arkiv.** Drawn at the measured box (redrawn once a detached host has a width), with a gutter measured from its tick labels plus room for the rotated y label; markers SOLID (r 4.5 ≥ 4) inside a 2px surface ring — the old 60% opacity turned two dots on one spot into one darker dot; the reference line SOLID. Paint in arkiv.css on `.sc-dot` / `.sc-ref`. Found in BOTH skins: scatter never got barChart's measured gutter, so #unit/assets' "AED 5,000.00" ticks ran off the drawing's left edge under its rotated y label (measured −11px); fixed under Arkiv, the old skin keeps it | **written** (Arkiv) · **open** (old skin) | chart_marks §7 (computed opacity, ring, dash, every label's client rect inside the drawing) |
| CH8b | **Both skins — #unit/assets named a line its scatter does not draw.** "…a dot well below that line is doing distance that is not being paid for": economics.js has never passed `refLine`, so there is no line. The sentence names the rate instead ("a car earning well under that for each km"). Drawing the line (`refLine: { slope: aed_per_km }`, which scatter already supports) would change the old skin's look, so it is the page phase's | **written** | chart_marks §7 scan |
| CH9 | **stackedBar to SPEC §4 under Arkiv.** Drawn at the measured width and 24px tall (redrawn once a detached host has a width); a 2px surface GAP between segments instead of a hairline stroke around each; square at the baseline, 4px round at the data end (a clip path, not rx 5 all round); segments coloured by NAME (`byName`: channels their identity, the rest distinct slots, the fold grey — the review's "stackedBar picks colours by CAT index" correction); the share printed on a segment in the ink that reads on its fill, `--on-cat-N` (paper on the four steps far from the paper, ink on the two near it; ≥ 5.14:1 light, ≥ 4.85:1 dark, measured with tokens.js `contrast()`) or `--on-chan-<key>` → `--on-c-<key>`, at `--t4`. The old skin: its 400 × 30 box, strokes, rx-5 clip, `--s` slots and paper labels (every `--on-cat-N` is `--surface` there) | **written** | chart_marks §8 (both skins, dark included: gaps, clip, slots, identities, label contrast ≥ 4.5 on every segment, keys) |
| CH10 | **Handed over by the dark step, and the loose ends.** The shift track's online layer (#driver/activity) is `--seq-1` under the skin, bar and key alike: app.css paints the bar with a literal `rgba()` blue where `color-mix()` is unsupported, and gives the key swatch `.lgnd .sw.o` no colour at all (an invisible swatch in the old skin, found and left there). `sourceToken()` stays null for an unknown key (returning `--grey` would repaint the old skin; the charts grey it through `--chan-none`) — ui.js's comment and tokens.test's label say so now. The plan carries an as-built note | **written** | chart_marks (the rule, static); screenshot #driver/…/activity "How the day was spent", both skins |

**Measurement: no mark moved in the old skin.** The dark step's pixel
harness (every `/api/` response recorded, the clock frozen, sticky elements
pinned, the caret hidden), old skin only: `8f27809` (before STEP 2) against
the working tree, #overview, #demand, #forecast, #causes, #unit/assets,
#revenue, #payouts, #capacity, #optimise, #settlement, #performance and
#finance, at 1440 light, 1440 dark and 390 light — 36 shots a tree, and a
second run of `8f27809` for the noise. 14 are byte-identical; 4 more differ
only as the second run of the same tree does (a clock digit and a tab
underline in the today strip, one pixel column at #payouts' edge). The other
18 are the seven intended sentences (#forecast, #causes, #demand, #capacity
×2, #optimise, #unit/assets) and the page heights they move. To prove that is
ALL they are, the working tree was shot again with only those seven strings
put back: 18 shots, every one byte-identical to the first or the second
`8f27809` run except the today strip, whose recorded answer differed between
runs (547 against 826 bookings so far). Scratchpad `reskin/step2/pixel/`.

**Screenshots** (live-ui :8100, production data), one set per chart function,
both skins, light and dark where it matters: `reskin/step2/shots/1-barChart`
(#forecast), `2-gapBars` (#overview, #causes), `3-fit` (#payouts 1440/390),
`4-areaChart` (#demand), `5-hbars` (#overview, #revenue), `6-donut`
(#overview), `7-heatmap` (#demand, #capacity, #optimise), `8-scatter`
(#unit/assets), `9-stackedBar` (#overview, #settlement), `10-narrow` (390,
no sideways scroll), `11-shift`.

**Tests.** New: `test/chart_marks.test.mjs`, 137 checks, both skins in a
browser on the mock (light and dark), each chart function's section proved by
reverting it (every commit message lists its reverts and the failures they
produced). Changed deliberately: tokens.test (the mark declarations in the
generated block; the sourceToken note). Green file by file across the step:
chart_marks, tokens, arkiv_skin, type_scale, chart_fit, chart_geometry,
forecast_page, money_precise, routes, live_day, phone, phone_today_only and
phone_render (private mock), driver_empty_window_page, break_month_grain,
seasonal, signed, source_line, trend_gaps, capacity_headline, spacing (125
routes), platform_share_once, optimise, window_honesty, unit_ranking_gate,
caption_matches_figure, cash_value_caption. The full suite was not run, per
this step's instructions.

### NOT DONE in STEP 2, and named

- **No donut caller is converted.** Ruling 6: each donut is replaced on its
  own page, as its plan entry says. `donut(…, { as: 'bars' | 'bar100' })` is
  ready; the ring stays the default until then.
- **The ~20 `'--s1'…'--s8'` names pages still pass** (the map pins, the
  unauthorized series `--s8`, forecast's `--s3`/`--s5`, alerts `--s2`…) keep
  STEP 1's neutral steps under the skin. Converting each to `channelOf(name)`
  or ink is the page phase's, page by page, as the plan says.
- **L3, found and not this step's:** driver.js's standing bars fill with
  `--good` / `--warn` / `--critical` (a semantic as an area fill in a plot),
  and economics.js's vehicle states colour with the same three. Both are
  page components on files the page phase owns (driver.js is also being
  edited on the concurrent unauthorized-trips branch).
- **#driver/activity's shift track draws a missing dropoff as a HATCH**
  (`.sh-track>i.u`) and three captions say so (driver.js 279, 317, 427).
  Under SPEC §5 that is an outline. The swap needs driver.js caption edits
  on a file the concurrent branch is editing; left for the page phase.
- **vehicle.js:215** (on the plan's list) is a comment, not a caption. Left.
- **#unit/assets' scatter has no reference line**; its caption now names the
  rate. Drawing it (`refLine: { slope: aed_per_km }`) would change the old
  skin.
- **Old-skin defects found and fixed only under Arkiv**, because fixing them
  there moves production: #payouts draws its chart before its panel is on the
  page (1.5× ticks); every hbars row has its own track width; scatter's
  gutter lets "AED" ticks run off the drawing. Each is named in its row above.
- **`sourceToken()` still returns null** for an unknown key; the charts turn
  the null into `--chan-none` (grey under Arkiv). `dominantBar()` (a STEP 1
  component in ui.js) still gives an unknown channel a positional class.
- **`spark()` stays in m/ui.js** — the review's option; moving it is STEP 3's,
  with test/phone.test.mjs updated there.
- **Map pins** are untouched: the plan flags them for the map page, keeping
  the state colours an operator reads the live map by.
- **The phone's own m.css pass** is STEP 5; its screens reach charts.js only
  through the desktop driver and vehicle tabs, which follow the tokens.

## Arkiv reskin, STEP 3 — the page contract and the stale-render guard — 2026-09-23, NOT ON PRODUCTION

Branch `reskin-foundation`. docs/UI-REDESIGN-PLAN.md §3 ("Page contract",
"Components" item 12, "Review corrections", "Also required"), SPEC §1 and §3A,
the operator's rulings (§1). Not deployed, not pushed, default skin not
flipped. Everything visual is under `?skin=arkiv`; the stale-render guard is
in both skins (it changes no pixel, measured below).

| # | what | state | proof |
|---|---|---|---|
| C1 | **The stale-render guard, central.** `render()` replaced the ONE #view's contents and handed it to the next page, so a render the reader had left wrote into the page they were on. Measured on the mock: #supply held on `/api/supply/balance`, the reader moves to #settings, the answer lands, and #settings grows #supply's closing paragraph. `freshView()` now REPLACES #view with an empty copy of itself (same id and classes) on every render; an abandoned render writes into its own detached element. Covers supply, causes, forecast, optimise, capacity, day, slot, trip, trips and every other view without a per-page edit (none of the concurrent branch's files is touched for it) | **written** | page_contract §4 (the leaked paragraph, the old element detached and holding it, one #view). Reverted to `root.innerHTML = ''`: 3 fail |
| C2 | coverage.js:289 awaited `/api/coverage` with no `alive(gen)` check; it has one (the anchor scroll after it reads `location.hash`, which by then is the next page's) | **written** | page_contract §4. Removed: 1 fails |
| C3 | **Which DOM a page builds is a token.** `--pg-contract` (app.css `:root` 0, arkiv.css 1), read by `ui.js contract()` — markForm()'s pattern; no module reads the skin | **written** | page_contract §0; arkiv_skin §4 still scans every module (103 green) |
| C4 | `delta(value, {invert, unit, of, kind, d, na})`: colour and screen-reader word from `semanticOf()`, arrow and sign from the arithmetic (a fall in cancellations is a green ▼ −, SPEC L3; semanticOf's own glyph is ▲ for every "better"); a change that rounds to nothing is grey "no change"; ruling 4 — `kind: 'level' \| 'gap'` without `of` throws; `na` printed verbatim | **written** | page_contract §1. Arrow from semanticOf: 2 fail. Level allowed without a reference: 1 fails |
| C5 | `highlight(node, token)`: wraps the figure in `span.hl` (wash `--w-*`, a 3px rule under the figure, weight 600, digits ink); refuses an absent figure, an `<svg>`, a `<tbody>`, a 2nd in a band and a 4th on a page, and says which rule | **written** | page_contract §5. No band check: 2 fail · no page cap: 1 · svg/tbody allowed: 1 · absent allowed: 2 |
| C6 | `glance(host, tiles)`, built ON `kpiTile` (a `glance` flag adds `tile`/`t-l`/`t-v`, `is-hero`, a channel swatch, `na` — the reason in the value slot —, `unit`, `delta`, `spark` or the reason there is none). A kpiRow tile is byte-identical to the pre-STEP-3 function (frozen in the test as the oracle). arkiv.css: six columns, the hero two at `--d6`, 6 → 2 → 1 at 820/480 | **written** | page_contract §2, §5, §5b; kpi_one_tile 20. Extras on every tile: kpi_one_tile 9 fail · six columns removed: 1 · hero spanning two at 390: 1 |
| C7 | `secHead(idx, name, note)`: `idx` null takes the next number from the counter the panel titles use; the index in `--grey`, not b.css's grey-2 | **written** | page_contract §5 (computed `::before`) |
| C8 | `absenceBand(host, cells)`: up to four cells a row, the size in Karla 600 `--d5` ink-2, the reason at reading size, `none` for a gap no figure sizes, one ink highlight on the `hl` cell with a figure | **written** | page_contract §5 |
| C9 | **The shell footer.** `<footer id="pageFoot">` after #view, inside #app, carrying the principle line verbatim ("A figure that cannot be measured is shown absent, with the reason — never as zero.", the mockups' `.principle`); `pageFoot({basis, colophon}, host)` fills basis and colophon, `clearPageFoot()` runs on every render, and under the contract `stampSource` puts `.srcline` in the basis. The old skin: `display:none`, `.srcline` stays in #view. **The phone** (review finding): a host outside #view — m/screens.js fallback()'s `.m-fallback` — gets its own `.pf-inline` footer, principle included | **written** | page_contract §5, §5b. No inline footer: 2 fail · not cleared: 2 · srcline left in #view: 1 · footer shown in the old skin: 1 |
| C10 | `spark()` moved from m/ui.js to charts.js (m/ui.js re-exports it); a null is a GAP (it was `Number(null)` = 0 — the `\|\| 0` lie — and an undefined was dropped, sliding later days left). Every series the phone passes is byte-identical to the old function (all finite: each caller `\|\| 0`s first) | **written** | page_contract §3 (the old function frozen as the oracle, seven series); phone 142 (its spark checks now read charts.js, changed deliberately, with the re-export pinned). Old filter restored: 2 fail |
| C11 | `tableFrom(…, {pairs: [[a, b], …]})`: two columns in one cell, both labels in the heading and both sort buttons with their own keys (sort in the address), `data-key`/`data-key2`, phone card label "A · B"; a pruned half falls back to the other. Opt-in | **written** | page_contract §6. Second label not a button: 2 fail |
| C12 | **render-audit: the four checks** — `highlight-budget`, `grey2-text`, `off-token-colour`, `semantic-no-glyph` — from computed style; the colour three only where `--pg-contract` is 1 | **written** | audit_tools_detect (33): a faulty stub, a legal stub, the faulty stub at `--pg-contract:0`. Each check removed: 2 / 1 / 1 / 1 fail; law applied to the old skin: 1 |
| C13 | gapBars `secondaryLine: {color, label}`: the second measure as a step line with a direct label, placed above every mark under it. Opt-in; no existing caller passes it | **written** | page_contract §7 (`.gb-step`, "FMS journeys") |
| C14 | **#overview, the pilot, under the skin** (plan §4 with the review's correction and rulings 5-7): 00 (the verdict as the statement, then seven tiles, Trips the hero), 01 Bookings per day in ink with the FMS journeys step line and the stats caption (busiest day highlighted), 02 Cancellations a day (complete days), 03 channel bars (click-to-filter), 04 the /api/kpis outcome buckets in ink plus every raw status word, 05 every tier (12 drawn, the rest counted), 06 settle bars, 07 Top drivers with channel swatches, † four live cells, the colophon. Deltas on Trips, Distance, Trip value, Money in (%) and Completion (points) from `/api/compare/period`, ABSENT with the true reason on a rolling window or a channel filter (where the endpoint answers 400, so it is not asked); sparklines on four tiles, Money in says why it has none. No §06 AED/km per tier (ruling 5). The old skin's page is unchanged: `overviewClassic`, sharing `overviewTiles`, `overviewVerdict` and `topDrivers` | **written** | page_contract §7 (order, 7 tiles, 5 deltas, 4 sparks, no bare —/0, 3 highlights, 4 cells, no ring, step line, swatches, no per-tier rate; rolling window; channel filter, and no refused request; old skin: six panels, kpiRow, two rings). All of it on the old page under the skin: 14 fail · comparison asked under a channel filter: 1 |

**Measurement: the old skin did not move.** STEP 2's pixel harness (every
`/api/` answer recorded, clock frozen at 2026-09-23T08:00Z, sticky pinned,
caret hidden), HEAD `c0b6238` (`git archive`, :8101) against the working tree
(:8102): #overview, #supply, #settings, #coverage, #drivers, #finance at 1440
light, 1440 dark and 390 light, plus the phone build's #overview and #today —
20 shots and 20 `#view` DOM dumps a tree, and a second HEAD run for the noise.
**Every DOM dump is identical** (random chart ids normalised) except #drivers
1440 light ("0d ago" / "-1d ago"), where the second HEAD run equals the
working tree. 18 of 20 shots are byte-identical; #coverage 1440 light equals
the second HEAD run; #settings 390 light equals a third HEAD run (the 646-pixel
band the dark step recorded as run-to-run noise). Harness in scratchpad
`reskin/step3/pixel/`.

**render-audit under the skin.** Production data (live-ui): #overview at 1440
and 390, 0 findings, 3 highlights. On the mock, all 125 routes at 1440: no
js-error; the new checks found #compare's ▲/▼ with no sign (11), #coverage's
red counts (5), #receipts' "−AED 1,500.00" with no glyph (2), #insights'
impact figures (1 on the mock, 14 on production), unstyled form controls in
the browser's own grey (#online-time, #trips, #playbook) and #retention's
table-cell backgrounds (6 non-token colours) — all page-phase work, listed in
AUDIT.md.

**Screenshots** (live-ui :8100, production data): #overview under the skin at
1440 and 390, light and dark, and in the old skin at 1440 and 390, full page;
plus a 1440×900 fold. Scratchpad `reskin/step3/shots/final/`.

**Tests.** New: `test/page_contract.test.mjs`, 81 checks (static and browser
on the mock). Extended: `audit_tools_detect` (6 new, 33). Changed
deliberately: `phone` (spark checks read charts.js; the re-export pinned),
`chart_marks` (#overview's hero chart is "Bookings per day" under the skin).
Green file by file: page_contract 81, audit_tools_detect 33, kpi_one_tile 20,
phone 142, arkiv_skin 103, type_scale 11, tokens 144, chart_marks 137,
chart_fit 27, chart_geometry 17, platform_share_once 8, routes 65,
nav_sections 17, today_band 38, page_numbers 11, caption_matches_figure 32,
calendar_window 82, auth_banner_pending_ui 18, imports_resolve 4, verdicts
24, assets 40, sticky_header 9, pinned_identity 72, fold_rows 8,
absent_columns 25, payout_mobile 39, scroll_cue 6, money_precise 21,
phone_render 8, phone_today_only 19, payout_page_reconcile 55,
driver_empty_window_page 63, insight_named 35, kpi_pill 10, query_params 12,
source_line 19, settings_page_layout 20, credential_errand 23, trend_gaps 50,
live_day 20, capacity_headline 22, formatters 34, signed 14, interlinking 11,
consistency 67, spacing 2 (125 routes), smoke_views 125/125. Browser suites on
a private mock (:18399). The full suite was not run, per this step's
instructions.

**Revert proofs** (`scratchpad reskin/step3/reverts.py`: each mutation
applied, the test run, the file restored and md5-checked; all 24 fail as
listed in the rows above). Four first proved nothing and the test was
strengthened until they did: the absent-figure refusal (no case reached it
before the budget did — now asked first, and a hero that cannot be measured is
checked), the six-column rule (at 1,100px auto-fit also gives six — the test
host is now 900px, where it gives five), the pair's second sort button (the
test crashed instead of failing — now fails cleanly), and the channel-filter
comparison (the mock does not answer 400 — the test now asserts no request is
made).

### NOT DONE in STEP 3, and named

- **The fold at 1440×900.** With today's shell (the rail, the three-row
  credential banner production carries now, the topbar and the today strip)
  the 00 head starts above the fold and the first row of tiles at ~720px, so
  the hero runs past 900. STEP 4's shell restructure is the plan's answer (§3
  Risks, "THE FOLD"); nothing in the page can fix it.
- **No page but #overview adopts the contract.** driver.js and vehicle.js
  (the phone's fallback tabs) will call `pageFoot(…, host)` in the page
  phase; both are on the concurrent unauthorized-trips branch and were not
  touched.
- `rowMark` / `chanChip` (plan §3 Components 12) are not built; #overview
  needed only `swatch()`.
- **Both skins, found and not fixed:** the old skin's Trips tile prints
  "0 telematics journeys" under a channel filter (`/api/kpis` answers 0 there
  because journeys are not a channel's; `|| 0` also turns a null into 0). The
  contract version says why instead; the old skin keeps production's text
  until the flip. The phone's money spark passes `n(d.revenue) || 0`, so a
  day with no revenue figure draws as a day of none. #drivers is 67px wider
  than a 1440 window on the mock in BOTH skins (its table), as STEP 1
  recorded at 1180.
- The render-audit findings above (#compare, #coverage, #receipts, #insights,
  the unstyled inputs, #retention) are each page's own plan entry.

## Arkiv reskin, STEP 4 — the shell — 2026-09-23, NOT ON PRODUCTION

Branch `reskin-foundation`. docs/UI-REDESIGN-PLAN.md §3 ("Shell: rail, header,
control bar, credential banner, freshness", "Order of work" STEP 4, "Review
corrections", "Also required"), the mockups' b.css chrome, viz.css `.livebar`
and arkiv-new/authbar.css. Not deployed, not pushed, default skin not flipped.
Everything visual is under `?skin=arkiv`; the old skin's DOM and pixels did not
move (measured below). The concurrent unauthorized-trips branch's areas were
not touched: app.js changes are confined to render(), authBanner(),
todayNow(), freshness() and the boot line, and index.html's change is the
one line that loads the module (SH16).

| # | what | state | proof |
|---|---|---|---|
| SH1 | **Which shell is a token.** `--pg-shell` (app.css `:root` 0, arkiv.css 1), read by `shell.js shellContract()` — the chart form's and the page contract's pattern; no module reads the skin | **written** | arkiv_shell §0; arkiv_skin §4 still scans every module. Token removed from arkiv.css: REV17 |
| SH2 | **The sheet.** `buildShell()` MOVES the existing nodes, never re-creates them: masthead `#mast` (wordmark in Fraunces, "Ecosine & Egari · Dubai", the window in `#mastWin`/`#mastWinSub`) → `#secRow` (#nav, then #settingsLink relabelled "Set up" with `href="#settings"` intact, then #freshness) → #sectabs → #authBanner → #filters as the control bar `.ctl` (the six controls, #themeBtn joined, the sentence `#fApplies`, #tzNote) → #todayNow → the title block `.topbar` → #view → #pageFoot, and stamps `#app.ak-shell`. Every listener survives (the platform select, the range calendar and the theme cycle drive the page from their new places), every shell id is in the document once (#fRangeLabel, #tt, #m included), the rail is `display:none`, and #app is invisible until the class is on it | **written** | arkiv_shell §3 (order, ids, contents of each row, the moved controls working). Theme left in the rail: REV8 |
| SH3 | **The control bar is the one thing that sticks** (top 0, ≈50px, in place of the 148px sticky topbar); the view row and the title no longer stick; selects are square mono with a drawn ▾ | **written** | §3. Made static: REV20 |
| SH4 | **The .applies sentence.** `appliesSentence(view)` names exactly the controls data.js's three lists hide, and why, in the words data.js's own comments give (`APPLIES_WHY`, 32 pages); compliance, insights and retention take the shared "none of them changes what it shows"; "notfound" says the address names no page. A page that hides nothing says nothing. A NO_FILTER page hides the platform and fleet too, so its reason answers for all four where the source says why: #live (its feed takes no parameter), #day (every source for that day), #online-time (the call list was asked for as every driver), #deposits (a position against a person), #salary (the pay book, /api/ledger/entries, takes no platform or fleet), #capacity (demand from every channel) — reworded on resuming after the container restart; copy only, no behaviour, so no revert proof | **written** | §1 (all 35 listed pages; no stale reason; exact controls), §3 (#payouts, #settings, #overview in a browser). Payouts' reason removed: REV11 · platform and fleet named on a NO_RANGE page: REV12 |
| SH5 | **The masthead window**, only what the client can vouch for: a rolling window's two Dubai days ("25 Aug – 23 Sep 2026", computed by windowDates), a calendar period's name alone (the server's calendar resolves it), two calendar dates as the label, "No window applies here" on a hidesRange() page; always "· Dubai time" | **written** | §2, §3. Period printed with client dates: REV13 · never filled (shellFrame not called): REV10 |
| SH6 | **The banner as a grid** (authbar.css): four cells — who with the channel's swatch (`swatch(provider)`), the key with `rows[].surface` under it, what, when — and a meta cell "as of HH:MM Dubai" from the LATEST `checked_at` of the rows shown (none printed when no row has one — a page clock would claim a check nobody made) and "Set up → credentials" → #settings. Severity, errands, classes and the pending tone unchanged; the old skin's row markup is byte-identical (`detailOf`/`whenOf` extracted, same output) | **written** | §4; auth_banner_pending_ui 18, credential_errand 23, arkiv_skin §5. First row's time: REV5 · the page clock when none: REV6 · no surface: REV7 |
| SH7 | **The livebar.** Each figure a cell (value, `.lb-l` mono label, sub-line under), trip value's chrome emphasis (a 3px rule and a size step, no wash, `.lb-hl`), the scope caption on the face of the strip ("Both fleets, every channel — this strip does not follow the filters above."), and the notes that lived only in `host.title` (the fares basis, FARES_LAG, the projection basis, what was wired and not counted) in a `<details>` that starts closed. `host.title` is still built; the old band's markup is byte-identical. Two columns of cells below 820px | **written** | §5; today_band 38. Livebar markup in the old skin: REV15 · notes open: REV16 |
| SH8 | **Freshness on one line** in the section row's right slot (three parts joined by `.fr-sep`); the rail's three lines byte-identical in the old skin | **written** | §5, §0. `<br>` kept under the shell: REV14 |
| SH9 | **The first render waits for the stylesheets** (`shell.js whenStyled`, both skins; a microtask when every sheet is in). index.html appends app.js as a module from a script, and nothing orders it after the parser-inserted `<link>`s: with arkiv.css held back 1.5s the first render read `--pg-shell` AND STEP 3's `--pg-contract` as 0 — the old shell and the classic #overview under the new stylesheet — and nothing re-rendered when the sheet landed. **A latent STEP 3 defect** (contract()), fixed here. A sheet slower than the 4s cap renders without it and again when it lands, so a skin page is never left blank. **Since SH16 the browser does this first**: app.js is now a module the parser writes in, so it is deferred, and a deferred script does not run while a parser-inserted stylesheet (arkiv.css included) is loading. The wait is kept as the second line (a stylesheet a script appends never holds a script back); on today's index.html it is a microtask | **written** | §8. Boot without the wait: REV0 (3 fail) · no render when a slow sheet lands: REV1 — both measured with app.js APPENDED, as index.html had it then. With SH16 in place the wait alone is no longer load-bearing (measured: the boot line made a bare `render()`, arkiv_shell 73/73), so §8 now proves the pair; REV22 proves SH16 |
| SH10 | **A new page starts at the top of the sheet**, not with #view at the top of the window, which under the new shell hid the title block (at 390px the chrome is taller than the screen) | **written** | §3 (390px). `scrollIntoView(#view)` kept: REV9 |
| SH11 | **Zen and print.** Zen hides the masthead, both rows, the strip and the sub-line, and keeps the banner, the control bar (with its way out) and the title. Print drops the rows, the controls and the strip and keeps the masthead (on paper, the only place the window is named) | **written** | §6. Zen's strip rule without `:not([hidden])`: REV4 · print keeps the control bar: REV18 |
| SH12 | **Narrow windows.** The section links scroll as one row with an edge fade and freshness takes its own line below 900px; the masthead window wraps under the wordmark, the banner's cells stack and the livebar's cells go two to a row below 820px; the lit section and the lit page are scrolled sideways into their rows (at 390px Set up, lit on #settings, was off the edge); no sideways scroll at 390 | **written** | §7, arkiv_skin §6. app.css's 820px `#nav{order:3}` put Set up before Today: REV2 · lit items not scrolled into view: REV19 |
| SH13 | **The phone is untouched**: `#app` under the skin gets one grid track, never a display (a `display:block` at (1,2,0) outranked m.css's phone hide at (1,1,1) and drew the desktop shell above the phone app — page_contract §5b caught it in this step) | **written** | arkiv_shell §7 (phone), page_contract §5b. `display:block` restored: REV3 |
| SH15 | **test/auth_banner_pending_ui's fixture was a date literal** (2026-09-23T08:30Z, "12:30 in Dubai"), and the page prints a bare "saved 12:30" only for a save on the reader's own Dubai day — so from 00:00 Dubai on 24 September the check failed on a correct page. It is today's Dubai date at 08:30Z now; the earlier-day case keeps its fixed date on purpose. No product change | **written** | The full run below (past midnight in Dubai) failed it 1; 18/18 after. The literal is the revert, and it fails every day from 24 Sep |
| SH16 | **The boot race STEP 1 introduced, found by this step's full run.** index.html APPENDED the application module from a script, which makes it async: it runs when it has arrived, whether or not `<body>` exists. STEP 1 put an inline script after the stylesheets (the `document.write` of arkiv.css), and an inline script waits for every stylesheet above it while the parser waits for the script — so a slow app.css held `<body>` back while the module ran without it. Found when `charging_page`'s phone half failed in the full run under load (`TypeError: Cannot read properties of null (reading 'append')`, body text empty) and passed alone; reproduced with app.css held back 2s: the phone build throws at m/app.js `root.append` (#m not parsed yet) and the desktop at app.js `$('#fRange').onclick` — a blank page on both builds, in both skins, at STEP 1 (0fc5d29) and after; the commit before it (d00202f) renders both. Fixed in index.html: the parser writes the module in (`document.write('<script type="module" …>')`), so it is deferred — the download still starts at the top of `<head>`, and it runs once the document is parsed and the parser's stylesheets have loaded. Both builds, both skins; no visual change | **written** | new `test/boot_order.test.mjs` (5: index.html writes the module and appends none; with app.css held back 2s the desktop in both skins and the phone render with no error). The appended module restored: REV22 (5 fail) |
| SH14 | **render-audit reads the chrome.** Its colour checks read #view and #pageFoot only, so none of the new shell was checked; the scope now includes every child of `#app.ak-shell > .main` but those two (the old skin's rail predates the law). Clean on production (6 routes × 1440/390) and the mock (125 routes at 1440); AUDIT.md "Reskin STEP 4" | **written** | audit_tools_detect (a masthead date in grey-2 reported, in grey not). Chrome out of the scope: REV21 |

**Measurement: the old skin did not move.** STEP 3's pixel harness (every
`/api/` answer recorded, clock frozen at 2026-09-23T08:00Z, sticky pinned,
caret hidden), HEAD `fff8be1` (`git archive`, :8101) against the FINAL working
tree (:8102): #overview, #supply, #settings, #coverage, #drivers, #finance,
#compare, #payouts at 1440 light, 1440 dark and 390 light, plus the phone
build's #overview and #today — 26 shots, and 26 DOM dumps now of the WHOLE
`#app` (the shell included, not only #view). **Every DOM dump is identical**
(random chart ids aside). 25 of 26 shots are byte-identical; #drivers at 390
differs by 6 pixels at the right edge (x 388–390), and a second HEAD run
differs from the first HEAD run in the same shot — run-to-run noise (an
earlier working-tree run matched this one exactly). Harness in scratchpad
`reskin/step4/pixel/` (`shots/before`, `before2`, `after`, `final`).
**Rerun after SH16** (index.html's module line, `shots/final2`):
every DOM dump identical to `final` and to `before` but for the random
chart ids; 25 of 26 shots byte-identical to `final`, #payouts 1440 light
differing in 13 pixels at x 1438–1440 — the same right-edge noise — and
#drivers 390 against `before` as above.

**The fold, measured** (production data through live-ui, #overview 1440×900):
masthead 61px, section row 38, view row 38, the credential banner 252 (the
three stopped rows production carries today), control bar 56, livebar 119,
title block 71 — #view starts at 635px and the first tile at 897. Without the
banner #view would start at ~383, which is the plan's ~380. The old skin, same
data: first tile at 697 (its band is one 44px line and it has no masthead or
rows). The banner's grid makes it taller than the old banner (200px): its
detail column is narrower. See NOT DONE.

**Tests.** New: `test/arkiv_shell.test.mjs`, 73 checks (static, and a browser
on the mock: the old skin untouched, the sheet, the moved controls working,
the sentence and the window on four pages, the banner grid and its "as of",
the livebar and freshness, zen and print, 390px and the phone build, a slow
stylesheet and one slower than the cap). Changed deliberately:
`arkiv_skin` §5 measures the wordmark on `.mast-word` (the masthead's; the
rail's `.brand` is hidden with the rail, so its face proved nothing).
Green file by file after the last edit: arkiv_shell 73, arkiv_skin 103,
page_contract 81, audit_tools_detect 35, today_band 38, auth_banner_pending_ui
18, credential_errand 23, nav_sections 17, routes 65, calendar_window 82,
type_scale 11, tokens 144, assets 40, imports_resolve 4, phone 142,
phone_render 8, phone_clock 12 (1 skipped), kpi_pill 10, chart_fit 27,
chart_geometry 17, platform_share_once 8, sticky_header 9, pinned_identity 73,
scroll_cue 6, fold_rows 8, payout_mobile 39, settings_page_layout 20,
driver_money_tab 56, performer_week 26, money_precise 21, page_numbers 11,
source_line 19, live_day 20, today_live 16, route_smoke 59. After SH16:
boot_order 5 (new), arkiv_shell 73, and the files that load index.html listed
under "The full suite" below.

**The full suite** (`npm test`). First run, just after 20:00 UTC — past
midnight in Dubai, 24 Sep: 315 files, 10,458 assertions, 3 files failing, all three bound to the
clock and none touched by this step: `auth_banner_pending_ui` 1 (the fixture
date, SH15, fixed and green after); `payout_scope` 2 ("ends at a measured date
rather than the 2100-01-01 sentinel ["2024-12-23","2026-09-24"]"; "640 against
a register floor 639 days back") and `phone_today_only` 3 (the mock reports no
bookings for Dubai's 2026-09-24 while UTC is still the 23rd). Both fail
identically on an extract of HEAD `fff8be1` run at 20:31 UTC, so they are the
hours between 20:00 and 24:00 UTC, not this change — named in NOT DONE.
Second run, after resuming from a container restart (20:47 UTC, the reasons
reworded): 315 files, 10,456 assertions, 3 failing — the same two clock-bound
files, and `charging_page` 3 (its phone half: body empty, "Cannot read
properties of null (reading 'append')"), which passed alone. That flake was
the boot race, SH16. Third run, after SH16 (21:04 UTC): **316 files, 10,464
assertions, 2 failing** — `payout_scope` 2 and `phone_today_only` 3, the same
words as before, and both fail identically on the HEAD `fff8be1` extract
rerun at 21:16 UTC (phone_today_only against mockapi on :8099, as run-all
gives it).

**Revert proofs** (`scratchpad reskin/step4/reverts.py`: each mutation
applied, the test run, the file restored and md5-checked; 22 mutations, every
one fails, listed as REV0–REV21 in the rows above; `reverts.log`). Before
any revert, the new tests, page_contract §5b and the screenshots found five defects in this
step's own first draft, each now a row above: `#app{display:block}` drawing
the desktop shell over the phone app (SH13), app.css's `#nav{order:3}` putting
Set up before Today at 390px (SH12), zen leaving the livebar on (SH11), the
print rule losing to setHeader()'s inline `display:flex` (SH11), and Set up
lit off the edge of its row at 390px (SH12). After the resume: REV22, the
appended module restored in index.html — boot_order 0 passed, 5 failed (the
static pair, and the three boots blank with the errors quoted in SH16); the
file restored and md5-checked.

**Screenshots** (live-ui :8100, production data, under the skin): #overview,
#drivers, a driver's page, #payouts, #settings and #live at 1440×900 and
390×844, light and dark (24), plus #overview full-page at each width and
theme. #live retaken after the reasons were reworded, and #online-time and
a #day added at both widths and themes (12), to show the longest sentence on
one line at 1440. Scratchpad `reskin/step4/shots/`.

### NOT DONE in STEP 4, and named

- **The fold at 1440×900 is not won while production carries a three-row
  banner** (#view at 635px, the first tile at 897, measured above). The
  banner is the one piece of chrome the plan keeps above everything, and its
  grid rows wrap more than the old prose rows did. Options for the operator:
  clip each row's detail to two lines with the rest on hover or in a
  `<details>`, or fold the rows under the head when there are more than two.
  Neither is done: a credential that has stopped is the most important thing
  on the page, and hiding its detail is a ruling, not a restyle.
- **STEP 5's part of the shell**: the Fraunces preload swapped for Plex Mono
  500, the theme-color metas and the manifest colours, the phone's m.css
  pass. As STEP 1 recorded.
- **The theme button keeps its word** ("◐ system", "☀ light", "☾ dark"), not
  an icon alone: the word says which of three states it is in.
- **Both skins, found and not fixed:** app.css's print rule has never hidden
  the old skin's controls (setHeader() writes `display:flex` inline on
  #filters on every render). #tzNote says nothing to a reader in Dubai, as
  before; the masthead now says "Dubai time" to everybody under the skin.
- **Channel names inside the livebar's notes** (FARES_LAG's "Uber") carry no
  swatch; the mockup gives them one. The notes are the shared sentences from
  today.js, used by the phone too, and a swatch inside them is the page
  phase's.
- `rowMark` / `chanChip` are still not built (STEP 3 named them).
- **Two suites fail between 20:00 and 24:00 UTC** (Dubai's new day, UTC's old
  one), at HEAD as on this branch: `payout_scope` (2) and `phone_today_only`
  (3, the mock's "today" is UTC's). Not this step's; found by its full run.
- `npm run audit:pages` (production, every window): 64 views and 219 endpoint
  calls a window; the same 8 views "unreached" in each — POST-only endpoints
  the audit asks with GET (`/api/ledger/receipt`, `/api/finance/payouts/verify`,
  `/api/same-person/decide`, `/api/hr-roster/preview|commit`,
  `/api/ledger/import/preview|commit`) and `/api/corporate/property` without an
  id. API-level and unchanged by a shell step; the audit tool's own noise.

## Arkiv reskin — the review's six findings, fixed — 2026-09-23, NOT ON PRODUCTION

The workflow's adversarial review of `reskin-foundation` (e98d5f4..3e2f21c)
found six real defects. After merging the FMS work in (`8555139`), each is fixed
and proven by revert: the fix is undone, the test fails, and the file is
restored with its md5 checked.

| # | what | state | proof |
|---|---|---|---|
| R1 | A stale #overview render wrote its colophon into the shell's #pageFoot under the next page. `freshView()` leaves the old node with id="view", so `host.closest('#view')` matched the detached node itself. Fixed twice: `pageFoot()` refuses a host that is not connected, and `overviewContract` checks `alive(gen)` after its eight fetches | **written** | `page_contract` §4b, run in a browser: the leaderboard fetch is held, the reader moves to #settings, then the fetch is released. Reverts: pageFoot guard alone fails 1; `alive(gen)` alone fails 1 (the source check, tightened so its lazy match cannot reach a later function's guard); both together fail the browser check, `{"colophon":"…bookings counted…"}` |
| R2 | Marks that come out the same colour under Arkiv. (a) A donut whose graphite slots repeat or fall within 5 ΔE of the fold draws as labelled bars (`--mk-ring: distinct`, `charts.js ringDistinct`, and `donut()` returns the form it drew). The two "click a slice" captions follow the form. (b) On #live, a stale fix is a hollow ring, not a faded fill (`--mk-stale: hollow`); the legend swatch matches. The old skin declares `always` / `fade` | **written** | `chart_marks` §5 and §5b. Threshold measured over every graphite pair: collisions 0 / 1.3 / 2.8, the closest pair used on purpose 7.6, adjacent steps 9.9–11.2 in dark. So the threshold is 5, not 10. Reverts: Arkiv `always` fails 3; threshold 10 fails the dark six-slice ring; map ignoring the form fails the hollow-pin check |
| R3 | The driver rating chip's text was 4.24 / 3.94 / 3.99 : 1 under Arkiv. The figure is ink now, and only the arrow (its own `.rt-g` span) is toned | **written** | `arkiv_skin` §7b, light and both dark modes: 16.26 / 15.27 light, 14.41 / 14.47 dark. The old skin still draws the whole chip toned. Revert fails 6 and reproduces the review's exact ratios |
| R4 | Merge conflicts with the FMS branch: main's wording kept, with `--grey` for the retired `--ink-3` | **done** in `8555139` | tokens, occupancy_sources and money_precise green on the merged tree |
| R5 | STEP 0 changed production's look unasked: in old dark mode, the chosen deposit chip, the phone's primary button and the map/driver pin ring went from white to near-black. Two role tokens, `--on-fill` and `--pin-ring`, are `#ffffff` in every old theme and point at `--paper` (what `--on-accent` is) under the skin. The suite caught a first version that pointed `--on-fill` at `--on-accent`, an old-skin name: `arkiv_skin` requires every re-pointed name to map onto an Arkiv token | **written** | `tokens` §7. Reverts: chip back on `--on-accent` fails 1; an old dark block moving `--on-fill` fails 1 |
| R6 | `/api/compare/period` answered −100% when the window's own sum was NULL, because `Number(null)` is 0. The Arkiv #overview's delta reason also always blamed the span before | **written** | new `compare_period_absent` (9): window with no fares against a span that has them gives `null`, not −100; the mirror case gives `null`; the page words the reason by the empty side. Revert fails 2, printing `-100` |

### Not done, and named

- **White on the old dark accent stays 2.94:1.** That is production's look (R5),
  and it changes at the flip, not before, unless the operator asks.
- **CABMAN's dark channel colour is 2.84:1 on `--paper-2`.** This is hover only
  (a hovered row or tile), under 3:1 for a mark. The review called it minor, and
  it is left for the channel-colour pass.
- **The evening test failures** (docs/COVERAGE.md traps): `payout_scope` and
  `phone_today_only` fail from 20:00 UTC on main as well.

### On production — deployment `c9bab16` (commit `dbff5b1`), ACTIVE 22:09:20Z

Behind `?skin=arkiv`: the default look is unchanged apart from what the
operator ruled (money to the fils) and the fixes named above.

- **Money to the fils, from the API up.** `/api/compare/period` for the month
  gives fares 981,611.81; `/api/kpis` gives accounted 751,097.75. The current
  look prints AED 751,097.75 and AED 981,611.81, as does Arkiv, and neither
  prints a whole-dirham amount on #overview, #live or #segments (light and
  dark, 1440 and 390).
- **A one-fils scare, resolved.** A first capture printed 751,097.76 in the
  current look against .75 under Arkiv, minutes apart. Re-captured with the
  API at the same moment, both print .75: the data moved between captures. It
  was not a rounding difference.
- **Screens** go through bin/prod-mirror.mjs, with assets byte-identical to
  the origin. `data-skin` is `arkiv` only under the switch. Arkiv draws the
  masthead, section row, banner grid, sticky control bar, livebar and the
  #overview contract with its footer colophon. The credential banner shows in
  both looks within 2 s: 200px in the current look, 252px under Arkiv.

### Open, and named — measured on production after this deploy

- **`/api/unauthorized/attributed` is about three times slower now that FMS is
  in it.** September holds 13,354 segments, 769 of them unauthorized (673 FMS
  trip), after the 21:00Z 30-day pass. Uncached, this month's call took 33.8 s,
  and a two-day window 7.6-17.8 s. On 2026-09-16 (this file, above) the month
  took 11.8 s for 124 rows. The cost grows with the rows it attributes. #segments'
  first uncached load took 77 s, and about 2 s from cache after. `/api/kpis`
  also took 5-10 s uncached at the same time, so part of it is database load.
  Not fixed here; put to the operator.
- **The Arkiv banner fills the phone's first screen** while three credentials
  are stopped. Shortening its detail is the operator's call (STEP 4's note).


## Phone PWA redesign — operator ruling 2026-09-24, NOT ON PRODUCTION

The operator ruled that the phone gets a redesigned PWA, which supersedes the "tokens only" phone shell in docs/UI-REDESIGN-PLAN.md §3. The design note is the plan's new section "Phone PWA — redesign". The work is gated on a token, `--pg-phone` (0 in app.css, 1 in m/arkiv-m.css). That sheet is written only for a phone reader under `?skin=arkiv`. Not deployed, not pushed, and the default skin is not flipped.

**How the two claims are held.** `test/phone_harness.mjs` serves the phone with no server: the static files come off disk, every `/api/` answer comes from one recording (`test/fixtures/phone_api.json.gz`, recorded from mockapi.mjs by `bin/phone-fixture.mjs record`), and the page clock is frozen at the recording instant. Under the old skin, `test/phone_classic.test.mjs` requires every phone screen (25 states and the window sheet) to be byte-identical to what commit `abb79ad`, the tree before the redesign, drew from the same answers (`phone_classic_dom.json.gz`, taken by `bin/phone-fixture.mjs oracle`). Under the skin, `test/phone_arkiv.test.mjs` checks each screen as it lands.

| # | what | state | proof |
|---|---|---|---|
| P0 | **The oracle harness.** Hermetic, so it cannot collide with another agent's mock on a shared port, and so the evening clock trap cannot reach it. Off-origin requests are answered with a one-pixel image. Left to fail, a lazy `<img>` turned its avatar into "could not be loaded" on some runs and not others (1 run in 6 before the fix, 0 in 8 after) | **written** | `phone_classic` 34/34 eight runs in a row. With "Who called it off" edited in m/screens.js it fails 2 (today, today+sheet) and prints both strings; the file was restored and its md5 checked (`a1a8de04…`) |
| P1 | **app.css declares `--pg-phone:0`** in the old skin's `:root`, beside `--pg-contract` and `--pg-shell`. Only m/arkiv-m.css declares 1 (P2) | **written** | `phone_arkiv` §0. With the line removed, it fails 2; the file was restored and its md5 checked (`a2b23209…`). tokens 149, type_scale 11 and phone_classic 34 are green |
| P2 | **The phone's sheet, and how it arrives.** New `m/arkiv-m.css` declares `--pg-phone:1`. It is scoped to `:root[data-skin="arkiv"][data-ui="phone"]` and has no hex. index.html's second inline script `document.write`s it straight after arkiv.css, only when the skin is Arkiv AND the build is the phone. `sw.js SHELL_FILES` precaches it. `m/ui.js phoneContract()` reads the token, and keeps the answer until the number of loaded sheets changes | **written** | `phone_arkiv` §0–§1 (29). Reverts: appended instead of written → 3 fail (first paint at 104 ms with the sheet held 1.5 s, against ≥1,400 written) · the write removed → 8 · the SW entry removed → 1 · the token renamed → 3 · written for the desktop too → 2. Each file restored, md5 checked. Green after: arkiv_skin 111, boot_order 5, phone 143, tokens 149, phone_classic 34, assets 40, phone_render 8 |
| P3 | **The shell** (m/app.js, only under the token). The header keeps back, title and ⟳; at a tab's root the wordmark "Fleet" (Fraunces) stands in for the back arrow and leads to Today. The ⋮ becomes a **control bar**: one row of mono capitals naming the window (shell.js `windowWords`, the desktop masthead's words), the channel and the fleet, one tap to the same sheet. A control the screen ignores is said to be ignored, never claimed as covered. #online-time ignores the platform chip because only Uber reports time online, so "every channel" there would be false. The desktop's `appliesSentence()` opens the deck and the sheet. Every screen closes on ui.js `pageFoot()`: the phone's own source line as the basis, the principle, and a colophon ("This month · Dubai time"). The `theme-color` metas take the resolved `--paper`. The tab bar marks the lit tab with an ink rule; controls are 44px squares. `/shell.js` joins `SHELL_FILES` | **written** | `phone_arkiv` §2 (36 new, 65 total). Reverts, each failing as named: wordmark left on deep screens → 1 · separator before the part (a dot opening line 2 at 360px) → 1 · no chrome colour → 3 · no applies sentence → 3 · the old source line instead of the footer → 5 · channel always named → 2 · More given a window → 1 · a silent sheet → 1 · 40px header controls → 1. Files restored, md5 checked. Green: phone_classic 34, phone 144, tokens 149, phone_render 8, phone_clock 14, phone_today_only 19, boot_order 5 |
| P4 | **The component vocabulary** (m/ui.js, CSS in m/arkiv-m.css §3–§10, only under the token). A card becomes a ruled, numbered section: a 1.5px ink rule, and a mono head numbered from the deck's counter, the counter the desktop's panels use. The lede becomes the statement band: an ink rule, 3px and semantic when toned, with a dot before the claim. Tiles get hairline column rules, a mono label and ink figures (L4). A new hero option spans the row at `--d5` with the one highlight (ui.js `highlight()`). A tile with no figure prints its **reason in the value slot**, marked absent, never a dash over a grey sub-line; the highlight is refused on it. New `atGlance()` puts the desktop's `secHead('00', 'At a glance', note)` over them. Rows lose the box; the figure is mono and ink, and the tone is a class (`t-<tone>`) drawn as a dot, not an inline colour. The dot follows ruling 1 everywhere (hollow = warning; solid red = bad/critical; solid green = good), each with its screen-reader word. The segmented control, chips, search and inputs are square, 44px, and the chosen one is an ink fill. Share bars are ink and ranked, not `--s1..--s6` cycled by position (L1). The sparkline is restyled to 2px ink by CSS, since CSS outranks an SVG presentation attribute, so the shared function is untouched. Faces become square plates. **New test sweep (§9):** on all 25 screen states, every word the old screen printed from the same answers is printed by the new one; nothing goes sideways at 390 or 360; every control is ≥44px (credentials excepted until it converts, P-next) | **written** | `phone_arkiv` §3 (26) and §9 (7), 98 total. Reverts: row tone back to inline → 3 fail · bars cycled → 2 · no reason slot → 2 · no hero highlight → 1 · warning dot solid → 3 · figure colour off `.m-stat .n` → 1 · segments at m.css's 40px → 3. First proved nothing: the toned-tile ink rule was redundant under the base rule (0,5,0), so it was removed and the base rule is the one proven. Files restored, md5 checked. phone_classic 34 |
| P5 | **Today.** The today card becomes the **livebar**: unnumbered, with an ink dot before its name, like the desktop strip. Its caption now says it does not follow "the window or the channel in the bar above", because the control bar makes that question visible. **Latest booking** becomes one of its figures (the desktop livebar's cell), and Trip value carries the strip's own 3px-rule emphasis. The window's statement and tiles become **00 At a glance**, above the chart rather than below it, with Bookings as the hero. The sections are numbered. The screen closes on **† What this screen does not know**: unpriced bookings, bookings with no distance, and unmapped outcomes when there are any. Each uses the desktop #overview's own reasons, word for word, built on ui.js `UBER_FARE_WHY`, and a test fails if the phone's copy drifts from app.js. Every other figure and sentence is unchanged | **written** | `phone_arkiv` §4.1 (20), and §9 on the whole screen. The words check now compares with spaces removed, so a sentence that became a figure and its label ("Latest booking 04:59." → LATEST BOOKING / 04:59) still counts as kept. Reverts: no livebar class → 5 fail · no Latest booking tile → 2 · no reorder → 1 · a reason reworded on the phone alone → 1. Files restored, md5 checked. phone_classic 34, phone 144 |
| P6 | **Money.** 00 At a glance (the statement, then the four tiles, Trip value the hero) sits above the day line. The sections are numbered. A **swatch beside each channel's name** under By channel (ui.js `swatch()`; the name stays ink, L5.6). **†**: the bookings Trip value is not over (the screen's own priced count, in the desktop's sentence); "Money in, day by day: No series", in the desktop #overview's reason, word for word; and the bookings no settlement route describes, when there are any, from the screen's own caption | **written** | `phone_arkiv` §4.2 (8). Reverts: no reorder → 1 · no swatch → 1 · the priced count taken from `/api/kpis` instead of the screen's own → 1 · the settlement-route cell dropped → 1. That last one first proved nothing, because the recording holds no unrouted booking. The test now asks a copy of the recording that does, and fails. Files restored, md5 checked |
| P7 | **People.** The search and the sort stay first, as the list's controls. The list gets its own numbered head, naming how many people the window holds (the leaderboard's own count; the old screen said it only in the cut line at the foot). Rows use the component layer (square face plates, mono figures). **Found and fixed under the skin:** three empty states (People, Fleet, Corporate) told the reader to "widen the window from the ⋮ menu", and the redesigned shell has no ⋮. Under the token they say "from the bar above"; the old phone keeps its words | **written** | `phone_arkiv` §4.3 (4), including a copy of the recording with an empty leaderboard, in both skins. Reverts: no head → 2 · the ⋮ wording under the skin → 1. Files restored, md5 checked. phone_classic 34 |
| P8 | **Fleet.** As People: the search and the sort first, then the list under its own numbered head, naming how many vehicles the window holds (/api/vehicles' own count). Every row keeps its live state from /api/live (moving, stopped, stale fix, not reporting) | **written** | `phone_arkiv` §4.4 (3). Revert: no head → 2 fail. File restored, md5 checked. phone_classic 34 |
| P9 | **More.** Analyse, Operate, On the desktop and This app are numbered sections. "This app" carries the masthead the header has no room for: the wordmark in Fraunces, and "Ecosine & Egari · Dubai" in the desktop masthead's words. The way to the desktop is a full-width `.m-btn`, the form every action on the phone takes (defined here for all of them: square, ink-ruled, 48px, primary an ink fill). **Found and fixed:** the footer's colophon asked `windowWords()` on its own, so More said "No window applies here" in the bar and "This month · Dubai time" at its foot. Bar and footer now share one `windowOf()` | **written** | `phone_arkiv` §4.5 (4). Reverts: the colophon back on `windowWords` → 1 · no masthead/button → 2. Files restored, md5 checked. phone_classic 34 |
| P10 | **Live.** The four counts become 00 At a glance, with Reporting as the hero. The head names the feed's own clock, "newest fix HH:MM Dubai", the latest `polled_at` in the answer, which the old screen left a reader to find row by row. Stale fix keeps its tone as a dot. **New `rowMark()`** (m/ui.js; SPEC §4's row marker): each car carries a 3px rule in the gutter in the identity of the feed that saw it (CABMAN or FMS). The name stays in the sub-line and the plate stays ink. A name that is not one of the six channels marks nothing (L1) | **written** | `phone_arkiv` §4.6 (6). Reverts: no marks → 1 · no glance → 3 · `rowMark` marking any name → 1. That last one first proved nothing, because the recording holds only known feeds; a named-feed check was added. Files restored, md5 checked. phone_classic 34 |
| P11 | **Safety.** 00 heads the statement directly. The statement is the glance, and by ruling 7 its figure is not repeated as a tile. By kind is drawn as ranked ink bars (P4); By vehicle is a numbered section. **Found:** `/api/alerts/summary` failing was caught into an empty list, and the screen then said "No harsh-driving event in this window — Nothing to review.", a zero over a figure nobody measured. **Under the skin**, a failed summary now says it could not be fetched. The old phone keeps the defect, because it is held byte-identical until the flip — **named for the operator** | **written** | `phone_arkiv` §4.7 (3), including a recording with the summary removed. Reverts: the failure read as zero again → 1 · no 00 head → 1. Files restored, md5 checked. phone_classic 34 |
| P12 | **Unauthorized.** 00 heads the statement. The verdict tiles carry no hero, because the statement's figure is the headline (ruling 7). The coverage note ("Only N of M days … carry seat evidence …") moves **directly under the claim it qualifies**; after the tiles, "21 trips" had already been read as 21 over thirty days. Each row carries its provider's mark (CABMAN, or FMS for both of FMS's counts), and the provider's words stay in the row. **Found and fixed under the skin:** the list drew 40 rows of up to 300 under "Every one of them" and never said so. It now says "The 40 most recent of N rows the list returns" (the route orders newest first and stops at 300; that is noted when it is hit) | **written** | `phone_arkiv` §4.8 (5), including a recording with 55 rows. Reverts: the note left after the tiles → 1 · no cut line → 1 · FMS rows unmarked → 1. Files restored, md5 checked. phone_classic 34, phone 144 |
| P13 | **Sources.** 00 heads the statement. The collectors become a numbered section, "Every collector". Each collector feeding one of the six channels carries that channel's row mark (`uber_fleet` is Uber); any other ("ledger", "events") is marked by nothing (L1). **Found and fixed under the skin:** every error was cut at 70 characters with no ellipsis, and the one-line sub-line then cut it again. The reason a source stopped is what this screen exists to say, so it is now printed whole and wraps. The old phone keeps its 70 characters | **written** | `phone_arkiv` §4.9 (4), including a recording with one long error, in both skins. Reverts: the error cut again → 1 · no marks → 1. Files restored, md5 checked. phone_classic 34 |
| P14 | **Corporate.** 00 heads the statement. **Added from the design** (the #corporate mockup's "Kept on the channel" and "Cost filed"), from figures the summary already carries and the statement already names: what the channel kept (fares less what the drivers were paid, on the same bookings) is the hero, beside the cost the channel filed. When the channel files no cost, Kept is absent with the statement's own reason and is never highlighted. Per km and Unpaid approach, which printed a bare dash, carry the true reason in the value slot, from how `/api/corporate/summary` computes them (analytics_routes.js). **Found:** a failed summary read as "No hotel booking in this window". Under the skin it says the fetch failed; the old phone keeps the defect until the flip | **written** | `phone_arkiv` §4.10 (6), including a recording with no cost and one with the summary removed. Reverts: the failure read as empty → 1 · Kept not less the cost → 1 · a bare dash again → 1. Files restored, md5 checked. phone_classic 34 |
| P15 | **Analyst.** 00 heads the statement. The four verdict tiles carry no hero (ruling 7). Each finding keeps its claim and its verdict word, but the verdict tag is **ink, not green or red**. Under the colour law (SPEC L3), green and red mean better and worse and nothing else, and a refuted claim is an answer, not bad news. The finding's inline sizes, which the sheet cannot outrank, become the redesign's classes | **written** | `phone_arkiv` §4.11 (4). Revert: the inline green/red left on → 1. File restored, md5 checked. phone_classic 34 |
| P16 | **Credentials** (the paste; same endpoint and same accept-before-store rule). "Read and test" and "Apply the N that were accepted" become the primary `.m-btn`, full width and 48px. The old ones were 40px chips sized inline, where no sheet can reach, so the §9 sweep's one exception comes off. The paste box takes the redesign's form. **Each provider's reason is printed whole:** the one-line sub-line used to cut "why this was refused" mid-sentence. **"Stored …" takes the good dot**; the old screen dressed good news in the staleness bar's warning colours | **written** | `phone_arkiv` §4.12 (6), with recorded paste answers (one refused with a long reason, one accepted, then one applied). Reverts: the chip back → 3 (including the sweep at 390 and 360) · the reason cut → 1 · "Stored" as a warning → 1. File restored, md5 checked. phone_classic 34 |
| P17 | **Found in my own P4: a tile's reason is the one its screen names.** P4's `stat()` moved whatever a dash's sub-line said into the value slot as the reason. A sub-line is not always a reason: Optimise's Median wait reads "drop-off to next pick-up", which is what the figure measures, and it would have been printed as though it were why there is no figure. That is a reason that is not the true one, which the house rule forbids outright. Now a screen passes `na` where it knows the true reason: Today's card (Trip value, Priced so far, Money in), Today's window Trip value, Money's Per priced booking and Per km, and Corporate's four tiles. A dash without `na` stays a dash, marked absent, with its sub-line kept where it was | **written** | `phone_arkiv` §3 (new check: a definition is never promoted into a reason). Revert (the sub promoted again) → 1. File restored, md5 checked. phone_classic 34 |
| P18 | **Optimise.** 00 heads the statement. The three tiles become two columns, with Idle hours as the hero across the row: three to a row at 390px gave each figure 110px. The When/Where switch, its ranked hours (worth being out for / do not pay) and the place-hours keep their rows and captions, drawn with the component layer's dots (good, bad, warning) | **written** | `phone_arkiv` §4.13 (3). Revert (three across, no hero) → 2. File restored, md5 checked. phone_classic 34 |
| P19 | **Every trip.** The search and the kind stay first, as the list's controls. 00 heads the count. Each booking carries its channel's row mark, and its name stays in the row. **Found and fixed under the skin:** the pager called `window.scrollTo()`, but on the phone the deck scrolls, not the window. On a page already seen, which the stale-while-revalidate store returns at once so nothing clamps the scroll, "‹ Newer" left the reader at the foot of the rows they had asked to read from the top (measured: 2,555px down, before and after). The redesign scrolls the deck. The old phone keeps the defect until the flip — **named for the operator** | **written** | `phone_arkiv` §4.14 (4), with a recorded second page. Reverts: `window.scrollTo` again → 1 (2555 → 2555) · no marks → 1. The first form of the pager check proved nothing, because on an uncached page the skeleton shortens the deck and the browser clamps the scroll anyway; it now returns to a cached page. Files restored, md5 checked. phone_classic 34 |
| P20 | **Online time (the call list).** The day and start pickers and the To chase / Cannot judge / Everyone filter stay first. The call list keeps its order, rows, tel: links, one reason per grey state, and no-phone count. **Added above it, from what `/api/online-time` already answers:** 00 At a glance, then the statement, then tiles. On time says how many were proved by a trip, not a timeline. Cannot be judged lists the grey states it is made of and how many of them drove anyway. Drove is out of those allowed to take work on Uber, and on another channel only. The not-asked warning and the feed's own clock follow. All of it is in the desktop page's own words; they are built inside `renderOnlineTime` and cannot be imported, so a test fails if the copies drift. Late is the statement's figure and is not a tile (ruling 7). With no start time, On time is absent with the reason, never zero. **Found:** my 00 head's −8px margin, meant for the deck's gap, drew the statement's rule through the head inside the call list's body and the trip list's host (P19). Negative margins now apply only to the deck's direct children, and the §9 sweep fails any head overlapped by its next block | **written** | `phone_arkiv` §4.15 (18), including a recording with no start time, and the §9 overlap check at 390 and 360. Reverts: no glance → 7 · the phone's words drifting from the desktop's → 1 · a zero with no start time → 1 · the −8px back on every head → 2 (Trips and Online time). Files restored, md5 checked. phone_classic 34, phone 144, online_time 74 |
| P21 | **To the bank (payouts).** 00 heads the last wire's statement and the tiles. To the bank is the hero, at the long step, so a figure with decimals and its currency keeps to one line at 360px. The transfers and the comparisons (what the platform said it sent, against what landed) keep their order and their rows, and each carries its channel's row mark; the platform names carry their swatches. **Moved, not dropped:** the transfers that could not be compared, one kind per channel and fleet, and the card "What we have not asked Uber about", used to be captions and a card at the foot. Under the skin they are cells in the † band, each one with its count and the old sentence word for word as its reason. Each label carries its fleet as well as its channel, because "Not compared — Bolt" printed twice reads as the same figure printed twice. The old phone is unchanged | **written** | `phone_arkiv` §4.16 (7), and the §9 sweep finds every old sentence in the new deck. Reverts: no band → 4 · the hero not at the long step → 1 · labels without the fleet → 1. Files restored, md5 checked. phone_classic 34, phone_arkiv 205 |
| P22 | **Cash handed in (the only write).** The same five steps in the same order — Recorded by, From, Amount handed in, Photograph of the receipt, Note — numbered 01–05 by the deck's counter. The same targets: supervisors and search hits 44px, the amount 56px, both buttons 48px, the save an ink fill in both themes. The fields, the hits (one ruled list), the chosen driver (edged in ink like a chosen chip), the photograph and the server's quoted sentence (on a 3px ink rule) are square; the browser's "Choose File" becomes the house's outline button. **Added:** each state line says how much it matters, as ruling 1's dot, with the old words unchanged and in ink. A hollow dot marks an unfinished form: a field missing, an amount that is not money, or a photograph that could not be read. It also marks "Nothing is recorded yet." after the check, which the old phone printed in the same grey as a file size. A solid dot means the server refused the receipt or the entry, or the save failed. The good dot means "Recorded.". The old phone draws a missing field and a refused save in the same red, and everything else in grey. It is unchanged. The same entry reaches the server from both skins, byte for byte: the receipt, the dry run and the commit. **Found and fixed for every search box:** arkiv.css's focus ring landed on the bare input inside `.m-search`, drawing a box inside the box; it is now on the box (`:focus-within`). Also in this commit, a test-only fix: §4.12 waits for what the paste draws, because `settle()` once found the network idle before the POST left (trap in COVERAGE.md) | **written** | `phone_arkiv` §4.17 (13). The flow is driven end to end on both skins and in dark mode, with a refused save, and both POSTs are answered by the test. Reverts: no form CSS → 5 · no tones → 2 · a refusal drawn as a warning → 1 · "Nothing is recorded yet." without its dot → 1 · the ring back inside the box → 1 · tones on the old phone → 1. Files restored, md5 checked. phone_classic 34, phone 144, deposit_ui 43, tokens 149 |
