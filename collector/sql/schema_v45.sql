/* What the platform says about a driver, from the surface that actually says it.
   ─────────────────────────────────────────────────────────────────────────
   The roster has shown a Rating column of dashes since it was built, and every
   sentence under it — including one rewritten this morning — has explained the
   emptiness as a fact about the world: no channel this fleet is connected to
   reports a driver rating.

   That was never true. It was a fact about which surfaces the collector calls.
   Uber's supplier portal answers GetDriver with

     driver.member.user.driverInfo.recognitionRating
     driver.member.user.driverInfo.completedTripsCount
     driver.member.user.isBanned
     driver.complianceInfo.status
     driver.associatedVehicles[] { uuid, licensePlate, make, model, year }

   and nothing here had ever asked. Probed live on 2026-08-31 against a real
   Ecosine driver: rating 4.97, 8,998 completed trips, not banned, compliance
   ACTIVE, one vehicle. The two surfaces the collector DOES call cannot carry
   any of it — the OAuth roster returns onboarding status and a plate, and the
   earnings breakdown returns trips, distance and money.

   The columns land on driver_platform_state because that table already means
   "what this platform says about this person", is keyed (platform,
   driver_ext_id), and is already written by four collectors. A row here is one
   platform's opinion, which is the right shape: two platforms may rate the
   same human differently and both be right.

   Deliberately NOT reusing `score`. Bolt writes a standing score there — a
   different quantity on a different scale, from a different provider — and one
   column holding two incomparable measures is how a page comes to rank people
   against each other on a number that means two things. */
ALTER TABLE driver_platform_state
  ADD COLUMN IF NOT EXISTS rating            DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lifetime_trips    INT,
  ADD COLUMN IF NOT EXISTS is_banned         BOOLEAN,
  ADD COLUMN IF NOT EXISTS compliance_status TEXT,
  /* When the PROFILE was last read, which is not observed_at. The roster pull
     runs every half hour and stamps observed_at; the profile pull is one call
     per driver and runs daily. A reader who cannot tell them apart will report
     a rating as thirty minutes old when it is a day old. */
  ADD COLUMN IF NOT EXISTS profile_at        TIMESTAMPTZ;

COMMENT ON COLUMN driver_platform_state.rating IS
  'The platform''s own driver rating (Uber: recognitionRating, 0-5). NULL means this platform was not asked or does not publish one — never that the driver is unrated.';
COMMENT ON COLUMN driver_platform_state.lifetime_trips IS
  'Completed trips this platform has ever recorded for the driver. Uber''s own count, which is a cross-check on ours and not a substitute: ours covers what we collected, this covers their whole relationship.';
COMMENT ON COLUMN driver_platform_state.is_banned IS
  'The platform has barred this driver. A supply constraint, and a harder one than a state of "inactive".';
COMMENT ON COLUMN driver_platform_state.compliance_status IS
  'The platform''s own view of whether the driver''s papers are in order. Independent of driver_compliance, which is the hotel channel''s document register.';

CREATE INDEX IF NOT EXISTS dps_rating_idx ON driver_platform_state (rating)
  WHERE rating IS NOT NULL;

/* Uber names the car the driver is attached to, with its make, model and year.
   The vehicle register carries all three and they are mostly empty, so the same
   call that answers the rating question also fills the fleet's own asset list.
   Nothing here overwrites a value that is already set: a make from the vehicle
   supplier's own record beats one inferred from a plate, and this is the only
   writer that has Uber's. */
ALTER TABLE vehicle
  ADD COLUMN IF NOT EXISTS ext_id TEXT;

COMMENT ON COLUMN vehicle.ext_id IS
  'The platform''s uuid for this vehicle, where one is known. Uber''s associatedVehicles gives it beside the plate, which is what lets a driver-to-vehicle assignment be read from the provider rather than inferred from who drove it.';
