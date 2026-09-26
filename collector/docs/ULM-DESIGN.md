# FleetMirror — user and access lifecycle management (ULM): the design

**Status: design only. Nothing here is implemented.** Requested 2026-09-26:
"Go through the complete view and design ULM for a multi team company. Just
design, don't implement." Then: "The fleet names should be taken from the
platforms. I should be able to add other companies as well."

The design rests on four read-only inventories (2026-09-26):
- the 143 views and phone screens, each classified by what it shows and what it
  lets you do (Appendix B);
- the 189 API routes, each with its gate today and its requirement under this
  design (Appendix C);
- the caches, the service worker and the logs;
- the fleet model and each platform's organisation identity.

One adversarial review then checked this document against the code. It found
no factual error, but 14 security gaps and 11 contradictions. All of them are
fixed in this revision (§15 lists them).

The house principle governs every screen here, as everywhere else: **a figure
that cannot be shown renders absent with its true reason, never as zero.**
"Not shown to your role" is such a reason, and it must say who can see it and
how to ask.

---

## 1. Where we start (measured, not assumed)

| fact | evidence |
|---|---|
| **There is no sign-in.** All 173 GET routes answer an anonymous request. Five of them blank some fields for a caller without the admin token, and production does not set one. | api/redact.js:1-8; inventory: 176 of 189 routes ungated |
| **The one credential is a shared `ADMIN_TOKEN`, and it is unset on production**, so the write gate is open. | `/api/admin-mode` answered `{"open":true}` on 2026-09-26; api/admin_gate.js:49 |
| **Eight money and identity writes have no gate at all**, not even the admin token. The analyst run, which sends data to a third party, is ungated too. | ledger entry, receipt, policy, import preview and commit; person merge; same-person decide; payouts verify |
| **Money and identity writes are attributed, not authenticated.** | the supervisor must be one of four hard-coded first names (api/ledger_routes.js:97); the HR commit takes a free-text `by`; settings changes record no actor |
| **Identity documents reach anyone.** Document numbers come back from `/api/driver/profile` (by the 2026-09-23 ruling). `/api/hr-roster` returns phone, email and five document fields. Both are ungated. | api/redact.js; api/hr_roster_routes.js:49 |
| **Receipt photos are protected only by an unguessable URL**, and `/api/ledger/entries` hands that URL to anyone. The photo is sent `immutable` for a year, so it stays in the browser cache. | api/ledger_routes.js:642, 1099, 1127 |
| **Nothing in the caches knows who is asking.** The server cache is keyed by URL alone, and a stale entry is refreshed by the server calling itself with only an `x-warm` header. The browser keeps API bodies for 36 h. The phone's service worker stores every `/api` GET, receipt images included. | api/cache.js:167, 208-211; src/warm.js:184; swr.js:28-31; sw.js:126-137 |
| **The fleet chip is a convenience, not a boundary.** `qAll()` drops it. Every driver, vehicle, ledger and HR route answers across both fleets. | inventory cross-cutting 6, 24, 38 |
| **Pages fetch more than they show.** `/api/insights` carries phone, email and position for names the page prints bare. | cross-cutting 23, 37 |
| **Raw provider records carry secrets.** A hotel trip's stored raw record holds a password hash, a document number, a phone number and a push token. Today redact.js strips them. | api/redact.js:9-16 |
| **Personal data reaches the logs.** FMS puts the provider password in the query string, and a retry logs the URL. Route errors log the query, which carries names and plates. | src/http.js:38, 81; api/wrap.js:23 |
| **One database role owns every table and serves every request.** | src/db.js:18 |
| **17 lines in the repository carry real Emirates ID numbers**, checked against the HR export. | §14, first decision |

So ULM is **greenfield**: nothing in today's code is a boundary. Every rule
below is enforced on the server. The UI only follows what the server has
already decided.

---

## 2. The model

```
FleetMirror (the platform operator)
 └─ Company (the tenant: one customer business with its own staff; data never crosses this line)
     ├─ Connections   a provider credential the company pasted
     │    └─ Platform accounts   what that credential can see: an Uber org, a Bolt company,
     │                          a Yango park, an FMS login, a CABMAN interface, a hotel domain
     ├─ Fleets        named FROM the platform accounts linked to them (§3); each records the
     │                legal entity the platforms register it under
     ├─ Teams         Operations, Finance, HR … (templates; the company edits them)
     └─ Users         people who sign in; one person can belong to several companies
          └─ Grants  role × fleet scope × optional expiry, given directly or through a team
```

### 2.1 Company or fleet: the rule that decides

Ecosine Transports LLC and Egari Luxury Cars Transport LLC are **two legal
businesses**. They are modelled as **two fleets of one company** because they
are run as one business:
- one staff runs both;
- drivers work in both, often on the same day: "appearing in BOTH businesses —
  which is the ordinary case" (sql/schema_v49.sql:19);
- one HR export covers both;
- one identity register decides who is one person across both.

Splitting them into two companies would split every person who drives for
both.

So "add another company" has two meanings, and the product offers both:

| you want | add a | what is shared |
|---|---|---|
| another business run by the same people, whose drivers overlap with yours (a third LLC you acquire) | **fleet** in your company. Connect its platform accounts and they name it (§3). | staff, teams, drivers, HR, identity register |
| a separate business with its own staff, whose data must never mix with yours (a customer, a sister business run apart) | **company**. You create it from the company switcher, "Add a company", and become its first Owner. | nothing. A driver working for both is two people, one in each. |

Each fleet carries a **legal entity**, taken from the platform (the name the
platform registers the org under). So finance views can total by legal entity
without that becoming a data boundary.

### 2.2 Who is who

- **Company, not fleet, is the isolation boundary.** Within a company, a grant
  says which fleets it covers: all fleets, or a named set.
- **Users are global; memberships are per company.** An accountant serving two
  companies has one sign-in and a company switcher.
- **The operator is a separate principal.** The person who runs FleetMirror
  holds an *operator* account that sees no company's data (§6.5, §10.5). If
  that person also works in a company, they hold a separate *member* account
  there. The two never combine in one session: moving between them is a fresh
  sign-in, and it is logged.

---

## 3. Fleets come from the platforms

The ruling: **fleet names are taken from the platforms.** Nobody types a fleet
name.

The design has to cope with four facts from the inventory:
- some providers give a name and some do not;
- providers spell the same fleet differently;
- one credential can see several organisations;
- providers' ids come in different shapes.

### 3.1 What each provider can tell us

| provider | stable id | display name, from | today | one credential sees |
|---|---|---|---|---|
| Uber | encrypted org id (REST) plus `supplierOrgUUID` (cookie JWT) | `GET /v1/vehicle-suppliers/orgs` → `name` | called on paste (src/credcheck.js:473) but **not stored**; also sits in `platform_account_day.raw` | a **list**, including parent and child orgs |
| Bolt (fleet-integration) | `company_id` | none; `getCompanies` answers 404 | ids are code literals (src/config.js:175-178) | a **set** of company ids, found only by trying each |
| Bolt (fleet-owner portal) | `company_id` (+ owner user id) | `getCompanyDetails` / `getProfile` | **never called** | the companies the owner holds |
| Yango | park id | console `parks/users/profile` | unreachable (403 since 2026-09-06) | one park |
| FMS / InfoTrack | login `userid` | `GetVehicleList` → `ClientName` | **never called** | one fleet |
| CABMAN | InterfaceUniqueId | `GetIVDData` → `CompanyName` | in `telemetry_snapshot.raw` every 5 min, not read | one interface |
| Hotel channel | `x-domain` | none | hard-wired to Ecosine (src/config.js:163) | one domain |

### 3.2 The rules

1. **Connecting a credential discovers accounts; it does not create fleets.**
   - On connect, and nightly, the collector calls each provider's identity
     call (the table above). The calls marked "never called" become part of
     connecting.
   - It records a `platform_account` with the provider, stable id, **reported
     name**, when it was reported, and which call reported it.
2. **A person links an account to a fleet, using evidence.**
   - Names are never matched for equality, because providers spell one fleet
     differently. Examples: "ECOSINE TRANSPORTS" in Uber (COVERAGE.md) and
     "ECOSINE TRANSPORTS LLC" in Yango (src/sources/yango.js:7); "Egari Luxury
     Cars Transport LLC" in Uber (src/credcheck.js:450) and "Egari Luxury" in
     our own `fleet` table (sql/schema.sql:11).
   - The linking screen (§10.4) proposes a link from evidence: how similar the
     normalised names are, **shared plates** (the same cars appear in both
     accounts' vehicle lists), and shared drivers. This is the method the
     identity register already uses.
   - An admin confirms the link or makes a new fleet.
3. **A fleet's name is the name one of its accounts reports.**
   - The admin chooses which account names it. By default this is the first
     linked account that reports a name.
   - The other names show as aliases, each with its provider.
   - There is no free-text name field.
   - If two fleets report the same name, each shows its provider and the last
     four characters of its id ("Ecosine Transports · Uber …a1f2"). The admin
     can choose a different naming account for either.
4. **When no linked account reports a name**, the fleet is shown as
   *"Unnamed fleet — Bolt company …1234"*.
   - This happens with Bolt fleet-integration alone, the hotel channel alone,
     or FMS before `GetVehicleList` is wired.
   - The reason stays visible beside the name: "Bolt's fleet-integration API
     returns no company name; connect the fleet-owner portal to name it." That
     is the house rule, applied to a name.
5. **When a platform renames an organisation**, the new reported name is
   recorded and the fleet's name follows its naming account. The change goes
   in the audit log and shows once as "renamed by Uber on 26 Sep".
6. **One account belongs to one company.**
   - `(provider, stable id)` is unique across FleetMirror.
   - A company's first claim of an account is **provisional for 72 hours**.
     During that time every Owner is notified, and any Owner can cancel it.
   - A second company that tries the same account gets a neutral refusal:
     "This account can't be connected here. FleetMirror support can help." The
     message never says whether the account is already taken.
   - Disputes go to FleetMirror support, which decides using evidence from the
     platform's own administrator contact.
   - **When an account moves between companies**, only future collection moves.
     Rows already collected stay with the company that collected them under its
     own credential, unless both Owners agree in writing.
7. **Accounts a credential can see but the company does not want** (an Uber
   parent org, a Bolt company that is not theirs) are marked *ignored*.
   - They are never collected silently.
   - Their reported names are shown only on the linking screen, and only to
     that company's Owner and Connections admin.
   - An ignored account's name is deleted after 30 days.
8. **Linking or unlinking changes who can see rows.** A fleet-scoped user gains
   or loses an account's history. So:
   - it is an access change, audited, and needs an Owner;
   - the screen shows who gains or loses visibility before it is confirmed.

### 3.3 From today's two hard-coded fleets

- **Fleet ids.** The slugs `ecosine` and `egari` stay as the fleets' stable
  internal ids, so every row that already carries them stays valid. Their
  names come from the accounts linked to them.
- **Settings.** The `_EGARI`-suffixed settings keys (for example
  `UBER_ORG_ENCRYPTED_EGARI`) become connection settings, one set per
  connection. A third fleet needs no new key name.
- **The hotel channel** (src/config.js:163) becomes an account that the admin
  links to a fleet on the linking screen, not by configuration.
- **Removed:** every hard-coded fleet id and label. The inventory lists about 40
  sites, including:
  - `SOURCE_LABEL`, the two pickers, and "Ecosine & Egari" in two mastheads;
  - the `=== 'egari' ? 'Egari' : 'Ecosine'` two-way labels, which would
    mislabel a third fleet;
  - the config.js fleet arrays;
  - the payout, probe and coverage whitelists.
- **The unread `fleet.name` column** (sql/schema.sql:10-11) becomes the fleet's
  display name, now fed from the platforms.

---

## 4. Tenancy: isolating companies

### 4.1 One database, a `company_id` on every row, and row-level security enforced

| option | isolation | cost in this codebase | verdict |
|---|---|---|---|
| **Shared DB + `company_id` + RLS** | Postgres enforces it on every statement, including the 562 read statements that carry no tenant predicate today | add `company_id` to 71 tables; rework the colliding keys (§4.2); one policy per table | **recommended.** One pool and one migration run, and the database refuses a missed predicate instead of trusting 562 hand-edits. |
| Schema per company | strong | all 84 migrations and the v53 rebuild replay per schema; `search_path` per request on a pool of 8 | workable, but migrations grow with every company |
| Database per company | strongest | one pool per company per process: 8 connections × 2 processes × N companies, on basic-xxs | keep for a customer who contractually needs physical isolation |

**RLS only protects if the requesting role cannot bypass it.** Today one role
(src/db.js:18) runs the migrations, so it owns every table, and Postgres
exempts table owners from row-level security. The design therefore uses two
roles:

| role | used by | properties |
|---|---|---|
| owner role | migrations only | owns the tables |
| request role | the API, collector, rollups and warmers | owns nothing; no `BYPASSRLS` |

- **Every table** gets `ENABLE` and **`FORCE ROW LEVEL SECURITY`**.
- **Every policy** reads `current_setting('app.company_id', true)`, so it
  **fails closed**: an unset company returns no rows, never all of them.
- **Each request** sets the company with `SET LOCAL` inside its transaction.
- **The collector, rollups and warmers** do the same per company run.

RLS is the backstop, not the only line. Routes still bind `company_id`
explicitly, and two tests fail if any table holding company data lacks a
policy, or lacks `FORCE`.

### 4.2 What changes, from the blast-radius measurement

- **The 27 tables with no fleet or company column get `company_id`.** They
  include `app_setting`, `credential_state`, `driver_identity_link`,
  `driver_lifetime`, `driver_ledger*`, `ledger_policy`, `hr_roster_upload`,
  `partner`, `place_cell` and `rollup_person_month`.
- **The shared reference tables stay global:** `weather_daily`,
  `calendar_day` and `world_event`. Edits to `world_event` become per-company
  overlays, because `POST /api/events` writes it today.
- **Keys that would collide across companies gain `company_id`.**
  - Today they are keyed by plate alone or by driver id alone: vehicle,
    telemetry_snapshot, occupancy_segment, vehicle_driver_day, driver_day,
    driver_lifetime, driver_platform_state, and every `(platform, external_id)`.
  - There is a precedent: money_event's key lacked the fleet, and a real
    collision killed an insert (sql/schema_v49.sql:15-30).
- **The identity register goes per company.** `api/identity_map.js` and the
  `person_key` it compiles (schema_v53.sql) become per company. The name
  fallback must never fold two companies' drivers into one person.
- **Rollups go per company.** The `'*'` "all fleets" rows become "all fleets of
  this company".
- **The collector** runs one schedule that iterates over companies. Each run is
  pinned to one company's settings (an extension of `withPinnedSettings`,
  src/settings.js:399), so one company's failures never mark another's
  credentials.
- **Secrets.** Each company gets its own data key (envelope encryption), and no
  company's secrets can be decrypted with the database URL. Today the key falls
  back to `DATABASE_URL`, then to a literal (src/settings.js:11-13).
- **Locale per company.**
  - "Asia/Dubai" appears about 300 times, and `DEFAULT 'AED'` 11 times.
  - Instead, a company has a timezone and a currency, and "Dubai time" in the
    masthead reads the company's zone.

---

## 5. Signing in

### 5.1 People

- **Sign-in methods.**
  - **Passkey** (WebAuthn) is the primary way in.
  - An **emailed one-time link** is the fallback.
  - Optionally, a company's Owner sets up **SSO** (Google Workspace or
    Microsoft Entra) for that company.
- **SSO is bound to proven domains and to its own company.**
  - The company proves it owns an email domain by DNS record before its SSO is
    offered to anyone at that domain.
  - An SSO sign-in admits the user **only into the company that configured
    it**. That user's memberships elsewhere still need their own passkey or
    link.
  - So a company cannot claim someone else's domain and sign in as their
    users.
- **Multi-factor** is required for any role that can write, reveal documents or
  change access. A passkey counts as MFA.
- **Session.** An HttpOnly, Secure, SameSite=Lax cookie on the one origin. On
  desktop it ends after 12 h idle or 7 days absolute.
- **Phone PWA.** A 30-day session bound to the device.
- **Step-up re-authentication** is required for:
  - revealing a document number;
  - committing cash above the company's threshold;
  - changing access;
  - applying credentials.
- **Company switcher.** Shown when a user holds more than one company. The
  chosen company lives in the session, **not in the URL**.
  - Every page load records which company it was rendered for, and sends it on
    every request as `x-fm-company`.
  - The server answers **409** when that differs from the session. The stale
    tab then reloads instead of writing into the company another tab switched
    to.

### 5.2 Machines

- **Wall display.** A named service principal with the Wall display role. It
  holds a revocable token bound to one company and one device.
- **Integrations and exports.** Named tokens, each owned by a user, with a scope
  no wider than that user's and an expiry of at most 90 days. They are listed
  and revocable on the Access page.
- **The collector** acts as `system:collector` in the audit, per company, under
  the request role (§4.1).

### 5.3 What is retired

- **`ADMIN_TOKEN`**, the `x-admin-token` header, and the token kept in
  localStorage (`adminToken`). Today the phone silently reuses the token the
  desktop saved in the same browser.
- **The four hard-coded supervisor codes.** "Recorded by" becomes the signed-in
  user. History keeps its codes (§12.3).
- **Free-text `by`, `set_by` and `entered_by` fields** on every write.

---

## 6. Authorisation

### 6.1 Data classes: what a response is made of

Every route, and every field that matters, is labelled with the class of data
it carries. The inventory found fifteen classes. The design adds four.

| code | class | examples |
|---|---|---|
| ID | driver identity | names, photos, platform ids |
| CT | driver contact | phone, email, tel:/mailto: links |
| DOC | driver documents | Emirates ID, licence and passport numbers, document expiries |
| EARN | driver earnings | money per named driver |
| CASH | driver cash | deposits, advances, salary, ledger balances, the lending line, receipt photos |
| COND | driver conduct | safety events, ratings, quality, cancellations by driver |
| **ACCUSE** (new) | attribution of wrongdoing to a named person | unauthorized-trip attribution by name, "who drives hardest", low-performer lists |
| REV | company revenue | fleet-level trip value, money in |
| PAY | company payouts | platform-to-company payouts, bank transfers, reconciliation |
| BK | bookings | trip rows |
| LOC | location | live positions, traces, pickup and drop-off places, territory |
| VEH | vehicle operations | vehicles, utilisation, vehicle compliance |
| HR | HR roster | the HR export's rows |
| MRG | identity decisions | same-person, merges |
| CRED | credentials and collector control | provider secrets, runs, probes |
| SYS | system health | sources, coverage, freshness |
| **PAX** (new) | passengers | hotel guest ids, room numbers, trip purposes (`/api/corporate/guests` returns `guest_id` and `room_no`: api/analytics_routes.js:805-815) |
| **AUDIT** (new) | the audit log | who saw and did what |
| **RAW** (new) | raw provider records and query diagnostics | `trip.raw`, `/api/schema/raw-*`, the `EXPLAIN ANALYZE` plan route |

- **ACCUSE is split from COND on purpose.**
  - A count of harsh events is conduct. A page that names a person as the
    likely culprit of an unbooked trip is an accusation.
  - It needs its own grant, and it always carries its evidence and its
    confidence.
- **RAW is Owner-only.** A per-field shaper cannot see inside a provider's
  free-form record. api/redact.js stays underneath every response as a second
  line.

### 6.2 Grant levels

A role holds each class at one of five levels.

| level | code | what the holder sees |
|---|---|---|
| full | F | everything |
| masked | M | present but masked: `•••• 4821` for an ID, `05• ••• •12` for a phone. The full value needs a **reveal**: step-up, a reason, and an audit entry. A revealed value is sent `no-store` and never cached. |
| pseudonymised | P | people, and plates for pseudonymised VEH, appear as stable pseudonyms. See below. |
| aggregate | A | counts and totals only; no row names a person or a car. An aggregate grant **cannot open a page about one record**. |
| none | — | absent, with the reason |

Pseudonyms work as follows:
- Each is a keyed HMAC per company, for example `D-7QK2`. It is never derived
  from a real id's digits.
- It is consistent across pages, so analysis still works.
- The key is rotated when an analyst's grant ends.
- Pseudonymisation guards against casual exposure and third-party exposure. It
  is not a guarantee against a determined insider who also holds other access.

### 6.3 Roles

These are the defaults FleetMirror ships. A company can copy one to make its
own role, but only up to the ceiling of the person copying it (§6.4).

| role | ID | CT | DOC | EARN | CASH | COND | ACCUSE | REV | PAY | BK | LOC | VEH | HR | MRG | CRED | SYS | PAX | AUDIT | RAW |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Owner | F | F | F | F | F | F | F | F | F | F | F | F | F | F | F | F | F | F | F |
| Management | F | F | M | F | F | F | F | F | F | F | F | F | M | F | — | F | F | — | — |
| Finance manager | F | F | — | F | F | — | — | F | F | F | — | F | — | — | — | F | F | — | — |
| Cash desk | F | — | — | — | F | — | — | — | — | — | — | — | — | — | — | F | — | — | — |
| Operations manager | F | F | — | F | — | F | F | F | — | F | F | F | — | — | — | F | A | — | — |
| Dispatcher | F | F | — | — | — | A | — | — | — | F | F | F | — | — | — | F | A | — | — |
| HR officer | F | F | F | — | — | F | F | — | — | — | — | F | F | F | — | F | — | — | — |
| Safety & compliance | F | F | M | — | — | F | F | — | — | F | F | F | — | — | — | F | — | — | — |
| Fleet technician | F | — | — | — | — | — | — | — | — | A | F | F | — | — | — | F | — | — | — |
| Analyst | P | — | — | P | — | P | — | F | F | P | A | P | — | — | — | F | A | — | — |
| Auditor (time-boxed) | F | M | M | F | F | F | F | F | F | F | F | F | M | F | — | F | M | F | — |
| Access admin | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | F | — | F | — |
| Connections admin | — | — | — | — | — | — | — | — | — | — | — | — | — | — | F | F | — | — | — |
| Wall display (service) | — | — | — | — | — | — | — | F | — | A | A | A | — | — | — | F | — | — | — |

Actions are separate capabilities, not implied by read access (§8).

- **Separation of duties.** The Access admin manages who has access and reads
  the audit log, shaped to their own levels (§12), but sees no business data.
  The Connections admin manages credentials but sees no driver.
- **Owner** holds everything. A company must have at least one Owner, and
  should have two.

### 6.4 Teams, grants, and the ceiling on granting

- **Teams.** A team is a named group with default grants, each a role plus a
  fleet scope, and members inherit them.
  - FleetMirror ships templates: Management, Finance, Operations, HR, Safety &
    compliance, Fleet maintenance and IT.
  - A company renames, adds and removes teams freely.
- **Direct grants.** A user can also hold grants directly, for example a cover
  role while a colleague is on leave.
- **Every grant records:**
  - its role and fleet scope;
  - an optional **expiry**;
  - who granted it, when, and why.
- **Evaluation.** A user's access is the **union** of their grants, **deny by
  default**. Fleet scope is intersected with the fleet of each row.
- **The ceiling.** Nobody confers more than they hold.
  - A grantor can give, or approve, only class levels at or below their own,
    within their own fleet scope.
  - The same limit applies to inviting someone, copying or editing a role, and
    creating an integration token.
- **Sensitive grants need a second Owner.** Two Owners must agree before
  anyone is given:
  - Owner;
  - any Access or Connections capability;
  - DOC at F, CASH, CRED, ACCUSE, AUDIT or RAW.

  In a company with a single Owner, such a grant waits 24 hours, with a notice
  to every holder of Access admin, before it takes effect.
- **No one approves their own request**, or a grant for an account they also
  hold.

### 6.5 Support access from FleetMirror

The operator has no standing access to a company's data.

- **How support gets in.** The company's Owner grants a **time-boxed support
  grant** of at most 72 hours, with a role and a reason.
- **What support can never hold.** Owner, `act:access.*`, `act:credentials.*`
  or RAW. So support cannot create access that outlives its own.
- **Visibility.** While the grant lasts, a banner on every page says:
  "FleetMirror support can see this company until 28 Sep 14:00."
- **Audit.** Everything the support user does is audited under their own name.

---

## 7. How pages behave

1. **A view opens when you hold its subject class.** The subject is the class
   the page is *about*:
   - usually the first class in its Appendix B row: a driver page's is ID, and
     #payouts' is PAY;
   - **a page whose rows are cash records opens on CASH**, even though it lists
     names: #advances, #deposits, #salary, #opening, #charging, #import-sheet,
     #policy, #settlement/cash, a driver's Money tab. The list of who took an
     advance is itself cash data;
   - guest pages open on PAX;
   - a driver's Earnings tab opens on EARN;
   - the shell opens on SYS.

   Appendix B names the subject of every view, and Appendix C the subject of
   every route. The two use the same rule.
2. **Everything else on the page follows your level for that class.** A class
   you do not hold renders **absent, with the reason**:

   > **Phone** — not shown to your role. Operations and HR can see contact
   > details. *Request access*

   This applies at every level: a tile, a column, a card or a section. **A
   withheld figure is never a zero or a dash.**
3. **The server leaves withheld fields out.** It does not hide them in the
   browser; it omits them. The response lists what it withheld and why
   (`withheld: {phone: "role"}`), so the page can say so without guessing.
4. **Accusatory pages without ACCUSE.** The counts remain, and the named
   attribution is withheld with its reason.
5. **Navigation.** The rail, the section row and the phone tab bar list only
   views you can open.
6. **A link to a view you cannot open** is plain text, not a link.
7. **A direct address to a closed view** shows a page that says so. It names the
   teams that can see it and offers *Request access* (§11.2). It is never a
   blank page and never a 404.
8. **Fleet scope.**
   - **Scope of one fleet:** the fleet chip is locked to that fleet, and every
     total is that fleet's.
   - **Scope of several fleets:** the chip offers only those fleets, and "All
     fleets" means *your* fleets. The masthead says so: "Ecosine · your
     fleets".
   - **Person pages:** a person can hold accounts in several fleets. The page
     shows only the accounts in your scope. The rest appear as "1 more account
     in a fleet outside your scope". Figures that combine fleets are
     recomputed over your scope, never shown whole.
9. **The shell** (the part of every page around the content) opens for
   everyone.
   - **The credential banner** names providers and errors, which is CRED
     detail. Only CRED holders see that detail. Everyone else sees one line:
     "Some data sources need attention — the Connections admin has been told."
   - **The today strip** shows company money (REV) only to REV holders. Anyone
     else sees the same strip with bookings and cars only.
   - **Freshness** (SYS) is shown to everyone.
10. **Phone.** The same rules apply, plus:
    - The fallback that renders the desktop driver and vehicle tabs inside the
      app obeys the same response shaping, because it uses the same endpoints.
    - "Open it on the desktop version" keeps the session.
    - Screens reachable only by address (Deposits, Online time) are listed on
      More for the roles that hold them.
11. **Addresses carry no personal identifiers.**
    - Driver and person pages use opaque ids (`#driver/p_7Qk2`), never names.
      `#segments/driver/<name>` goes away.
    - Plates stay, because a plate is an operational identifier the fleet uses
      openly. But an address with a plate and a day is still recorded as a
      location read.

Appendix B applies these rules to all 143 views and shows the result per role.

---

## 8. Actions

Every write is a named capability, held only through a role. The actor is
always the signed-in user.

| capability | what | routes today (gate) | held by | extra control |
|---|---|---|---|---|
| act:cash.record | record cash handed in, an advance, a charge, a salary line, an opening balance; attach a receipt | POST /api/ledger/entry, /api/ledger/receipt (**none**) | Cash desk, Finance manager, Owner | step-up above the company's threshold |
| act:cash.import | preview an imported cash sheet and assign each row to an **existing** person | POST /api/ledger/import/preview (**none**) | Cash desk, Finance manager | it never merges people; a suspected same person goes to the identity queue for HR |
| act:cash.import.commit | commit a stored preview | POST /api/ledger/import/commit (**none**) | Finance manager, Owner | **four-eyes**, see below |
| act:cash.policy | move the lending line | POST /api/ledger/policy (**none**) | Finance manager, Owner | a reason is required; the screen shows who it moves first |
| act:finance.import | import statement days | POST /api/import/statement-days (admin) | Finance manager | — |
| act:finance.verify | ask Uber to confirm payouts (spends provider quota) | POST /api/finance/payouts/verify (**none**) | Finance manager | rate-limited per company |
| act:hr.import | preview and commit the HR export | POST /api/hr-roster/preview, /commit (admin) | HR officer, Owner | step-up on commit |
| act:identity.decide | same-person verdicts | POST /api/same-person/decide (**none**) | HR officer, Management, Owner | — |
| act:identity.merge | merge two people's records | POST /api/person/merge (**none**) | HR officer, Owner | **four-eyes**. If the merge moves a cash balance, the approver must hold CASH, so someone who can see the money approves it. |
| act:credentials.test / .write | test and apply provider credentials; start the Tesla connection | PUT /api/settings, POST /api/settings/paste (admin); GET /api/tesla/connect (**none**, becomes POST) | Connections admin, Owner | step-up on apply; values are never shown back |
| act:collector.run | run the incremental collection now | POST /api/settings/trigger (admin) | Connections admin, Operations manager | — |
| act:collector.backfill | run the 12-month backfill (spends provider quota) | POST /api/settings/trigger (admin) | Connections admin, Owner | one at a time per company |
| act:collector.probe | call a provider to test what it returns (spends quota; may rotate a token) | the 16 `/api/probe/*` routes and `/api/tesla/status`, `/vehicles` (**none**; all become POST) | Connections admin, Owner | responses shaped like any other (a probe shows no driver to a Connections admin); two probes that only read our own database become Owner diagnostics (RAW) |
| act:analyst.run | run the analyst, which sends a brief to a third-party model | POST /api/analyst/run (**none**), /api/settings/trigger | Management, Analyst, Owner | the brief is **pseudonymised**, drivers and plates alike, before it leaves; today it carries up to 12 candidate driver names and 12 plates (src/analyst.js:119-124, 503) |
| act:calendar.edit | add a local event | POST /api/events (admin) | Management, Operations manager | per company |
| act:finding.own | take, assign and close a finding on #insights | new | Operations manager, Safety, Management | records who acted; the page says today that this is "not recorded" |
| act:access.* | invite, grant, revoke, review | new | Access admin, Owner | step-up; the ceiling and second-Owner rules (§6.4) |
| act:export.<class> | CSV export (`/api/export/trips.csv`, up to 400,000 rows) | GET (redacted for non-admin) | whoever holds every class exported | watermarked with user and time; audited |

**Four-eyes means one stored, unchangeable proposal and two different people.**
1. The preparer's preview is **stored on the server** with an id, a hash of its
   content, and the preparer.
2. The approver sees that stored preview from their own session and commits it
   **by id only**.
3. The server refuses the commit if:
   - the approver is the preparer;
   - the content hash has changed;
   - the request carries any rows of its own.

Today the commit accepts rows from the request body (api/import_routes.js:224),
so an approver could commit something other than what was previewed.

Rules that apply to every action:
- **A dry run needs the same capability as the commit**, because it shows the
  same people and money. This includes a dry run that writes anyway: the
  phone's "Check it" stores the receipt photo.
- **No GET has side effects, and none spends quota.** Every state-changing or
  quota-spending request is a POST with a CSRF token.

---

## 9. Enforcement, on the server

### 9.1 A route manifest, deny by default

Each of the 189 routes declares, beside its handler:
- its **subject class**;
- the classes of the fields it returns;
- the capability it needs;
- whether it takes a fleet parameter and a subject (a person or a plate).

A request passes through these stages:

```
cookie → session → user → x-fm-company matches the session (else 409) → grants
  (cached per session, invalidated on any grant change) → subject class or capability
  check (403 with a reason) → SET LOCAL app.company_id → handler
  → response shaper (drop or mask each field by class and level; add `withheld`)
  → cache → client
```

- **An undeclared route answers 403.** A test fails if any route lacks a
  declaration, like the house's existing completeness tests.
- **RLS policies are checked the same way.** A test fails if any table holding
  company data has no policy or lacks `FORCE` (§4.1).
- **Subjects are checked.** A request about a person or a plate outside the
  caller's fleet scope answers 404 as "no such driver in your fleets". It never
  answers with the other fleet's data.
- **Public routes are few, and each is listed.** There are four: the shell
  HTML, `sw.js`, the Tesla public key (Tesla fetches it anonymously), and the
  Tesla OAuth return. The last checks its single-use state and then acts as the
  signed-in user who started the connection.

### 9.2 Caches: the leak that has to close first

**Server response cache** (api/cache.js):
- **The key.** URL + company + a **visibility fingerprint**. The fingerprint is
  a hash of the caller's class levels and fleet scope, so two users with the
  same access share entries and nobody gets another's answer.
- **Stale entries** are refreshed **in-process, as the fingerprint that asked**.
  Today the server calls itself over loopback with only `x-warm`
  (api/cache.js:208-211); under sign-in that call would either fail or become a
  bypass. `x-warm` is retired.
- **warm.js** pre-warms only fingerprints used in the last day, in-process, per
  company.
- **Writes invalidate** the entries they affect. Ledger and merge writes do not
  today (finding 20).
- **Revealed values and `no-store` responses** never enter the cache.

**Browser storage and the service worker:**
- **The server decides what may be stored, by class.**
  - Every response carrying CT, DOC, CASH, HR, MRG, PAX, AUDIT or RAW is sent
    `Cache-Control: no-store`.
  - The browser SWR cache and the service worker honour that header.
  - So the rule follows the data and cannot drift from a hand-kept path list.
    The design's first draft had such a list, and it already missed
    `/api/insights`, `/api/online-time`, `/api/driver/earnings`,
    `/api/settlement/*` and the merge routes.
- **The service worker partitions by scope.** Every API response carries a
  non-secret `x-fm-scope`: a hash of user, company and fingerprint.
  - The SW keeps a separate data cache per scope value.
  - It drops every other partition when the value changes: on sign-out, a
    company switch, a grant change, or a `401`.
  - It needs this header because it cannot read the HttpOnly session.
- **SW limits.** A size cap and a TTL. Its scope is `/` today, so it also
  intercepts desktop pages; it keeps to the phone's paths.
- **Receipts and photos** are sent `no-store`. Today receipts are sent
  `immutable` for a year (api/ledger_routes.js:1127).
- **Sign-out and company switch** send `Clear-Site-Data: "cache", "storage"`,
  which also empties the browser's HTTP cache.

### 9.3 Files, exports, logs, headers, third parties

- **Receipt photos and driver photos** are served only through a class check
  (CASH and ID respectively), never to whoever knows the URL. List responses
  carry an opaque reference, not the content hash.
- **Exports** are gated by `act:export.<class>`, stamped with user and time,
  and audited.
- **Logs:**
  - No personal data in error logs, and no query strings (api/wrap.js:23).
  - Outbound URLs are logged without their query, which carries FMS's password
    (src/http.js:38, 81).
  - An **access log** records user, route, company and status, so "who read
    what" has an answer.
- **Headers.** CSP, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy:
  same-origin`, and no `x-powered-by`. There is still no CORS: one origin serves
  the app and the API.
- **CSRF.** A SameSite=Lax cookie plus a CSRF token on every state-changing or
  quota-spending request (§8).
- **Rate limits.** Per user on reveal, export, the quota-spending actions and
  sign-in.
- **Third parties:**
  - The analyst brief is pseudonymised (§8).
  - Map tiles from OpenStreetMap disclose the viewport being looked at. The
    Owner may choose a self-hosted tile source.
  - Vehicle photos hot-linked from a platform are proxied.
- **Diagnostics are Owner-only (RAW).** `/api/unauthorized/attributed/plan`
  runs `EXPLAIN ANALYZE`, and `/api/schema/raw-*` returns raw provider values.

---

## 10. Screens

### 10.1 Sign-in

- **The FleetMirror mark and name**, and one field: email.
- **Two ways in:** "Continue with passkey" and "Email me a sign-in link".
- **SSO:** a company that set it up and verified its domain shows "Continue
  with Google / Microsoft" after someone types an address at that domain.

### 10.2 The masthead, for a signed-in user

- **The company name**, with the switcher when the user holds more than one
  company.
- **The switcher** ends with "Add a company" (§2.1).
- **The account menu:** name, teams, fleet scope, "Sign out everywhere", and
  "Your access", a read-only list of the user's grants and their expiries.

### 10.3 Set up → Access (Access admin and Owner)

- **People.** Everyone with access: teams, roles, fleet scope, last sign-in,
  MFA state, expiry.
  - Filters: team, role, dormant, expiring.
  - Row actions: change grants, suspend, offboard, resend invite.
  - Every change offered stops at the grantor's ceiling (§6.4). A change that
    needs a second Owner shows as "waiting for a second Owner".
- **Teams.** Each team with its default grants, members and lead. The lead
  approves requests within the lead's own ceiling and attests reviews.
- **Roles.** The catalogue in §6.3, read-only for built-ins. "Duplicate to
  customise" makes a company role, capped at your ceiling. Each role shows the
  views it opens (from Appendix B) and the actions it holds.
- **Requests.** Pending access requests, with the requester's reason and the
  view that triggered them. Approve for a period, or decline with a reason.
- **Reviews.** The quarterly attestation per team (§11.3): open, due and
  overdue.
- **Audit** (§12).

### 10.4 Set up → Connections and fleets

This screen is for the Connections admin and the Owner.

- **Connections.** Each credential with its health: today's credential banner,
  now per company.
- **Platform accounts.** What each credential can see: reported name, stable
  id, and the linked fleet or *ignored*.
  - A new account arrives as "**New: Uber org 'Egari Luxury Cars Transport
    LLC' — link to a fleet**".
  - The evidence panel shows name similarity and **counts**: "41 of 43 plates
    and 118 drivers in common with Egari". A Connections admin sees no driver.
    An Owner can open the lists behind the counts.
  - Linking, unlinking and relinking show who gains or loses visibility, and
    need an Owner (§3.2 rule 8).
- **Fleets.** Each fleet with its accounts, its legal entity, the account that
  names it, its aliases, and its "renamed on …" history.

### 10.5 FleetMirror operator console (operator only)

- **Companies.** Every company with its status, fleet and user counts, last
  collection and plan.
- **Actions:** create a company for a new customer, suspend, reinstate,
  offboard, and resolve an account dispute (§3.2 rule 6).
- **Support.** Your active support grants and their expiries.
- **No company data** appears here, except what support grants allow.

### 10.6 Phone

- **Sign-in** is the same, with a passkey on the phone.
- **More → Account** shows your name, company and fleet scope, and a sign-out.
- **Blocked screens** give the same reasons as the desktop.
- **Step-up prompts** use the phone's own passkey.

---

## 11. Lifecycle

### 11.1 A company

```
created   by an existing user ("Add a company"; they become its first Owner)
          or by the operator for a new customer (legal name, timezone, currency, first Owner's email)
 → onboarding  the Owner connects the first platform credential; accounts discovered (provisional
               for 72 h, §3.2); fleets linked and named from the platforms
 → active      teams from templates; users invited
 → suspended   read-only; collectors stop; users see why
 → offboarding export of the company's data for its Owners; 30-day grace
 → deleted     data removed; the audit summary kept for the retention period
```

**Ownership transfer**:
- Two Owners agree, or FleetMirror support acts on the company's written
  request.
- Either way, it takes effect only after a **7-day cooling-off**, with notice
  to every Owner and Access admin, any of whom can stop it.
- No single operator staff member can complete it alone.

### 11.2 A user

```
invited ──accept (verify email, register a passkey)──▶ active
  │ expires after 7 days unaccepted                     │
  ▼                                                     ├── grant changed (audited; ceiling and second-Owner rules;
revoked                                                 │   takes effect on the next request; caches purge, §9.2)
                                                        ├── request access ──▶ approved (for a period) / declined
                                                        ├── dormant: no sign-in for 60 days ──▶ suspended automatically
                                                        ├── suspended (by an admin) ──▶ reinstated
                                                        └── offboarded: all sessions and tokens revoked at once,
                                                            grants removed, identity kept for attribution
                                                            (their name stays on everything they recorded)
```

- **Invites** carry team, role, fleet scope and an optional end date, all
  within the inviter's ceiling. An Access admin issues them, or a team lead
  within the lead's team and scope.
- **Access requests** start from the "not shown to your role" pages. They carry
  the view, the class and a reason, and go to the team lead or an Access admin.
  An approval can be time-boxed ("until 30 Sep"), and no one approves their own.
- **Cover for leave** is a direct grant with an end date. It expires by itself,
  and a banner on the covering user's pages says until when.
- **Rehire** reactivates the same identity with fresh grants, so history stays
  joined up.
- **The last Owner cannot be removed.**

### 11.3 Reviews

- Every quarter, each team lead attests their team's access, keeping or
  removing it person by person.
- Access nobody attested expires 14 days after the review closes.
- The Owner sees review status on the Access page.
- Holders of sensitive classes are reviewed monthly: DOC at F, CASH, CRED,
  ACCUSE, AUDIT and RAW.

### 11.4 Drivers as users (not in the first release)

The model has room for a *driver* principal:
- A driver would see only their own earnings, cash position, documents and
  trips, through the same response shaper at scope "self".
- It is left out of the first release on purpose. It needs consent wording,
  and a support path this company does not have yet.

---

## 12. Audit

### 12.1 What is recorded

The audit log is append-only and hash-chained per company. It records:
- **Every write:** actor, capability, subject, reason, IP, device and time.
  - Before and after values are kept in full only for classes that are safe to
    keep there.
  - **DOC, CT, CRED, CASH amounts and RAW values are stored as keyed hashes**,
    so the log can prove what changed without becoming a second copy of the
    secrets.
- **Every access change and every sign-in.**
- **Sensitive reads:** document reveals, exports, receipt views, and opening a
  person's documents.
- **Support-grant sessions.**

### 12.2 Where it shows

- **Set up → Access → Audit**, for the Owner, Access admin and Auditor. It is
  shaped by the viewer's own levels like any other response, so an Access
  admin sees who did what without seeing the business values.
- **"Who looked at this driver's documents"**, on the driver's page, for
  holders of DOC at F. It is part of the documents themselves, so it needs no
  AUDIT grant.
- **Each cash entry's history**, which already exists as `driver_ledger_audit`,
  now with real actors.

### 12.3 Retention and history

- **Retention:** two years, or the company's legal requirement if longer.
- **History before ULM** keeps its attributions as they were: the four
  supervisor codes, the free-text `by` values and the IP addresses.
  - They are labelled "attributed, not authenticated — recorded before sign-in
    existed".
  - They are mapped to users only where the company confirms who they were.

---

## 13. Rollout, in phases

Each phase can ship on its own.

| phase | delivers | done when |
|---|---|---|
| **0 — close the open doors (days)** | **one interim sign-in in front of the whole app, reads included** (the admin token, or a shared password at the edge; see §14.2); the 8 ungated writes, the analyst run and the probes behind it; PII out of logs; `no-store` on CT, DOC, CASH, HR responses and receipts; no receipt hashes in list responses; security headers | an anonymous request to `/api/hr-roster`, `/api/live` or a receipt is refused on production, and so is an anonymous write |
| **1 — sign-in for this company** | users, passkeys, sessions; the route manifest in *observe* mode (it logs what it would deny); the audit log; "recorded by" becomes the user; `x-warm` retired | every request carries a user; the manifest covers 189 of 189 routes |
| **2 — roles, teams, fleet scope** | the response shaper; absent-with-reason for withheld fields; per-fingerprint caches; SW partitions; nav and links follow access; access requests; stored-preview four-eyes | the manifest *enforces*; Appendix B holds on production, role by role (screenshots per role) |
| **3 — fleets from the platforms** | `platform_account`; the identity calls wired in, including those never called today; the linking screen; about 40 hard-coded fleet sites removed; settings per connection | a third fleet can be connected and named with no code change |
| **4 — more companies** | `company_id`, `FORCE` RLS and the two database roles; per-company settings, keys, collector runs, identity register, rollups and locale; "Add a company"; the operator console; support grants | a second company onboards on production, and a cross-company read test fails closed |
| **5 — operate it** | quarterly reviews, dormant suspension, reveal with a reason, export watermarks, finding ownership | the first review cycle completes |

Two ordering rules:
- **Phase 0 must come before anything else.**
- **Phase 4 must not start until phases 1–2 are proven.** Onboarding a second
  company onto today's anonymous API would expose it to everyone who has the
  address.

---

## 14. Decisions for you

1. **Emirates ID numbers in the repository.**
   - What was found: 17 lines carry real drivers' Emirates ID numbers, matched
     against the HR export on 2026-09-26. They are in code, tests, one
     migration comment and two docs.
   - Where else: the git history already pushed to GitHub, and six local agent
     worktrees that are not pushed.
   - What to decide: replace them with synthetic numbers in the working tree
     only, or also rewrite history. Rewriting needs every clone to re-fetch,
     and editing an old migration file changes a file that replays on every
     boot.
   - Nothing has been changed yet.
2. **Phase 0 against your earlier "don't keep admin token at all for now".**
   Phase 0 needs one interim sign-in in front of everything. Should it be the
   admin token, or a shared password at the edge until passkeys ship?
3. **Sign-in.** Which identity provider does the company use: Google Workspace,
   Microsoft 365, or email only? Is a passkey on every phone acceptable?
4. **Teams.** Is the template list (§6.4) right for this company? Who leads
   each team?
5. **Scope by fleet.** Do any staff work only one fleet, so that a
   fleet-scoped grant matters on day one?
6. **Dispatchers and earnings.** Should dispatchers see driver earnings? The
   design says no: contact, live and bookings only.
7. **Documents.** Who sees full Emirates ID and licence numbers? The design says
   HR and the Owner in full, and Management, Safety and the Auditor masked with
   reveal. That reverses the 2026-09-23 ruling that shows them on every driver
   page.
8. **Four-eyes.** The design applies it to cash-import commits and person
   merges only. Should it also cover single cash entries above a threshold,
   and if so, what threshold?
9. **Ecosine and Egari.** Is "two fleets of one company" (§2.1) right? Or should
   any member of staff be kept out of one of them entirely? Fleet scope covers
   that, so they would not need to be separate companies.
10. **The analyst.** Should the brief be pseudonymised before it goes to the
    third-party model (the design), or stop being sent?
11. **Retention.** How long should the audit log and receipt photos be kept? The
    design says two years for the audit log. Receipts are 12 months today.

---

## 15. What the review changed

One adversarial review read this document against the code on 2026-09-26.

- **Leaks:** none in the document.
- **Factual claims:** none wrong, apart from one count ("Asia/Dubai" appears
  about 300 times, not 302).

It found these gaps, and this revision closes each one.

| gap | where it is closed |
|---|---|
| a grantor could invite a second address of their own as Owner, or widen a copied role | §6.4 ceiling, second Owner, no self-approval |
| a company could claim another's email domain for SSO and sign in as its users | §5.1 DNS-verified domains; SSO admits only into its own company |
| RLS does not apply to the role that owns the tables, and today one role owns them all | §4.1 two roles, `FORCE`, fail closed |
| the stale-refresh and warm calls carry only `x-warm` | §9.2 in-process refresh as the asking fingerprint |
| the SW could not tell companies apart; a path deny list missed contact and cash routes; receipts cached for a year | §9.2 `no-store` by class, `x-fm-scope` partitions, `Clear-Site-Data` |
| four-eyes could be bypassed because the commit takes rows from the request | §8 stored preview, commit by id |
| support could hold Owner or Access and outlive its 72 hours; one operator could transfer ownership | §6.5, §11.1 |
| the first to connect a leaked credential owned the org; the refusal confirmed the account was taken; account moves were undefined | §3.2 rules 6–8 |
| cash lists opened for every role holding ID; guest records were classed as bookings | §7.1 subject class; PAX |
| raw provider records could not be shaped field by field | §6.1 RAW, Owner-only; redact.js kept underneath |
| the audit log would copy documents and credentials | §12.1 keyed hashes; audit view shaped |
| probes are GETs that spend quota | §8 act:collector.probe, POST with CSRF |
| a stale tab could write into another company | §5.1 `x-fm-company`, 409 |
| pseudonyms could be undone by plate and time | §6.2 keyed HMAC; analyst holds VEH and BK pseudonymised and LOC aggregate |
| phase 0 left anonymous reads open | §13 interim sign-in over reads too |

It also found contradictions, which the regenerated appendices resolve:
- the shell was closed to seven roles;
- #policy was closed to Finance;
- the merge route needed CASH;
- diagnostics were open to every role;
- the analyst saw accusations;
- the Connections admin saw drivers;
- HR saw the audit log;
- the export and probe capabilities were undefined;
- the Tesla key needed sign-in.

---

## Appendix A — how to read Appendices B and C

**Role codes:**

| code | role |
|---|---|
| OWN | Owner |
| MGT | Management |
| FIN | Finance manager |
| CLK | Cash desk |
| OPS | Operations manager |
| DSP | Dispatcher |
| HRO | HR officer |
| SAF | Safety & compliance |
| TEC | Fleet technician |
| ANL | Analyst |
| AUD | Auditor |
| ACC | Access admin |
| CON | Connections admin |
| WALL | Wall display |

**Class codes:** as in §6.1.

**The "opens, partly" column:**
- `CLASS` alone means withheld, shown absent with its reason.
- `CLASS:M` means masked, `CLASS:P` pseudonymised and `CLASS:A` aggregate only.
- `accusation` means the page's named attribution is withheld and its counts
  remain.

**Where the classes come from.** The inventory's classes, with these changes:
- PAX added to guest pages;
- PAX and RAW added to single-trip pages;
- ACCUSE added to every page the inventory marked accusatory;
- #policy reclassed from CRED to CASH.

**Per-role totals**, as views that open fully / partly / not at all:

| role | full | partly | closed |
|---|---|---|---|
| OWN | 143 | 0 | 0 |
| MGT | 114 | 26 | 3 |
| FIN | 54 | 64 | 25 |
| CLK | 14 | 46 | 83 |
| OPS | 91 | 27 | 25 |
| DSP | 26 | 69 | 48 |
| HRO | 23 | 52 | 68 |
| SAF | 42 | 55 | 46 |
| TEC | 17 | 68 | 58 |
| ANL | 19 | 104 | 20 |
| AUD | 104 | 36 | 3 |
| ACC | 8 | 3 | 132 |
| CON | 11 | 3 | 129 |
| WALL | 12 | 49 | 82 |

## Appendix B — every view: what it shows, what it opens on, and who can open it

Generated from the 2026-09-26 inventory (143 views and phone screens), the role table in §6.3 and the rules in §7. "opens on" is the subject class (§7.1). "closed" means the view does not open. Accusatory pages are marked **A**. Rows prefixed `m:` are phone screens.

| view | section | shows | opens on | opens fully | opens, partly (withheld or degraded) | closed | |
|---|---|---|---|---|---|---|---|
| demand | Work | BK,REV | BK | OWN MGT FIN OPS AUD | DSP(REV) SAF(REV) TEC(BK:A/REV) ANL(BK:P) WALL(BK:A) | CLK HRO ACC CON |  |
| trips | Work | BK,ID,VEH,LOC,EARN,REV | BK | OWN MGT OPS AUD | FIN(LOC) DSP(EARN/REV) SAF(EARN/REV) TEC(BK:A/EARN/REV) ANL(BK:P/ID:P/VEH:P/LOC:A/EARN:P) WALL(BK:A/ID/VEH:A/LOC:A/EARN) | CLK HRO ACC CON |  |
| supply | Work | BK,LOC | BK | OWN MGT OPS DSP SAF AUD | FIN(LOC) TEC(BK:A) ANL(BK:P/LOC:A) WALL(BK:A/LOC:A) | CLK HRO ACC CON |  |
| platforms (default tab share; also platforms/share) | Work | BK,REV | BK | OWN MGT FIN OPS AUD | DSP(REV) SAF(REV) TEC(BK:A/REV) ANL(BK:P) WALL(BK:A) | CLK HRO ACC CON |  |
| platforms/tiers | Work | VEH,BK,ID | VEH | OWN MGT FIN OPS DSP SAF AUD | HRO(BK) TEC(BK:A) ANL(VEH:P/BK:P/ID:P) WALL(VEH:A/BK:A/ID) | CLK ACC CON |  |
| platforms/funnel | Work | ID,COND,EARN,REV,ACCUSE | ID | OWN MGT OPS AUD | FIN(COND/accusation) CLK(COND/EARN/REV/accusation) DSP(COND:A/EARN/REV/accusation) HRO(EARN/REV) SAF(EARN/REV) TEC(COND/EARN/REV/accusation) ANL(ID:P/COND:P/EARN:P/accusation) | ACC CON WALL | A |
| corridors | Work | LOC,BK,REV | LOC | OWN MGT OPS AUD | DSP(REV) SAF(REV) TEC(BK:A/REV) ANL(LOC:A/BK:P) WALL(LOC:A/BK:A) | FIN CLK HRO ACC CON |  |
| causes | Work | BK,REV | BK | OWN MGT FIN OPS AUD | DSP(REV) SAF(REV) TEC(BK:A/REV) ANL(BK:P) WALL(BK:A) | CLK HRO ACC CON |  |
| forecast | Work | BK | BK | OWN MGT FIN OPS DSP SAF AUD | TEC(BK:A) ANL(BK:P) WALL(BK:A) | CLK HRO ACC CON |  |
| optimise | Work | BK,REV,LOC | BK | OWN MGT OPS AUD | FIN(LOC) DSP(REV) SAF(REV) TEC(BK:A/REV) ANL(BK:P/LOC:A) WALL(BK:A/LOC:A) | CLK HRO ACC CON |  |
| capacity | Work | BK | BK | OWN MGT FIN OPS DSP SAF AUD | TEC(BK:A) ANL(BK:P) WALL(BK:A) | CLK HRO ACC CON |  |
| day/&lt;YYYY-MM-DD&gt; | Work | BK,ID,EARN,COND,VEH,REV,SYS,ACCUSE | BK | OWN MGT OPS AUD | FIN(COND/accusation) DSP(EARN/COND:A/REV/accusation) SAF(EARN/REV) TEC(BK:A/EARN/COND/REV/accusation) ANL(BK:P/ID:P/EARN:P/COND:P/VEH:P/accusation) WALL(BK:A/ID/EARN/COND/VEH:A/accusation) | CLK HRO ACC CON | A |
| slot/&lt;dow 0-6&gt;/&lt;hour 0-23&gt; | Work | BK,ID,EARN,REV,LOC | BK | OWN MGT OPS AUD | FIN(LOC) DSP(EARN/REV) SAF(EARN/REV) TEC(BK:A/EARN/REV) ANL(BK:P/ID:P/EARN:P/LOC:A) WALL(BK:A/ID/EARN/LOC:A) | CLK HRO ACC CON |  |
| trip/&lt;platform&gt;/&lt;id&gt; | Work | BK,ID,EARN,VEH,LOC,REV,PAX,RAW | BK | OWN | MGT(RAW) FIN(LOC/RAW) OPS(PAX:A/RAW) DSP(EARN/REV/PAX:A/RAW) SAF(EARN/REV/PAX/RAW) ANL(BK:P/ID:P/EARN:P/VEH:P/LOC:A/PAX:A/RAW) AUD(PAX:M/RAW) | CLK HRO TEC ACC CON WALL |  |
| drivers | People — drivers | ID,EARN,COND,DOC,VEH,BK,MRG,ACCUSE | ID | OWN | MGT(DOC:M) FIN(COND/DOC/MRG/accusation) CLK(EARN/COND/DOC/VEH/BK/MRG/accusation) OPS(DOC/MRG) DSP(EARN/COND:A/DOC/MRG/accusation) HRO(EARN/BK) SAF(EARN/DOC:M/MRG) TEC(EARN/COND/DOC/BK:A/MRG/accusation) ANL(ID:P/EARN:P/COND:P/DOC/VEH:P/BK:P/MRG/accusation) AUD(DOC:M) | ACC CON WALL | A |
| driver/&lt;id&gt; (overview) | People — drivers | ID,CT,DOC,EARN,CASH,COND,VEH,BK | ID | OWN | MGT(DOC:M) FIN(DOC/COND) CLK(CT/DOC/EARN/COND/VEH/BK) OPS(DOC/CASH) DSP(DOC/EARN/CASH/COND:A) HRO(EARN/CASH/BK) SAF(DOC:M/EARN/CASH) TEC(CT/DOC/EARN/CASH/COND/BK:A) ANL(ID:P/CT/DOC/EARN:P/CASH/COND:P/VEH:P/BK:P) AUD(CT:M/DOC:M) | ACC CON WALL |  |
| driver/&lt;id&gt;/activity | People — drivers | ID,CT,DOC,BK,EARN,VEH | ID | OWN | MGT(DOC:M) FIN(DOC) CLK(CT/DOC/BK/EARN/VEH) OPS(DOC) DSP(DOC/EARN) HRO(BK/EARN) SAF(DOC:M/EARN) TEC(CT/DOC/BK:A/EARN) ANL(ID:P/CT/DOC/BK:P/EARN:P/VEH:P) AUD(CT:M/DOC:M) | ACC CON WALL |  |
| driver/&lt;id&gt;/day?on=&lt;YYYY-MM-DD&gt; | People — drivers | ID,CT,DOC,BK,EARN,LOC,VEH | ID | OWN | MGT(DOC:M) FIN(DOC/LOC) CLK(CT/DOC/BK/EARN/LOC/VEH) OPS(DOC) DSP(DOC/EARN) HRO(BK/EARN/LOC) SAF(DOC:M/EARN) TEC(CT/DOC/BK:A/EARN) ANL(ID:P/CT/DOC/BK:P/EARN:P/LOC:A/VEH:P) AUD(CT:M/DOC:M) | ACC CON WALL |  |
| driver/&lt;id&gt;/territory | People — drivers | ID,CT,DOC,LOC,BK,EARN | ID | OWN | MGT(DOC:M) FIN(DOC/LOC) CLK(CT/DOC/LOC/BK/EARN) OPS(DOC) DSP(DOC/EARN) HRO(LOC/BK/EARN) SAF(DOC:M/EARN) TEC(CT/DOC/BK:A/EARN) ANL(ID:P/CT/DOC/LOC:A/BK:P/EARN:P) AUD(CT:M/DOC:M) | ACC CON WALL |  |
| driver/&lt;id&gt;/earnings | People — drivers | ID,CT,DOC,EARN,CASH,COND | EARN | OWN | MGT(DOC:M) FIN(DOC/COND) OPS(DOC/CASH) ANL(ID:P/CT/DOC/EARN:P/CASH/COND:P) AUD(CT:M/DOC:M) | CLK DSP HRO SAF TEC ACC CON WALL |  |
| driver/&lt;id&gt;/quality | People — drivers | ID,CT,DOC,COND,ACCUSE | ID | OWN HRO | MGT(DOC:M) FIN(DOC/COND/accusation) CLK(CT/DOC/COND/accusation) OPS(DOC) DSP(DOC/COND:A/accusation) SAF(DOC:M) TEC(CT/DOC/COND/accusation) ANL(ID:P/CT/DOC/COND:P/accusation) AUD(CT:M/DOC:M) | ACC CON WALL | A |
| driver/&lt;id&gt;/record | People — drivers | ID,CT,DOC,COND,EARN,BK,ACCUSE | ID | OWN | MGT(DOC:M) FIN(DOC/COND/accusation) CLK(CT/DOC/COND/EARN/BK/accusation) OPS(DOC) DSP(DOC/COND:A/EARN/accusation) HRO(EARN/BK) SAF(DOC:M/EARN) TEC(CT/DOC/COND/EARN/BK:A/accusation) ANL(ID:P/CT/DOC/COND:P/EARN:P/BK:P/accusation) AUD(CT:M/DOC:M) | ACC CON WALL | A |
| driver/&lt;id&gt;/money | People — drivers | ID,CT,DOC,CASH,EARN | CASH | OWN | MGT(DOC:M) FIN(DOC) CLK(CT/DOC/EARN) AUD(CT:M/DOC:M) | OPS DSP HRO SAF TEC ANL ACC CON WALL |  |
| driver/&lt;id&gt;/trips | People — drivers | ID,CT,DOC,BK,LOC,EARN,VEH,COND,ACCUSE | ID | OWN | MGT(DOC:M) FIN(DOC/LOC/COND/accusation) CLK(CT/DOC/BK/LOC/EARN/VEH/COND/accusation) OPS(DOC) DSP(DOC/EARN/COND:A/accusation) HRO(BK/LOC/EARN) SAF(DOC:M/EARN) TEC(CT/DOC/BK:A/EARN/COND/accusation) ANL(ID:P/CT/DOC/BK:P/LOC:A/EARN:P/VEH:P/COND:P/accusation) AUD(CT:M/DOC:M) | ACC CON WALL | A |
| driver/&lt;id&gt;/unauthorized | People — drivers | ID,CT,DOC,COND,VEH,REV,ACCUSE | ID | OWN | MGT(DOC:M) FIN(DOC/COND/accusation) CLK(CT/DOC/COND/VEH/REV/accusation) OPS(DOC) DSP(DOC/COND:A/REV/accusation) HRO(REV) SAF(DOC:M/REV) TEC(CT/DOC/COND/REV/accusation) ANL(ID:P/CT/DOC/COND:P/VEH:P/accusation) AUD(CT:M/DOC:M) | ACC CON WALL | A |
| online-time | People — drivers | ID,CT,COND,LOC,VEH,ACCUSE | ID | OWN MGT OPS SAF | FIN(COND/LOC/accusation) CLK(CT/COND/LOC/VEH/accusation) DSP(COND:A/accusation) HRO(LOC) TEC(CT/COND/accusation) ANL(ID:P/CT/COND:P/LOC:A/VEH:P/accusation) AUD(CT:M) | ACC CON WALL | A |
| performer/&lt;id&gt;[/&lt;week&gt;] | People — drivers | ID,EARN,BK,LOC,VEH | ID | OWN MGT OPS AUD | FIN(LOC) CLK(EARN/BK/LOC/VEH) DSP(EARN) HRO(EARN/BK/LOC) SAF(EARN) TEC(EARN/BK:A) ANL(ID:P/EARN:P/BK:P/LOC:A/VEH:P) | ACC CON WALL |  |
| cohort/&lt;cohort-id&gt; (driver cohorts) | People — drivers | ID,EARN,CASH,COND,DOC,VEH,BK,ACCUSE | ID | OWN | MGT(DOC:M) FIN(COND/DOC/accusation) CLK(EARN/COND/DOC/VEH/BK/accusation) OPS(CASH/DOC) DSP(EARN/CASH/COND:A/DOC/accusation) HRO(EARN/CASH/BK) SAF(EARN/CASH/DOC:M) TEC(EARN/CASH/COND/DOC/BK:A/accusation) ANL(ID:P/EARN:P/CASH/COND:P/DOC/VEH:P/BK:P/accusation) AUD(DOC:M) | ACC CON WALL | A |
| cohort/&lt;cohort-id&gt; (vehicle cohorts) | People — drivers | VEH,ID,LOC,COND,REV | VEH | OWN MGT OPS AUD | FIN(LOC/COND) DSP(COND:A/REV) HRO(LOC/REV) SAF(REV) TEC(COND/REV) ANL(VEH:P/ID:P/LOC:A/COND:P) WALL(VEH:A/ID/LOC:A/COND) | CLK ACC CON |  |
| cancellations | People — the rest | ID,CT,COND,VEH,BK,ACCUSE | ID | OWN MGT OPS SAF | FIN(COND/accusation) CLK(CT/COND/VEH/BK/accusation) DSP(COND:A/accusation) HRO(BK) TEC(CT/COND/BK:A/accusation) ANL(ID:P/CT/COND:P/VEH:P/BK:P/accusation) AUD(CT:M) | ACC CON WALL | A |
| roster (tab all) | People — the rest | ID,COND,EARN,VEH,BK,MRG,ACCUSE | ID | OWN MGT AUD | FIN(COND/MRG/accusation) CLK(COND/EARN/VEH/BK/MRG/accusation) OPS(MRG) DSP(COND:A/EARN/MRG/accusation) HRO(EARN/BK) SAF(EARN/MRG) TEC(COND/EARN/BK:A/MRG/accusation) ANL(ID:P/COND:P/EARN:P/VEH:P/BK:P/MRG/accusation) | ACC CON WALL | A |
| roster/pipeline | People — the rest | ID,COND,VEH | ID | OWN MGT OPS HRO SAF AUD | FIN(COND) CLK(COND/VEH) DSP(COND:A) TEC(COND) ANL(ID:P/COND:P/VEH:P) | ACC CON WALL |  |
| roster/idle | People — the rest | ID,COND,VEH,BK,ACCUSE | ID | OWN MGT OPS SAF AUD | FIN(COND/accusation) CLK(COND/VEH/BK/accusation) DSP(COND:A/accusation) HRO(BK) TEC(COND/BK:A/accusation) ANL(ID:P/COND:P/VEH:P/BK:P/accusation) | ACC CON WALL | A |
| roster/blocked | People — the rest | ID,COND,VEH,ACCUSE | ID | OWN MGT OPS HRO SAF AUD | FIN(COND/accusation) CLK(COND/VEH/accusation) DSP(COND:A/accusation) TEC(COND/accusation) ANL(ID:P/COND:P/VEH:P/accusation) | ACC CON WALL | A |
| roster/states | People — the rest | SYS | SYS | OWN MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC CON WALL |  |  |  |
| top-performers[/&lt;week&gt;] | People — the rest | ID,EARN,BK,VEH | ID | OWN MGT FIN OPS AUD | CLK(EARN/BK/VEH) DSP(EARN) HRO(EARN/BK) SAF(EARN) TEC(EARN/BK:A) ANL(ID:P/EARN:P/BK:P/VEH:P) | ACC CON WALL |  |
| low-performers[/&lt;week&gt;] | People — the rest | ID,EARN,COND,BK,VEH,ACCUSE | ID | OWN MGT OPS AUD | FIN(COND/accusation) CLK(EARN/COND/BK/VEH/accusation) DSP(EARN/COND:A/accusation) HRO(EARN/BK) SAF(EARN) TEC(EARN/COND/BK:A/accusation) ANL(ID:P/EARN:P/COND:P/BK:P/VEH:P/accusation) | ACC CON WALL | A |
| performance[/&lt;period&gt;] (grain week) | People — the rest | ID,COND,EARN,BK,ACCUSE | ID | OWN MGT OPS AUD | FIN(COND/accusation) CLK(COND/EARN/BK/accusation) DSP(COND:A/EARN/accusation) HRO(EARN/BK) SAF(EARN) TEC(COND/EARN/BK:A/accusation) ANL(ID:P/COND:P/EARN:P/BK:P/accusation) | ACC CON WALL | A |
| performance?grain=month[/&lt;period&gt;] | People — the rest | ID,COND,EARN,BK,ACCUSE | ID | OWN MGT OPS AUD | FIN(COND/accusation) CLK(COND/EARN/BK/accusation) DSP(COND:A/EARN/accusation) HRO(EARN/BK) SAF(EARN) TEC(COND/EARN/BK:A/accusation) ANL(ID:P/COND:P/EARN:P/BK:P/accusation) | ACC CON WALL | A |
| retention | People — the rest | ID,BK,VEH | ID | OWN MGT FIN OPS DSP SAF AUD | CLK(BK/VEH) HRO(BK) TEC(BK:A) ANL(ID:P/BK:P/VEH:P) | ACC CON WALL |  |
| compliance | People — the rest | ID,CT,DOC,HR,VEH,COND,ACCUSE | ID | OWN HRO | MGT(DOC:M/HR:M) FIN(DOC/HR/COND/accusation) CLK(CT/DOC/HR/VEH/COND/accusation) OPS(DOC/HR) DSP(DOC/HR/COND:A/accusation) SAF(DOC:M/HR) TEC(CT/DOC/HR/COND/accusation) ANL(ID:P/CT/DOC/HR/VEH:P/COND:P/accusation) AUD(CT:M/DOC:M/HR:M) | ACC CON WALL | A |
| hr-roster | People — the rest | HR,ID,DOC,MRG | HR | OWN HRO | MGT(HR:M/DOC:M) AUD(HR:M/DOC:M) | FIN CLK OPS DSP SAF TEC ANL ACC CON WALL |  |
| identity | People — the rest | MRG,ID,CT | MRG | OWN MGT HRO | AUD(CT:M) | FIN CLK OPS DSP SAF TEC ANL ACC CON WALL |  |
| same-person | People — the rest | MRG,ID,CT,HR,VEH,BK | MRG | OWN | MGT(HR:M) HRO(BK) AUD(CT:M/HR:M) | FIN CLK OPS DSP SAF TEC ANL ACC CON WALL |  |
| #insights | Today | ID,COND,DOC,VEH,REV,SYS,ACCUSE | ID | OWN | MGT(DOC:M) FIN(COND/DOC/accusation) CLK(COND/DOC/VEH/REV/accusation) OPS(DOC) DSP(COND:A/DOC/REV/accusation) HRO(REV) SAF(DOC:M/REV) TEC(COND/DOC/REV/accusation) ANL(ID:P/COND:P/DOC/VEH:P/accusation) AUD(DOC:M) | ACC CON WALL | A |
| #insights/&lt;category&gt; | Today | ID,COND,DOC,VEH,REV,SYS,ACCUSE | ID | OWN | MGT(DOC:M) FIN(COND/DOC/accusation) CLK(COND/DOC/VEH/REV/accusation) OPS(DOC) DSP(COND:A/DOC/REV/accusation) HRO(REV) SAF(DOC:M/REV) TEC(COND/DOC/REV/accusation) ANL(ID:P/COND:P/DOC/VEH:P/accusation) AUD(DOC:M) | ACC CON WALL | A |
| #insights/severity/&lt;critical\|warning&gt; | Today | ID,COND,DOC,VEH,REV,SYS,ACCUSE | ID | OWN | MGT(DOC:M) FIN(COND/DOC/accusation) CLK(COND/DOC/VEH/REV/accusation) OPS(DOC) DSP(COND:A/DOC/REV/accusation) HRO(REV) SAF(DOC:M/REV) TEC(COND/DOC/REV/accusation) ANL(ID:P/COND:P/DOC/VEH:P/accusation) AUD(DOC:M) | ACC CON WALL | A |
| #action/&lt;code&gt;/&lt;entity_id\|-&gt; | Today | ID,CT,COND,DOC,VEH,LOC,REV,ACCUSE | ID | OWN | MGT(DOC:M) FIN(COND/DOC/LOC/accusation) CLK(CT/COND/DOC/VEH/LOC/REV/accusation) OPS(DOC) DSP(COND:A/DOC/REV/accusation) HRO(LOC/REV) SAF(DOC:M/REV) TEC(CT/COND/DOC/REV/accusation) ANL(ID:P/CT/COND:P/DOC/VEH:P/LOC:A/accusation) AUD(CT:M/DOC:M) | ACC CON WALL | A |
| #playbook | Today | REV,ID,CASH,DOC,VEH,LOC,BK | REV | OWN | MGT(DOC:M) FIN(DOC/LOC) OPS(CASH/DOC) ANL(ID:P/CASH/DOC/VEH:P/LOC:A/BK:P) AUD(DOC:M) WALL(ID/CASH/DOC/VEH:A/LOC:A/BK:A) | CLK DSP HRO SAF TEC ACC CON |  |
| #overview | Today | BK,REV,ID,COND,VEH | BK | OWN MGT OPS AUD | FIN(COND) DSP(REV/COND:A) SAF(REV) TEC(BK:A/REV/COND) ANL(BK:P/ID:P/COND:P/VEH:P) WALL(BK:A/ID/COND/VEH:A) | CLK HRO ACC CON |  |
| #compare/&lt;dayA&gt;/&lt;dayB&gt;[?cut=full] | Today | BK,REV,ID,COND,VEH,ACCUSE | BK | OWN MGT OPS AUD | FIN(COND/accusation) DSP(REV/COND:A/accusation) SAF(REV) TEC(BK:A/REV/COND/accusation) ANL(BK:P/ID:P/COND:P/VEH:P/accusation) WALL(BK:A/ID/COND/VEH:A/accusation) | CLK HRO ACC CON | A |
| #analyst | Today | REV,BK,ID,COND,VEH,LOC,ACCUSE | REV | OWN MGT OPS AUD | FIN(COND/LOC/accusation) ANL(BK:P/ID:P/COND:P/VEH:P/LOC:A/accusation) WALL(BK:A/ID/COND/VEH:A/LOC:A/accusation) | CLK DSP HRO SAF TEC ACC CON | A |
| #analyst/refuted | Today | REV,BK,ID,COND,VEH,ACCUSE | REV | OWN MGT OPS AUD | FIN(COND/accusation) ANL(BK:P/ID:P/COND:P/VEH:P/accusation) WALL(BK:A/ID/COND/VEH:A/accusation) | CLK DSP HRO SAF TEC ACC CON | A |
| #analyst/immaterial | Today | REV,BK,ID,COND,VEH,ACCUSE | REV | OWN MGT OPS AUD | FIN(COND/accusation) ANL(BK:P/ID:P/COND:P/VEH:P/accusation) WALL(BK:A/ID/COND/VEH:A/accusation) | CLK DSP HRO SAF TEC ACC CON | A |
| #analyst/unsupported | Today | REV,BK,ID | REV | OWN MGT FIN OPS AUD | ANL(BK:P/ID:P) WALL(BK:A/ID) | CLK DSP HRO SAF TEC ACC CON |  |
| #analyst/rules | Today | ID,VEH | ID | OWN MGT FIN OPS DSP HRO SAF TEC AUD | CLK(VEH) ANL(ID:P/VEH:P) | ACC CON WALL |  |
| #unit | Money | REV,EARN,ID,VEH,LOC,ACCUSE | REV | OWN MGT OPS AUD | FIN(LOC/accusation) ANL(EARN:P/ID:P/VEH:P/LOC:A/accusation) WALL(EARN/ID/VEH:A/LOC:A/accusation) | CLK DSP HRO SAF TEC ACC CON | A |
| #unit/assets | Money | VEH,REV,ID | VEH | OWN MGT FIN OPS AUD | DSP(REV) HRO(REV) SAF(REV) TEC(REV) ANL(VEH:P/ID:P) WALL(VEH:A/ID) | CLK ACC CON |  |
| #unit/drivers | Money | ID,EARN,COND,DOC,VEH,ACCUSE | ID | OWN | MGT(DOC:M) FIN(COND/DOC/accusation) CLK(EARN/COND/DOC/VEH/accusation) OPS(DOC) DSP(EARN/COND:A/DOC/accusation) HRO(EARN) SAF(EARN/DOC:M) TEC(EARN/COND/DOC/accusation) ANL(ID:P/EARN:P/COND:P/DOC/VEH:P/accusation) AUD(DOC:M) | ACC CON WALL | A |
| #cohort/unit-(drove-unpaid\|earned-nothing\|no-hours\|licence-due) | Money | ID,EARN,COND,DOC,VEH,BK,ACCUSE | ID | OWN | MGT(DOC:M) FIN(COND/DOC/accusation) CLK(EARN/COND/DOC/VEH/BK/accusation) OPS(DOC) DSP(EARN/COND:A/DOC/accusation) HRO(EARN/BK) SAF(EARN/DOC:M) TEC(EARN/COND/DOC/BK:A/accusation) ANL(ID:P/EARN:P/COND:P/DOC/VEH:P/BK:P/accusation) AUD(DOC:M) | ACC CON WALL | A |
| #cohort/unit-(idle-documented\|moved-unpaid\|still) | Money | VEH,ID,COND,REV,SYS,ACCUSE | VEH | OWN MGT OPS AUD | FIN(COND/accusation) DSP(COND:A/REV/accusation) HRO(REV) SAF(REV) TEC(COND/REV/accusation) ANL(VEH:P/ID:P/COND:P/accusation) WALL(VEH:A/ID/COND/accusation) | CLK ACC CON | A |
| #revenue | Money | REV,PAY,SYS | REV | OWN MGT FIN ANL AUD | OPS(PAY) WALL(PAY) | CLK DSP HRO SAF TEC ACC CON |  |
| #corporate | Money | REV,BK,LOC | REV | OWN MGT OPS AUD | FIN(LOC) ANL(BK:P/LOC:A) WALL(BK:A/LOC:A) | CLK DSP HRO SAF TEC ACC CON |  |
| #corporate/properties | Money | REV,BK | REV | OWN MGT FIN OPS AUD | ANL(BK:P) WALL(BK:A) | CLK DSP HRO SAF TEC ACC CON |  |
| #corporate/guests | Money | PAX,BK,REV | PAX | OWN MGT FIN | OPS(PAX:A) DSP(PAX:A/REV) ANL(PAX:A/BK:P) AUD(PAX:M) | CLK HRO SAF TEC ACC CON WALL |  |
| #corporate/leakage | Money | REV,BK | REV | OWN MGT FIN OPS AUD | ANL(BK:P) WALL(BK:A) | CLK DSP HRO SAF TEC ACC CON |  |
| #corporate/leakage/&lt;kind&gt; | Money | BK,REV,ID,VEH,LOC,ACCUSE | BK | OWN MGT OPS AUD | FIN(LOC/accusation) DSP(REV/accusation) SAF(REV) TEC(BK:A/REV/accusation) ANL(BK:P/ID:P/VEH:P/LOC:A/accusation) WALL(BK:A/ID/VEH:A/LOC:A/accusation) | CLK HRO ACC CON | A |
| #corporate/approach[/property\|daypart\|type\|zone] | Money | LOC,BK | LOC | OWN MGT OPS DSP SAF AUD | TEC(BK:A) ANL(LOC:A/BK:P) WALL(LOC:A/BK:A) | FIN CLK HRO ACC CON |  |
| #corporate/approach/driver | Money | LOC,ID,COND,ACCUSE | LOC | OWN MGT OPS SAF AUD | DSP(COND:A/accusation) TEC(COND/accusation) ANL(LOC:A/ID:P/COND:P/accusation) WALL(LOC:A/ID/COND/accusation) | FIN CLK HRO ACC CON | A |
| #property/&lt;id&gt; | Money | REV,BK | REV | OWN MGT FIN OPS AUD | ANL(BK:P) WALL(BK:A) | CLK DSP HRO SAF TEC ACC CON |  |
| #property/&lt;id&gt;/guests | Money | PAX,BK,REV | PAX | OWN MGT FIN | AUD(PAX:M) | CLK OPS DSP HRO SAF TEC ANL ACC CON WALL |  |
| #property/&lt;id&gt;/drivers | Money | ID,EARN,LOC | ID | OWN MGT OPS AUD | FIN(LOC) CLK(EARN/LOC) DSP(EARN) HRO(EARN/LOC) SAF(EARN) TEC(EARN) ANL(ID:P/EARN:P/LOC:A) | ACC CON WALL |  |
| #import-sheet | Money | ID,CASH,MRG | CASH | OWN MGT AUD | FIN(MRG) CLK(MRG) | OPS DSP HRO SAF TEC ANL ACC CON WALL |  |
| #opening | Money | ID,CASH | CASH | OWN MGT FIN CLK AUD |  | OPS DSP HRO SAF TEC ANL ACC CON WALL |  |
| #salary | Money | ID,CASH,EARN | CASH | OWN MGT FIN AUD | CLK(EARN) | OPS DSP HRO SAF TEC ANL ACC CON WALL |  |
| #advances | Money | ID,CASH,EARN,ACCUSE | CASH | OWN MGT AUD | FIN(accusation) CLK(EARN/accusation) | OPS DSP HRO SAF TEC ANL ACC CON WALL | A |
| #charging | Money | ID,CASH | CASH | OWN MGT FIN CLK AUD |  | OPS DSP HRO SAF TEC ANL ACC CON WALL |  |
| #policy | Money | CASH,SYS | CASH | OWN MGT FIN CLK AUD |  | OPS DSP HRO SAF TEC ANL ACC CON WALL |  |
| #deposits | Money | ID,CASH | CASH | OWN MGT FIN CLK AUD |  | OPS DSP HRO SAF TEC ANL ACC CON WALL |  |
| #deposits (phone shell, coarse pointer and 760px wide or less) | Money | ID,CASH | CASH | OWN MGT FIN CLK AUD |  | OPS DSP HRO SAF TEC ANL ACC CON WALL |  |
| #finance | Finance | REV,PAY,ID,EARN,COND,ACCUSE | REV | OWN MGT AUD | FIN(COND/accusation) OPS(PAY) ANL(ID:P/EARN:P/COND:P/accusation) WALL(PAY/ID/EARN/COND/accusation) | CLK DSP HRO SAF TEC ACC CON | A |
| #receipts | Finance | PAY,SYS | PAY | OWN MGT FIN ANL AUD |  | CLK OPS DSP HRO SAF TEC ACC CON WALL |  |
| #payouts | Finance | PAY,REV | PAY | OWN MGT FIN ANL AUD |  | CLK OPS DSP HRO SAF TEC ACC CON WALL |  |
| #reconcile | Finance | PAY,REV | PAY | OWN MGT FIN ANL AUD |  | CLK OPS DSP HRO SAF TEC ACC CON WALL |  |
| #reconcile/&lt;YYYY-MM&gt; | Finance | PAY,REV | PAY | OWN MGT FIN ANL AUD |  | CLK OPS DSP HRO SAF TEC ACC CON WALL |  |
| #settlement | Finance | REV,BK | REV | OWN MGT FIN OPS AUD | ANL(BK:P) WALL(BK:A) | CLK DSP HRO SAF TEC ACC CON |  |
| #settlement/cash | Finance | ID,CASH,EARN,VEH,REV | CASH | OWN MGT FIN AUD | CLK(EARN/VEH/REV) | OPS DSP HRO SAF TEC ANL ACC CON WALL |  |
| #settlement/receivables | Finance | PAY,REV,ID,CASH | PAY | OWN MGT FIN AUD | ANL(ID:P/CASH) | CLK OPS DSP HRO SAF TEC ACC CON WALL |  |
| #cohort/settlement-cash | Finance | ID,CASH,EARN,COND,DOC,VEH,ACCUSE | CASH | OWN | MGT(DOC:M) FIN(COND/DOC/accusation) CLK(EARN/COND/DOC/VEH/accusation) AUD(DOC:M) | OPS DSP HRO SAF TEC ANL ACC CON WALL | A |
| #provenance | Finance | REV,PAY,SYS | REV | OWN MGT FIN ANL AUD | OPS(PAY) WALL(PAY) | CLK DSP HRO SAF TEC ACC CON |  |
| vehicles | Fleet | VEH,REV,ID | VEH | OWN MGT FIN OPS AUD | DSP(REV) HRO(REV) SAF(REV) TEC(REV) ANL(VEH:P/ID:P) WALL(VEH:A/ID) | CLK ACC CON |  |
| vehicle/&lt;plate&gt; (overview) | Fleet | VEH,REV,ID,COND,ACCUSE | VEH | OWN MGT OPS AUD | FIN(COND/accusation) DSP(REV/COND:A/accusation) HRO(REV) SAF(REV) TEC(REV/COND/accusation) ANL(VEH:P/ID:P/COND:P/accusation) | CLK ACC CON WALL | A |
| vehicle/&lt;plate&gt;/drivers | Fleet | ID,EARN,BK,VEH | ID | OWN MGT FIN OPS AUD | CLK(EARN/BK/VEH) DSP(EARN) HRO(EARN/BK) SAF(EARN) TEC(EARN/BK:A) ANL(ID:P/EARN:P/BK:P/VEH:P) | ACC CON WALL |  |
| vehicle/&lt;plate&gt;/movement (?day=) | Fleet | LOC,VEH,ID | LOC | OWN MGT OPS DSP SAF TEC AUD |  | FIN CLK HRO ANL ACC CON WALL |  |
| vehicle/&lt;plate&gt;/earnings | Fleet | EARN,REV,ID | EARN | OWN MGT FIN OPS AUD | ANL(EARN:P/ID:P) | CLK DSP HRO SAF TEC ACC CON WALL |  |
| vehicle/&lt;plate&gt;/safety | Fleet | COND,ID,VEH,LOC,ACCUSE | COND | OWN MGT OPS SAF AUD | HRO(LOC) ANL(COND:P/ID:P/VEH:P/LOC:A/accusation) | FIN CLK DSP TEC ACC CON WALL | A |
| vehicle/&lt;plate&gt;/compliance | Fleet | VEH,ID | VEH | OWN MGT FIN OPS DSP HRO SAF TEC AUD | ANL(VEH:P/ID:P) | CLK ACC CON WALL |  |
| vehicle/&lt;plate&gt;/trips | Fleet | BK,ID,LOC,REV | BK | OWN MGT OPS AUD | FIN(LOC) DSP(REV) SAF(REV) ANL(BK:P/ID:P/LOC:A) | CLK HRO TEC ACC CON WALL |  |
| unauthorized | Fleet | COND,ID,VEH,LOC,REV,ACCUSE | COND | OWN MGT OPS AUD | DSP(COND:A/REV/accusation) HRO(LOC/REV) SAF(REV) ANL(COND:P/ID:P/VEH:P/LOC:A/accusation) | FIN CLK TEC ACC CON WALL | A |
| segments | Fleet | COND,ID,LOC,VEH,ACCUSE | COND | OWN MGT OPS SAF AUD | DSP(COND:A/accusation) HRO(LOC) ANL(COND:P/ID:P/LOC:A/VEH:P/accusation) | FIN CLK TEC ACC CON WALL | A |
| segments/verdict/&lt;verdict\|all&gt; | Fleet | COND,ID,LOC,VEH,ACCUSE | COND | OWN MGT OPS SAF AUD | DSP(COND:A/accusation) HRO(LOC) ANL(COND:P/ID:P/LOC:A/VEH:P/accusation) | FIN CLK TEC ACC CON WALL | A |
| segments/plate/&lt;plate&gt; | Fleet | COND,ID,LOC,VEH,ACCUSE | COND | OWN MGT OPS SAF AUD | DSP(COND:A/accusation) HRO(LOC) ANL(COND:P/ID:P/LOC:A/VEH:P/accusation) | FIN CLK TEC ACC CON WALL | A |
| segments/day/&lt;YYYY-MM-DD&gt; | Fleet | COND,ID,LOC,VEH,ACCUSE | COND | OWN MGT OPS SAF AUD | DSP(COND:A/accusation) HRO(LOC) ANL(COND:P/ID:P/LOC:A/VEH:P/accusation) | FIN CLK TEC ACC CON WALL | A |
| segments/driver/&lt;driver name&gt; | Fleet | COND,ID,LOC,VEH,ACCUSE | COND | OWN MGT OPS SAF AUD | HRO(LOC) ANL(COND:P/ID:P/LOC:A/VEH:P/accusation) | FIN CLK DSP TEC ACC CON WALL | A |
| segment/&lt;plate&gt;/&lt;started_at&gt; (?source=) | Fleet | COND,ID,LOC,BK,REV,VEH,ACCUSE | COND | OWN MGT OPS AUD | HRO(LOC/BK/REV) SAF(REV) ANL(COND:P/ID:P/LOC:A/BK:P/VEH:P/accusation) | FIN CLK DSP TEC ACC CON WALL | A |
| safety (safety/people) | Fleet | COND,ID,VEH,ACCUSE | COND | OWN MGT OPS HRO SAF AUD | DSP(COND:A/accusation) ANL(COND:P/ID:P/VEH:P/accusation) | FIN CLK TEC ACC CON WALL | A |
| safety/vehicles | Fleet | VEH,COND,ID,ACCUSE | VEH | OWN MGT OPS HRO SAF AUD | FIN(COND/accusation) DSP(COND:A/accusation) TEC(COND/accusation) ANL(VEH:P/COND:P/ID:P/accusation) WALL(VEH:A/COND/ID/accusation) | CLK ACC CON | A |
| safety/events | Fleet | VEH | VEH | OWN MGT FIN OPS DSP HRO SAF TEC AUD | ANL(VEH:P) WALL(VEH:A) | CLK ACC CON |  |
| live | Fleet | LOC,VEH,ID | LOC | OWN MGT OPS DSP SAF TEC AUD | ANL(LOC:A/VEH:P/ID:P) WALL(LOC:A/VEH:A/ID) | FIN CLK HRO ACC CON |  |
| feeds | Fleet | VEH,SYS,ID,CT | VEH | OWN MGT FIN OPS DSP HRO SAF | TEC(CT) ANL(VEH:P/ID:P/CT) AUD(CT:M) WALL(VEH:A/ID/CT) | CLK ACC CON |  |
| map | Fleet | LOC,ID,VEH | LOC | OWN MGT OPS DSP SAF TEC AUD | ANL(LOC:A/ID:P/VEH:P) WALL(LOC:A/ID/VEH:A) | FIN CLK HRO ACC CON |  |
| map/replay/&lt;plate&gt;?day= | Fleet | LOC,ID,VEH | LOC | OWN MGT OPS DSP SAF TEC AUD | ANL(LOC:A/ID:P/VEH:P) WALL(LOC:A/ID/VEH:A) | FIN CLK HRO ACC CON |  |
| sources | Sources | SYS,ID,CT,LOC | SYS | OWN MGT OPS DSP SAF | FIN(LOC) CLK(CT/LOC) HRO(LOC) TEC(CT) ANL(ID:P/CT/LOC:A) AUD(CT:M) ACC(ID/CT/LOC) CON(ID/CT/LOC) WALL(ID/CT/LOC:A) |  |  |
| coverage | Sources | SYS | SYS | OWN MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC CON WALL |  |  |  |
| providers | Sources | SYS | SYS | OWN MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC CON WALL |  |  |  |
| providers/&lt;provider&gt;/&lt;surface&gt;/&lt;key&gt; | Sources | SYS,ID,CT,LOC,BK | SYS | OWN MGT OPS DSP SAF | FIN(LOC) CLK(CT/LOC/BK) HRO(LOC/BK) TEC(CT/BK:A) ANL(ID:P/CT/LOC:A/BK:P) AUD(CT:M) ACC(ID/CT/LOC/BK) CON(ID/CT/LOC/BK) WALL(ID/CT/LOC:A/BK:A) |  |  |
| settings | Set up | CRED,SYS | CRED | OWN CON |  | MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC WALL |  |
| settings (paste panel) | Set up | CRED | CRED | OWN CON |  | MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC WALL |  |
| notfound | (router) | SYS | SYS | OWN MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC CON WALL |  |  |  |
| (shell, every desktop page) | (shell) | REV,SYS,CRED | SYS | OWN | MGT(CRED) FIN(CRED) CLK(REV/CRED) OPS(CRED) DSP(REV/CRED) HRO(REV/CRED) SAF(REV/CRED) TEC(REV/CRED) ANL(CRED) AUD(CRED) ACC(REV/CRED) CON(REV) WALL(CRED) |  |  |
| m:today (aliases m:overview) | m:Today | REV,SYS | REV | OWN MGT FIN OPS ANL AUD WALL |  | CLK DSP HRO SAF TEC ACC CON |  |
| m:money (aliases m:finance, m:unit, m:settlement, m:revenue) | m:Money | REV | REV | OWN MGT FIN OPS ANL AUD WALL |  | CLK DSP HRO SAF TEC ACC CON |  |
| m:people (alias m:drivers) | m:People | ID,EARN | ID | OWN MGT FIN OPS AUD | CLK(EARN) DSP(EARN) HRO(EARN) SAF(EARN) TEC(EARN) ANL(ID:P/EARN:P) | ACC CON WALL |  |
| m:online-time (?day&start) | m:People | ID,CT,COND,VEH,ACCUSE | ID | OWN MGT OPS HRO SAF | FIN(COND/accusation) CLK(CT/COND/VEH/accusation) DSP(COND:A/accusation) TEC(CT/COND/accusation) ANL(ID:P/CT/COND:P/VEH:P/accusation) AUD(CT:M) | ACC CON WALL | A |
| m:fleet (alias m:vehicles) | m:Fleet | VEH,ID,REV,LOC | VEH | OWN MGT OPS AUD | FIN(LOC) DSP(REV) HRO(REV/LOC) SAF(REV) TEC(REV) ANL(VEH:P/ID:P/LOC:A) WALL(VEH:A/ID/LOC:A) | CLK ACC CON |  |
| m:vehicle/&lt;plate&gt; | m:Fleet | VEH,REV,ID | VEH | OWN MGT FIN OPS AUD | DSP(REV) HRO(REV) SAF(REV) TEC(REV) ANL(VEH:P/ID:P) | CLK ACC CON WALL |  |
| m:vehicle/&lt;plate&gt;/&lt;tab&gt; (fallback) | m:Fleet | VEH,REV,ID,EARN,COND,LOC,BK,ACCUSE | VEH | OWN MGT OPS AUD | FIN(COND/LOC/accusation) DSP(REV/EARN/COND:A/accusation) HRO(REV/EARN/LOC/BK) SAF(REV/EARN) TEC(REV/EARN/COND/BK:A/accusation) ANL(VEH:P/ID:P/EARN:P/COND:P/LOC:A/BK:P/accusation) | CLK ACC CON WALL | A |
| m:driver/&lt;id&gt; | m:People | ID,CT,EARN,COND,ACCUSE | ID | OWN MGT OPS | FIN(COND/accusation) CLK(CT/EARN/COND/accusation) DSP(EARN/COND:A/accusation) HRO(EARN) SAF(EARN) TEC(CT/EARN/COND/accusation) ANL(ID:P/CT/EARN:P/COND:P/accusation) AUD(CT:M) | ACC CON WALL | A |
| m:driver/&lt;id&gt;/&lt;tab&gt; (fallback) | m:People | ID,CT,DOC,EARN,CASH,COND,BK,LOC,MRG,ACCUSE | ID | OWN | MGT(DOC:M) FIN(DOC/COND/LOC/MRG/accusation) CLK(CT/DOC/EARN/COND/BK/LOC/MRG/accusation) OPS(DOC/CASH/MRG) DSP(DOC/EARN/CASH/COND:A/MRG/accusation) HRO(EARN/CASH/BK/LOC) SAF(DOC:M/EARN/CASH/MRG) TEC(CT/DOC/EARN/CASH/COND/BK:A/MRG/accusation) ANL(ID:P/CT/DOC/EARN:P/CASH/COND:P/BK:P/LOC:A/MRG/accusation) AUD(CT:M/DOC:M) | ACC CON WALL | A |
| m:live | m:More | LOC,VEH | LOC | OWN MGT OPS DSP SAF TEC AUD | ANL(LOC:A/VEH:P) WALL(LOC:A/VEH:A) | FIN CLK HRO ACC CON |  |
| m:safety | m:More | VEH | VEH | OWN MGT FIN OPS DSP HRO SAF TEC AUD | ANL(VEH:P) WALL(VEH:A) | CLK ACC CON |  |
| m:unauthorized | m:More | COND,ID,VEH,ACCUSE | COND | OWN MGT OPS HRO SAF AUD | DSP(COND:A/accusation) ANL(COND:P/ID:P/VEH:P/accusation) | FIN CLK TEC ACC CON WALL | A |
| m:sources | m:More | SYS | SYS | OWN MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC CON WALL |  |  |  |
| m:trips | m:More | BK,ID,LOC,REV | BK | OWN MGT OPS AUD | FIN(LOC) DSP(REV) SAF(REV) TEC(BK:A/REV) ANL(BK:P/ID:P/LOC:A) WALL(BK:A/ID/LOC:A) | CLK HRO ACC CON |  |
| m:more | m:More | SYS | SYS | OWN MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC CON WALL |  |  |  |
| m:payouts | m:Money | PAY | PAY | OWN MGT FIN ANL AUD |  | CLK OPS DSP HRO SAF TEC ACC CON WALL |  |
| m:corporate | m:More | REV | REV | OWN MGT FIN OPS ANL AUD WALL |  | CLK DSP HRO SAF TEC ACC CON |  |
| m:analyst | m:More | REV | REV | OWN MGT FIN OPS ANL AUD WALL |  | CLK DSP HRO SAF TEC ACC CON |  |
| m:optimise | m:More | LOC,REV | LOC | OWN MGT OPS AUD | DSP(REV) SAF(REV) TEC(REV) ANL(LOC:A) WALL(LOC:A) | FIN CLK HRO ACC CON |  |
| m:credentials | m:More | CRED | CRED | OWN CON |  | MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC WALL |  |
| m:deposits | m:Money | ID,CASH | CASH | OWN MGT FIN CLK AUD |  | OPS DSP HRO SAF TEC ANL ACC CON WALL |  |
| m:&lt;any view without a phone screen&gt; (fallback) | m:(fallback) | SYS | SYS | OWN MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC CON WALL |  |  |  |
| m:(shell) | m:(shell) | SYS | SYS | OWN MGT FIN CLK OPS DSP HRO SAF TEC ANL AUD ACC CON WALL |  |  |  |

## Appendix C — every API route, today and under ULM

Generated from the 2026-09-26 inventory of 189 routes. "gate today" is what guards the route now (`none` means anonymous). "requires" is what the route manifest (§9.1) declares: `view:X` answers a caller who holds subject class X at any level that can open it, and the shaper then masks or withholds the other classes the route carries ("shaped"); `act:` routes are the actions in §8; `public` routes are the four in §9.1. `fleet` says whether the route takes a fleet parameter today; the manifest scopes every fleet-bearing row whatever the answer.

| method | route | gate today | fleet | requires | shaped |
|---|---|---|---|---|---|
| GET | /api/health | none | no | view:SYS | — |
| GET | /api/ready | none | no | view:SYS | — |
| GET | /api/kpis | none | yes | view:REV | BK,VEH,SYS |
| GET | /api/compare/period | none | yes | view:REV | BK |
| GET | /api/trips/list | none | yes | view:BK | ID,VEH,LOC,REV |
| GET | /api/trips/daily | none | yes | view:REV | BK |
| GET | /api/trips/hourly | none | yes | view:BK | — |
| GET | /api/trips/heatmap | none | yes | view:BK | — |
| GET | /api/mix | none | yes | view:REV | — |
| GET | /api/mix/detail | none | yes | view:REV | ID |
| GET | /api/drivers/leaderboard | none | yes | view:ID | EARN,COND,VEH |
| GET | /api/drivers/cross-platform | none | yes | view:ID | EARN |
| GET | /api/drivers/performance | none | yes | view:ID | EARN,COND |
| GET | /api/vehicles | none | yes | view:VEH | ID,REV |
| GET | /api/live | none | no | view:LOC | VEH,ID |
| GET | /api/track | none | no | view:LOC | — |
| GET | /api/map/days | none | no | view:LOC | ID,VEH |
| GET | /api/map/journey | none | no | view:LOC | ID,VEH |
| GET | /api/alerts/summary | none | yes | view:VEH | COND |
| GET | /api/alerts/by-vehicle | none | yes | view:COND | VEH,ID |
| GET | /api/alerts/by-driver | none | yes | view:COND | ID,VEH |
| GET | /api/finance/ledger | none | yes | view:REV | PAY |
| GET | /api/finance/daily | none | yes | view:REV | — |
| GET | /api/reconcile/periods | none | yes | view:PAY | REV |
| GET | /api/unauthorized/summary | none | yes | view:VEH | REV |
| GET | /api/unauthorized/list | none | yes | view:COND | ID,VEH,LOC |
| GET | /api/unauthorized/by-vehicle | none | yes | view:COND | VEH,ID |
| GET | /api/unauthorized/daily | none | yes | view:VEH | — |
| GET | /api/sensor-health | none | yes | view:VEH | SYS |
| GET | /api/platforms | none | no | view:SYS | — |
| GET | /api/status | none | no | view:SYS | — |
| GET | /api/coverage | none | yes | view:SYS | — |
| GET | /api/admin-mode | isAdmin_redaction | no | view:CRED | — |
| GET | /api/settings | isAdmin_redaction | no | view:CRED | — |
| PUT | /api/settings | requireAdmin | no | act:credentials.write +MFA | CRED |
| POST | /api/settings/paste | requireAdmin | no | act:credentials.write +MFA (apply) / act:credentials.test (test) | CRED |
| POST | /api/import/statement-days | requireAdmin | yes | act:finance.import | EARN,CASH |
| POST | /api/analyst/run | none | yes | act:analyst.run (third-party transfer; pseudonymised brief) | REV,ID,VEH |
| POST | /api/settings/trigger | requireAdmin | yes | act:collector.run (incremental) · act:collector.backfill (backfill, probe; quota) · act:analyst.run (analyst) | CRED,SYS |
| GET | /api/rollups | none | no | view:SYS | — |
| GET | /api/cache-stats | none | no | view:SYS | — |
| GET | /api/settings/jobs | none | no | view:CRED | SYS |
| GET | /api/insights | none | yes | view:ID | CT,COND,REV |
| GET | /api/insights/summary | none | yes | view:REV | COND |
| GET | /api/trend/monthly | none | yes | view:REV | — |
| GET | /api/context | none | no | signed-in | — |
| GET | /api/compliance/vehicles | none | yes | view:VEH | ID |
| GET | /api/compliance/drivers | isAdmin_redaction | yes | view:ID | CT,DOC,HR,COND,MRG |
| GET | /api/recommendations | none | no | view:REV | — |
| GET | /api/earnings/components | none | yes | view:REV | EARN |
| GET | /api/earnings/tips | none | yes | view:EARN | ID |
| GET | /api/product/by-vehicle | none | yes | view:VEH | REV,ID |
| GET | /api/breaks | none | yes | view:REV | — |
| GET | /api/events | none | no | signed-in | — |
| POST | /api/events | requireAdmin | no | act:calendar.edit | — |
| GET | /api/schema/raw-fields | none | no | view:RAW (Owner diagnostics) | SYS,ID,CT,BK,LOC |
| GET | /api/schema/raw-values | none | no | view:RAW (Owner diagnostics) | SYS,ID,CT,BK,LOC |
| GET | /sw.js | none | no | public (no data) | — |
| GET | /.well-known/appspecific/com.tesla.3p.public-key.pem | none | no | public (Tesla fetches it anonymously) | — |
| GET | * (static index.html catch-all, after express.static at :7101) | none | no | public (the shell HTML carries no data) | — |
| GET | /api/drivers/identity-links | none | no | view:MRG | ID |
| GET | /api/drivers/directory | none | yes | view:ID | EARN,COND,DOC,VEH |
| GET | /api/driver/photo/:platform/:id | none | no | view:ID | — |
| GET | /api/driver/profile | isAdmin_redaction | no | view:ID | CT,DOC,HR,COND,VEH,EARN,MRG |
| GET | /api/driver/kpis | none | no | view:EARN | BK,COND,VEH |
| GET | /api/driver/daily | none | no | view:EARN | BK |
| GET | /api/driver/shift | none | no | view:BK | EARN,LOC |
| GET | /api/driver/days | none | no | view:BK | EARN |
| GET | /api/driver/day | none | no | view:LOC | BK,EARN,VEH |
| GET | /api/driver/heatmap | none | no | view:BK | EARN |
| GET | /api/driver/standing | none | no | view:COND | ID |
| GET | /api/driver/territory | none | no | view:LOC | — |
| GET | /api/driver/mix | none | no | view:EARN | — |
| GET | /api/driver/earnings | none | no | view:EARN | CASH |
| GET | /api/driver/quality | none | no | view:COND | — |
| GET | /api/driver/trips | none | no | view:BK | LOC,EARN |
| GET | /api/driver/custody | none | no | view:VEH | — |
| GET | /api/driver/vehicles | none | no | view:VEH | EARN |
| GET | /api/vehicles/directory | none | no | view:VEH | REV,ID |
| GET | /api/vehicles/handover | none | yes | view:VEH | ID |
| GET | /api/vehicle/profile | none | no | view:VEH | LOC,ID |
| GET | /api/vehicle/kpis | none | no | view:VEH | REV,ID,COND |
| GET | /api/vehicle/daily | none | no | view:VEH | REV,COND |
| GET | /api/vehicle/drivers | none | no | view:ID | EARN,VEH |
| GET | /api/vehicle/drivers-detail | none | no | view:ID | EARN,COND |
| GET | /api/vehicle/earnings | none | no | view:EARN | REV,VEH |
| GET | /api/vehicle/movement | none | no | view:LOC | VEH |
| GET | /api/vehicle/safety | none | no | view:COND | LOC,ID,VEH |
| GET | /api/vehicle/mix | none | no | view:REV | VEH |
| GET | /api/vehicle/trips | none | no | view:BK | ID,LOC,REV |
| GET | /api/vehicles/feeds | none | no | view:VEH | SYS,ID,CT |
| GET | /api/cohort/drivers | none | no | view:ID | EARN,COND,DOC |
| GET | /api/cohort/vehicles | none | no | view:VEH | REV,ID |
| GET | /api/settlement/mix | none | yes | view:REV | — |
| GET | /api/settlement/cash-exposure | none | yes | view:CASH | ID |
| GET | /api/settlement/receivables | none | yes | view:REV | CASH,ID |
| GET | /api/corporate/summary | none | yes | view:REV | BK |
| GET | /api/corporate/properties | none | yes | view:REV | — |
| GET | /api/corporate/property | none | yes | view:REV | BK,ID,VEH |
| GET | /api/corporate/guests | none | yes | view:PAX | BK,REV |
| GET | /api/corporate/leakage | none | yes | view:BK | REV,ID,COND |
| GET | /api/corporate/approach | none | yes | view:BK | LOC,ID |
| GET | /api/corporate/stranding | none | yes | view:LOC | BK |
| GET | /api/tiers/by-vehicle | none | yes | view:VEH | REV,ID |
| GET | /api/tiers/mix | none | yes | view:REV | — |
| GET | /api/coverage/calendar | none | yes | view:SYS | — |
| GET | /api/coverage/verified | none | yes | view:SYS | — |
| GET | /api/geo/corridors | none | yes | view:LOC | REV |
| GET | /api/funnel/drivers | none | yes | view:ID | EARN,COND |
| GET | /api/probe/results | none | no | act:collector.probe (becomes POST; spends provider quota) | SYS |
| GET | /api/analyst/findings | none | yes | view:REV | ID |
| GET | /api/analyst/brief | none | yes | view:REV | ID,VEH |
| GET | /api/analyst/rules | none | no | view:SYS | — |
| GET | /api/auth | none | no | view:CRED | SYS |
| GET | /api/cancellations | none | no | view:COND | ID,CT |
| GET | /api/capacity | none | yes | view:VEH | LOC |
| GET | /api/compare | none | yes | view:REV | ID,EARN,LOC |
| GET | /api/day | none | no | view:BK | ID,VEH,LOC,REV,SYS |
| GET | /api/economics/assets | none | yes | view:VEH | REV,EARN,ID |
| GET | /api/economics/drivers | none | yes | view:ID | EARN,COND,DOC,VEH |
| GET | /api/export/trips.csv | isAdmin_redaction | yes | act:export.BK (+ each class exported; watermarked) | BK,ID,VEH,REV,LOC |
| GET | /api/forecast | none | yes | view:REV | — |
| GET | /api/hr-roster | none | no | view:HR | ID,CT,DOC,MRG |
| POST | /api/hr-roster/preview | requireAdmin | no | act:hr.import | HR,MRG,DOC |
| POST | /api/hr-roster/commit | requireAdmin | no | act:hr.import +MFA | HR,MRG,DOC |
| POST | /api/ledger/import/preview | none | no | act:cash.import | CASH,ID |
| POST | /api/ledger/import/commit | none | no | act:cash.import.commit (four-eyes) | CASH,ID |
| GET | /api/ledger/cash-position | none | no | view:CASH | ID |
| GET | /api/ledger/people | none | no | view:CASH | ID |
| GET | /api/ledger/entries | none | no | view:CASH | ID |
| POST | /api/ledger/entry | none | no | act:cash.record | CASH,ID |
| POST | /api/ledger/receipt | none | no | act:cash.record | CASH |
| GET | /api/ledger/receipt/:sha | none | no | view:CASH | — |
| GET | /api/ledger/exposure | none | no | view:CASH | EARN,ID |
| GET | /api/ledger/policy | none | no | view:CASH | — |
| POST | /api/ledger/policy | none | no | act:cash.policy (reason required) | CASH |
| GET | /api/online-time | none | no | view:ID | CT,COND,VEH |
| GET | /api/finance/payouts | none | yes | view:PAY | — |
| GET | /api/finance/payouts/reconcile | none | yes | view:PAY | REV |
| POST | /api/finance/payouts/verify | none | implicit_single_fleet | act:finance.verify (provider quota) | PAY |
| GET | /api/performance/driver | none | yes | view:ID | EARN,COND |
| GET | /api/performance/fleet | none | yes | view:REV | — |
| GET | /api/performer | none | no | view:ID | EARN,BK,LOC,VEH |
| GET | /api/performer/weeks | none | no | signed-in | — |
| GET | /api/person/merge | none | no | view:MRG | CASH |
| POST | /api/person/merge | none | no | act:identity.merge (four-eyes) | MRG,CASH |
| GET | /api/playbook | none | yes | view:ID | DOC,VEH,REV,LOC,COND |
| GET | /api/probe/uber/report-types | none | implicit_single_fleet | act:collector.probe (becomes POST; spends provider quota) | CRED,SYS |
| GET | /api/probe/uber/report-columns | none | implicit_single_fleet | act:collector.probe (becomes POST; spends provider quota) | CRED,SYS |
| GET | /api/probe/uber/driver | none | implicit_single_fleet | act:collector.probe (becomes POST; spends provider quota) | CRED,SYS |
| GET | /api/probe/uber/rest | none | implicit_single_fleet | act:collector.probe (becomes POST; spends provider quota) | CRED,SYS |
| GET | /api/probe/uber/window | none | implicit_single_fleet | act:collector.probe (becomes POST; spends provider quota) | CRED,SYS |
| GET | /api/probe/uber/timeline | none | no | view:RAW (Owner diagnostics) | LOC,COND,BK |
| GET | /api/probe/zero-distance | none | no | view:RAW (Owner diagnostics) | BK,ID |
| GET | /api/probe/tesla/egress | none | no | act:collector.probe (becomes POST; spends provider quota) | SYS |
| GET | /api/probe/uber/realtime | none | no | act:collector.probe (becomes POST; spends provider quota) | CRED,SYS |
| GET | /api/probe/uber/audit | none | yes | act:collector.probe (becomes POST; spends provider quota) | BK,SYS |
| GET | /api/probe/uber/tier | none | implicit_single_fleet | act:collector.probe (becomes POST; spends provider quota) | CRED,SYS |
| GET | /api/probe/yango | none | no | act:collector.probe (becomes POST; spends provider quota) | CRED,SYS |
| GET | /api/probe/yango/keyapi | none | no | act:collector.probe (becomes POST; spends provider quota) | CRED,SYS |
| GET | /api/probe/bolt/payouts | none | yes | act:collector.probe (becomes POST; spends provider quota) | PAY,CRED |
| GET | /api/probe/yango/ledger | none | no | act:collector.probe (becomes POST; spends provider quota) | PAY,CRED |
| GET | /api/probe/fms/window | none | no | act:collector.probe (becomes POST; spends provider quota) | CRED,SYS |
| GET | /api/reconcile | none | yes | view:PAY | REV |
| GET | /api/driver/register | none | no | view:CASH | EARN,BK,ID,VEH |
| GET | /api/retention | none | yes | view:ID | REV |
| GET | /api/finance/receipts | none | yes | view:REV | PAY |
| GET | /api/money/sources | none | yes | view:REV | — |
| GET | /api/revenue | none | yes | view:REV | VEH |
| GET | /api/roster | none | yes | view:ID | COND,VEH,EARN |
| GET | /api/roster/states | none | yes | view:COND | VEH |
| GET | /api/same-person | none | no | view:MRG | ID,HR |
| POST | /api/same-person/decide | none | no | act:identity.decide | MRG |
| GET | /api/segments | none | yes | view:VEH | COND,LOC |
| GET | /api/segment | none | no | view:LOC | BK,ID,VEH |
| GET | /api/slot | none | yes | view:ID | VEH,LOC,BK |
| GET | /api/status/driver | none | no | view:COND | VEH,ID |
| GET | /api/status/fleet | none | yes | view:COND | ID,VEH |
| GET | /api/supply/balance | none | yes | view:LOC | REV |
| GET | /api/optimise | none | yes | view:LOC | VEH,REV |
| GET | /api/supply/areas | none | yes | view:LOC | — |
| GET | /api/tesla/status | none | no | act:collector.probe (calls Tesla, may rotate its token) | VEH,CRED |
| GET | /api/tesla/connect | none | no | act:credentials.write (becomes POST) | CRED |
| GET | /teslaredirect | other | no | public (OAuth return; single-use state checked, then act:credentials.write of the signed-in user who started it) | CRED |
| GET | /api/tesla/vehicles | none | no | act:collector.probe (calls Tesla, may rotate its token) | VEH |
| GET | /api/trip | none | no | view:BK | ID,VEH,LOC,REV,PAX,RAW |
| GET | /api/unauthorized/attributed/plan | none | yes | view:RAW (Owner diagnostics) | SYS |
| GET | /api/unauthorized/attributed | none | yes | view:COND | ID,VEH,REV |
| GET | /api/driver/unauthorized | none | yes | view:COND | ID,VEH,LOC |
