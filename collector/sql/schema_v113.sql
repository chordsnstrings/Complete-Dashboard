-- v113: charging, from PowerDrive (a YoCharge white label, api.mena.yocharge.com)
-- — src/sources/yocharge.js; the operator, 2026-11-03: "show charging wallet
-- balance for the drivers that we have … we need to be very precise before we
-- incorporate anything into production", then "let's figure out how we can have
-- all sessions as well. we can track how many times each vehicles are charging".
--
-- charging_user     one row per PowerDrive customer the collector has read: who
--                   they are as PowerDrive knows them (name, mobile, email — the
--                   match keys; there is no external id), their fleet group, and
--                   their wallet as of fetched_at. AED (the currency is named on
--                   each transaction's payment; the wallet names none).
-- charging_link     which of OUR people a PowerDrive customer is. 'auto' is
--                   written by the collector only on the precise rule (a phone
--                   held by exactly one of our people and one customer, and the
--                   two names sharing a word); 'candidate' is everything short of
--                   it, with its reason, waiting for a person; 'confirmed' and
--                   'refused' are a person's decision and the collector never
--                   touches them.
-- charging_session  one row per charging session of a WATCHED customer (in one
--                   of our fleet groups, or linked to one of our people) — never
--                   another PowerDrive customer's. kWh (PowerDrive counts watt-
--                   hours: stored ÷ 1000), seconds, cost, state of charge, the
--                   site and charger, the vehicle as PowerDrive holds it (its
--                   number is often empty), and which of our cars it was.
CREATE TABLE IF NOT EXISTS charging_user (
  yc_user_id            text PRIMARY KEY,
  name                  text,
  phone_norm            text,
  email                 text,
  fleet_group           text,
  using_fleet_wallet    boolean NOT NULL DEFAULT false,
  fleet_limit           numeric(12,2),
  fleet_limit_available numeric(12,2),
  fleet_limit_used      numeric(12,2),
  balance               numeric(12,2),
  hold_amount           numeric(12,2),
  credit_limit          numeric(12,2),
  last_session_at       timestamptz,
  vehicles              jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active             boolean,
  fetched_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS charging_user_phone_idx ON charging_user (phone_norm);
CREATE INDEX IF NOT EXISTS charging_user_fleet_idx ON charging_user (fleet_group);

CREATE TABLE IF NOT EXISTS charging_link (
  yc_user_id  text NOT NULL,
  person_id   bigint NOT NULL,
  tier        text NOT NULL CHECK (tier IN ('auto', 'candidate', 'confirmed', 'refused')),
  reason      text,
  decided_by  text,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (yc_user_id, person_id)
);
CREATE INDEX IF NOT EXISTS charging_link_person_idx ON charging_link (person_id);

CREATE TABLE IF NOT EXISTS charging_session (
  id              text PRIMARY KEY,
  yc_user_id      text NOT NULL,
  started_at      timestamptz,
  stopped_at      timestamptz,
  created_at      timestamptz,
  status          text,
  kwh             numeric(12,3),
  duration_s      integer,
  charging_s      integer,
  soc_start       numeric(6,2),
  soc_end         numeric(6,2),
  cost_incl_vat   numeric(12,2),
  cost_excl_vat   numeric(12,2),
  currency        text,
  property_id     text,
  property_name   text,
  charger_name    text,
  connector       text,
  vehicle_id      text,
  vehicle_name    text,
  vehicle_number  text,
  anomaly         boolean,
  anomaly_type    text,
  is_emsp         boolean,
  /* Which of OUR cars charged, and how that is known (attributeSessions):
       session_plate  PowerDrive's own vehicle number on the session equals
                      one of our plates;
       only_car       the linked driver drove one car that day;
       nearest_trip   they drove more than one; the car of the trip nearest
                      the session's start;
       no_trip        they drove no car that day — not attributed;
       no_link        the customer is not linked to one of our people. */
  plate           text,
  plate_basis     text,
  fetched_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS charging_session_user_idx ON charging_session (yc_user_id, started_at);
CREATE INDEX IF NOT EXISTS charging_session_started_idx ON charging_session (started_at);
