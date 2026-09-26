# FleetMirror — user and access lifecycle management (ULM): the design

**Status: design only. Nothing here is implemented.** Requested 2026-09-26:
"Go through the complete view and design ULM for a multi team company. Just
design, don't implement." Then: "The fleet names should be taken from the
platforms. I should be able to add other companies as well."

The design rests on four read-only inventories (2026-09-26):
- the 143 views and phone screens, each classified by what it shows and what it
  lets you do (Appendix B);
- the 189 API routes, each with its gate today and its proposed requirement
  (Appendix C);
- the caches, the service worker and the logs;
- the fleet model and each platform's organisation identity.

Every claim about today's code below comes from those inventories, with file
and line where it matters.

The house principle governs every screen here, as everywhere else: **a figure
that cannot be shown renders absent with its true reason, never as zero.**
"Not shown to your role" is such a reason, and it must say who can see it and
how to ask.

---

## 1. Where we start (measured, not assumed)

| fact | evidence |
|---|---|
| There is no sign-in. All 173 GET routes answer an anonymous request; five of them blank some fields for a caller without the admin token, which production does not set. | api/redact.js:1-8; inventory, 176 of 189 routes ungated |
| The one credential is a shared `ADMIN_TOKEN`, which is **unset on production**, so the write gate is open. | `/api/admin-mode` answered `{"open":true}` on 2026-09-26; api/admin_gate.js:49 |
| 8 money and identity writes have no gate at all, not even the admin token. These are ledger entry, receipt, policy, import preview and commit, person merge, same-person decide, and payouts verify. The analyst run is ungated too. | inventory findings 2, 17 |
| **Money and identity writes are attributed, not authenticated.** The supervisor must be one of four hard-coded first names (`api/ledger_routes.js:97`), the HR commit takes a free-text `by`, and settings changes record no actor. | inventory; ledger_routes.js:92-97 |
| Identity-document numbers reach anyone through `/api/driver/profile` (by the 2026-09-23 ruling). `/api/hr-roster` returns phone, email and five document fields ungated. | api/redact.js; hr_roster_routes.js:49 |
| **Receipt photos are protected only by an unguessable URL**, and `/api/ledger/entries` hands that URL to anyone. | ledger_routes.js:642, 1099 |
| The server cache is keyed by URL alone. The browser keeps API bodies for 36 h in localStorage. The phone's service worker stores every `/api` GET, receipt images included, with no deny list. | api/cache.js:167; swr.js:28-31; sw.js:126-137 |
| The fleet chip is a convenience, not a boundary. `qAll()` drops it, and every driver, vehicle, ledger and HR route answers across both fleets. | inventory cross-cutting 6, 24, 38 |
| **Pages fetch more than they show.** `/api/insights` carries phone, email and position for names the page prints bare. | cross-cutting 23, 37 |
| A provider password can reach the logs (FMS puts it in the query string, and src/http.js logs the URL on retry). Route errors log the query string, which carries names and plates. | findings 10, 11 |
| **17 lines in the repository carry real Emirates ID numbers** (checked against the HR export, 2026-09-26). | §14, first decision |

So ULM is **greenfield**: nothing in today's code is a boundary. Every rule
below is enforced on the server. The UI only follows what the server has
already decided.

---

## 2. The model

```
FleetMirror (the platform operator — you)
 └─ Company (a tenant: one customer business; data never crosses this line)
     ├─ Connections   a provider credential the company pasted
     │    └─ Platform accounts   what that credential can see: an Uber org, a Bolt company,
     │                          a Yango park, an FMS login, a CABMAN interface, a hotel domain
     ├─ Fleets        named FROM the platform accounts linked to them (§3)
     ├─ Teams         Operations, Finance, HR … (templates; the company edits them)
     └─ Users         people who sign in; a user can belong to several companies
          └─ Grants  role × fleet scope × optional expiry, given directly or through a team
```

- **Company, not fleet, is the isolation boundary.** Ecosine and Egari are two
  fleets of one company. They deliberately share drivers, one HR export and one
  identity register (schema_v49.sql:15-21), so merges across those two fleets
  stay possible. Two companies share nothing, not even a driver who works for
  both: he is two people, one in each.
- **Fleet is a scope inside a company.** A grant says which fleets it covers,
  either all fleets or a set.
- **Users are global. Memberships are per company.** An accountant who serves
  two companies has one sign-in and a company switcher. The FleetMirror
  operator sees no company's data by default (§6.5).

---

## 3. Fleets come from the platforms

The ruling: **fleet names are taken from the platforms.** Nobody types a fleet
name. The design has to cope with four facts from the inventory:
- some providers give a name and some do not;
- two providers spell one fleet differently;
- one credential can see several organisations;
- providers' ids come in different shapes.

### 3.1 What each provider can tell us

| provider | stable id | display name, from | today | one credential sees |
|---|---|---|---|---|
| Uber | encrypted org id (REST) plus `supplierOrgUUID` (cookie JWT) | `GET /v1/vehicle-suppliers/orgs` → `name` | called on paste (credcheck.js:473) but **not stored**; also sits in `platform_account_day.raw` | a **list**, including parent and child orgs |
| Bolt (fleet-integration) | `company_id` | none; `getCompanies` answers 404 | ids are code literals (config.js:175-178) | a **set** of company ids, found only by trying each |
| Bolt (fleet-owner portal) | `company_id` (+ owner user id) | `getCompanyDetails` / `getProfile` | **never called** | the companies the owner holds |
| Yango | park id | console `parks/users/profile` | unreachable (403 since 2026-09-06) | one park |
| FMS / InfoTrack | login `userid` | `GetVehicleList` → `ClientName` | **never called** | one fleet |
| CABMAN | InterfaceUniqueId | `GetIVDData` → `CompanyName` | in `telemetry_snapshot.raw` every 5 min, not read | one interface |
| Hotel channel | `x-domain` | none | — | one domain |

### 3.2 The rules

1. **Connecting a credential discovers accounts; it does not create fleets.**
   On connect, and nightly, the collector calls each provider's identity call
   (the table above). It records a `platform_account` with provider, stable id,
   **reported name**, when it was reported, and which call reported it. Calls
   that are "never called" today become part of connecting.
2. **An account is linked to a fleet by a person, with evidence.** Names are
   never matched for equality, because providers spell one fleet differently:
   "ECOSINE TRANSPORTS" in Uber (COVERAGE.md) and "ECOSINE TRANSPORTS LLC" in
   Yango (src/sources/yango.js:7); "Egari Luxury Cars Transport LLC" in Uber
   (src/credcheck.js:450) and "Egari Luxury" in our own `fleet` table
   (sql/schema.sql:11). The linking screen (§10.4) proposes a
   link from evidence:
   - how similar the normalised names are;
   - **shared plates**, since the same cars appear in both accounts' vehicle lists;
   - shared drivers.

   It is the same evidence-first method as the identity register. The company's
   Connections admin confirms the link or makes a new fleet.
3. **A fleet's name is the name one of its accounts reports.** The admin
   chooses which account names it (by default, the first linked account that
   reports a name). The other names show as aliases, each with its provider.
   There is no free-text name field.
4. **When no linked account reports a name** (Bolt fleet-integration only, the
   hotel channel only, or FMS before `GetVehicleList` is wired), the fleet is
   shown as *"Unnamed fleet — Bolt company …1234"*. The reason stays visible
   beside it: "Bolt's fleet-integration API returns no company name; connect the
   fleet-owner portal to name it." That is the house rule, applied to a name.
5. **A platform renames an organisation.** The new reported name is recorded,
   and the fleet's name follows its naming account. The change is noted in the
   audit log and shown once as "renamed by Uber on 26 Sep".
6. **One account belongs to one company.** `(provider, stable id)` is unique
   across the platform. If a second company tries to connect an Uber org that
   is already connected, it is refused, with a reason that points to FleetMirror
   support. This stops a shared or leaked credential from reading another
   customer's data.
7. **Accounts a credential can see but the company does not want** (an Uber
   parent org, a Bolt company that is not theirs) are marked *ignored*
   explicitly. They are never collected silently.

What goes away: every hard-coded fleet id and label. The inventory lists about
40 sites, including:
- `SOURCE_LABEL`, the two pickers, "Ecosine & Egari" in two mastheads;
- the `=== 'egari' ? 'Egari' : 'Ecosine'` two-way labels that would mislabel a
  third fleet;
- the `_EGARI` settings-key suffixes;
- the config.js fleet arrays;
- the payout, probe and coverage whitelists.

The unread `fleet.name` column (schema.sql:10-11) becomes the fleet's display
name, now fed from the platforms.

---

## 4. Tenancy: isolating companies

### 4.1 Recommendation: one database, a `company_id` on every row, and Postgres row-level security

| option | isolation | cost in this codebase | verdict |
|---|---|---|---|
| **Shared DB + `company_id` + RLS** | enforced by Postgres on every statement, including the 562 read statements that carry no tenant predicate today | add `company_id` to 71 tables. Rework the colliding keys (§4.2). One policy per table. `SET LOCAL app.company_id` per request, inside a transaction | **recommended**: one pool, one migration run, and the database refuses a missed predicate instead of trusting 562 hand-edits |
| Schema per company | strong | all 84 migrations and the v53 rebuild replay per schema; `search_path` per request on a pool of 8 | workable, but migrations grow with every company |
| Database per company | strongest | one pool per company per process: 8 connections × 2 processes × N companies, on basic-xxs | keep for a customer who contractually needs physical isolation |

RLS is the backstop, not the only line. Routes still bind `company_id`
explicitly, and a test proves that every table holding company data has a
policy (§9.1).

### 4.2 What changes, from the blast-radius measurement

- **27 tables with no fleet or company column get `company_id`.** They include:
  `app_setting`, `credential_state`, `driver_identity_link`, `driver_lifetime`,
  `driver_ledger*`, `ledger_policy`, `hr_roster_upload`, `partner`,
  `place_cell` and `rollup_person_month`.

  The shared reference tables stay global: `weather_daily`, `calendar_day` and
  `world_event`. But `world_event` edits become per-company overlays, because
  `POST /api/events` writes it today.
- **Keys that would collide across companies gain `company_id`.** Today they
  are keyed by plate alone or by driver id alone:
  - vehicle, telemetry_snapshot, occupancy_segment, vehicle_driver_day;
  - driver_day, driver_lifetime, driver_platform_state;
  - every `(platform, external_id)`.

  There is a precedent: money_event's key lacked the fleet and a real collision
  killed an insert (schema_v49.sql:15-30).
- **The identity register goes per company.** `api/identity_map.js` and the
  `person_key` it compiles (schema_v53.sql) become per-company. Its name
  fallback must never fold two companies' drivers into one person.
- **Rollups go per company.** The `'*'` "all fleets" rows become "all fleets of
  this company".
- **Collector.** One schedule iterates over companies. Each run is pinned to
  one company's settings, which extends `withPinnedSettings` (settings.js:399).
  Company A's failures never mark company B's credentials.
- **Secrets.** Each company gets its own data key (envelope encryption), and no
  company's secrets are decryptable with the database URL. Today the key falls
  back to `DATABASE_URL`, then to a literal (settings.js:11-13).
- **Locale per company.** "Asia/Dubai" appears 302 times and `DEFAULT 'AED'` 11
  times. A company has a timezone and a currency, and "Dubai time" in the
  masthead reads the company's zone.

---

## 5. Signing in

### 5.1 People

- **Sign-in:**
  - **Passkey** (WebAuthn) as the primary way in.
  - **Emailed one-time link** as the fallback.
  - Optionally, **SSO per company** (Google Workspace or Microsoft Entra), set
    up by that company's Owner.
- **Multi-factor.** Required for any role that can write, reveal documents or
  change access. A passkey counts as MFA.
- **Session.** An HttpOnly, Secure, SameSite=Lax cookie on the one origin. It
  ends after 12 h idle or 7 days absolute on desktop.
- **Phone PWA.** A 30-day session bound to the device. **Step-up**
  re-authentication is required for:
  - revealing a document number;
  - committing cash above the company's threshold;
  - changing access;
  - applying credentials.
- **Company switcher.** Shown in the masthead when a user holds more than one
  company. The chosen company is carried in the session, **not in the URL**.
  Every request is scoped to exactly one company.

### 5.2 Machines

- **Wall display.** A named service principal with the Wall display role. It
  holds a revocable token bound to one company and one device.
- **Integrations and exports.** Named tokens owned by a user, with a scope and
  an expiry (at most 90 days). They are listed and revocable on the Access page.
- **The collector** acts as `system:collector` in the audit, per company.

### 5.3 What is retired

- **`ADMIN_TOKEN`**, the `x-admin-token` header, and the token kept in
  localStorage (`adminToken`). Today the phone silently reuses the token the
  desktop saved in the same browser.
- **The four hard-coded supervisor codes.** "Recorded by" becomes the signed-in
  user. History keeps its codes, mapped to users where the company says who
  they were (§12.3).
- **Free-text `by`, `set_by` and `entered_by` fields** on every write.

---

## 6. Authorisation

### 6.1 Data classes: what a response is made of

Every route, and every field that matters, is labelled with the class of data
it carries. The inventory found fifteen classes. The design adds three.

| code | class | examples |
|---|---|---|
| ID | driver identity | names, photos, platform ids |
| CT | driver contact | phone, email, tel:/mailto: links |
| DOC | driver documents | Emirates ID, licence and passport numbers, document expiries |
| EARN | driver earnings | money per named driver |
| CASH | driver cash | deposits, advances, salary, ledger balances, receipt photos |
| COND | driver conduct | safety events, ratings, quality, cancellations by driver |
| **ACCUSE** | attribution of wrongdoing to a named person | unauthorized-trip attribution by name, "who drives hardest", low-performer lists |
| REV | company revenue | fleet-level trip value, money in |
| PAY | company payouts | platform-to-company payouts, bank transfers, reconciliation |
| BK | bookings | trip rows |
| LOC | location | live positions, traces, pickup and drop-off places, territory |
| VEH | vehicle operations | vehicles, utilisation, vehicle compliance |
| HR | HR roster | the HR export's rows |
| MRG | identity decisions | same-person, merges |
| CRED | credentials and collector control | provider secrets, runs, probes |
| SYS | system health | sources, coverage, freshness |
| **PAX** (new) | passengers | hotel guest records, room numbers, trip purposes (#corporate/guests, #property/guests) |
| **AUDIT** (new) | the audit log | who saw and did what |

ACCUSE is split from COND on purpose. A count of harsh events is conduct. A
page that names a person as the likely culprit of an unbooked trip is an
accusation. It needs its own grant, and it always carries its evidence and its
confidence.

### 6.2 Grant levels

A role holds each class at one of five levels:
- **F, full.** Everything.
- **M, masked.** Present but masked: `•••• 4821` for an ID, `05• ••• •12` for a
  phone. The full value needs a **reveal** (step-up and a reason, audited).
- **P, pseudonymised.** People appear as stable pseudonyms per company
  (`D-4821`), consistently across pages, so analysis still works.
- **A, aggregate.** Counts and totals only; no row names a person.
- **none.** Absent, with the reason.

### 6.3 Roles

These are the defaults FleetMirror ships. A company can copy one to make its
own role, but cannot widen a built-in one.

| role | ID | CT | DOC | EARN | CASH | COND | ACCUSE | REV | PAY | BK | LOC | VEH | HR | MRG | CRED | SYS | PAX | AUDIT |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Owner | F | F | F | F | F | F | F | F | F | F | F | F | F | F | F | F | F | F |
| Management | F | F | M | F | F | F | F | F | F | F | F | F | M | F | — | F | F | — |
| Finance manager | F | F | — | F | F | — | — | F | F | F | — | F | — | — | — | F | F | — |
| Cash desk | F | — | — | — | F | — | — | — | — | — | — | — | — | — | — | F | — | — |
| Operations manager | F | F | — | F | — | F | F | F | — | F | F | F | — | — | — | F | — | — |
| Dispatcher | F | F | — | — | — | A | — | — | — | F | F | F | — | — | — | F | — | — |
| HR officer | F | F | F | — | — | F | F | — | — | — | — | F | F | F | — | F | — | — |
| Safety & compliance | F | F | M | — | — | F | F | — | — | F | F | F | — | — | — | F | — | — |
| Fleet technician | F | — | — | — | — | — | — | — | — | A | F | F | — | — | — | F | — | — |
| Analyst | P | — | — | P | — | P | — | F | F | F | F | F | — | — | — | F | A | — |
| Auditor (time-boxed) | F | M | M | F | F | F | F | F | F | F | F | F | M | F | — | F | M | F |
| Access admin | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | F | — | F |
| Connections admin | — | — | — | — | — | — | — | — | — | — | — | — | — | — | F | F | — | — |
| Wall display (service) | — | — | — | — | — | — | — | F | — | A | A | A | — | — | — | F | — | — |

Actions are separate capabilities, not implied by read access (§8).

- **Separation of duties.** The Access admin manages who has access but sees no
  business data. The Connections admin manages credentials but sees no driver.
- **Owner.** The one role that holds everything. A company must have at least
  one Owner, and should have two.

### 6.4 Teams and grants

- **A team is a named group with default grants.** Each grant is a role plus a
  fleet scope. Members inherit the team's grants.
- **Templates.** Management, Finance, Operations, HR, Safety & compliance,
  Fleet maintenance and IT. A company renames, adds and removes teams freely.
- **Direct grants.** A user can also hold grants directly, for example a cover
  role while a colleague is on leave.
- **Every grant records:**
  - its role and fleet scope (all fleets, or a set);
  - an optional **expiry**;
  - who granted it, when, and why.
- **Evaluation:**
  - A user's access is the **union** of their grants.
  - The result is **deny-by-default**.
  - Fleet scope is intersected with the fleet of each row.

### 6.5 Support access from FleetMirror

The platform operator has no standing access to a company's data. Support
works like this:
- The company's Owner grants a **time-boxed support grant** (at most 72 h).
- The grant carries a role and a reason.
- Every page shows a banner while it lasts: "FleetMirror support can see this
  company until 28 Sep 14:00."
- Everything the support user does is audited under their own name.

---

## 7. How pages behave

1. **A view opens when you hold its primary class.** The primary class is the
   first class in its Appendix B row: a driver page's is ID, and #payouts' is
   PAY.
2. **Everything else on the page follows your level for that class.** A class
   you do not hold renders **absent, with the reason**:

   > **Phone** — not shown to your role. Operations and HR can see contact
   > details. *Request access*

   This applies at every level: a tile, a column, a card or a section. **A
   withheld figure is never a zero or a dash.**
3. **The server leaves withheld fields out.** They are not hidden in the
   browser; the server omits them. The response lists what it withheld and why
   (`withheld: {phone: "role"}`), so the page can say so without guessing.
4. **Navigation.** The rail, the section row and the phone tab bar list only
   views you can open.
5. **A link to a view you cannot open** is plain text, not a link.
6. **A direct address to a closed view** shows a page that says so. It names the
   teams that can see it and offers *Request access* (§11.2). It is never a
   blank page and never a 404.
7. **Fleet scope.**
   - **Scope of one fleet:** the fleet chip is locked to that fleet, and every
     total is that fleet's.
   - **Scope of several fleets:** the chip offers only those fleets, and "All
     fleets" means *your* fleets. The masthead says so: "Ecosine · your fleets".
   - **Person pages** (a person can hold accounts in several fleets) show only
     the in-scope accounts. The rest appear as "1 more account in a fleet
     outside your scope". Figures that combine fleets are recomputed over your
     scope, never shown whole.
8. **The shell.** The shell is the part of every page around the content:
   - **The credential banner** names providers and errors (CRED). Only CRED
     holders see that detail. Everyone else sees one line: "Some data sources
     need attention — the Connections admin has been told."
   - **The today strip** shows company money (REV). It is shown only to REV
     holders. Anyone else sees the same strip with bookings and cars only.
   - **Freshness** (SYS) is shown to everyone.
9. **Phone.** The same rules apply, plus:
   - The fallback that renders the desktop driver and vehicle tabs inside the
     app obeys the same response shaping, because it uses the same endpoints.
   - "Open it on the desktop version" keeps the session.
   - Screens that can only be reached by address (Deposits, Online time) are
     listed on More for the roles that hold them.
10. **Addresses carry no personal identifiers.** Driver and person pages use
    opaque ids (`#driver/p_7Qk2`), never names. `#segments/driver/<name>` goes
    away. Plates stay, because a plate is an operational identifier the fleet
    uses openly. But an address with a plate and a day is still recorded as a
    location read.

Appendix B applies these rules to all 143 views and shows the result per role.

---

## 8. Actions

Every write is a named capability, held only through a role. The actor is
always the signed-in user.

| capability | what | routes today (gate) | held by | extra control |
|---|---|---|---|---|
| act:cash.record | record cash handed in, an advance, a charge, a salary line, an opening balance; attach a receipt | POST /api/ledger/entry, /api/ledger/receipt (**none**) | Cash desk, Finance manager, Owner | step-up above the company's threshold |
| act:cash.import | preview an imported cash sheet and choose who each row is | POST /api/ledger/import/preview (**none**) | Cash desk, Finance manager | — |
| act:cash.import.commit | commit it | POST /api/ledger/import/commit (**none**) | Finance manager, Owner | **four-eyes**: not the person who previewed it |
| act:cash.policy | move the lending line | POST /api/ledger/policy (**none**) | Finance manager, Owner | reason required; shows who it moves first |
| act:finance.import | import statement days | POST /api/import/statement-days (admin) | Finance manager | — |
| act:finance.verify | ask Uber to confirm payouts (spends provider quota) | POST /api/finance/payouts/verify (**none**) | Finance manager | rate-limited per company |
| act:hr.import | preview and commit the HR export | POST /api/hr-roster/preview, /commit (admin) | HR officer, Owner | step-up on commit |
| act:identity.decide | same-person verdicts | POST /api/same-person/decide (**none**) | HR officer, Management, Owner | — |
| act:identity.merge | merge two people's records | POST /api/person/merge (**none**) | HR officer, Owner | **four-eyes** |
| act:credentials.test / .write | test and apply provider credentials | PUT /api/settings, POST /api/settings/paste (admin) | Connections admin, Owner | step-up on apply; values never shown back |
| act:collector.run | run incremental now | POST /api/settings/trigger (admin) | Connections admin, Operations manager | — |
| act:collector.backfill | 12-month backfill, probe (spends provider quota) | POST /api/settings/trigger, GET /api/probe/* (**none**) | Connections admin, Owner | one at a time per company |
| act:analyst.run | run the analyst, which sends a brief to a third-party model | POST /api/analyst/run (**none**), /settings/trigger | Management, Analyst, Owner | the brief is **pseudonymised** before it leaves (today it carries up to 12 candidate driver names and 12 plates: src/analyst.js:119-124, 503) |
| act:calendar.edit | add a local event | POST /api/events (admin) | Management, Operations manager | per company |
| act:finding.own | take, assign and close a finding on #insights | new | Operations manager, Safety, Management | records who acted, which the page says today is "not recorded" |
| act:access.* | invite, grant, revoke, review | new | Access admin, Owner | step-up; the actor cannot grant themselves more than they hold |
| act:export.<class> | CSV export (`/api/export/trips.csv`, up to 400,000 rows) | GET (**none**) | whoever holds the classes exported | watermarked with user and time; audited |

Rules that apply to every action:
- **A dry run needs the same capability as the commit**, because a dry run shows
  the same people and money. A dry run that writes anyway needs it too: the
  phone's "Check it" stores the receipt photo.
- **Four-eyes means two distinct signed-in users.** The second approves from
  their own session. The page shows who prepared the change.
- **No GET has side effects.** `GET /api/tesla/connect` writes OAuth state today;
  it becomes a POST under act:credentials.write.

---

## 9. Enforcement, on the server

### 9.1 A route manifest, deny by default

Each of the 189 routes declares:
- the classes it returns, with the class of each field;
- the capability it needs;
- whether it takes a fleet parameter and a subject (person or plate).

That declaration lives beside the route. A request passes through these stages
in order:

```
cookie → session → user → active company → grants (cached per session, invalidated on any grant change)
  → capability check (403 with a reason) → SET LOCAL app.company_id → handler
  → response shaper (drop or mask each field by class and level; add `withheld`) → cache → client
```

- **An undeclared route answers 403.** A test fails if any route lacks a
  declaration, in the same style as the house's existing completeness tests.
- **RLS policies are checked the same way.** A test fails if any table holding
  company data has no RLS policy.
- **Subjects are checked.** A request about a person or a plate outside the
  caller's fleet scope answers 404-as-not-yours: "no such driver in your
  fleets". It never answers with the other fleet's data.

### 9.2 Caches: the leak that has to close first

- **Server response cache** (api/cache.js). The key becomes: URL + company +
  a **visibility fingerprint**. The fingerprint is a hash of the caller's class
  levels and fleet scope, so two users with the same access share entries and
  nobody gets another's answer.
  - `warm.js` pre-warms only the fingerprints in use in the last day.
  - The `x-warm` header is honoured from loopback only.
  - Write routes invalidate the entries they affect. Ledger and merge writes do
    not today (finding 20).
- **Browser SWR cache** (swr.js). Namespaced by user and company. Wiped on sign
  out, on company switch and on any grant change (the server sends a
  `grants-changed` header). It never stores CT, DOC, CASH, HR, MRG or AUDIT
  responses.
- **Service worker** (sw.js).
  - The data cache is partitioned per user and company.
  - It gets a **deny list**: receipt images, `/api/hr-roster`, `/api/ledger/*`,
    `/api/settings*`, `/api/compliance/drivers` and the driver profile.
  - It gets a size cap and a TTL.
  - It is purged on sign-out and on a `401`.
  - Its scope today is `/`, so it also intercepts desktop pages; it keeps to
    the phone's paths.

### 9.3 Files, exports, logs, headers, third parties

- **Receipt photos and driver photos** are served only through a class check
  (CASH and ID respectively), never by the capability of knowing the URL.
- **Exports** are gated by `act:export.<class>`, stamped with user and time,
  and audited.
- **Logs:**
  - No personal data, and no query strings, in error logs (api/wrap.js:23).
  - Outbound URLs are logged without their query (FMS's password; src/http.js:38, 81).
  - An **access log** records user, route, company and status, so "who read
    what" has an answer.
- **Headers.** CSP, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy:
  same-origin` and no `x-powered-by`. There is still no CORS: one origin serves
  the app and the API.
- **Writes.** SameSite=Lax cookie plus a CSRF token on every write.
- **Rate limits.** Per user on reveal, export, the quota-spending actions and
  sign-in.
- **Third parties:**
  - The analyst brief is pseudonymised (§8).
  - Map tiles from OpenStreetMap disclose the viewport being looked at. The
    Owner may choose a self-hosted tile source.
  - Vehicle photos hot-linked from a platform are proxied.
- **Diagnostics.** `GET /api/unauthorized/attributed/plan`, which runs
  `EXPLAIN ANALYZE`, and `/api/schema/raw-*` become Owner-only diagnostics.

---

## 10. Screens

### 10.1 Sign-in

- **The FleetMirror mark and name**, and one field: email.
- **Two ways in:** "Continue with passkey", and "Email me a sign-in link".
- **SSO:** a company that set it up sees "Continue with Google / Microsoft"
  after typing an address at its domain.

### 10.2 The masthead, for a signed-in user

- **The company name**, with the switcher when the user holds more than one
  company.
- **The account menu:** name, teams, fleet scope, "Sign out everywhere", and
  "Your access" (a read-only list of the user's grants and their expiries).

### 10.3 Set up → Access (Access admin and Owner)

- **People.** Everyone with access: teams, roles, fleet scope, last sign-in,
  MFA state, expiry.
  - Filters: team, role, dormant, expiring.
  - Row actions: change grants, suspend, offboard, resend invite.
- **Teams.** The team, its default grants, its members and its lead (the lead
  approves requests and attests reviews).
- **Roles.** The catalogue in §6.3, read-only for built-ins. "Duplicate to
  customise" makes a company role.
  - Each role shows the views it opens (from Appendix B) and the actions it holds.
- **Requests.** Pending access requests with the requester's reason and the
  view that triggered it. Approve (for a period) or decline (with a reason).
- **Reviews.** The quarterly attestation per team (§11.3): open, due and overdue.
- **Audit** (§12).

### 10.4 Set up → Connections and fleets (Connections admin and Owner)

- **Connections.** Each credential, with its health (today's credential
  banner, now per company).
- **Platform accounts.** What each credential can see: reported name, stable id,
  and linked fleet or *ignored*.
  - A new account arrives as "**New: Uber org 'Egari Luxury Cars Transport LLC'
    — link to a fleet**".
  - The evidence panel shows shared plates, shared drivers and name similarity.
- **Fleets.** Each fleet with its accounts, which account names it, its
  aliases, and "renamed on …" history.

### 10.5 FleetMirror operator console (platform operator only)

- **Companies.** Every company with its status, fleet and user counts, last
  collection and plan.
- **Actions:** create a company (§11.1), suspend, reinstate, offboard.
- **Support.** Your active support grants and their expiries.
- **No company data** appears here except what support grants allow.

### 10.6 Phone

- **Sign-in** is the same, with a passkey on the phone.
- **More → Account:** your name, company, fleet scope and sign out.
- **Blocked screens** show the same reasons as the desktop.
- **Step-up** prompts use the phone's own passkey.

---

## 11. Lifecycle

### 11.1 A company

```
created (by the FleetMirror operator: legal name, timezone, currency, first Owner's email)
 → onboarding (Owner accepts; connects the first platform credential; accounts discovered; fleets linked and named)
 → active (teams from templates; users invited)
 → suspended (read-only; collectors stop; users see why)
 → offboarding (export of the company's data for the Owner; 30-day grace)
 → deleted (data removed; the audit summary kept for the retention period)
```

### 11.2 A user

```
invited ──accept (verify email, register a passkey)──▶ active
  │ expires after 7 days unaccepted                     │
  ▼                                                     ├── grant changed (by an Access admin; audited; takes effect on the next request)
revoked                                                 ├── request access ──▶ approved (for a period) / declined
                                                        ├── dormant: no sign-in for 60 days ──▶ suspended automatically
                                                        ├── suspended (by an admin) ──▶ reinstated
                                                        └── offboarded: all sessions and tokens revoked at once,
                                                            grants removed, identity kept for attribution
                                                            (their name stays on everything they recorded)
```

- **An invite** carries team, role, fleet scope and an optional end date. It
  is issued by an Access admin, or by a team lead within the lead's own team
  and scope.
- **Access requests** start from the "not shown to your role" pages. They carry
  the view, the class and a reason, and go to the team lead or an Access admin.
  An approval can be time-boxed ("until 30 Sep").
- **Cover** for leave is a direct grant with an end date. It expires by itself,
  and the banner on the covering user's pages says until when.
- **Rehire** reactivates the same identity with fresh grants, so history stays
  joined up.
- **Owners cannot remove the last Owner.** Transferring ownership takes two
  Owners, or FleetMirror support with the company's written request.

### 11.3 Reviews

- **Every quarter, each team lead attests their team's access.** Keep or remove,
  person by person.
- **Unattested access expires** 14 days after the review closes.
- **The Owner sees review status** on the Access page.
- **Sensitive-class holders** (DOC at F, CASH, CRED, ACCUSE) are reviewed monthly.

### 11.4 Drivers as users (not in the first release)

The model has room for a *driver* principal. A driver would see only their own
earnings, cash position, documents and trips, through the same response shaper
at scope "self". It is left out of the first release on purpose: it needs
consent wording, and a support path this company does not have yet.

---

## 12. Audit

### 12.1 What is recorded

The audit log is append-only and hash-chained per company. It records:
- **every write:** actor, capability, subject, before and after (or its hash
  for money), reason, IP, device and time;
- **every access change and every sign-in;**
- **sensitive reads:** document reveals, exports, receipt views, and opening a
  person's documents;
- **support-grant sessions.**

### 12.2 Where it shows

- **Set up → Access → Audit** for the Owner, Access admin and Auditor.
- **"Who looked at this driver's documents"** on the driver's page, for HR.
- **Each cash entry's history**, which already exists as `driver_ledger_audit`,
  now with real actors.

### 12.3 Retention and history

- **Two years**, or the company's legal requirement if longer.
- **History before ULM keeps its attributions as they were.** The four
  supervisor codes, the free-text `by` values and the IP addresses stay. They
  are labelled "attributed, not authenticated — recorded before sign-in
  existed" and mapped to users only where the company confirms who they were.

---

## 13. Rollout, in phases

Each phase can ship on its own.

| phase | delivers | done when |
|---|---|---|
| **0 — close the open doors (days)** | Set `ADMIN_TOKEN`; gate the 8 ungated money and identity writes and the probes; take PII out of logs; exclude CT, DOC and CASH responses from the SW and SWR caches; stop serving receipt URLs in list responses; security headers | `/api/admin-mode` answers `open:false`; a write with no token is refused on production |
| **1 — sign-in for this company** | users, passkeys, sessions; the route manifest in *observe* mode (logs what it would deny); the audit log; "recorded by" becomes the user | every request carries a user; the manifest covers 189 of 189 routes |
| **2 — roles, teams, fleet scope** | the response shaper; absent-with-reason for withheld fields; per-fingerprint caches; nav and links follow access; access requests | the manifest *enforces*; Appendix B holds on production, role by role (screenshots per role) |
| **3 — fleets from the platforms** | `platform_account`; the identity calls wired in, including those never called today; the linking screen; about 40 hard-coded fleet sites removed | a third fleet can be connected and named with no code change |
| **4 — more companies** | `company_id` and RLS everywhere; per-company settings, keys, collector runs, identity register, rollups and locale; the operator console; support grants | a second company onboards on production, and a cross-company read test fails closed |
| **5 — operate it** | quarterly reviews, dormant suspension, reveal with a reason, export watermarks, finding ownership | the first review cycle completes |

**Phase 0 must come before anything else.** **Phase 4 must not start until
phases 1–2 are proven**, because onboarding a second company onto today's
anonymous API would expose it to everyone who has the address.

---

## 14. Decisions for you

1. **The Emirates ID numbers in the repository.**
   - What: 17 lines carry real drivers' Emirates ID numbers, matched against
     the HR export on 2026-09-26. They are in code, tests, one migration
     comment and two docs, and in the git history already pushed to GitHub.
   - The choice: replace them with synthetic numbers in the working tree only,
     or also rewrite the git history. Rewriting needs every clone to re-fetch,
     and editing an old migration file changes a file that replays on every
     boot. Nothing has been changed yet.
2. **Phase 0 against your earlier "don't keep admin token at all for now".**
   Phase 0 needs a token, or sign-in, before anything else. Which do you want?
3. **Sign-in.** Which identity provider does the company use (Google Workspace,
   Microsoft 365, or email only)? Is a passkey on every phone acceptable?
4. **Teams.** Is the template list right for this company (§6.4)? Who leads
   each team?
5. **Split by fleet?** Do any staff work only one fleet, so that a
   fleet-scoped grant matters on day one?
6. **Dispatchers.** Should they see driver earnings? The design says no: they
   see contact, live and bookings.
7. **Documents.** Who sees full Emirates ID and licence numbers? The design says
   HR and the Owner in full, and Management, Safety and the Auditor masked with
   reveal. That reverses the 2026-09-23 ruling that shows them on every driver
   page.
8. **Four-eyes.** Should four-eyes apply to cash-import commits and person
   merges only (the design), or also to single cash entries above a threshold?
   What threshold?
9. **Other companies.** Will they be separate businesses with nothing in
   common (the design), or could a group company need to see across its
   subsidiaries? The latter needs a "group" level above company.
10. **The analyst.** Should the brief be pseudonymised before it goes to the
    third-party model (the design), or stop being sent?
11. **Retention.** How long should the audit log and receipt photos be kept?
    The design says two years for the audit log. Receipts are 12 months today.

---

## Appendix A — role codes used in Appendix B

`OWN` Owner · `MGT` Management · `FIN` Finance manager · `CLK` Cash desk ·
`OPS` Operations manager · `DSP` Dispatcher · `HRO` HR officer ·
`SAF` Safety & compliance · `TEC` Fleet technician · `ANL` Analyst ·
`AUD` Auditor · `ACC` Access admin · `CON` Connections admin · `DSP_WALL` Wall display

Levels in the "partial" column: a class alone (e.g. `DOC`) means withheld,
shown absent with its reason. `CLASS:M` means masked, `CLASS:P` pseudonymised
and `CLASS:A` aggregate only. `accusation` means the page's named attribution
is withheld (counts remain).

Classes in the "shows" column: `ID` identity · `CT` contact · `DOC` documents ·
`EARN` driver earnings · `CASH` driver cash · `COND` conduct · `REV` company
revenue · `PAY` company payouts · `BK` bookings · `LOC` location ·
`VEH` vehicles · `HR` HR roster · `MRG` identity decisions · `CRED`
credentials · `SYS` system health.

The ACCUSE, PAX and AUDIT classes (§6.1) are not in the inventory's vocabulary.
Accusatory views are marked **A** in the last column instead.

## Appendix B — every view, what it shows, and who can open it

Generated from the 2026-09-26 inventory (143 views and phone screens) and the role catalogue in §6.3, by the rules in §7. "opens fully" means every class on the page is shown to that role. "opens, partly" lists what that role gets withheld, masked, pseudonymised or aggregated. "closed" means the view does not open (the primary class is not held). Accusatory pages are marked **A**. Rows prefixed `m:` are phone screens.

| view | section | shows | opens fully | opens, partly (withheld or degraded) | closed | |
|---|---|---|---|---|---|---|
| demand | Work | BK,REV | OWN MGT FIN OPS ANL AUD | DSP(REV) SAF(REV) TEC(REV/BK:A) DSP_WALL(BK:A) | CLK HRO ACC CON |  |
| trips | Work | BK,ID,VEH,LOC,EARN,REV | OWN MGT OPS AUD | FIN(LOC) DSP(EARN/REV) SAF(EARN/REV) TEC(EARN/REV/BK:A) ANL(ID:P/EARN:P) DSP_WALL(ID/EARN/BK:A/VEH:A/LOC:A) | CLK HRO ACC CON |  |
| supply | Work | BK,LOC | OWN MGT OPS DSP SAF ANL AUD | FIN(LOC) TEC(BK:A) DSP_WALL(BK:A/LOC:A) | CLK HRO ACC CON |  |
| platforms (default tab share; also platforms/share) | Work | BK,REV | OWN MGT FIN OPS ANL AUD | DSP(REV) SAF(REV) TEC(REV/BK:A) DSP_WALL(BK:A) | CLK HRO ACC CON |  |
| platforms/tiers | Work | VEH,BK,ID | OWN MGT FIN OPS DSP SAF AUD | HRO(BK) TEC(BK:A) ANL(ID:P) DSP_WALL(ID/VEH:A/BK:A) | CLK ACC CON |  |
| platforms/funnel | Work | ID,COND,EARN,REV | OWN MGT OPS AUD | FIN(COND/accusation) CLK(COND/EARN/REV/accusation) DSP(EARN/REV/accusation/COND:A) HRO(EARN/REV) SAF(EARN/REV) TEC(COND/EARN/REV/accusation) ANL(ID:P/COND:P/EARN:P) | ACC CON DSP_WALL | A |
| corridors | Work | LOC,BK,REV | OWN MGT OPS ANL AUD | DSP(REV) SAF(REV) TEC(REV/BK:A) DSP_WALL(LOC:A/BK:A) | FIN CLK HRO ACC CON |  |
| causes | Work | BK,REV | OWN MGT FIN OPS ANL AUD | DSP(REV) SAF(REV) TEC(REV/BK:A) DSP_WALL(BK:A) | CLK HRO ACC CON |  |
| forecast | Work | BK | OWN MGT FIN OPS DSP SAF ANL AUD | TEC(BK:A) DSP_WALL(BK:A) | CLK HRO ACC CON |  |
| optimise | Work | BK,REV,LOC | OWN MGT OPS ANL AUD | FIN(LOC) DSP(REV) SAF(REV) TEC(REV/BK:A) DSP_WALL(BK:A/LOC:A) | CLK HRO ACC CON |  |
| capacity | Work | BK | OWN MGT FIN OPS DSP SAF ANL AUD | TEC(BK:A) DSP_WALL(BK:A) | CLK HRO ACC CON |  |
| day/&lt;YYYY-MM-DD&gt; | Work | BK,ID,EARN,COND,VEH,REV,SYS | OWN MGT OPS AUD | FIN(COND/accusation) DSP(EARN/REV/accusation/COND:A) SAF(EARN/REV) TEC(EARN/COND/REV/accusation/BK:A) ANL(ID:P/EARN:P/COND:P) DSP_WALL(ID/EARN/COND/accusation/BK:A/VEH:A) | CLK HRO ACC CON | A |
| slot/&lt;dow 0-6&gt;/&lt;hour 0-23&gt; | Work | BK,ID,EARN,REV,LOC | OWN MGT OPS AUD | FIN(LOC) DSP(EARN/REV) SAF(EARN/REV) TEC(EARN/REV/BK:A) ANL(ID:P/EARN:P) DSP_WALL(ID/EARN/BK:A/LOC:A) | CLK HRO ACC CON |  |
| trip/&lt;platform&gt;/&lt;id&gt; | Work | BK,ID,EARN,VEH,LOC,REV | OWN MGT OPS AUD | FIN(LOC) DSP(EARN/REV) SAF(EARN/REV) TEC(EARN/REV/BK:A) ANL(ID:P/EARN:P) DSP_WALL(ID/EARN/BK:A/VEH:A/LOC:A) | CLK HRO ACC CON |  |
| drivers | People — drivers | ID,EARN,COND,DOC,VEH,BK,MRG | OWN | MGT(DOC:M) FIN(COND/DOC/MRG/accusation) CLK(EARN/COND/DOC/VEH/BK/MRG/accusation) OPS(DOC/MRG) DSP(EARN/DOC/MRG/accusation/COND:A) HRO(EARN/BK) SAF(EARN/MRG/DOC:M) TEC(EARN/COND/DOC/MRG/accusation/BK:A) ANL(DOC/MRG/ID:P/EARN:P/COND:P) AUD(DOC:M) | ACC CON DSP_WALL | A |
| driver/&lt;id&gt; (overview) | People — drivers | ID,CT,DOC,EARN,CASH,COND,VEH,BK | OWN | MGT(DOC:M) FIN(DOC/COND) CLK(CT/DOC/EARN/COND/VEH/BK) OPS(DOC/CASH) DSP(DOC/EARN/CASH/COND:A) HRO(EARN/CASH/BK) SAF(EARN/CASH/DOC:M) TEC(CT/DOC/EARN/CASH/COND/BK:A) ANL(CT/DOC/CASH/ID:P/EARN:P/COND:P) AUD(CT:M/DOC:M) | ACC CON DSP_WALL |  |
| driver/&lt;id&gt;/activity | People — drivers | ID,CT,DOC,BK,EARN,VEH | OWN | MGT(DOC:M) FIN(DOC) CLK(CT/DOC/BK/EARN/VEH) OPS(DOC) DSP(DOC/EARN) HRO(BK/EARN) SAF(EARN/DOC:M) TEC(CT/DOC/EARN/BK:A) ANL(CT/DOC/ID:P/EARN:P) AUD(CT:M/DOC:M) | ACC CON DSP_WALL |  |
| driver/&lt;id&gt;/day?on=&lt;YYYY-MM-DD&gt; | People — drivers | ID,CT,DOC,BK,EARN,LOC,VEH | OWN | MGT(DOC:M) FIN(DOC/LOC) CLK(CT/DOC/BK/EARN/LOC/VEH) OPS(DOC) DSP(DOC/EARN) HRO(BK/EARN/LOC) SAF(EARN/DOC:M) TEC(CT/DOC/EARN/BK:A) ANL(CT/DOC/ID:P/EARN:P) AUD(CT:M/DOC:M) | ACC CON DSP_WALL |  |
| driver/&lt;id&gt;/territory | People — drivers | ID,CT,DOC,LOC,BK,EARN | OWN | MGT(DOC:M) FIN(DOC/LOC) CLK(CT/DOC/LOC/BK/EARN) OPS(DOC) DSP(DOC/EARN) HRO(LOC/BK/EARN) SAF(EARN/DOC:M) TEC(CT/DOC/EARN/BK:A) ANL(CT/DOC/ID:P/EARN:P) AUD(CT:M/DOC:M) | ACC CON DSP_WALL |  |
| driver/&lt;id&gt;/earnings | People — drivers | ID,CT,DOC,EARN,CASH,COND | OWN | MGT(DOC:M) FIN(DOC/COND) CLK(CT/DOC/EARN/COND) OPS(DOC/CASH) DSP(DOC/EARN/CASH/COND:A) HRO(EARN/CASH) SAF(EARN/CASH/DOC:M) TEC(CT/DOC/EARN/CASH/COND) ANL(CT/DOC/CASH/ID:P/EARN:P/COND:P) AUD(CT:M/DOC:M) | ACC CON DSP_WALL |  |
| driver/&lt;id&gt;/quality | People — drivers | ID,CT,DOC,COND | OWN HRO | MGT(DOC:M) FIN(DOC/COND/accusation) CLK(CT/DOC/COND/accusation) OPS(DOC) DSP(DOC/accusation/COND:A) SAF(DOC:M) TEC(CT/DOC/COND/accusation) ANL(CT/DOC/ID:P/COND:P) AUD(CT:M/DOC:M) | ACC CON DSP_WALL | A |
| driver/&lt;id&gt;/record | People — drivers | ID,CT,DOC,COND,EARN,BK | OWN | MGT(DOC:M) FIN(DOC/COND/accusation) CLK(CT/DOC/COND/EARN/BK/accusation) OPS(DOC) DSP(DOC/EARN/accusation/COND:A) HRO(EARN/BK) SAF(EARN/DOC:M) TEC(CT/DOC/COND/EARN/accusation/BK:A) ANL(CT/DOC/ID:P/COND:P/EARN:P) AUD(CT:M/DOC:M) | ACC CON DSP_WALL | A |
| driver/&lt;id&gt;/money | People — drivers | ID,CT,DOC,CASH,EARN | OWN | MGT(DOC:M) FIN(DOC) CLK(CT/DOC/EARN) OPS(DOC/CASH) DSP(DOC/CASH/EARN) HRO(CASH/EARN) SAF(CASH/EARN/DOC:M) TEC(CT/DOC/CASH/EARN) ANL(CT/DOC/CASH/ID:P/EARN:P) AUD(CT:M/DOC:M) | ACC CON DSP_WALL |  |
| driver/&lt;id&gt;/trips | People — drivers | ID,CT,DOC,BK,LOC,EARN,VEH,COND | OWN | MGT(DOC:M) FIN(DOC/LOC/COND/accusation) CLK(CT/DOC/BK/LOC/EARN/VEH/COND/accusation) OPS(DOC) DSP(DOC/EARN/accusation/COND:A) HRO(BK/LOC/EARN) SAF(EARN/DOC:M) TEC(CT/DOC/EARN/COND/accusation/BK:A) ANL(CT/DOC/ID:P/EARN:P/COND:P) AUD(CT:M/DOC:M) | ACC CON DSP_WALL | A |
| driver/&lt;id&gt;/unauthorized | People — drivers | ID,CT,DOC,COND,VEH,REV | OWN | MGT(DOC:M) FIN(DOC/COND/accusation) CLK(CT/DOC/COND/VEH/REV/accusation) OPS(DOC) DSP(DOC/REV/accusation/COND:A) HRO(REV) SAF(REV/DOC:M) TEC(CT/DOC/COND/REV/accusation) ANL(CT/DOC/ID:P/COND:P) AUD(CT:M/DOC:M) | ACC CON DSP_WALL | A |
| online-time | People — drivers | ID,CT,COND,LOC,VEH | OWN MGT OPS SAF | FIN(COND/LOC/accusation) CLK(CT/COND/LOC/VEH/accusation) DSP(accusation/COND:A) HRO(LOC) TEC(CT/COND/accusation) ANL(CT/ID:P/COND:P) AUD(CT:M) | ACC CON DSP_WALL | A |
| performer/&lt;id&gt;[/&lt;week&gt;] | People — drivers | ID,EARN,BK,LOC,VEH | OWN MGT OPS AUD | FIN(LOC) CLK(EARN/BK/LOC/VEH) DSP(EARN) HRO(EARN/BK/LOC) SAF(EARN) TEC(EARN/BK:A) ANL(ID:P/EARN:P) | ACC CON DSP_WALL |  |
| cohort/&lt;cohort-id&gt; (driver cohorts) | People — drivers | ID,EARN,CASH,COND,DOC,VEH,BK | OWN | MGT(DOC:M) FIN(COND/DOC/accusation) CLK(EARN/COND/DOC/VEH/BK/accusation) OPS(CASH/DOC) DSP(EARN/CASH/DOC/accusation/COND:A) HRO(EARN/CASH/BK) SAF(EARN/CASH/DOC:M) TEC(EARN/CASH/COND/DOC/accusation/BK:A) ANL(CASH/DOC/ID:P/EARN:P/COND:P) AUD(DOC:M) | ACC CON DSP_WALL | A |
| cohort/&lt;cohort-id&gt; (vehicle cohorts) | People — drivers | VEH,ID,LOC,COND,REV | OWN MGT OPS AUD | FIN(LOC/COND) DSP(REV/COND:A) HRO(LOC/REV) SAF(REV) TEC(COND/REV) ANL(ID:P/COND:P) DSP_WALL(ID/COND/VEH:A/LOC:A) | CLK ACC CON |  |
| cancellations | People — the rest | ID,CT,COND,VEH,BK | OWN MGT OPS SAF | FIN(COND/accusation) CLK(CT/COND/VEH/BK/accusation) DSP(accusation/COND:A) HRO(BK) TEC(CT/COND/accusation/BK:A) ANL(CT/ID:P/COND:P) AUD(CT:M) | ACC CON DSP_WALL | A |
| roster (tab all) | People — the rest | ID,COND,EARN,VEH,BK,MRG | OWN MGT AUD | FIN(COND/MRG/accusation) CLK(COND/EARN/VEH/BK/MRG/accusation) OPS(MRG) DSP(EARN/MRG/accusation/COND:A) HRO(EARN/BK) SAF(EARN/MRG) TEC(COND/EARN/MRG/accusation/BK:A) ANL(MRG/ID:P/COND:P/EARN:P) | ACC CON DSP_WALL | A |
| roster/pipeline | People — the rest | ID,COND,VEH | OWN MGT OPS HRO SAF AUD | FIN(COND) CLK(COND/VEH) DSP(COND:A) TEC(COND) ANL(ID:P/COND:P) | ACC CON DSP_WALL |  |
| roster/idle | People — the rest | ID,COND,VEH,BK | OWN MGT OPS SAF AUD | FIN(COND/accusation) CLK(COND/VEH/BK/accusation) DSP(accusation/COND:A) HRO(BK) TEC(COND/accusation/BK:A) ANL(ID:P/COND:P) | ACC CON DSP_WALL | A |
| roster/blocked | People — the rest | ID,COND,VEH | OWN MGT OPS HRO SAF AUD | FIN(COND/accusation) CLK(COND/VEH/accusation) DSP(accusation/COND:A) TEC(COND/accusation) ANL(ID:P/COND:P) | ACC CON DSP_WALL | A |
| roster/states | People — the rest | SYS | OWN MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC CON DSP_WALL |  |  |  |
| top-performers[/&lt;week&gt;] | People — the rest | ID,EARN,BK,VEH | OWN MGT FIN OPS AUD | CLK(EARN/BK/VEH) DSP(EARN) HRO(EARN/BK) SAF(EARN) TEC(EARN/BK:A) ANL(ID:P/EARN:P) | ACC CON DSP_WALL |  |
| low-performers[/&lt;week&gt;] | People — the rest | ID,EARN,COND,BK,VEH | OWN MGT OPS AUD | FIN(COND/accusation) CLK(EARN/COND/BK/VEH/accusation) DSP(EARN/accusation/COND:A) HRO(EARN/BK) SAF(EARN) TEC(EARN/COND/accusation/BK:A) ANL(ID:P/EARN:P/COND:P) | ACC CON DSP_WALL | A |
| performance[/&lt;period&gt;] (grain week) | People — the rest | ID,COND,EARN,BK | OWN MGT OPS AUD | FIN(COND/accusation) CLK(COND/EARN/BK/accusation) DSP(EARN/accusation/COND:A) HRO(EARN/BK) SAF(EARN) TEC(COND/EARN/accusation/BK:A) ANL(ID:P/COND:P/EARN:P) | ACC CON DSP_WALL | A |
| performance?grain=month[/&lt;period&gt;] | People — the rest | ID,COND,EARN,BK | OWN MGT OPS AUD | FIN(COND/accusation) CLK(COND/EARN/BK/accusation) DSP(EARN/accusation/COND:A) HRO(EARN/BK) SAF(EARN) TEC(COND/EARN/accusation/BK:A) ANL(ID:P/COND:P/EARN:P) | ACC CON DSP_WALL | A |
| retention | People — the rest | ID,BK,VEH | OWN MGT FIN OPS DSP SAF AUD | CLK(BK/VEH) HRO(BK) TEC(BK:A) ANL(ID:P) | ACC CON DSP_WALL |  |
| compliance | People — the rest | ID,CT,DOC,HR,VEH,COND | OWN HRO | MGT(DOC:M/HR:M) FIN(DOC/HR/COND/accusation) CLK(CT/DOC/HR/VEH/COND/accusation) OPS(DOC/HR) DSP(DOC/HR/accusation/COND:A) SAF(HR/DOC:M) TEC(CT/DOC/HR/COND/accusation) ANL(CT/DOC/HR/ID:P/COND:P) AUD(CT:M/DOC:M/HR:M) | ACC CON DSP_WALL | A |
| hr-roster | People — the rest | HR,ID,DOC,MRG | OWN HRO | MGT(HR:M/DOC:M) AUD(HR:M/DOC:M) | FIN CLK OPS DSP SAF TEC ANL ACC CON DSP_WALL |  |
| identity | People — the rest | MRG,ID,CT | OWN MGT HRO | AUD(CT:M) | FIN CLK OPS DSP SAF TEC ANL ACC CON DSP_WALL |  |
| same-person | People — the rest | MRG,ID,CT,HR,VEH,BK | OWN | MGT(HR:M) HRO(BK) AUD(CT:M/HR:M) | FIN CLK OPS DSP SAF TEC ANL ACC CON DSP_WALL |  |
| #insights | Today | ID,COND,DOC,VEH,REV,SYS | OWN | MGT(DOC:M) FIN(COND/DOC/accusation) CLK(COND/DOC/VEH/REV/accusation) OPS(DOC) DSP(DOC/REV/accusation/COND:A) HRO(REV) SAF(REV/DOC:M) TEC(COND/DOC/REV/accusation) ANL(DOC/ID:P/COND:P) AUD(DOC:M) | ACC CON DSP_WALL | A |
| #insights/&lt;category&gt; | Today | ID,COND,DOC,VEH,REV,SYS | OWN | MGT(DOC:M) FIN(COND/DOC/accusation) CLK(COND/DOC/VEH/REV/accusation) OPS(DOC) DSP(DOC/REV/accusation/COND:A) HRO(REV) SAF(REV/DOC:M) TEC(COND/DOC/REV/accusation) ANL(DOC/ID:P/COND:P) AUD(DOC:M) | ACC CON DSP_WALL | A |
| #insights/severity/&lt;critical\|warning&gt; | Today | ID,COND,DOC,VEH,REV,SYS | OWN | MGT(DOC:M) FIN(COND/DOC/accusation) CLK(COND/DOC/VEH/REV/accusation) OPS(DOC) DSP(DOC/REV/accusation/COND:A) HRO(REV) SAF(REV/DOC:M) TEC(COND/DOC/REV/accusation) ANL(DOC/ID:P/COND:P) AUD(DOC:M) | ACC CON DSP_WALL | A |
| #action/&lt;code&gt;/&lt;entity_id\|-&gt; | Today | ID,CT,COND,DOC,VEH,LOC,REV | OWN | MGT(DOC:M) FIN(COND/DOC/LOC/accusation) CLK(CT/COND/DOC/VEH/LOC/REV/accusation) OPS(DOC) DSP(DOC/REV/accusation/COND:A) HRO(LOC/REV) SAF(REV/DOC:M) TEC(CT/COND/DOC/REV/accusation) ANL(CT/DOC/ID:P/COND:P) AUD(CT:M/DOC:M) | ACC CON DSP_WALL | A |
| #playbook | Today | REV,ID,CASH,DOC,VEH,LOC,BK | OWN | MGT(DOC:M) FIN(DOC/LOC) OPS(CASH/DOC) ANL(CASH/DOC/ID:P) AUD(DOC:M) DSP_WALL(ID/CASH/DOC/VEH:A/LOC:A/BK:A) | CLK DSP HRO SAF TEC ACC CON |  |
| #overview | Today | BK,REV,ID,COND,VEH | OWN MGT OPS AUD | FIN(COND) DSP(REV/COND:A) SAF(REV) TEC(REV/COND/BK:A) ANL(ID:P/COND:P) DSP_WALL(ID/COND/BK:A/VEH:A) | CLK HRO ACC CON |  |
| #compare/&lt;dayA&gt;/&lt;dayB&gt;[?cut=full] | Today | BK,REV,ID,COND,VEH | OWN MGT OPS AUD | FIN(COND/accusation) DSP(REV/accusation/COND:A) SAF(REV) TEC(REV/COND/accusation/BK:A) ANL(ID:P/COND:P) DSP_WALL(ID/COND/accusation/BK:A/VEH:A) | CLK HRO ACC CON | A |
| #analyst | Today | REV,BK,ID,COND,VEH,LOC | OWN MGT OPS AUD | FIN(COND/LOC/accusation) ANL(ID:P/COND:P) DSP_WALL(ID/COND/accusation/BK:A/VEH:A/LOC:A) | CLK DSP HRO SAF TEC ACC CON | A |
| #analyst/refuted | Today | REV,BK,ID,COND,VEH | OWN MGT OPS AUD | FIN(COND/accusation) ANL(ID:P/COND:P) DSP_WALL(ID/COND/accusation/BK:A/VEH:A) | CLK DSP HRO SAF TEC ACC CON | A |
| #analyst/immaterial | Today | REV,BK,ID,COND,VEH | OWN MGT OPS AUD | FIN(COND/accusation) ANL(ID:P/COND:P) DSP_WALL(ID/COND/accusation/BK:A/VEH:A) | CLK DSP HRO SAF TEC ACC CON | A |
| #analyst/unsupported | Today | REV,BK,ID | OWN MGT FIN OPS AUD | ANL(ID:P) DSP_WALL(ID/BK:A) | CLK DSP HRO SAF TEC ACC CON |  |
| #analyst/rules | Today | ID,VEH | OWN MGT FIN OPS DSP HRO SAF TEC AUD | CLK(VEH) ANL(ID:P) | ACC CON DSP_WALL |  |
| #unit | Money | REV,EARN,ID,VEH,LOC | OWN MGT OPS AUD | FIN(LOC/accusation) ANL(EARN:P/ID:P) DSP_WALL(EARN/ID/accusation/VEH:A/LOC:A) | CLK DSP HRO SAF TEC ACC CON | A |
| #unit/assets | Money | VEH,REV,ID | OWN MGT FIN OPS AUD | DSP(REV) HRO(REV) SAF(REV) TEC(REV) ANL(ID:P) DSP_WALL(ID/VEH:A) | CLK ACC CON |  |
| #unit/drivers | Money | ID,EARN,COND,DOC,VEH | OWN | MGT(DOC:M) FIN(COND/DOC/accusation) CLK(EARN/COND/DOC/VEH/accusation) OPS(DOC) DSP(EARN/DOC/accusation/COND:A) HRO(EARN) SAF(EARN/DOC:M) TEC(EARN/COND/DOC/accusation) ANL(DOC/ID:P/EARN:P/COND:P) AUD(DOC:M) | ACC CON DSP_WALL | A |
| #cohort/unit-(drove-unpaid\|earned-nothing\|no-hours\|licence-due) | Money | ID,EARN,COND,DOC,VEH,BK | OWN | MGT(DOC:M) FIN(COND/DOC/accusation) CLK(EARN/COND/DOC/VEH/BK/accusation) OPS(DOC) DSP(EARN/DOC/accusation/COND:A) HRO(EARN/BK) SAF(EARN/DOC:M) TEC(EARN/COND/DOC/accusation/BK:A) ANL(DOC/ID:P/EARN:P/COND:P) AUD(DOC:M) | ACC CON DSP_WALL | A |
| #cohort/unit-(idle-documented\|moved-unpaid\|still) | Money | VEH,ID,COND,REV,SYS | OWN MGT OPS AUD | FIN(COND/accusation) DSP(REV/accusation/COND:A) HRO(REV) SAF(REV) TEC(COND/REV/accusation) ANL(ID:P/COND:P) DSP_WALL(ID/COND/accusation/VEH:A) | CLK ACC CON | A |
| #revenue | Money | REV,PAY,SYS | OWN MGT FIN ANL AUD | OPS(PAY) DSP_WALL(PAY) | CLK DSP HRO SAF TEC ACC CON |  |
| #corporate | Money | REV,BK,LOC | OWN MGT OPS ANL AUD | FIN(LOC) DSP_WALL(BK:A/LOC:A) | CLK DSP HRO SAF TEC ACC CON |  |
| #corporate/properties | Money | REV,BK | OWN MGT FIN OPS ANL AUD | DSP_WALL(BK:A) | CLK DSP HRO SAF TEC ACC CON |  |
| #corporate/guests | Money | BK,REV | OWN MGT FIN OPS ANL AUD | DSP(REV) SAF(REV) TEC(REV/BK:A) DSP_WALL(BK:A) | CLK HRO ACC CON |  |
| #corporate/leakage | Money | REV,BK | OWN MGT FIN OPS ANL AUD | DSP_WALL(BK:A) | CLK DSP HRO SAF TEC ACC CON |  |
| #corporate/leakage/&lt;kind&gt; | Money | BK,REV,ID,VEH,LOC | OWN MGT OPS AUD | FIN(LOC/accusation) DSP(REV/accusation) SAF(REV) TEC(REV/accusation/BK:A) ANL(ID:P) DSP_WALL(ID/accusation/BK:A/VEH:A/LOC:A) | CLK HRO ACC CON | A |
| #corporate/approach[/property\|daypart\|type\|zone] | Money | LOC,BK | OWN MGT OPS DSP SAF ANL AUD | TEC(BK:A) DSP_WALL(LOC:A/BK:A) | FIN CLK HRO ACC CON |  |
| #corporate/approach/driver | Money | LOC,ID,COND | OWN MGT OPS SAF AUD | DSP(accusation/COND:A) TEC(COND/accusation) ANL(ID:P/COND:P) DSP_WALL(ID/COND/accusation/LOC:A) | FIN CLK HRO ACC CON | A |
| #property/&lt;id&gt; | Money | REV,BK | OWN MGT FIN OPS ANL AUD | DSP_WALL(BK:A) | CLK DSP HRO SAF TEC ACC CON |  |
| #property/&lt;id&gt;/guests | Money | BK,REV | OWN MGT FIN OPS ANL AUD | DSP(REV) SAF(REV) TEC(REV/BK:A) DSP_WALL(BK:A) | CLK HRO ACC CON |  |
| #property/&lt;id&gt;/drivers | Money | ID,EARN,LOC | OWN MGT OPS AUD | FIN(LOC) CLK(EARN/LOC) DSP(EARN) HRO(EARN/LOC) SAF(EARN) TEC(EARN) ANL(ID:P/EARN:P) | ACC CON DSP_WALL |  |
| #import-sheet | Money | ID,CASH,MRG | OWN MGT AUD | FIN(MRG) CLK(MRG) OPS(CASH/MRG) DSP(CASH/MRG) HRO(CASH) SAF(CASH/MRG) TEC(CASH/MRG) ANL(CASH/MRG/ID:P) | ACC CON DSP_WALL |  |
| #opening | Money | ID,CASH | OWN MGT FIN CLK AUD | OPS(CASH) DSP(CASH) HRO(CASH) SAF(CASH) TEC(CASH) ANL(CASH/ID:P) | ACC CON DSP_WALL |  |
| #salary | Money | ID,CASH,EARN | OWN MGT FIN AUD | CLK(EARN) OPS(CASH) DSP(CASH/EARN) HRO(CASH/EARN) SAF(CASH/EARN) TEC(CASH/EARN) ANL(CASH/ID:P/EARN:P) | ACC CON DSP_WALL |  |
| #advances | Money | ID,CASH,EARN | OWN MGT AUD | FIN(accusation) CLK(EARN/accusation) OPS(CASH) DSP(CASH/EARN/accusation) HRO(CASH/EARN) SAF(CASH/EARN) TEC(CASH/EARN/accusation) ANL(CASH/ID:P/EARN:P) | ACC CON DSP_WALL | A |
| #charging | Money | ID,CASH | OWN MGT FIN CLK AUD | OPS(CASH) DSP(CASH) HRO(CASH) SAF(CASH) TEC(CASH) ANL(CASH/ID:P) | ACC CON DSP_WALL |  |
| #policy | Money | CRED,CASH | OWN | CON(CASH) | MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC DSP_WALL |  |
| #deposits | Money | ID,CASH | OWN MGT FIN CLK AUD | OPS(CASH) DSP(CASH) HRO(CASH) SAF(CASH) TEC(CASH) ANL(CASH/ID:P) | ACC CON DSP_WALL |  |
| #deposits (phone shell, coarse pointer and 760px wide or less) | Money | ID,CASH | OWN MGT FIN CLK AUD | OPS(CASH) DSP(CASH) HRO(CASH) SAF(CASH) TEC(CASH) ANL(CASH/ID:P) | ACC CON DSP_WALL |  |
| #finance | Finance | REV,PAY,ID,EARN,COND | OWN MGT AUD | FIN(COND/accusation) OPS(PAY) ANL(ID:P/EARN:P/COND:P) DSP_WALL(PAY/ID/EARN/COND/accusation) | CLK DSP HRO SAF TEC ACC CON | A |
| #receipts | Finance | PAY,SYS | OWN MGT FIN ANL AUD |  | CLK OPS DSP HRO SAF TEC ACC CON DSP_WALL |  |
| #payouts | Finance | PAY,REV | OWN MGT FIN ANL AUD |  | CLK OPS DSP HRO SAF TEC ACC CON DSP_WALL |  |
| #reconcile | Finance | PAY,REV | OWN MGT FIN ANL AUD |  | CLK OPS DSP HRO SAF TEC ACC CON DSP_WALL |  |
| #reconcile/&lt;YYYY-MM&gt; | Finance | PAY,REV | OWN MGT FIN ANL AUD |  | CLK OPS DSP HRO SAF TEC ACC CON DSP_WALL |  |
| #settlement | Finance | REV,BK | OWN MGT FIN OPS ANL AUD | DSP_WALL(BK:A) | CLK DSP HRO SAF TEC ACC CON |  |
| #settlement/cash | Finance | ID,CASH,EARN,VEH,REV | OWN MGT FIN AUD | CLK(EARN/VEH/REV) OPS(CASH) DSP(CASH/EARN/REV) HRO(CASH/EARN/REV) SAF(CASH/EARN/REV) TEC(CASH/EARN/REV) ANL(CASH/ID:P/EARN:P) | ACC CON DSP_WALL |  |
| #settlement/receivables | Finance | PAY,REV,ID,CASH | OWN MGT FIN AUD | ANL(CASH/ID:P) | CLK OPS DSP HRO SAF TEC ACC CON DSP_WALL |  |
| #cohort/settlement-cash | Finance | ID,CASH,EARN,COND,DOC,VEH | OWN | MGT(DOC:M) FIN(COND/DOC/accusation) CLK(EARN/COND/DOC/VEH/accusation) OPS(CASH/DOC) DSP(CASH/EARN/DOC/accusation/COND:A) HRO(CASH/EARN) SAF(CASH/EARN/DOC:M) TEC(CASH/EARN/COND/DOC/accusation) ANL(CASH/DOC/ID:P/EARN:P/COND:P) AUD(DOC:M) | ACC CON DSP_WALL | A |
| #provenance | Finance | REV,PAY,SYS | OWN MGT FIN ANL AUD | OPS(PAY) DSP_WALL(PAY) | CLK DSP HRO SAF TEC ACC CON |  |
| vehicles | Fleet | VEH,REV,ID | OWN MGT FIN OPS AUD | DSP(REV) HRO(REV) SAF(REV) TEC(REV) ANL(ID:P) DSP_WALL(ID/VEH:A) | CLK ACC CON |  |
| vehicle/&lt;plate&gt; (overview) | Fleet | VEH,REV,ID,COND | OWN MGT OPS AUD | FIN(COND/accusation) DSP(REV/accusation/COND:A) HRO(REV) SAF(REV) TEC(REV/COND/accusation) ANL(ID:P/COND:P) DSP_WALL(ID/COND/accusation/VEH:A) | CLK ACC CON | A |
| vehicle/&lt;plate&gt;/drivers | Fleet | ID,EARN,BK,VEH | OWN MGT FIN OPS AUD | CLK(EARN/BK/VEH) DSP(EARN) HRO(EARN/BK) SAF(EARN) TEC(EARN/BK:A) ANL(ID:P/EARN:P) | ACC CON DSP_WALL |  |
| vehicle/&lt;plate&gt;/movement (?day=) | Fleet | LOC,VEH,ID | OWN MGT OPS DSP SAF TEC AUD | ANL(ID:P) DSP_WALL(ID/LOC:A/VEH:A) | FIN CLK HRO ACC CON |  |
| vehicle/&lt;plate&gt;/earnings | Fleet | EARN,REV,ID | OWN MGT FIN OPS AUD | ANL(EARN:P/ID:P) | CLK DSP HRO SAF TEC ACC CON DSP_WALL |  |
| vehicle/&lt;plate&gt;/safety | Fleet | COND,ID,VEH,LOC | OWN MGT OPS SAF AUD | DSP(accusation/COND:A) HRO(LOC) ANL(COND:P/ID:P) | FIN CLK TEC ACC CON DSP_WALL | A |
| vehicle/&lt;plate&gt;/compliance | Fleet | VEH,ID | OWN MGT FIN OPS DSP HRO SAF TEC AUD | ANL(ID:P) DSP_WALL(ID/VEH:A) | CLK ACC CON |  |
| vehicle/&lt;plate&gt;/trips | Fleet | BK,ID,LOC,REV | OWN MGT OPS AUD | FIN(LOC) DSP(REV) SAF(REV) TEC(REV/BK:A) ANL(ID:P) DSP_WALL(ID/BK:A/LOC:A) | CLK HRO ACC CON |  |
| unauthorized | Fleet | COND,ID,VEH,LOC,REV | OWN MGT OPS AUD | DSP(REV/accusation/COND:A) HRO(LOC/REV) SAF(REV) ANL(COND:P/ID:P) | FIN CLK TEC ACC CON DSP_WALL | A |
| segments | Fleet | COND,ID,LOC,VEH | OWN MGT OPS SAF AUD | DSP(accusation/COND:A) HRO(LOC) ANL(COND:P/ID:P) | FIN CLK TEC ACC CON DSP_WALL | A |
| segments/verdict/&lt;verdict\|all&gt; | Fleet | COND,ID,LOC,VEH | OWN MGT OPS SAF AUD | DSP(accusation/COND:A) HRO(LOC) ANL(COND:P/ID:P) | FIN CLK TEC ACC CON DSP_WALL | A |
| segments/plate/&lt;plate&gt; | Fleet | COND,ID,LOC,VEH | OWN MGT OPS SAF AUD | DSP(accusation/COND:A) HRO(LOC) ANL(COND:P/ID:P) | FIN CLK TEC ACC CON DSP_WALL | A |
| segments/day/&lt;YYYY-MM-DD&gt; | Fleet | COND,ID,LOC,VEH | OWN MGT OPS SAF AUD | DSP(accusation/COND:A) HRO(LOC) ANL(COND:P/ID:P) | FIN CLK TEC ACC CON DSP_WALL | A |
| segments/driver/&lt;driver name&gt; | Fleet | COND,ID,LOC,VEH | OWN MGT OPS SAF AUD | DSP(accusation/COND:A) HRO(LOC) ANL(COND:P/ID:P) | FIN CLK TEC ACC CON DSP_WALL | A |
| segment/&lt;plate&gt;/&lt;started_at&gt; (?source=) | Fleet | COND,ID,LOC,BK,REV,VEH | OWN MGT OPS AUD | DSP(REV/accusation/COND:A) HRO(LOC/BK/REV) SAF(REV) ANL(COND:P/ID:P) | FIN CLK TEC ACC CON DSP_WALL | A |
| safety (safety/people) | Fleet | COND,ID,VEH | OWN MGT OPS HRO SAF AUD | DSP(accusation/COND:A) ANL(COND:P/ID:P) | FIN CLK TEC ACC CON DSP_WALL | A |
| safety/vehicles | Fleet | VEH,COND,ID | OWN MGT OPS HRO SAF AUD | FIN(COND/accusation) DSP(accusation/COND:A) TEC(COND/accusation) ANL(COND:P/ID:P) DSP_WALL(COND/ID/accusation/VEH:A) | CLK ACC CON | A |
| safety/events | Fleet | VEH | OWN MGT FIN OPS DSP HRO SAF TEC ANL AUD | DSP_WALL(VEH:A) | CLK ACC CON |  |
| live | Fleet | LOC,VEH,ID | OWN MGT OPS DSP SAF TEC AUD | ANL(ID:P) DSP_WALL(ID/LOC:A/VEH:A) | FIN CLK HRO ACC CON |  |
| feeds | Fleet | VEH,SYS,ID,CT | OWN MGT FIN OPS DSP HRO SAF | TEC(CT) ANL(CT/ID:P) AUD(CT:M) DSP_WALL(ID/CT/VEH:A) | CLK ACC CON |  |
| map | Fleet | LOC,ID,VEH | OWN MGT OPS DSP SAF TEC AUD | ANL(ID:P) DSP_WALL(ID/LOC:A/VEH:A) | FIN CLK HRO ACC CON |  |
| map/replay/&lt;plate&gt;?day= | Fleet | LOC,ID,VEH | OWN MGT OPS DSP SAF TEC AUD | ANL(ID:P) DSP_WALL(ID/LOC:A/VEH:A) | FIN CLK HRO ACC CON |  |
| sources | Sources | SYS,ID,CT,LOC | OWN MGT OPS DSP SAF | FIN(LOC) CLK(CT/LOC) HRO(LOC) TEC(CT) ANL(CT/ID:P) AUD(CT:M) ACC(ID/CT/LOC) CON(ID/CT/LOC) DSP_WALL(ID/CT/LOC:A) |  |  |
| coverage | Sources | SYS | OWN MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC CON DSP_WALL |  |  |  |
| providers | Sources | SYS | OWN MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC CON DSP_WALL |  |  |  |
| providers/&lt;provider&gt;/&lt;surface&gt;/&lt;key&gt; | Sources | SYS,ID,CT,LOC,BK | OWN MGT OPS DSP SAF | FIN(LOC) CLK(CT/LOC/BK) HRO(LOC/BK) TEC(CT/BK:A) ANL(CT/ID:P) AUD(CT:M) ACC(ID/CT/LOC/BK) CON(ID/CT/LOC/BK) DSP_WALL(ID/CT/LOC:A/BK:A) |  |  |
| settings | Set up | CRED,SYS | OWN CON |  | MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC DSP_WALL |  |
| settings (paste panel) | Set up | CRED | OWN CON |  | MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC DSP_WALL |  |
| notfound | (router) |  | OWN MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC CON DSP_WALL |  |  |  |
| (shell, every desktop page) | (shell) | REV,SYS,CRED | OWN | MGT(CRED) FIN(CRED) OPS(CRED) ANL(CRED) AUD(CRED) DSP_WALL(CRED) | CLK DSP HRO SAF TEC ACC CON |  |
| m:today (aliases m:overview) | m:Today | REV,SYS | OWN MGT FIN OPS ANL AUD DSP_WALL |  | CLK DSP HRO SAF TEC ACC CON |  |
| m:money (aliases m:finance, m:unit, m:settlement, m:revenue) | m:Money | REV | OWN MGT FIN OPS ANL AUD DSP_WALL |  | CLK DSP HRO SAF TEC ACC CON |  |
| m:people (alias m:drivers) | m:People | ID,EARN | OWN MGT FIN OPS AUD | CLK(EARN) DSP(EARN) HRO(EARN) SAF(EARN) TEC(EARN) ANL(ID:P/EARN:P) | ACC CON DSP_WALL |  |
| m:online-time (?day&start) | m:People | ID,CT,COND,VEH | OWN MGT OPS HRO SAF | FIN(COND/accusation) CLK(CT/COND/VEH/accusation) DSP(accusation/COND:A) TEC(CT/COND/accusation) ANL(CT/ID:P/COND:P) AUD(CT:M) | ACC CON DSP_WALL | A |
| m:fleet (alias m:vehicles) | m:Fleet | VEH,ID,REV,LOC | OWN MGT OPS AUD | FIN(LOC) DSP(REV) HRO(REV/LOC) SAF(REV) TEC(REV) ANL(ID:P) DSP_WALL(ID/VEH:A/LOC:A) | CLK ACC CON |  |
| m:vehicle/&lt;plate&gt; | m:Fleet | VEH,REV,ID | OWN MGT FIN OPS AUD | DSP(REV) HRO(REV) SAF(REV) TEC(REV) ANL(ID:P) DSP_WALL(ID/VEH:A) | CLK ACC CON |  |
| m:vehicle/&lt;plate&gt;/&lt;tab&gt; (fallback) | m:Fleet | VEH,REV,ID,EARN,COND,LOC,BK | OWN MGT OPS AUD | FIN(COND/LOC/accusation) DSP(REV/EARN/accusation/COND:A) HRO(REV/EARN/LOC/BK) SAF(REV/EARN) TEC(REV/EARN/COND/accusation/BK:A) ANL(ID:P/EARN:P/COND:P) DSP_WALL(ID/EARN/COND/accusation/VEH:A/LOC:A/BK:A) | CLK ACC CON | A |
| m:driver/&lt;id&gt; | m:People | ID,CT,EARN,COND | OWN MGT OPS | FIN(COND/accusation) CLK(CT/EARN/COND/accusation) DSP(EARN/accusation/COND:A) HRO(EARN) SAF(EARN) TEC(CT/EARN/COND/accusation) ANL(CT/ID:P/EARN:P/COND:P) AUD(CT:M) | ACC CON DSP_WALL | A |
| m:driver/&lt;id&gt;/&lt;tab&gt; (fallback) | m:People | ID,CT,DOC,EARN,CASH,COND,BK,LOC,MRG | OWN | MGT(DOC:M) FIN(DOC/COND/LOC/MRG/accusation) CLK(CT/DOC/EARN/COND/BK/LOC/MRG/accusation) OPS(DOC/CASH/MRG) DSP(DOC/EARN/CASH/MRG/accusation/COND:A) HRO(EARN/CASH/BK/LOC) SAF(EARN/CASH/MRG/DOC:M) TEC(CT/DOC/EARN/CASH/COND/MRG/accusation/BK:A) ANL(CT/DOC/CASH/MRG/ID:P/EARN:P/COND:P) AUD(CT:M/DOC:M) | ACC CON DSP_WALL | A |
| m:live | m:More | LOC,VEH | OWN MGT OPS DSP SAF TEC ANL AUD | DSP_WALL(LOC:A/VEH:A) | FIN CLK HRO ACC CON |  |
| m:safety | m:More | VEH | OWN MGT FIN OPS DSP HRO SAF TEC ANL AUD | DSP_WALL(VEH:A) | CLK ACC CON |  |
| m:unauthorized | m:More | COND,ID,VEH | OWN MGT OPS HRO SAF AUD | DSP(accusation/COND:A) ANL(COND:P/ID:P) | FIN CLK TEC ACC CON DSP_WALL | A |
| m:sources | m:More | SYS | OWN MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC CON DSP_WALL |  |  |  |
| m:trips | m:More | BK,ID,LOC,REV | OWN MGT OPS AUD | FIN(LOC) DSP(REV) SAF(REV) TEC(REV/BK:A) ANL(ID:P) DSP_WALL(ID/BK:A/LOC:A) | CLK HRO ACC CON |  |
| m:more | m:More |  | OWN MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC CON DSP_WALL |  |  |  |
| m:payouts | m:Money | PAY | OWN MGT FIN ANL AUD |  | CLK OPS DSP HRO SAF TEC ACC CON DSP_WALL |  |
| m:corporate | m:More | REV | OWN MGT FIN OPS ANL AUD DSP_WALL |  | CLK DSP HRO SAF TEC ACC CON |  |
| m:analyst | m:More | REV | OWN MGT FIN OPS ANL AUD DSP_WALL |  | CLK DSP HRO SAF TEC ACC CON |  |
| m:optimise | m:More | LOC,REV | OWN MGT OPS ANL AUD | DSP(REV) SAF(REV) TEC(REV) DSP_WALL(LOC:A) | FIN CLK HRO ACC CON |  |
| m:credentials | m:More | CRED | OWN CON |  | MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC DSP_WALL |  |
| m:deposits | m:Money | ID,CASH | OWN MGT FIN CLK AUD | OPS(CASH) DSP(CASH) HRO(CASH) SAF(CASH) TEC(CASH) ANL(CASH/ID:P) | ACC CON DSP_WALL |  |
| m:&lt;any view without a phone screen&gt; (fallback) | m:(fallback) |  | OWN MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC CON DSP_WALL |  |  |  |
| m:(shell) | m:(shell) | SYS | OWN MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC CON DSP_WALL |  |  |  |

## Appendix C — every API route, today and under ULM

Generated from the 2026-09-26 inventory of 189 routes. "gate today" is what guards the route now (`none` means anonymous). "requires" is the capability the route manifest (§9.1) will declare: `view:` routes need every listed class at a level that lets the response be shaped (fields the caller holds at a lower level are masked or withheld by the shaper, not refused outright), and `act:` routes are the actions in §8. `fleet` says whether the route takes a fleet parameter today (the manifest adds fleet scoping to every route that returns fleet-bearing rows).

| method | route | carries | gate today | fleet | requires |
|---|---|---|---|---|---|
| GET | * (static index.html catch-all, after express.static at :7101) | — | none | no | signed-in |
| GET | /.well-known/appspecific/com.tesla.3p.public-key.pem | — | none | no | signed-in |
| GET | /api/admin-mode | CRED | isAdmin_redaction | no | view:CRED |
| GET | /api/alerts/by-driver | COND,ID,VEH | none | yes | view:COND+ID+VEH |
| GET | /api/alerts/by-vehicle | COND,VEH,ID | none | yes | view:COND+VEH+ID |
| GET | /api/alerts/summary | VEH,COND | none | yes | view:VEH+COND |
| GET | /api/analyst/brief | REV,ID,VEH | none | yes | view:REV+ID+VEH |
| GET | /api/analyst/findings | REV,ID | none | yes | view:REV+ID |
| GET | /api/analyst/rules | SYS | none | no | view:SYS |
| POST | /api/analyst/run | REV,ID,VEH | none | yes | act:analyst.run (third-party transfer; pseudonymised brief) |
| GET | /api/auth | CRED,SYS | none | no | view:CRED+SYS |
| GET | /api/breaks | REV | none | yes | view:REV |
| GET | /api/cache-stats | SYS | none | no | view:SYS |
| GET | /api/cancellations | COND,ID,CT | none | no | view:COND+ID+CT |
| GET | /api/capacity | VEH,LOC | none | yes | view:VEH+LOC |
| GET | /api/cohort/drivers | ID,EARN,COND,DOC | none | no | view:ID+EARN+COND+DOC |
| GET | /api/cohort/vehicles | VEH,REV,ID | none | no | view:VEH+REV+ID |
| GET | /api/compare | REV,ID,EARN,LOC | none | yes | view:REV+ID+EARN+LOC |
| GET | /api/compare/period | REV,BK | none | yes | view:REV+BK |
| GET | /api/compliance/drivers | ID,CT,DOC,HR,COND,MRG | isAdmin_redaction | yes | view:ID+CT+DOC+HR+COND+MRG |
| GET | /api/compliance/vehicles | VEH,ID | none | yes | view:VEH+ID |
| GET | /api/context | — | none | no | signed-in |
| GET | /api/corporate/approach | BK,LOC,ID | none | yes | view:BK+LOC+ID |
| GET | /api/corporate/guests | BK,REV | none | yes | view:BK+REV |
| GET | /api/corporate/leakage | BK,REV,ID,COND | none | yes | view:BK+REV+ID+COND |
| GET | /api/corporate/properties | REV | none | yes | view:REV |
| GET | /api/corporate/property | REV,BK,ID,VEH | none | yes | view:REV+BK+ID+VEH |
| GET | /api/corporate/stranding | LOC,BK | none | yes | view:LOC+BK |
| GET | /api/corporate/summary | REV,BK | none | yes | view:REV+BK |
| GET | /api/coverage | SYS | none | yes | view:SYS |
| GET | /api/coverage/calendar | SYS | none | yes | view:SYS |
| GET | /api/coverage/verified | SYS | none | yes | view:SYS |
| GET | /api/day | BK,ID,VEH,LOC,REV,SYS | none | no | view:BK+ID+VEH+LOC+REV+SYS |
| GET | /api/driver/custody | VEH | none | no | view:VEH |
| GET | /api/driver/daily | EARN,BK | none | no | view:EARN+BK |
| GET | /api/driver/day | LOC,BK,EARN,VEH | none | no | view:LOC+BK+EARN+VEH |
| GET | /api/driver/days | BK,EARN | none | no | view:BK+EARN |
| GET | /api/driver/earnings | EARN,CASH | none | no | view:EARN+CASH |
| GET | /api/driver/heatmap | BK,EARN | none | no | view:BK+EARN |
| GET | /api/driver/kpis | EARN,BK,COND,VEH | none | no | view:EARN+BK+COND+VEH |
| GET | /api/driver/mix | EARN | none | no | view:EARN |
| GET | /api/driver/photo/:platform/:id | ID | none | no | view:ID |
| GET | /api/driver/profile | ID,CT,DOC,HR,COND,VEH,EARN,MRG | isAdmin_redaction | no | view:ID+CT+DOC+HR+COND+VEH+EARN+MRG |
| GET | /api/driver/quality | COND | none | no | view:COND |
| GET | /api/driver/register | CASH,EARN,BK,ID,VEH | none | no | view:CASH+EARN+BK+ID+VEH |
| GET | /api/driver/shift | BK,EARN,LOC | none | no | view:BK+EARN+LOC |
| GET | /api/driver/standing | COND,ID | none | no | view:COND+ID |
| GET | /api/driver/territory | LOC | none | no | view:LOC |
| GET | /api/driver/trips | BK,LOC,EARN | none | no | view:BK+LOC+EARN |
| GET | /api/driver/unauthorized | COND,ID,VEH,LOC | none | yes | view:COND+ID+VEH+LOC |
| GET | /api/driver/vehicles | VEH,EARN | none | no | view:VEH+EARN |
| GET | /api/drivers/cross-platform | ID,EARN | none | yes | view:ID+EARN |
| GET | /api/drivers/directory | ID,EARN,COND,DOC,VEH | none | yes | view:ID+EARN+COND+DOC+VEH |
| GET | /api/drivers/identity-links | MRG,ID | none | no | view:MRG+ID |
| GET | /api/drivers/leaderboard | ID,EARN,COND,VEH | none | yes | view:ID+EARN+COND+VEH |
| GET | /api/drivers/performance | ID,EARN,COND | none | yes | view:ID+EARN+COND |
| GET | /api/earnings/components | REV,EARN | none | yes | view:REV+EARN |
| GET | /api/earnings/tips | EARN,ID | none | yes | view:EARN+ID |
| GET | /api/economics/assets | VEH,REV,EARN,ID | none | yes | view:VEH+REV+EARN+ID |
| GET | /api/economics/drivers | ID,EARN,COND,DOC,VEH | none | yes | view:ID+EARN+COND+DOC+VEH |
| GET | /api/events | — | none | no | signed-in |
| POST | /api/events | — | requireAdmin | no | act:calendar.edit |
| GET | /api/export/trips.csv | BK,ID,VEH,REV,LOC | isAdmin_redaction | yes | view:BK+ID+VEH+REV+LOC |
| GET | /api/finance/daily | REV | none | yes | view:REV |
| GET | /api/finance/ledger | REV,PAY | none | yes | view:REV+PAY |
| GET | /api/finance/payouts | PAY | none | yes | view:PAY |
| GET | /api/finance/payouts/reconcile | PAY,REV | none | yes | view:PAY+REV |
| POST | /api/finance/payouts/verify | PAY | none | implicit_single_fleet | act:finance.verify (provider quota) |
| GET | /api/finance/receipts | REV,PAY | none | yes | view:REV+PAY |
| GET | /api/forecast | REV | none | yes | view:REV |
| GET | /api/funnel/drivers | ID,EARN,COND | none | yes | view:ID+EARN+COND |
| GET | /api/geo/corridors | LOC,REV | none | yes | view:LOC+REV |
| GET | /api/health | SYS | none | no | view:SYS |
| GET | /api/hr-roster | HR,ID,CT,DOC,MRG | none | no | view:HR+ID+CT+DOC+MRG |
| POST | /api/hr-roster/commit | HR,MRG,DOC | requireAdmin | no | act:hr.import +MFA |
| POST | /api/hr-roster/preview | HR,MRG,DOC | requireAdmin | no | act:hr.import |
| POST | /api/import/statement-days | EARN,CASH | requireAdmin | yes | act:finance.import |
| GET | /api/insights | ID,CT,COND,REV | none | yes | view:ID+CT+COND+REV |
| GET | /api/insights/summary | REV,COND | none | yes | view:REV+COND |
| GET | /api/kpis | REV,BK,VEH,SYS | none | yes | view:REV+BK+VEH+SYS |
| GET | /api/ledger/cash-position | CASH,ID | none | no | view:CASH+ID |
| GET | /api/ledger/entries | CASH,ID | none | no | view:CASH+ID |
| POST | /api/ledger/entry | CASH,ID | none | no | act:cash.record |
| GET | /api/ledger/exposure | CASH,EARN,ID | none | no | view:CASH+EARN+ID |
| POST | /api/ledger/import/commit | CASH,ID | none | no | act:cash.import.commit (four-eyes) |
| POST | /api/ledger/import/preview | CASH,ID | none | no | act:cash.import |
| GET | /api/ledger/people | ID,CASH | none | no | view:ID+CASH |
| GET | /api/ledger/policy | CRED | none | no | view:CRED |
| POST | /api/ledger/policy | CRED | none | no | act:cash.policy (reason required) |
| POST | /api/ledger/receipt | CASH | none | no | act:cash.record |
| GET | /api/ledger/receipt/:sha | CASH | none | no | view:CASH |
| GET | /api/live | LOC,VEH,ID | none | no | view:LOC+VEH+ID |
| GET | /api/map/days | LOC,ID,VEH | none | no | view:LOC+ID+VEH |
| GET | /api/map/journey | LOC,ID,VEH | none | no | view:LOC+ID+VEH |
| GET | /api/mix | REV | none | yes | view:REV |
| GET | /api/mix/detail | REV,ID | none | yes | view:REV+ID |
| GET | /api/money/sources | REV | none | yes | view:REV |
| GET | /api/online-time | ID,CT,COND,VEH | none | no | view:ID+CT+COND+VEH |
| GET | /api/optimise | LOC,VEH,REV | none | yes | view:LOC+VEH+REV |
| GET | /api/performance/driver | ID,EARN,COND | none | yes | view:ID+EARN+COND |
| GET | /api/performance/fleet | REV | none | yes | view:REV |
| GET | /api/performer | ID,EARN,BK,LOC,VEH | none | no | view:ID+EARN+BK+LOC+VEH |
| GET | /api/performer/weeks | — | none | no | signed-in |
| GET | /api/person/merge | MRG,CASH | none | no | view:MRG+CASH |
| POST | /api/person/merge | MRG,CASH | none | no | act:identity.merge (four-eyes) |
| GET | /api/platforms | SYS | none | no | view:SYS |
| GET | /api/playbook | ID,DOC,VEH,REV,LOC,COND | none | yes | view:ID+DOC+VEH+REV+LOC+COND |
| GET | /api/probe/bolt/payouts | PAY,CRED | none | yes | act:collector.probe (live provider calls) |
| GET | /api/probe/fms/window | CRED,SYS | none | no | act:collector.probe (live provider calls) |
| GET | /api/probe/results | SYS | none | no | act:collector.probe (live provider calls) |
| GET | /api/probe/tesla/egress | SYS | none | no | act:collector.probe (live provider calls) |
| GET | /api/probe/uber/audit | BK,SYS | none | yes | act:collector.probe (live provider calls) |
| GET | /api/probe/uber/driver | CRED,SYS | none | implicit_single_fleet | act:collector.probe (live provider calls) |
| GET | /api/probe/uber/realtime | CRED,SYS | none | no | act:collector.probe (live provider calls) |
| GET | /api/probe/uber/report-columns | CRED,SYS | none | implicit_single_fleet | act:collector.probe (live provider calls) |
| GET | /api/probe/uber/report-types | CRED,SYS | none | implicit_single_fleet | act:collector.probe (live provider calls) |
| GET | /api/probe/uber/rest | CRED,SYS | none | implicit_single_fleet | act:collector.probe (live provider calls) |
| GET | /api/probe/uber/tier | CRED,SYS | none | implicit_single_fleet | act:collector.probe (live provider calls) |
| GET | /api/probe/uber/timeline | LOC,COND,BK | none | no | act:collector.probe (live provider calls) |
| GET | /api/probe/uber/window | CRED,SYS | none | implicit_single_fleet | act:collector.probe (live provider calls) |
| GET | /api/probe/yango | CRED,SYS | none | no | act:collector.probe (live provider calls) |
| GET | /api/probe/yango/keyapi | CRED,SYS | none | no | act:collector.probe (live provider calls) |
| GET | /api/probe/yango/ledger | PAY,CRED | none | no | act:collector.probe (live provider calls) |
| GET | /api/probe/zero-distance | BK,ID | none | no | act:collector.probe (live provider calls) |
| GET | /api/product/by-vehicle | VEH,REV,ID | none | yes | view:VEH+REV+ID |
| GET | /api/ready | SYS | none | no | view:SYS |
| GET | /api/recommendations | REV | none | no | view:REV |
| GET | /api/reconcile | PAY,REV | none | yes | view:PAY+REV |
| GET | /api/reconcile/periods | PAY,REV | none | yes | view:PAY+REV |
| GET | /api/retention | ID,REV | none | yes | view:ID+REV |
| GET | /api/revenue | REV,VEH | none | yes | view:REV+VEH |
| GET | /api/rollups | SYS | none | no | view:SYS |
| GET | /api/roster | ID,COND,VEH,EARN | none | yes | view:ID+COND+VEH+EARN |
| GET | /api/roster/states | COND,VEH | none | yes | view:COND+VEH |
| GET | /api/same-person | MRG,ID,HR | none | no | view:MRG+ID+HR |
| POST | /api/same-person/decide | MRG | none | no | act:identity.decide |
| GET | /api/schema/raw-fields | SYS,ID,CT,BK,LOC | none | no | view:SYS+ID+CT+BK+LOC |
| GET | /api/schema/raw-values | SYS,ID,CT,BK,LOC | none | no | view:SYS+ID+CT+BK+LOC |
| GET | /api/segment | LOC,BK,ID,VEH | none | no | view:LOC+BK+ID+VEH |
| GET | /api/segments | VEH,COND,LOC | none | yes | view:VEH+COND+LOC |
| GET | /api/sensor-health | VEH,SYS | none | yes | view:VEH+SYS |
| GET | /api/settings | CRED | isAdmin_redaction | no | view:CRED |
| PUT | /api/settings | CRED | requireAdmin | no | act:credentials.write +MFA |
| GET | /api/settings/jobs | CRED,SYS | none | no | view:CRED+SYS |
| POST | /api/settings/paste | CRED | requireAdmin | no | act:credentials.write +MFA (apply) / act:credentials.test (test) |
| POST | /api/settings/trigger | CRED,SYS | requireAdmin | yes | act:collector.run (incremental) · act:collector.backfill (backfill, probe; quota) · act:analyst.run (analyst) |
| GET | /api/settlement/cash-exposure | CASH,ID | none | yes | view:CASH+ID |
| GET | /api/settlement/mix | REV | none | yes | view:REV |
| GET | /api/settlement/receivables | REV,CASH,ID | none | yes | view:REV+CASH+ID |
| GET | /api/slot | ID,VEH,LOC,BK | none | yes | view:ID+VEH+LOC+BK |
| GET | /api/status | SYS | none | no | view:SYS |
| GET | /api/status/driver | COND,VEH,ID | none | no | view:COND+VEH+ID |
| GET | /api/status/fleet | COND,ID,VEH | none | yes | view:COND+ID+VEH |
| GET | /api/supply/areas | LOC | none | yes | view:LOC |
| GET | /api/supply/balance | LOC,REV | none | yes | view:LOC+REV |
| GET | /api/tesla/connect | CRED | none | no | view:CRED · OAuth start/finish: act:credentials.write |
| GET | /api/tesla/status | VEH,CRED | none | no | view:VEH+CRED · OAuth start/finish: act:credentials.write |
| GET | /api/tesla/vehicles | VEH | none | no | view:VEH · OAuth start/finish: act:credentials.write |
| GET | /api/tiers/by-vehicle | VEH,REV,ID | none | yes | view:VEH+REV+ID |
| GET | /api/tiers/mix | REV | none | yes | view:REV |
| GET | /api/track | LOC | none | no | view:LOC |
| GET | /api/trend/monthly | REV | none | yes | view:REV |
| GET | /api/trip | BK,ID,VEH,LOC,REV | none | no | view:BK+ID+VEH+LOC+REV |
| GET | /api/trips/daily | REV,BK | none | yes | view:REV+BK |
| GET | /api/trips/heatmap | BK | none | yes | view:BK |
| GET | /api/trips/hourly | BK | none | yes | view:BK |
| GET | /api/trips/list | BK,ID,VEH,LOC,REV | none | yes | view:BK+ID+VEH+LOC+REV |
| GET | /api/unauthorized/attributed | COND,ID,VEH,REV | none | yes | view:COND+ID+VEH+REV |
| GET | /api/unauthorized/attributed/plan | SYS | none | yes | view:SYS |
| GET | /api/unauthorized/by-vehicle | COND,VEH,ID | none | yes | view:COND+VEH+ID |
| GET | /api/unauthorized/daily | VEH | none | yes | view:VEH |
| GET | /api/unauthorized/list | COND,ID,VEH,LOC | none | yes | view:COND+ID+VEH+LOC |
| GET | /api/unauthorized/summary | VEH,REV | none | yes | view:VEH+REV |
| GET | /api/vehicle/daily | VEH,REV,COND | none | no | view:VEH+REV+COND |
| GET | /api/vehicle/drivers | ID,EARN,VEH | none | no | view:ID+EARN+VEH |
| GET | /api/vehicle/drivers-detail | ID,EARN,COND | none | no | view:ID+EARN+COND |
| GET | /api/vehicle/earnings | EARN,REV,VEH | none | no | view:EARN+REV+VEH |
| GET | /api/vehicle/kpis | VEH,REV,ID,COND | none | no | view:VEH+REV+ID+COND |
| GET | /api/vehicle/mix | REV,VEH | none | no | view:REV+VEH |
| GET | /api/vehicle/movement | LOC,VEH | none | no | view:LOC+VEH |
| GET | /api/vehicle/profile | VEH,LOC,ID | none | no | view:VEH+LOC+ID |
| GET | /api/vehicle/safety | COND,LOC,ID,VEH | none | no | view:COND+LOC+ID+VEH |
| GET | /api/vehicle/trips | BK,ID,LOC,REV | none | no | view:BK+ID+LOC+REV |
| GET | /api/vehicles | VEH,ID,REV | none | yes | view:VEH+ID+REV |
| GET | /api/vehicles/directory | VEH,REV,ID | none | no | view:VEH+REV+ID |
| GET | /api/vehicles/feeds | VEH,SYS,ID,CT | none | no | view:VEH+SYS+ID+CT |
| GET | /api/vehicles/handover | VEH,ID | none | yes | view:VEH+ID |
| GET | /sw.js | — | none | no | signed-in |
| GET | /teslaredirect | CRED | other | no | view:CRED |
