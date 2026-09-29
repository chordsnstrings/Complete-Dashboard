-- v92 — Yango's console weeks restated to net, and their distance filled in
-- (the operator, 2026-09-29: "yes correct them").
--
-- Every console row in driver_performance (112 driver-weeks from 2026-05-11)
-- holds the GROSS in `earnings` — price_cash + price_cashless, AED 18,229 —
-- because the rows were stored before the collector's net fix and the console
-- never answered again to restate them. The column is defined as net: what the
-- riders paid plus the platform's (negative) commission, and the rebuilt weeks
-- from 2026-09-07 are net. Left alone, Yango's line would step down by the
-- commission (AED 4,053.09 over the period) at the first rebuilt week, which
-- is a change of definition, not of business.
--
-- The net is recomputed from each row's own raw figures, and only where the
-- stored figure is still exactly the gross — so replaying this is a no-op, a
-- row the console restates itself is left as it wrote it, a rebuilt row
-- (raw.rebuilt_from) is never touched, and a figure that is not a number in
-- raw is never cast.
UPDATE driver_performance
   SET earnings = round((raw->>'price_cash')::numeric + (raw->>'price_cashless')::numeric
                        + (raw->>'price_platform_commission')::numeric, 2)
 WHERE platform = 'yango'
   AND NOT coalesce(raw ? 'rebuilt_from', false)
   AND jsonb_typeof(raw->'price_cash') = 'number'
   AND jsonb_typeof(raw->'price_cashless') = 'number'
   AND jsonb_typeof(raw->'price_platform_commission') = 'number'
   AND (raw->>'price_platform_commission')::numeric <> 0
   AND abs(earnings - ((raw->>'price_cash')::numeric + (raw->>'price_cashless')::numeric)) < 0.005;

-- distance_km was NULL on every console row: Yango sends `distance`, in
-- metres, and the mapper read `sum_distance` (fixed in src/sources/yango.js).
UPDATE driver_performance
   SET distance_km = (raw->>'distance')::numeric / 1000
 WHERE platform = 'yango' AND distance_km IS NULL
   AND NOT coalesce(raw ? 'rebuilt_from', false)
   AND jsonb_typeof(raw->'distance') = 'number';
