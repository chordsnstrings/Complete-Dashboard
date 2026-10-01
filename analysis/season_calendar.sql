-- ============================================================================
-- Dubai ride-hailing DEMAND-SEASONALITY CALENDAR
-- Window: 2025-09-01 .. 2026-08-27  (361 days, fully covered, no gaps)
-- expected_effect starts with a demand multiplier token "xN.NN" vs a NORMAL
-- (pre-war) Dubai average day, then an airport token "apt xN.NN".
-- ============================================================================

DROP TABLE IF EXISTS season_calendar;

CREATE TABLE season_calendar AS
WITH days AS (
    SELECT generate_series(DATE '2025-09-01', DATE '2026-08-27', INTERVAL '1 day')::date AS day
),

-- ---------------------------------------------------------------- BASE LAYER
-- Non-overlapping, exhaustive. One row per day comes from exactly one of these.
season_ranges (d0, d1, season, season_effect) AS (VALUES
 (DATE '2025-09-01', DATE '2025-09-14', 'shoulder_late_summer',  'x0.86 apt x0.85 | tail of the heat trough; residents still on summer leave; inbound leisure near annual low'),
 (DATE '2025-09-15', DATE '2025-09-30', 'shoulder_late_summer',  'x0.92 apt x0.95 | return wave complete, schools in session, humidity still peak; demand climbing week on week'),
 (DATE '2025-10-01', DATE '2025-10-19', 'shoulder_autumn',       'x0.96 apt x1.00 | MICE season opens, weather still hot; corporate travel back'),
 (DATE '2025-10-20', DATE '2025-10-31', 'shoulder_autumn',       'x1.02 apt x1.05 | first comfortable outdoor evenings; beach/terrace demand switches on'),
 (DATE '2025-11-01', DATE '2025-11-30', 'high_season_ramp',      'x1.12 apt x1.15 | high season proper begins; heavy events month; hotel occupancy 80%+'),
 (DATE '2025-12-01', DATE '2025-12-31', 'high_season_peak',      'x1.30 apt x1.35 | strongest month of the year: National Day, DSF, winter break, Christmas, NYE'),
 (DATE '2026-01-01', DATE '2026-01-11', 'high_season_peak',      'x1.26 apt x1.30 | New Year + DSF run-out; peak inbound leisure'),
 (DATE '2026-01-12', DATE '2026-01-31', 'high_season',           'x1.14 apt x1.15 | post-DSF but still peak weather + trade-fair season'),
 (DATE '2026-02-01', DATE '2026-02-17', 'high_season',           'x1.16 apt x1.15 | last clean high-season block before Ramadan and before the war'),
 (DATE '2026-02-18', DATE '2026-02-27', 'ramadan_prewar',        'x0.98 apt x1.05 | DAILY TOTAL roughly flat but INTRA-DAY SHAPE INVERTED (see ramadan_* events)'),
 (DATE '2026-02-28', DATE '2026-03-19', 'ramadan_wartime',       'x0.72 apt x0.30 | Ramadan overlaid with war onset; airport collapses, intra-city holds up far better'),
 (DATE '2026-03-20', DATE '2026-03-22', 'eid_al_fitr',           'x0.78 apt x0.25 | Eid under wartime conditions: local leisure partially returns, airport still shut down'),
 (DATE '2026-03-23', DATE '2026-04-19', 'war_trough',            'x0.62 apt x0.20 | deepest point of the window; schools remote, expat exodus, tourism near zero'),
 (DATE '2026-04-20', DATE '2026-05-03', 'war_recovery_1',        'x0.72 apt x0.35 | schools reopen in person 20 Apr; ceasefire holding; airspace still restricted'),
 (DATE '2026-05-04', DATE '2026-05-10', 'war_relapse',           'x0.66 apt x0.40 | renewed strikes; schools back to remote 5-8 May; second, shallower dip'),
 (DATE '2026-05-11', DATE '2026-05-25', 'war_recovery_2',        'x0.78 apt x0.55 | airspace fully restored, airlines re-adding capacity week by week'),
 (DATE '2026-05-26', DATE '2026-05-31', 'eid_al_adha',           'x0.80 apt x0.70 | 4-day public holiday + weekend = 6-day break; first normal-ish holiday since Feb'),
 (DATE '2026-06-01', DATE '2026-06-30', 'summer_onset',          'x0.76 apt x0.62 | heat ramping, tourism still war-depressed, recovery continuing (DXB 5.0m pax in June)'),
 (DATE '2026-07-01', DATE '2026-07-15', 'summer_trough',         'x0.72 apt x0.75 | peak RESIDENT OUTBOUND wave: airport departures spike while intra-city empties out'),
 (DATE '2026-07-16', DATE '2026-08-15', 'summer_trough_deep',    'x0.64 apt x0.55 | hottest, emptiest stretch of the year; 42-48C; population at its annual minimum'),
 (DATE '2026-08-16', DATE '2026-08-27', 'summer_trough_end',     'x0.70 apt x0.80 | resident RETURN wave for the 31 Aug school start; airport inbound rebuilding')
),

-- ------------------------------------------------------------ OVERLAY LAYER
-- Overlapping allowed. Zero or many per day.
event_ranges (d0, d1, event, event_effect) AS (VALUES

 -- ---- public holidays -----------------------------------------------------
 (DATE '2025-09-05', DATE '2025-09-05', 'Prophet Muhammad birthday (public holiday, Fri)', 'x1.05 | commute peaks absent, leisure/late-night up; mosque cluster 11:30-13:30'),
 (DATE '2025-11-30', DATE '2025-11-30', 'Commemoration Day (observed, not a separate paid day off)', 'x1.00 | no material demand effect'),
 (DATE '2025-12-02', DATE '2025-12-03', 'Eid Al Etihad / UAE National Day 54 (public holiday Tue-Wed)', 'x1.22 apt x1.15 | commute -60%, leisure +30%; parades/fireworks; heavy intercity to Abu Dhabi and RAK'),
 (DATE '2025-11-29', DATE '2025-12-01', 'National Day long-weekend bridge (Sat-Mon)', 'x1.10 apt x1.25 | many take Mon 1 Dec off; outbound airport surge Fri/Sat, return Wed/Thu'),
 (DATE '2026-01-01', DATE '2026-01-01', 'New Years Day (public holiday, Thu)', 'x1.20 | latest-ending night of the year: 01:00-05:00 block is the annual maximum'),
 (DATE '2026-03-19', DATE '2026-03-22', 'Eid Al Fitr public holiday (Thu-Sun; Eid itself 20-22 Mar)', 'x1.15 rel. to wartime base | leisure/family/mall trips, late nights; commute ~0'),
 (DATE '2026-05-26', DATE '2026-05-26', 'Arafat Day (public holiday, Tue)', 'x1.05 | quiet daytime, strong evening'),
 (DATE '2026-05-27', DATE '2026-05-29', 'Eid Al Adha (public holiday Wed-Fri)', 'x1.18 apt x1.30 | 6-day break with the weekend; big outbound 22-26 May, return 30 May-1 Jun'),
 (DATE '2026-06-17', DATE '2026-06-17', 'Islamic New Year 1448 (ESTIMATE - confirm)', 'x1.05 | single-day holiday, mild leisure uplift'),

 -- ---- Ramadan intra-day inversion (the single biggest pattern distorter) ---
 (DATE '2026-02-18', DATE '2026-03-19', 'RAMADAN 1447 (confirmed start Wed 18 Feb, ran full 30 days)', 'x0.98 daily TOTAL | INTRA-DAY INVERSION - do not compare hour-weighted driver metrics across this boundary'),
 (DATE '2026-02-18', DATE '2026-03-19', 'ramadan_iftar_collapse (approx 18:05-19:15, sunset drifts 18:12->18:35)', 'x0.10-x0.30 for that hour | near-total demand vacuum; an online hour here is worth ~1/5 of a normal one'),
 (DATE '2026-02-18', DATE '2026-03-19', 'ramadan_pre_iftar_rush (approx 15:30-18:05)', 'x1.40-x1.80 | everyone racing home/to iftar; worst congestion of the day; short trips, high cancel risk'),
 (DATE '2026-02-18', DATE '2026-03-19', 'ramadan_early_office_release (approx 13:30-15:30)', 'x1.50 | reduced hours: govt out 14:30, private sector on 6-hour days; a NEW weekday peak that does not exist any other month'),
 (DATE '2026-02-18', DATE '2026-03-19', 'ramadan_late_night_surge (approx 21:00-03:00)', 'x1.60-x2.50 | taraweeh, Ramadan markets, malls to 01:00-02:00, suhoor gatherings; the money hours move to the middle of the night'),
 (DATE '2026-02-18', DATE '2026-03-19', 'ramadan_suhoor_micro_peak (approx 03:30-05:00)', 'x1.30 | small but real; then a dead zone 05:30-09:00'),
 (DATE '2026-02-18', DATE '2026-03-19', 'ramadan_morning_flattening (approx 06:00-09:00)', 'x0.60 | commute starts later and is spread out; classic morning peak largely disappears'),

 -- ---- WAR / GEOPOLITICAL SHOCK (2026 Iran war) ----------------------------
 (DATE '2026-02-28', DATE '2026-05-02', 'WAR: UAE airspace restrictions in force (28 Feb - 2 May)', 'apt x0.15-x0.45 | AIRPORT-SPECIFIC collapse; intra-city trips fall far less. Detect via airport_share, do not hard-code'),
 (DATE '2026-02-28', DATE '2026-02-28', 'WAR onset: US/Israel strike Iran; Gulf airspace closed; all Dubai flights suspended; first Iranian strikes on UAE (Al Dhafra ~12:53)', 'apt x0.05 | airport trips go to near zero within hours; brief intra-city spike then sharp fall'),
 (DATE '2026-03-01', DATE '2026-03-01', 'WAR: DXB struck ~00:30 (5 staff injured); Jebel Ali Port fire', 'apt x0.05 | DXB and Jebel Ali zones effectively closed to ride-hailing'),
 (DATE '2026-03-02', DATE '2026-04-19', 'WAR: all UAE schools/nurseries/universities on remote learning', 'x0.90 | school-run micro-peaks (07:00-08:00, 12:30-14:00) VANISH - a clean, detectable signature'),
 (DATE '2026-03-07', DATE '2026-03-13', 'WAR: escalation cluster (Dubai fatality in Al Barsha, Creek Harbour tower fire, Ruwais refinery fire, brief DXB closures)', 'x0.85 apt x0.15 | multi-day suppression; night-time trips fall hardest'),
 (DATE '2026-03-16', DATE '2026-03-17', 'WAR: DXB fuel-tank fire (16 Mar) then full ~2h UAE airspace closure and missile debris on Palm Jumeirah (17 Mar)', 'apt x0.05 | worst two days for airport work in the window; Palm/Atlantis zone avoided'),
 (DATE '2026-02-28', DATE '2026-03-27', 'WAR: expat exodus (40,000+ departures in 28 days; 37,000+ flights cancelled)', 'ASYMMETRY | airport DROP-OFFS >> PICK-UPS (ratio 1.5-3.0 vs normal ~1.05). Strongest single detector of an evacuation'),
 (DATE '2026-04-08', DATE '2026-04-08', 'WAR: ceasefire violation (17 ballistic missiles / 35 UAVs intercepted; Fujairah terminal hit)', 'x0.92 | one-day dip, mostly evening'),
 (DATE '2026-05-02', DATE '2026-05-02', 'WAR: UAE lifts all air traffic restrictions; airspace returns to normal', 'apt x1.60 step-up | inflection point - airport pick-ups rebound BEFORE drop-offs (return/repatriation)'),
 (DATE '2026-05-04', DATE '2026-05-08', 'WAR: renewed Iranian attack (Fujairah, 4 May), US strikes on Iran (7 May), schools back to remote 5-8 May', 'x0.90 apt x0.75 | second, shallower shock; school-run peaks vanish again for four days'),
 (DATE '2026-07-28', DATE '2026-08-27', 'Recovery: Dubai USD 800 traveller incentive scheme (launched 28 Jul, runs to end Oct)', 'apt x1.05 | mild inbound stimulus late in the window; too small to see in daily noise'),

 -- ---- schools -------------------------------------------------------------
 (DATE '2025-10-13', DATE '2025-10-19', 'School mid-term break 1', 'x0.97 | school runs gone; family leisure and short-haul outbound up'),
 (DATE '2025-12-08', DATE '2026-01-04', 'School winter break (4 weeks)', 'x1.05 apt x1.30 | resident outbound wave 8-20 Dec, inbound return 1-4 Jan; no school runs at all'),
 (DATE '2026-02-11', DATE '2026-02-15', 'School mid-term break 2', 'x0.98 | as above'),
 (DATE '2026-03-16', DATE '2026-03-29', 'School spring break (overlapped by remote learning and the war)', 'x0.98 | little marginal effect this year - schools were already remote'),
 (DATE '2026-05-25', DATE '2026-05-31', 'School mid-term break 3 (aligned to Eid Al Adha)', 'x1.02 | reinforces the Eid break'),
 (DATE '2026-07-04', DATE '2026-08-27', 'School SUMMER break (term ended 3 Jul; AY 2026-27 starts 31 Aug)', 'x0.90 apt x1.15 early / x0.85 mid | the long resident exodus; also cuts DRIVER supply as drivers take annual leave'),
 (DATE '2026-08-24', DATE '2026-08-27', 'Teachers return (24 Aug); families back before 31 Aug start', 'apt x1.20 | inbound return wave concentrated in the last 10 days of August'),

 -- ---- big demand events ---------------------------------------------------
 (DATE '2025-09-09', DATE '2025-09-28', 'DP World Asia Cup 2025 (11 matches at Dubai Intl Cricket Stadium, Sports City; 18 of 19 games start 18:30)', 'x1.04 citywide on match days | Sports City/Motor City +200-400% 21:30-01:00; strong DXB inbound from the subcontinent'),
 (DATE '2025-09-14', DATE '2025-09-14', 'Asia Cup: India v Pakistan, Dubai', 'x1.08 citywide | single biggest sport night of the autumn; gridlock on Al Qudra / Hessa St'),
 (DATE '2025-09-21', DATE '2025-09-21', 'Asia Cup: India v Pakistan (Super Fours), Dubai', 'x1.07 | as above'),
 (DATE '2025-09-28', DATE '2025-09-28', 'Asia Cup FINAL, Dubai Intl Cricket Stadium', 'x1.08 | as above'),
 (DATE '2025-10-13', DATE '2025-10-17', 'GITEX GLOBAL 2025 + Expand North Star (DWTC; ~180k visitors)', 'x1.10 citywide weekdays | DWTC/Zabeel/Sheikh Zayed Rd +30-50% at 08:00-10:00 and 17:00-19:00; Deira/Bur Dubai/Business Bay hotel corridor; DXB T3 arrivals 11-13 Oct, departures 17-19 Oct'),
 (DATE '2025-11-01', DATE '2025-11-30', 'Dubai Fitness Challenge 30x30', 'x0.99 | mildly NEGATIVE on sub-2km trips (people walk/cycle); Dubai Run/Dubai Ride Sundays close Sheikh Zayed Rd'),
 (DATE '2025-11-07', DATE '2026-03-28', 'Dubai Racing Carnival at Meydan (17 Friday meetings)', 'x1.02 on Fridays | Meydan/Nad Al Sheba cluster 15:00-23:00 Fri'),
 (DATE '2025-11-17', DATE '2025-11-21', 'DUBAI AIRSHOW 2025 (DWC / Al Maktoum Intl) - biennial, ODD years only; there is NO airshow in 2026', 'x1.07 citywide | very long, high-fare trips Downtown/Marina hotels <-> DWC (45-60 min); Dubai South and Expo City saturated 07:00-09:00 and 16:00-18:00'),
 (DATE '2025-11-28', DATE '2025-11-30', 'Emirates Dubai Rugby 7s (The Sevens Stadium, Dubai-Al Ain Rd)', 'x1.14 Fri-Sun evenings | venue has NO metro: ride-hailing dominant; huge outbound surge 22:00-02:00; highest surge multiples of November'),
 (DATE '2025-12-05', DATE '2025-12-07', 'Abu Dhabi Grand Prix (Yas Marina) - F1 season finale', 'x1.05 | very long intercity Dubai<->Yas fares; Dubai nightlife slightly thinner Sat night, rebounds Sun'),
 (DATE '2025-12-05', DATE '2026-01-11', 'DUBAI SHOPPING FESTIVAL, 31st edition (38 days)', 'x1.12 | mall trips +15-25% (Dubai Mall, MoE, Deira City Centre, Global Village); nightly drone shows/fireworks at Bluewaters, JBR, The Beach, Al Seef, Festival City'),
 (DATE '2025-12-24', DATE '2025-12-26', 'Christmas Eve / Christmas / Boxing Day', 'x1.15 | brunch and hotel-restaurant clusters; Fri 26 Dec is the strongest of the three'),
 (DATE '2025-12-27', DATE '2025-12-30', 'NYE inbound arrival wave', 'apt x1.45 | DXB arrival banks saturated; hotel-district drop-offs'),
 (DATE '2025-12-31', DATE '2025-12-31', 'NEW YEARS EVE - 2.7m people out citywide, ~800k around Burj Khalifa, 48 firework displays at 40 locations', 'x1.70 evening, x2.20 at 00:30-04:00 | THE single highest-earning night of the year. Downtown road closures from 16:00; Burj Khalifa/Dubai Mall metro station shut ~17:00; pickups displaced to Business Bay / DIFC / Al Wasl perimeter'),
 (DATE '2026-01-03', DATE '2026-01-03', 'Dense fog: 21 DXB + 2 DWC inbound flights diverted; red/yellow fog warnings 00:00-10:00', 'apt x0.55 in the 04:00-10:00 bank, then a catch-up spike 11:00-15:00 | classic fog signature'),
 (DATE '2025-11-15', DATE '2026-03-15', 'FOG SEASON (peak Dec-Feb): recurring 03:00-09:00 low-visibility events', 'apt x0.70-x0.95 on affected mornings | arrivals diverted to AUH/Al Ain/SHJ; DXB pickup queue dries up then floods'),
 (DATE '2026-01-26', DATE '2026-01-30', 'Gulfood 2026 (31st ed., DUAL VENUE: DWTC + Dubai Exhibition Centre, Expo City)', 'x1.07 | demand SPLITS between Zabeel and Dubai South - do not assume DWTC-only geography'),
 (DATE '2026-02-03', DATE '2026-02-05', 'World Governments Summit 2026 (Madinat Jumeirah; 60+ heads of state, 6,250+ delegates)', 'x1.06 | heavy road closures/motorcade restrictions on Al Sufouh, Umm Suqeim and Jumeirah Rd; long detours inflate trip duration without inflating fares'),
 (DATE '2026-02-09', DATE '2026-02-12', 'WHX Dubai 2026 (formerly Arab Health), Dubai Exhibition Centre / Expo City', 'x1.05 | Dubai South corridor; long airport<->Expo City fares'),
 (DATE '2026-02-28', DATE '2026-02-28', 'Emirates Super Saturday, Meydan (Dubai World Cup prep)', 'x1.02 | swamped by the war onset the same day - a good example of an event signal being destroyed by a shock'),
 (DATE '2026-03-23', DATE '2026-03-27', 'HEAVY RAIN / URBAN FLOODING (>100mm in parts of the UAE; roads flooded 27 Mar; flight disruption)', 'x1.10 requests but x0.75 COMPLETED trips | speeds collapse, cancellations spike, trip duration per km jumps 40-80%. Opposite fingerprint to a geopolitical shock'),
 (DATE '2026-03-28', DATE '2026-03-28', 'DUBAI WORLD CUP, 30th edition, Meydan - went ahead despite the war', 'x1.05 vs wartime base | attendance far below a normal year; Meydan/Nad Al Sheba 15:00-23:00'),
 (DATE '2026-04-15', DATE '2026-04-19', 'Art Dubai ORIGINAL April dates - CANCELLED / POSTPONED (announced Mar 2026)', 'x1.00 - NO uplift | trap for any calendar copied from a prior year'),
 (DATE '2026-05-14', DATE '2026-05-17', 'Art Dubai 2026 (rescheduled, adapted format, Madinat Jumeirah)', 'x1.02 | far smaller than a normal edition'),
 (DATE '2026-07-02', DATE '2026-08-27', 'Dubai Summer Surprises 2026 (2 Jul - 30 Aug)', 'x1.04 | pushes trips indoors and late: mall and hotel-staycation traffic, 20:00-01:00 skew'),
 (DATE '2026-07-01', DATE '2026-07-15', 'Peak summer outbound: DXB expects ~3m guests in the first half of July, >200k/day, busiest 12 Jul (>225k)', 'apt x1.35 | airport DEPARTURES surge while the rest of the city empties - airport share of trips hits its annual maximum'),
 (DATE '2026-06-15', DATE '2026-08-27', 'EXTREME HEAT (42-48C, apparent temp 55C+, humidity peaks in Aug)', 'x1.08 on trips under 2km | walking converts to riding: trips/hour can RISE while AED/hour FALLS. Never read trip count as productivity here')
)

SELECT
    d.day,
    s.season,
    NULLIF(string_agg(DISTINCT e.event, '  ||  ' ORDER BY e.event), '')                        AS event,
    s.season_effect
      || COALESCE('  ||  ' || string_agg(DISTINCT e.event_effect, '  ||  ' ORDER BY e.event_effect), '') AS expected_effect
FROM days d
JOIN season_ranges s  ON d.day BETWEEN s.d0 AND s.d1
LEFT JOIN event_ranges e ON d.day BETWEEN e.d0 AND e.d1
GROUP BY d.day, s.season, s.season_effect
ORDER BY d.day;

ALTER TABLE season_calendar ADD PRIMARY KEY (day);
