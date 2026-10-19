/* v109: LOW-PERFORMER WATCH LISTS (api/lowperf_routes.js, api/lowperf.js).
   ─────────────────────────────────────────────────────────────────────────
   The operator, 2026-10-19: the Low performers tab must let them "check
   their performance improvement as well" — the bottom-45 list of 14 Oct,
   followed day by day for the fortnight after, was the report that asked
   for it. A watch list is that: the people below target on the day it was
   saved, and the day itself, so every later day can be read against it.

   Kept by the Owner and the Operations managers (the capability
   watchlist.edit, api/public/access_model.js), ruled the same day.

   MEMBERS are person keys — the stored fold every driver count uses
   (trip.person_key, sql/schema_v53.sql) — plus every platform account the
   person held when saved, because a later ruling in the identity register
   re-keys a person and the list must still find them (api/lowperf.js
   watchOf). `at_save` is the member's figures on the save, as the server
   computed them (never as a page sent them): share of target, AED and days,
   so "where they started" survives a later re-pricing of the same days.

   NOTHING IS DELETED. Removing a member stamps removed_at; archiving a list
   stamps archived_at. Who did it is the staff user id; the access audit log
   (api/access/audit.js) holds the request itself. */
CREATE TABLE IF NOT EXISTS lowperf_watch (
  id               bigserial   PRIMARY KEY,
  name             text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  saved_day        date        NOT NULL,                   -- the Dubai day it was saved
  period_from      date,                                   -- the period the list was drawn from
  period_to        date,
  hotel            text        NOT NULL DEFAULT 'hide' CHECK (hotel IN ('hide', 'mostly', 'show')),
  fleet            text,                                   -- null: both fleets
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       bigint,
  archived_at      timestamptz,
  archived_by      bigint
);

CREATE TABLE IF NOT EXISTS lowperf_watch_member (
  watch_id   bigint      NOT NULL REFERENCES lowperf_watch (id),
  pk         text        NOT NULL,
  ids        text[]      NOT NULL DEFAULT '{}',
  name       text,
  fleet      text,
  at_save    jsonb,
  added_at   timestamptz NOT NULL DEFAULT now(),
  added_by   bigint,
  removed_at timestamptz,
  removed_by bigint,
  PRIMARY KEY (watch_id, pk)
);

CREATE INDEX IF NOT EXISTS lowperf_watch_member_live_idx ON lowperf_watch_member (watch_id) WHERE removed_at IS NULL;
