# Backup and restore — fleet-dashboard-db

Written 2026-11-12, after the system audit found no backup or restore note
anywhere in the repository. It covers what DigitalOcean keeps, how to restore
into a new cluster and point the app at it, the one setting that must not be
lost (`SETTINGS_KEY`), what the app does to a restored database on its first
boot, how to verify a restore with `bin/restore-drill.mjs`, and how to keep
history longer than DigitalOcean does.

Every statement about DigitalOcean is marked:

- **[verified]** — read from the DigitalOcean API or production by the
  system audit of 2026-11-12 (docs/COVERAGE.md, "What the system audit of
  2026-11-12 measured"), or from this repository's code.
- **[knowledge]** — from DigitalOcean's documented behaviour as the author
  understands it, NOT verified in this session (no DigitalOcean API calls
  were allowed). Check it against the control panel before relying on it in
  an incident.

## 1. What exists today

| | |
|---|---|
| Cluster | `fleet-dashboard-db`, PostgreSQL 16, `db-s-2vcpu-4gb`, **one node (no standby)**, region fra1, 60 GiB disk **[verified]** |
| Backups | daily, taken by DigitalOcean. The backup list read on 2026-11-12 held 8 entries (the audit's working notes say "7 kept"); the newest was **5.95 GB** **[verified]**. DigitalOcean keeps daily backups for **7 days** **[knowledge]** — the eighth entry is most likely today's beside seven older ones. |
| Point-in-time restore | DigitalOcean can restore a PostgreSQL cluster to any moment inside the backup retention window, from its write-ahead log **[knowledge]** |
| Where a restore goes | always into a **new** cluster; DigitalOcean does not restore over the running one **[knowledge]** |
| Backups after deletion | a cluster's backups go when the cluster is destroyed **[knowledge]** — never destroy the old cluster until the new one has run cleanly for a week |
| Trusted sources | **none** — the cluster accepts a connection from any address that has the password **[verified]**. Fix that on a restored cluster at creation (§3 step 2). |
| Components that connect | the `api` service and the `collector` worker, both reading `DATABASE_URL`; both also set `SETTINGS_KEY` **[verified]** |
| Anything else that holds data | nothing. Both components are `basic-xxs` with **ephemeral disk** — nothing written to local disk survives a deploy (CLAUDE.md) **[verified]** |
| Logical exports | **none** before this note. §6 is how to start them. |

So the honest position is: **seven days of history, one region, no copy
outside DigitalOcean.** A mistake noticed on day eight is not recoverable,
and that includes a mistake by the data-retention pass — which is why
`RETENTION_MODE` defaults to `dry_run` (src/data_retention.js) and why §6
says to take a logical export before anyone switches it to `on`.

## 2. Before you need it: record the counts

A restore can only be checked against something. Read-only, against
production, at backup time (weekly with the export in §6 is enough):

```bash
cd collector
DATABASE_URL=<production URL> node bin/restore-drill.mjs --counts > counts-$(date +%F).json
```

It prints whole-table row counts of the major tables (trip, alert,
telemetry_snapshot, driver_timeline_event, driver_payout_day, ledger_entry,
app_setting, access_user, schema_applied, …) and nothing else — no names, no
values. Keep the file beside the export. The session is READ ONLY.

## 3. Restore into a new cluster

1. **Pick the moment.** The latest daily backup, or — for "before the bad
   write at 14:05" — a point in time inside the last seven days
   **[knowledge]**.
2. **Create the restored cluster** **[knowledge — confirm the field names
   in the control panel or the API reference]**:
   - Control panel: Databases → `fleet-dashboard-db` → Backups → choose a
     backup or a point in time → Restore. Same engine (PG 16), region fra1,
     size at least `db-s-2vcpu-4gb`, a new name such as
     `fleet-dashboard-db-restore-YYYYMMDD`.
   - Or the API: `POST /v2/databases` with the usual cluster fields plus
     `"backup_restore": {"database_name": "fleet-dashboard-db",
     "backup_created_at": "<ISO time>"}`.
   - Or `doctl databases create <new-name> --engine pg --version 16
     --region fra1 --size db-s-2vcpu-4gb --num-nodes 1
     --restore-from-cluster-name fleet-dashboard-db
     --restore-from-timestamp "<YYYY-MM-DD HH:MM:SS +0000 UTC>"`.
   - **Add trusted sources now**: the App Platform app `fleet-dashboard`
     (and the address you will run the drill from, removed afterwards).
     Production has none; a restore is the moment not to copy that.
3. **Wait until it is online**, then take its connection string from
   Connection details. Do not assume the old password works on the new
   cluster; use what the new cluster shows.
4. **Run the drill against it** (§5) with production's `SETTINGS_KEY` and
   the counts you recorded. Do not repoint anything until it passes.
5. **Repoint both components.** `DATABASE_URL` is set on the `api` service
   AND on the `collector` worker; change both, and leave `SETTINGS_KEY`
   exactly as it is on both.
   - Control panel: Apps → `fleet-dashboard` → Settings → each component →
     Environment variables → `DATABASE_URL` (encrypted) → the new string.
   - Or the app spec: `doctl apps spec get <app-id> > spec.yaml`, change
     both components' `DATABASE_URL`, `doctl apps update <app-id> --spec
     spec.yaml`. **An app-spec update redeploys the last BUILT commit, not
     the branch head** (COVERAGE trap 25) — which is what you want here: the
     same code against the restored data. If the spec binds the database as
     a component (`${fleet-dashboard-db.DATABASE_URL}`) rather than holding
     a literal, attach the new cluster and change the binding instead.
6. **Watch the first boot** (§4): the log line `migrations complete {ran,
   skipped, of}`; `/api/health` (200 from the moment the process is up, with
   `migrating: true` while migrations run — every other `/api` route answers
   503 "starting" until they finish); then `/api/status` rows advancing past
   the restore point and
   `/api/settings` showing every credential configured — a credential that
   reads "not configured" after a restore is a `SETTINGS_KEY` problem (§3a).
   Production caches: append `&_=$RANDOM` to every check.
7. **Keep the old cluster for a week**, read-only in practice, then destroy
   it. Its backups go with it **[knowledge]**.

### 3a. Why `SETTINGS_KEY` must be carried over unchanged

`src/settings.js:11-13`:

```js
const KEY = crypto.createHash('sha256')
  .update(process.env.SETTINGS_KEY || process.env.DATABASE_URL || 'fleet-dev-key')
  .digest();
```

Every secret saved on the Settings page — Uber cookies and OAuth secrets,
Bolt and Yango tokens, FMS and CABMAN passwords, SMS and model API keys — is
stored in `app_setting` sealed with AES-256-GCM under that key. If
`SETTINGS_KEY` were unset, the key would be derived from `DATABASE_URL`, and
**a restore always changes `DATABASE_URL`**: every stored secret would then
fail its GCM tag, `dec()` would answer null, the collectors would behave as
unconfigured and the Settings page would show the credentials as missing —
with nothing anywhere saying the key moved. The only recovery would be to
re-enter every secret by hand.

Production sets `SETTINGS_KEY` on both components **[verified]**, so the
fallback is not live — which is exactly why the same value must go onto any
component that reads a restored database. Keep it in the operator's password
manager beside the app id, never in the repository. The drill (§5) checks it
for you: it derives the key exactly as the app does and tries every stored
secret, printing only setting names.

(Rotating `SETTINGS_KEY` is a different job: every secret would have to be
re-sealed under the new key. No tool for that exists yet.)

## 4. What the app does to a restored database on first boot

`src/db.js` `migrate()`, run by BOTH components at boot:

- It takes a session advisory lock first, so the API and the collector,
  which a deploy starts together, migrate one after the other instead of
  deadlocking on the same objects.
- It reads the ledger `schema_applied` (file, SHA-256 of the file's
  contents) and walks `src/schema_files.js` in order. A file whose recorded
  SHA matches is **skipped**; any other file is **run once** as one batch
  and recorded on success. A file that fails is NOT recorded and is retried
  on the next boot; only a failure of `schema.sql` stops the boot.
- The ledger is a table, so **it is restored with the data**. Files applied
  when the backup was taken are skipped; files the code has gained since run
  once; a file edited since runs once more. `schema_v53.sql` is the edited
  file by design — it is regenerated whenever the merge register changes,
  drops and re-adds `person_key` on six tables, and took about two minutes
  on 2026-09-07 with the API answering 503 meanwhile.
- While migrations run, every `/api` route except `/api/health` answers
  `503 {"error":"starting"}` with `Retry-After`; health answers 200 with
  `migrating: true`, so the platform does not roll the deploy back.
- Into an EMPTY database (a logical restore that left the ledger out, or a
  fresh cluster) every file replays from `schema.sql` up. That works — every
  file is written to be idempotent — and takes minutes, not seconds.

## 5. The drill: `bin/restore-drill.mjs`

```bash
cd collector
DATABASE_URL=<restored cluster URL> SETTINGS_KEY=<production value> \
  node bin/restore-drill.mjs --expect-file counts-2026-11-12.json
```

It never prints `DATABASE_URL`, `SETTINGS_KEY` or any stored secret — and a
failed connection's message has the URL's password, user, host and port cut
out (node names an unreachable host bare; the first draft printed it). It
names the database (its name, which is not a credential), the server version
and when the server started (a restored
cluster started minutes ago; production has been up for days — that is how
you tell which one you are pointed at). The session is READ ONLY.

| check | passes when | otherwise |
|---|---|---|
| ledger | every file in `src/schema_files.js` has a `schema_applied` row with this checkout's SHA | a file missing before the last applied one is a **hole** (fail); missing files at the end are newer migrations the first boot applies (fail, or warn with `--allow-pending` before cutover); a changed SHA re-runs once at boot (warn) |
| counts | every `--expect table=N` / `table>=N` (or `--expect-file`) holds | a short or missing table fails; nothing given is **not measured**, never a pass |
| secret | every `app_setting` secret decrypts under the key this environment derives, as `src/settings.js` derives it | none decrypt: fail (wrong key); some do: warn, naming the settings to re-enter; a key from `DATABASE_URL` instead of `SETTINGS_KEY` warns even when it works |

Exit codes: 0 pass (warnings allowed), 1 a check failed, 2 nothing failed but
something was not measured, 3 could not connect. The checks live in
`src/restore_drill.js` and are tested on PGlite in
`test/restore_drill.test.mjs`, including that the drill's key derivation is
the app's (a secret sealed by `setSetting()` decrypts) and that a refused or
unresolvable connection prints no part of the URL, host included.

## 6. Keeping history longer than seven days

DigitalOcean's backups are a seven-day safety net for accidents, not an
archive. For anything longer, take a **weekly logical export to storage the
operator chooses** — a DigitalOcean Spaces bucket in fra1 is the nearest; any
S3-compatible store works.

```bash
# pg_dump 16 or newer (never older than the server)
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" \
  | age -r <operator public key> \
  | aws s3 cp - "s3://<bucket>/fleet/fleet-$(date +%F).dump.age" --endpoint-url https://fra1.digitaloceanspaces.com
node bin/restore-drill.mjs --counts | aws s3 cp - "s3://<bucket>/fleet/counts-$(date +%F).json" --endpoint-url …
```

- **Stream it; never stage it.** The worker has 512 MB of memory and
  ephemeral disk; a multi-gigabyte dump must not touch either. Run it
  somewhere with its own disk and network: a scheduled job outside the two
  `basic-xxs` components, or a small machine with cron. (Whether App
  Platform's scheduled jobs suit this is **[knowledge]** to confirm.) The
  `fleet-egress` droplet appears unused (audit) — it is not a backup host
  until someone decides it is.
- **Encrypt it before it leaves.** The dump holds personal data (driver
  names, phone numbers, identity documents, GPS tracks) in clear. The stored
  secrets stay sealed under `SETTINGS_KEY` inside it — so never store the
  dump and the key in the same place.
- **Keep a lifecycle rule** on the bucket, e.g. twelve weeklies and twelve
  monthlies.
- **Size**: the physical backup is 5.95 GB **[verified]**; a compressed
  custom-format dump is usually much smaller because indexes are not dumped,
  but measure the first one rather than trusting an estimate.
- **Restoring an export**: create an empty cluster (or database), decrypt
  the dump with the operator's private key, then restore it:
  `age -d -i <operator key file> fleet.dump.age > fleet.dump` (on a machine
  with its own disk, never the app's components) and
  `pg_restore --no-owner --no-privileges --dbname "$NEW_URL" fleet.dump`.
  The dump carries `schema_applied`, so the first boot skips what was
  applied (§4). Then run the drill against it.
- **Take one before** switching `RETENTION_MODE` to `on`, and before any
  migration that rewrites data.

## 7. Practise it

A restore nobody has rehearsed is a hope. Quarterly: restore last night's
backup into a throwaway cluster (§3 steps 1-4), run the drill against it with
the counts recorded that night, add a row below with the date and the drill's
summary lines (it prints no secrets), destroy the throwaway cluster.

## Drills run

| date | backup restored | drill result | by |
|---|---|---|---|
| — | none yet: the drill was written 2026-11-12 and has run only against PGlite in the tests | | |
