# Handoff — where the fleet dashboard stands, 2026-10-20

Written 2026-10-20 (about 04:45 UTC) by a fresh session whose only job was to
work out what the previous session ("Ecosine/Egari fleet tracking APIs",
2026-08-21 → 2026-10-19) did and what it left. **Read this before the other
standing notes; it tells you which of them are out of date.** It does not
replace them — FIX-STATUS.md is still the ledger, COVERAGE.md still owns the
providers and the traps — it reconciles them against code, git and
production as of this date, so the next session does not have to.

Everything below was checked against HEAD `e542bdb` and against production
with cache-busted GETs (`&_=$RANDOM`), unless it says "unverified". Nothing
here was checked behind sign-in or against the DigitalOcean API (no token in
this environment).

When you change something this note lists as pending, strike it here **in
the same commit** — or delete the row — so the note does not become the next
stale document.

---

## 0. Do these first

| # | what | why now | who |
|---|---|---|---|
| 0.1 | **Both Bolt portal refresh tokens expire 2026-10-20 09:18:15Z (Ecosine) and 09:19:57Z (Egari)** — 13:18 / 13:20 Dubai. | After that Bolt trips and fares stop for both fleets until new tokens are pasted. They last exactly 7 days and cannot be extended. | **Operator only** — standing rule: never sign in to the Bolt portal interactively. Capture one fleet, paste it in Settings, then check the *other* fleet's token still works before capturing it. That also settles COVERAGE's open question of whether one owner's sign-in kills the other's (the two were minted 102 s apart on 10-13 and both survived the week, which suggests not). Re-check expiry with `GET /api/settings` (expiry fields only; never print a value). |
| 0.2 | ~~LPG not deployed~~ **Done 2026-10-20:** LPG1–11 are on production and proven (FIX-STATUS LPG, deployment `9cf3fe85`). | — | ~~The page's speed~~ **Done 2026-10-20 (FIX-STATUS LPS):** `/api/lowperf` is cached under a key that carries the target; the default view answers in 0.3–0.6 s (was 6.2–7.7 s), and the page opens in 4.96 s on desktop and 1.82 s on the phone (was 12.4 / 12.2 s). |
| 0.3 | **Deploying needs a DigitalOcean token, and none is stored.** The operator pasted one into the 2026-10-20 session; it lived only in that session's scratchpad. | Checked through the API: the `fleet-dashboard` app builds two components, the `api` service and the `collector` worker (both `basic-xxs`), from `claude/ecosine-egari-tracking-apis-rf9ong`. **`deploy_on_push` is off on both, so nothing deploys on a merge.** | Get a token from the operator for each deploying session, kept outside the repo; suggest they revoke tokens pasted into chat. Then `POST /v2/apps/$APP_ID/deployments` with `{"force_build":true}`, poll that deployment id to `ACTIVE`, and compare `services[].source_commit_hash` and the `sw.js` fingerprint (§9) with the branch. |
| 0.4 | Production is at `8fac6dd` (deployment `cb6407aa`, 2026-10-20 12:12Z): PRs #4–#14 merged and force-built. `NTFY_TOPIC` is an app secret on the api service (set through the DO API; the value is held outside the repo). | — | Merge work into the production branch through a PR, then force-build (§0.3). |
| 0.6 | ~~ntfy phone alerts~~ **Live 2026-10-20** (FIX-STATUS NTFY): the banner's verdicts are pushed when a row changes, and the run clock is fixed (BCL). The first message reached the topic at 12:06:31Z. | The topic is a secret: the app env holds `NTFY_TOPIC`, and the Settings page can override it. It is never in the repo. The operator subscribes in the ntfy app. | NT6 ("At risk" wording) has been on production since `cb6407aa`. The operator still has to subscribe to the topic in the ntfy app. |
| 0.5 | **The operator has an unanswered question from 2026-10-19 14:29Z** (garage history, §5). | They asked for the garage audit, plan and build to come straight after LPG. The session asked how the existing garage history should reach production and got no answer, because the session died. **2026-10-20:** the two source files were re-supplied (session uploads; the log is also a live Google Sheet), the distinct invoices reproduce at 239 / AED 423,841.96, and a printable six-garage price sheet was made (GARAGE-PLAN.md, "The work done most often"). The import-route question was put again and is still open. | Ask again, in the same terms (§5). |

---

## 1. The state in one table

| | where it is |
|---|---|
| HEAD | `e542bdb` (2026-10-19 14:26Z). `claude/ulm-access-control`, `claude/ecosine-egari-tracking-apis-rf9ong` and `claude/practical-galileo-p92zg8` all point at it. Working tree clean. 1,180 commits since 2026-08-21. |
| Production | `6368228` (deployment `32850f02`, 2026-10-20 07:01Z): everything through the CABMAN table is live. `sw.js` serves `fleet-936fdefe51ad`. Before that it was `86d0f5e` (deployment `c602a386`, 2026-10-19). |
| How to tell which commit is live | Production does not expose a sha (`/api/health` is `{ok, migrating}`). It does stamp `sw.js` with `VERSION = 'fleet-<first 12 hex of sha256 over api/public>'` (`api/server.js` `shellHash`). Recompute that for a commit with the recipe in §9 and compare. `86d0f5e` → `fleet-c8696f07a063`, which is what production served on 2026-10-20; `e542bdb` → `fleet-0a44fa83522e`. **Limit:** this only sees the front end. A deploy that changes only server code leaves the hash alone, so for API changes check a field the new code adds (LPG adds `avg_active`, `causes`, `weekdays` to `/api/lowperf` rows). |
| Collectors | Running (`/api/status`: incremental 04:01Z, CABMAN 04:15Z on 10-20). |
| Access control (ULM) | Built and deployed (`a1429529`, 2026-09-28) but in **open** mode. `/api/auth/me` → `mode: "open"`. Anonymous readers get every page (§6.1). |
| Identity register | 461 entries over 237 people, PENDING 0, REFUSED 3. `test/identity_register_counts.test.mjs` passes 16/16, and `node bin/gen-schema-v53.mjs --check` matches. CLAUDE.md's counts are right. |
| Migrations | 109 files (`schema.sql` + `schema_v2`…`v110`; v60 never existed). v110 = `alert_state`, the ntfy watcher's memory. All registered in `src/schema_files.js`, in order, none missing (checked mechanically). |
| Tests | **386** `.test.mjs` files plus 15 helpers (2026-10-20, with `ntfy_alerts`). CLAUDE.md carries the same count. |

---

## 2. The previous session — what it was and how it worked

- **Session** `session_017PxcnnMZS9YdEgsRQYy4oM`, titled "Ecosine/Egari fleet
  tracking APIs", 2026-08-21 → 2026-10-19, one continuous session, compacted
  at least 14 times between 10-06 and 10-19. Its status is now PENDING with
  `last_init_error` "Setup script failed" (`recoverable: false`); **it cannot
  be resumed.** Continue in a new session.
- **Why it died.** At 15:25:54Z on 10-19 the queued task notifications from
  its own suite run woke it. That was not an operator message. A new container
  was provisioned, and the environment's setup script failed:
  `/tmp/init-script-…sh: line 13: Do: command not found`, exit 127. New
  sessions in the same environment (`env_01AnYgw9PCRHqMs6JBdgzs3c`) do start,
  this one included, so nothing needs changing in the environment except the
  lost deploy credentials. If a session ever fails to start the same way, look
  at line 13 of the environment's setup script in the claude.ai environment
  settings. It is not in the repo.
- **Working pattern, worth keeping.**
  - Commit to `claude/ulm-access-control`, then push the same commit to
    `claude/ecosine-egari-tracking-apis-rf9ong` (the branch production
    builds).
  - Run the full suite in a separate worktree, one run at a time.
  - Deploy with a forced build and poll it to `ACTIVE`.
  - Prove on production with cache-busted curls plus screenshots through
    `bin/prod-mirror.mjs` (:8200).
  - Record all four states in FIX-STATUS.md.
- **The operator's style.**
  - Short asks: "audit, plan, explain before execution", "don't change codes",
    "be cautious about token expense", "stop doing things that I am not asking
    you to".
  - Rulings often come as answers to multiple-choice questions.
  - Screenshots, and Excel or PDF deliverables for reports.
- **Recorded cost** by 10-19: about $3.4k on the last turn's counter. The
  session metadata's counter reads higher; they measure different things.

---

## 3. What has been built (dated, so you can find the commit)

Phases from the git history. Every item is on production unless §4 says otherwise.

| dates | what landed |
|---|---|
| 08-21 | API reference docs (`docs/*.md`), the containerised collector with a year backfill, CABMAN GPS every 5 min, the whole first UI, hotel source, Settings, unauthorized-trip detection, insight engine, vehicle–driver custody, map + replay (Leaflet), per-driver and per-vehicle pages, raw-field inspector, LLM findings judged by the DB. |
| 08-22 → 08-25 | 10-pass audit + `bin/live-audit.mjs`; Uber earnings collector fixed; revenue by channel; performance pass (rollups, caches, indexes); statement-vs-bank money; Settlement; 5 months of FMS telematics recovered; unit economics; top/low performers. |
| 08-26 → 08-31 | Egari payouts/earnings; credential banner; CSV export; both Uber logins; Uber availability; "a verdict on every page"; driver's day; supply vs demand; "Who exactly?" drill-down; MiniMax analyst; phone PWA; credential paste with auto-identify; provenance lines; resumable backfill; Uber rating/ban/papers. |
| 09-01 → 09-08 | FIXLIST fixes 1–49; Dubai clocks everywhere; identity duplicates begin; Uber contacts/photos and per-trip fares; the **FIXLIST-2026-09-05 audit** (258 findings) and **redaction** (Batch 1); FIX-STATUS started; Finance receipts register; phone-number identity joins; Yango key API; "Money in" = gross. |
| 09-08 → 09-19 | Trip value; Online time page; Uber realtime feed shape solved (not collected); Tesla attempt (blocked, page removed 09-15); cancellations; better-or-worse; live status + review queue; bank-wire payouts register; custody by the hour (last-holder rule); payouts on the phone. |
| 09-21 → 09-25 | Driver ledger (current account, cash, receipts, salary, advances, Money tab); the **person spine** (`src/persons.js`); year-on-year forecast; Bolt balance ledger; HR roster; FMS as a seat sensor in unauthorized detection; **Arkiv redesign** (tokens, shell, contract, dark mode, pages P1–P77, phone PWA P0–P27, phone default); renamed **FleetMirror**. |
| 09-26 → 10-02 | **ULM** sign-in and access (designed 09-26, built and deployed 09-28, open mode); fleet names from the platforms; SMSala SMS (reset codes, 05:00 cash text, unbooked-journey text); money workbook; Yango console once a day + weekly rebuild + gross→net restatement; 07:00 daily report email (GLM 5.2); median page time 2.3 s → 0.9 s; 08:00 cash and low-trips emails; monthly report; revenue target + Today panel + workbook. |
| 10-05 → 10-08 | Phone Today against target; SPD performance work; Egari hotel account; **goal texts** (13:00/18:00 Dubai, DRY RUN); `#feeds` "receiving no data" count (both skins); **Egari's own CABMAN login** (5 Teslas now receiving); Uber fares retried at 09:00, then hourly; **Month target** page; operator's identity review, register 132 → 460. |
| 10-09 → 10-16 | **Chat assistant** (BytePlus ModelArk Seed 2.0 Pro, read-only, 24 h wipe, then a second reach: hours, positions, money, where a car was); weekday-weighted target (Mon 0.94 … Sun 0.78; October target AED 1,795,786.01 kept); Yango reduced-mode banner; Shajahan and Mohammad Shahin merges (461 entries); driver day page rebuilt (Kashif's ask); vehicles audit + **GARAGE-PLAN.md** (docs only); vehicle truthfulness **V1–V12**; Uber online-by-hour stored (UOH); unbooked journeys on Activity/day pages (UNA); cancelled bookings are not rides (NB); `#compare` hour by hour. |
| 10-19 | **Low performers** tab rebuilt with watch lists (LP, `ba5090b`→`86d0f5e`, live, matches Month target with 0 differences over 83 people). Then **LPG1–9** (`e542bdb`), not deployed (§0.2). |

Off-repo deliverables the operator received (files, not code): bottom-45
reports (PDF, 10-12 and 10-14), an Excel reissue plus a Tue-vs-Thu delta PDF
(10-16), and a day-by-day landscape PDF (10-19). Their generator scripts lived
in the old scratchpad and are gone. The Low performers page and its Excel/print
export (`/api/export/lowperf.xlsx`) now cover the same ground.

---

## 4. Pending — reconciled against code, git and production

### 4.1 In flight (the previous session stopped mid-way)

- **LPG: fixed, deployed and proven, 2026-10-20** (FIX-STATUS LPG, and the
  "Deployed and proven" paragraph under CST). The page's speed was fixed
  and proven on production the same day (FIX-STATUS LPS).
- **What still costs a desktop page its first seconds** (measured
  2026-10-20 opening #low-performers through `bin/prod-mirror.mjs`): about
  2.7 s loading ~90 ES modules (the mirror fetches each from production, so
  a real browser with its service worker is faster), then `/api/auth/me`,
  0.5–3.1 s from outside against 0.3–0.4 s for `/api/health`, which every
  desktop page waits on before it routes. For an anonymous reader it is one
  read of `fleet`, cached 60 s (`api/access/service.js allFleets`), so the
  spread is a wait for a database connection; measured in the first minutes
  after a deploy, while the boot warm pass runs every window. **Re-timed at
  rest (08:05Z, 20 min after the deploy): 0.28–0.73 s, the same as
  `/api/health` (0.46–0.74 s)**, so it is not a problem of its own. The
  desktop then drew #low-performers in 6.1 s and the phone in 2.3 s. The list
  answered in 0.2–0.3 s; the rest was module loading through the mirror.
- **One `stale` read of `/api/lowperf` took 5.1 s at rest** (1 of 5;
  the others 0.34–0.71 s). A stale serve computes nothing, so the wait was
  before it. Every request waits for the target salt query, and the version
  re-read every 30 s, on the shared 8-connection pool (`src/db.js`). The
  stale refresh behind the previous reader runs the list's dozen aggregates
  on that same pool. That points at a connection wait, though it was not
  measured. If it recurs: memo the salt in-process and have the three save
  routes (target, trips-a-day, weights) clear it. That is exact while the
  API runs as one instance, which it does (`basic-xxs`, one container).
- ~~The Drivers page and its Excel disagree~~ **Fixed and proven on production 2026-10-20** (FIX-STATUS DRX): 0 differences row for row over three windows; one driver's page equals their file, cash included. Two things remain:
  - **A name ruling for the operator.** The Drivers list (longest account name), the driver page (longest spelling across every record) and the person record can still spell one person three ways. Each Excel follows the page it came from.
  - **An efficiency point.** "Excel ⤓ this driver" computes the whole Drivers page to read one row: about 2.5 s for a month, 22 s at 365 days.
- **A cache hit carries no route `Cache-Control`** (the review of LPS): a
  route's own `private, no-store` is set only when the route runs. Harmless
  under open mode's deliberate policy; a ruling for the operator if
  sign-in becomes required, and a three-line change in `api/cache.js` if so
  (FIX-STATUS LPS).
- **Watch lists** (LP-5) are deployed (`schema_v109`) but have never been used.
  `/api/lowperf/watch` → `{lists: []}`. Saving needs a signed-in Owner or
  Operations manager, and nobody signs in (§6.1). The 14-Oct list was never
  rebuilt as the first watch list, and it was never checked against the PDFs
  (AED 384,724.59).
- **Garage build** (GARAGE-PLAN.md). Step 1 (V1–V12) is deployed. Steps 2–5
  (the garage record, the views, the "off the road" day state) have **not
  been started**:
  - `sql/` has no garage tables;
  - `access_model.js` has no GAR class;
  - `VEHICLE_TABS` (`api/public/vehicle.js:28`) has no Garage tab;
  - the "a workshop visit is recorded nowhere" lines are still live at
    `playbook.js:563`, `app.js:2891` and `driver.js:1725`. GARAGE-PLAN cites
    old line numbers (2875 and 1629).

  The operator said "go" on 10-14 08:19 and asked again on 10-19. What blocks
  it is the history-load question (§5).

- **The CABMAN table on `#feeds` (CST, 2026-10-20): deployed and proven.**
  Two independent reviews found 11 and then 9 defects; all were fixed
  (FIX-STATUS CST R1–R11, N1–N8, N2b). What remains is for the operator:
  - **Pads to check physically** (production, 14–20 Oct):
    - reading nobody: L44295, L44259, L45235, L45227, L44286, L27976,
      L64998;
    - missing most passengers: L77059, L12615, L47118, L76092, L46706.
  - **Units silent on working cars:** L44289, L45240, L45232 and L76099.
  - **A unit not moving with its car:** L45243, the dual-tracker car.
  - **Judgement rules are mine, not the operator's:** the pad works at 80%
    or more of bookings; standing still is under 0.5 km on bookings of
    10 minutes or more; hotel bookings are judged generously. The
    operator may want different lines.

### 4.2 Deployed but not proven on production

- **V1–V12.** `/api/vehicles/directory` already carries `last_trip_ever`,
  `cab_days_moved`, `doc_expired_undated`, `device_status` and
  `tracker_source`, but no rendering pass of the vehicle pages has been done
  on production. FIX-STATUS's VF table still says "production: no".
- **Rows with no production proof, deployment confirmed by git ancestry:**
  HTL-1..3, TGS, CE-2, LT-1/2, TRIP-1/2/3/6, SMS-3/5, and F9 (the forecast
  page).
- **ULM per-role proofs** (U3–U18, S1–S5), the Settings-save credential rows
  and paste flow P1–P10. These stand on the local `bin/access-sweep.mjs`
  only, because proving them needs signed-in accounts.
- **Converted Arkiv pages.** About 45 are proven only by the suite against
  the mock, not by a production screenshot each. 16 desktop pages, 8 phone
  screens, the default flip, FleetMirror and the folded banner *are*
  proven.
- **GLM commentary in the daily report.** RPT-6 ✗; MR-5's daily half has not
  been seen.

### 4.3 Blocked outside the codebase

- **Bolt Ecosine entitlement.** The fleet-integration client is not entitled
  to company 142868 (`COMPANIES_NOT_ALLOWED`), so every Ecosine Bolt run is
  partial (still the case at 2026-10-20 04:01Z). Only Bolt can fix this.
  It also blocks HR's Ecosine Bolt id matching (0 of 77).
- **Bolt `getFleetOrders` (long-lived FI route).** It answers for Egari (28
  orders in the 10-19 probe) but is only probed, never collected. Collecting
  it is the only way to end the weekly 7-day token outage; Ecosine also needs
  the entitlement above.
- **Yango console** (fleet.yango.com: weekly per-driver summary, online
  hours). Yandex's edge refuses DigitalOcean's address (HTML 403; checked on
  10-19 against 209.38.223.10), so re-pasting the cookie cannot help; only a
  stable egress or a relay would. The keyed API has recovered from Yango's
  10-11/12 reduced mode: trips are present every day.
- **Tesla Fleet API.**
  - The token expired 2026-09-10.
  - Tesla's auth edge refuses DigitalOcean.
  - The app sits on a personal account, so it sees 0 vehicles.
  - `docs/tesla-support-request.md` is drafted, and nothing records it
    being sent.
- **InfoTrack (FMS) questions:**
  - Does Seat Count include the driver?
  - What does `previousDistance` mean?
  - How does `GetGeofenceInfo` authenticate?
  - What is the `listtype` enum of `GetVehicleStatusList`?
- **CABMAN, other fleets' cars.** The Ecosine interface carries Sahalat, Star
  Skyline and VOLYA cars, all filed as Ecosine. They need linking or
  excluding on `#fleet-names`.
- **CABMAN, dual-tracker cars.** The devices on L44251 and L45243 report 12.7
  and 25.6 km from FMS at the same minute and need a physical check.
- **Hotel history before 2026-07-07 is missing.** That includes the Egari
  tenant's 153 bookings for October 2025. The cause has not been established.

### 4.4 Known defects still in code (checked by grep at `e542bdb`)

- **C21:** `api/supply_routes.js:183-186` builds `bounded` on UTC `iso()`, not `dubaiIso`.
- **C22:** the `#compare` auto-cut (`api/compare_routes.js:88`) ignores collection lag, so a lagging collector still reads as a collapse.
- **C26 / H13 / H26:** one in-memory promise queue (`src/run.js:92`), and the cron `catchUp(30)` / `backfill()` calls pass no `jobId`, so they get no checkpoint and no requeue after a restart. Latency-plan steps 1–3 are not started.
- **C18, half done:** `api/fleet_roster.js` is imported by nothing, so no route reads the departed-plate set.
- **AED 0 for unmeasured money, the root cause:** `api/public/charts.js:1177,1182` (`hbars()`/`barChart()`) coerce `null` to 0.
- **H19 / H91:** an Uber payments download timeout throws the `reportId` away (`src/sources/uber.js:142`). The data has healed (100% of chargeable bookings priced, 2025-04 → 2026-10); the code has not.
- **Not collected:** the Uber live transactions feed (request shape solved, no collector; the nightly probe still sends a GET and gets 404), `analytics-data/query` and `getPerformanceReport`.
- **H5:** no CompanyName check in `cabman.js`.
- **H82:** the "ever seen" channel-veto rule is unchanged, although Yango now delivers.
- **Same person card:** prints "Both filed a phone ending …" even when the numbers disagree (`src/name_proposals.js:132`, `api/public/sameperson.js:82-83`).
- **Open bookings:** an open booking cannot explain a journey, and the journey is not judged again when the booking closes (no pending branch in `src/reconcile.js`). The hotel channel's in-progress status words would need measuring first.
- **Fleet chip:** `/api/segments` ignores it (worked around, not fixed).
- **`person_key` vs the person spine:** `person_key` does not follow the spine; the roster still keys on the register.
- **Yango AED per online hour:** runs high over windows that mix console weeks and rebuilt weeks.
- **Access shaper:** paths with `[key=value]` selectors are not enforced (`api/access/shape.js:42` `parsePath`; about 23 manifest lines use them). Cash statement lines and standing percentiles would leak to roles without that class once access is enforced.
- **Slow endpoints:** `/api/ledger/exposure` takes about 32.5 s cold; kpis/economics at 90 days with a fleet chip take 9–15 s; `/api/unauthorized/attributed` is slow; `/api/lowperf` takes about 4.2 s.
- **FIXLIST highs and mediums:** H1–H118 and mediums/lows 1–122 have never been checked one by one. About 15 were spot-checked for this note. FIX-STATUS tracks them by id only for H65, H118 and 98.

### 4.5 Redesign leftovers (Arkiv)

- **Not built:**
  - `rowMark`/`chanChip` (the 3px channel row marker);
  - hero sparklines;
  - the desktop `theme-color` metas (`index.html:11-12`);
  - the Fraunces preload swap;
  - page-contract branches for `#messages`, `#access`, `#approvals`,
    `#fleet-names` and sign-in.
- **The Classic skin is still held byte-frozen.** `arkiv_classic_frozen`
  replays the old DOM; whether that continues depends on a ruling (§6.5).

### 4.6 Repo hygiene

- **A real Bolt portal JWT sits in a test fixture:**
  `test/credentials.test.mjs:39` (`const REAL`), committed in `9f06bd0` on
  2026-08-22. It expired 2026-08-27, but it is a genuinely signed credential,
  against the hard rule. Replace it with a synthetic `jwt()` fixture; whether
  to scrub git history is the operator's call.
- **Stray files.** `collector/shot.mjs`, `shot4.mjs` and `cohort_veh.json`
  are referenced by nothing and ship in the image.
- **No `.dockerignore`.** `test/`, `docs/` and the 556 KB `mockapi.mjs` ship
  in the image too.
- **No build id on `/api/health`.** Adding the git sha or shell hash would
  make §1's "which commit is live" a single GET.
- **A dead scheduled task.** "Driver timelines — refresh (paused,
  on-demand only)" (`trig_01AWM6…`) has been disabled since 2026-08-26 and
  points at a scratchpad that no longer exists. Delete it only if the
  operator agrees.

---

## 5. The unanswered question (2026-10-19 14:29Z)

After the operator queued the garage work behind LPG, the session asked:

> How should the existing garage history get into production so it shows on the pages?
> - **Load it on deploy (Recommended)**: a migration carrying the consolidated workbook.
> - **Import page, two people**: the plan's four-eyes route.
> - **Import page, Owner alone**.

Nobody answered. Note the conflict before you re-ask. The "recommended"
option puts invoices, amounts, plates and garage names into git history, and
GARAGE-PLAN.md:287-290 records the operator's ruling that history comes in
through the four-eyes import. Put that to the operator plainly. The
consolidated garage-history workbook existed only in the old scratchpad and
as private artifacts. If it is gone, the operator has to supply it again.

The operator's exact queued message (around 14:2xZ) could not be retrieved.
It is known only from the session's acknowledgement at 14:27:40Z: "Noted:
I'll finish the low-performers deploy and production check first, then do
the garage audit, plan and build."

---

## 6. Waiting on the operator

### 6.1 Security (held open by instruction, but say it every time)

- **Access mode is open.** Anonymous `/api/hr-roster` returns all 143 people
  with **full, unmasked phone numbers and emails** (checked by shape only; no
  value printed). `/api/live`, `/api/kpis` and `/api/lowperf` (named driver
  earnings) answer anonymously too.
- **Closing it is the Owner's job:** sign in, invite staff, then set Access →
  Settings → Required. Nothing records that the bootstrapped Owner has ever
  signed in.
- **`admin_gate` fails open** (`/api/admin-mode` → `open: true`), held so
  since 2026-09-05 by instruction: "don't bother with token, we need to test
  everything before we create security fixes".
- **Two proposals are open:**
  - make Emirates ID and licence number on `/api/driver/profile` admin-only
    (one `isAdmin(req)` check);
  - gate `POST /api/same-person/decide`.

### 6.2 Fleet names have regressed on production (new, found 2026-10-20)

- `/api/auth/me` and `/api/fleets` give both fleets `name: null`, `basis:
  'disagree'`, so the pages fall back to the ids `ecosine` and `egari`.
- The cause is in the data, not the code. Bolt's names now arrive as "Dubai
  Fleet ECOSINE TRANSPORTS LLC" and "Dubai Fleet EGARI LUXURY CARS TRANSPORT
  LLC", and the common-leading-word rule in `src/fleet_names.js:298-308`
  fails on the "Dubai Fleet" prefix. When the names were proven on 09-28,
  Bolt Ecosine's names were not there yet.
- `src/fleet_names.js` has not changed since `8537fea`.
- **Fix, either:** an admin picks the names on `#fleet-names` (needs a
  signed-in admin, so §6.1 first), or the rule drops a leading "Dubai Fleet".
  COVERAGE.md:8018 is wrong either way.

### 6.3 Identity rulings

- Binu Abdul Rehman Kunju: Bolt 9770175 appears nowhere in the register.
- The Yango "MUHAMMAD KHALID" card was unlinked on 10-08 and put back in the
  queue.
- Bolt ZAHID KHAN ISMAIL 6633205 was left as "not sure".
- Maimaitiyiming Abduduhaibaier / Abuduhaibaier.
- Zain Hassan Raja Nasrullah Khan / Zain Raja.
- Seven hotel-only or Bolt-only "active" records look like second records of
  drivers who did drive.
- **The Same person queue on production holds 47 pending proposals** against
  398 decided, mostly `similar_name`/`same_name`, with "KHALID" 11 times. No
  doc mentions this backlog, and nobody has classified it.

### 6.4 Operations and money

- **Goal texts.** Switch `sms_target` from dry to on? The code defaults to
  `dry`; the switch cannot be read anonymously (`/api/sms/log` → 401).
- **Goal texts and the low-trips email.** Use the weekday trips minimum (Sun
  10, Thu/Fri 14)?
- **Cash texts.** Keep retrying after 09:00 when Uber publishes fares late?
- **New signal.** Make "Bolt order cancelled at the pickup, then driven
  anyway" a stronger unauthorized-trip signal of its own?
- **Live map.** Should `LATEST_FIX` prefer a coordinate-bearing fix, at a
  cost in query time?
- **Access shaper.** Teach it selector paths (§4.4)?
- **Ledger.**
  - No `ledger_policy` threshold has ever been stored.
  - No `cash_opening` or cash hand-ins are recorded, so cash owed cannot be
    measured.
- **Payslip questions:**
  - Does a driver owe back a toll (Salik) collected in cash?
  - Which gross does a payslip use: 11,461.61 (fares), 10,353.98 (statement
    gross) or 7,614.21 (statement periods)?
  - When does step 7 (the issued payslip) start?
- **Today estimate.** Keep its rounding to the hundred with `.00`, or print
  the model's fils?
- **Target data.** Save a September 2026 target? Supply a public-holiday
  calendar?
- **Hotel history.** Backfill it before 2026-07-07? What is production's
  `BACKFILL_MONTHS`? It is blanked to non-admin reads.

### 6.5 Design rulings (Arkiv)

- **`#receipts`.** Keep "Credited, net of re-filings" (AED 3,397,340.06 across
  kinds) as a headline at all, or make "Set aside as re-filed" the hero?
- **`#map/replay` distance.** It sums straight lines across interleaved
  device streams, giving 5,361.7 km on one car-day. Which figure is right?
- **`#vehicle/overview` Fares tile.** It prints `accounted_fares` under a
  caption describing `k.revenue`'s basis.
- **`#driver/activity` ribbon.** Show jobs in channel identity and the online
  band as a neutral wash (colour law L2)?
- **`#sources`.** Fold "Windows that did not land" to 20 rows?
- **Classic skin.** Keep it permanently as the user switch (the 09-28 ruling),
  or delete it as plan STEP 5 says? This decides whether the
  `arkiv_classic_frozen` and `phone_classic` oracles keep holding the old
  DOM.
- **Per-tier AED/km.** Revisit ruling 5 once every bar can say "priced n of
  N".

### 6.6 Garage inputs (GARAGE-PLAN.md:388-405)

- The garages in use: name, location, and the work each takes.
- The responsible operations person per car (workbook column D).
- The approvers and the threshold.
- Signed price lists ("none as of yet").
- Whether to send InfoTrack its three questions.

### 6.7 ULM-DESIGN §14

Decisions 1–10 are all open:

1. Emirates IDs in the repo and in git history.
2. The sign-in method: password + TOTP only, or passkeys / Google / Microsoft.
3. Teams and leads.
4. Fleet-scoped staff.
5. Who sees full document numbers.
6. The analyst brief with real names.
7. The four-eyes threshold.
8. Sahalat and the other CABMAN companies.
9. Retention of the audit log.
10. Retention of the receipts.

ULM also defers, by design: passkeys/SSO, row-level security and DB roles,
one-fleet readers on the 77 mixed routes, Phase 4 (reviews, dormancy,
watermarks), and settings per connection.

---

## 7. Documents that are stale — do not trust these lines

- **FIX-STATUS.md**, tables and headings that say "pending deploy", "no" or
  "NOT ON PRODUCTION" for work that git ancestry shows is deployed:
  - rows: HTL-1..3 (4321-4325), TGS, SPD-5..13, FD-1, UBF-3, AG-6..10,
    UOH-1..5, UNA, SMS-7, and the VF table (4588-4592);
  - section headings: Ali Abbas, the Arkiv steps, the phone PWA, the HR
    roster, unauthorized attribution, the 09-17 payouts.

  Each needs a production *proof* (§4.2), not a deploy.
- **ULM-DESIGN.md:3** says "design only. Nothing here is implemented". It is
  deployed.
  - :950 says "12-hour idle and absolute": the absolute limit is
    `session_days` 7 (`api/access/service.js:22`).
  - :953 says "192 entries": the manifest has 217. Appendix C was generated
    from 189 routes.
- **UI-REDESIGN-PLAN.md:3** says "Nothing below is implemented". Every step
  is built and deployed, and STEPs 5–6 have no as-built notes.
- **COVERAGE.md:**
  - :7460 (FMS in unauthorized detection) and :7675 (phone PWA) say NOT ON
    PRODUCTION; they were deployed in `89154e9` and `564d636`.
  - :8018, fleet naming, no longer holds (§6.2).
  - The coverage-by-month table is out of date: Uber fares are now 100%
    priced in every sampled month, both fleets.
  - The seat table's "Egari 0 — no CABMAN account" is wrong since 10-06.
  - The report-columns `?fleet=` trap and "Egari's bank wire still
    unmeasured" are fixed (`orgFor`; Egari wires are in the register).
  - "/api/unauthorized/list … still unfixed" is fixed: it now uses
    `custodyRefs`.
- **docs/unauthorized-trips.md:21** says "Egari has no CABMAN DT account".
  That is false since 2026-10-06.
- **collector/README.md and both `docs/*api*.md`** describe 2026-08-21: Uber
  Ecosine only, the Bolt portal blocked, the Yango console live.
- **CLAUDE.md**:
  - "376" test files: corrected to 384 with this note.
  - "Six upstream providers": the code also calls Tesla (blocked), SMSala
    (SMS), GDELT (news), open-meteo (weather), BytePlus ModelArk (the chat
    assistant) and GLM 5.2 (report commentary).
- **Refuted claims, so nobody re-checks them:**
  - "uber_timeline timeline mode last ran 2026-09-11" is a stale label. The
    tick now runs as mode `roster` (`src/index.js:60,211`) and is ok.
  - "Yango switched off orders/ledger" was the 10-11/12 reduced mode, since
    recovered.

---

## 8. The test suite

Full run (`npm test`), 2026-10-20 ~12:30Z, on NTFY (`b413c9c`→`19446bd`): **386
files, 14,305 assertions, 3 files failing**:
- `access_pages`: no Postgres.
- `arkiv_classic_frozen`: the six known Leaflet routes.
- `timezone`: the UTC-day lint flagged api/alerts.js's local `iso(now)`, a
  full timestamp whose name collided with src/util.js's day helper. Renamed
  `stamp`, then 19/0 alone.

`auth_banner`, `ntfy_alerts` and `timezone` were re-run alone on the final
commit.

Full run (`npm test`), 2026-10-20 ~07:20Z, on LPS (`e46d0e5`): **385
files, 14,222 assertions, 2 files failing** — `access_pages` (no Postgres)
and `arkiv_classic_frozen`, the six pre-existing Leaflet routes only
(re-run alone against a fresh `mockapi.mjs`: 147/6, the same six hashes).

Full run (`npm test`), 2026-10-20 ~04:00Z: **384 files, 14,143 assertions, 4 files failing.**

| file | result | cause |
|---|---|---|
| `arkiv_fils.test.mjs` | 79 passed, 1 failed | **LPG**: reference rows print whole dirhams (§4.1) |
| `arkiv_people.test.mjs` | 240 passed, 1 failed | **LPG**: grid shape `[39,19]` (§4.1) |
| `arkiv_classic_frozen.test.mjs` | 147 passed, 6 failed | Six Leaflet routes (`unit`, `unit/nonsense`, `vehicle/L45235/movement`, `map`, `map/replay/L45235`, `unit?days=90&fleet=ecosine`); the same hashes have failed since `834bcb4`. Pre-existing. |
| `access_pages.test.mjs` | NO TALLY | Needs a real Postgres on `127.0.0.1:55432` (as does `signin_page`); this sandbox has none. Environmental. |

**Each failure was re-run on its own** against a fresh `mockapi.mjs`, one at
a time:

- `arkiv_fils` failed again, 79/1, with the same rows.
- `arkiv_people` failed again, 240/1, with the same `[39,19]`.

So the two LPG failures are real, not caused by concurrency.
`access_pages` printed nothing again, as expected with no Postgres.
`arkiv_classic_frozen` failed again, 147/6, with the same six hashes as the
full run, so that failure is pre-existing.

**On the fix (`76325c5`), 2026-10-20 ~05:10Z: 384 files, 14,143 assertions,
2 files failing.** `access_pages` fails for want of a Postgres.
`arkiv_classic_frozen` fails 10:

- the six pre-existing Leaflet routes;
- `low-performers` and `low-performers/2026-09-01..2026-09-20/show.egari`;
- `watchlist/1` and `watchlist/1/2026-09-15_2026-09-22`.

Those last four pages draw the shared grid, so the old skin moved with the
fils, as ruling 2 intends in both skins. Before re-recording I proved the
fils was the only change. Each failing page's written HTML had its
`fils()` figures rounded back to whole dirhams (898, 427, 290 and 290
figures) and the legend's three samples restored, and every page then hashed
back to its recorded value exactly. The four were re-recorded from a clean
`git archive 76325c5` (COVERAGE trap 24), and the test passes on them, 6/6
with `ONLY=low-performers,watchlist`.

The evening-UTC and month-boundary flakes (`payout_scope`,
`phone_today_only`, `forecast_yoy`) passed in this run, which started around
04:00 UTC and not on a month boundary. They will fail again in those windows.

---

## 9. How to re-check any of this cheaply

- **Which commit is live.** Recompute the front-end fingerprint for a commit
  and compare it with production's:

  ```bash
  c=86d0f5e; d=$(mktemp -d); git archive $c collector/api/public | tar -x -C $d
  node -e '
  const {readdirSync,readFileSync}=require("fs"),{join,extname}=require("path"),h=require("crypto").createHash("sha256");
  const ex=new Set([".js",".css",".html",".webmanifest"]);
  const w=d=>readdirSync(d,{withFileTypes:true}).flatMap(n=>{const f=join(d,n.name);return n.isDirectory()?w(f):(n.name!=="sw.js"&&ex.has(extname(n.name))?[f]:[])});
  for(const f of w(join(process.argv[1],"public")).sort()){h.update(f.slice(f.indexOf("/public/")));h.update(readFileSync(f))}
  console.log("fleet-"+h.digest("hex").slice(0,12))' $d/collector/api
  curl -s "https://fleet-dashboard-wpeqb.ondigitalocean.app/sw.js?_=$RANDOM" | grep -o "fleet-[0-9a-f]\{12\}" | head -1
  ```

  For server-only changes, check a field the new code adds (§1).
- **Credential health without printing a value.** `GET /api/settings` gives
  expiry and `updated_at` metadata. `GET /api/auth` gives per-credential
  states (`ok`, `unentitled`, `blocked`, `unknown`). Then:
  - **Uber web cookies** were last pasted 2026-10-12, with no expiry exposed.
    An earlier capture lived about 13 days, so expect a refresh around 10-25.
    That is inferred, not measured.
- **Collection health.** `GET /api/status` (per-source runs; Ecosine Bolt is
  always `partial`, §4.3) and `GET /api/probe/results` (the nightly probe,
  22:20 UTC).
- **The previous session's transcript.**
  - Read it with `mcp__claude-code-remote__list_events` on
    `session_017PxcnnMZS9YdEgsRQYy4oM`, `kinds: ["user","result"]`,
    `limit: 100`, paging back with `before_id`.
  - It is dense: about 200 events per 8 minutes of work, so the full two
    months is thousands of pages.
  - For this note, 2026-10-06 05:09Z → 2026-10-19 15:26Z was read
    page by page. The earlier period was read only through compaction
    summaries.
  - The oldest cursor reached was `e0edb1cb-4467-4f3c-880a-44a9220edd7b`.
    Pass it as `before_id` to continue further back.
  - Operator answers given through multiple-choice questions sit inside
    `tool_result` blocks, not plain user messages.
  - **You should not need any of this.** Everything that mattered from it
    is in §0–§6 above, or already in FIX-STATUS.md.
- **Isolated rerun of a failing suite.** Start `PORT=8099 node mockapi.mjs &`,
  then `SMOKE_BASE=http://127.0.0.1:8099 node test/<file>.test.mjs`. One
  suite at a time, never alongside a full run.
