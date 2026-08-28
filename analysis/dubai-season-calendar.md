## Dubai Ride‑Hailing Demand‑Seasonality Calendar — 1 Sep 2025 → 27 Aug 2026

**Ready-to-run SQL:** `analysis/season_calendar.sql` (validated against PostgreSQL 16 — produces exactly 361 rows, one per day, no gaps, `day` as PK). Full text reproduced in §10.

---

## 0. Read this before anything else

**This window is not a normal Dubai year, and no calendar built from prior years will fit it.** On **28 February 2026** the US and Israel struck Iran; Iran struck the UAE the same day. UAE airspace restrictions ran **28 Feb → 2 May 2026**. The consequences for your data:

| Metric | Normal | This window |
|---|---|---|
| DXB passengers, March 2026 | ~7.5m | **2.5m (−65.7% YoY)** |
| DXB passengers, Q1 2026 | ~23m | 18.6m (−20.6%) |
| DXB, H1 2026 | ~46m | **31.5m (−31.3%)** |
| DXB monthly recovery | — | Apr 3.5m → May 4.5m → Jun 5.0m |
| Dubai hotel occupancy, March 2026 | ~87% | **33.1% (−54.4pp YoY)** |
| Dubai hotel occupancy, H1 2026 | ~80% | 56.4% (−30.3%) |
| Expat departures | — | **40,000+ in 28 days**; ~30,000 Britons alone |

So the window splits cleanly into **a normal, very strong high season (Sep 2025 – 27 Feb 2026)** and **a structurally broken period (28 Feb – 27 Aug 2026)**. Consistency scoring that spans that boundary without controls will rank drivers by *when they happened to be driving*, not by how they drove.

Two more things that matter more than any single date:

1. **Ramadan does not change daily volume much — it inverts the intra-day shape.** Total trips are roughly flat (±5%). But the hour-of-day distribution is unrecognisable. Any driver metric weighted by online *hours* breaks completely across 18 Feb → 19 Mar 2026.
2. **A geopolitical shock is airport-specific.** Intra-city trips held up far better than airport trips during the war. That asymmetry is the fingerprint, and it is what lets you detect shocks from the data instead of hard-coding them (§7.3).

---

## 1. Confidence register — what is firm, what is my estimate

**FIRM (officially announced / reported; safe to hard-code):**

| Item | Date | Source authority |
|---|---|---|
| Ramadan 1447 first day | **Wed 18 Feb 2026** | UAE Moon Sighting Committee, confirmed 17 Feb |
| Ramadan length | **30 days** (crescent not sighted 18 Mar) | UAE Council for Fatwa |
| Eid al‑Fitr (religious) | **Fri 20 – Sun 22 Mar 2026** | UAE Council for Fatwa |
| Eid al‑Fitr public holiday | **Thu 19 – Sun 22 Mar 2026** | FAHR / MoHRE |
| Arafat Day | **Tue 26 May 2026** | UAE Cabinet |
| Eid al‑Adha public holiday | **Wed 27 – Fri 29 May 2026** (6-day break with weekend) | UAE Cabinet |
| Eid Al Etihad / National Day 54 | **Tue 2 – Wed 3 Dec 2025** | Federal holiday law |
| Prophet's Birthday | **Fri 5 Sep 2025** (next: Fri 28 Aug 2026, one day *outside* window) | UAE Cabinet |
| School year 2025/26 | Term 1 25 Aug – 7 Dec 2025; Term 2 5 Jan – 15 Mar 2026; Term 3 30 Mar – 3 Jul 2026 | MoE |
| Winter break | **8 Dec 2025 – 4 Jan 2026** (4 weeks) | MoE |
| Spring break | **16 – 29 Mar 2026** | MoE |
| Mid-term breaks | 13–19 Oct 2025; 11–15 Feb 2026; 25–31 May 2026 | MoE |
| Summer break | **4 Jul – 30 Aug 2026** (AY 26/27 starts Mon 31 Aug; teachers 24 Aug) | MoE |
| Dubai Shopping Festival 31 | **5 Dec 2025 – 11 Jan 2026** (38 days) | Dubai DET |
| GITEX Global 2025 | **13 – 17 Oct 2025**, DWTC | DWTC |
| Dubai Airshow 2025 | **17 – 21 Nov 2025**, DWC — **biennial, odd years. NO airshow in 2026.** | Organiser |
| Gulfood 2026 | **26 – 30 Jan 2026**, DWTC **+ Dubai Exhibition Centre, Expo City** | Organiser |
| WHX Dubai (ex-Arab Health) 2026 | **9 – 12 Feb 2026**, Dubai Exhibition Centre | Informa |
| World Governments Summit 2026 | **3 – 5 Feb 2026**, Madinat Jumeirah | WGS |
| Dubai World Cup, 30th | **Sat 28 Mar 2026**, Meydan (went ahead despite the war) | Dubai Racing Club |
| Dubai Rugby 7s | **28 – 30 Nov 2025** | Organiser |
| DP World Asia Cup (cricket) | **9 – 28 Sep 2025**, Dubai + Abu Dhabi | ACC |
| Abu Dhabi GP (F1 finale) | **5 – 7 Dec 2025**, Yas Marina | F1 |
| Dubai Fitness Challenge 30x30 | **1 – 30 Nov 2025** | Dubai Sports Council |
| Dubai Summer Surprises 2026 | **2 Jul – 30 Aug 2026** | Dubai DET |
| War onset | **28 Feb 2026** | Multiple |
| UAE airspace fully restored | **2 May 2026**; DXB near-full ops 4 May | GCAA / Dubai Airports |
| Schools on remote learning | **2 Mar – 19 Apr 2026**, and again **5 – 8 May 2026** | MoE |
| Art Dubai | April dates **cancelled**; held **14 – 17 May 2026** | Art Dubai |
| Fog event | **3 Jan 2026** — 21 DXB + 2 DWC diversions | Dubai Airports / NCM |
| Rain/flood | **23 – 27 Mar 2026**, >100 mm, roads flooded 27 Mar | NCM |

**ESTIMATES — confirm before relying on them:**

- **Islamic New Year 1448 holiday: ~17 June 2026.** I could not verify the observed UAE date. Your own data will show it: a single mid-June weekday with a holiday-shaped profile (no morning commute peak, elevated evening).
- **Dubai Marathon 2026** — typically January, date unverified. Look for a Sunday morning with Jumeirah/Umm Suqeim road closures and a 05:00–10:00 anomaly.
- **All demand multipliers** in this document and in the SQL are informed estimates, *not* measurements from your data. Treat them as priors and fit the real ones (§9).
- **The DXB flight-bank hours** I cite (§8) are approximate. Derive them from your own airport pickup timestamps.
- **Fog days beyond 3 Jan 2026 and 18–19 Dec 2025.** Fog season is real and recurring (Nov–Mar, peak Dec–Feb) but individual mornings are stochastic. Detect, don't schedule (§6.2).
- **The day-by-day intensity of the war period.** I have anchored the named incidents; the interpolation between them is my judgement.

---

## 2. Tourism season structure

Dubai's underlying tourism curve, and what the war did to it.

### 2.1 High season: 1 Nov 2025 – 17 Feb 2026 (undisturbed, the good part)

Dubai took **19.59 million international visitors in 2025 — a record**, and this window contains that record's peak months.

| Block | Index* | Notes |
|---|---|---|
| 1–30 Nov 2025 | **×1.12** | Season opens; weather turns; MICE-heavy month |
| 1–31 Dec 2025 | **×1.30** | Strongest month of the year, full stop |
| 1–11 Jan 2026 | **×1.26** | NY + DSF run-out |
| 12 Jan – 17 Feb 2026 | **×1.14–1.16** | Peak weather, trade-fair season |

\* Index = expected daily city-wide trips vs. a normal Dubai average day (1.00).

**Hits hardest:** Downtown/Burj Khalifa, Dubai Marina/JBR/Bluewaters, Palm Jumeirah, DXB T1/T3, Deira & Bur Dubai mid-market hotel corridor, Business Bay.

### 2.2 Shoulder months

- **1–14 Sep 2025 (×0.86):** tail of the heat trough. Residents still on summer leave, inbound leisure near annual low. Schools resumed 25 Aug so the school-run peaks are back, but little else is.
- **15–30 Sep 2025 (×0.92):** return wave complete; humidity still at peak; demand climbing week over week.
- **1–19 Oct 2025 (×0.96):** MICE opens, weather still hot.
- **20–31 Oct 2025 (×1.02):** first comfortable outdoor evenings — beach, terrace and Marina walk demand switches on. This is a real step change, not a gradient.

### 2.3 The Jun–Aug heat trough

Normally ~×0.82. **This year ~×0.64–0.76**, because the normal trough is stacked on top of war-suppressed inbound.

| Block | Index | Character |
|---|---|---|
| 1–30 Jun 2026 | ×0.76 | Heat ramping, tourism still war-depressed, DXB recovering (5.0m pax) |
| 1–15 Jul 2026 | ×0.72 | **Peak resident OUTBOUND wave.** DXB expected ~3m in the fortnight, >200k/day, busiest 12 Jul (>225k) |
| 16 Jul – 15 Aug 2026 | ×0.64 | Hottest, emptiest stretch of the year. 42–48 °C, apparent temp 55 °C+ |
| 16–27 Aug 2026 | ×0.70 | Return wave for the 31 Aug school start |

**Critical for driver analysis:** in July–August, **trips per hour can RISE while AED per hour FALLS.** Extreme heat converts walking trips (500 m – 2 km) into rides. Short, cheap, high-frequency. A driver who looks more "productive" in August by trip count may be earning less. Never use raw trip count as the productivity metric across the summer boundary.

**Supply side:** driver availability also drops in summer — annual leave, home visits. Utilisation per online hour can therefore hold up better than total demand would suggest.

---

## 3. Ramadan 2026, Eid al‑Fitr, Eid al‑Adha

### 3.1 Ramadan 1447: Wed 18 Feb – Thu 19 Mar 2026 (30 days, confirmed)

**Total daily trips: roughly flat, ×0.95–1.00. The intra-day shape is the story.**

Two structural drivers: (a) fasting from Fajr to Maghrib, and (b) **legally mandated reduced working hours** — MoHRE cut the private-sector day by 2 hours to 6 hours (36-hour week); federal government ran 09:00–14:30 Mon–Thu and 09:00–12:00 Fri. That alone moves the entire weekday commute structure.

**The inversion, hour by hour** (sunset drifts 18:12 on 18 Feb → 18:35 on 19 Mar):

| Window | Multiplier vs. same hour in a normal week | What's happening |
|---|---|---|
| 03:30–05:00 | **×1.30** | Suhoor micro-peak — small but real |
| 05:30–09:00 | **×0.60** | Classic morning commute largely disappears; later, flatter start |
| 09:00–13:30 | ×0.85 | Muted |
| **13:30–15:30** | **×1.50** | **A NEW weekday peak that exists in no other month** — early office release |
| **15:30–18:05** | **×1.40–1.80** | Race home / to iftar. Worst congestion of the day. Short trips, high cancel risk, long ETAs |
| **18:05–19:15** | **×0.10–0.30** | **IFTAR COLLAPSE.** Near-total demand vacuum. Streets empty |
| 19:15–21:00 | ×1.10 | Recovery; taraweeh trips to mosques |
| **21:00–03:00** | **×1.60–2.50** | **THE MONEY HOURS MOVE TO THE MIDDLE OF THE NIGHT.** Ramadan markets, malls to 01:00–02:00, cafés, shisha, suhoor gatherings. Weekend nights are the extreme |

**Why this is the single biggest pattern-distorter for your analysis:**

- An online hour at 18:30 during Ramadan is worth roughly **one-fifth** of an online hour at 18:30 in January. A driver whose trips-per-online-hour "collapses" in late February may simply have kept his normal shift pattern.
- Conversely, a driver who "suddenly improves" in Ramadan may just have shifted to nights, where the market rate per hour is genuinely 2× higher.
- **Supply moves too.** Fasting drivers restructure entirely — off during the day, heavy at night. So both numerator and denominator of any utilisation metric shift, in the same direction, at the same time.
- **Geography shifts:** demand concentrates on mosques (short, low-fare, high-volume), Ramadan tents at hotels (Madinat Jumeirah, Downtown, Deira), Global Village, and the malls. Airport work is relatively *less* affected than the rest of the market — which is why during Ramadan 2026 the airport share metric was already anomalous *before* the war started on 28 Feb, and the two effects are confounded for three weeks.

**Practical rule: score Ramadan against a Ramadan-specific hourly baseline, or exclude 18 Feb – 22 Mar 2026 from consistency scoring entirely.** The latter is safer this year, because the war contaminates the same window.

### 3.2 Eid al‑Fitr: public holiday Thu 19 – Sun 22 Mar 2026; Eid itself Fri 20 – Sun 22

In a normal year this is a strong 4-day leisure block (×1.15–1.30) with a big outbound airport surge in the 2 days prior and a return surge on the last day. **In 2026 it fell inside the deepest phase of the war**, with airspace restricted and the 23–27 Mar flood arriving right behind it. Expect the Eid signal to be almost invisible against the war baseline. Do not use Eid 2026 to calibrate what Eid looks like.

### 3.3 Eid al‑Adha: Arafat Tue 26 May, Eid Wed 27 – Fri 29 May 2026

Four paid days + the weekend = **a 6-day break (26–31 May)**; many private-sector staff stretched it to 9. Falls just after the airspace reopened (2 May), so this is **the first near-normal holiday in the window** and the cleanest post-war demand reference point you have.

- **Outbound airport surge:** roughly 22–26 May.
- **Return surge:** 30 May – 1 Jun.
- Commute effectively zero for 6 days; intercity (Abu Dhabi, RAK, Fujairah, Oman border) elevated.
- Coincides with school mid-term break 3 (25–31 May), which reinforces it.

### 3.4 Other Islamic dates in-window

- **Prophet Muhammad's Birthday: Fri 5 Sep 2025** — single-day public holiday, ×1.05, mosque cluster 11:30–13:30.
- **Islamic New Year 1448: ~17 Jun 2026 (ESTIMATE)** — single-day holiday. Confirm.
- Next Prophet's Birthday, **Fri 28 Aug 2026**, is one day past your window end — but the pre-holiday behaviour lands on the evening of **27 Aug**, your last day. Flag that day as contaminated.

---

## 4. UAE school calendar 2025/26 — demand *and* driver supply

Schools drive two things you must control for: **school-run micro-peaks** (roughly 06:45–08:15 and 12:30–14:30 on term weekdays, concentrated in villa communities — Arabian Ranches, Mirdif, Jumeirah, Al Barsha, Springs/Meadows, Motor City) and **resident travel waves** at break boundaries.

| Period | Dates | Effect |
|---|---|---|
| Term 1 | 25 Aug – 7 Dec 2025 | Normal school peaks |
| **Mid-term break 1** | **13–19 Oct 2025** | ×0.97; school runs gone; overlaps GITEX exactly — the two partly cancel |
| **Winter break (4 weeks)** | **8 Dec 2025 – 4 Jan 2026** | ×1.05 overall, **airport ×1.30**. Outbound wave 8–20 Dec, inbound return 1–4 Jan. Schools resume 5 Jan |
| Term 2 | 5 Jan – 15 Mar 2026 | Normal, then destroyed by remote learning from 2 Mar |
| **Mid-term break 2** | **11–15 Feb 2026** | ×0.98 |
| **Spring break** | **16–29 Mar 2026** | ×0.98 — **almost no marginal effect this year**, schools were already remote since 2 Mar |
| Term 3 | 30 Mar – 3 Jul 2026 | Remote until 20 Apr; remote again 5–8 May |
| **Mid-term break 3** | **25–31 May 2026** | ×1.02; aligned to Eid al-Adha, reinforces it |
| **SUMMER BREAK** | **4 Jul – 30 Aug 2026** | ×0.85–0.90. The long resident exodus. Also **cuts driver supply** — drivers take annual leave and home visits in the same window |
| AY 2026/27 | Teachers 24 Aug; students **31 Aug 2026** | Return wave concentrated in the last 10 days of August |

**Remote-learning windows (war-driven, unique to this year):**
- **2 Mar – 19 Apr 2026** — all nurseries, schools and universities remote.
- **5 – 8 May 2026** — remote again after renewed strikes.
- **20 Apr 2026 onward** — in-person resumes, but **hybrid with parental opt-out**, so school-run amplitude was probably only 60–80% of normal for the rest of Term 3. Verify from your own data rather than assuming full restoration.

**Driver-supply note:** a large share of Dubai's ride-hailing drivers live in Sharjah and Ajman. Sharjah government has run a **4-day week (Fri–Sat–Sun off) since 2022**, and Sharjah private schools returned from spring break on **23 Mar**, a week earlier than the rest of the UAE. That desynchronises the Dubai–Sharjah commute corridor in ways that show up in driver start-of-shift timing.

---

## 5. Big demand events

### Autumn 2025
- **DP World Asia Cup, 9–28 Sep 2025** — 11 matches at Dubai International Cricket Stadium (Sports City); 18 of 19 games at 18:30. Citywide ×1.04 on match days, but **Sports City / Motor City +200–400% between 21:30 and 01:00**, gridlock on Al Qudra Rd and Hessa St. Peak nights: **India v Pakistan 14 Sep and 21 Sep, final 28 Sep (×1.07–1.08 citywide)**. Also a real DXB inbound bump from the subcontinent.
- **GITEX Global 2025 + Expand North Star, 13–17 Oct** — ~180,000 visitors, 6,000+ exhibitors. **Citywide ×1.10 on weekdays.** DWTC / Za'abeel / Sheikh Zayed Rd corridor +30–50% at 08:00–10:00 and 17:00–19:00. Hotel corridor: Deira, Bur Dubai, Business Bay. Airport: arrivals 11–13 Oct, departures 17–19 Oct.
- **Dubai Fitness Challenge 30x30, 1–30 Nov** — mildly **negative** on sub-2 km trips (people walk and cycle instead). Dubai Ride / Dubai Run Sundays close Sheikh Zayed Rd, producing a sharp localised anomaly.
- **Dubai Racing Carnival, 7 Nov 2025 – 28 Mar 2026** — 17 Friday meetings at Meydan. Friday ×1.02, Meydan/Nad Al Sheba cluster 15:00–23:00.
- **Dubai Airshow, 17–21 Nov 2025, DWC/Al Maktoum** — citywide ×1.07, but the geography is unusual: **very long, high-fare trips from Downtown and Marina hotels to DWC (45–60 min each way)**. Dubai South and Expo City saturated 07:00–09:00 and 16:00–18:00. **Biennial, odd years only — there is no airshow in 2026**, so do not expect a November 2026 analogue.
- **Emirates Dubai Rugby 7s, 28–30 Nov 2025, The Sevens Stadium (Dubai–Al Ain Rd)** — ×1.14 Fri–Sun evenings. **The venue has no metro**, so ride-hailing is dominant. Huge outbound surge 22:00–02:00; likely the highest surge multiples of November.

### December 2025 — the peak
- **Eid Al Etihad / National Day 54, 2–3 Dec (Tue–Wed).** ×1.22. Commute −60%, leisure +30%. Fireworks, parades, heavy intercity to Abu Dhabi and RAK. With Sat 29 – Sun 30 Nov and Mon 1 Dec taken off, this became a 5-day bridge for many; airport outbound surge 28–30 Nov, return 3–4 Dec. (Commemoration Day 30 Nov is observed but is not a separate paid day off.)
- **Abu Dhabi Grand Prix, 5–7 Dec, Yas Marina** — F1 season finale. Very long intercity Dubai↔Yas fares. Dubai's own Saturday nightlife runs slightly thin, rebounds Sunday.
- **Dubai Shopping Festival, 31st edition, 5 Dec 2025 – 11 Jan 2026 (38 days)** — ×1.12 sustained. Mall trips +15–25% (Dubai Mall, Mall of the Emirates, Deira City Centre, Global Village). Nightly drone shows and fireworks at **Bluewaters, JBR, The Beach, Al Seef, Festival City, Hatta** — each produces a localised 21:00–23:00 spike.
- **18–19 Dec** — unstable weather, thunderstorms, DXB delays and cancellations on 19 Dec.
- **Christmas, 24–26 Dec** — ×1.15, brunch and hotel-restaurant clusters. Fri 26 Dec strongest.
- **27–30 Dec** — NYE inbound arrival wave, airport ×1.45.
- **31 Dec — NEW YEAR'S EVE. The single highest-earning night of the year.** 2.7m people out across Dubai, ~800,000 around Burj Khalifa alone, 48 firework displays at 40 locations. Evening ×1.70, **00:30–04:00 ×2.20**. Operationally: Downtown road closures phase in **from 16:00**; Burj Khalifa/Dubai Mall metro station closed ~17:00; buses from Al Quoz, Oud Al Muteena and Jebel Ali suspended; metro ran 43 hours straight from 05:00 on 31 Dec. **Pickups are displaced outward to the Business Bay / DIFC / Al Wasl perimeter** — a driver's "Downtown" trips look strange that night for structural reasons.
- **1 Jan 2026 (Thu)** — New Year's Day holiday. The 01:00–05:00 block is the annual maximum.

### Jan–Feb 2026 (pre-war)
- **3 Jan — dense fog.** Red/yellow warnings 00:00–10:00; **21 DXB + 2 DWC inbound flights diverted**; delays of 1–2 hours across Emirates, flydubai, Air Arabia. Airport pickups ×0.55 in the 04:00–10:00 bank, then a catch-up spike 11:00–15:00.
- **Gulfood 2026, 26–30 Jan** — ×1.07. **Dual venue this year: DWTC *and* Dubai Exhibition Centre at Expo City.** Demand splits between Za'abeel and Dubai South — do not assume DWTC-only geography.
- **World Governments Summit 2026, 3–5 Feb, Madinat Jumeirah** — 60+ heads of state, 6,250+ delegates. ×1.06 citywide, but the real effect is **heavy road closures and motorcade restrictions on Al Sufouh, Umm Suqeim and Jumeirah Rd**, which inflate trip duration without inflating fares. Drivers working that corridor look inefficient for three days for reasons entirely outside their control.
- **WHX Dubai 2026 (formerly Arab Health), 9–12 Feb, Dubai Exhibition Centre / Expo City** — ×1.05, Dubai South corridor, long airport↔Expo City fares.
- **28 Feb — Emirates Super Saturday at Meydan.** Normally ×1.02. This year it collided with the war onset on the same day — a useful illustration of an event signal being annihilated by a shock.

### Spring–summer 2026 (wartime and after)
- **28 Mar — Dubai World Cup, 30th edition, Meydan.** Went ahead despite the war, with attendance far below a normal year. ×1.05 against the wartime base, not the ×1.25 a normal year would give. Meydan / Nad Al Sheba 15:00–23:00.
- **15–19 Apr — Art Dubai's original dates: CANCELLED.** **This is a trap.** Any calendar copied from a prior year will predict an uplift that did not happen.
- **14–17 May — Art Dubai, rescheduled, "adapted format", Madinat Jumeirah.** ×1.02, much smaller than a normal edition.
- **2 Jul – 30 Aug — Dubai Summer Surprises 2026.** ×1.04. Pushes trips indoors and late — malls, staycations, a 20:00–01:00 skew. Also indoor mall-running events (Mallathon; 9 Aug Dubai Outlet Mall, 23 Aug Palm Jumeirah Mall).
- **28 Jul — Dubai launches an ~$800 traveller incentive** (running through end October) to pull tourists back. Mild inbound stimulus, probably too small to see above daily noise.
- **Note on Q4 2026:** many organisers moved postponed events into Q4 2026. If your analysis extends past this window, expect an unusually dense autumn.

---

## 6. Weather-driven anomalies

### 6.1 Summer heat trough (mid-Jun → early Sep)
Highs 42–48 °C, apparent temperature 55 °C+, humidity peaking in August. Covered in §2.3. The key analytical point bears repeating: **short trips proliferate, so trip count rises relative to revenue.** Use fare-per-hour or distance-per-hour, not trips-per-hour, across this boundary.

### 6.2 Fog season (~15 Nov 2025 – 15 Mar 2026, peak Dec–Feb)
Radiation fog forms on the coastal strip when the diurnal temperature swing is large. Effects are concentrated **03:00–09:00** and hit **airport arrivals specifically**:
- Inbound flights divert to Abu Dhabi, Al Ain or Sharjah → the DXB pickup queue **dries up**, then floods 2–4 hours later as diverted passengers are bussed or re-flown in.
- Road visibility warnings slow the Sheikh Zayed Rd and Emirates Rd corridors; trip duration per km jumps.
- **Confirmed events in window:** 18–19 Dec 2025 (storms + fog, DXB cancellations); **3 Jan 2026 (23 diversions)**. Others certainly occurred — detect them (§7.3), don't schedule them.

### 6.3 Rain and flooding
- **18–19 Dec 2025** — heavy rain, thunderstorms, strong winds; DXB delays and cancellations across Emirates, flydubai, Turkish, Saudia, Kuwait, Qatar Airways.
- **23–27 Mar 2026 — the significant one.** Multi-day thunderstorms; several UAE stations over 100 mm; Jebel Yanas 244 mm (more than double typical annual rainfall). Roads under water on 27 Mar, stranded vehicles, transport and flight disruption. It landed **immediately after Eid al-Fitr and inside the war trough** — three overlapping causes in one week. Do not attribute that week to any single factor.

**Rain has an inverted fingerprint vs. a geopolitical shock, which is what makes it separable:**

| | Rain/flood | Geopolitical/airspace shock |
|---|---|---|
| Ride *requests* | **UP** (×1.10) | DOWN |
| *Completed* trips | DOWN (×0.75) | DOWN |
| Cancellation rate | **Spikes, rider-side** | Spikes, driver-side (going offline) |
| Mean speed | **Collapses** | **Rises** (empty roads) |
| Duration per km | **+40–80%** | Flat or down |
| Airport share of trips | Roughly unchanged | **Collapses** |

---

## 7. The regional conflict shock — and how to detect one from the data

### 7.1 What actually happened

| Date | Event | Ride-hailing consequence |
|---|---|---|
| **28 Feb 2026** | US/Israel strike Iran. Gulf states close airspace. **All flights at DXB and DWC suspended.** First Iranian strikes on UAE (~12:53, Al Dhafra AB; one civilian killed near Zayed Intl) | Airport trips → near zero within hours. Brief intra-city spike (people moving, supply runs) then a sharp fall |
| **1 Mar** | **DXB itself struck ~00:30**, five staff injured. Fire at Jebel Ali Port | DXB and Jebel Ali effectively closed to ride-hailing |
| **2 Mar** | All UAE schools/nurseries/universities → **remote learning** | **School-run micro-peaks vanish** — the cleanest detectable signature in the whole dataset |
| **2 Mar** | MoD: 161 ballistic missiles and 645 drones intercepted; 8 cruise missiles struck | — |
| **7–13 Mar** | Escalation cluster: fatality in **Al Barsha (Dubai)**, Dubai Creek Harbour tower fire, Ruwais refinery fire (922k bpd halted), brief DXB closures | Multi-day suppression; night trips fall hardest |
| **16 Mar** | **DXB fuel-tank fire** from a drone → flight suspensions | Worst airport days of the window |
| **17 Mar** | **Full UAE airspace closure (~2 hours)**; Iranian missiles and drones; **missile debris on Palm Jumeirah** | Palm/Atlantis zone avoided; airport ×0.05 |
| **28 Feb – 27 Mar** | **Expat exodus: 40,000+ departures in 28 days; 37,000+ flights cancelled** (23,000+ globally by 6 Mar) | **Airport drop-offs ≫ pickups.** The single strongest evacuation signature |
| **early Apr** | Ceasefire agreed | — |
| **8 Apr** | Ceasefire violation: 17 ballistic missiles / 35 UAVs intercepted; Fujairah terminal hit | One-day dip, mostly evening |
| **20 Apr** | **Schools reopen in person** (phased, hybrid, parental opt-out) | School-run peaks partially return |
| **2 May** | **UAE lifts all air-traffic restrictions.** Airspace normal | **Inflection point.** Airport pickups rebound *before* drop-offs |
| **4 May** | DXB ramps to near-full ops. Small-scale Iranian attack (Fujairah) | — |
| **5–8 May** | **Schools back to remote learning** | School peaks vanish again for four days |
| **7 May** | US strikes Iran (Qeshm, Bandar Abbas, Minab) | Second, shallower shock |
| **May–Aug** | Steady recovery: DXB 4.5m (May) → 5.0m (Jun) → ~3m in the first half of July | Airport share climbs back over ~14 weeks |

**Magnitude summary for the calendar:** airport trips fell to roughly **×0.15–0.45 of normal for 28 Feb – 2 May**, bottoming near **×0.20 in late March**, while total city trips fell to roughly **×0.62–0.72**. That gap — a 5× collapse in airport work against a 1.5× collapse in everything else — *is* the diagnostic.

### 7.2 Why you must detect rather than hard-code

You asked for this explicitly, and you're right to. Hard-coded dates fail three ways here:
1. **They don't generalise.** The next shock will have different dates.
2. **They're wrong at the edges.** The war "started" 28 Feb, but the demand effect on airport trips started within *hours* and the recovery took *weeks*, with two relapses. A binary flag misstates both onset and decay.
3. **They confound.** 28 Feb – 19 Mar is simultaneously Ramadan, war, and the run-up to Eid. Three flags on the same days cannot be separately identified from three weeks of data.

### 7.3 Detection recipes — run these on your own daily/hourly aggregates

**(a) Airport share ratio — the primary geopolitical detector.**
```
airport_share = airport_trips / total_trips     -- daily
```
Normal Dubai sits around **0.10–0.14**. An aviation/geopolitical shock drops it below **0.06 within 24–48 h while total trips fall far less**. A demand shock (holiday, weather, heat) moves numerator and denominator *together*, leaving the ratio roughly intact. **This ratio is the single most informative series you can build.**

Flag rule: `airport_share < 0.6 × median(airport_share over prior 28 days)` for ≥2 consecutive days **AND** `total_trips > 0.8 × median(total_trips over prior 28 days)`.

**(b) Airport directional asymmetry — the evacuation detector.**
```
exodus_ratio = airport_dropoffs / airport_pickups
```
Normal ~1.00–1.10. During 28 Feb – 27 Mar 2026 this should read **1.5–3.0** and stay there for days: everyone leaving, nobody arriving. After the 2 May reopening it should **invert** (pickups spike first — returns and repatriations). No ordinary seasonal effect produces a sustained one-way flow like this. Holidays produce a *sequenced* pair (drop-offs spike, then pickups spike a week later); an evacuation produces drop-offs with no matching return.

**(c) Step-change vs. gradient.**
Compare each day's total to `median(prior 28 days)`. Seasonal transitions are gradients over weeks. Shocks are **step functions within 48 hours**. Use a simple CUSUM or a rolling-median break test; you don't need anything fancier.

**(d) Speed and duration — separates weather from geopolitics.**
```
mean_speed = trip_distance_km / trip_duration_hr
```
Geopolitical shock → **speed UP** (roads empty). Rain/flood → **speed DOWN sharply**, duration-per-km +40–80%, completed/requested ratio collapses. If demand is down *and* speed is down, it's weather. If demand is down *and* speed is up, it's a shock or a holiday.

**(e) Supply vs. demand separation.**
```
distinct_drivers_online (daily), trips_per_online_hour (market median)
```
A **supply** shock (exodus, Eid leave, summer leave) → distinct drivers steps down, trips-per-online-hour holds or *rises*.
A **demand** shock (war, weather) → distinct drivers roughly flat initially, trips-per-online-hour collapses, then drivers exit with a lag.
This distinction is essential: a driver whose earnings-per-hour rose in March 2026 may have been the beneficiary of a supply collapse, not a better driver.

**(f) Hour-of-day fingerprint — the Ramadan and remote-learning detector.**
Build a 24-element vector of each day's trip share by hour. Compute cosine distance (or Jensen–Shannon divergence) against the trailing 28-day median vector.
- **Ramadan:** a large, *sustained* (30-day) distance, with a characteristic signature — a deep notch at the sunset hour and a large positive lobe at 00:00–02:00.
- **One-off shocks:** a spike in distance lasting 1–3 days.
- **Holidays:** loss of the two commute lobes, gain in midday and late-night.
This one metric catches every regime change in this document, including ones nobody put on a calendar.

**(g) Remote-learning / school-in-session detector.**
Ratio of 07:00–08:00 trips originating in villa communities (Arabian Ranches, Mirdif, Jumeirah, Springs/Meadows, Motor City) to total 07:00–08:00 trips. It collapses on **2 Mar 2026**, stays collapsed to **19 Apr**, partially recovers, collapses again **5–8 May**. A very clean binary marker — and a good validation test for any detector you build.

---

## 8. Ordinary weekly seasonality (UAE structure)

Since **1 January 2022** the UAE federal working week is **Monday–Friday with a half-day Friday** (government 09:00–12:00), weekend **Saturday–Sunday**. This is not the old Fri–Sat weekend and not the Western Mon–Fri, and it produces a shape unique to the UAE. Caveats: private-sector practice varies (many free-zone, retail, logistics and construction employers still run Saturdays), and **Sharjah government has a 4-day week with Fri–Sat–Sun off**, which matters because a large share of both drivers and Dubai commuters live in Sharjah.

**A normal (non-Ramadan, non-holiday) week:**

| Day | Character | Notes for driver analysis |
|---|---|---|
| **Mon** | Full commute. Peaks 07:00–09:00 and 17:00–19:30. Weekly *low* for leisure and nightlife | Lowest late-night hours of the week (Mon 01:00–05:00) |
| **Tue** | Same as Monday | Cleanest "baseline weekday" for comparisons |
| **Wed** | Same, evening starts building | |
| **Thu** | Full commute + **first big going-out night**: 20:00–03:00 Friday morning | One of the two biggest nightlife blocks |
| **Fri** | **Unique double shape.** Muted morning commute → **large 11:30–13:30 spike for Jumu'ah** (mosque trips: short, low-fare, high-volume) and offices emptying at noon → **biggest brunch block 12:30–17:00** → **largest nightlife peak of the week 21:00–04:00** | A driver's Friday fare-per-trip is structurally *lower* midday and structurally *higher* at night. Never blend them |
| **Sat** | Leisure-dominated. **No morning peak.** Late start, malls, beaches, family trips, strong evening, large late-night | |
| **Sun** | Leisure daytime, but **evening tapers early** — Monday is a work day | The weekly nightlife trough |

**Typical amplitudes:** Friday + Saturday run roughly **15–25% above the Mon–Thu daily mean** in trip counts; Sunday sits near the mean; Monday is the weekly low for leisure. Weekend trips are longer and higher-fare on average; weekday trips are shorter and more commute-shaped.

**Airport banks run on a different clock entirely.** DXB has a large overnight arrival bank (roughly 00:00–04:00) and morning arrival/departure banks (roughly 06:00–11:00), plus an evening departure bank (roughly 20:00–23:00). *Verify these from your own pickup timestamps — my hours are approximate.* The practical point stands regardless: **a driver who works DXB nights has a completely different hour profile from a driver who works Marina evenings, and comparing their trips-per-online-hour without controlling for the bank structure is meaningless.**

---

## 9. How to actually use this as a control

The calendar is necessary but not sufficient. My recommended hierarchy:

**1. Prefer a market-relative metric over a calendar-adjusted one.**
```sql
-- market index, computed per (date, hour_block, zone) across all active drivers
market_rate := median(driver_trips_per_online_hour)
driver_ratio := driver_trips_per_online_hour / market_rate
```
Consistency = **low variance of `driver_ratio`**, not low variance of the raw metric. This automatically controls for *every* effect in this document — including Ramadan's inversion, the war, the heat, and any event nobody put on the calendar. It is strictly more robust than a hand-built calendar, and it is what I'd build first.

**2. Use the calendar for two jobs the market index can't do:**
   - **Interpretation.** When a driver's ratio moves, the calendar tells you *why*.
   - **Exclusion.** Some windows are structurally uninterpretable. I would **exclude 18 Feb – 8 May 2026 from consistency scoring** entirely, or score it separately: Ramadan's inversion, the war, the flood and two remote-learning periods overlap so heavily that no amount of adjustment recovers a clean signal.

**3. If you do model it, fit the multipliers — don't trust mine.**
```sql
log(trips_per_online_hour) ~ driver_fe + day_fe + dow + hour_block + zone
```
A saturated **day fixed effect** absorbs the entire calendar without you having to specify it correctly. Then judge consistency on the **driver residual**. My multipliers are priors for sanity-checking that model's output, not inputs to it.

**4. Watch for the specific traps this window contains:**
   - Trips-per-hour rising in July–August is heat, not skill (§2.3).
   - Earnings-per-hour rising in March 2026 may be a supply collapse, not skill (§7.3e).
   - A driver "going inconsistent" in late February 2026 may have kept a normal shift through Ramadan's inversion (§3.1).
   - A driver's airport trips collapsing on 1 March 2026 is not a behaviour change (§7.1).
   - The 15–19 April Art Dubai uplift **does not exist this year** (§5).
   - **27 Aug 2026**, your final day, is contaminated by the 28 Aug public holiday.

---

## 10. `season_calendar` — PostgreSQL

Validated on PostgreSQL 16: emits **exactly 361 rows**, one per day from 2025‑09‑01 to 2026‑08‑27, zero gaps, `day` unique. Base seasons are non-overlapping and exhaustive; event overlays may stack and are aggregated per day. `expected_effect` leads with a demand multiplier token `xN.NN` and an airport token `apt xN.NN`, so numeric indices are recoverable:

```sql
SELECT day, season,
       substring(expected_effect from 'x([0-9]+\.[0-9]+)')::numeric      AS demand_index,
       substring(expected_effect from 'apt x([0-9]+\.[0-9]+)')::numeric  AS airport_index
FROM season_calendar;
```

```sql
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
```

Join it on:
```sql
SELECT t.day, t.trips, c.season, c.event, c.expected_effect
FROM daily_trips t
LEFT JOIN season_calendar c USING (day);
```

---

### Sources

[The National — Ramadan 2026 date forecast](https://www.thenationalnews.com/news/uae/2026/02/03/when-is-ramadan-dates-holiday/) · [Gulf News — UAE confirms first day of Ramadan 2026](https://gulfnews.com/uae/ramadan/ramadan-2026-uae-confirms-first-day-after-crescent-moon-sighting-1.500446056) · [Khaleej Times — UAE announces 20 March as start of Eid Al Fitr 2026](https://www.khaleejtimes.com/uae/eid-al-fitr-2026-uae-announces-first-day-march-20) · [Gulf News — Eid Al Adha 2026 six-day holiday](https://gulfnews.com/uae/eid-al-adha-2026-explained-moon-sighting-arafat-day-and-uae-holiday-1.500535173) · [MoE — Academic Calendar 2025–2026](https://moe.gov.ae/en/guides/Pages/Academic-Calendar-2025%E2%80%932026.aspx) · [Gulf News — UAE sets 31 August start for AY 2026/27](https://gulfnews.com/uae/education/uae-sets-august-31-start-for-20262027-academic-year-1.500528465) · [Dubai DET — 31st Dubai Shopping Festival dates](https://www.dubaidet.gov.ae/en/newsroom/press-releases/31st-edition-of-dubai-shopping-festival) · [DWTC — GITEX Global 2025](https://www.dwtc.com/en/events/gitex-global-2025/) · [Gulfood 2026 — dates](https://www.gulfood.com/gulfood-2026-products/dates-1) · [WHX Dubai 2026](https://www.worldhealthexpo.com/events/healthcare/dubai/en/whats-on/features/arab-health-is-now-whx.html) · [Dubai Airshow 2025](https://www.dubaiairshow.aero/en/usefulinfo/info/news/dubai-airshow-2025-unveils-new-features.html) · [WGS 2026 — 3–5 February](https://www.worldgovernmentssummit.org/media-hub/news/detail/world-governments-summit-to-hold-next-edition-from-3-5-february-2026) · [UAE Media Office — Dubai Racing Carnival 2025/26 and DWC 28 March 2026](https://www.mediaoffice.ae/en/news/2025/july/24-07/dubai-racing-carnival) · [Emirates Dubai 7s 2025](https://emiratesdubai7s.com/news/2025-date-announcement/) · [Gulf News — Asia Cup 2025 in the UAE, 9–28 September](https://gulfnews.com/sport/cricket/mens-asia-cup-2025-to-be-held-in-uae-from-september-9-to-28-confirms-acc-president-1.500212229) · [Gulf News — NYE 2026 Dubai traffic, metro and closures](https://gulfnews.com/uae/transport/nye-2026-dubai-road-closures-metro-and-parking-for-burj-khalifa-fireworks-1.500395187) · [Khaleej Times — 23 flights diverted in fog, 3 January 2026](https://www.khaleejtimes.com/business/aviation/23-inbound-flights-diverted-dubai-airports-fog-jan-3-morning) · [The Watchers — Dubai flooding, 23–27 March 2026](https://watchers.news/2026/03/30/heavy-rain-triggers-urban-flooding-and-transport-disruption-in-dubai-uae/) · [Al Jazeera — airspace closed as US/Israel attack Iran, 28 Feb 2026](https://www.aljazeera.com/news/2026/2/28/airspace-closed-airlines-halt-flights-as-us-israel-attack-iran-responds) · [Wikipedia — 2026 Iranian strikes on the UAE](https://en.wikipedia.org/wiki/2026_Iranian_strikes_on_the_United_Arab_Emirates) · [Al Jazeera — UAE lifts all air traffic restrictions, 3 May 2026](https://www.aljazeera.com/news/2026/5/3/uae-lifts-all-air-traffic-restrictions-introduced-since-iran-war) · [Skift — DXB traffic down 66% in March](https://skift.com/2026/05/04/dubai-international-airport-passenger-traffic-plunged-66-in-march-as-iran-war-closed-airspace/) · [Khaleej Times — Dubai hotel occupancy H1 2026](https://www.khaleejtimes.com/business/dubai-hotel-occupancy-to-recover-in-h2-2026-after-sharp-first-half-decline) · [Gulf News — UAE schools reopen 20 April 2026](https://gulfnews.com/living-in-uae/education/uae-schools-to-reopen-everything-parents-need-to-know-1.500506230) · [The National — UAE schools return to remote learning, 4 May 2026](https://www.thenationalnews.com/news/uae/2026/05/04/uae-to-adopt-remote-learning-for-rest-of-week-after-iran-attacks/) · [Artforum — Art Dubai postpones 2026 fair](https://www.artforum.com/news/art-dubai-postpones-2026-fair-amid-sustained-iran-war-1234745711/) · [MoHRE — Ramadan 2026 reduced working hours](https://www.mohre.gov.ae/en/media-center/news/12/2/2026/reduction-of-working-hours-for-private-sector-employees-by-two-hours-daily-during-the-holy-month-of) · [CNN — Dubai $800 tourism incentive](https://www.cnn.com/2026/07/28/travel/dubai-launches-tourism-incentive-after-iran-strikes) · [Dubai Summer Surprises 2026](https://dubaifastliving.com/dss-2026-dates/)