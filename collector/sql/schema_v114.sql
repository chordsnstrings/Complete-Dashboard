-- v114: two guards on charging_link that schema_v113 (already applied on
-- production, 2026-11-03) did not have. Found by the second independent
-- review of the PowerDrive build, the same day.
--
-- 1. 'held' — a tier the collector never deletes or recomputes. When two
--    person records fold into one and a person had CONFIRMED a customer for
--    one record and REFUSED it for the other, src/charging_links.js wrote the
--    pair back as 'candidate' — a machine tier, which the next run deleted
--    and recomputed: into an automatic link when the mobile then matched
--    uniquely (the very "refusal becomes a link" defect the fold-follow was
--    written to remove), or into nothing at all, after which the customer's
--    sessions and the decision were gone. A 'held' pair stays until a person
--    decides it; it is never linked automatically, it is offered for review
--    every run, and its customer stays watched.
--
-- 2. One confirmation per customer. POST /api/charging/link checked for an
--    existing confirmation and then inserted: two confirmations of the same
--    customer as different people, sent at once, both landed. The partial
--    unique index makes the second one fail (23505), which the route answers
--    with 409.
ALTER TABLE charging_link DROP CONSTRAINT IF EXISTS charging_link_tier_check;
ALTER TABLE charging_link ADD CONSTRAINT charging_link_tier_check
  CHECK (tier IN ('auto', 'candidate', 'confirmed', 'refused', 'held'));
CREATE UNIQUE INDEX IF NOT EXISTS charging_link_one_confirmed ON charging_link (yc_user_id) WHERE tier = 'confirmed';
