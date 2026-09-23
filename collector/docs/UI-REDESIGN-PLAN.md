# UI redesign plan — every page, before any code changes

Status: **PLAN, approved by the operator 2026-09-23 with the rulings in section 1.** Nothing below is implemented. Written 2026-09-23 from a read-only survey: nine agents compared each live page (rendered through `bin/prod-mirror.mjs`, and from source once the mirror was stopped) with its Arkiv mockup in the scratchpad (`arkiv-new/`, `arkiv/arkiv-pages/`), and a critic checked the combined plan against the operator's rules. Its corrections are written into the entries they apply to.

The operator's rules this plan is held to:
1. Never replace a working solution that gives better data than the redesign. Live content that is richer or more exact stays.
2. Where the redesign shows data the live page lacks, add it — only where the data exists (each addition names its endpoint).
3. Views that make operations faster (tables with actions, forms, filters, drill-downs, the map, live tracking, the paste box, the deposit form, the review queue) are restyled only, never restructured.
4. A figure that cannot be measured renders absent with its true reason — never zero.

## 1. Decisions — ruled by the operator, 2026-09-23

The survey could not settle these conflicts. Each one below has been ruled on by the operator. Where the ruling differs from the recommended default, it is marked **RULED**.

1. **Warnings without amber.** The redesign's colour law has no amber. Live pages use amber for "warning" in 34 tiles, 27 pills and the at-risk banner. *Ruled — the default:* Negative red with a HOLLOW dot for warning, solid dot for critical — one rule used on every page.
2. **Money precision.** Some page plans switch to cents (AED 1,275.14), others keep whole dirhams; tests pin whole-AED strings. ~~Recommended: whole dirhams on tiles.~~ **RULED: every money figure is PRECISE, with decimal points (AED 1,275.14), on every page, tile, table and chart label.** Tests that pin whole-AED strings are changed deliberately, and each one says why.
3. **Dark mode.** The live app has light/dark/system; the redesign defines light only, and no colour in it was validated on dark. **RULED: design a dark mode FOR THE NEW UI.** Dark tokens for every neutral, channel identity, wash, ramp, semantic and hatch. Each is validated the way PALETTE-EVIDENCE.md validated light: contrast against the dark paper, and CVD separation between channel colours. The existing system/light/dark toggle keeps working.
4. **A level or gap in the delta slot.** Several pages put "vs fleet median" or "vs 95% target" where the redesign reserves a change-over-time. *Ruled — the default:* Allow it, always worded ("+24 against the fleet median"), never a bare arrow.
5. **Per-tier revenue (AED/km per tier).** #overview would add it; #platforms/tiers rejects it because Uber fares arrive from a weekly walk and cover some weeks of some tiers. *Ruled — the default:* Do not add it until every bar can say "priced n of N"; revisit after.
6. **Donuts.** The foundation turns every donut into ranked bars; some pages want a 100% bar instead. *Ruled — the default:* Each donut is replaced explicitly per page, as its entry says; no global switch.
7. **Verdict sentence vs hero figure.** Pages differ on whether the verdict band keeps its figure or the hero tile takes it; tests read the verdict DOM. *Ruled — the default:* Keep the verdict band as the page's statement under "At a glance" and do not repeat its figure as a tile.
8. **#receipts "Credited, net of re-filings" tile.** The redesign drops it for a per-kind split. *Ruled — the default:* Keep the tile with a "not a total across kinds" caption, add the per-kind split beside it.

Other conflicts the implementation must settle in the foundation, not per page: settlement classes coloured four ways (one mapping, used everywhere); payout components (ink for added, grey for deducted, with signs); the state ramp (engaged / available / idle defined once); build the new glance tile ON the existing `kpiTile`, not beside it; the control bar keeps its six controls and page-specific pickers stay in their pages; `#unit`'s eight tiles fit the six-column glance grid as 6 + 2.

## 2. Page index

Effort: **S** restyle only · **M** sections restructured · **L** new data or large restructure.

### Today

| Page | Effort | Adds | Mockup | Headline change |
|---|---|---|---|---|
| `insights` | L | 8 | arkiv/arkiv-pages/C-insights.png | Section order: 00 At a glance (verdict headline plus the 5 live tiles, Open actions as the one hero), then the chip row, then 01 Ranked actions directly under the chips,… |
| `playbook` | M | 5 | arkiv/arkiv-pages/C-playbook.png | FIX (unit): the verdict says 'worth AED 163,733 a month' with the figure unit 'over 23 days'. |
| `overview` ⚑ | M | 8 | arkiv/arkiv-pages/C-overview.png | Section order: 00 At a glance (verdict headline + 7 tiles with Trips as the hero), then 01 Bookings per day/week, then 02 Cancellations a day, then 03 Which channel (was… |
| `compare` | M | 5 | arkiv/arkiv-pages/C-compare.png | FIX (rule 4, false reason): |
| `analyst/confirmed` ⚑ | L | 6 | arkiv/arkiv-pages/C-analyst.png | Cards grouped one per DISTINCT claim. |
| `analyst/refuted` ⚑ | S | 2 | none | Hero tile becomes 'Contradicted by the data', with the other verdict counts as tiles |
| `analyst/immaterial` ⚑ | M | 2 | none | Hero tile becomes 'True but too small'. |
| `analyst/unsupported` ⚑ | S | 1 | none | Restyle only: shared tiles (hero 'Not measurable') and ruled cards. |
| `analyst/rules` ⚑ | S | 0 | none | Restyle only: shared tiles, hairline tables, and dimension chips as plain ink chips. |
| `action` | L | 5 | arkiv-new/C-action.png | Section order: 00 glance (Sized at as the hero when present, drawn with HATCH and the 'modelled, not a measurement' label when modelled; |

### Money

| Page | Effort | Adds | Mockup | Headline change |
|---|---|---|---|---|
| `unit` | M | 6 | arkiv/arkiv-pages/C-unit.html | Section order: 00 At a glance (the verdict figure becomes the hero tile and its claim the band's opening sentence; |
| `unit/assets` | S | 0 | none | Restyle through the shared foundation only: |
| `unit/drivers` | S | 0 | none | Restyle only (tiles, hairline table, chips) |
| `revenue` ⚑ | M | 6 | arkiv/arkiv-pages/C-revenue.html | Section order: 00 At a glance (verdict → hero 'Accounted for'; |
| `corporate/overview` ⚑ | M | 4 | arkiv/arkiv-pages/C-corporate.html | 00 At a glance: hero 'Kept' (margin AED 18,434, 30.1% of revenue); |
| `corporate/properties` | S | 0 | none | Restyle only (hairline table, Hotel row marker) |
| `corporate/guests` | S | 0 | none | Restyle only |
| `corporate/leakage` | S | 0 | none | Restyle the counters as a ranked check list (count + label), still links |
| `corporate/approach` | S | 0 | none | Restyle only. Bars in Hotel identity with direct labels; |
| `property/overview` | M | 4 | arkiv-new/C-property.html | 00 At a glance with hero 'Kept' once the cost comes from the properties row |
| `property/guests` | S | 0 | none | Restyle only |
| `property/drivers` | S | 0 | none | Restyle only |
| `import-sheet` | S | 0 | none | Restyle only (form tokens, visible hairline input fields, chips of at least 44px) |
| `opening` | M | 4 | arkiv-new/C-opening.html | Order: 00 At a glance (one row, so the form still starts above the fold at 1440) → form → grid → the charts → † absence band → footer |
| `salary` | M | 3 | arkiv-new/C-salary.html | The column header 'Generated' becomes 'Generated, whole record'. |
| `advances` | M | 5 | arkiv-new/C-advances.html | Order: 00 → owes table → form → register → 01 scatter → 02 ranked ceiling → † absence band |
| `charging` | M | 3 | arkiv-new/C-charging.html | The hero 'Advanced in <window>' prints the literal 'AED 0.00' from a fallback (charging.js: |
| `policy` | M | 3 | arkiv-new/C-policy.html | Give 'The line' a visible field with a '%' suffix |
| `deposits` | M | 4 | arkiv-new/C-deposits.html | Order: 00 → Record a handover (unchanged) → 01 top-20 bars → Who is carrying cash table → distributions → † absence band (what each driver holds: |
| `deposits/phone` | S | 0 | none | Restyle through m.css tokens only (Arkiv type and ink; |

### Finance

| Page | Effort | Adds | Mockup | Headline change |
|---|---|---|---|---|
| `finance` ⚑ | L | 7 | arkiv/arkiv-pages/C-finance.html | Section order: 00 At a glance → 01 Money in, day by day (hero chart, full width) → 02 Trip value a day / 03 Platform payouts a day (a pair) → 04 How the rider paid → 05… |
| `receipts` ⚑ | L | 7 | arkiv/arkiv-pages/C-receipts.html | FINDING, needs an operator ruling: |
| `payouts` ⚑ | L | 9 | arkiv-new/C-payouts.html | Section order: 00 At a glance → 01 wire vs ours → 02 difference (+03 zoom) → 'Each wire against our own figure' table plus the ask controls (unchanged) → audit panel →… |
| `reconcile` ⚑ | M | 9 | arkiv/arkiv-pages/C-reconcile.html | Section order: 00 At a glance (Bank paid over statement HERO · latest gap · latest bank paid · Compared over · Trips) → 01 expected vs paid → 02 gap trend / 03 what the… |
| `reconcile/<YYYY-MM>` | S | 1 | none | Restyle through the foundation: |
| `settlement/mix` | M | 0 | arkiv/arkiv-pages/C-settlement.html | 00 band: HERO = 'still to collect' (the verdict's figure: |
| `settlement/cash` ⚑ | M | 2 | arkiv/arkiv-pages/C-settlement.html | FINDING: the 'Cash the platforms report' tile's sub always ends 'a different measurement of the same money, and the larger of the two'. |
| `settlement/receivables` | M | 0 | arkiv/arkiv-pages/C-settlement.html | 00 band: HERO = Outstanding · Counterparties · Oldest debt · Bookings with no fare (today only in a sub-line). |
| `provenance` | M | 8 | arkiv/arkiv-pages/C-provenance.html | Order: 00 At a glance (headline HERO · Calls returning money · Figures the providers sent · Figures that restate · Channels answering · Not footed [absence]) → 01 every… |

### Work

| Page | Effort | Adds | Mockup | Headline change |
|---|---|---|---|---|
| `demand` | M | 5 | arkiv/arkiv-pages/C-demand.html | New section order: 00 At a glance → 01 Every hour of every weekday (the heatmap, promoted to hero chart) → 02 The shape of a day (the live rate curve redrawn as 24… |
| `trips` | M | 7 | arkiv/arkiv-pages/C-trips.html | Order: 00 At a glance → 01 the bookings table with search, filters and paging → 02 price-status bars → 03 daily columns → 04 cancel-rate line → 05 fare-settlement bars →… |
| `supply` | M | 4 | arkiv/arkiv-pages/C-supply.html | Order: 00 → 01 rate heatmap (hero, same measure) → 02 typical week stacked → 03 what an online hour buys → 04 Where the waiting happens (table) → † absence → links +… |
| `platforms/share` | M | 4 | arkiv/arkiv-pages/C-platforms.html | 00 tiles: bookings across all channels (hero), Uber's share, best and worst channel completion against the fleet (▲/▼ with sign), work turned down. |
| `platforms/tiers` | S | 2 | arkiv/arkiv-pages/C-platforms.html | KPIs become 00 tiles, with premium share as the hero. |
| `platforms/funnel` | S | 1 | arkiv/arkiv-pages/C-platforms.html | KPIs become 00 tiles; |
| `corridors` | M | 4 | arkiv/arkiv-pages/C-corridors.html | Order: 00 → 01 busiest routes (bars) → 02 where the work starts (live hbars) → 03 km×fare scatter → 04 morning vs evening (live diverging) → 05 never leaves the area →… |
| `causes` | M | 3 | arkiv/arkiv-pages/C-causes.html | 00 tiles: biggest real break (hero, with ▲/▼ and sign), breaks found, share explained by headcount, bookings per driver. |
| `forecast` | M | 3 | arkiv/arkiv-pages/C-forecast.html | 00 tiles. Hero: the RANGE for next month (low method to high method), not a point. |
| `optimise` | M | 5 | arkiv/arkiv-pages/C-optimise.html | 00 tiles: idle between jobs (hero), median wait, idle at a charging site ('waiting and charging cannot be told apart'), bookings where no car waited (6.3%), best and… |
| `capacity` | M | 3 | arkiv/arkiv-pages/C-capacity.html | 00 tiles: hours short of drivers (hero, 'of 168'), worst hour, smallest shortfall, bookings expected (with range), and the rota as ABSENT. |
| `day` | S | 1 | none | Restyle through the shared foundation only. |
| `slot` ⚑ | M | 3 | arkiv-new/C-slot.html | '15:00 across the week' switches from raw weekday counts to PER OCCURRENCE (peers[].trips ÷ peers[].days, both in the payload). |
| `trip` ⚑ | L | 4 | arkiv-new/C-trip.html | 00 tiles: fare (hero, with product and payment route), driver earnings (service fee, commission %), distance, request→drop-off, rider in the car (seat sensor when… |

### People — drivers

| Page | Effort | Adds | Mockup | Headline change |
|---|---|---|---|---|
| `#drivers` ⚑ | M | 7 | arkiv-new/C-drivers.html | The verdict card becomes '00 At a glance' with 5 tiles: |
| `#driver/overview` ⚑ | M | 4 | arkiv-new/C-driver.html | Header layout: identity card on the left with the photo, live status and span strip on the right, tab bar as a text row with an underline on the current tab. |
| `#driver/activity` | M | 3 | arkiv-new/C-driver-activity.html | Ribbon colours: on job = Uber identity, online-waiting = Uber 'available' ramp step, not online = no mark, no-dropoff = hatch in the job's own colour. |
| `#driver/day (?on=YYYY-MM-DD)` ⚑ | L | 4 | arkiv-new/C-driver-day.html | The headline becomes the 00 band (hero = the share of online time carrying someone, the one highlight) |
| `#driver/territory` | S | 0 | none | Restyle through the shared foundation only. |
| `#driver/earnings` | S | 0 | none | The donut becomes one 100% stacked bar with direct labels (count and share) in achromatic sequential steps. |
| `#driver/quality` | S | 0 | none | Per 100 km sub-line becomes a delta chip '▲ +41.3 against the fleet median 68.1' in the negative colour (a measure where lower is better, so semanticOf is inverted),… |
| `#driver/record` | S | 0 | none | The fleet-median outline behind each bar becomes a 2px ink-2 tick across the bar. |
| `#driver/money` | S | 0 | none | Restyle only: absent tiles use the Arkiv absence cell (the reason in place of the value, never highlighted — L4); |
| `#driver/trips` | S | 0 | none | Restyle only: a 3px channel row marker in the gutter (SPEC §4); |
| `#driver/unauthorized` | S | 0 | none | Restyle only, plus ONE TRUTH FIX (house principle, SPEC §5). |
| `#online-time` ⚑ | L | 6 | arkiv-new/C-online-time.html | The live line becomes a one-line bar: |
| `#performer` | L | 8 | arkiv-new/C-performer.html | 00 At a glance = Money (hero) · Bookings · Days worked · Carrying someone · Of time on the road · Waiting between jobs (6 tiles), with the fact strip under it. |
| `#cohort` | M | 6 | arkiv-new/C-cohort.html | The verdict becomes the 00 band hero. |

### People — the rest

| Page | Effort | Adds | Mockup | Headline change |
|---|---|---|---|---|
| `cancellations` ⚑ | M | 7 | arkiv/arkiv-pages/C-cancellations.html | Section order: 00 At a glance (5 tiles; |
| `roster` | M | 3 | arkiv/arkiv-pages/C-roster.html | 00 At a glance: the verdict's figure becomes the hero tile (first, largest, the one highlight, same choice logic as the verdict). |
| `roster/pipeline` | S | 2 | none | Restyle through the shared foundation only: |
| `roster/idle` | S | 1 | arkiv/arkiv-pages/C-roster.html | Restyle through the shared foundation. |
| `roster/blocked` | S | 0 | none | Restyle only. The holding-a-car note sits in the absence/cost band under the table |
| `roster/states` | S | 1 | arkiv/arkiv-pages/C-roster.html | Restyle. One channel per small multiple, following SPEC §3.4's one-ramp-per-plot rule |
| `top-performers` | M | 5 | arkiv/arkiv-pages/C-top-performers.html | Order: week control and one-line note in the chrome → 00 tiles (the hero is Best per day, the verdict's figure) → 01 top-12 bars → 02 concentration curve → 03 Ranked… |
| `low-performers` | M | 5 | arkiv/arkiv-pages/C-low-performers.html | Order: 00 tiles (the hero is Lowest per day) → 01 bottom-12 bars → 02 days-worked histogram → 03 Ranked lowest table (unchanged) → 04 completion scatter → 05 best/worst… |
| `performance` | M | 5 | arkiv/arkiv-pages/C-performance.html | Order: grain tabs and chips in the chrome → 00 tiles (the hero is Changed N of M tested, the page's distinctive question) → 01 scatter → 02 movers (tables plus split… |
| `performance/month` | S | 1 | arkiv/arkiv-pages/C-performance.html | Same plan as #performance. |
| `retention` | M | 4 | arkiv/arkiv-pages/C-retention.html | Split flowChart. The dashed headcount line on its own scale is a dual axis, which SPEC §4 forbids. |
| `compliance` | M | 6 | arkiv/arkiv-pages/C-compliance.html | 00 tiles: the hero is 'Drivers who cannot legally work' (people). |
| `identity` ⚑ | M | 4 | arkiv/arkiv-pages/C-identity.html | Correctness first: 'Could the names have done it?' reads Yes for name-basis links (the name is the evidence) and keeps the /changes nothing/ logic only for phone links. |
| `same-person` | S | 5 | arkiv/arkiv-pages/C-same-person.html | Fold 'Already answered' to the 12 most recent, with 'show all 365' and a same/different filter. |

### Fleet and Sources

| Page | Effort | Adds | Mockup | Headline change |
|---|---|---|---|---|
| `#vehicles` | L | 6 | arkiv/arkiv-pages/C-vehicles.html | Merge the verdict figure (3) and the 'Moved, no booking' tile into one hero tile. |
| `#vehicle/overview` ⚑ | L | 8 | arkiv-new/C-vehicle.html | 00 band: Money in (hero, exact AED, the one highlight) · Bookings · Distance · Money per km with delta · Harsh events per 100 km · Utilisation. |
| `#vehicle/drivers` | S | 0 | none | Restyle through the shared table CSS only: |
| `#vehicle/movement` | S | 0 | none | Restyle only. Verdict bars go neutral ink (verdicts are not channels). |
| `#vehicle/earnings` | S | 0 | none | Exact money (AED 13,995.70, not 13,996) |
| `#vehicle/safety` | S | 1 | none | Event bars in FMS identity #9974F5 with direct labels (every event comes from the FMS/InfoTrack alert feed). |
| `#vehicle/compliance` | S | 0 | none | Restyle. Days-left chip: |
| `#vehicle/trips` | S | 0 | none | Restyle. Platform gets a swatch; |
| `#unauthorized` | L | 7 | arkiv/arkiv-pages/C-unauthorized.html | The verdict figure merges into the hero tile; |
| `#segments` | L | 7 | arkiv-new/C-segments.html | The verdict's figure moves into the band. |
| `#segment` | M | 7 | arkiv-new/C-segment.html | 00 band: Carried with no booking (km, hero) · To the nearest booking · Revenue forgone · Who was driving · Telemetry through the window (fixes, observed, largest gap). |
| `#safety/people` | M | 6 | arkiv/arkiv-pages/C-safety.html | 00 band, shared by all 3 tabs: |
| `#safety/vehicles` | M | 2 | arkiv/arkiv-pages/C-safety.html | Worst-vehicles bars in FMS identity with labels |
| `#safety/events` | S | 0 | arkiv/arkiv-pages/C-safety.html | The 2 donuts become one '§04 The kinds of alert' ranked-bar list. |
| `#live` | M | 5 | arkiv/arkiv-pages/C-live.html | 00 band: Not reporting (hero, the verdict figure, of N) · Fresh <30 min · Silent over a day · Moving · Engaged of N with a seat sensor. |
| `#map` | S | 0 | arkiv/arkiv-pages/C-map.html | Restyle only. Marker colours come from feed identity, with the occupancy state as that channel's ramp; |
| `#map/replay` | M | 6 | arkiv/arkiv-pages/C-map.html | The new marks go BELOW the map, and only in replay mode. |
| `#sources` | L | 6 | arkiv/arkiv-pages/C-sources.html | Order: verdict/00 → §01 reasons → §02 by month → Collector health → Data coverage → §04 freshness / §05 rows by source → Windows that did not land → Pre-built summaries… |
| `#coverage` | M | 5 | arkiv/arkiv-pages/C-coverage.html | BUG FIRST: coverage.js awaits /api/coverage (line 289) with no alive(gen) check. |
| `#providers` | S | 1 | arkiv/arkiv-pages/C-providers.html | 00 band from the existing tiles: |
| `#providers/<provider>/<surface>/<key>` | S | 0 | none | Restyle only |
| `#settings` | M | 2 | arkiv/arkiv-pages/C-settings.html | The band + §01 sit ABOVE the paste box and take no more than one screen. |
| `#notfound` | S | 0 | none | Restyle only. The 'err' note becomes an ink notice: |

⚑ = a review correction or corrected data source is written into that page's entry below.

## 3. Shared foundation (lands first; every page inherits it)

### Colour tokens

- ONE SOURCE. Port scratchpad arkiv-new/tokens.mjs to api/public/tokens.js (NEUTRAL, CHANNEL, CHANNEL_ORDER, RAMP, WASH, SEMANTIC, SEQUENTIAL, FORM, plus the helpers channelKey, channelOf, stateOf, washOf, semanticOf, sequentialOf and lintTokens). app.css's :root block is GENERATED from that file by a new bin/gen-tokens-css.mjs, the same pattern as gen-schema-v53. A new test asserts the two agree. This is SPEC L5.1: colour is defined in exactly one place.
- NEUTRALS, old → new. --paper #f4f2ed → #FFFFFF. --paper-2 #efece5 → #F6F6F7. --surface #fbfaf7 → #FFFFFF, an alias of --paper, so panels stop being cards. --surface-2 #eeebe4 → #F6F6F7, used for the hover row, thead and skeleton. --surface-3 #e6e2d9 → --faint #E9E9EB. --rule #e2ded4 → --hair #D6D6D9 for row separators and column rules; chart gridlines (.gl) take --faint instead. --rule-strong #cbc6b8 → --grey-2 #97979D, for rules and outlines only, never text. --ink #1f2225 → #0A0A0B.
- NAME COLLISION, resolved first. The live --ink-2 #5b6165 is SECONDARY TEXT. Arkiv's --ink-2 #2E2E31 is near-black emphasis. Step 1: rename the old --ink-3 #8b9095 → --grey #6D6D72 (5.15:1). It is used as text in ~60 rules: KPI labels, .dim, the crumb, the freshness block. Step 2: rename the old --ink-2 → --grey. Step 3: only then define --ink-2 #2E2E31. One mechanical commit, in that order. It is also about 14 var() references in JS (4 of them --ink-2, 10 --ink-3).
- ACCENT RETIRED. --accent #2f6f9f, --accent-ink, --accent-soft, --accent-line and --on-accent all move to ink. Links (.lnk, .ent, .getout-a, .kpi-who, .vdct-who, .tn-links) become ink-2 text with a 1px grey-2 underline. The focus ring becomes 2px --ink. A selected tab or chip gets an ink underline or an ink fill. .btn.primary becomes an ink fill with paper text. Reason: #2f6f9f sits next to Uber's new #2362D3, and under L1 every non-semantic hue names a channel, so a blue link would read as 'Uber'.
- CHANNELS. --ch-uber #2a4999 → --c-uber #2362D3. --ch-bolt #329d70 → --c-bolt #0398BA. --ch-yango #b83f1c → --c-yango #B4358A. --ch-hotel #a57db3 → --c-hotel #A38902. --ch-fms #636f75 → --c-fms #9974F5. --ch-cabman #4f453f → --c-cabman #6B259F. Each channel also gets its --w-<ch> 14% wash and its --c-<ch>-engaged/-available/-idle ramp. Used by ui.js SOURCE_TOKEN (its values change from --ch-* to --c-*), the .sw and .domb-seg ch-* classes, and chart colorFor. sourceToken() of an unknown key returns '--grey' instead of null, so an unlabelled feed looks unidentified and never falls through to a categorical hue (L1). The fleets (Ecosine, Egari) are not channels and get no hue.
- SEVERITY. --good #5e6f5b → --sem-pos #007E44. --critical #901d38 and --serious #8d4031 → --sem-neg #961111; severity is carried by form (critical = weight 600 plus a solid dot or ▼; serious = regular weight). --warn #7d5b05 (amber) has no place in the colour law. Proposed: --sem-neg with a HOLLOW dot, meaning worse than OK at the lowest severity. This needs an operator ruling. It affects 34 tone:'warn' tiles, 27 warn pills, the at-risk banner, and the 64 severity var() references in app.css plus 8 in m.css. The washes --good-bg / --critical-bg / --warn-bg → --w-pos #DBEDE5 / --w-neg #F0DEDE / --w-ink #DDDDDD.
- SEQUENTIAL. The 7 blue steps --b100..--b700 → 6 achromatic steps --seq-0..--seq-5 (#ACB0B7 #878E9A #676E79 #4A4F57 #2D323A #13171F), picked with sequentialOf(t). Used by heatmap and SEQ, hbars' default '--b400' (16 call sites), '--b500' and '--b300' (12), and map.js '--b300'. A cell with no reading uses --abs-outline #97979D, never step 0.
- CATEGORICAL --s1..--s8 retired as a palette cycled by index (L1: hues are never cycled by index). CAT stays exported but resolves to ink or graphite, so a caller that was missed renders neutral instead of a fake channel colour. The ~50 '--s1'..'--s8' string arguments are converted page by page to channelOf(name) or to ink. They sit in charts, app, causes, compare, corporate, day, driver, economics, forecast, map, revenue, segments, slot and vehicle.
- GEOMETRY AND MOTION. --r 10px, --r-sm 7px and --r-lg 16px → 0 for the sheet furniture. Marks keep a 4px data-end, chips 3px, swatches 2px. --shadow-1 and --shadow-2 → none. The hover lifts and the .stagger fadeUp entrance are removed. --side-w 236px goes with the rail, and the zen rules are rewritten.
- NEW FORM TOKENS, emitted as generated: --hl-weight 600, --hl-rule-w 3px, --hl-pad-x 8px, --hl-radius 3px, --mark-row 3px, --abs-outline #97979D, --sem-neu #6D6D72.
- LIVE DEFECTS FIXED IN THE SAME STEP. --card, --line, --sunken, --muted and --bad are referenced by the app.css deposit form and ~15 rules in m.css, and defined nowhere. Literal whites to replace with --paper: .depchip.on color:#fff, the '#fff' pin stroke in map.js, and the '#fff' in driver.js. Also update index.html's theme-color metas and manifest.webmanifest (#14171a, #f4f2ed) to Arkiv paper and ink.
- DARK MODE. The live app has one: two token blocks plus the system/light/dark cycle in #themeBtn. The design defines none; every validator run in PALETTE-EVIDENCE.md is against #FFFFFF only. There is no Arkiv-dark token block to port; see the risks entry.

### Typography

- FACES: nothing to load. The 10 woff2 files in api/public/fonts are byte-identical (cmp) to the design's fonts/, and both fonts.css files declare the same 20 faces: Fraunces 500–700, Plex Mono 400–600, Karla 400–700. One change: the <link rel=preload> for Fraunces is swapped for IBM Plex Mono 500, keeping Karla, because Fraunces now appears only on the wordmark.
- ROLES. IBM Plex Mono: every label (uppercase, tracked .14–.22em), table figures, axis ticks and controls. Karla: prose, names, the page title, and stat-tile values with proportional-nums (SPEC §4); tabular-nums only in aligned columns. Fraunces: the wordmark 'Fleet' ONLY. These leave Fraunces: h1–h4, .idmeta h2, the .av initials, .vdct-claim, .bk-head h4, and the phone's .m-stat and .m-lede figures.
- SCALE. Keep the existing --t1..--t9 and --d1..--d5 tokens; type_scale.test forbids literal sizes, requires every step to be used and steps ≥6% apart. The Arkiv px sizes quantize onto it: 9–9.5px labels → --t1 (9.44). 10–10.5 → --t2 / --t3. 11–11.5 → --t4. 12–12.5 captions → --t5. 13–13.5 body and table figures → --t6. 14 names → --t7. 15.5 statement sentence → --t8. 18.5–21 → --d1 / --d2. 27 tile value → --d4 (26.4). 40–46 absence and statement figures → --d5 (39.2). Add ONE step, --d6 ≈3.15rem (50px), for the hero tile value.
- REJECT b.css's sub-floor sizes (7.5, 8 and 8.5px on the chart day-of-week and heat-hour labels): they are below --t1 and below readable.
- Body base moves from --t7 (14.2px) to --t6 (13.25px) to match Arkiv's 13px sheet. Table cells stay at --t6, names at --t7.
- CONTRAST FIXES AT ADOPTION. The shell breach NEW-PAGES §4 logged: grey-2 used as TEXT at 2.90:1. It covers .ch .ax axis labels plus ~14 b.css rules: .window-sub, .nav-meta, .sec-idx, .capline, .c-rank, .c-chan, .thead .u, .colophon, .dow. Those rules port as --grey (5.15:1). --faint used as text (.ph-cap, .rp .fromto span, ~1.2:1) also becomes --grey.
- Plex Mono has no 700 weight (b.css .dow-t, .ch .dl-em ask for one), so those rules use 600. Add html{-webkit-text-size-adjust:100%} in the shell: the 390px overflow fix NEW-PAGES §6 says belongs there, not in each page.

### Components

- NAMESPACE, DON'T PASTE. b.css and viz.css class names collide with live ones: .cap (332 JS uses as a caption PARAGRAPH, which viz.css would turn into 9.5px mono caps), .num, .lab, .sub, .sec, .tag, .chip, .sw, .dl, .ledger, .wrap, .band, .basis and .table. Live classes are restyled in place. New Arkiv rules get new names or are scoped under .glance, .absband, .livebar or .authbar. Never import b.css or viz.css verbatim.
- panel(title, cap, key). Unchanged: DOM, the .pbody body, data-panel keys. Changes: the card (surface, border, 10px radius, shadow) becomes a ruled section with no box and a 1.5px ink top rule. h3 becomes the section name (mono --t3, weight 600, .22em caps) with a CSS counter printing '01', '02'… in ::before, so the .panel h3 textContent that tests read is unchanged. .cap stays a grey --t5 SENTENCE, not mono caps. The .g2/.g23/.g3 grids trade their 18px gutters for hairline column rules.
- kpiRow / kpiTile. Unchanged: the API and classes (.kpi .l .n .s, data-kpi, t-* and ok/warn/err tones), a.kpi cohort links with 'Who exactly? →', .long wrapping, kpiCols and --kpi-n. Changes: the card becomes an Arkiv tile with hairline column rules, mono caps label, value in Karla 600 at --d4 with proportional figures. Tones stop colouring the digits (L4: digits stay ink). Instead a semantic dot plus a screen-reader word sits in the label row, and ▲/▼ are reserved for signed deltas (today .kpi.t-good .n::before prints ▲ on a level).
- tableFrom. Unchanged: every column, sort buttons with the sort in the URL and nulls last, the sticky thead in .tall, the pinned first column, folding, cue fades, cards at 560px and below, markTall. Restyle: header in mono --t1 caps with a 1px ink rule beneath; rows 1px --hair; no zebra stripes (the pinned cell keeps an opaque --paper background); hover --paper-2. NEW opt-in option rowMark(r) → channel draws SPEC §4's 3px gutter marker instead of a tinted row.
- pill(text, tone) and .tag. Kept. The 99px pill becomes a 3px chip in mono --t2 caps. .pill.plat becomes a channel chip with a swatch, which needs the channel key: a new chanChip(key, label). ok/bad/warn become a wash plus a semantic dot with ink text (L5.6: no channel-coloured text). .pill.bad keeps its '!'.
- note(text, tone), 320 calls. The accent left bar becomes a caption topped by a hairline, in grey text. The err and warn tone classes stay (payout_page_reconcile reads .note.err and .note.warn) and gain a negative dot.
- verdict(), 42 calls in 26 files. Unchanged: fields and classes (.vdct-claim, -sub, -rec, -fig, -meta, -who; read by 4 tests). Changes: the card with a coloured left rule becomes b.css's STATEMENT BAND: an ink top rule, the claim in Karla --t8, the figure in Karla 600 --d5. The figure's digits stay INK; its tone moves to a 3px semantic rule on the band's top edge. Per-page plans place it BELOW 00 so the glance leads.
- dominantBar() (#platforms). Unchanged: classes (.domb-bar, -seg, -key, -total) and the clickable segment buttons. Changes: the 44px rounded bar with names printed ON channel fills becomes a bar ≤24px tall with 2px surface gaps, and every label moves into .domb-keys beneath it. SPEC says a label that doesn't fit moves outside the mark, and ink on #2362D3 does not reach 4.5:1.
- tabBar(), .tabs and .sectabs. Unchanged: routes, hrefs and the lit-tab logic. Folder tabs become text links with a 1px ink underline on the current one (the nav-view idiom). Icons are HIDDEN by CSS, not removed, because routes.test pins '#nav a .ic{'.
- avatar() and .idcard. Kept: the photo proxy, the initials fallback, and the difference between 'no photograph' and av-lost. The rounded gradient tile becomes a square hairline plate (.ph). av-lost's amber ring becomes a grey-2 outline with a visible 'photo on file, not fetched'. REJECT the design's grayscale photo filter: colour identifies a driver better (rule 1).
- RESTYLE ONLY, no DOM change, for the rest. entity(), .lnk, .ent: ink underline. foldRows / .foldbtn: the dashed accent button becomes a mono 'SHOW ALL n' with a hair rule. exportRow / .getout. loading / .skel: shimmer on --paper-2 and --faint; .skel.says kept. .empty: dashed box → 1px --hair. .modal: radius 16 + blur → square, ink border, 6px offset shadow like .rp. #tt: ink ground kept. .btn, inputs and selects: square, grey-2 border, ink focus. .setgroup / .setrow: DOM untouched for settings_page_layout. .depform: 44px targets kept. .rangepanel: daterange.js DOM unchanged, styled as b.css .rp (mono chips, ink when selected, disabled months shown faint). .insight-row, .dircard, .breakcard: ruled rows.
- NEW SHARED COMPONENTS in ui.js, additive and opt-in. glance(host, tiles) and glanceTile({label, value, unit, channel, hero, delta, spark, sub, na, to|cohort, key}): each tile emits class='kpi tile', 'l t-l' and 'n t-v', so every test that finds .kpi and .kpi .l still works. delta(v, {invert, unit, of}): built on semanticOf. spark(values): moved from m/ui.js into charts.js so both shells share it. swatch(key), chanChip(key), rowMark(key). highlight(node, token): budgeted. secHead(idx, name, note). absenceBand(host, cells). pageFoot({basis, colophon}).

### Charts

- COLOUR BY NAME, never by index. Every channel series asks channelOf(name), which resolves to --c-*; an unknown name gets --grey. CHANNEL_ORDER is fixed at Uber → Bolt → Yango → Hotel → CABMAN → FMS for stacks, grouped bars and legends. Fleets get no hue.
- A SERIES THAT SPANS SEVERAL CHANNELS IS DRAWN IN INK (or graphite), never in a channel hue. The mockups draw fleet aggregates in Uber blue only because on 2026-09-16 'the booking table is exactly the Uber feed'. Live #overview now says Uber is 91% of the work, so copying the blue onto an all-channel series would claim the other 9% are Uber.
- CVD VALIDATION already done by the design (PALETTE-EVIDENCE.md, dataviz validator against #FFFFFF). A1, six identities adjacent: worst CVD ΔE 8.6 (Yango↔Bolt, deutan), normal-vision 16.1 (Bolt↔Uber), exit 0. A2, all pairs: identical, so scatter, map and small multiples need no faceting. A3, the semantic pair: CVD 8.6, normal 28.0. A4, six channels plus both semantics, all pairs: pass (CVD 8.6, normal 16.1). B1–B6, ramps: dL 0.065, hue spread ≤1°, light ends ≥2.04:1. Darkening ramps were rejected: 6 of 44 channel×semantic pairs failed, worst CVD 3.0. This ends the live collision, where Bolt's green sat at 1.06:1 from --good and Yango's red at 1.04:1 from --critical. 8.6 is a pass with little margin, so direct labels are mandatory on adjacent forms and on every Bolt, Hotel or FMS mark (3.38–3.42:1 on paper).
- L3 IN CODE. A semantic colour is never an area fill inside an SVG plot group. No channel hue ever goes on a delta chip or arrow. Text never wears a channel colour; a swatch sits beside it instead. The hbars negColor default '--s2' for deductions becomes ink with a − sign, not red, because a deduction is not 'worse'.
- MARKS. Bars ≤24px thick, 4px rounded data-end, square at the baseline (today rx:3 rounds all four corners). A 2px surface gap between every pair of touching marks (stackedBar today uses rx:2 plus a 1px gap). Lines 2px with round joins. Markers r≥4 with a 2px surface ring (scatter's r 4.5 at 0.6 opacity becomes solid). Area fill at 10%. Gridlines hairline and solid in --faint; the two dashed reference lines at charts.js:581 and :875 become solid. Axis ticks in mono --t1 in --grey. Never a dual axis. Figures stay exact: the live app already never abbreviates, and that is kept.
- ABSENCE IS DRAWN THE WRONG WAY ROUND TODAY. gapBars hatches an UNCOLLECTED day and draws today's in-progress bar with a dashed outline. SPEC §5 says the opposite: not measured = OUTLINE (1px solid grey-2, no fill, same 4px end); unfinished or projected = HATCH in the series' own colour (45% opacity, 45°, 4px pitch). Swap both. In the SAME commit, rewrite every caption that names the treatment: app.js:910, 1052, 1327, 1422; causes.js:141; driverrecord.js:443; vehicle.js:215; forecast.js:532; and gapBars' own 'drawn as a hatched band' at charts.js:500. A caption saying 'hatched' over an outline gives a reason that is not the true one.
- donut(): 22 calls in 8 files, and no mockup draws a ring. Keep the signature (label, value, onClick, clickable, colorFor, max, the tail fold to neutral). Render it as ranked horizontal bars with row markers and the share printed, so clicks still filter. chart_fit (svg.donut, .dnut-keys) and platform_share_once (its svg.donut query) are updated in the same change.
- hbars: no track background (the midpoint rule stays as a ruler), bar ≤14px with a 4px end, value in mono on the right, a channel row carries its gutter marker, the default fill is ink. heatmap: blue SEQ becomes graphite via sequentialOf; a no-reading cell becomes an outline; the legend is a neutral strip with labelled ends. areaChart and the rating spark: 2px line, endpoint label only.
- MAP PINS (map.js). Today: engaged --s3, moving --s1 or --b300, parked --s5, stale --ink-3 at 0.45. Proposed token swap only: engaged, available and idle take the ramp steps; stale takes the absence outline. SPEC §3.4 says CABMAN and FMS on one map should appear at identity only, one ramp per plot area. That would drop the state colours an operator reads the live map by. Flagged for the map page, recommending state stays (rule 3).

### Shell: rail, header, control bar, credential banner, freshness

- ORDER on the page, all inside #app (so the phone's html[data-ui=phone] #app{display:none} still hides every piece): masthead → section row → view row → #authBanner → control bar → today strip → title block → #view → footer. Every id is kept: #nav #sectabs #authBanner #filters #fRange #fGrain #fPlatform #fFleet #refreshBtn #zenBtn #tzNote #themeBtn #settingsLink #freshness #todayNow #crumb #viewTitle #viewSub #view #tt #m.
- THE RAIL BECOMES THE SECTION ROW (b.css .nav-sec). renderNav() emits the same 7 SECTIONS as a > .ic + .lb, with the icons hidden by CSS; the SECTIONS literal is unchanged because nav_sections matches it by regex. #settingsLink moves in as the last item, labelled 'Set up', with its id and href='#settings' intact. This gives back the 236px the rail takes at every width. Below ~900px the row scrolls sideways with an edge fade.
- SIDEBAR FRESHNESS IS KEPT (#freshness links to #sources: 'updated 13:45 · 7 sources need attention · oldest: ledger, 721h ago'). It moves into the section row's right-hand slot. REJECT the mockup's static 'Uber · Hotel · Bolt · Yango' in that slot: it is an unmeasured list. freshness()'s inline style='color:var(--warn)' becomes a negative dot with ink text.
- MASTHEAD: the wordmark 'Fleet' (Fraunces, the only serif on the page) and 'ECOSINE & EGARI · DUBAI'. ADD the window on the right, visibly: windowLabel() plus 'Dubai time', and windowDates() for rolling or explicit windows. For a calendar period the server resolves the bounds, so only the label is printed, never dates the client cannot vouch for. On hidesRange() views it says no window applies. Today this information lives only in #tzNote's title, and 'Dubai time' is hidden from any reader whose clock is already in Dubai.
- #sectabs BECOMES THE VIEW ROW (nav-view). Same items, same lit logic including DRILL_PAGE. The current page is shown in ink weight with a 1px ink underline. b.css's --signal red underline is retired, as tokens.mjs already requires.
- CONTROL BAR. #filters leaves the topbar and becomes .ctl directly under the banner. Kept: the same six controls, and the same setDisp per-view hiding (nav_sections pins the exact setDisp('#fGrain', lost || hidesRange(state.view)) line). The platform select keeps its 'FMS telematics' option, which the mockup omits: REJECTED. Its options may reorder to CHANNEL_ORDER. Controls become square mono selects with ▾, and #themeBtn joins them as an icon button. ADD a .applies sentence stating which controls do not apply here and why, derived from the NO_FILTER, NO_RANGE and NO_PLATFORM_FLEET lists in data.js; today a hidden control just vanishes. The bar is sticky at top:0 (≈50px), replacing the 148px sticky topbar, so the window stays reachable while scrolling.
- TITLE BLOCK (#crumb, #viewTitle, #viewSub) KEPT. The mockups drop it: REJECTED. setHeader's per-view titles, the crumb's drill-back path (Drivers / name / day) and render-audit's wrong-title check all depend on it. Restyled: crumb in mono --t2 caps, h1 in Karla 600 --d3, sub in --t6 grey on one line, sitting at the head of the page above 00.
- CREDENTIAL BANNER (authBanner). Unchanged: the /api/auth fetch, the severity logic, the ERRAND_HEAD, ERRAND_PART and NOUN_OF text, and the classes (.authbanner plus stopped, at-risk, degraded or pending; .ab-head; li). Restyled per authbar.css. stopped: --w-neg ground, 3px --sem-neg top rule, solid dot, every word in ink (15.27:1). at-risk: paper ground, 3px negative rule, HOLLOW dot. degraded and pending: --paper-2 ground, grey-2 rule, grey dot, never red (the test asserts pending bg ≠ stopped bg). Each li becomes the 4-column grid who · key · detail · when. ADD: a channel swatch on 'who' via channelOf(provider); the surface under the key (rows[].surface is on /api/auth today, e.g. 'fleet-integration getDrivers'); and a meta cell reading 'as of HH:MM Dubai' plus a 'Set up → credentials' link to #settings. The time is the latest rows[].checked_at, not the page clock.
- TODAY STRIP (todayNow). Unchanged: the data, the no-store fetch, the tripValue, moneyHalves, wiredNote and FARES_LAG sources, the host (id='todayNow' class='todaynow' hidden), and the .tn-now, .tn-dot and .tn-f classes that today_band pins. Restyled as the livebar: a lede with a dot (ink, pulsing on opacity, no accent); each figure a cell of value, mono label and sub-line between hairlines. Trip value carries the chrome-scope emphasis (a rule and a weight step, no wash), which does not count against the page's highlight budget. ADD visibly: the scope caption 'Both fleets, every channel — this strip does not follow the filters above', and the note row (FARES_LAG, the projection basis, wired-but-not-counted) that today lives only in host.title. The title string is still built, because today_band asserts the lag ? `\n\n${FARES_LAG}` line. The notes sit in a <details> that starts closed, to protect the fold.
- ZEN MODE (data-zen, 'f' and Esc, ?zen=) is kept. It hides the masthead, section row, view row, today strip and the sub-line, and keeps #authBanner and the control bar, following the reasoning already written in app.css. The print rules hide the navigation, control bar and strip as they do today.
- THEME: the #themeBtn cycle system → light → dark is kept (see the dark-mode risk).

### Page contract

- 00 · AT A GLANCE → glance(host, tiles). A 6-column grid so 4, 5 or 6 tiles share one rhythm. The hero spans 2 columns at --d6 and carries the page's one counted highlight. Each tile is label (with a swatch when it belongs to one channel) / value / delta / sparkline / sub. Opt-in per page; pages not yet converted keep kpiRow, restyled. A figure that cannot be measured prints its REASON in the value slot (.t-na, via na:'…'), never a bare '—' and never 0.
- NUMBERED SECTIONS → secHead(idx, name, note) for hand-built bands, plus the CSS counter on panel h3. The hero chart is simply section 01, an ordinary panel(), so no new chart type is needed.
- † WHAT THIS PAGE DOES NOT KNOW → absenceBand(host, [{label, fig | none, why}]). A 4-cell band: figure in Karla 600 --d5 in ink-2, the why at reading size (--t5) in grey. At most one highlight, on the figure that sizes the gap. Never drawn in a semantic hue (L5.9). The page plans supply the cells from what each page already explains in notes and subs.
- PRINCIPLE FOOTER → a shell-level <footer> after #view. It prints the fixed sentence 'A figure that cannot be measured is shown absent, with the reason — never as zero.' on every page with no per-page work. pageFoot({basis, colophon}) lets a view fill the basis paragraph and the right-aligned mono colophon; sourceLine() output moves into the basis and keeps .srcline, which page_numbers reads. The footer is cleared on every render.
- HIGHLIGHT BUDGET → highlight() refuses a 4th highlight per page and a 2nd per band, never runs inside svg or tbody, and never touches an absent figure (L4). Enforced at run time and by a new render-audit check.
- DELTA → delta(value, {invert, unit, of}) built on semanticOf. Better = ▲ + green; worse = ▼ − red; no change = grey –; always a screen-reader word too. invert is for measures where down is good: cancellations, unauthorized trips, cost per km. A null renders 'not measured'. The question NEW-PAGES §4 left open, whether a LEVEL or a gap may sit in the delta slot, needs a ruling before pages start doing it.
- The prose budget (≤120 body words outside the absence band) and the 'no table that repeats a chart' rule are page-level decisions for the per-page plans. They are bounded by rules 1 and 3: working tables stay.

### Phone shell

- The phone app (m/app.js, m/screens.js, m/ui.js, m/m.css) is a separate shell that loads instead of the desktop one, and the design defines no phone shell. Plan: restyle through tokens only. m.css reads app.css custom properties, so the generated :root repaints it. No screen, tab, sheet or flow changes: deposit entry, the call list and the today card stay as they are (rule 3).
- m.css specifics. The Fraunces figures in .m-lede and .m-stat → Karla 600 proportional. --m-r 14px → 4px. Kept: the 40px circle icons, 44–48px tap targets, the bottom tab bar, and the bottom-sheet range picker. .m-lede and .m-stat good/warn/bad → a semantic dot with ink digits. .m-err and .m-stale → the negative and neutral forms from the banner mapping. The undefined --card, --line, --sunken and --muted references are defined or replaced.
- A narrow desktop window (the desktop build under 820px). The section and view rows scroll horizontally with an edge fade. The window label wraps under the wordmark. .ctl wraps. The glance goes from 6 columns to 2, then 1. The table-to-cards rule at 560px and below (payout_mobile) is kept, and html{-webkit-text-size-adjust:100%} is added.
- Theme on the phone: index.html's pre-paint data-theme stamp is kept. The theme-color metas and the manifest colours move to Arkiv paper and ink.

### Kept exactly as it is

- Every route and hash address. VIEWS (57 rows), SECTIONS (7), DRILL_SECTION, DRILL_PAGE, COHORT_SECTION and sectionOf(). Settings stays out of the section list.
- All filter behaviour: the range picker (three kinds of window, each clearing the others), grain, platform and fleet, per-view control hiding, filters carried in the URL, refresh, zen (f and Esc, ?zen=), and ?ui=phone|desktop.
- setHeader's title, sub-line and crumb for every detail view, and the wrong-title guarantee that render-audit checks.
- authBanner's severity model, its errand sentences, the quiet pending and degraded tones, and the re-read after a settings save.
- todayNow's figures and its honesty rules: the ≈ estimate flag, absent before the first booking, never following the filters, no-store fetch keyed by the minute.
- freshness(): distinct sources rather than rows, realtime feeds excluded from the headline, the oldest batch source named, the link to #sources.
- tableFrom: sort in the URL, nulls last in both directions, sticky headers, the pinned identity column, row folding with counts, scroll cues, phone cards, markTall.
- kpiTile's cohort links and 'Who exactly?', .long wrapping, the kpiCols tile-count grid, and the data-panel and data-kpi test keys.
- charts.js: chartBox sizing, axisGutter, niceTicks, xTickIndices, exact figures, click-to-drill, tooltips, aria names. Leaflet's lazy load and the .panel:not(.mapwrap) svg opt-out.
- The house principle, everywhere: absent with a reason, never 0.

### Order of work (shippable after every step)

- EVIDENCE, for reviewing this plan: uiplan/foundation/. It holds live-overview.png (1440×900, light), live-overview-dark.png, live-phone-overview.png, and crops of the overview mockup's chrome, middle and footer (mock-overview-top.png, mock-overview-mid.png, mock-overview-foot.png).
- STEP 0, S, no visual change. tokens.js, bin/gen-tokens-css.mjs and the tokens test. app.css gains the Arkiv custom properties ALONGSIDE the old ones. SOURCE_TOKEN starts naming --c-*, which the old skin aliases to its --ch-* values. Ship.
  - *As built, 2026-09-23 (branch reskin-foundation; details in FIX-STATUS.md "Arkiv reskin, STEP 0").* STEP 1 needs to know four things. (1) The Arkiv values are already in app.css, generated under `:root[data-skin="arkiv"]` and placed after the old dark blocks. STEP 1 only has to stamp `data-skin="arkiv"` before paint. arkiv.css then re-points the old names (`--surface*`, `--rule*`, `--accent*`, `--s*`, `--b*`, severity) and carries no hex. (2) The collision needed one change to "NAME COLLISION" above. The old skin prints secondary text in two greys, so one name could not keep its look. Old `--ink-3` became `--grey`. Old `--ink-2` became `--grey-strong`, which the generated block folds onto `--grey` (tokens.js `BRIDGE`). When the old skin is deleted, `--grey-strong` → `--grey` is one rename. (3) `.depchip.on` and the phone's `.m-btn.primary` use `--on-accent`, not `--paper`, so light mode stays white. (4) No dark Arkiv set exists yet. Under the attribute, the light values win in both themes.
- STEP 1, M. A skin switch: arkiv.css loads after app.css only under ?skin=arkiv, remembered in localStorage and stamped pre-paint like ?zen and ?ui. It carries the token values, the typography and every component restyle (panel, kpi, tables, pills, notes, verdict, tabs, buttons, inputs, banner, strip, range panel), with NO DOM change. Production keeps the old look, and the operator compares both on production. Add arkiv.css to type_scale's scan. Verify with npm test (one run), render-audit across its five windows, and production screenshots at 1440 and 390.
  - *As built, 2026-09-23 (branch reskin-foundation; details in FIX-STATUS.md "Arkiv reskin, STEP 1").* What later steps need to know. (1) The switch is `?skin=arkiv` / `?skin=classic` / `?skin=auto`, stored as `fleet.skin`. index.html stamps `data-skin` in the pre-paint script, and a second inline script `document.write`s the `<link>` straight after app.css. That makes the sheet parser-inserted, so it blocks the first paint and wins ties by order. A script-appended link does neither, and was measured as such. (2) Every rule in arkiv.css is scoped to `:root[data-skin="arkiv"]`, and the file has no hex. The old colour names are re-pointed there, as STEP 0 planned. tokens.js `BRIDGE` still carries only `--grey-strong`. `--s1..--s8` are distinct NEUTRAL steps (the review's correction), not ink: s1..s8 = seq-5, seq-0, seq-1, seq-4, seq-0, seq-3, grey-2, grey. STEP 2 replaces them caller by caller. (3) The labels in the dominance bar stay INSIDE its segments (rule 1: the leader's share is printed nowhere else), in paper or ink per fill, and every pairing measures ≥ 4.5:1. That is a deviation from "every label moves into .domb-keys". (4) Not in STEP 1, on purpose: the shell's structure (STEP 4); the charts, the hbars track, the donut and the heatmap (STEP 2); `pill.plat` stays neutral until `chanChip()` exists; the Fraunces preload swap and the theme-color metas (at the flip); the phone's own m.css pass (STEP 5). The phone repaints through the tokens only. (5) **No dark Arkiv values.** Under the skin, `color-scheme` is light and the page is light in every theme state. The theme toggle still changes the old skin, and under Arkiv it does nothing visible until the dark set lands (ruling 3).
- STEP 2, M. Charts: colour by name, the mark specs, the outline/hatch swap together with its 9 caption rewrites, donut rendered as bars, graphite heatmap. This JS works under both skins through the token aliases. One commit per chart function, each shown with a screenshot, and each fix proven by reverting it and watching its test fail.
- STEP 3, M. The page-contract components in ui.js (glance, delta, spark, highlight, secHead, absenceBand, pageFoot), the shell footer with the principle line, and the four new render-audit checks. One pilot page (#overview) adopts them under the skin.
- STEP 4, L. Shell restructure, gated on the skin attribute: masthead with the window, section row with Set up and freshness, view row, sticky .ctl with the .applies sentence, the livebar layout, the authbar grid (surface, swatch, as-of, settings link), and the title block. The default shell is untouched until the flip.
- STEP 5, M. Flip the default to Arkiv; delete the old CSS one release later. The phone repaints through the tokens, then gets its m.css pass. Update the manifest and theme-color metas. Dark mode is settled here (see risks) before or with the flip.
- STEP 6, L overall. Per-page adoption from the per-page plans: one page per commit, production screenshots at 1440 and 390, an AUDIT.md pass entry, and a FIX-STATUS.md row. New traps go in COVERAGE.md: the class-name collisions, the two meanings of --ink-2, the hatch/outline inversion.

### Risks

- DARK MODE. The live app has one: system/light/dark via applyTheme, a pre-paint stamp on the phone, two token blocks. The design is validated against #FFFFFF only and defines no dark set. CABMAN #6B259F and the ink-on-wash pairings cannot be reused on a dark ground. Options: (a) solve an Arkiv-dark set with the same validator in dark mode before the flip (M); or (b) ship Arkiv light only, with the toggle saying dark is not available yet. (b) removes a working feature, so it is the operator's call. Never keep the old dark palette under the new skin: that would be two colour laws.
- WARN / AMBER. The colour law has no warn tone. The 34 warn tiles, 27 warn pills and the at-risk banner need the proposed hollow-negative-dot form, or a different ruling.
- LEVEL vs DIRECTION. The live KPI tones print ▲/▼ on a judged LEVEL (e.g. 96% completion); SPEC reserves arrows for signed deltas. NEW-PAGES §4 left the level-in-the-delta-slot question open.
- CLASS COLLISIONS. .cap (332 uses), .num, .lab, .sub, .sec, .tag, .chip, .sw and more. A verbatim import of b.css or viz.css would restyle hundreds of sentences as 9.5px mono caps. --ink-2 also means two different things in the two systems.
- HATCH vs OUTLINE are inverted relative to SPEC. If the captions do not change in the same commit, they state a false reason.
- The mockups paint fleet aggregates Uber blue on a 2026-09-16 data fact that is no longer true: the booking table was the Uber feed then, and live now says Uber is 91% of the work. The per-page plans must not copy those fills.
- THE FOLD at 1440×900. The new chrome is about 380px before 00: masthead 72, section row 40, view row 36, control bar 50, strip ~110, title ~70. Today's 3-row banner (~200px, measured) lands the glance tiles at roughly 640–790px, and open notes would push them past 850px, which is why the notes start closed. For comparison, live #overview today puts its first KPI at ~800px, under a 230px verdict (measured).
- MAP. SPEC §3.4's one-ramp-per-plot rule conflicts with the live map's four-state pins; resolve it on the map page, keeping state. PALETTE.html labels the third ramp step 'idle / offline', but SPEC §3.3 says offline is not a ramp step. Follow SPEC on #online-time and #live.
- tokens.mjs is a RECONSTRUCTION: the original gen2/tokens.mjs was lost. Its 43 hexes are verified against the 44 pages, but viz.mjs, the design's chart builder, never existed here. Every chart rule is reimplemented in charts.js, not ported.
- SCALE OF CHANGE. 287 panel(), 171 tableFrom(), 72 kpiRow(), 320 note() and 131 pill() call sites. Without the skin switch, every commit changes every page at once and cannot be verified on production before users see it, which CLAUDE.md requires.

### Tests that pin what changes

- type_scale.test.mjs: no literal font-size in app.css or m.css, every --t/--d step used, steps ≥6% apart. --d6 must be used somewhere, and any new stylesheet (arkiv.css) has to be added to its scan.
- today_band.test.mjs: regexes on index.html (id="todayNow" class="todaynow" hidden); on app.js ('freshness(); authBanner(); todayNow();', 'host.hidden = true', the lag ? `\n\n${FARES_LAG}` line); and on app.css (.todaynow rules hex-free for 1400 characters; the exact reduced-motion rule for .todaynow .tn-dot).
- routes.test.mjs: '#nav a{' and '#nav a .ic{' in the CSS, <span class="lb"> in renderNav, id="crumb", the .panel:not(.mapwrap) svg rule, no blanket svg rule, the .hb .fill{, .hb .track{ and legend-swatch rules, and hbars emitting class="fill.
- nav_sections.test.mjs: the SECTIONS literal's shape and a count of 4–8; #settingsLink with href="#settings" in index.html; the exact setDisp('#fGrain', …) line and its 'Still set BOTH ways' comment; no #nav .grp; no module reprinting its view's label or sub-line.
- auth_banner_pending_ui.test.mjs and credential_errand.test.mjs: the banner's tone classes, .ab-head and li text, pending bg ≠ stopped bg, and the slice of app.js from const ERRAND_HEAD up to async function authBanner.
- spacing.test.mjs: at least 10px between sections (panel, pbody, note, kpis, tblock, tscroll…) on 116 routes. Arkiv's ruled grids with no gutter must still leave 10px.
- chart_fit.test.mjs: the .kpis --kpi-n column count, and the donut's svg.donut and .dnut-keys alignment, which changes when donut becomes bars. chart_geometry.test.mjs: charts drawn at box size with axis labels inside the panel, which the gutter must keep true through any tick-font change.
- platform_share_once.test.mjs: the .domb-bar, -seg, -key and -total classes and its svg.donut query. kpi_pill.test.mjs: a pill value must fit its tile at 1180px, and Karla and mono measure differently.
- driver_standing.test.mjs asserts `const tone = sn.tied ? '--s1'` in desktop code. Retiring --s1 means moving that assertion to the new token in the same commit.
- The table tests (sticky_header, pinned_identity, scroll_cue, fold_rows, absent_columns, payout_mobile) must stay green through the restyle. The pinned cell needs an opaque --paper background once the zebra stripes go.
- Class and text hooks. capacity_headline, caption_matches_figure, corridor_denominators and live_day read .vdct-claim, -sub, -fig b, -fig i, -meta and .kpi .l. money_contradictions and driver_fares read .kpi. page_numbers reads .srcline. person_address reads .idcard .pill. driver_empty_window_page reads .idcard, .kpi and .note. cash_value_caption, source_value, safety_cap, unit_ranking_gate, trip_own_money and compare read .panel and .panel h3 text. unauthorized_attribution_page and collection_debt read .tag. payout_page_reconcile reads .note.err and .note.warn. avatar_lost, insight_named and driver_photo read .av and av-lost. settings_page_layout needs the setgroup/setrow DOM and a monospaced key. driver_money_tab reads .tabs a, performer_week #crumb, calendar_window #fRange.
- phone_render, phone_today_only, phone and phone_clock: #app must be display:none on the phone, so all new chrome has to live inside #app.
- assets.test.mjs: every preload is woff2 with crossorigin and named in fonts.css. Any new stylesheet must come from the same origin.
- audit_tools_detect.test.mjs and bin/render-audit.mjs: wrong-title reads #viewTitle. Each new check (highlight budget, grey-2 used as text, a colour outside the tokens, a semantic with no glyph) needs a stub the tool catches and one it passes. smoke_views.mjs: every route must render under the new shell.
- No test pins contrast today; the only hit for 'contrast' is a comment. Add a tokens test: tokens.js lintTokens() returns [], the generated :root matches tokens.js, text tokens clear 4.5:1 (grey 5.15), and grey-2 is flagged rules-only.

### Review corrections to the foundation (adopted)

- **The accent bar becomes a caption in grey text** — Operational warnings, such as the #trips unpriced-but-charged warning, the #insights truncation note and #notfound, lose their salience. **Adopted:** err and warn notes keep ink text as well as the negative dot.
- **CAT resolves to ink, and the default flips at STEP 5 before the per-page work in STEP 6** — donut and stackedBar pick segment and swatch colours by CAT index (charts.js:655, 684, 929). On production every segment in overview's outcome bar, the settlement mix and corporate's settle bar would draw in the same ink. **Adopted:** Convert the stackedBar and donut callers in STEP 2, or have CAT resolve to distinct sequential steps until they are converted.

### Also required (found missing by the review)

- Shell id #fRangeLabel (the range button's label, app.js:7215) is not in the foundation's list of ids to keep. test/calendar_window.test.mjs reads it.
- api/public/sw.js SHELL_FILES is a hand-written list (sw.js:47-60). tokens.js, which ui.js and charts.js will import and which the phone reaches, has to be added to it, and so does arkiv.css if the phone loads it. The file's own comment records that a module left off the list gives a broken shell on a cold offline open.
- On the phone, m/screens.js fallback() (l.2103-2121) renders the desktop driver.js and vehicle.js tabs inside #m. So glance, absenceBand, secHead and the tabBar restyle must also work in m.css. pageFoot writes into the shell <footer>, which sits inside #app and is hidden on the phone, so .srcline and the basis line would disappear on the phone's driver and vehicle tabs.
- The phone screens (today, money, people, fleet, live, safety, unauthorized, sources, corporate, analyst, credentials, optimise, trips, online-time, payouts, driver, vehicle) have no plan beyond 'tokens only'. Only deposits/phone has an entry.
- The foundation's list of captions to rewrite for the hatch/outline swap is incomplete. It misses causes.js:230 (a visible caption: 'Hatched columns are months we hold no data for'), app.js:1398 ('draws its bar hollow'), driverrecord.js:506 ('drawn hollow' under How to read this), and gapBars' own captions at charts.js:477 ('Drawn hollow, because a part-week…') and :485/:457. Part-period buckets (performance.js:397-400, driverrecord) are drawn hollow too and must also become HATCH, not only today's bar.
- The --ink-2/--ink-3 rename counts only var() in JS (about 14). It misses 11 bare '--ink-3' string arguments (app.js 2, charts.js 3, forecast.js 3, map.js 3) and 21 var(--ink-2/3) uses in m/m.css.
- Moving spark() from m/ui.js into charts.js breaks test/phone.test.mjs, which greps the m/ui.js source for the zeroBased spark code. That test is not in tests_at_risk.
- The stale-render guard belongs in the foundation, because render() reuses #view for every page. Confirmed: coverage.js:289 awaits with no alive(gen) check, and supply, causes, forecast, optimise, capacity, day, slot, trip and trips have no guard at all (only app, corridors, coverage, driver, driverrecord and payouts call alive). It has to land before any page reorders its sections.
- People A needs a paired-header option in tableFrom; the foundation's component list has rowMark only.
- Dark mode: no page plan gives dark values for the channel identities, washes or hatch. A ruling is needed before STEP 5.
- No front-end test covers #receipts (the finance plan notes this). The per-kind split and the first-seen absence need one.

## 4. Every page

### Today

#### `insights` — effort L

*Today:* The landing page. It has 5 tiles: Open actions 202 (405 cleared since the last run), Critical 148 and Warnings 54 (each links to #insights/severity/<level>), Measured cost AED 389, and Idle capital modelled AED 21,840 with its assumption. Under the tiles: a row of filter chips that are real addresses (All, 6 categories, 2 severities), a truncation note ('first 200 of 202'), a verdict sentence, and the Ranked actions list. Each row carries a severity tag, title, action text, the names involved, entity/fleet tags, the metric and the AED (modelled ones starred) and opens #action/<code>/<entity>. 6 rows show, then 'Show the other 194'. Under the list is the 'What Uber is asking the fleet to fix' table: 7 columns, sortable, with an on-target verdict.

**Change**

- Section order: 00 At a glance (verdict headline plus the 5 live tiles, Open actions as the one hero), then the chip row, then 01 Ranked actions directly under the chips, then 02–07 supporting charts, then 08 What Uber is asking (table), then 09 absence band, then the source line
- Tiles become Arkiv tiles: label, value, sub. The err/warn/ok tone borders and the ▾/• glyphs go (the colour law allows red/green only on better/worse deltas). The Critical/Warnings href stays. The highlight is used once, on Open actions.
- In list rows, severity tags become neutral ink chips (critical filled, warning outlined) rather than red/amber. Row AED loses its --critical/--warn colour. Modelled figures keep the '*' and gain a hatch swatch.
- Ranked-action boxed cards are restyled as hairline-ruled rows with the same 3 columns and the same content
- Uber targets table: same 7 columns, restyled to hairline rules. The 'on target/below target' pill becomes ▲/▼ text with sign where it is a comparison.
- FIX (rule 4): missingTarget() at app.js:86 does Number(null) → 0. Uber's TRIP_COMPLETION row (org_value null, target_value null) therefore renders 'ON TARGET', and the caption says 'All 3 current targets are being met'. A null on either side must render 'no target published', and the caption must count only rows with both figures.
- FIX (rule 4): 'Measured cost AED 389' is cancels × average fare × 0.3 (src/insights.js:835). The 0.3 is an assumption, yet api/server.js:4264 marks every impact except idle_vehicle as 'measured'. Either classify cancellation_rate as modelled with its assumption, or state the 30% on the tile.

**Add (from the redesign, with its data source)**

- Findings stored (607) as a sub-line on the Open actions tile, next to '405 cleared since the rules last ran', in neutral ink rather than green (the mockup's own absence cell admits nothing records whether a person acted) — *source:* /api/insights/summary .stored_rows, .resolved_since_last_run
- Section 02 · By category over all open findings: a ranked bar per category. Each bar is an address to #insights/<category>. — *source:* /api/insights/summary .by_category (complete, 202)
- Section 03 · What is open, by kind: ranked bars per rule code. A 3px channel marker appears only where the finding names a channel or feed (entity_type platform/source); rules that name no channel show none. — *source:* needs a by_code GROUP BY on /api/insights/summary. The 200 served rows are capped (202 open), so without it the chart is partial and must say so. — **needs a new endpoint**
- Section 04 · What it costs to ignore: modelled bar drawn HATCHED (13 cars × AED 1,680 = AED 21,840), measured bar (AED 389), and 'never priced' as an OUTLINE with its reason — *source:* /api/insights/summary .modelled, .total.measured_impact, .total.n. The count of priced findings needs a priced_n field; without it the outline count is over the served rows.
- Section 05 · Cars off the road, by date: cumulative line of vehicle documents by days left, 0 to 45 — *source:* /api/compliance/vehicles rows[].days_left + totals (within_7 7, within_45 23). A complete set.
- Section 06 · How old the licence backlog is: histogram of days past expiry — *source:* /api/insights?code=licence_expired (100 rows, truncated false). metric = days to expiry. The caption must state the basis: #compliance counts 88 expired drivers against these 100 findings.
- Section 07 · The cars nobody can see: ranked bars of hours since the last fix, per plate — *source:* /api/insights?code=stale_tracker (17 rows, complete), metric = hours. Colouring by FEED needs src/insights.js to write r.source into refs, because the feed appears only in the detail prose. Parsing the prose is rejected. — **needs a new endpoint**
- Absence band, 4 cells: findings carrying a cost (N of 202, why the rest are unpriced), who cleared the 405 (no actor/ack field), which feed raised a compliance item (none: a date passing raises it), and the 30% assumption inside the 'measured' cancellation cost — *source:* summary + src/insights.js rule source

**Keep**

- The Ranked actions list, row for row: severity, title, action, names line, entity/feed/fleet tags, metric and AED with the modelled star. Each row links to #action/<code>/<entity>. The 6-then-fold is kept. The mockup has no list at all.
- Filter chips as addresses (#insights/<category>, #insights/severity/<level>) and the 'Filtered to … Show everything' line
- The Critical and Warnings tiles as links to their filtered lists. The mockup folds them into a sub-line and loses the one-click route.
- The 'Showing the first 200 of N' truncation note
- The 'What Uber is asking the fleet to fix' table (7 columns, sortable) and its count sentence
- The verdict sentence ('148 things need doing today … the one at the top: …'), restyled as the headline of the 00 band
- The 'Built from the whole record' source line

**Leave structurally untouched (restyle only)**

- Ranked actions list: structure, server order (most severe first), per-row click-through to #action, and the fold. This is the operator's daily work queue.
- Chip filters as URL addresses that refetch per facet (a correctness fix: client-side filtering over the 200 cap showed a partial category)
- Uber targets table columns and sort behaviour

**Not adopted from the mockup**

- Replacing the ranked list and chips with charts only. Rules 1 and 3: the list is the operational view and the mockup has no way to act on a finding.
- Folding Critical/Warnings into a hero sub-line. This loses the two one-click filtered lists.
- 'Trip volume · Aug 2026, −42.2%' tile: it is one of the 202 rows (volume_trend), its counts exist only in prose, and it belongs on #demand
- Green 'better −370' chip on cleared findings: colouring a closure as good news claims a cause the payload does not record
- 'Safety items served 0 of 5' and the other mockup figures (228 open, 598 stored, 17 cars): these are 15-Sep data and are stale. Today all 4 safety items are inside the cap. Every figure must be read live.
- Credential banner rows as drawn: they are data, not design, and the live banner must render whatever the API reports (cross-cutting)

*Tests that pin this page:* test/chart_fit.test.mjs (the #insights innerHTML kpiTiles path), test/kpi_one_tile.test.mjs (Critical tile keeps href #insights/severity/critical), test/insight_named.test.mjs (action list rows carry the first few names), test/imports_resolve.test.mjs (foldChildren import), test/spacing.test.mjs and test/smoke_views.mjs (routes_list.mjs renders 'insights')

#### `playbook` — effort M

*Today:* The page opens with a verdict ('8 things to do, worth AED 163,733 a month', figure 'over 23 days') and a window caption. Then 6–7 tiles: Things to do, Money already earned, Idle capacity, At risk if nothing is done, Vehicles earning 103 of 273, What a new driver produces 12, and Modelled upside only when a rate is set. Then a Revenue-per-booking input (stored locally, re-renders the page) with the assumption note. Then group panels Collect, Protect, Deploy, Cover, Improve holding 8 action cards. Each card has horizon/certainty/effort pills, the why, labelled figures, a 'How this was worked out' disclosure with basis and a linked evidence table, and 'Open the evidence →'. At the bottom: a red new-driver caveat and a sort-order note. Order is horizon, then certainty, never size.

**Change**

- FIX (unit): the verdict says 'worth AED 163,733 a month' with the figure unit 'over 23 days'. totals.aed_measured is receivables owed plus cash held (AED 31,687 + 132,046), a BALANCE rather than a monthly flow. It should read '8 things to do — AED 163,733 already earned and not yet in hand'.
- Section order: 00 At a glance (verdict headline; tiles with Money already earned as the hero), then the rate input with its note, then 01 Where the cars are, then 02 The arithmetic behind the ceilings, then 03–07 the group sections Collect/Protect/Deploy/Cover/Improve (cards unchanged inside), then the absence band, then the sort-order note
- Certainty pills lose their colours: CERT maps measured → 'ok' green and ceiling → 'warn' amber, which reads as good/bad under the colour law. They become neutral text chips; ceiling gets a hatch swatch (projection), measured a solid swatch. Horizon pill 'today' drops --critical red.
- Tiles: 'At risk' loses its critical red and 'Vehicles earning' its red/amber tone. Only the hero carries the highlight.
- The red new-driver caveat note (.note.err) moves into the absence band as the cell 'The ceiling is not a forecast', with its text unchanged and not in red
- Group panels restyled as numbered sections with hairline rules. Cards restyled as ruled blocks, with the same order of elements inside.

**Add (from the redesign, with its data source)**

- Section 01 · Where the fleet's cars are: 100% bar or 3 ranked bars for earned at least one booking / took no booking / moved but never earned — *source:* /api/playbook .fleet.earning, .still, .moved_only, .vehicles_seen
- Truth of the 'moved but never earned' segment. Today it returns 0, and the payload cannot say whether that is a measured 0 or 'the journey feed filed nothing in this window' (the mockup draws it as an outline for that reason). Adding fleet.journeys_in_window lets the bar render a 0 or ABSENT with the true reason. — *source:* api/playbook_routes.js fleet query (~line 70-90). One more count(*) FILTER. — **needs a new endpoint**
- The arithmetic behind every ceiling: 2 bars, median earning car (bookings per 30 days) against a new driver's first whole month (12), with the ratio — *source:* /api/playbook .fleet.median_bookings, .median_unit, .new_driver_first_month, .new_drivers_measured
- A Modelled upside tile rendered ABSENT WITH REASON ('no revenue-per-booking rate supplied — nothing is converted to money') instead of being omitted when no rate is set — *source:* /api/playbook .totals.aed_modelled null + .assumption.note
- Idle-capacity tile sub-line: the same ceiling at a NEW driver's rate (idle vehicles × new_driver_first_month), labelled a ceiling. This is a sub-line, never the hero. — *source:* /api/playbook redeploy_idle_vehicles.size × fleet.new_driver_first_month

**Keep**

- Every action card with all of its content: the 3 pills, why, labelled figures, the basis disclosure with its evidence table (plate/driver links, custody, days-left), the 'Showing N of M' and 'headline counts N' captions, and 'Open the evidence →'
- The group panels and card order (horizon, then certainty, never size)
- The Revenue-per-booking input and its assumption note (per-viewer store, re-render on change)
- The window caption stating the span and that widening it changes items and sizes
- Money and bookings-ceilings kept apart: Idle capacity (gain) and At risk (protect) remain separate tiles, never summed
- The Vehicles earning and What a new driver produces tiles, and the new-driver caveat text (content)

**Leave structurally untouched (restyle only)**

- Action cards and their evidence tables: this is a to-do list with drill-through links, so it is restyled only
- The sort order (horizon, then certainty) and the reasoning note under it
- The revenue-per-booking form and its behaviour

**Not adopted from the mockup**

- Hero '2,124 bookings' (177 idle cars × 12): a projection made the headline of a to-do list. The live page deliberately leads with measured money and warns that ranking by the size of a ceiling puts the least reliable item first. It is kept only as a labelled sub-line.
- Section 02 'What each job is worth' 4-up: it repeats the cards' figures in tiles, places ceilings beside money, and invites adding them
- Section 03 'papers that stop a car working' and 04 'twelve biggest cash balances' dot plots: they redraw 12 rows of evidence tables that already carry more columns and entity links
- Mockup figures (273 cars, 177 idle, AED 113,064): these are 15-Sep, 30-day data and must be read live
- Dropping the rate input, pills and 'Open the evidence' links (rule 3)

*Tests that pin this page:* test/spacing.test.mjs and test/smoke_views.mjs (routes_list.mjs renders 'playbook'), test/playbook.test.mjs, test/playbook_actions.test.mjs, test/route_smoke.test.mjs (only if /api/playbook gains fleet.journeys_in_window)

#### `overview` — effort M

*Today:* Fleet activity. A verdict comes first ('single-channel fleet — Uber is 91%', 755 bookings a day, with a comparison to the same span before when a calendar period is chosen). Then 7 linked tiles: Trips, Distance, Trip value, Money in (statement + fares + payouts, platforms named), Completion (count first, with rider/driver/declined/unsaid split), Vehicles, and Safety alerts. Charts: Trips per day (gapBars) with telematics journeys behind, uncollected days hatched, today hollow, and click-through to #day. Platform share is a donut whose slice click filters the dashboard and opens #platforms. Product mix shows the top 6 tiers. How fares settle is a donut of 8 settlement routes linking to outstanding money. Trip outcome is a stacked bar with every raw status word in the caption. Top drivers is a table of 12 people with 7 columns, sortable, driver and plate links.

**Change**

- Section order: 00 At a glance (verdict headline + 7 tiles with Trips as the hero), then 01 Bookings per day/week, then 02 Cancellations a day, then 03 Which channel (was Platform share), then 04 How every booking ended, then 05 What the fleet drove (tiers), then 06 AED per km per tier, then 07 How fares settle, then 08 Top drivers, then 09 absence band
- Trips-per-day bars drawn in INK, not blue. The bookings span 4 channels and blue is now Uber's identity.
- Telematics journeys behind the bars become an FMS-identity (#9974F5) step line with a direct label 'FMS journeys'. Today they are grey hollow bars, which under the SPEC reads as the ABSENCE outline.
- gapBars absence treatments swapped per SPEC §5: an uncollected day becomes an OUTLINE (1px grey-2, no fill), and today (unfinished) is HATCHED in the bar's own colour. Today it is the other way round. This is shared: charts.js.
- Platform share donut becomes ranked bars in channel identity (Uber #2362D3, Bolt cyan, Hotel, Yango magenta) with direct labels, counts and %. Click-to-filter kept on each bar.
- Trip outcome stacked bar becomes ranked bars (outcome buckets are not channels, so ink), with the raw-status caption kept
- How fares settle payment donut becomes ranked ink bars. The same 8 routes, counts, %, and outstanding link.
- Top drivers table restyled to hairline rules, with a channel swatch beside each channel name (never coloured text). Same 12 rows, same 7 columns.

**Add (from the redesign, with its data source)**

- A sparkline per tile: trips, completed, cancelled, revenue (priced) and km per day. Money in gets none, and its tile says why: statements are weekly, so there is no daily series. — *source:* /api/trips/daily (d, trips, completed, cancelled, km, revenue, priced_trips)
- Delta chips on Trips, Completion (in points), Trip value/fares, Distance and Money in, each with ▲+/▼− and the colour set by meaning (cancellations inverted). Basis stated as driver_day. — *source:* /api/compare/period .change_pct / .now / .before, fetched today only for calendar periods (state.period). On rolling windows the chip renders ABSENT with the page's existing reason.
- Section 02 · Cancellations a day: line of cancelled per day. Today excluded, because a part-day rate is not a day rate. — *source:* /api/trips/daily .cancelled / .trips
- Section 06 · What a kilometre is worth on each tier: bars of AED per km per tier, each with a channel marker, basis 'priced trips only, priced_n of n' — *source:* /api/mix .revenue_per_km, .priced_km, .priced_n per platform:tier
- Product mix shows all tiers (live slices to 6 of 18 and silently drops the rest), capped with 'N more tiers, M bookings' — *source:* /api/mix
- Trip outcome uses the finer kpis buckets: completed, cancelled by rider, cancelled by driver, offers not taken, cancelled unsaid, other, no outcome. These are the same expressions as the Completion tile and #cancellations. — *source:* /api/kpis completed_trips, cancelled_by_rider, cancelled_by_driver, declined_offers, cancelled_unsaid, other_outcome, no_outcome
- Caption under the hero chart: N days · total · mean per complete day · today so far · busiest day (labelled once, at the extreme) — *source:* /api/trips/daily
- Absence band, 4 cells with live figures: bookings carrying no distance (trips − trips_with_distance); bookings not yet priced and why (Uber priced from the weekly payments report walk, via UBER_FARE_WHY); days with a silent source (fleetVerdict partial/uncollected); why Money in has no daily series — *source:* /api/kpis, /api/trips/daily, ui.js UBER_FARE_WHY

**Keep**

- All 7 tiles and their hrefs. The mockup drops Money in, Vehicles and Safety alerts; Money in is the reconciled figure and stays.
- The verdict (claim, figure, recommendation, same-span comparison), as the 00 headline
- Trips per day: telematics journeys behind the bookings, per-day click-through to #day, gap handling, grain-aware title, and the 'last bar is today, still being collected' caption
- Platform share's click-to-filter (setFilter platform → #platforms)
- How fares settle: all 8 settlement routes with counts and %, and the link to 'what is outstanding, and from whom'
- Trip outcome's raw-status caption (every provider word and its count)
- Top drivers table: 12 rows, 7 columns, sortable, rank inside the name cell, entity links, ranking caption
- The Distance tile's 'avg over the N trips reporting one' basis, and the 'Built from …' source line

**Leave structurally untouched (restyle only)**

- Trips per day drill-through to #day and its grain rule (click only at day grain)
- Channel click-to-filter behaviour
- Top drivers table: columns, sort, rank-in-name, links
- The comparison fetch rule (period only) unless the operator decides otherwise

**Not adopted from the mockup**

- Drawing every mark in Uber identity with 'the booking table holds exactly the Uber feed' (15-Sep data): stale. Today the table holds Uber 15,854 · Bolt 747 · Hotel 690 · Yango 80.
- Dropping Money in, Vehicles, Safety alerts, How fares settle and Top drivers (rule 1)
- Absence cells 'Bookings the feeds hold and this page does not count 1,790', 'Journeys from the car: None' (16,830 telematics journeys this month) and 'Channels filing a payout statement 1 of 4' (Money in names 4): all stale, and would now be false reasons
- Tile deltas on rolling windows computed from compare/period without the operator's say. The live code's position is that the rolling comparison misleads, so those chips stay ABSENT with that reason unless the operator overrules it.

**Review corrections (adopted — they override the lines above)**

- *Data source corrected:* overview §06 'AED per km per tier': Uber fares come from a weekly payments-report walk, so a per-tier figure covers some weeks of some tiers. That is exactly the reason #platforms/tiers gives for rejecting it. At minimum each bar needs a 'priced n of N' basis, and the operator has to decide.

*Tests that pin this page:* test/page_numbers.test.mjs (#overview .kpi tiles labelled Trips/Distance/Completion match /api/kpis), test/caption_matches_figure.test.mjs (#overview restores filter controls #fRange/#fPlatform/#fFleet/#fGrain), test/calendar_window.test.mjs (#overview?period parsing and render), test/auth_banner_pending_ui.test.mjs (banner rendered on #overview), test/verdicts.test.mjs (fleetVerdict), test/phone.test.mjs (references gapBars today-hollow semantics; m/screens Trip value regexes), test/spacing.test.mjs, test/smoke_views.mjs

#### `compare` — effort M

*Today:* Two days, cut at the same Dubai minute. Toolbar: two date pickers (addresses), Swap, Today vs yesterday, and a cut/full toggle. Then a verdict and 7 tiles: Bookings 344 vs 365, Change ▼21 (6%), Drivers out with 18 started · 21 stopped, Completed, Cancelled, Distance, and Carrying someone (hours). Then the cut note, the day-B full-day line and a fares caption. Hour by hour: two bar rows on one scale, click → #day, busiest-hour caption. 'Who drove more, who drove less': every driver, 9 columns (bookings/km/on trip/waiting/first/cancelled/channels/vehicle), sortable, row → performer, new/not-out pills. By channel: 4 columns, one money column with stmt/ldg basis markers. Started and stopped: name lists with links and the night-driver caveat. 'Was everything collected?': last run, last success and rows written per source.

**Change**

- FIX (rule 4, false reason): the caption 'Uber's trip export carries no fare column at all, so money here describes the hotel, Yango and Bolt rows only' is false. Yesterday 331 of 365 were priced, Uber fares AED 17,869.68. Replace it with UBER_FARE_WHY and the per-day priced counts.
- Tiles: 'Change' merges into the Bookings tile as its ▲/▼ delta chip (the same figure). That leaves 6 tiles: Bookings (hero, delta), Drivers out, Completed (delta in points), Cancelled (inverted semantic), Distance, Carrying someone. The 'both days to 14:00' sub moves to the band's cut line.
- Day colours: day A in ink and day B in grey, not --b400/--b200 blues (blue is Uber's identity and these series span every channel)
- By channel: the FMS TELEMATICS row is labelled 'journeys, not bookings', or set apart under a rule. It is counted under a 'Trips' header today.
- Section order: 00 glance, then cut/basis line, then 01 Hour by hour, then 02 Cancellations by hour, then 03 Who drove more/less (table), then 04 By channel + Started/stopped (grid kept at g23), then 05 Was everything collected, then 06 absence band
- The stale pill ('506 H AGO', 'never succeeded') becomes plain ink text with the word 'stale', with no amber

**Add (from the redesign, with its data source)**

- Section 02 · Cancellations hour by hour, both days, on the same shared-scale two-row form — *source:* /api/compare .hours[].a_cancelled / .b_cancelled
- Hours of the live day past the cut drawn as OUTLINE ('not yet reached'), not as zero-height bars — *source:* /api/compare .hours[].past_cut
- Telematics journeys for both days (120 vs 390) as a sub-line of Distance or in the basis line. Present in the payload and shown nowhere. — *source:* /api/compare .totals.a.telematics / .b.telematics
- Money today as an absence-band cell with live figures: priced N of M on each day and the true reason (Uber's fare arrives with the weekly payments-report walk) — *source:* /api/compare .totals.a/.b .fares, .priced, .bookings + ui.js UBER_FARE_WHY
- By channel money cell states 'priced N of M' where fares cover only part of a channel's bookings (Uber today: AED 235 over 311 bookings reads as a collapse) — *source:* needs a priced count per channel on /api/compare .platforms[].a/.b (only n, completed, cancelled, km, fares, paid, statement_net today) — **needs a new endpoint**

**Keep**

- The toolbar: both date pickers as addresses, Swap, Today vs yesterday, and the cut/full toggle
- Verdict with the cut stated first
- All tile content: bookings pair, drivers out with started/stopped, completed and %, cancelled with inverted delta, distance, and carrying someone (the mockup drops distance and on-trip hours)
- Hour by hour as two rows on ONE shared scale, with per-hour click-through to #day and the busiest-hour caption
- The 9-column per-driver table ordered by size of change, sortable, rows → #performer, new-today/not-out markers
- By channel table with its single money column and basis markers (stmt/ldg)
- Started and stopped name lists with performer links and the night-driver caveat
- The 'Was everything collected?' table: last run, last success, rows written

**Leave structurally untouched (restyle only)**

- The date pickers, swap, cut toggle: every comparison is a sendable address
- The per-driver table (9 columns, sort, row link): the phone-call list
- By channel's one-money-column-with-basis design and g23 width (a measured fix against sideways scroll)
- The qChan('/api/compare', { a, b, cut }) call: no window is sent

**Not adopted from the mockup**

- Section 01 'four hours at a time' paired bars: a coarser redraw of the hour-by-hour data. It adds nothing and moves the working table down.
- Section 02 single hourly series (today solid, yesterday hatched after the cut): it merges two days into one series. The live two-row shared scale shows both days at every hour.
- Sections 04/05 'who did less / who did more' dot plots: 7 names each, no links, a subset of the 9-column table the operator phones from
- Section 06 feed freshness bars: the live table carries last run, last success and rows written, and a bar carries one of them
- Absence cells 'Journeys from the car: 0' (today 120 vs 390), 'Channels in this comparison 1 of 4' (5 today) and 'Every row is Uber': stale 15-Sep data

*Tests that pin this page:* test/compare.test.mjs (renders #compare/A/B?cut=full: By channel panel, one money column, no fifth column, basis markers, on-screen width), test/window_honesty.test.mjs (compare.js must call qChan('/api/compare', { a, b, cut })), test/scroll_cue.test.mjs (compare By channel panel width), test/fare_reason_shared.test.mjs (scans every public file for unqualified 'no fare column' wording; the caption fix must use UBER_FARE_WHY), test/query_params.test.mjs, test/spacing.test.mjs, test/smoke_views.mjs

#### `analyst/confirmed` — effort L

*Today:* The default tab. A tab bar holds 5 addresses. 5 tiles: Survived 151, Contradicted 83, Too small 120, Not measurable 8, Passes 31 judged by MiniMax-M3. Then one card per judgement, 151 of them. The page is 25,355px tall, because the same claim is restated nightly. Each card: verdict pill, claim, verdict reason, a 4-cell number block (segment value with records, everything-else value with records, difference and % of baseline, p-value), why, what to do, and 'the model said X; the measurement says Y'. Empty states distinguish unconfigured, failed pass (with error) and no finding, and offer 'Run a pass now' (POST).

**Change**

- Cards grouped one per DISTINCT claim. The latest judgement is shown in full, with a line 'judged N times, D1–D2, measured range X–Y' and a disclosure listing every judgement (run, window, measured, baseline, n, p). All 151 stay reachable; the page drops from about 25,000px to about 31 cards.
- Verdict pills become neutral chips with a glyph (✓ ✗ · ?), not green/red. A verdict is not a better/worse delta under the colour law. The tile tones (good/critical/warn) go.
- Section order: 00 glance (5 tiles, distinct-claims hero), then 01 verdict bars, then 02/03 above/below dot plots, then 04 per run and 05 by cut side by side, then 06 the grouped cards, then 07 absence band

**Add (from the redesign, with its data source)**

- Hero tile: distinct claims confirmed. Judgements are de-duplicated on dimension + segment + metric + direction. Today: 151 judgements, 31 distinct (unwindowed). — *source:* /api/analyst/findings?verdict=confirmed .findings[].dimension, .segment, .metric, .direction
- Each card shows its OWN window (window_start → window_end) and run date. Each pass measures its own trailing span, which may not be the header window. — *source:* /api/analyst/findings .window_start, .window_end, .created_at, .run_id
- Section 01 · What became of every claim: 4 verdict bars, each linking to its tab — *source:* /api/analyst/findings .confirmed/.refuted/.immaterial/.unsupported
- Sections 02/03 · Segments above / below the rest of the fleet: dot plot of relative gap per distinct confirmed claim, with a channel swatch only where dimension = platform — *source:* findings .measured_value, .baseline_value, .effect_pct, .direction, .dimension
- Section 04 · Confirmed judgements per run (bars by run), and 05 · which cut the model found things in (bars by dimension) — *source:* findings .run_id/.created_at, .dimension
- Absence band: claims measured over the window shown (count where window matches the header), property rows in the model's pack (brief.properties is empty), whether anyone acted (no ack field), and what a claim is worth in money (no AED field) — *source:* findings windows + /api/analyst/brief .properties

**Keep**

- The tab bar (5 tabs as addresses)
- Every number on a card: segment and baseline values with record counts, difference, % of baseline, p-value with 'two-sided' / 'no test applies', why, what to do, and model-said vs measured
- The three distinct empty states and the Run a pass now button with its 409 handling
- The verdict counts across all four verdicts

**Leave structurally untouched (restyle only)**

- Run a pass now (a POST that queues one job and refuses a second): position in the empty state and behaviour
- Tab addresses and the default tab

**Not adopted from the mockup**

- Section 06 'What the model had to work with' (rows and completion by channel): brief.by_platform is platform completion, which #platforms owns
- Section 07 'What the model was allowed to measure': this is brief.metric_coverage, already on the Rules tab. Duplicating it here only adds length.
- Absence cell 'Refuted and immaterial claims: counted, never listed': FALSE on live. Both are listed on their own tabs.
- Mockup counts (26 distinct, 114 of 267, 23 runs): 15-Sep data

**Review corrections (adopted — they override the lines above)**

- *Correction adopted:* instead of “Grouping by distinct claim, with a disclosure listing each judgement as 'run, window, measured, baseline, n, p'”: Have each disclosure row carry the full card fields, or fold the full older cards. (For every judgement except the latest, the verdict_reason, why, what-to-do and 'model said / measurement says' text would no longer be shown (rule 1).)

*Tests that pin this page:* test/spacing.test.mjs and test/smoke_views.mjs (routes_list.mjs renders 'analyst'), test/phone_clock.test.mjs and test/phone_render.test.mjs (phone UI reads /api/analyst/findings; only if the payload changes, which is not planned)

#### `analyst/refuted` — effort S

*Today:* The same 5 tiles and card component, filtered to 83 refuted judgements (83 distinct claims), plus a closing note on why refuted claims are kept.

**Change**

- Hero tile becomes 'Contradicted by the data', with the other verdict counts as tiles
- Cards restyled to ruled blocks with the same distinct-claim grouping as the confirmed tab (a no-op today: every claim is distinct)
- Verdict chip neutral with the ✗ glyph; tile 'critical' tone removed

**Add (from the redesign, with its data source)**

- Hero chart: claimed value against measured value per refuted claim (dumbbell), showing how far the model was off — *source:* /api/analyst/findings?verdict=refuted .claimed_value, .measured_value, .unit
- Each card shows its own window and run date — *source:* findings .window_start/.window_end/.created_at

**Keep**

- Every card and its numbers, including 'the model said X; the measurement says Y'
- The closing note on why refuted claims are kept

**Leave structurally untouched (restyle only)**

- The tab address and the kept-not-hidden rationale

**Review corrections (adopted — they override the lines above)**

- *Correction adopted:* instead of “Grouping by distinct claim, with a disclosure listing each judgement as 'run, window, measured, baseline, n, p'”: Have each disclosure row carry the full card fields, or fold the full older cards. (For every judgement except the latest, the verdict_reason, why, what-to-do and 'model said / measurement says' text would no longer be shown (rule 1).)

*Tests that pin this page:* test/spacing.test.mjs and test/smoke_views.mjs (routes_list.mjs renders 'analyst/refuted')

#### `analyst/immaterial` — effort M

*Today:* The same tiles and cards, filtered to 120 'true but too small' judgements.

**Change**

- Hero tile becomes 'True but too small'. Tile tones removed. Neutral chip with the · glyph.
- Cards restyled to ruled blocks, with distinct-claim grouping

**Add (from the redesign, with its data source)**

- Hero chart: each claim's relative effect against the materiality floor (a rule at 15%) and its segment n against the minimum-records floor, showing WHY each is too small — *source:* /api/analyst/findings?verdict=immaterial .effect_pct, .segment_n + /api/analyst/rules .materiality (minRelEffect, minSegmentN)
- Each card shows its own window and run date — *source:* findings .window_start/.window_end/.created_at

**Keep**

- Every card and its numbers

**Leave structurally untouched (restyle only)**

- Tab address

**Review corrections (adopted — they override the lines above)**

- *Correction adopted:* instead of “Grouping by distinct claim, with a disclosure listing each judgement as 'run, window, measured, baseline, n, p'”: Have each disclosure row carry the full card fields, or fold the full older cards. (For every judgement except the latest, the verdict_reason, why, what-to-do and 'model said / measurement says' text would no longer be shown (rule 1).)

*Tests that pin this page:* test/spacing.test.mjs and test/smoke_views.mjs (routes_list.mjs renders 'analyst/immaterial')

#### `analyst/unsupported` — effort S

*Today:* The same tiles and cards, filtered to 8 judgements the database could not measure. The verdict reason carries why.

**Change**

- Restyle only: shared tiles (hero 'Not measurable') and ruled cards. The measured/baseline cells that are null render ABSENT with the verdict reason, never as '—' alone.
- Neutral chip with the ? glyph

**Add (from the redesign, with its data source)**

- Each card shows its own window and run date — *source:* findings .window_start/.window_end/.created_at

**Keep**

- Every card, especially verdict_reason, which is the absence reason

**Leave structurally untouched (restyle only)**

- Tab address

**Review corrections (adopted — they override the lines above)**

- *Correction adopted:* instead of “Grouping by distinct claim, with a disclosure listing each judgement as 'run, window, measured, baseline, n, p'”: Have each disclosure row carry the full card fields, or fold the full older cards. (For every judgement except the latest, the verdict_reason, why, what-to-do and 'model said / measurement says' text would no longer be shown (rule 1).)

*Tests that pin this page:* test/spacing.test.mjs and test/smoke_views.mjs (routes_list.mjs renders 'analyst/unsupported')

#### `analyst/rules` — effort S

*Today:* How judgements are decided: a note, 3 tiles (minimum records, minimum relative difference, significance threshold), a table of the metrics the model can check (label, key, kind, unit, defined over), dimension chips, 'What the model could pick from' (metric coverage table and per-dimension candidate lines from /api/analyst/brief), and a minimum-absolute-difference table by unit.

**Change**

- Restyle only: shared tiles, hairline tables, and dimension chips as plain ink chips. The 'one platform, so no complement' marker gets a channel swatch beside the platform name (not coloured text).

**Keep**

- All 4 tables/lists and the 3 threshold tiles. This is reference material, and the tables are the detail layer.

**Leave structurally untouched (restyle only)**

- The metric registry table and the candidates list: the model can only be checked against what they list

**Review corrections (adopted — they override the lines above)**

- *Correction adopted:* instead of “Grouping by distinct claim, with a disclosure listing each judgement as 'run, window, measured, baseline, n, p'”: Have each disclosure row carry the full card fields, or fold the full older cards. (For every judgement except the latest, the verdict_reason, why, what-to-do and 'model said / measurement says' text would no longer be shown (rule 1).)

*Tests that pin this page:* test/spacing.test.mjs and test/smoke_views.mjs (routes_list.mjs renders 'analyst/rules')

#### `action` — effort L

*Today:* One finding at #action/<code>/<entity>, fetched with ?code= (a complete set). Crumb back to the Action list. Tiles: Severity, Category, About (entity link), Computed (and window or 'current state'), Sized at (with 'a modelled holding cost, not a measurement'), Measured at (metric), and Fleet. Then 'What we found' (detail prose) and 'What to do' (action). Then 'N drivers named by this finding' person cards with contact, then a note linking the entity page, then 'The same rule elsewhere': every sibling finding, sortable, with entity and #action links, severity and sized-at. There is an honest not-open / truncated state.

**Change**

- Section order: 00 glance (Sized at as the hero when present, drawn with HATCH and the 'modelled, not a measurement' label when modelled; otherwise Measured at), then 01 What we found + What to do (two ruled cells, text verbatim), then 02 People named, then 03 The same rule on every entity (chart, where the metric varies), then 04 The same rule elsewhere (table), then 05 absence band
- Severity tile loses the red ▾ and 'critical' tone and becomes ink. The Sized-at amber tone is replaced by the hatch swatch.
- Sibling table severity pills become neutral chips. The table is restyled to hairline rules, with the same 5 columns and sort.

**Add (from the redesign, with its data source)**

- A per-rule label for 'Measured at' so the number says what it is. idle_vehicle: bookings in the last 14 days. stale_tracker: hours since the last fix. licence_expired / vehicle_doc_expiring / vehicle_dormant: days (negative = past). cancellation_rate: share cancelled. tracker_feed_dark: trackers that stopped together. volume_trend: change on the base month. — *source:* a client map from the metric assignments in src/insights.js (lines 268, 313, 446, 634, 751, 786, 835)
- Tile 'The same rule elsewhere': count of siblings, their AED total (modelled or measured, labelled) and the fleet split — *source:* /api/insights?code=<code> (complete)
- Section 01 · The same rule on every entity: ranked bars of the rule's metric with this entity marked by weight. Works now for rules whose metric varies (stale_tracker, licence_expired, vehicle_doc_expiring, vehicle_dormant). — *source:* /api/insights?code=<code> .metric
- For idle_vehicle (metric is a constant 0): days since the last recorded trip, lifetime trips, and hours since the tracker reported, per car. The rule already SELECTs last_trip, lifetime and last_seen but writes them only into prose. It must write them into refs. — *source:* src/insights.js ~240-270 (idle_vehicle), write refs JSON — **needs a new endpoint**
- Absence band: whether the car is parked on purpose (workshop/reserve not recorded), where AED 120/day comes from (a constant assumption, VEHICLE_DAY_COST_AED), whether the finding has been acted on (no actor/ack field), and what the metric is NOT (per rule) — *source:* rule source + insight row fields

**Keep**

- Every tile's content, including the entity link and the modelled label
- 'What we found' and 'What to do', verbatim
- The people cards 'N drivers named by this finding' (who to ring), placed directly under What to do
- 'The same rule elsewhere' table: every sibling, sortable, with entity links and #action links
- The not-open / capped-list states and the crumb

**Leave structurally untouched (restyle only)**

- The narrowed ?code= fetch, which prevents false 'no longer open' states
- The people cards and their position (the 'who do I ring' answer)
- The sibling table's links and sort

**Not adopted from the mockup**

- Sections 04 'Every rule open in what the list serves' and 05 'What it costs to ignore, across the 200': fleet-wide charts that belong to #insights. They duplicate it and push this finding's evidence down.
- Deriving days-since-trip, lifetime trips and tracker hours by parsing the detail sentence. Prose parsing breaks silently. They come from structured refs or are not drawn.
- Cell 'Who it is written for: All 17': trivia
- Absence cell 'How many findings are open in all: more than 200': wrong. ?code= returns the complete set and the summary gives the total (202).
- Mockup plate/figures (L37810, 17 cars, AED 28,560): 15-Sep data

*Tests that pin this page:* test/insight_named.test.mjs (drives the real router and V.action; asserts the named-people panel), test/held_fields.test.mjs (?code= narrowed fetch), test/spacing.test.mjs and test/smoke_views.mjs (routes_list.mjs: action/idle_vehicle/L45235, action/nope/-), test/insight_freshness.test.mjs (only if src/insights.js starts writing refs for idle_vehicle)

### Money

#### `unit` — effort M

*Today:* Money in tab (economics.js moneyTab), rendered from the mirror at 1440. Verdict: '1 driver drove and was paid nothing', figure AED 26 per online hour, sub-line about the 100 drivers with measured availability (74% of those hours had nobody in the car), with a cohort link. Coverage note: payouts only exist from 6 Feb 2026. 8 KPI tiles: Money placed on cars AED 642,730 (compared with Finance's AED 714,783), Money per car per earning day AED 322, Per km AED 3.09, Per booking AED 37.01, Cars earning 103/273 (links to who), Insured and idle 28 (links to who), Days a car sat idle 4,237 (AED 82,682 priced only for cars that have their own rate), Money we cannot place AED 63. Panels: the concentration curve (click opens the car); Money per km by channel (bars plus a 4-row table); four ranked 10-row tables (cars top and bottom, drivers top and bottom), whose captions name the day threshold actually used (8 of 23 days); Insured cars that earned nothing (28 rows × 9 columns); map of each car's last position; basis note; provenance line. Data: /api/economics/assets (26s through the mirror), /api/economics/drivers, /api/kpis.

**Change**

- Section order: 00 At a glance (the verdict figure becomes the hero tile and its claim the band's opening sentence; the 8 tiles sit in two rows of 4 with labels and keys unchanged. That is more than SPEC's 4–6 on purpose, under rule 1) → 01 per-earning-day histogram → 02 concentration curve beside money per km by channel → 03 the four ranked tables → 04 per-person histogram and scatter → 05 insured-and-idle table → 06 map → 07 † absence band → provenance footer
- Money per km bars take channel identity colours (Uber #2362D3, Bolt #0398BA, Yango #B4358A, Hotel #A38902) with direct labels; the 4-row table stays beneath as the detail layer
- Map pins: earning = ink dot, moved but paid nothing = negative dot, never moved = grey-2 outline (absence), with a legend in words
- Level tiles lose their red and amber tone fills; the one highlight is the hero tile
- Tables restyled to hairline rules; a row that belongs to one channel gets a 3px channel marker

**Add (from the redesign, with its data source)**

- 01 hero chart: 'What a car earns on a day it earns anything', a histogram in AED 50 bands — *source:* /api/economics/assets rows[].aed_per_earning_day (already fetched)
- 'What a person earns on a day they work', a histogram — *source:* /api/economics/drivers rows[].aed_per_day_worked (already fetched)
- Scatter: days earned against the rate per earning day, one dot per car — *source:* assets rows[].earning_days × aed_per_earning_day
- 'What 273 cars did' / 'What 307 people did': 3-segment bars (earning / moved but paid nothing / never moved; earning / drove unpaid / idle) — *source:* assets totals earning, moved_unpaid, still; drivers totals earning, drove_unpaid, idle
- 'Hours behind the hourly rate': two bars, hours with a job against hours online and idle — *source:* drivers totals measured_hours_online, measured_idle_h
- † absence band: no cost of a car-day (no cost feed); online hours measured for only 100 of 307; Finance spreads payouts differently (AED 714,783 vs 642,730); bookings before 6 Feb 2026 carry no money — *source:* the existing coverage note, basis note and totals (all already fetched)

**Keep**

- The verdict's dynamic claim (drove unpaid → per online hour → per day worked → earning count) and its cohort link
- All 8 KPI tiles with their exact sub-lines and data-kpi keys (unit-aed-per-earning-day, unit-idle-days …), including the Finance comparison and the refusal to price 3,906 idle days of cars that never earned
- The four ranked tables (data-panel unit-cars-top/-bottom, unit-drivers-top/-bottom) with their plate and held-by links and their window-scaled threshold captions
- The Insured cars that earned nothing table (28 rows, 9 columns)
- The map of each car's last position, drawn from the asset ledger rather than /api/live
- The concentration curve's click-through to the car; the coverage note; the basis note on how payouts are spread over days

**Leave structurally untouched (restyle only)**

- The four ranked tables and their threshold logic: operations use them to find which car or driver to act on, with links
- The insured-and-idle table and its 'Who exactly?' cohort links
- The map: structure and data source unchanged, pins restyled only
- Tab bar (Money in / Every vehicle / Every driver) and its URLs

**Not adopted from the mockup**

- The mockup's 'every figure is Uber money': live places fares from Bolt, Hotel and Yango on cars too, so the live page has more data
- Hero 'Forgone on idle days AED 118,664': live deliberately prices only the 331 idle days of cars that have their own rate (AED 82,682), calls it 'unearned, not lost', and refuses to price never-earned cars. The mockup's framing contradicts that
- The top-12 cars bars: the live ranked tables carry more (held by, days, per km, links)
- 'The 100 people who earned, by state (on a job / available / offline)': a snapshot of the driver register at read time, not a measure over the window; it is not money and would need an extra call
- The mockup has no map; the live map stays

*Tests that pin this page:* collector/test/unit_ranking_gate.test.mjs, collector/test/money_contradictions.test.mjs, collector/test/cohorts.test.mjs, collector/test/economics.test.mjs, collector/test/person_vs_account_counts.test.mjs, collector/test/phone_render.test.mjs, collector/test/tracker_speed.test.mjs, collector/test/spacing.test.mjs + smoke_views.mjs (via routes_list.mjs: unit, unit?days=90&fleet=ecosine)

#### `unit/assets` — effort S

*Today:* Every vehicle tab (economics.js assetsTab). Coverage note. 6 tiles: Money in AED 642,730; Per earning vehicle-day AED 322; Earning 103 of 273; Moved, no money 3 (links to who); Never moved 167 (links to who); Insured and idle 28 (links to who). Search box (plate, make, model). Band filter buttons with counts (All 273 / Earning 103 / Moved, no money 3 / Never moved 167). Scatter of km driven against money earned (click opens the car). Every vehicle table: 273 rows × 15 columns, sortable, row opens the asset.

**Change**

- Restyle through the shared foundation only: tiles, hairline table, filter buttons as chips (counts kept), scatter dots in ink with the band shown by shape and legend rather than red/amber/green

**Keep**

- All 6 tiles and their cohort links
- Search, band filter buttons with counts, 'N of M vehicles' line
- The km-vs-money scatter and its click-through
- The 15-column sortable table with row click to #vehicle

**Leave structurally untouched (restyle only)**

- Search, filters, sort and row drill-down: this is the working list operations use to find a car

*Tests that pin this page:* collector/test/economics.test.mjs, collector/test/cohorts.test.mjs (unit-moved-unpaid, unit-still), collector/test/spacing.test.mjs + smoke_views.mjs (unit/assets?days=7&platform=uber)

#### `unit/drivers` — effort S

*Today:* Every driver tab (economics.js driversTab). Coverage note. 7 tiles: Money to drivers AED 667,681; Per day worked AED 260; Per booking AED 38.40; Earning 176 of 307; Drove, no money 1 (links to who); Earned nothing 130 (links to who); Per hour online AED 26. Search, band filter buttons with counts, and a 307-row × 14-column sortable table; each row opens the person.

**Change**

- Restyle only (tiles, hairline table, chips)
- Before restyling, resolve a contradiction measured today. The 'Per hour online' tile prints the API's hours_note, '59 of 307 people have any online hours reported — Uber sends none'. The Money in verdict, built from the same /api/economics/drivers totals, says 100 drivers have measured availability (people_with_availability 100, people_with_hours 59). Check in api/economics_routes.js which reason is true; the tile must not carry a reason that contradicts the verdict

**Keep**

- All 7 tiles, their cohort links, search, filters, and the 14-column sortable table with person drill-down

**Leave structurally untouched (restyle only)**

- Search, filters, sort order and row drill-down

*Tests that pin this page:* collector/test/economics.test.mjs, collector/test/cohorts.test.mjs (unit-drove-unpaid, unit-earned-nothing), collector/test/person_vs_account_counts.test.mjs

#### `revenue` — effort M

*Today:* revenue.js, one call to /api/revenue. Verdict: 'Uber is 91% of the work and AED 667,652 of the money', with 17,388 of 17,388 bookings accounted for. 7 tiles: Accounted for (fares + Uber statement net + Yango payout, split in the sub-line); Fares charged AED 933,699 (gross); Paid into the bank AED 556,000; On-trip revenue AED 581,841; Cash the platforms report AED 110,417 (split between the payout tree and the statements); Tips AED 4,818; Bookings with no money value 0 (80 Yango bookings under-covered). Then an explanatory paragraph of about 180 words. Money by channel table: 4 rows × 9 columns (bookings, report a fare, fares gross, payout net, on-trip net, per km, basis, why). The WHY column wraps a long sentence inside a narrow scrolled column, so each row renders about 500px tall and Per km / Basis / Why are cut off at 1440 (measured on the mirror). 'The payout, broken down': top-level component bars (blue = paid, orange = taken back), a 29-row component table (within / component / amount / share of parent / accounts) and a caption explaining shares above 100%; links to Money sources and Reconciliation; window line; provenance.

**Change**

- Section order: 00 At a glance (verdict → hero 'Accounted for'; the other 6 tiles follow, labels unchanged) → 01 accounted-by-channel bars → 02 bookings by channel beside 03 Uber six ways → Money by channel table → 05/06 leaf-line bars → payout breakdown table → † absence band → footer
- Fix the Money by channel table: keep all 9 facts, but render Basis and Why as a second full-width line under each channel row, so rows are one line tall and nothing is cut off at 1440
- Top-level payout bars: remove the blue 'paid' / orange 'taken back' fills. All bars take the Uber identity colour; direction is carried by the '−' sign and the label (SPEC L3 and L5.2)
- The ~180-word paragraph and the reconciliation caption move out of the body into the absence band and captions, text unchanged and still p.cap
- Money in tile values keep the payload's cents per SPEC §4. This is a cross-cutting formatter decision; see cross_cutting

**Add (from the redesign, with its data source)**

- 01 hero chart: 'What each channel is accounted on'. One bar per channel = platforms[].best, labelled with its basis (statement / fares / payout). A channel with best null would draw an outline with basis_note — *source:* /api/revenue platforms[].best, .basis, .basis_note
- 02 'How many bookings each channel filed': bars — *source:* /api/revenue platforms[].bookings
- 03 'Uber's money, six ways': fares 845,303.53 · statement gross 753,243.41 · statement net 582,087.02 · payouts 556,279.98 · service fee 188,414.83 · cash taken 110,419.40, with the basis bar marked — *source:* /api/revenue platforms[uber].fares, statement_gross, statement_net, payouts, statement_fees, statement_cash
- 05/06 'What Uber added' / 'What Uber took out': leaf-line bars, top 8 of each — *source:* /api/revenue components[] (already fetched)
- 04 'The same channels, one fleet at a time' (optional) — *source:* /api/revenue?fleet=ecosine and ?fleet=egari (two extra GETs); collector state from the credential banner's feed
- † absence band built from the CURRENT payload: 80 Yango bookings covered by a payout over only 6 of 22 days; the Uber statement files no bank figure (statement_bank null), and payouts are a separate register; Bolt and Hotel have no payout or statement ('not reported' / 'not collected') — *source:* /api/revenue totals.undercovered_*, platforms[].statement_bank, collection_status

**Keep**

- The verdict and all 7 tiles with their labels, sub-lines and tone classes. 'Accounted for' covers all 4 channels, each on its best basis
- The Money by channel table: all 4 channels × 9 facts, including Basis and Why
- The payout breakdown: the 29-row component table with share-of-parent and the 'a share above 100% is not an error' caption
- The 'Three views of the same money…' reconciliation caption and the 'accounted for by what the platform reports…' paragraph, text unchanged (tests pin both)
- Links to Money sources and Reconciliation; the window line; provenance

**Leave structurally untouched (restyle only)**

- Sortable table headers
- The component table as the detail layer
- The Money sources and Reconciliation links

**Not adopted from the mockup**

- Hero 'Net on the statement' (Uber only): live's 'Accounted for' covers all 4 channels
- 'Channels filing money 1 of 4' and 'Files no money row: Hotel 923 / Bolt 773 / Yango 94'. Stale: today all 4 channels are accounted for (Hotel and Bolt on fares, Yango on payout) and dark_bookings is 0, so this would print a false reason
- 'Bank transfer: No bank line is filed' as a tile: live's 'Paid into the bank AED 556,000' comes from the payout register and is measured. The statement's missing bank line belongs in a caption
- 'Trip value booked ▲ +16,529.42 week on week': Uber-only fares and a two-week comparison that needs two extra calls, while live's 'Fares charged' covers every channel. Deferred until a like-for-like window is agreed
- The label 'Cash the drivers hold': the figure is cash the platforms report as taken at the kerb, not cash held now. Keep 'Cash the platforms report'

**Review corrections (adopted — they override the lines above)**

- *Data source corrected:* revenue: 'All [payout] bars take the Uber identity colour'. The components are labelled `${sourceLabel(c.platform)}: …` (revenue.js:634) and come from per-platform driver_payout_day. Colour each by channelOf(c.platform).

*Tests that pin this page:* collector/test/money_contradictions.test.mjs (.kpi .l 'Accounted for'; dark tile; tone class t-warn; whole-AED sub text such as 'AED 130,219 in fares over 1,616 priced bookings'; p.cap 'Three views of the same money'; p.cap 'accounted for by what the platform reports'), collector/test/spacing.test.mjs + smoke_views.mjs (routes_list: revenue)

#### `corporate/overview` — effort M

*Today:* corporate.js renderCorporate('overview'). Verdict: '8 bookings were given away', figure AED 61,324 reported. 10 tiles: Bookings 691 ('0 properties · 652 guests'), Revenue AED 61,324, Average fare AED 89.79, Cost of delivery AED 42,890, Gross margin AED 18,434 (30.1%), Empty km before pickup 566 km, Given away 8, Carried an authorisation — (absent, with reason), Ended outside Dubai 8, How much rests on one client 10,000 (HHI). Panels: Who books (bars; '(unnamed)' 691; HHI caption; click → #property); How the fare is settled (100% stacked bar in 5 colours, with a receivables line); What is booked (donut); Empty km before pickup by time of day (bars, click → approach/daypart); Booked ahead or called on the spot (donut); Where money is being lost (only kinds with n>0: 8 / 9 / 38 / 6, each linking to leakage/<kind>); source note.

**Change**

- 00 At a glance: hero 'Kept' (margin AED 18,434, 30.1% of revenue); then tiles Billed (AED 61,324 over 683 priced; AED 89.79 a priced booking), Cost filed, Unpaid approach (566 km, 5.0% of paid distance, measured on 100%), Given away 8. The verdict claim stays as the band's opening sentence. Bookings, guests and ended-outside-Dubai move to the 02 caption; the authorisation tile moves to the absence band. No figure is dropped
- 'How much rests on one client 10,000' renders ABSENT with its reason: no booking names a property, so one unnamed bucket holds all 691 and HHI 10,000 is an artefact, not a concentration. The Who books caption 'a business resting on one customer' goes for the same reason
- Bookings tile sub-line '0 properties' becomes 'no named property — the one booker on record has no partner id'
- 'What is booked' donut → horizontal bars in Hotel identity with direct labels; 'Booked ahead' donut → one 100% bar or the caption '2 of 691 booked ahead (0.3%)'
- Settlement 100% bar: the five payment classes are not channels, so they move to the achromatic sequential ramp with direct labels (no green, no orange)
- Who books: a bar whose partner_id is null is no longer clickable. Today it opens 'No property chosen', whose note wrongly says every property name carries an id
- Sections after 00: 01 margin bars → 02 what is booked (+ caption) → 03 leak checks → settlement mix → empty km by time of day → 04/05 drop areas → † absence band

**Add (from the redesign, with its data source)**

- 01 'The only margin in the product': three bars, billed / cost / kept — *source:* /api/corporate/summary revenue, cost (margin = revenue − cost)
- 03 'Where the money leaks': all seven checks as bars, zeros included, each still linking to leakage/<kind>. The authorisation check is drawn as an outline carrying summary.authorized_absent_reason — *source:* /api/corporate/leakage kinds[] (already fetched) + summary.authorized_absent_reason
- 04/05 'Where a driver is left after the drop': total return km and mean return per drop, by drop area, as ranked bars — *source:* /api/corporate/stranding rows[].return_km, avg_return_km (one extra GET; the Empty km tab already uses it)
- † absence band: which hotel (no booking names a property; the one row has partner_id null); repeat business 0.7%; approvals not applicable (production's words); hours given away not filed (leakage summary.foc_hours null) — *source:* /api/corporate/summary, /api/corporate/guests (extra GET), /api/corporate/leakage

**Keep**

- The verdict claim and every tile figure (bookings, revenue, average fare, cost, margin, empty km, given away, authorisation absent with production's reason, ended outside Dubai)
- How the fare is settled, with its link to settlement receivables
- Empty km by time of day, with its click-through to approach/daypart
- The leak links to corporate/leakage/<kind>
- The source note (the only channel where the unpaid approach leg is measurable)

**Leave structurally untouched (restyle only)**

- The five-tab bar and its URLs
- Click-throughs to leakage/<kind>, approach/daypart and settlement/receivables

**Not adopted from the mockup**

- 'Billed nothing 49 = 11 given away + 38 priced at zero': this adds two counts the payload does not key together (a given-away booking may also be priced at zero). Show both counts separately, as live does
- Delta-slot use of levels ('▲ +3.31 a billed km', '▼ −6.1% of billed distance'): a ruling on this is still open (NEW-PAGES §4). Print as plain sub-line text
- Dropping the settlement mix and empty km by time of day: the mockup omits them, live has them
- The mockup's single tab-less page: live's five tabs stay

**Review corrections (adopted — they override the lines above)**

- *Correction adopted:* instead of “A new 00 band that assumes a cost figure exists”: Keep the fallbacks. The 'Kept' hero renders absent with a reason when cost is null. (Live has conditional tiles: 'Revenue per km' when there is no cost, and 'Booked in advance' when there is no margin (corporate.js:106-116). The plan drops both branches.)

*Tests that pin this page:* collector/test/corporate.test.mjs (API + corporate.js import parse), collector/test/spacing.test.mjs + smoke_views.mjs (routes_list: corporate)

#### `corporate/properties` — effort S

*Today:* 'Every property that books — 1 property': a 15-column sortable table (property, bookings, revenue, with a fare, average fare, cost, margin, AED/km, guests, bookings per guest, approach, scheduled, hourly, given away, last booking) with one row, '(unnamed)'. Margin note. The name renders as ent-off because partner_id is null.

**Change**

- Restyle only (hairline table, Hotel row marker)
- The '(unnamed)' row gets a title reason: 'no booking names its property — partner id is empty'

**Keep**

- All 15 columns, the sort, and the margin note

**Leave structurally untouched (restyle only)**

- Table columns, sort and links: this is the operator's property list

*Tests that pin this page:* collector/test/corporate.test.mjs, collector/test/spacing.test.mjs (routes_list: corporate/properties)

#### `corporate/guests` — effort S

*Today:* Passengers tab: 4 tiles (Guests 652; Booked more than once 2; Bookings from repeat guests 12.1%; Bookings per guest 1.06); short-window note; a 300-row table (record, property, room, bookings, revenue, km, when, purpose); a sort note; 'Showing 300 of 652'; a purpose caption.

**Change**

- Restyle only
- Fix a broken sentence seen on production: 'Purpose is empty on 250 of these 300 rows. are the only booking sources that record one…'. purposeNote() builds its subject from row.property, which is null on every row, so the subject is empty and the reason ('the channel the ride came through') is unsupported. Print that reason only when property names exist; otherwise say that no row names its property

**Keep**

- All tiles, the 300-row table and its columns, the capped and sort notes

**Leave structurally untouched (restyle only)**

- Table, sort, capping

*Tests that pin this page:* collector/test/spacing.test.mjs (routes_list: corporate/guests)

#### `corporate/leakage` — effort S

*Today:* Money lost tab (and /leakage/<kind>). A picker of 7 category counters (Given away 8, Ran past the booked hours 9, No fare recorded 0, Priced at zero 38, Charged with no approved authorisation 0, Drove further to reach the job than the job itself 6, Flagged missing 0). 5 tiles (Bookings 691; Cost of rides given away AED 192; Value of hourly overruns AED 2,630; Km to reach shorter jobs 67.5; Properties requiring approval 1 of 6). Choosing a category opens its named, dated bookings table (10 columns: when, property, driver, vehicle, type, paid by, fare, km, approach, authorised) with driver and vehicle links.

**Change**

- Restyle the counters as a ranked check list (count + label), still links
- 'Charged with no approved authorisation 0' becomes an outline with its reason: 1 of 6 properties requires approval and 0 bookings were at it, so this check had nothing in scope. That is not a measured zero

**Keep**

- The category picker and its URLs
- The 5 tiles
- The per-category booking table with driver and vehicle links

**Leave structurally untouched (restyle only)**

- The picker → table drill-down: it is how an operator turns a count into named bookings

*Tests that pin this page:* collector/test/corporate.test.mjs, collector/test/spacing.test.mjs (routes_list: corporate/leakage, corporate/leakage/complimentary)

#### `corporate/approach` — effort S

*Today:* Empty km tab, with 5 sub-views (by property / time of day / driver / booking type / zone). 4 tiles (empty km before pickup, after drop-off, both legs where both were measured, ended more than 15 km from anywhere). Bars of approach km by the chosen dimension; a per-booking note; a both-legs table (11 columns, sortable); a note; a drop-off areas table (7 columns: drops, measured, average return, worst, over 15 km, average paid trip).

**Change**

- Restyle only. Bars in Hotel identity with direct labels; hairline tables

**Keep**

- All 5 sub-views, tiles, bars, both tables and notes

**Leave structurally untouched (restyle only)**

- Sub-view URLs, sortable tables

*Tests that pin this page:* collector/test/spacing.test.mjs + smoke_views.mjs (routes_list: corporate/approach, corporate/approach/daypart)

#### `property/overview` — effort M

*Today:* renderProperty. With no id it shows 'No property chosen'; with an unknown id, 'No property with that id'. With a valid id: 8 tiles (bookings, revenue, average fare, guests, drivers, vehicles, first and last booking); bookings per day and revenue per day as two area charts; What they book (donut + types table with revenue and share); How they settle (bars + a receivables line); When they travel (donut). On production today NO property resolves: /api/corporate/properties returns one row with partner_id null, so #property shows 'No property chosen' and #property/1 answers 404.

**Change**

- 00 At a glance with hero 'Kept' once the cost comes from the properties row
- Donuts → bars (booking types) and one 100% bar (dayparts); area charts in Hotel identity

**Add (from the redesign, with its data source)**

- 00 hero 'Kept on this property' and 01 price / cost / kept bars (billed, cost filed, kept, per billed km, mean approach km) — *source:* /api/corporate/properties row matched on partner_id (cost, km, avg_deadhead_km, revenue). /api/corporate/property returns no cost. One extra GET
- 03 exceptions on this property's bookings: overrun, given away, scheduled — *source:* the same properties row: overrun, foc, scheduled
- Ended outside Dubai and authorisation, per property — *source:* not in any per-property payload; needs new fields on /api/corporate/property — **needs a new endpoint**
- A totals-only view for the unnamed booker: totals from the properties row, plus the mockup's 'marks this page cannot draw' as outlines carrying the true 400/404 reasons — *source:* /api/corporate/properties (available). Making the null-partner row addressable needs a client route key; its detail rows need /api/corporate/property to accept that key (API change) — **needs a new endpoint**

**Keep**

- The no-id and 404 states
- All 8 tiles, the two daily charts (two charts, never a dual axis), the types table, settle bars with the receivables link

**Leave structurally untouched (restyle only)**

- Tab bar (Overview / Passengers / Drivers) and the links out to drivers and receivables

**Not adopted from the mockup**

- 'Unpaid approach ▼ −5.2%': a level in the delta slot (ruling still open)
- The mockup's lack of Passengers and Drivers tabs: they exist and work whenever an id resolves

*Tests that pin this page:* collector/test/corporate.test.mjs, collector/test/spacing.test.mjs + smoke_views.mjs (routes_list: property/h-palm)

#### `property/guests` — effort S

*Today:* Note: this channel issues a passenger id per booking, not per person. 6-column sortable table (record, room, bookings, revenue, first, last), capped at N of M passenger records.

**Change**

- Restyle only

**Keep**

- The note, the table and the capped line

**Leave structurally untouched (restyle only)**

- Table and sort

*Tests that pin this page:* collector/test/spacing.test.mjs (routes_list: property/h-palm/guests)

#### `property/drivers` — effort S

*Today:* 4-column sortable table (driver link, bookings, revenue, average approach) and a positioning note.

**Change**

- Restyle only

**Keep**

- Table with driver links, and the note

**Leave structurally untouched (restyle only)**

- Driver links, sort

*Tests that pin this page:* collector/test/spacing.test.mjs (routes_list: property/h-palm/drivers)

#### `import-sheet` — effort S

*Today:* An operational form. 'Choose the file': supervisor chips (Ahsan / Haseeb / Hossam / Shohaib), CSV file input, column-recognition help, 'Import the chosen rows' button, and a note on which types a sheet can carry (opening_balance, cash_opening, salik, salary). 'What it matched': empty until a file is read; then the columns placed, exact / likely / ambiguous counts, a person select per row, and the commit result with its batch id. Data: /api/ledger/people plus POST preview and commit.

**Change**

- Restyle only (form tokens, visible hairline input fields, chips of at least 44px)
- The empty 'What it matched' panel gets one line: nothing is read until a file is chosen

**Keep**

- The whole flow: supervisor → file → local parse → per-row person choice → commit, with every note it prints

**Leave structurally untouched (restyle only)**

- Form structure, the per-row person select, the import button's live count

*Tests that pin this page:* collector/test/ledger_import.test.mjs (API)

#### `opening` — effort M

*Today:* An operational form. 'State a starting balance': a counted-on date that pre-fills every row, supervisor chips, 'Check them', and 'State these balances' (disabled until checked). 'Every driver': a 347-row grid (driver link, stated, counted now [input], on [date input]) with the note 'Nobody has one yet…'. Data: loadPeople() → /api/ledger/people + /api/ledger/exposure (unwindowed). The mockup has NO form and NO grid.

**Change**

- Order: 00 At a glance (one row, so the form still starts above the fold at 1440) → form → grid → the charts → † absence band → footer
- Visible hairline input fields; the grid restyled to hairline rules

**Add (from the redesign, with its data source)**

- 00 tiles: Opening balances stated 0 of 347 (hero) · Exposures it blocks 347, not measurable · Unstated, at its ceiling AED 3,430,564.43 (276 carry a cash ceiling, 71 none) · People to be counted 347 across 810 accounts · How far back a count reaches: 642 days, from 19 Dec 2024 — *source:* /api/ledger/exposure summary + people[].owes.cash_basis / cash_taken / cash_taken_from; /api/ledger/people accounts (already fetched)
- Grid column 'Cash fares on record (ceiling), since <date>', so the person counting sees who holds cash — *source:* exposure people[].owes.cash_taken, cash_taken_from
- Below the grid: the month of each driver's first cash fare (histogram); how long each driver's cash has been running (histogram); exposure verdict bars (measurable 0 / not measurable 347 / over the line 0) — *source:* exposure owes.cash_taken_from / _to, summary
- † absence band: the opening position (347 of 347, production's reason quoted); what each driver owes (0 rows); the date each count is as of (per row) — *source:* exposure cash_absent_reason, books_absent_reason

**Keep**

- The form, the 347-row input grid, per-row date override, check-then-save, locked rows once stated

**Leave structurally untouched (restyle only)**

- The form and grid: this is the data-entry screen for the one figure the ledger cannot derive

**Not adopted from the mockup**

- 01, the 347-cell 'stated / not stated' grid: it repeats the hero tile and the grid's Stated column, and would put about 350px above the form
- 'The daily figure that looks like it: 16.3%' as a big figure: it is a dated measurement taken from a code comment, not a payload field. Production's reason sentence is quoted instead
- The mockup's absence of the form and grid

*Tests that pin this page:* collector/test/ledger_exposure.test.mjs / ledger_import.test.mjs (API only; no UI test loads opening.js)

#### `salary` — effort M

*Today:* An operational form. 'Pay the month': month picker, supervisor chips, 'Check the month', 'Record the month'. 'The month': a note ('Nothing recorded for 2026-09 yet'), then a 347-row grid (driver, Generated, Last month, Salary for 2026-09 [input]), with rows locked once recorded. Data: loadPeople() (unwindowed) + /api/ledger/entries?book=pay for this month and last. The mockup has NO form and NO grid.

**Change**

- The column header 'Generated' becomes 'Generated, whole record'. loadPeople() is unwindowed, so the column is all-time while the column beside it is one month; a reader today takes it as the month's
- Order: 00 → form → grid → coverage and distribution → † absence band

**Add (from the redesign, with its data source)**

- 00 tiles: Salary recorded for <month> 0 of 347 (hero) · Last month 0 of 347 · On the payroll 347 across 810 accounts · Generated, whole record AED 2,750,467.24 by 148 of 347 over 33,353 earning days · No generated figure 199 of 347 (126 none at all, 73 exactly 0.00) — *source:* the entries book=pay responses already fetched; exposure people[].earned, earning_days, earned_absent_reason; people[].accounts
- Below the grid: pay-book coverage (one outline across 347) over generated split measured / 0.00 / none; distribution of generated for the 148 — *source:* same payloads
- † absence band: wage runs recorded (none, ever); payroll as a feed (not imported); what a wage should be (not derivable); generated missing for 126 — *source:* same payloads plus production's reasons

**Keep**

- Form, grid, lock rule, 'recorded, never calculated' principle

**Leave structurally untouched (restyle only)**

- Form and grid structure, month picker, row locking

**Not adopted from the mockup**

- The tile 'A rate to check a wage against: None is stored': no GET serves the pay basis, and a rate beside the grid is what salary.js is built never to hold (ledger_ui.test.mjs fails on 'rate', 'pct' or 'percent' in salary.js source)
- 02 accounts-per-person histogram: an identity question, not payroll
- The mockup's absence of the form and grid

*Tests that pin this page:* collector/test/ledger_ui.test.mjs (no rate / pct / percent / '* 0.x' in salary.js non-comment source; 'RECORDED, NEVER CALCULATED' marker), collector/test/ledger_register.test.mjs

#### `advances` — effort M

*Today:* 'What each driver owes': the policy sentence, then the note '347 of 347 have no exposure figure', then a table (driver, advances, deductions, cash held, generated, exposure) with unmeasurable people first. 'Record an entry': supervisor chips, 9 kinds (cash / salary / charging advance, repayment, Salik, traffic fine, damage, refund, write-off), driver search, amount, date, photograph, note, check and record. 'The register': 'Nothing has been recorded yet'; it has a proof column. The mockup has no table, form or register.

**Change**

- Order: 00 → owes table → form → register → 01 scatter → 02 ranked ceiling → † absence band
- Form chips of at least 44px and visible hairline fields

**Add (from the redesign, with its data source)**

- 00 tiles: Cash fares put in drivers' hands AED 3,430,564.43 (hero, labelled a ceiling not a balance; 276 of 347, 62,321 cash fares, 19 Dec 2024 → 23 Sep 2026, largest single driver AED 47,631.78) · Recorded on the advance book 0 of 347 · Exposure measurable 0 of 347 · The lending line: none stored (→ #policy) · Generated AED 2,750,467.24 by 148 — *source:* exposure owes.cash_taken / _trips / _from / _to, advance_rows, deduction_rows, summary, earned (already fetched)
- Owes-table column 'Cash fares on record (ceiling)' beside 'Cash held' — *source:* exposure owes.cash_taken
- 01 scatter: cash taken against generated, one dot per person. People with cash and no generated figure sit in an outline lane; no policy line is drawn because none is stored — *source:* exposure owes.cash_taken, earned
- 02 ceiling ranked across all 347 (outline for the 71 with no cash fare) — *source:* exposure owes.cash_taken
- † absence band: what each driver owes (0 of 347); cash in hand as a balance (unknown); exposure (not measurable); the line itself (never set). Production's reasons, quoted — *source:* exposure *_absent_reason

**Keep**

- The owes table and its unmeasurable-first sort
- The form with its 9 kinds
- The register with proof links

**Leave structurally untouched (restyle only)**

- Table sort (unmeasurable first), form, register: the page an operator uses to lend and record

**Not adopted from the mockup**

- 03 'The eighteen books' outline bars: no GET serves the ledger-type registry; the mockup derived the 18 codes from the route's refusal message for an unknown type_code
- Any client-side ratio. ledger_ui.test.mjs forbids advances.js from dividing by earned or assigning exposure_pct

*Tests that pin this page:* collector/test/ledger_ui.test.mjs (never assigns exposure_pct; no '/ earned'; policy sentence; unmeasurable sorts first; 'N of M people have no exposure figure'; roster count; register proof cell at index 4), collector/test/deposit_ui.test.mjs (advances delegates the form to entry_form.js)

#### `charging` — effort M

*Today:* 'What has been advanced': 3 tiles (Advanced in This month 'AED 0.00'; Drivers 0; Entries 0) and a caption claiming everything is over This month. 'Record one': charging-advance form, plus a note that repayments are recorded on Advances. 'Who has had what' (table, largest first). 'Every entry, most recent first' (register with proof). 'What none of this is checked against': five bullets (Tesla serves the data; the token cannot be renewed from this server; a billing gate; even ingested it would be partial; a vehicle is not a person) and a Supply idle-hours caveat. Data: /api/ledger/entries?type_code=charging_advance + loadPeople.

**Change**

- The hero 'Advanced in <window>' prints the literal 'AED 0.00' from a fallback (charging.js: aed(t.advance) || 'AED 0.00') while production answers totals.advance null with 0 rows. Render it ABSENT with production's reason ('no entry recorded') instead
- Fix the window claim. /api/ledger/entries reads only from/to, so period=month is answered with the whole record (measured today: from null, to null). The caption 'Both figures above and both tables below are over This month' is therefore untrue. Send an explicit from/to for the window (or have the route resolve period); until then the caption must say 'whole record'
- 'What none of this is checked against' becomes the † absence band (a meter to check it against: none · why the access is not there: token expired 2026-09-10 + billing gate · a complete feed still would not settle vehicle ≠ person · idle hours at charging sites are not evidence), keeping the full text and the Supply link
- Order: 00 → Record one → Who has had what → Every entry → 01 → † absence band

**Add (from the redesign, with its data source)**

- Tile 'Drivers with one: 0 of 347' (denominator added) — *source:* /api/ledger/people (already fetched)
- Tile 'A meter to check it against: none ingested' — *source:* the fact already stated in the gap panel
- 01 'Both sides of this reconciliation': people the form can point at (347) / with a charging advance (0) / with a charging session (outline: none ingested) — *source:* people + entries.by_person

**Keep**

- The form, both tables, all five bullets and the Supply caveat (their content becomes the absence band)

**Leave structurally untouched (restyle only)**

- Form, register, 'Who has had what' largest-first order, the repayment note

**Not adopted from the mockup**

- 02 'The eighteen books' bars and the 'Books on this ledger 18' tile: no GET serves the registry (the mockup read it from a refusal message), and it is not about charging
- 03 people per channel and 04 channels per person: roster composition is the identity page's question and says nothing about charging
- 05 'window asked vs answered' chart: fix the window instead of drawing the defect

*Tests that pin this page:* collector/test/charging_page.test.mjs (headline /ADVANCED IN/i; 'AED 420' fixture figure; 'says which dates it is over'; largest first; proof links; Tesla gap text), collector/test/ledger_register.test.mjs, collector/test/ledger_absent_not_zero.test.mjs

#### `policy` — effort M

*Today:* 'Where it stands': a note that no threshold has ever been stored, and a note that anybody who can reach this URL can move the line. 'Move it': the line (%), applying-from date, set by (name), why it is moving, 'See who this moves' (dry run), 'Set the line' (disabled until checked). 'Every line this fleet has had': history marked in force / starts later / superseded. Its empty note says 'The first one recorded below', but the form is above. At 1440 the 'The line' input is invisible: no border and no placeholder, a blank gap under the label (seen on the mirror). Data: /api/ledger/policy.

**Change**

- Give 'The line' a visible field with a '%' suffix
- History note 'recorded below' → 'recorded above'
- Order: 00 → Where it stands (notes as the band's opening line) → Move it → Every line → 01 → distributions → † absence band (a stored line: none, ever; what each person owes; cash held: not derivable; who may move this line: nobody is authenticated)

**Add (from the redesign, with its data source)**

- 00 tiles: People this line would govern 347 (hero) · The line in force: none stored (production's words) · Lines ever recorded 0 · Exposure measurable 0 of 347 — *source:* /api/ledger/policy + /api/ledger/exposure summary (one extra GET)
- 01 'What a lending line needs, and how much of it exists': advance book 0/347, deduction book 0/347, opening cash 0/347, earnings figure 221/347 — *source:* exposure people[].owes.advance_rows / deduction_rows / cash_basis, earned
- Cash-taken distribution; 'both halves of the ratio on the same person' (both 145 / cash only 131 / earnings only 3 / neither 68) — *source:* exposure owes.cash_taken, earned

**Keep**

- The form (append-only, check before set), the history with its in-force / starts-later / superseded marks, both notes

**Leave structurally untouched (restyle only)**

- Form fields, dry-run-then-set, history list

**Not adopted from the mockup**

- Tile 'Types the register accepts 18', 02 registry by book and 03 direction per type: no GET serves the registry; the mockup read it from schema files and a refusal message

*Tests that pin this page:* collector/test/policy_ui.test.mjs (line in force as headline with date and setter; history count; reason; in-force / starts-later / superseded marks; both dates on each row; 'authenticates nobody'; save starts disabled), collector/test/ledger_policy.test.mjs, collector/test/ledger_ui.test.mjs ('35% … in force since')

#### `deposits` — effort M

*Today:* Desktop worklist. 'Record a handover': supervisor chips (44px), kind 'Cash handed in', driver search, amount with a live echo, date, photograph, note, 'Check it' / 'Record it' (disabled until checked). 'Who is carrying cash': notes, then a 347-row table (driver, cash position, advances, exposure) sorted by stated cash position. Every position is null, so the order is effectively A–Z; the table renders as cards at narrow widths. Data: loadPeople() (unwindowed). The mockup has no form and no table.

**Change**

- Order: 00 → Record a handover (unchanged) → 01 top-20 bars → Who is carrying cash table → distributions → † absence band (what each driver holds: 347 of 347 unknown; owes: 0 rows; the line: never stored; window: this page is the whole record)
- State that the control bar's window does not apply (the exposure read is unwindowed), as #policy already does

**Add (from the redesign, with its data source)**

- 00 tiles: Ceiling on cash outstanding AED 3,430,564.43 (hero; 276 of 347; 62,321 cash trips; 19 Dec 2024 – 23 Sep 2026) · Cash actually in hand: unknown for all 347 (reason) · Drivers carrying a ceiling 276 (71 no cash fare) · Cash trips behind it 62,321 (mean AED 55.0, derived) · Handovers recorded 0 — *source:* exposure owes.cash_taken / _trips / _from / _to (already fetched); the handover count needs /api/ledger/entries?type_code=cash_deposit (one extra GET)
- 01 'Who is carrying the most': the top 20 by ceiling as ranked bars — *source:* exposure owes.cash_taken
- Table columns 'Cash fares on record (ceiling)' and 'Last cash fare'; table made sortable with the default order unchanged — *source:* exposure owes.cash_taken, cash_taken_to
- Ceiling bands histogram; the month of each driver's last cash fare (is cash still coming in); concentration curve (58 drivers carry half) — *source:* exposure owes.cash_taken, cash_taken_to

**Keep**

- The form exactly as is
- The table, its default sort, the .dash reasons and the card mode

**Leave structurally untouched (restyle only)**

- The form (the worklist's purpose) and its 44px touch targets
- The table's default order and card mode

**Not adopted from the mockup**

- The mockup's absence of the form and table
- The sparkline on 'Drivers carrying a ceiling': the payload holds no series for it

*Tests that pin this page:* collector/test/deposit_ui.test.mjs (desktop form renders; amount and chip ≥ 44px; .dash with title reason; .depamount + .depnote echo; .depactions .primary disabled; .depverdict .note; no sideways scroll at 1280), collector/test/ledger_absent_not_zero.test.mjs

#### `deposits/phone` — effort S

*Today:* The phone app (m/screens.js deposits, loaded when max-width 760px and pointer is coarse). Cards in order: Recorded by (supervisor chips, sticky for the session), From (search; the picked person's line names their account or 'new'), Amount (decimal keypad + echo), Photograph of the receipt (rear camera, compressed on the device), Record the deposit. Rules come from deposit_core.js. (A desktop render at 390px without a coarse pointer is a different page: 347 cards, 56k px tall.)

**Change**

- Restyle through m.css tokens only (Arkiv type and ink; touch targets stay ≥ 44px)

**Keep**

- The one-handover flow, camera in the flow, on-device compression, sticky supervisor

**Leave structurally untouched (restyle only)**

- Card order and flow: it is used standing at the car

**Not adopted from the mockup**

- No glance band or charts on the phone screen; the mockup is desktop-only

*Tests that pin this page:* collector/test/deposit_ui.test.mjs (the phone screen takes its rules from the core), collector/test/phone.test.mjs

### Finance

#### `finance` — effort L

*Today:* V.finance in api/public/app.js (about lines 2632-3270). It calls 10 endpoints: /api/kpis, /api/mix/detail?by=payment, /api/mix, /api/mix?by=service, /api/finance/ledger, /api/earnings/components, /api/earnings/tips, /api/finance/daily, /api/settlement/mix and /api/trips/daily. What renders on the mirror (This month): (1) a verdict band: 'AED 135,754 was collected in cash and has to be handed in', 19% of the money. (2) 8 tiles: Money in AED 714,783 (every channel on its chosen basis); Fares 85,545 with fare coverage; Platform payouts 556,547, with a sentence naming which channels are counted and which are not, taken from uncounted_payout_bases; On-trip revenue 628,972; Average fare 60.48; Revenue per km 4.52, with its numerator shown; Cash collected (measured portion), with three states that separate a real zero from an absence; Tips 4,818, the fleet total rather than the ranked list. (3) A fare-coverage note. (4) 'Money in per day': gapBars in green --s3, where a day nothing reported is a hole. Under it: a caption splitting the money by basis (statement / derived open week / fares / payout), the open-week 'why' from the endpoint, a grain sentence, and a warning if the bars drift from the tile. (5) 'Payment mix': a donut of settlement classes. Slices click through to #settlement/cash, #settlement/receivables and #corporate/leakage. (6) 'What each priced tier earns': a 6-column sortable table (it scrolls sideways at 1440 in a half-width panel), a within-platform comparison and the Uber personal/business split. (7) 'What makes up a payout': componentTree bars in blue/orange plus a 5-column table. (8) 'Tips by driver': top 30, 4 columns, the server's fare floor, tone pills, driver links. (9) 'Ledger by category': signed hbars in blue/orange, a net line, and unpriced categories named.

**Change**

- Section order: 00 At a glance → 01 Money in, day by day (hero chart, full width) → 02 Trip value a day | 03 Platform payouts a day (a pair) → 04 How the rider paid → 05 What each priced tier earns (full width) → 06 What makes up a payout (full width) → 07 Tips by driver → 08 What the operator ledger added | 09 What it took out → 10 What this page does not know.
- 00 band holds 6 tiles: Money in (HERO, the one highlight), Platform payouts, On-trip revenue, Cash collected (measured portion), Trip value booked (new) and The open week (new). The verdict text becomes the band's claim line.
- Fares, Average fare and Revenue per km move out of the top band into a 3-tile row heading section 05. All three are over priced trips only, so they sit beside the table that shares that base. The Tips tile moves to the head of section 07. No tile is dropped.
- The fare-coverage note under the tiles moves into the absence band (section 10), word for word, together with Money out and the uncounted-payout share.
- Chart 01: recolour from --s3 green (reserved for 'better' under Arkiv) to a single ink series. Hatch the open-week days. Re-set the composition caption as mono caption lines (open week · closed weeks · total · basis split). Every fact stays.
- The Payment mix donut becomes ranked horizontal bars, one per settlement class, labelled with count, share and revenue. Card and wallet (settled at the ride) are ink; everything else is grey. Every bar keeps its click-through to the same destination as the slice.
- The tier, component and tips tables leave the half-width g2 grid for full width, so the tier table stops scrolling sideways at 1440 ('Scroll the table sideways for 2 more columns' on the mirror). Restyle them to hairline rules.
- Payout component bars and ledger bars go from --b400/--s2 (blue/orange) to ink for money added and grey for money taken out, with the direction in the label. There is no channel colour: /api/finance/ledger rows carry no platform field.
- 'Ledger by category' splits into two ranked charts: 08 added (positive categories) and 09 took out (negative categories). The net line and the unpriced-category sentence sit under the pair.
- Tip-rate pills (green/amber/red on a level, not on a change) become plain tabular figures. Rows below the fare floor stay dim with their tooltip. The ranking is unchanged. Keep the pill class names if the foundation restyles .pill (see cross-cutting).

**Add (from the redesign, with its data source)**

- Tile 'Trip value booked': gross fare on every priced booking, never added to Money in, with a week-on-week delta over whole days. — *source:* /api/finance/daily totals.fares; rows[].revenue for the delta
- Tile 'The open week': the money in the week whose statement has not been filed, with its rate and basis. Today it appears only inside a caption. — *source:* /api/finance/daily totals.money_derived_part + open_statement[] (rate, days, open_start, open_end, why)
- Week-on-week delta and a sparkline on the Money in and Platform payouts tiles, over whole days only. The Money in sparkline covers closed statement weeks, because Uber files weekly. — *source:* /api/finance/daily rows[].money / rows[].payout / rows[].money_derived
- Chart 02 'Trip value a day', with today hatched as unfinished. — *source:* /api/finance/daily rows[].revenue
- Chart 03 'Platform payouts a day', with today hatched. — *source:* /api/finance/daily rows[].payout
- Hatch the open-week days on chart 01 (SPEC §5 HATCH). Today they are drawn exactly like filed days. — *source:* /api/finance/daily rows[].money_derived
- An absence-band tile 'Money out'. Its reason is computed, not hard-coded: no provider feed reports a cost, and the operator ledger (#charging, #salary, #advances) holds N entries for this window. N is 0 today. — *source:* /api/ledger/entries totals.rows + absent_reason

**Keep**

- Money in = k.accounted over EVERY channel on its chosen basis (AED 714,783 this month). The mockup's Money in is Uber's statement only, which is less data.
- The Platform payouts tile and its sub-line: which channels wired it, the days and drivers, and the 'not counted as income here, … so the same work is not counted twice' clause built from uncounted_payout_bases. test/caption_matches_figure.test.mjs reads this tile.
- The Fares, On-trip revenue, Average fare, Revenue per km (with the priced_measured_revenue numerator) and Tips tiles, all with their current sub-lines. Tips stays the fleet total from tipRows.totals, not the ranked sum.
- Cash collected (measured portion), with its three states: a measured AED 0 / no route recorded / no booking at all.
- The verdict claim, the share of money in a driver's hand. Its text is unchanged; it moves to the 00 band's claim line (see change).
- Money in per day: a day with nothing_recorded stays a HOLE, never a zero bar. Keep the basis-by-basis composition sentences, the open_statement[].why text from the endpoint, the grain sentence and the bars-vs-tile drift warning.
- The payment classes and their click-through destinations: Cash → #settlement/cash; On account and Salary → #settlement/receivables; Card and Wallet → #settlement; Complimentary → #corporate/leakage. Also the unlabelled-trips caption.
- The tier table's 6 columns (Tier, Trips, Priced, Fares, Share of revenue, Per priced trip), sortId tierrev with Fares descending by default, the within-one-platform-only comparison caption, the Uber business-split caption, and the no-fare fallback table with its capped disclosure.
- The payout component tree and its table (Within, Component, Amount, Share of its parent, Drivers), plus the whole-period absence sentence.
- The tips table: 30 rows, floor-first then rate ranking, the server's fare_floor and excluded_n sentence, the ranked-vs-fleet sentence, and driver links.
- The ledger's signed bars, its net line, the sentence naming unpriced categories, and the 'a ledger nobody valued' absence.

**Leave structurally untouched (restyle only)**

- The tips table's order (floor first, then rate), its 30-row cut disclosure and its driver links. Operators coach from this list.
- The tier table's columns and default sort (tierrev, Fares descending).
- The click-through destinations of the payment classes.
- The Money in per day hole semantics: an unreported day is never a zero bar.

**Not adopted from the mockup**

- Money in defined as Uber's statement net only ('Uber unless a mark says otherwise'). Live counts every channel on its chosen basis; the mockup's definition is less data.
- 06 'Every document a provider filed' and 07 'Over how many days each one runs'. These are /api/finance/receipts, which #receipts exists to show. Duplicating them puts an 11th fetch on the heaviest money page; link to #receipts instead.
- The absence tile 'Superseded filings 63 / AED 711,002.73'. It belongs on #receipts.
- The absence tile 'Ledger days 0 of 30' as fixed text. It is window-specific: today /api/finance/daily rows carry ledger amounts (25 Aug: AED 31.53 over 4 entries), so the sentence would be false. It may render only if computed from the rows.
- The hard-coded 'No cost feed reaches here'. The reason must come from /api/ledger/entries, because the operator ledger can hold charging, salary and advances.

**Review corrections (adopted — they override the lines above)**

- *Data source corrected:* finance 'Money out' and settlement/cash 'Cash banked' from /api/ledger/entries. The route reads only from/to (ledger_routes.js:540-544) and ignores period, so an 'N entries in this window' reading would really be the whole record. absent_reason is also null on fleet-wide reads; it is set only for a driver lookup. Send from/to explicitly and write the reason in the client from totals.rows.

*Tests that pin this page:* test/caption_matches_figure.test.mjs (opens #finance, finds the .kpi .l 'Platform payouts' tile and reads its sub), test/held_fields.test.mjs (tips tile = fleet total, not the ranked sum), test/fare_reason_shared.test.mjs (UBER_FARE_WHY in the tier caption), test/money_contradictions.test.mjs (reads KPI figures after countUp), test/components.test.mjs (componentTree behaviour), test/lazy_assets.mjs (MAPLESS includes 'finance')

#### `receipts` — effort L

*Today:* api/public/receipts.js renderReceipts, one endpoint: /api/finance/receipts. (1) 4 tiles: Filings on record (the headline is deliberately a COUNT), Credited net of re-filings (superseded amount in the sub), Filed for a single date, Newest filing received. (2) 'By month, as the providers booked it': a barChart plus a 5-column table (Month, Credited, Left out as superseded, Filings with straddle count, Channels). It renders only when the window spans more than one month, so it is absent under This month. (3) 'Every filing, newest first': a 9-column sortable register (Covers, Grain tag, From, What it is, Amount with superseded rows dimmed, Of which fees in red, People, First seen, Status Superseded / Counted-re-filed / Counted), captioned with the endpoint's note and restated_note. (4) month_note. (5) Links to #reconcile, #settlement/cash, #settlement/receivables and #provenance. No charts render on the mirror.

**Change**

- FINDING, needs an operator ruling: 'Credited, net of re-filings' adds together kinds that are different views of the same trading. On the mirror over 30 days it is AED 2,904,381 = Uber earnings components 2,214,113 + Uber payout breakdown 686,124 + Yango ledger 2,667 + Yango payout 1,478. The mockup's §03 refuses this sum ('Not a total'). Replace the single tile with per-kind chart 03. Stop merging kinds in the byMonth fold, so the month table has one row per month × kind and the month chart becomes one small multiple per kind. The server already returns months per platform × kind.
- FINDING: the 'First seen' column and the 'Newest filing received' tile are captioned 'when the document reached us', but every row's first_seen is the last money_event rebuild. 116 of 116 rows in 30 days, and 2,000 of 2,000 in 365 days, share one minute (2026-09-23 10:07). The tile becomes an absence tile, 'When each one arrived: one stamp on all N', giving that reason. The column is dropped while every row carries the same stamp, with the reason printed under the table (tableFrom's absent: pattern). Preserving the ingest time across rebuilds is a collector fix, not a UI one.
- Section order: 00 At a glance (Filings on record HERO · Set aside as re-filed · Provider rows inside · Filed for a single date · Days claimed · When each arrived [absence]) → 01 documents per day → 02 displaced per day → 03 | 04 by kind → 05 | 06 grain / surface → 07 By month (per kind, when >1 month) → 08 Every filing (register) → 09 What this page does not know (arrival stamp, restatement rule, straddle convention, why the kinds are not a total).
- Grain 'One day' tag (green ok) and Status tags (ok/warn) become neutral tags. Superseded gets a grey-2 outline, not amber.
- 'Of which fees' drops var(--critical) red text for ink with a minus sign. A deduction is not 'worse'.

**Add (from the redesign, with its data source)**

- Tile 'Set aside as re-filed' = sum(amount of superseded rows) + sum(superseded_amount of part-superseded rows). Today this is only in the Credited tile's sub. — *source:* /api/finance/receipts rows[].superseded, superseded_amount
- Tile 'Provider rows inside' = sum rows_seen. — *source:* /api/finance/receipts rows[].rows_seen
- Tile 'Days claimed' = the union of the period_start..period_end days. — *source:* /api/finance/receipts rows[].period_start/period_end
- Chart 01 'How many documents claim each day' (per-day count; days after today hatched). — *source:* /api/finance/receipts rows (client-side count)
- Chart 02 'How many of each day's claims a later filing displaces'. — *source:* /api/finance/receipts rows[].superseded
- Charts 03 'What each kind is worth' (per-kind sums after the overlap rule, never summed across kinds) and 04 'What a later filing displaced', by kind. — *source:* /api/finance/receipts rows[].kind, amount, superseded_amount
- Chart 05 'The grain each was filed at' (a histogram of days per document) and chart 06 'Which surface filed them' (source counts, with the fleet split). — *source:* /api/finance/receipts rows[].days, source, fleet_id

**Keep**

- The register table's 9 columns, its sort (sortId rcpt), the 3-state Status, the Grain column (which says a weekly filing is never divided into days), and the endpoint's note and restated_note as its caption.
- The month rollup, table and chart: its superseded column, the straddle count per month and the 'a period belongs to the month it ENDS in' convention.
- 'Filings on record' as the HERO. Live states the reason in code: a register's first fact is how many documents it holds.
- 'Filed for a single date' and its sub ('not divisible into daily figures without inventing them').
- The empty-state reasons and the links to #reconcile, #settlement/cash, #settlement/receivables and #provenance.

**Leave structurally untouched (restyle only)**

- The register table: it is the finance team's reconciliation register (one row per document, sortable, with a status per row).
- The superseded rule and its wording, which come from the endpoint (longest period wins, then newest).

**Not adopted from the mockup**

- 07 'The ten largest documents on the register'. It duplicates the register sorted by Amount.
- Making 'Set aside as re-filed AED 711,002.73' the page's HERO. Live's reasoning is that a register's first fact is its count; the excluded money becomes a tile. This is the operator's call.
- The mockup's 'Uber, on four of its surfaces' / 'Channels filing anything 1 of 4' as fixed text. On the mirror, Yango files 28 of the 116 documents in 30 days, so any channel count has to be computed from the rows.

**Review corrections (adopted — they override the lines above)**

- *Correction adopted:* instead of “Removing the 'Credited, net of re-filings' tile and splitting the month table by kind”: Keep the tile with a 'not a total across kinds' caption until the operator rules. (The plan itself marks this as needing an operator ruling, yet it is written as the change. Removing a live headline figure by default breaks rule 1.)

*Tests that pin this page:* test/routes_list.mjs, test/receipts_register.test.mjs (server only; affected only if the month split changes the endpoint), No front-end test covers #receipts. The redesign should add one, including for the per-kind split and the first-seen absence.

#### `payouts` — effort L

*Today:* api/public/payouts.js renderPayouts, using qChan with no window (NO_RANGE) over /api/finance/payouts and /api/finance/payouts/reconcile. (1) 4 tiles: Transferred to the bank AED 10,804,336 (333 transfers on N dates on record); Dates money arrived ('every one of them a Monday'); Platforms that publish a transfer 2 of 3 (warn tone); The record starts 23 Dec 2024. (2) reconcileSection (data-panel payout-reconcile): 'Each wire against our own figure', 9 columns (Arrived, Platform, Fleet, The wire, Settles, Our figure, Difference, Against the opening balance, Asked live), newest 12 with a fold, every absent Our figure carrying its reason. Per-fleet live-ask buttons (POST /api/finance/payouts/verify, which locks every ask button). 'What has been checked against Uber's transaction report' (audit, when present). 'What we have not asked Uber about' (197 + 197 days, date chips, pick-newest and show-more buttons). (3) 'Every transfer, by the date it arrived': 6 columns, the Bolt balance-ledger marker (listed_by_provider false, landed 2026-09-23), first seen, folded to 20, cards on a phone. (4) 'The same transfers, in order': barChart of all platforms summed by date, inside .chartscroll. (5) 'What each platform publishes about its own transfers': a 5-column table, absent notes, Bolt's balance and next payout date, expected_missing warnings. (6) 'The provider's own books, day by day': 10 columns (basis pill, opening/closing balance, earned, cash, fee, to the bank), folded to 14. (7) d.note.

**Change**

- Section order: 00 At a glance → 01 wire vs ours → 02 difference (+03 zoom) → 'Each wire against our own figure' table plus the ask controls (unchanged) → audit panel → 'What we have not asked Uber about' (unchanged) → 04 Uber by month | 05 Bolt by month → Every transfer (register) → What each platform publishes (with Bolt balance and next payout) → The provider's own books → 06 What this page does not know.
- 00 band: Transferred to the bank (HERO, the highlight, with the channel split and the Monday and record-start facts as sub-lines) · Can be checked · Difference over those · The latest wire · Yango, publishes no transfer (an absence tile taking its reason from coverage[].absent, which replaces the amber-toned '2 of 3' tile; the count stays in its sub).
- 'The same transfers, in order' (all channels summed per date) is replaced by chart 01 plus 04/05. The per-date Bolt detail stays in the register. The new chart keeps the .chartscroll wrapper and the phone-only caption.
- Bars take channel identity (Uber #2362D3, Bolt #0398BA) with direct labels. The 'ledger' pill (warn) and the statement/ledger basis pills become neutral chips.
- No new fetch: every new tile and chart reads the two payloads already loaded. test/payout_scope.test.mjs counts exactly 3 qChan('/api/finance/payouts…') calls.

**Add (from the redesign, with its data source)**

- A per-channel split under the hero (Uber AED x · Bolt AED y). — *source:* /api/finance/payouts payouts[] grouped by platform
- Tile 'Can be checked against ours' = comparable_rows of rows (65 of 333). — *source:* /api/finance/payouts/reconcile totals.comparable_rows, rows
- Tile 'The difference over those', with wire_comparable against calculated. — *source:* /api/finance/payouts/reconcile totals.delta, wire_comparable, calculated
- Tile 'The latest wire': the newest comparable transfer, the week it settles, our figure, and the difference in AED and %. — *source:* /api/finance/payouts/reconcile rows[] (wire, period_start/end, calculated, delta, delta_pct)
- Chart 01 'Every Uber transfer date, and our own figure beside it'. Bars = the wire in Uber identity blue; an ink tick = our figure; a grey-2 outline = no figure of ours; a strip beneath marks which transfers can be compared. — *source:* /api/finance/payouts/reconcile rows[].wire, calculated, calculated_absent
- Chart 02 'The difference, per transfer' over the comparable transfers. — *source:* /api/finance/payouts/reconcile rows[].delta
- Chart 03, a zoomed twin of 02, only with a stated threshold computed from the data and the excluded transfers named in its caption. Today, three February transfers carry AED 359,678 of the 362,992. — *source:* /api/finance/payouts/reconcile rows[].delta
- Charts 04 'Uber, by month' and 05 'Bolt, by month', each channel on its own scale. — *source:* /api/finance/payouts payouts[] grouped by month × platform
- An absence band. Transfers we can check: 65 of 333 (179 Bolt transfers name no period; 89 Uber transfers have no driver-day rows). Checked against Uber's transaction report: none (audit.audited_days 0, with audit.means). Days Uber was never asked about: 394 (sum of unchecked[].count). Yango transfers: not published. — *source:* reconcile rows[].calculated_absent, audit, unchecked[]; payouts coverage[].absent

**Keep**

- Every panel and table listed in the live summary, with their columns, folds, sort ids, cards/cardLead and absent-column reasons.
- The Bolt balance-ledger 'ledger' marker and the first-seen line on register rows (the Bolt ledger work of 2026-09-23).
- The facts in the 'Dates money arrived' and 'The record starts' tiles: the weekday finding and the record start date.
- The whole-register scope with no window (qChan, NO_RANGE), and the WHERE wording 'on record' / 'in this window' taken from d.scope.

**Leave structurally untouched (restyle only)**

- The wire-vs-ours table, the live-ask buttons and the lock-all-buttons behaviour. The operator asks Uber from here.
- 'What we have not asked Uber about', with its date chips and pick buttons.
- The register (sortId payout-rows, fold 20, cards with cardLead paid_on), the books table (fold 14, cards), and the coverage table with Bolt's balance, next payout date and expected_missing warnings.
- data-panel='payout-reconcile', the Difference / Our figure headings, and the dropped 'Asked live' column with its printed reason.

**Not adopted from the mockup**

- The mockup's fixed counts (331 transfers, 'every one of the 331 landed on a Monday'). The mirror now holds 333, so every count must be computed.
- Chart 03 if it is built as a hard-coded 'without those three February transfers'. It is only acceptable with a computed threshold and named exclusions.
- Dropping the transfer register, the coverage table, the books table and the ask controls. The mockup shows none of them, and all of them stay (rules 1 and 3).

**Review corrections (adopted — they override the lines above)**

- *Correction adopted:* instead of “'The same transfers, in order' replaced by an Uber-only per-date chart plus by-month charts”: Keep per-date bars for each channel, Bolt included, inside .chartscroll. (There would be no per-date chart of Bolt transfers any more (rule 1). The register alone is a weaker view of it.)

*Tests that pin this page:* test/payout_mobile.test.mjs (exactly 4 card-mode tables, .chartscroll plus the phone-only caption, one-line short fields, no sideways scroll at 390, page height), test/payout_page_reconcile.test.mjs (data-panel payout-reconcile, Difference / Our figure heads, Asked live dropped with its reason, '217.57', unasked-day counts text), test/payout_scope.test.mjs (3 qChan calls, no q(), NO_RANGE includes payouts), test/payout_register.test.mjs (weekdayOf export)

#### `reconcile` — effort M

*Today:* api/public/reconcile.js renderReconcile(root, null), using qChan over /api/reconcile and /api/reconcile/periods. The range selector is hidden; the scope is the whole record. (1) Verdict from headlineVerdict(): '5 months of 24 can be reconciled at all'. (2) 5 tiles: Trips, Expected payout (with coverage), Bank payout (with coverage), Compared over (driver-days), Gap (deltaPill). deltaPill carries the 15% salik floor, statement_partial and period_cut logic. (3) 'Month by month': a 10-column sortable table (Month linking to #reconcile/YYYY-MM, Trips, On-trip net, Tips, Salik, Cash collected, Expected payout with a report-spread basis marker, Bank payout with the compared figure beside it, Δ bank − expected pill, Compared over). (4) 'What each statement said': 7 columns (Period, Channel, Fleet, Drivers, Net, Of which cash, Complete whole / cut by the window), a mixed-grain warning, and the whole-period total 'to check a bank statement against'. (5) The endpoint's note and the timing / 192-day-horizon note. No charts.

**Change**

- Section order: 00 At a glance (Bank paid over statement HERO · latest gap · latest bank paid · Compared over · Trips) → 01 expected vs paid → 02 gap trend | 03 what the expectation is built from → 04 every month on record → Month by month table → What each statement said → What this page does not know.
- The Expected payout and Bank payout tiles move into chart 01's caption line as totals, each with its coverage sub-line, so the band stays at 5 tiles. No figure is dropped.
- deltaPill: keep the ok/warn/bad/dim class names and tone thresholds, and restyle .pill tones through the foundation (see cross-cutting). A tolerance band on a gap is not better/worse.
- Charts use Uber identity only when the platform chip narrows to Uber. Unfiltered, the series are all-channel and drawn in ink.

**Add (from the redesign, with its data source)**

- HERO 'Bank paid over statement' = totals.delta (AED 73,861.06), with bank_covered against expected_covered over the comparable months. Today this is inside the Gap tile. — *source:* /api/reconcile totals.delta, bank_covered, expected_covered
- Tile 'The gap in <latest comparable month>': delta_pct, with the change against the previous comparable month and a sparkline. — *source:* /api/reconcile rows[].delta_pct (comparable rows only)
- Tile 'Bank paid in <latest comparable month>': bank_covered, with a NEUTRAL delta against the prior month. — *source:* /api/reconcile rows[].bank_covered
- Chart 01 'What the statement expects, and what the bank paid': paired bars per month of expected_covered against bank_covered. Months with statement_partial or period_cut are marked †. — *source:* /api/reconcile rows[]
- Chart 02 'Is the gap closing?': a delta_pct line over the comparable months, with non-comparable months as gaps. — *source:* /api/reconcile rows[].delta_pct
- Chart 03 'What the expectation is built from': on-trip net, tips, salik, cash taken out, and the four netted. — *source:* /api/reconcile totals.ontrip_net, tips, salik, cash_collected, expected_payout
- Chart 04 'Every month on record': bank payout columns, with a grey-2 outline for months that filed no money row and the open period hatched. — *source:* /api/reconcile rows[].bank_payout, period_cut
- Absence band: months that cannot be compared (totals.not_comparable_reasons); the bank side is the platform's own payout report, not a bank-statement feed; salik not seen on N months (rows with salik null); the statement horizon. — *source:* /api/reconcile totals.not_comparable_reasons, rows[].salik, statement_horizon
- Tile / absence 'Channels answering' (on the mirror: Uber has both sides over 8 months, Yango has the bank side only over 5 months, Bolt and Hotel have neither). — *source:* needs a per-platform summary on /api/reconcile. The unfiltered answer is platform '*', and 4 extra filtered reads of the heaviest endpoint on every load is not acceptable. — **needs a new endpoint**

**Keep**

- headlineVerdict() and its claim ('5 months of 24 can be reconciled at all'). It moves to the 00 band's claim line.
- The Trips, Expected payout, Bank payout and Compared over tiles, each keeping its own coverage sub-line.
- deltaPill logic: the salik floor at 15%, statement_partial, period_cut, and the exported function names (spreadRuns, deltaPill, headlineVerdict).
- The Month by month table, all 10 columns, with month links to the day view.
- The 'What each statement said' table, its whole / cut marker, the mixed-grain warning and the whole-period total sentence.
- The timing and 192-day-horizon notes.

**Leave structurally untouched (restyle only)**

- The Month by month table and its month → day drill-down (sortId recon-months).
- The statement periods table, which holds the figure a bank line is checked against.
- The hidden range selector (whole record) and qChan's no-'?' cache-key guard.

**Not adopted from the mockup**

- 'Channels answering 1 of 4' and 'All 18 rows are Uber' as fixed text. The unfiltered endpoint returns 24 all-channel months, and Yango contributes AED 17,788.93 of the bank side.
- The green ▲ on 'Bank paid in Aug 26 +75,925.33'. A bigger payout is not 'better' on a page whose question is agreement, so the delta is neutral.
- The mockup's 18-month count. That was Uber-filtered; live shows 24.

**Review corrections (adopted — they override the lines above)**

- *Correction adopted:* instead of “The Gap tile replaced by a 'Bank paid over statement' hero built from totals.delta”: Render the hero's value through deltaPill(t). (The live Gap tile goes through deltaPill, which applies the 15% salik floor and the statement_partial and period_cut judgements. The plan does not carry that judgement onto the hero.)

*Tests that pin this page:* test/reconcile.test.mjs (deltaPill pill class names, NO_RANGE lists, reconcile.js exports), test/reconcile_headline.test.mjs (headlineVerdict), test/kpi_pill.test.mjs (five tiles at 1180px, Gap pill fit), test/kpi_one_tile.test.mjs (Gap tile markup)

#### `reconcile/<YYYY-MM>` — effort S

*Today:* The same module, with the month set: a '← All months' link, a verdict ('31 days of 31 can be reconciled at all'), the same 5 tiles at day grain, '<Month>, day by day' (10 columns, Day linking to #day/YYYY-MM-DD), a spreadRuns caption naming the days that repeat the previous day's figures (a weekly report spread across its days), the statement periods for that month, and notes.

**Change**

- Restyle through the foundation: 00 band from the same tiles; chart 01; the day table and statement table unchanged; notes move to the absence band.

**Add (from the redesign, with its data source)**

- Chart 01 at day grain: expected_covered against bank_covered per day, captioned (not hatched) where a side is a weekly report spread across its days, following C-finance's 'plateaus are the grain' convention. — *source:* /api/reconcile?month= rows[] incl. expected_period_days / bank_period_days

**Keep**

- The day table and its links to #day/<date>, the spreadRuns caption, the statement periods panel, the back link, and the 5 tiles.

**Leave structurally untouched (restyle only)**

- The day table, its drill-down to #day, and the repeated-day caption.

*Tests that pin this page:* test/kpi_pill.test.mjs (#reconcile/2026-08 five tiles at 1180px), test/reconcile.test.mjs

#### `settlement/mix` — effort M

*Today:* #settlement (default tab), api/public/settlement.js settleMix over /api/settlement/mix. Tab bar: How fares are paid / Cash in hand / Outstanding. (1) Verdict: '21% of bookings are still to be collected'. (2) 6 tiles: Bookings with a settlement route; Settled at the ride (card + wallet, green); Paid in cash; Settled after the ride; Settled off-platform (priced sub); Everything else (a remainder, so the tiles reach 100%). (3) 'Every booking, by how it was paid': a stackedBar. (4) One card per class (count, share, meaning, revenue, average fare starred when coverage is under 50%, priced n of N, channels). Cash, on-account, salary and complimentary cards link to their tab or to #corporate/leakage. (5) Unlabelled note and the 'Revenue: not reported is not zero' note. On the mirror (30 days) the classes span 4 channels: cash is bolt, hotel, uber and yango; on_account is bolt and hotel; salary is hotel.

**Change**

- 00 band: HERO = 'still to collect' (the verdict's figure: outstanding count and %), with the booking total and unlabelled count as its sub-line. Tiles: Settled at the ride · Paid in cash · Settled after the ride · Settled off-platform · Everything else (only when non-zero). The 'Bookings with a settlement route' tile folds into the hero's sub-line.
- The stackedBar becomes ranked horizontal bars (mockup 02), one per class, labelled with count and share. Card and wallet are ink (cleared at the ride); the rest are grey. The 2-ride 'other' class stays legible.
- The tile tones (good/warn) and the class cards' TONE borders (good/warn/critical) become neutral. These are levels, not changes. Cards are restyled as hairline tiles and keep their links.
- The notes move into the absence band (unlabelled bookings; 'not reported' is not zero).

**Keep**

- The three tabs and their addresses (#settlement, #settlement/cash, #settlement/receivables). They are linked from #finance, #receipts, the class cards and the payment-mix bars.
- The six tile definitions. Off-platform stays separate from 'settled at the ride', with its priced sub-line, and 'Everything else' stays a computed remainder.
- The class cards, with their links, the average-fare coverage star and the channels line.
- The verdict text and both notes.

**Leave structurally untouched (restyle only)**

- The tab bar and addresses, the card links, and the star on thin averages.

**Not adopted from the mockup**

- Merging the three tabs into one page. It would drop the addresses other pages link to and stack three pages of tables.
- 'Cleared at the ride 80.2% — card, wallet or off-platform'. Live deliberately separates off-platform as not settled at the ride in any sense.
- 'Channels labelling a route: Uber only'. On the mirror, classes are labelled by bolt, hotel, uber and yango.

*Tests that pin this page:* test/spacing.test.mjs (#settlement chart flush under its title), test/routes_list.mjs

#### `settlement/cash` — effort M

*Today:* settleCash over /api/settlement/cash-exposure and /api/revenue. (1) Verdict: '23% of cash bookings carry no fare at all'. Its figure is the value we can see; recommend shows the statement figure only when it is larger. (2) 4 tiles: Cash bookings 3,191; Value we can see AED 132,127 (a floor, with coverage); Cash the platforms report AED 110,443 (statements); Drivers holding cash 118 (people folded through the merge register, with a cohort link). (3) Caveat note. (4) 'Who is holding it — 194 rows for 118 people': 8 columns (Driver link, Cash bookings, Value known, Coverage, Statement cash with stmt and † for shared names, Channels, Vehicles links, Last cash trip), default sort Value known descending, capped at 200. (5) A computed caption for blank values, and the note excluding supervisor-collected cash.

**Change**

- FINDING: the 'Cash the platforms report' tile's sub always ends 'a different measurement of the same money, and the larger of the two'. On the mirror (This month) it reads AED 110,443 beside Value we can see AED 132,127, so it is the smaller. The comparative must be computed; the verdict's recommend already guards on reported > known.
- 00 band: HERO = Value we can see (the verdict's figure, with the blind-share claim) · Cash the platforms report · Cash bookings · Drivers holding cash · Cash banked (absence).
- Order: 00 → 01 scatter (hero chart) → the 'Who is holding it' table (the detail layer, unchanged) → an absence band (cash banked, the blind share, the supervisor exclusion, statement cash filed by name).
- The table is restyled to hairline rules and keeps its Channels text column. There is no row tint.

**Add (from the redesign, with its data source)**

- Chart 01 'Two readings of the same cash, driver by driver': a scatter with x = Value known (trip feed) and y = Statement cash, one dot per row that has both. The count of rows with only one reading is stated. — *source:* /api/settlement/cash-exposure drivers[].cash_value, statement_cash
- Absence tile 'Cash banked'. Its reason is computed from the hand-in record (0 rows today), not hard-coded. — *source:* /api/ledger/entries totals.rows + absent_reason

**Keep**

- Both readings of the cash, the fare-based floor and the platforms' statement, shown side by side and never added.
- The people-vs-rows split (118 people across 194 accounts).
- The table's 8 columns, its sort, its cap disclosure, the † shared-name marker, and the driver and vehicle links.
- The computed blank-value caption and the supervisor-exclusion note.

**Leave structurally untouched (restyle only)**

- The 'Who is holding it' table: its columns, default sort by Value known, cap, and links. This is the cash-handling control list.

**Not adopted from the mockup**

- 03 'Who is holding it' top-12 bars. They duplicate the sortable table, which can already sort by Statement cash.
- The mockup's single hero 'AED 121,372, Uber's statement' as THE cash figure. Live shows both readings, and neither may replace the other.
- The 'Uber only' framing. Cash bookings on the mirror span bolt, hotel, uber and yango.

**Review corrections (adopted — they override the lines above)**

- *Data source corrected:* finance 'Money out' and settlement/cash 'Cash banked' from /api/ledger/entries. The route reads only from/to (ledger_routes.js:540-544) and ignores period, so an 'N entries in this window' reading would really be the whole record. absent_reason is also null on fleet-wide reads; it is set only for a driver lookup. Send from/to explicitly and write the reason in the client from totals.rows.

*Tests that pin this page:* test/cash_value_caption.test.mjs (the table with the 'Value known' header and the blank-row caption at #settlement/cash), test/driver_money_tiles.test.mjs (same cash predicate as #settlement)

#### `settlement/receivables` — effort M

*Today:* settleReceivables over /api/settlement/receivables. (1) 3 tiles: Outstanding (AED over N bookings, with the no-fare count); Counterparties; Oldest debt (all-time or window, as the response states). (2) An ageing table (Age, Counterparties, Bookings, Amount), with a caption explaining why it covers all time up to as_at while the tiles cover the window. (3) 'Who owes it — 8 counterparties': 7 columns (Owed by, linking to the driver for salary and the property for on-account; Route; Bookings; Amount; Oldest; Age pill, warn over 60 days and bad over 90; Newest), default sort Amount descending, capped. (4) The exposure-not-ledger note.

**Change**

- 00 band: HERO = Outstanding · Counterparties · Oldest debt · Bookings with no fare (today only in a sub-line).
- The ageing table becomes 01 'How old the unpaid work is': horizontal bars of amount per bucket, labelled with bookings and counterparties, so no column is lost. An empty bucket draws no bar and says 'nothing outstanding', a measured zero. Keep the line `const buckets = r.ageing?.buckets;`.
- The age pills follow the foundation's rule for tones on a level. The class names stay.
- The exposure note moves to the absence band: 'whether any of this has since been collected is not in this data'.

**Keep**

- The three tiles and their sub-lines (window vs all-time on Oldest debt).
- The counterparty table, with its links, sort and cap.
- The window-vs-all-time ageing caption and the exposure note.

**Leave structurally untouched (restyle only)**

- The 'Who owes it' table (links to driver and property pages, amount order).

**Not adopted from the mockup**

- 'Unpaid, last 30 days AED 39,140 ▼ −221 better'. It compares the 0–30 bucket with the 31–60 bucket, which are different bookings at different ages, and the newer bucket is still inside payment terms. Calling the difference 'better' claims a trend nobody measured.
- 04 'Who has not paid' bars. They duplicate the table's default order and drop Route, Oldest, Newest and the links.

*Tests that pin this page:* test/receivables_ageing.test.mjs (greps settlement.js for `const buckets = r.ageing?.buckets;`)

#### `provenance` — effort M

*Today:* api/public/provenance.js over /api/money/sources and /api/revenue. (1) 3 tiles: API calls reporting money (5 sources · 8 channel-and-kind combinations); Figures the providers sent (single-day / span / restating split); What Finance counts (rev.totals.accounted and the channels chosen). (2) 'Every call that returned money in this window': 8 columns (API surface · channel · fleet, What it reports, Reported at as a grain tag, Figures, Drivers, Returned, Can it be added? yes/no with the restated count, In the headline counted / held out). (3) 'Held out of the headline — 7 of 8', with a per-row reason from why(). (4) 'The provider's own names for the money': a 44-row categories table (Category, From, Lines, Amount). (5) d.note. d.caveats (restatements, categories) is returned by the endpoint and never rendered. On the mirror (30 days) Yango's park ledger and driver summary return money beside Uber's surfaces.

**Change**

- Order: 00 At a glance (headline HERO · Calls returning money · Figures the providers sent · Figures that restate · Channels answering · Not footed [absence]) → 01 every call (hero chart) → 02 restate share → 'Every call' table (the detail layer, unchanged) → 'Held out of the headline' (unchanged) → 04 names chart plus the categories table folded underneath → (05 optional) → What this page does not know (not footed, silent channels, calls that name no driver, one window only).
- The tags ok/bad/dim on 'Can it be added?' and 'In the headline' become neutral text with a grey-2 outline. A 'no' here is not 'worse'.

**Add (from the redesign, with its data source)**

- HERO 'The headline figure' = rev.totals.accounted with its basis and the calls it is built from. Today this is the third tile. — *source:* /api/revenue totals.accounted, platforms[].basis
- Tile 'Figures that restate' = sum restated_rows over sum rows_seen. Today this is inside a sub-line. — *source:* /api/money/sources rows[].restated_rows, rows_seen
- Tile 'Channels answering': distinct rows[].platform against the channels the product collects. — *source:* /api/money/sources rows[].platform
- Absence tile 'A total of the N: deliberately not footed', using the endpoint's own caveats.restatements text, which is currently unrendered. — *source:* /api/money/sources caveats.restatements
- Chart 01 'Every call that returned money': ranked bars per call, ink = in the headline, grey = held out. — *source:* /api/money/sources rows[].amount + inHeadline()
- Chart 02 'How much of each call restates' (restated_rows / rows_seen per call). — *source:* /api/money/sources rows[]
- Chart 04 'What the money was called': the top-12 categories as bars with direction in the label, captioned with caveats.categories. The full 44-row table stays underneath, folded. — *source:* /api/money/sources categories[], caveats.categories
- OPTIONAL chart 05 'One window, several money figures, none added': trip value, the headline, payouts reported, components after the overlap rule, and statement cash, side by side. It costs 3–4 extra reads, and every bar must name its endpoint. — *source:* /api/finance/daily totals.fares; /api/revenue totals.accounted; /api/kpis reported_payouts; /api/finance/receipts; /api/settlement/cash-exposure total_statement_cash

**Keep**

- All three tables, including the per-row reason why a call is held out of the headline. The mockup has no reasons.
- The provider's own words (never renamed), the grain column and the can-it-be-added verdict.
- Headline membership read from /api/revenue platforms[].basis, not re-derived.

**Leave structurally untouched (restyle only)**

- The 'Held out of the headline' table with its per-row reasons. It is the audit trail the page exists for.

**Not adopted from the mockup**

- 03 'How many drivers each call names'. It duplicates the Drivers column and no decision rests on it.
- 'Channels answering 1 of 4 / Every call is Uber' as fixed text. On the mirror, yango_park_ledger and yango_driver_summary return money in the same 30-day window.
- The mockup's call list (10 calls, including uber_trips). The mirror returns 8 rows over 30 days, so everything is computed from the payload.

*Tests that pin this page:* test/rollup_money_atomic.test.mjs (provenance empty-state wording), test/routes_list.mjs

### Work

#### `demand` — effort M

*Today:* The page covers every booking channel: the heatmap total is 17,388 this month (Uber 15,870 + Bolt 747 + Hotel 691 + Yango 80, checked against /api/trips/heatmap per platform). Verdict: 'The busiest hour is 15:00, 9% of the day's work', with 774 bookings a day over 22 whole days and today excluded (splitLive/hourProfile). Hourly demand curve: an area chart of the per-day RATE, which names the hour still in progress. Daily volume: gapBars with telematics behind, uncollected days hatched, today drawn hollow, a click on a bar opens #day, a 'Busiest days' link list and an export row (daily totals / every trip CSV). Trips against weather and holidays: a note, 4–6 KPIs (the temperature-vs-volume r is guarded at n<3) and a 23-row table (Day link, Trips, Completed, Did not complete, Neither yet, Drivers, Km, Fares with priced-of-n, Max temp, Rain, Wind, Calendar). Busiest hours of the week: a heatmap whose cells open #slot, with a legend and a 'Busiest slots' link list. When a platform filter leaves no bookings the page shows an empty state (FMS is explained, with links). Ends with the srcline.

**Change**

- New section order: 00 At a glance → 01 Every hour of every weekday (the heatmap, promoted to hero chart) → 02 The shape of a day (the live rate curve redrawn as 24 columns ≤24px, peak labelled, the hour in progress hatched) → 03 Shape of a week (new) → 04 Weekend day vs weekday (new) → 05 Daily volume (live) → 06 Trips against weather and holidays (live, content unchanged) → † What this page does not know → srcline as colophon.
- 00 tiles. Hero: bookings a day (the live verdict figure), with the claim as its label. Then: busiest hour (rate, share and ×quietest), a weekend day, busiest weekday, and demand nobody served (ABSENT with its reason).
- Heatmap ramp moves from blue to the achromatic sequential tokens (#ACB0B7…#13171F), captioned 'grey is magnitude, not identity'.
- Daily volume encodings swap, with the captions in the same edit (SPEC §5). An uncollected day becomes an OUTLINE (grey-2, no fill) instead of a hatch. Today becomes a HATCH instead of a hollow bar.
- Weather table keeps all 11 columns, restyled with hairline rules. The Max-temp pills lose their ok/warn/bad fills, because a hot day is not 'worse' (L3). The Did-not-complete pill above 15% becomes a ▼ in the negative token with its sign.
- Prose about today and uncollected days moves out of the chart captions into the absence band. The captions keep only the rate basis.

**Add (from the redesign, with its data source)**

- 'Busiest weekday' tile and §'The shape of a week': 7 ranked bars of bookings PER OCCURRENCE of each weekday (heatmap row sum ÷ the number of that weekday's whole days in the daily series) — *source:* /api/trips/heatmap + /api/trips/daily (client-side, no new endpoint)
- 'A weekend day' tile and §'A weekend day is a different day': two small-multiple 24-column charts (Sun–Thu vs Fri–Sat), mean bookings an hour per day of that type, peak hour labelled, with today handled the way hourProfile handles it — *source:* /api/trips/heatmap + /api/trips/daily
- Peak-to-trough ratio in the busiest-hour tile (e.g. '8.8× the quietest hour'), taken from the rate rows — *source:* /api/trips/hourly via hourProfile
- Sparklines on the tiles, drawn from the daily series — *source:* /api/trips/daily
- Absence band. 'Demand nobody served': no feed reports a request that no car took, and the Did-not-complete column is the only unserved-demand signal we hold. 'Cells with no reading: N of 168', counted from the heatmap. 'Why an hour is busy': weather is held per DAY, not per hour, and there is no surge or event feed. — *source:* existing payloads + text

**Keep**

- The verdict arithmetic, unchanged: today excluded from the daily rate, the today-only fallback, the 'N of these days were never collected' claim. It becomes the hero tile's figure, unit and claim, with the same meta and sub text.
- The hourly curve plotted as a per-day RATE, including the rule that the hour still in progress is drawn but never named the busiest.
- Daily volume with bar click to #day, the 'Busiest days in this window' link list and the exportRow (daily totals CSV / every trip CSV).
- The whole weather panel: the coverage note, the KPIs (with the n<3 correlation refusal), the 11-column day table with #day links, the Calendar absent line and the correlation caveat.
- Heatmap cell click to #slot/<dow>/<h>, the 'Busiest slots' link list, the legend scale and the caveat that today's weekday row is one day short.
- The empty states for ?platform=fms and for a channel with no bookings, with their links to overview, map, sources and revenue.
- The srcline naming every channel.

**Leave structurally untouched (restyle only)**

- Heatmap cell click to #slot and the Busiest-slots addresses: this is the rota drill-down.
- Daily bar click to #day, the busiest-days links and the CSV export row.
- Day-table columns and their #day links.
- The splitLive/hourProfile/dubaiClock arithmetic. It was written to fix three separate production defects, and live_day.test.mjs asserts it.

**Not adopted from the mockup**

- The 'EVERY MARK HERE IS UBER' badges, and the absence cell claiming 1,790 bookings are held but in no cell. Both are false for live: /api/trips/heatmap counts every booking channel.
- §02 'shape of a day' as window SUMS, and the hero '1,197 bookings in the busiest hour'. Live plots a per-day rate because the sum gives every hour before now an extra day.
- Shape of a week as raw weekday sums. A 30-day window holds 5 of some weekdays and 4 of others, so it is adopted only per occurrence.
- The 'Bookings a day ▲ +58.4%' delta. The mockup never defines what it compares against; a delta goes in only if defined as the previous equal window of whole days.
- 'Why an hour is busy: None … no weather feed'. Live holds daily weather, so the reason must say daily, not hourly.
- Dropping the daily-volume chart and the weather/day table (the mockup has neither).

*Tests that pin this page:* test/live_day.test.mjs (demand verdict claim/figure/meta/sub; the 'Busiest slots: Tue 18:00' caption text), test/reachability.test.mjs (demand days open #day, heatmap cells open #slot; API level), test/audit_tools_detect.test.mjs (endpoints behind #demand), test/phone.test.mjs (a comment near l.382 relies on gapBars drawing today hollow), test/spacing.test.mjs + test/smoke_views.mjs (every route in routes_list.mjs)

#### `trips` — effort M

*Today:* Three KPI tiles: trips in window (17,388), on this page, carrying a fare (15,438 of the window). A Bookings panel with a debounced search (plate / driver / place), a What select (bookings / telematics / both) and an Outcome select. A 9-column table of 100 rows per page: When (tripTime, which opens the replay), Channel · fleet, Driver link, Vehicle link, From/To area with the full address as tooltip, Km, Outcome tag, Fare. Newer/Older paging with a row range. A warning for unpriced-but-charged cancellations, a derived-fare note, the server note, a trip-grain CSV link and the srcline. All channels.

**Change**

- Order: 00 At a glance → 01 the bookings table with search, filters and paging → 02 price-status bars → 03 daily columns → 04 cancel-rate line → 05 fare-settlement bars → † absence band → CSV link + srcline. The table sits directly under the tiles, ahead of the charts. This deliberately departs from SPEC's 'hero chart at 01', because operators come here to find a job (rule 3).
- Hero tile becomes 'Carrying a fare' with its share and the unpriced count. Beside it: bookings, completed %, cancelled, and ride time as ABSENT.
- Table restyle: hairline rules, a 3px channel row marker in the gutter (the Channel text stays), tabular-nums on Km and Fare. Outcome tags lose their green/red fills: text only, with a ▼ glyph on not-completed.

**Add (from the redesign, with its data source)**

- Tier and Payment columns in the table — *source:* /api/trips/list rows already carry product and payment_type, which are not rendered today
- A link on every row to the booking page #trip/<platform>/<external_id>. Today no #trips row can open #trip; only driver.js, driverday.js, vehicle.js and trip.js link there. — *source:* /api/trips/list row.platform + row.external_id
- 00 tiles: completed %, cancelled (split into rider / driver), drivers and cars, mean fare over priced bookings — *source:* /api/kpis (completion_pct, cancelled_trips, cancelled_by_rider, cancelled_by_driver, drivers, vehicles, avg_fare, priced_trips)
- §'Whether the booking carries a price': ranked bars for priced / cancelled never charged / completed fare not filed yet / fare recovered from earnings / charged but unpriced — *source:* /api/trips/list totals (priced, unpriced_cancelled, unpriced_completed, derived_fares, unpriced_but_charged)
- §'Every booking, a day at a time' columns (today hatched) and §'How much of a day gets cancelled' line — *source:* /api/trips/daily (trips, cancelled)
- §'How the fare settles': ranked bars of bookings (and AED) per payment type — *source:* /api/mix?by=payment (n, revenue, priced_n)
- Absence tile 'How long a ride took': duration_s is null on every row, and request→end stamps are not ride time — *source:* /api/trips/list rows (duration_s)

**Keep**

- Search box, the What and Outcome selects, Newer/Older paging and the 'x–y of N' text.
- All 9 columns and their order; the tripTime replay link; the driver and vehicle links.
- The window total kept separate from the page count; the unpriced-but-charged warning; the derived-fare note; the CSV download at trip grain.

**Leave structurally untouched (restyle only)**

- Search input, both selects, paging buttons and range text, the 100-row page size.
- Column set and order; the tripTime replay link; the driver and vehicle links; the CSV link.

**Not adopted from the mockup**

- 'UBER ONLY' and the absence cell 'Every other channel: 1,790'. The list covers 4 channels (this month: Bolt 747, Hotel 691, Yango 80 beside Uber).
- 'The newest bookings: 16 rows' in place of the searchable, paged 100-row table.

*Tests that pin this page:* test/trips_list.test.mjs (renders #trips?days=7; rows drawn = api.shown; the window-total tile vs the page tile; channel shown on the row), test/audit_tools_detect.test.mjs, test/spacing.test.mjs + test/smoke_views.mjs

#### `supply` — effort M

*Today:* Verdict: 70% of the hours drivers are online, nobody is in the car. 0.77 jobs per online hour (21,998 h online, 6,565 h on a job), the worst and best slot, and a recommendation worth '+22 jobs'. Heatmap 'Which hours sell the drivers you are paying for': jobs per online hour per weekday-hour, per occurrence, with a pink 'sold nothing' state, a hatched 'no availability collected' state and a 5-bin legend. 'Where the waiting happens': a sortable table of 210 areas (Area, Waits, Median, Mean, Hours waited ↓), folded at 12 with 'Show the other 198'. Links to Demand and Rota gaps, then the srcline. Availability is Uber's driver timeline only (supply_routes.js:145-151).

**Change**

- Order: 00 → 01 rate heatmap (hero, same measure) → 02 typical week stacked → 03 what an online hour buys → 04 Where the waiting happens (table) → † absence → links + srcline.
- Heatmap ramp moves from blue to achromatic sequential.
- 'No availability collected' becomes an OUTLINE instead of a hatch (§5: hatch is for projections).
- 'Sold nothing' is a measured zero, not an absence. It moves from a pink fill (L3 forbids a semantic area fill) to the lowest sequential step plus a small glyph in the negative token.
- Table restyled with hairline rules. The (unrecorded) row stays in the table and is also named in the absence band.

**Add (from the redesign, with its data source)**

- 00 tiles: idle hours, online hours (with on-job hours), jobs per online hour, waiting between jobs (Σ waiting_h, Σ waits) — *source:* /api/supply/balance totals + /api/supply/areas
- §'A typical week, hour by hour': 24 stacked columns per occurrence, rider in the car vs online and waiting, in Uber's own ramp (engaged → available) — *source:* /api/supply/balance cells (on_job_h, idle_h, occurrences) summed by hour
- §'What an online hour actually buys': a line of jobs per 100 online hours by hour of day, against the window mean — *source:* /api/supply/balance cells
- Absence band. 'Availability off Uber: 1 of 4 channels' (true: driver_timeline_event holds platform 'uber' only). 'Why a car sat idle': no feed says offered or refused. 'Waits in an unnamed area': the (unrecorded) row, 1,335.7 h. 'What an idle hour cost': not measurable. — *source:* existing payloads + text

**Keep**

- The verdict and its recommendation.
- The jobs-per-online-hour heatmap, per occurrence. It is the operational lens: 'two slots with ten jobs are opposite problems'.
- The area table: all 5 columns, the sort and the fold.
- The per-occurrence basis caption, and the refusal on non-Uber channel chips (supply_chip_denominator).

**Leave structurally untouched (restyle only)**

- Area table: columns, sort (hours waited desc), the 12-row fold and 'Show the other N areas'.
- The heatmap's measure (jobs per online hour, per occurrence) and its legend bins.

**Not adopted from the mockup**

- Replacing the rate heatmap with an idle-hours heatmap. That loses the question the page answers, and idle-by-hour is carried by the new §02 instead.
- §03 ranked bars 'where the waiting piles up'. They answer the same question as the 210-row table, which carries more (median, mean, waits).
- The long-prose KPI tile about Optimise's per-car idle. Over the prose budget; replaced by a one-line cross-link to #optimise.

*Tests that pin this page:* test/supply_chip_denominator.test.mjs (renders #supply?platform=bolt; reads supply.js for declared locals), test/supply_span_clock.test.mjs (reads supply.js), test/audit_tools_detect.test.mjs, test/spacing.test.mjs + test/smoke_views.mjs

#### `platforms/share` — effort M

*Today:* Tab bar: Share / Product tiers / Acceptance funnel. Verdict: 'single-channel fleet: Uber is 91% of the work', with a recommendation. A dominance 100% bar that IS the channel filter: its segments and keyed legend are buttons, each showing bookings, share and 'AED reported'. The FMS key reads '0 · no booking in this window'. 'Trips by fleet' donut (Ecosine 12,146 / Egari 5,242, with bars). 'Coverage & history depth' table (Platform link, Fleet, Bookings all time, Rows stored, Earliest, Latest) with an all-time caveat. Srcline.

**Change**

- 00 tiles: bookings across all channels (hero), Uber's share, best and worst channel completion against the fleet (▲/▼ with sign), work turned down.
- Dominance bar recoloured to the channel tokens: Uber #2362D3, Bolt #0398BA, Hotel #A38902, Yango #B4358A. Today Bolt is green and Yango red, which L3/L5.12 forbid. Add 2px gaps and direct labels.
- 'Trips by fleet' donut becomes a 2-segment 100% bar in ink and grey. Fleets are not channels and get no hue.
- Fix the verdict sub. 'FMS telematics is configured and has delivered nothing in this window' is not the true reason: `dead` is keyed on window_bookings = 0, and FMS delivered journeys (21,354 over the last 30 days per /api/kpis), not bookings. Reword to 'files journeys, not bookings'.
- Order: 00 → 01 dominance bar (hero and control) → 02 completion by channel → 03 mean km by channel → 04 Trips by fleet → 05 Coverage & history depth → † absence.

**Add (from the redesign, with its data source)**

- Completion rate per channel against the fleet, in ▲/▼ points — *source:* /api/kpis?platform=<p> completion_pct: one call per channel, no new endpoint
- Mean km per booking per channel — *source:* /api/mix?by=platform avg_km (already fetched as byPlat)
- 'Work turned down' tile (declines) — *source:* /api/kpis declined_offers
- Absence band. Feeds refusing to collect (from the credential banner state). Car tier off Uber: the hotel files a booking type, not a car tier. Offers nobody files: only Bolt's driver report carries offered/accepted. The tracker as a channel: FMS journeys in the window, zero bookings. — *source:* banner/sources data + /api/kpis telematics_journeys + text

**Keep**

- The tab bar and its URLs.
- The dominance bar as the dashboard's channel filter: buttons, keyboard-reachable, 'AED reported' per channel.
- The coverage table (6 columns, 8 rows) and its all-time caveat note.
- The recommendation.

**Leave structurally untouched (restyle only)**

- The dominance bar's click-to-filter behaviour and keyboard reachability.
- Coverage table columns and the platform links.
- The tab URLs #platforms, #platforms/tiers, #platforms/funnel.

**Not adopted from the mockup**

- §01 ranked bars 'where the work came from' as a second drawing of the split. The dominance bar is the control, and platform_share_once.test asserts the split is drawn once.
- §03 'Everything each channel has ever filed' bars. The coverage table already carries it, plus rows stored, earliest and latest, per fleet.
- §04/§05 tier charts on the Share tab. They belong to #platforms/tiers (see there).

*Tests that pin this page:* test/platform_share_once.test.mjs (one dominance bar; segments and keys are buttons; caption; a click narrows the dashboard), test/audit_tools_detect.test.mjs, test/spacing.test.mjs + test/smoke_views.mjs

#### `platforms/tiers` — effort S

*Today:* KPIs: premium share 15.5%, 96 vehicles carrying Uber work, 68 behind the best car of their own model (with a 'who exactly?' link), largest shortfall 28.7% (L19262 · BYD Han EV). 'Tier by time of day' table (daypart × 7 tiers + trips + avg trip) with a premium-concentration line. 'Gap to the best car of the same model' hbars (12 cars). 'Every vehicle carrying Uber work' sortable table (96 rows, 13 columns). A note that the absent revenue column is deliberate.

**Change**

- KPIs become 00 tiles, with premium share as the hero.
- The tier-count bars become 01. The daypart table stays as detail, because it answers 'when', not 'how many'.
- Gap hbars ≤24px, directly labelled 'plate · model', in ink (a shortfall against a peer is not a channel colour). The vehicle table gets hairline rules and tabular-nums.

**Add (from the redesign, with its data source)**

- §'Which car the rider asked for': ranked bars of Uber bookings per tier (Electric 7,453, UberX 5,568, …) — *source:* /api/mix?by=product n (or /api/tiers/mix summed)
- Mean km per tier, as a small column beside those bars (optional) — *source:* /api/mix?by=product avg_km

**Keep**

- All four KPIs and the 'who exactly?' link.
- The daypart table, the gap hbars, and the 96-row vehicle table with plate links and sort.
- The deliberate no-revenue note.

**Leave structurally untouched (restyle only)**

- Vehicle table: 13 columns, sort, plate links.
- The daypart table's rows and columns.

**Not adopted from the mockup**

- §05 'What that tier earns a trip' (AED per trip by tier). Live deliberately carries no per-tier revenue: Uber fares arrive a week at a time from a separate payments report, so a per-tier mean covers some weeks of some tiers, and the page already says so. /api/mix?by=product does return revenue_per_trip over priced_n, so reviving it with a 'priced n of N' basis on every bar is an operator decision, not a default.

*Tests that pin this page:* test/spacing.test.mjs + test/smoke_views.mjs (routes_list includes platforms/tiers)

#### `platforms/funnel` — effort S

*Today:* KPIs: jobs offered 7, accepted 100%, completed 100% of accepted, lost before it started 0, platform commission AED 67. 'Jobs offered and completed, per driver' table (15 columns, 7 records this month; Driver, Channel, Period, Offered, Accepted, Accept %, Completed, Complete %, They cancelled, Rider cancelled, Hours, Gross, Cash share, Commission, State). Explanations for the blank rates, and the per-period-overlap note.

**Change**

- KPIs become 00 tiles; the new turned-down bars become 01; the table stays as detail with hairline rules.
- Rate cells keep their measured or blank-with-reason behaviour, with no semantic fills on rates.

**Add (from the redesign, with its data source)**

- §'What any channel says about work turned down': ranked bars for cancelled by the rider / declined the offer / dropped after accepting / nobody said who, each labelled with which channel files it (only Bolt files offers) — *source:* /api/kpis cancelled_by_rider, declined_offers, cancelled_by_driver, cancelled_unsaid

**Keep**

- The 5 KPIs.
- The 15-column table and its sort.
- The blank-rate reasons (63.8 hours logged with no job sent is 'the finding') and the overlap note.

**Leave structurally untouched (restyle only)**

- The 15-column per-driver table and its sort.
- The blank-rate reason texts.

**Not adopted from the mockup**

- The mockup's '138 declines' is a 30-day figure. Compute it from the current window.

*Tests that pin this page:* test/blank_rate_reasons.test.mjs (#platforms/funnel blank-rate reasons), test/spacing.test.mjs + test/smoke_views.mjs

#### `corridors` — effort M

*Today:* Verdict: Al Garhoud is the busiest pickup area, 12% of addressed jobs, 1,010 corridors seen 3+ times. 5 KPIs: distinct pickup areas, routes seen 3+ times, busiest area, top 5 share, pickups with no area (2,412, 14.8%). 'Where jobs start': hbars of 14 named areas; the unrecorded bucket is stated in the caption, not drawn (AUDIT #47). 'Morning areas and evening areas': diverging bars with morning/evening counts, today in neither wave, a ≥3-trip floor. 'Common routes': sortable table of 119 rows (From, To, Trips, Avg km, Request→drop with n, Avg fare with * for a priced minority, Priced n of N %, Channels), folded at 12. Area-parsing note. All booking channels; the Channels column shows Hotel and Uber together.

**Change**

- Order: 00 → 01 busiest routes (bars) → 02 where the work starts (live hbars) → 03 km×fare scatter → 04 morning vs evening (live diverging) → 05 never leaves the area → 06 Common routes table (detail layer) → † absence.
- Diverging bars move from orange to ink/grey: morning vs evening is neither a channel nor good/bad. Origin hbars move from blue to ink. Bars ≤24px with direct labels.

**Add (from the redesign, with its data source)**

- Hero §'The busiest routes between two areas': top 12 ranked bars, from≠to, named areas only — *source:* /api/geo/corridors corridors[]
- §'Work that never leaves the area' (from_area = to_area) ranked bars, plus the tile 'Never leaves the area: N trips, x% of trips on the routes sent' — *source:* /api/geo/corridors corridors[]. Basis: only corridors seen 3+ times that the server sent (119 of 1,010), stated in the caption.
- §'How far a route runs, and what it earns': scatter of avg_km × avg_fare, one dot per priced route, starred routes marked — *source:* /api/geo/corridors corridors[] (avg_km, avg_fare, priced)
- Absence band: routes not drawn (corridors_all − shown), pickups with no area, ride minutes reported (duration_reported 0 of duration_measured 5,324), whether a route got busier (one window only) — *source:* /api/geo/corridors totals, duration_measured, duration_reported

**Keep**

- The verdict and the 5 KPIs with their denominators.
- The origin hbars excluding (unrecorded), with the caption that names the dropped bucket (AUDIT #47).
- The morning/evening diverging chart, its counts and the today-in-neither-half rule.
- The routes table: 8 columns, sort, fold, the starred-fare rule, the request→drop basis and the 'Sorting re-orders the 119 rows' note.

**Leave structurally untouched (restyle only)**

- The Common routes table: columns, sort, fold, footnotes.
- The morning/evening arithmetic (today in neither half) and the origins denominators.

**Not adopted from the mockup**

- The 'UBER ONLY' badge. The payload covers all booking channels (the Channels column reads 'Hotel, Uber').
- Drawing '(unrecorded)' as the top bar of 'Where the work starts' and as the endpoint of ranked routes. AUDIT #47: an unnamed bucket is not a place; live states it beside the chart instead.
- Splitting morning and evening into two separate ranked charts (§04/§05). That loses the per-area balance and the side-by-side counts live shows.

*Tests that pin this page:* test/corridor_denominators.test.mjs (unrecorded bucket; the bar caption names the dropped bucket), test/corridor_time.test.mjs, test/live_day.test.mjs (#corridors evening window / today in neither half), test/chart_fit.test.mjs (hbars label fit in charts.js), test/spacing.test.mjs + test/smoke_views.mjs

#### `causes` — effort M

*Today:* Range hidden: the page reads the whole record over all channels. Verdict: the largest real move is +1,029%; N real breaks, with the artefacts named. 4 KPIs: months observed 24 of 24, trips in record 380,251, months that name a driver, big jumps 8. 'Trips per month' bars (click a month; hatched = no data). 'Big jumps between months': 13 break cards across Uber, Bolt, Yango and FMS, each with drivers before→after, per-driver change, why, what this implies, and candidate events with confidence ('candidates, not proof'). 'Coverage gaps'. 'What was on in Dubai': 31-row events table (8 columns; LLM-classified news flagged). A partial-month warning. 'Fewer drivers, or less work?': first 6 vs last 6 months table and note. Srcline. 8,484px tall at 1440.

**Change**

- 00 tiles: biggest real break (hero, with ▲/▼ and sign), breaks found, share explained by headcount, bookings per driver.
- Trend chart: months with no data become an OUTLINE (not a hatch); partial months become a HATCH (§5); break months get direct labels.
- Order: 00 → 01 trips per month → 02 decomposition bars → 03 drivers line | 04 per-driver line → 05 break cards (detail) → 06 events table → 07 fewer drivers / less work → † absence.
- FMS break cards say 'journeys', not 'trips' (live prints '6,138 → 11,221 trips on FMS telematics').
- Break cards fold after the first 4 behind 'Show the other N breaks' (the existing foldRows pattern). Nothing is removed; the 8,484px page gets shorter.

**Add (from the redesign, with its data source)**

- §'What moved, at each break': diverging bars splitting each break into a headcount term and a per-driver term that sum exactly to the change (ΔT = ΔD·p₀ + D₁·Δp). FMS breaks, with null drivers, are drawn as an OUTLINE labelled 'unattributable'. — *source:* /api/breaks (value_from/to, drivers_from/to)
- Small multiples 'How many drivers' and 'What each one did' (bookings per driver) by month — *source:* /api/trend/monthly months[] (drivers, attributed_trips, drivers_known)
- Tiles: 'the headcount explains x%' and a sparkline on the biggest-break tile — *source:* derived from /api/breaks + /api/trend/monthly

**Keep**

- Whole-record, all-channel scope, and NO_RANGE.
- Every break card, including candidate events with confidence and the 'candidates, not proof' line.
- The events table, the coverage gaps and the fewer-drivers table.
- The partial-month artefact handling, and the click on a month.

**Leave structurally untouched (restyle only)**

- Break-card content and ranking.
- The events table columns.
- The whole-record scope (range control hidden).

**Not adopted from the mockup**

- Uber-only scope ('18 months of Uber bookings, 4 breaks, all on Uber'; 'Breaks off Uber: None'). Live detects breaks per channel over 24 months; narrowing it would drop 9 of the 13 cards.
- 'What caused a break: Not measured' as a REPLACEMENT for candidate events. Keep the caveat and keep the candidates with their confidence.

*Tests that pin this page:* test/trend_gaps.test.mjs (#causes gaps / no_data), test/routes.test.mjs (reads causes.js), test/break_month_grain.test.mjs (API), test/spacing.test.mjs + test/smoke_views.mjs

#### `forecast` — effort M

*Today:* Verdict: Oct 26 is between 16,000 and 31,900 bookings depending on the method; roster to the lower figure. KPIs: YoY expected with its range, Aug vs Aug, active vehicles then and now, per vehicle, fit r². 'Sep 26 so far, against what was forecast': 6 KPIs, run-rate over whole days. 'Every month against the same month a year earlier': 11-column table plus a refused-pairs table. 'Dubai's visitors, and what they explain': r² KPIs, a scatter, a 22-row table and reconciliation notes. 'Bookings by month, observed and forecast': bars (forecast hatched, excluded months drawn) plus a 22-row table. 'Month by month, both methods': 12 rows, 9 columns. 'Which method, and how wrong each one has been': backtest. 'Oct 26, day by day': bars plus a weekday table. The LLM calendar, flagged as not a measurement, naming the model. Method note. 10,133px.

**Change**

- 00 tiles. Hero: the RANGE for next month (low method to high method), not a point. Then: the month so far against forecast (▲/▼), fit r², months fitted of observed.
- Order: 00 → 01 range chart → 02 month so far vs forecast → 03 bookings by month (fitted/dropped encoding) → 04 both-methods table → 05 backtest → 06 YoY table → 07 visitors → 08 day by day + weekday bars and table → 09 LLM calendar → † absence (a day's own uncertainty, months dropped, beyond the fitted horizon, money not forecast).
- Every October daily bar is hatched: each one is a projection.

**Add (from the redesign, with its data source)**

- Hero §'The year ahead, and how wide the guess gets': observed months plus BOTH methods' monthly ranges as hatched bands on one axis — *source:* /api/forecast (both methods' lo/hi per month, already in the both-methods table)
- Fitted / dropped / part-month encoding on the observed bars ('what the fit could see') — *source:* /api/forecast fit start + excluded months
- §'What a weekday is worth': ranked bars beside the weekday table — *source:* /api/forecast weekday shares / daily

**Keep**

- Both methods and the range framing ('refuses to tell which to believe').
- Month-in-progress scoring; the YoY table and its refusals; the visitors regressor with r²; the both-methods table; the backtest; the weekday table.
- The LLM calendar with its disclaimer and model name; the method note.

**Leave structurally untouched (restyle only)**

- Every table's columns and the YoY refusal logic.
- The LLM calendar disclaimer, the model name, and 'the record wins' where they disagree.

**Not adopted from the mockup**

- The single-method hero '14,400' (straight line only). Live shows both methods and says they disagree by more than their ranges; one point hides that.
- Uber-only framing ('6 months of Uber bookings'). /api/forecast is built on every booking channel.
- Dropping YoY, visitors, the backtest and the calendar (the mockup has none of them).

*Tests that pin this page:* test/forecast_page.test.mjs (YoY panel, refusals, r² leads, visitors 'not published', most-accurate method, LLM calendar text), test/forecast.test.mjs, test/forecast_yoy.test.mjs, test/spacing.test.mjs + test/smoke_views.mjs

#### `optimise` — effort M

*Today:* Verdict: 70% of the hours this fleet pays for are idle; 37 min between one job and the next; recommendation of +1,024 trips. 6 KPIs: idle between jobs 4,157 h over 5,019 handovers, of that at a charger 933 h / 22.4%, median wait, best hour, worst with real supply, gap to itself. 'Best hours to be online': a jobs-per-online-hour heatmap whose cells open #slot. 'Where the waiting happens': a charger warning and a 20-row table (When, Where the car was left, Idle hours, Handovers, Median wait). 'Jobs that started where no car was waiting': a warning and a 15-row table (When, Area, Bookings, Cars already there, Short by each time, Average fare), with '580 of 9,232 placeable bookings (6.3%)'. Scope caption, srcline.

**Change**

- 00 tiles: idle between jobs (hero), median wait, idle at a charging site ('waiting and charging cannot be told apart'), bookings where no car waited (6.3%), best and worst hour.
- Order: 00 → 01 rate heatmap (hero) → 02 waiting table → 03 pile-up / run-out bars → 04 drop-off heatmap → 05 no-car table → 06 surplus table (new) → 07 scatter → † absence.
- Heatmap ramp becomes achromatic. The charger note becomes a caption rather than a warn box: it is a basis, not a defect.

**Add (from the redesign, with its data source)**

- §'Where cars arrive and no job starts': a 20-row table (When, Area, Pick-ups, Arrivals, Idle per occurrence, Avg fare) — *source:* /api/optimise surplus[]: sent today and never rendered
- §'When a car comes free': drop-offs by weekday × hour heatmap — *source:* /api/optimise slots[] (all 2,516 place-hours, arrivals)
- §'Where cars pile up, and run out': diverging bars by area (Σ pick-ups − Σ arrivals) — *source:* /api/optimise slots[]
- §'Is the waiting where the work is': scatter of handovers × median wait over the 40 worst slots, captioned 'worst 40 of 1,010' — *source:* /api/optimise waits[] + totals.waits
- Absence band: why a car waited (not measured), charging (a name match, not a plug event), places are names not shapes, slots not sent (1,010 − 40) — *source:* existing payload + text

**Keep**

- Verdict, recommendation and the 6 KPIs.
- The rate heatmap with its click to #slot.
- Both tables and both warnings.

**Leave structurally untouched (restyle only)**

- Both tables: columns, worst-first order, row counts.
- Heatmap click to #slot.

**Not adopted from the mockup**

- Ranked bars 'the twelve slots that hold the most waiting'. They answer the same question as the 20-row table, which also carries handovers and median wait.
- 'Which places hold the waiting' area totals. They are built from only the 40 worst of 1,010 place-hours, which would present a sample as the whole.

*Tests that pin this page:* test/optimise.test.mjs (/api/optimise shape), test/spacing.test.mjs + test/smoke_views.mjs

#### `capacity` — effort M

*Today:* Verdict: 83 hours of the week are short of people; the recommendation points at the slot pages. KPIs: bookings expected in Oct 26 with range, hours needing more people, hours with people to spare 0, busiest single hour. 'Add people here': a 20-row table (Hour → #slot, Expected each time, Drivers now, Most ever seen, Needed, Times next month, Gap) folded at 10, with a largest-gap note. 'Cover to spare here': empty, with the arithmetic that says why. 'Every hour of the week': a drivers-needed heatmap whose cells open #slot. 'Every hour, with the arithmetic': 168 rows folded at 14. A projection-above-rate warning, a throughput-is-a-measurement note and links. Srcline: all channels over 84 days (Uber 37,597 · Hotel 2,260 · Bolt 1,762 · Yango 282).

**Change**

- 00 tiles: hours short of drivers (hero, 'of 168'), worst hour, smallest shortfall, bookings expected (with range), and the rota as ABSENT.
- Heatmap: every cell HATCHED, because every cell is a projection (§5). Ramp achromatic. The click stays.
- Order: 00 → 01 heatmap → 02 has run vs still to find → 03 Add people here → 04 weekday columns → 05 every hour table → cover to spare → † absence.

**Add (from the redesign, with its data source)**

- §'Drivers the hour has run, and the drivers still to find': 24 columns, observed drivers per occurrence solid and projected extra hatched — *source:* /api/capacity cells[] (drivers_per_occurrence and drivers needed) summed by hour
- §'Which weekday is shortest': 7 hatched columns (Σ gap by weekday) — *source:* /api/capacity cells[]
- Absence band. The rota: no roster in any feed. The target's own range: what the 12,000 low end does to the grid. What a driver can do: throughput is a measurement. — *source:* /api/capacity (target_low / target_high, caveat) + text

**Keep**

- All tables, the folding and the #slot links.
- The verdict arithmetic, which capacity_headline asserts.
- The cover-to-spare explanation and both notes.

**Leave structurally untouched (restyle only)**

- The 'Add people here' and 'Every hour' tables: columns, gap order, #slot links, fold.
- The verdict wording, which capacity_headline.test asserts.

**Not adopted from the mockup**

- Uber-only scope ('34,008 Uber bookings; Hotel, Bolt and Yango are not in the need') and the 'Work off Uber: None' absence cell. Both are false: live projects all booking channels.
- 'Twelve hours worst short' ranked bars. Same question as the Add-people table, which also carries expected, drivers now, needed and times next month.

*Tests that pin this page:* test/capacity_headline.test.mjs (renders renderCapacity; the claim starts with 'N hours'; figure = sum of per-hour gaps; sub wording), test/capacity_weighting.test.mjs (API), test/window_honesty.test.mjs (reads capacity.js), test/spacing.test.mjs + test/smoke_views.mjs

#### `day` — effort S

*Today:* Previous/next day navigation. KPIs: bookings with the fortnight-median delta, completed, money in, imported statement, fares and more. 'Through the day': hourly bars whose bars open #slot. 'Against the fortnight around it': bars whose bars open #day. 'Which channel' donut. 'How the fares settled' hbars. 'Uber product tier' donut. 'Harsh-driving events' hbars. 'Where the work ran': hbars of 8 corridors. 'Seat occupied, no booking found': 60 of 108 intervals, with verdicts. 'Harsh driving, by vehicle and driver': 40 rows. 'Who drove': 108 rows. 'Which cars moved': 95 rows. 'Weather, and what was collected': a per-source verdict table. Srcline.

**Change**

- Restyle through the shared foundation only.
- 'Which channel' donut becomes a 100% bar in channel tokens with direct labels. 'Uber product tier' donut becomes ranked bars.
- hbars ≤24px. Tables get hairline rules and a 3px channel row marker where a row is one channel.
- KPIs become the 00 tile row, with bookings (and its fortnight delta) as the hero.

**Add (from the redesign, with its data source)**

- 00 / † bands built from what the page already has: KPIs as tiles, and the per-source 'what was collected' verdicts feeding the absence band — *source:* /api/day

**Keep**

- Every panel and table.
- Previous/next navigation and every click-through (hour to #slot, day to #day, driver and vehicle links).

**Leave structurally untouched (restyle only)**

- The four operational tables (seat-occupied verdicts, harsh driving, who drove, which cars moved) and their links.
- Hour bar to #slot, fortnight bar to #day, previous/next.

**Not adopted from the mockup**

- n/a: no mockup

*Tests that pin this page:* test/day_routes.test.mjs, test/chart_geometry.test.mjs (reads day.js), test/person_vs_account_counts.test.mjs (reads day.js), test/unauthorized_attribution_page.test.mjs (day.js seat-occupied panel), test/spacing.test.mjs + test/smoke_views.mjs (day/2026-08-14, day/not-a-date)

#### `slot` — effort M

*Today:* 7 KPIs: trips in slot 314 over 4 of 4 Tuesdays, typical 78.5, covered 100%, 84 people / 83 vehicles, average trip 12.7 km, fares AED 15,129 over 273 priced, AED 55.42 per priced trip. A fare-coverage note. 'Who covers this hour': a sortable 40-row table (Driver link, Trips, Tuesdays worked, Platforms, Completion, Fares) with a sort note and a 40-of-84 line. 'Every Tuesday in the window': bars whose bars open #day, with the spread. 'Which channel brings this hour': donut plus a table (Platform, Trips, Fares). 'Where the work starts': hbars of 12 including (no address). '15:00 across the week': hbars of RAW weekday counts and the line 'Tuesday runs 63% above the other weekdays'. 'How this hour settles': donut plus a cash line linking to where the cash sits. 'How trips in this hour end': an outcome table.

**Change**

- '15:00 across the week' switches from raw weekday counts to PER OCCURRENCE (peers[].trips ÷ peers[].days, both in the payload). It currently compares 314 bookings over 4 Tuesdays against 139–245 over 3 of each other weekday. 'Tuesday runs 63% above' is the calendar, not the fleet; per occurrence it is about 22% (78.5 against a mean of about 64.1).
- The channel donut becomes ranked bars in channel tokens, with fares and priced counts. The settlement donut becomes ranked bars on a neutral ramp, with AED. The outcome table becomes two 100% bars (completed vs not; priced vs not), with the unpriced part as an OUTLINE.
- 'Where the work starts': (no address) becomes an OUTLINE row with its count instead of a filled dark bar.
- Order: 00 → 01 Who covers this hour (table as hero; operational) → 02 every Tuesday → 03 across the week → 04 channel → 05 settles → 06 where it starts → 07 how it ends / priced → † absence.

**Add (from the redesign, with its data source)**

- A concentration line under the drivers table: the busiest person holds N of the slot's trips (x%) — *source:* /api/slot drivers[] + headline.trips
- Fares per channel with 'priced n of trips', and AED per settlement class — *source:* /api/slot platforms[].priced_n, settlement[].revenue (in the payload; the donut shows counts only)
- Absence band: the fare on unpriced bookings (trips − priced_n), what this hour was paid (payouts are per day), where the no-address bookings started, online time in this hour (availability is not per hour here) — *source:* /api/slot + text

**Keep**

- The KPIs and the fare-coverage note.
- The 'Who covers this hour' table: driver links, Tuesdays worked, Platforms, Completion, Fares, and the sort.
- The Tuesday bars that open #day, the channel figures, the corridors, the cash link, the outcome figures.

**Leave structurally untouched (restyle only)**

- The drivers table. It is the rota answer: driver links, days worked, platforms, completion, fares, sort.
- Tuesday bars that open #day.

**Not adopted from the mockup**

- Replacing the drivers table with two columns of name bars (trips · days). That drops Platforms, Completion and Fares and the table's sort.

**Review corrections (adopted — they override the lines above)**

- *Correction adopted:* instead of “'The outcome table becomes two 100% bars (completed vs not; priced vs not)'”: Draw three segments with '(not reported)' as an OUTLINE, and keep the table as the detail layer. (/api/slot outcome has three buckets: completed, not_completed and '(not reported)' (segment_routes.js:449). 'Completed vs not' folds the unreported trips into not-completed, which breaks rule 4, and it drops the Trips and Share table, which breaks rule 1.)

*Tests that pin this page:* test/person_vs_account_counts.test.mjs (reads slot.js: people vs accounts), test/reachability.test.mjs (API: every cell opens), test/spacing.test.mjs + test/smoke_views.mjs (slot/2/19, slot/0/3, slot/9/99)

#### `trip` — effort L

*Today:* Header: pickup → drop-off, channel · fleet · day link · driver · plate. 5 KPIs: status, distance, time (requested→ended, labelled as such), product, fare. A warning when the row is a telematics journey. 'What this trip earned': a 9-row table separating booking-level from day-level money, with 'what it measures' per row and the statement surface named. 'The rest of that day': every booking the driver took that day, all channels, this one marked, rows open #trip. 'What the trackers saw': a fixes table (At, State, Speed, Ignition, Position, Feed) with seat absent. 'Occupancy around this booking' when segments exist. 'Who held <plate> that day': a custody table. 'What the provider actually sent': raw, redacted. Ingestion line with the vehicle's and driver's trips links. Srcline.

**Change**

- 00 tiles: fare (hero, with product and payment route), driver earnings (service fee, commission %), distance, request→drop-off, rider in the car (seat sensor when present, otherwise ABSENT with the reason).
- Order: 00 → header facts line → 01 timeline + speed (hero) → 02 occupancy segments → 03 money table → 04 the rest of that day (plus a small fares strip with this trip marked) → 05 fixes table → 06 custody → † absence → raw payload + ingestion line.
- The status tile's ▲ stays only in the positive token with its sign; otherwise it is ink.

**Add (from the redesign, with its data source)**

- Hero §'The booking, and the feeds that watched it': one time axis carrying the booking span (requested→ended), the driver-status span (Uber ONTRIP→ONLINE rows), the seat-sensor span (segments), and a speed trace from the fixes that GAPS across a hole rather than bridging it — *source:* /api/trip trip + telemetry[] + segments[]
- Absence cell 'Why the fare and the earnings do not meet', with the residual (fare + service fee − earnings) — *source:* /api/trip trip_money
- §'Two documents, not one figure': the day's fares summed against the day's payout — *source:* /api/trip same_day[] fares + trip_money day rows
- Absence band: where the booking went (coordinates null, address only), how long the ride took (no duration_s; request→end includes the approach), how many rode (no seat count) — *source:* /api/trip + text

**Keep**

- The money table: all rows, the per-row 'what it measures', and the statement-surface caption.
- The same-day table (all channels, rows open #trip), the fixes table, the occupancy panel, the custody table.
- The raw provider payload (redacted), the ingestion line and its links.

**Leave structurally untouched (restyle only)**

- The money table rows and captions (trip_own_money asserts the booking vs day split).
- The raw-payload redaction.
- Same-day rows opening #trip.

**Not adopted from the mockup**

- §03 'Where this booking's money went' as 3 bars replacing the 9-row table. It drops 'what it measures', cash collected, the day rows and the statement surface.
- §04 'The six bookings this car ran' (per CAR) replacing the per-DRIVER, all-channel same-day table. Live carries more (channel, vehicle, km, product, status) and links every row.

**Review corrections (adopted — they override the lines above)**

- *Data source corrected:* trip hero speed trace: /api/trip telemetry does carry source (trip_routes.js:117). Draw it per source, or FMS and CABMAN readings interleave into a zigzag.

*Tests that pin this page:* test/trip_own_money.test.mjs (#trip money block), test/trip_routes.test.mjs, test/trip_raw_redaction.test.mjs (reads trip.js raw panel), test/nav_sections.test.mjs (#trip section mapping), test/spacing.test.mjs + test/smoke_views.mjs

### People — drivers

#### `#drivers` — effort M

*Today:* Verdict card: '146 drivers cannot legally work — the licence has expired', with 114 drove / 170 did not / 63 never have, and the recommendation to sort by Licence or open Compliance. Search box and live count line (it adds same-person pending pairs when there are any). Busiest-six photo cards. All drivers table: 19 sortable columns (Driver with rank, In this window, Standing, Rating, Barred [hidden when nobody is barred], Fleet, Platforms, Usual vehicle, Trips (default sort), Trips ever, Completed, Days, Km, Money ·1/7, Paid ·23d, Fares ·priced, Completion [coloured at 95/85], First trip, Last trip ·ago, Licence pill). 12 rows show until 'Show the other 335 drivers' is clicked, and a row click opens #driver. At 1440px the table scrolls sideways with 7 columns off-screen. Trips vs distance scatter (the 80 busiest; a click opens the driver). Cross-platform activity (the 15 busiest of the 70 multi-channel people, 10 sortable columns). Platform performance records (25 of 2,425 rows; the hours-online column is hidden with a reason). Provenance line.

**Change**

- The verdict card becomes '00 At a glance' with 5 tiles: Licence expired 146 (the hero, carrying the page's one highlight), On the books 347, Drove 114, Did not drive 170, Never have 63. The recommendation sentence is printed verbatim under the band. The hero follows the driversVerdict branch.
- The busiest six become §01: six columns, each with a 70px photo (the avatar fallback is kept), the full name wrapping with no ellipsis (fixes the AUDIT clipping at 133px), channel swatch chips, the plate and the trips figure
- §02 table keeps all 19 columns, restyled with hairline rules and no tinted or zebra rows. To fit 1440px without sideways scroll, six pairs of columns share a two-line cell: Standing/Rating, Fleet/Platforms, Trips/Trips ever, Completed/Completion, Days/Km, First trip/Last trip. Each paired header keeps BOTH sort keys as two clickable labels (this needs a tableFrom option). The search box sits directly above the table.
- The Licence pill becomes the word 'expired' in the negative colour with a glyph, plus the date line. Platform pills become swatch + ink label in the fixed order Uber→Bolt→Yango→Hotel.
- §03 scatter and §04 concentration curve sit side by side. §05 Cross-platform gets channel swatches in its column heads, in the fixed channel order rather than payload order. §06 performance records get a 3px channel row marker in the gutter.
- Money is shown to the cent wherever the payload has cents (for example AED 234.97 instead of AED 235), per SPEC §4. This is a change to the shared money formatter, not to this page (see cross-cutting).
- The captions under the table become one caption line. The provenance line becomes the colophon.

**Add (from the redesign, with its data source)**

- §04 'How the work concentrates' curve: share of bookings run by the top 10 / 20 / 50 (30.2% for the top 20), with the even-fleet diagonal — *source:* /api/drivers/directory rows (trips), already fetched — computed in the browser
- A sub-line on the Drove tile: median bookings per driver, the busiest driver's count, and the top-20 share — *source:* /api/drivers/directory
- A sub-line on the On the books tile: 0 pairs awaiting review · 252 Ecosine, 95 Egari — *source:* /api/same-person?counts=1 (already fetched) + directory fleet_id
- The licence expiry date on a line under the Licence pill (for example 'expired / Sep 22, 2024') — *source:* directory licence_expires
- Completion shown as a gap against the 95% threshold ('92% ▼ −3.0 pts'), replacing the cell colour — *source:* directory completion_pct + the existing completionTone 95/85 rule (the caption says it is a house threshold, not a fleet measurement)
- Absence band, 4 cells: 62 of 146 expired licences share one date (1 Jan 2026); 166 of 347 have no licence date at all; 190 of 347 have no rating; Uber bookings carry no fare — *source:* directory licence_expires, licence_days_left and platform_rating, plus the UBER_FARE_WHY constant
- Labels on the scatter's two extremes (highest and lowest km per trip) — *source:* directory trips and km

**Keep**

- The verdict text and its branch logic (driversVerdict: expired / not earning / drove), including the recommendation sentence
- The search box (name, plate, platform) and the count line, including the same-person pending pairs
- The busiest-six cards and their link to #driver/<canonical>
- All 19 directory columns, the default sort (Trips, highest first), every column sortable, the fold at 12 with the exact 'Show the other N drivers' count, a row click opening the driver, and the rank inside the name cell
- The line explaining why the Barred column is hidden, the notes on why other columns are empty, and the warning about the placeholder licence date (not-filled rule)
- The Trips vs distance scatter (80 busiest, one dot per person, click to open)
- The Cross-platform activity table: 15 rows, platform columns taken from the payload, Telematics, Bookings, Accounts, Mainly drives (+N more), Km, and its 150/15 caption logic
- The Platform performance records table with the hours-online explanation, the note that sorting only reorders the 25 shown rows, and the totals caption
- The provenance line (srcline)

**Leave structurally untouched (restyle only)**

- Search behaviour and the count line — the fastest way to find a driver
- Default sort, every sort key, the fold and a row opening the canonical #driver/p<id> — the directory is the working roster
- The Driver column stays pinned at phone width (AUDIT): on a phone it is the only thing tying the numbers to a name
- The not-filled placeholder licence rule and its count. It decides who counts as expired, so Compliance and this page agree.

**Not adopted from the mockup**

- The whole 14 Sep original (arkiv/arkiv-pages/C-drivers.html): five tiles, top-12 bars and a days-against-bookings scatter, and it drops the verdict, cards, table, cross-platform and records (rule 1). The revised arkiv-new version is the one adopted.
- The mockup's colouring of the 85–95% completion band the same as below 85% (it loses the live amber tier). The size of the gap carries it, but this needs the warn-tone ruling (see cross-cutting).

**Review corrections (adopted — they override the lines above)**

- *Correction adopted:* instead of “Six pairs of columns sharing two-line cells”: Keep all 19 columns and rely on the sticky header, pinned column and scroll cue that exist today. Restyle only. (This restructures the working roster table, which rule 3 says to restyle only. It changes the th text that absent_columns.test reads, and it touches the pinned column, sticky header and phone cards.)

*Tests that pin this page:* test/absent_columns.test.mjs (reads the directory's thead th text: 'Rating', 'Driver', 'Trips', 'Fares' — paired headers change th text), test/sticky_header.test.mjs (sticky thead inside .tscroll, measured on #drivers), test/verdicts.test.mjs (driversVerdict), test/compliance_person.test.mjs (verdict wording 'cannot legally work'), test/kpi_one_tile.test.mjs (tiles must come from kpiRow), test/auth_banner_pending_ui.test.mjs (loads #drivers in a browser), test/smoke_views.mjs, test/spacing.test.mjs

#### `#driver/overview` — effort M

*Today:* Page chrome, on every tab: identity card (photo, name, channel/fleet/state pills, phone, email, first/last trip, trips ever, in this window, accounts, person p432, rating, Uber count, Uber account, Uber papers). A separately fetched live status strip ('Offline since 14:04 · 6h 20m online today · 2.3h on trips · from 06:55', or an absence sentence if the request fails). Tab bar using canonical addresses. For multi-account people, a line splitting the work by account. The empty-window note. Overview: 11 tiles (Typical start, Days worked, Hours online, Utilisation, Trips, Completion, Money in [floor], Cash on hand, Bank deposit, Fares, Rating – 0). 'How they rank in the fleet' percentile bars (8 metrics) with an explanation of the cancellation direction and the basis. Cars they have held (whole record, 5 columns, primary-holder dot). When the day starts (scatter with the middle-half band). Days × hours heatmap. Trips per day (completed/cancelled).

**Change**

- Header layout: identity card on the left with the photo, live status and span strip on the right, tab bar as a text row with an underline on the current tab. Pills become swatch + ink label.
- Tiles regrouped: 00 At a glance = Trips (hero) · Days worked · Hours online · Utilisation · Completion · Typical start (6 tiles). The mockup put Typical start under Money, but it is not a money figure. 01 Money = Money in · Cash on hand · Bank deposit · Fares.
- The Rating tile moves into the identity card ('4.98 Uber · unchanged over 7 days and 57 trips'); the no-change dash stays grey
- Long tile sub-lines are shortened to one clause. The full reason moves, verbatim, to the absence band. Phrases the tests assert stay in the sub-lines.
- Rank bars become a lollipop against the 50th-percentile rule, in the Uber identity colour. Heatmap uses the achromatic sequential ramp. Start scatter dots use the channel identity with the band as a wash. Trips per day: completed in the identity colour, did-not-complete in ink, a day with no trip drawn as a rule on the axis.
- Section order: 00 glance → 01 money → 02 rank → 03 start | 04 heatmap → 05 cars held → 06 trips per day → absence band

**Add (from the redesign, with its data source)**

- Trips hero delta: '▲ +24 against the fleet median of 156 · 63rd of 118' — *source:* /api/driver/standing (already fetched: value, fleet median, rank, n)
- Each rank row's own value against the fleet median printed at the right (for example '180 · fleet median 156 · 63rd'). Today this is only in a tooltip. — *source:* /api/driver/standing
- Today's Uber status spans drawn 00–24 under the live status (on trip / online / offline outline) — *source:* /api/status/driver today.spans (status, from, minutes) — api/status_routes.js already returns it
- Absence band, 4 cells: fares on every booking (14 of 180), the bank transfer itself (none), licence and ID numbers (withheld), a pickup time (none) — *source:* kpis priced counts + profile identity_withheld + fixed truths already stated in the tile sub-lines

**Keep**

- Identity card, every field, and the withheld-identity wording
- Live status strip, fetched separately and never cached, with its absence sentence when the request fails
- Tab bar on canonical p<id> addresses; the multi-account split line; emptyWindowNote as the first line under the tabs
- All 11 tile figures and their meanings: Money in as a floor, Cash on hand, Bank deposit as a remainder rather than a receipt, and Fares
- The rank bars and their direction note (a high cancellation percentile is good); the rule that tied ranks are neutral
- Cars they have held (whole record, newest first) with the primary dot; the start scatter with the middle-half band; the heatmap; trips per day

**Leave structurally untouched (restyle only)**

- The canonical-address rewrite and the crumb 'Drivers / name'
- The one-request live status (it is on api/cache.js's NEVER list), so it stays separate from the cached profile
- Cars they have held is a working table (plate → vehicle). Restyle only.

**Not adopted from the mockup**

- Typical start placed inside the Money band (moved to 00 instead, see change)
- The 14 Sep original profile had no identity card, live status or tab bar (NEW-PAGES §9); only the revised arkiv-new version is used

**Review corrections (adopted — they override the lines above)**

- *Data source corrected:* driver/overview: the rank bars and trips per day are drawn 'in the Uber identity colour', but standing and trips cover every channel for a multi-channel driver. Use ink unless the person worked one channel.

*Tests that pin this page:* test/person_address.test.mjs (.idcard, #view .tabs, crumb), test/driver_fares.test.mjs (tile labels 'Money in', 'Cash on hand', 'Fares' and the Fares sub-line text), test/driver_money_tiles.test.mjs, test/driver_empty_window_page.test.mjs (.kpi, .stack > .note, 'Trips per day'), test/kpi_one_tile.test.mjs, test/page_numbers.test.mjs, test/uber_profile.test.mjs (identity-card source), test/phone.test.mjs (tel: link on the card), test/status_routes.test.mjs ('online today'), test/driver_standing.test.mjs (rank claims, reads driver.js and ui.js standingNote), test/driver_reconcile.test.mjs, test/interlinking.test.mjs, test/smoke_views.mjs, test/spacing.test.mjs

#### `#driver/activity` — effort M

*Today:* No tile row. 'How the day was spent' ribbon: one row per day, with each job at its real position, the online-waiting band, not-online and hatched no-dropoff jobs; each row shows first–last, on job, online, waiting h and % and jobs, and a row opens the driver-day page. Five captions: 65.9 h on job / 123.2 h waiting, 214.1 h online of which 148.2 h was not dispatched, 14 with no dropoff, the stored-record line. 'Hours online vs on job' (dual series, 214h / 66h, a 148h gap). 'Distance per day' (pale slots for days worked with no distance, faintest for days not worked). 'Day by day' table with 13 columns (Day→#day, First, Last, Span, Trips, Cancelled, Km, Fares, Money ·1/7, Online ·basis, On job, Vehicle, Context °C) and 2 captions. 'Vehicle custody' table with 8 columns (Day, Plate, Platform, Trips, Km, First, Last, Primary).

**Change**

- Ribbon colours: on job = Uber identity, online-waiting = Uber 'available' ramp step, not online = no mark, no-dropoff = hatch in the job's own colour. For drivers who work more than one channel, L2 forbids one channel's ramp beside another channel's identity in one plot. That needs a ruling; the proposal is jobs at channel identity and the online band as a neutral wash.
- Hours online vs on job becomes overlapping columns per day (online = available step, on job = identity) on one ruler, with the legend carrying the totals
- Distance per day: the pale slots for 'worked, no distance' become 1px grey-2 outlines, and days not worked get no mark (a gap), per SPEC §5. Measured days are Uber-identity columns.
- Tables restyled with hairline rules and tabular figures; money shown to the cent
- Captions trimmed to 120 words of body text or fewer. The absence explanations move, verbatim, to the band.

**Add (from the redesign, with its data source)**

- 00 At a glance, 5 tiles: Online, not dispatched 147.2 h (hero, 70% of online) · On job 64.5 h · Waiting between jobs 121.3 h (64%) · Online 211.7 h (availability for 20 of 20 days) · Jobs 180 (14 with no dropoff) — *source:* /api/driver/shift + /api/driver/days (already fetched; the same figures the captions print today)
- §06 'How the car was driven': tracker alerts per 100 km ▲ +41.9 against the fleet's 68.1 (negative colour, because this is a measure where lower is better), Sharp turn / Harsh acceleration / Harsh brake / Overspeed counts with the latest time — *source:* /api/driver/quality (the Quality tab's endpoint; one extra request on this tab)
- Absence band, 4 cells: a dropoff time (14), a pickup time (none), availability beyond 31 days, why a day was quiet (none) — *source:* shift payload counts + the fixed truths in today's captions

**Keep**

- The ribbon with every row, its five figure columns, and the row link to #driver/<p>/day?on=
- The totals and the stored-record statement (the time of the last write, days carrying availability)
- Hours online vs on job with its gap figure and basis sentence
- Distance per day with the '20 of 23 days carry a measured distance' statement
- Day by day: all 13 columns, including every day any feed reached; Day links to #day/<date>; the Money 1/7 share caption
- Vehicle custody: all 8 columns
- Both time-rounding rules (day by day rounds, custody truncates — NEW-PAGES §9)

**Leave structurally untouched (restyle only)**

- The ribbon → driver-day drill-down (the only way into #driver/<p>/day)
- The Day → #day/<date> links
- Both tables' columns and order (newest first)

**Not adopted from the mockup**

- The 14 Sep original (arkiv/arkiv-pages/C-driver-activity.html): it lacked the per-day hours, distance, the 13-column day-by-day table and custody

*Tests that pin this page:* test/uber_timeline.test.mjs ('How the day was spent' figures), test/driver_empty_window_page.test.mjs, test/smoke_views.mjs, test/spacing.test.mjs

#### `#driver/day (?on=YYYY-MM-DD)` — effort L

*Today:* Driver chrome, then a headline ('2h 58m carrying someone, 10h 13m online and waiting'; 09:36 to 23:14, online 13h 11m, median gap 31m) with the figure '23% of online time' and '10 trips · 106.4 km'. 'The day, midnight to midnight' timeline: jobs, waiting, 'online per Uber 13h 11m', 'went online in Al Garhoud 2×', and the no-coordinates caption. 'Every job, and the gaps between them': a card per job (times, pick-up/drop-off addresses, km, minutes on trip, tier, paid, fare, outcome, open ↗ to #trip) and a block per gap (waiting minutes, until, area and 'mostly X% of fixes', % stationary, km moved, coordinates, where ↗, LONG WAIT tag).

**Change**

- The headline becomes the 00 band (hero = the share of online time carrying someone, the one highlight)
- Timeline restyled: on a job = Uber identity, online-waiting = Uber available step, not online = no mark, ruler 00–24
- The job cards become one ledger table: one row per job (time range; pick-up and drop-off on two lines; km; on trip; tier; paid; fare to the cent; outcome; open ↗), with a full-width 'waiting' row between jobs carrying every gap field and the LONG WAIT tag. Same order, same fields.
- The date appears in the control bar as a fixed label taken from the URL

**Add (from the redesign, with its data source)**

- 00 tiles comparing the day with the driver's own month: share of online time carrying someone 23% ▼ −8.0 pts against his 30.5% (hero), Carrying someone 2h 58m, Online and waiting 10h 13m (median gap 31m), Trips 10 ▲ +1.0 against 9.0 a day, Distance 106.4 km (trip value AED 480.38 · 10.64 km a job) — *source:* /api/driver/day (already fetched) + /api/driver/kpis for the calendar month containing the day (one extra request)
- §03 'Where the car went': the day's tracker path, fix to fix, broken wherever the tracker was silent for more than 30 minutes, with the first and last fix marked — *source:* /api/driver/day fixes[] (lat, lng, m) — 198 on the sample day; draw with map.js makeMap, which driver.js already imports
- §04 'Where the tracker saw the car': fixes by area, as ranked bars — *source:* /api/driver/day fixes[].area
- Absence band, 4 cells: speed on a fix (115 of 198 carry none), distance with a rider in (none), money for this day (a 1/7 share, AED 348.21), a pickup time (none) — *source:* fixes[].speed null count; days payload; fixed truths

**Keep**

- Every field of every job and every gap, in time order, including 'open ↗' (#trip) and 'where ↗'
- The LONG WAIT rule (90 minutes or more), stationary judged by speed or by displacement under 60 m, and the statement 'a block with no position is one the tracker did not cover'
- 'went online in <area> N×' with the explanation of how the place is inferred
- The crumb Drivers / name / date and the subtitle naming the one day

**Leave structurally untouched (restyle only)**

- The day is only reached by clicking on Activity; no day picker or next/previous is added
- The gapMotion / onlineShare / outcome rules in driverday.js (tests pin them)
- The open ↗ and where ↗ links — the operator's way from a gap to the map or the booking

**Not adopted from the mockup**

- A working date picker in the control bar: the mockup's pill would be new navigation nobody asked for, so it is a label only

**Review corrections (adopted — they override the lines above)**

- *Correction adopted:* instead of “Job cards and gap blocks turned into one ledger table”: Restyle the cards, or get the operator's approval first. (A DOM restructure of a drill-down page. No field is lost, but rule 3 asks for restyle only.)
- *Data source corrected:* driver/day §03 'Where the car went': /api/driver/day fixes cover every plate the driver held that day (plate = ANY($1)) and carry no source (driver_routes.js:2762-2775). Drawing fix to fix would join two cars or two devices, the same interleave defect as #map/replay. Break the path by plate, and add source to the payload.

*Tests that pin this page:* test/dangling_online.test.mjs (reads driverday.js source), test/driver_day_outcome.test.mjs (reads driverday.js source), test/person_address.test.mjs, test/spacing.test.mjs

#### `#driver/territory` — effort S

*Today:* Map 'Where this driver works' (pickup clusters sized by trips; hollow markers where the car sat still between jobs). 'Busiest pickup areas' table (12 rows). 'Trip distance mix' bars plus a table. In this capture, the areas and distance panels were still loading after about 4 s.

**Change**

- Restyle through the shared foundation only. Cluster circles take the channel identity of the trips they hold, with a swatch legend.
- Stationary markers change from hollow rings to small filled grey-ink squares: under SPEC §5 a hollow mark means 'not measured', and these are measured places
- Distance-mix bars use the achromatic sequential ramp (distance bins are ordered, not channels); tables get hairline rules

**Keep**

- The map (pan, zoom, fit), the clusters and the stationary markers
- The busiest-areas table and the distance-mix bars and table

**Leave structurally untouched (restyle only)**

- The map and its interactions — an operational view (rule 3)

*Tests that pin this page:* test/smoke_views.mjs, test/spacing.test.mjs

#### `#driver/earnings` — effort S

*Today:* 6 tiles (Booked revenue, Average fare, Platform earnings, Tips, Cash collected, Revenue per km). 'What made up the pay': bars for 5 top-level components netting to AED 4,267, plus the nested components table (Within / Component / Amount). 'How riders paid' donut (braintree 62 · 34%, apple_pay 49, offline 43, cash 22). 'Revenue by day' line. 'What each platform paid' statements table.

**Change**

- The donut becomes one 100% stacked bar with direct labels (count and share) in achromatic sequential steps. Payment types are not channels, so they get no channel hue, and SPEC §4's mark set has no donut.
- Component bars: ink bars left and right of a zero rule. The sign is carried by '−' in the label, never by a green or red fill (L3: semantic colours are never an area).
- Revenue by day: a line in the channel identity colour (one line per channel, with direct labels, if there is more than one); tables get hairline rules; money shown to the cent

**Keep**

- All 6 tiles with their basis sub-lines (gross vs payout, priced counts)
- The components bars and the nested table, including the rule 'anything below is inside one of them'
- Payment counts and shares; revenue by day; the statements table

**Leave structurally untouched (restyle only)**

- The statements table (it is reconciled against payout files)

*Tests that pin this page:* test/driver_fares.test.mjs, test/driver_empty_window_page.test.mjs, test/smoke_views.mjs, test/spacing.test.mjs

#### `#driver/quality` — effort S

*Today:* 6 tiles (Completion 92.4%, Did not complete 7.6%, Acceptance 100%, Rating 4.98 – 0, Harsh events 2,378, Per 100 km 109.4 'fleet median 68.1 — 1.6x'). Non-completed trips bars (raw provider strings such as 'rider cancelled · uber'). Harsh driving table (event, count, most recent). Cancellations by day bars.

**Change**

- Per 100 km sub-line becomes a delta chip '▲ +41.3 against the fleet median 68.1' in the negative colour (a measure where lower is better, so semanticOf is inverted), keeping the '1.6x' ratio in the caption
- Completion shows its gap against 95% with glyph and sign; Rating keeps the grey '–' for no change
- Non-completed bars take the channel colour named in the label, with a swatch beside the text (never coloured text). Cancellation bars use the identity colour, and a day with no trip is a gap.

**Keep**

- All tiles and their basis lines; the raw provider strings; the harsh-driving table; cancellations by day

**Leave structurally untouched (restyle only)**

- The harsh-driving table

*Tests that pin this page:* test/driver_empty_window_page.test.mjs, test/smoke_views.mjs, test/spacing.test.mjs

#### `#driver/record` — effort S

*Today:* Grain toggle (Week by week / Month by month). Verdict 'Within their usual range' with a sentence. Tiles: Jobs done, Position on jobs (45th of 116), Trip value, Position on value, Active days, Jobs a day. Charts: jobs done week by week (bars with the fleet-median outline behind); trip value week by week; where they stood (a percentile bar with the value position as an outline). A part-week is drawn hollow, and no-work periods as a hatched band. 'Every period on record' table (9 columns). 'How to read this' (7 rules) and a channel note.

**Change**

- The fleet-median outline behind each bar becomes a 2px ink-2 tick across the bar. Under SPEC §5 an outline means 'not measured', so an outlined median would read as a missing figure. Where they stood gets the same treatment: the value position becomes a tick.
- The part-week bucket changes from hollow to HATCH in the bar's own colour (SPEC §5: hatch marks an unfinished period)
- No-work weeks change from a hatched band to a GAP, or a grey-2 outline if the band has to stay visible — hatch is reserved for unfinished periods
- 'Against their usual' keeps glyph and sign (▼ 11 in the negative colour); 'within range' stays grey. The verdict becomes the 00 band hero.

**Keep**

- Grain toggle, verdict and its rules, all tiles, all three charts' data, the period table, and the 'How to read this' text

**Leave structurally untouched (restyle only)**

- The grain toggle and the period table — the reading of this person over time

*Tests that pin this page:* test/driver_empty_window_page.test.mjs, test/smoke_views.mjs (driver/drv-0/record, ?grain=month, drv-3/record), test/spacing.test.mjs

#### `#driver/money` — effort S

*Today:* 'Where they stand': 5 tiles, all absent with reasons (Owed in total, Advances outstanding, Still held, Deductions, Against the line — no opening cash position, no stored threshold). 'Over this month': Income, Cash taken, Cash fares, Cash advanced —, Cash handed back —, with ceiling/position captions. 'Statement for This month' with opening lines and the long statement table (When, What, Fare, Cash in, Entry, Cash taken, Still held, Owed, Proof).

**Change**

- Restyle only: absent tiles use the Arkiv absence cell (the reason in place of the value, never highlighted — L4); the statement table gets hairline rules, tabular figures and cents

**Keep**

- Every tile, every reason and the ceiling-not-balance wording
- The statement table, all 9 columns and its row order

**Leave structurally untouched (restyle only)**

- The whole tab structurally. It is the per-driver cash reconciliation (rule 3).

*Tests that pin this page:* test/driver_money_tab.test.mjs, test/driver_empty_window_page.test.mjs, test/smoke_views.mjs, test/spacing.test.mjs

#### `#driver/trips` — effort S

*Today:* 'Trip records', newest first (Requested, Platform, Plate, From, To, Km, Minutes, Product, Pay, Status, Fare, including 'part of AED X earned that day'), with '184 bookings · 0 with no booking', a load-more page (offset) and unexplained journeys interleaved.

**Change**

- Restyle only: a 3px channel row marker in the gutter (SPEC §4); the Platform column text stays; status in ink (an outcome is not better or worse); fare shown to the cent; hairline rules

**Keep**

- Every column, newest-first order, paging, the 'part of AED X earned that day' cell and the interleaved journeys

**Leave structurally untouched (restyle only)**

- The table and its paging — the raw evidence rows

*Tests that pin this page:* test/driver_trip_day_money.test.mjs (browser), test/absent_columns.test.mjs, test/driver_empty_window_page.test.mjs, test/smoke_views.mjs, test/spacing.test.mjs

#### `#driver/unauthorized` — effort S

*Today:* A note that no car this person held carries any seat-occupancy evidence, and an inference note. 7 tiles: Named beside 0, Named by time 0, Last trip on the car 0, Sole custodian 0, One of several 0, Distance —, Revenue forgone — (its sub-line reads 'AED 0 across journeys… AED 0 across journeys…'). Two tables (named beside; one of several), each 'Nothing to show'.

**Change**

- Restyle only, plus ONE TRUTH FIX (house principle, SPEC §5). When the tab's own note says no seat-occupancy evidence exists for the window, the five count tiles show absent with that reason instead of '0', and the Revenue forgone sub-line stops printing 'AED 0 … AED 0'. Today the page says 'nothing was looked at' and then prints five zeros.

**Keep**

- Tier wording (custody is not driving), no warning colour unless all of it rests on time, and both tables

**Leave structurally untouched (restyle only)**

- The attribution tiers and the two tables

*Tests that pin this page:* test/unauthorized_attribution_page.test.mjs, test/unauthorized_attribution.test.mjs, test/smoke_views.mjs, test/spacing.test.mjs

#### `#online-time` — effort L

*Today:* Panel 'The day, and the time you expect them to start' with a Day picker and an Expected start picker (localStorage, default 06:00). Live line '61 working right now — 10 on a trip · 51 online and waiting · 35 offline · 63 not reported on', plus two notes (the 63 carry no status; only Uber reports a live status). 4 verdict tiles: Late, On time ('N proved by a trip'), Cannot be judged ('25 cannot earn · 36 no event · 5 drove, no timeline'), Drove ('of 134 allowed … · 7 on another channel only'). The tiles show '—' when no start time is set. 'Every driver' table: Driver, Online (time + '+234m' pill), First trip (time · channel · n), Phone (tel:), Car ('?' = roster-attached), Where, Portals; sortable, latest first. Caption about the timeline pass.

**Change**

- The live line becomes a one-line bar: on trip = Uber identity, online and waiting = Uber available step, offline = grey-2 outline, not reported = no mark, all counts labelled directly. The two notes become captions.
- Tiles become 00 At a glance: Late is the hero (the one highlight), then On time, Cannot be judged, Drove, Wait to a first job
- Online cell: '09:54 ▲ +1 h 24 min late' in the negative colour with glyph and sign, replacing the pink '+234m' pill (L3). On-time rows carry no colour. Portals become swatch chips in the fixed channel order.
- The pickers move into the control bar ('DAY · EXPECTED START'); the table gets hairline rules and tabular times

**Add (from the redesign, with its data source)**

- 'Wait to a first job' tile: median 60.7 min, 72 with an Uber job, 15 came online and have none yet — *source:* /api/online-time rows (online_minute, first_trip_at / worked_first_at)
- §02 'The morning, against <start>': cumulative people online by half-hour, split into 'a booking had started' and 'online, no booking yet', with a rule at the expected start and the labels '78 on by 08:30 · 9 after' — *source:* /api/online-time rows (online_minute, worked_first_at)
- §03 'Online to a first job' distribution (before, 0–15, 15–30, 30–60, 1–2 h, 2–3 h, 3 h+, and 'still waiting' hatched) — *source:* /api/online-time rows
- §04 'Could work it, and drove it' per channel (Uber 159/72, Bolt 21/2, Yango 31/1, Hotel 78/9) — *source:* /api/online-time rows portals + worked_platforms
- Late compared like with like: '▲ +1 against 8 late by 10:18 yesterday', shown only when the chosen Day is today — *source:* a second /api/online-time call for the day before with the same start, counting late rows with online_minute at or before the current minute
- Absence band, 4 cells: coming online after the last pass (not yet seen), people with no online event (40), start times from the other channels (none), a live status for everyone (63 of 159) — *source:* totals (absent, worked_elsewhere, unjudged_by_basis) + feed (last_run_at)

**Keep**

- The Day and Expected start pickers and their meaning (both apply to every number and colour); the start is stored per viewer
- The live 'working right now' counts and both notes
- The 4 verdict tiles with their exact sub-lines, and '—' when there is no start time
- 'Every driver': all 7 columns, sortable, default Online latest first, dialable phone, roster '?' on Car with its title, Where with its why, Portals, row → driver
- The timeline-pass caption

**Leave structurally untouched (restyle only)**

- The call-list table's order (latest first), columns and sorting — the operator works down it by phone (rule 3)
- The onlinetime.js expressions test/online_time.test.mjs pins ('const judged = d.expected_start != null;' and 'value: judged ? fmt(t.late ?? 0) : '—''); keep them, or change the test deliberately
- The /api/online-time contract, which the phone screen m/screens.js also reads

**Not adopted from the mockup**

- The grouped call list (Late · Not online at all · On time · Drove, no start time · Cannot take work on Uber) with group headings. It reorders the working call list, and NEW-PAGES §7 itself calls it a proposal. Adopt only if the operator explicitly approves; the default stays the single latest-first sortable table.
- The Late sparkline for 9–23 Sep: it needs one /api/online-time request per day (15 per page load), or a history endpoint that does not exist. Drop it unless that endpoint is built.
- The 14 Sep original (arkiv/arkiv-pages/C-online-time.html): no expected-start control, no verdicts, no call list

**Review corrections (adopted — they override the lines above)**

- *Correction adopted:* instead of “'The pickers move into the control bar (DAY · EXPECTED START)'”: Keep the pickers in the page panel and restyle them. (This moves a working form out of the page (rule 3). #online-time is in NO_FILTER, the foundation's .ctl has no place for page controls, and online_time.test pins onlinetime.js.)

*Tests that pin this page:* test/online_time.test.mjs (pins source expressions in onlinetime.js), test/online_other_channels.test.mjs (reads onlinetime.js), test/online_roster_coverage.test.mjs, test/phone.test.mjs (dialable tel: links), test/nav_sections.test.mjs, test/smoke_views.mjs, test/spacing.test.mjs

#### `#performer` — effort L

*Today:* 5 tiles: Days worked (week of Sep 14 to Sep 20), Bookings 109 (102 completed), Carrying someone 39.8 h (measured over 94%), Of time on the road 40%, Waiting between jobs 61 h (61%). 'The week, day by day' table with 11 columns (Day, Bookings, Cancelled, Km, First, Last, On trip, Elapsed, Waiting h·%, Longest gap·median, Vehicle → #vehicle) and overlap/no-end-time captions. 'Where the work came from' (Channel, Bookings, Km, Fares ·priced, Paid, Statement covers) with the fare-vs-payout caption. 'Where they picked up' (12 area bars, including '(unrecorded) 10'). 'What the platform said': Uber status table (Day, Status, Observations, First seen, Last seen) or an absence sentence.

**Change**

- 00 At a glance = Money (hero) · Bookings · Days worked · Carrying someone · Of time on the road · Waiting between jobs (6 tiles), with the fact strip under it. The three rates follow as a second row, 'Against the fleet this week'.
- Section order: glance → week chart → day-by-day table (full width, restyled) → fares per day → channel table next to the three-documents bars → areas → status → rank strip → absence band
- Areas: '(unrecorded)' becomes an outlined bar (absence), not a filled bar of 10
- Status: a grouped column chart of observations (on trip = identity, online = available step, offline = outline) is drawn ABOVE the kept table

**Add (from the redesign, with its data source)**

- Money hero: Uber statement net for the week (AED 4,470.21) with '▲ +2,783.7 against AED 1,666.5, the mean of the 151 who earned' — *source:* /api/economics/drivers?from=<week>&to=<week end> (statement_net, money, money_basis) — the request top-performers already makes; one extra request here
- Rates against the fleet this week: per day worked AED 638.6, per measured hour AED 40.34, per booking AED 41.01, each ▲/▼ against the fleet mean — *source:* same economics row (aed_per_day_worked, aed_per_measured_hour, aed_per_booking) and the fleet rows
- Fact strip: licence valid to 15 Nov 2028 · 946 alerts, 76 per 100 km · 155 telematics journeys beside the 109 bookings · money basis 'uber: statement' — *source:* economics row licence_expires, alerts, alerts_per_100km, telematics_journeys, money_basis
- §01 week chart: stacked columns per day of carrying someone (Uber identity) and waiting (available step), with the longest day labelled — *source:* /api/performer days (on_trip_min, wait_min, elapsed_min)
- Fares per day, as §02 bars and as a new Fares column in the day table (the live table has none) — *source:* /api/performer days[].fares
- 'Three documents, one week': fares on the bookings 5,960.47 · Uber's statement net 4,470.21 · payout register 4,440.73, never added together — *source:* /api/performer platforms + payouts, and economics statement_net
- §06 'The same week, for the other 282': this person's rank by money among everyone in the week; people with no money are a gap — *source:* /api/economics/drivers rows for the week
- Absence band: what a second account would hide (the detail endpoint is per account — NEW-PAGES gap 5; the count comes from economics ids/accounts), time logged in (hours_online null), 7 of 109 with no end time (p.note), whether a gap was waiting or rest (none) — *source:* economics row + /api/performer note

**Keep**

- All 5 live tiles and their sub-lines
- The day-by-day table, all 11 columns, with its overlap and no-end-time captions
- The channel table and the rule that fares and payouts are never added together
- The area bars and their free-text caption
- The status table: first and last seen per status are the only times the poll gives; its absence sentence stays
- The week taken from the URL and the crumb back to the ranking

**Leave structurally untouched (restyle only)**

- The day-by-day table and the status table (rule 1: the charts that sit above them do not carry first/last trip, longest and median gap, vehicle, or first/last seen)
- The link from a row in the ranking to this page, with its week

**Not adopted from the mockup**

- Replacing the day-by-day table and the status table with charts only
- Dropping Days worked, Bookings, Of time on the road and Waiting as tiles
- The weekly-money sparkline in the hero: it needs one economics request per past week and there is no history endpoint

*Tests that pin this page:* test/performer_week.test.mjs (week options, crumb, week in the tile sub-line), test/audit_tools_detect.test.mjs, test/smoke_views.mjs (performer/drv-0, performer/drv-9), test/spacing.test.mjs

#### `#cohort` — effort M

*Today:* One generic page for 24 cohorts (driver and vehicle), reached from Unit economics, Roster, Retention, Settlement, Vehicles, Safety and Tiers. Verdict ('59 people — licence expiring', the question and why, 'from Unit economics'). A tile row built only from fields the rows carry: People 59 of 307, Bookings 2,634 (31,780 km), Money, Idle days, Online, Licences due 59 'expiring within 30 days', Harsh events. 'The full list': normalised columns that hide themselves when no row carries them, sortable, 12 at rest, row → driver or vehicle. 'What each system holds': one card per member from /api/cohort/{drivers,vehicles}, listing which sources answered and which were silent, 6 at rest. Notes on caps, truncation and the 400-id limit.

**Change**

- The verdict becomes the 00 band hero. Tiles join the band (at most 6; any more go on a second row).
- The full list gets hairline rules; the cards become a grid restyle; channel names use swatch + label
- TRUTH FIX: the 'Licences due … expiring within 30 days' tile (and 'Papers due' on vehicle sets) counts every negative days_left, so unit-licence-due reads '59 expiring' when all 59 have already lapsed, the newest 61 days ago. Split it into 'Already lapsed' and 'Due within 30 days', and make the verdict say 'licence expired or expiring'. The predicate is unchanged, so the linking tile keeps its count.

**Add (from the redesign, with its data source)**

- 'What every other system could answer' bars for every cohort: N of M accounts answered, per source (availability, ride platforms, custody, standing, compliance, payouts, driving events, performance), with an outline where a source held nothing — *source:* the /api/cohort/{drivers,vehicles} join the cards already fetch — no extra request
- 'Which channels carry one' bars for driver cohorts (members, not accounts) — *source:* cohort rows platforms
- A runway chart for licence cohorts only (unit-licence-due, and roster cohorts that carry licence_days_left): one column per member showing days past or until expiry, the 30-day window drawn empty to scale, and the flat step labelled when many members share one date — *source:* rows licence_days_left / licence_expires
- Licence cohorts: 'still marked able to earn 57 of 59', 'carry the same expiry date 43 of 59', 'people with no licence date at all 235 of 307' — *source:* rows can_earn and licence_expires; the source rows (all)
- 'Earned since it lapsed', shown ONLY when every member's expiry falls before the window start; otherwise shown absent with that reason (money cannot be split by day from these rows) — *source:* rows money + licence_expires + the window
- Absence band built from the page's own silent-source list and the cap/truncation notes — *source:* cards' silent[] + c.cap / c.trunc

**Keep**

- The verdict (same count as the tile that linked here, same predicate)
- Tiles that only appear when their field exists; 'Forgone' in place of Money on an asset set
- The full list: all normalised columns, hidden with a reason when absent, sortable, fold, row click
- The member cards, with the 'Answered by … Silent: …' line
- The cap, truncation and 400-id notes

**Leave structurally untouched (restyle only)**

- The predicates in cohorts.js (the tile and this page must count the same set)
- The full list and its row clicks — this is the page where named people get acted on

**Not adopted from the mockup**

- The mockup drops the full list and the member cards. Rule 1: they are the named, sortable, clickable part.
- 'What they earned after it lapsed' (12 bars): the same people and money the sortable table's Money and Licence columns already hold; no new data
- Making the licence runway the hero for every cohort: it exists only for licence sets; other cohorts keep the verdict and table

*Tests that pin this page:* test/cohorts.test.mjs (predicates and cohort keys in app.js / vehicle.js), test/kpi_one_tile.test.mjs (tiles that link to #cohort carry kpi-who), test/tracker_speed.test.mjs (fold noun on #cohort/roster-blocked), test/smoke_views.mjs (5 cohort routes), test/spacing.test.mjs

### People — the rest

#### `cancellations` — effort M

*Today:* Rendered on the mirror at 1440: 5 tiles (Cancellations 2,030 · Dropped a job 119 · Offers not taken 165, only Bolt reports these · By the rider 1,727, 85% · Nobody said who 19). One panel, 'Cancellations by driver': a sortable table of 115 rows × 10 columns (Driver link, Car plate links, Phone as a tel: link through dialable(), Rating with its platform, Bookings, Cancelled with %, Dropped a job as a pill with the Uber/after-accept/%-of-accepted breakdown on hover, Offers not taken or 'not reported', By the rider, Nobody said who). Default sort is Dropped desc, which matches the SQL ORDER BY. Under the table: the API's unattributed_why note and the offers note. No charts. The mockup drops the table entirely.

**Change**

- Section order: 00 At a glance (5 tiles; the hero is Dropped a job, the figure the table is ordered by, and carries the page's one highlight) → 01 a compact hero row, 'Who called it off' beside 'What a driver cancellation was', about 260px tall → 02 the table, unchanged and kept directly under the hero so the phone list stays within one screen → 03 cancellations per driver by rank → 04 dropped-after-accepting by group → 05 absence band (unattributed_why, the offers note, ratings)
- Pills on counts lose their red/amber fills (Dropped ≥5 'err', Offers ≥20 'warn'): a count is not a direction. They become ink figures, with weight 600 at the old thresholds
- Chart colours: the rider/driver bars are ink/grey (a rider is not a channel); the nobody-said-who bar is Yango #B4358A because Yango filed those rows; composition segments use the Bolt identity where the status word is Bolt's own. Direct labels on every bar
- Table restyled to hairline rules and tokens only. The rating's platform stays text, never coloured

**Add (from the redesign, with its data source)**

- Hero mark, 'Who called it off': one bar each for rider, driver dropped a job, driver declined an offer, and nobody said who (Yango) — 4 bars, direct-labelled — *source:* /api/cancellations totals.by_rider, dropped, declined, unattributed
- 'What a driver cancellation was': a composition bar of Bolt offers declined or unanswered, Uber jobs cancelled after accepting, Bolt jobs abandoned after accepting, and the unattributed ones kept apart — *source:* sum of rows[].driver_declined_offer, driver_cancelled_uber, driver_after_accept; totals.unattributed
- Cancellations per driver by rank: one column per driver, with the maximum and the median labelled (mockup 01) — *source:* rows[].cancelled
- Dropped after accepting, drivers who work Bolt vs those who do not, on the one basis both groups share (mockup 05) — *source:* sum of dropped / sum of accepted, grouped by rows[].on_offer_channel
- Tile sub-lines: 'x% of the N bookings these M drivers took' and 'K drivers called none off themselves' — *source:* sum of rows[].bookings; rows where by_driver = 0
- Absence-band item: ratings are Uber's only — 'n of M drivers carry no rating' — *source:* rows[].rating == null, rows[].rating_platform
- Sparkline on the Cancellations tile — *source:* needs a per-day series added to /api/cancellations (the payload has totals and rows only) — **needs a new endpoint**

**Keep**

- The 10-column table exactly as it is: columns, their order, tel: links through dialable(), entity links on driver and plate, the hover breakdown on Dropped a job, the 'not reported' reason in Offers not taken, the per-column absent sentences, defaultSort dropped desc
- The split tiles Dropped a job / Offers not taken, never merged into one 'driver called it off' figure
- The Nobody said who tile, rendered even at 0 with 'every channel named the actor'
- The unattributed_why note, which comes from the API, and the offers note (moved into the absence band, text unchanged)
- Fetching through q() so the window is honoured

**Leave structurally untouched (restyle only)**

- The per-driver table: it is the operator's phone worklist. Row structure, sort and tel: links stay as they are
- The three-bucket actor model (rider / driver / nobody said who), and the split of dropped vs declined

**Not adopted from the mockup**

- Dropping the per-driver table (the mockup has none). It is the list operators ring from
- The single 'Driver called it off 270' tile, and sections 04 'Everything a driver called off', 06 'Who called off most themselves' and 07 'The share of their own they ended'. Each adds declined Bolt offers to dropped jobs, which ranks people by which app they work. The live page split these for exactly that reason, and cancellation_split.test.mjs guards the split
- The label 'Accepted elsewhere, then ended — channel not named in the feed'. driver_after_accept is Bolt's own status 'driver_cancelled_after_accept' (api/cancellation_sql.js:213), so the channel is named
- The absence claim 'Why a booking was called off — None': not checked against the trip schema. Adopt it only after confirming no channel files a reason
- Title-casing driver names: names stay as the channel filed them, because operators match them against the provider portals

**Review corrections (adopted — they override the lines above)**

- *Data source corrected:* cancellations: the 'nobody said who' bar is hard-coded Yango. The payload carries unattributed_platforms (cancellation_sql.js:207-210), so derive the colour from it and use ink when more than one channel is present.

*Tests that pin this page:* test/cancellation_split.test.mjs, test/dubai_day_window.test.mjs, test/interlinking.test.mjs, test/pinned_identity.test.mjs, test/completeness.test.mjs, test/signed.test.mjs, test/nav_sections.test.mjs

#### `roster` — effort M

*Today:* Everyone tab. A 5-tab bar. A verdict ('32 people cannot work on any platform they hold', figure 32). 7 tiles, each opening a cohort: People on the books 359 · Drove in this window 128 · Able to earn, earning nothing 98 · Recruited, never driven 90 · Still waiting to start 11 · Stopped everywhere 32 · Holding a car while stopped 31 of 32. Two further tiles appear only when non-zero (unclassified, activity_unknown). A donut 'What everyone is doing' whose slices link to the tabs or the directory. Hbars 'How many platforms each person works' (223/118/18). 'Everyone on the books — 359 people': a 17-column sortable table folded to 12 rows (default Trips desc), with the twin caption and the caveat. The roster spans Bolt, Hotel, Uber and Yango. Driver names wrap to 4 lines at 1440.

**Change**

- 00 At a glance: the verdict's figure becomes the hero tile (first, largest, the one highlight, same choice logic as the verdict). The claim becomes the band caption. The other tiles lose the ▲/▼/• tone glyphs, because none of them is a change
- Donut → one 100% horizontal bar of the standings. Segments use the achromatic sequential ramp (standings are not channels), with a direct label of count and %. Each segment keeps its click-through
- 'How many platforms each person works' restyled achromatic, 3 rows
- Section order: 00 tiles → 01 standings bar → 02 recency histogram (new) → 03 platforms per person → 04 table (unchanged) → 05 absence band (caveat, reasons)
- Table restyled to hairline rules. Standing pills become ink text chips, with no amber/red fills. The Driver column gets a minimum width so names stop wrapping to 4 lines

**Add (from the redesign, with its data source)**

- Recency histogram, 'When each person last took a booking': 0 / 1–6 / 7–29 / 30–89 / 90–179 / 180+ days. Never-driven is drawn as an outline column, never as a long gap (live: 109/13/9/21/19/92, plus 96 never) — *source:* /api/roster people[].days_since_last_trip, lifetime_trips
- Absence-band item: nobody gives a reason — 'n of N rows carry no reason; only a suspension carries one' — *source:* people[].reason
- Absence-band item, 'Rows that are not people': ECOSINE TRANSPORTS and Egari Luxury Cars Transport LLC are on the roster as drivers and counted in the 359 — *source:* needs a server-side flag on /api/roster, such as a hand-listed set of company account ids. Detecting them by name would be a name rule — **needs a new endpoint**

**Keep**

- The tab bar and every tab route
- Every tile and its 'Who exactly? →' cohort link. The categories stay split: idle and never-driven are different actions
- The 17-column table: Fares with stmt, Paid with days, Trips ever, First/Last drove with the never/not-observed distinction, Bolt score, Roster seen, Possibly already driving, Reason given. foldRows(12) and the default Trips sort stay
- Clicking a standing opens the people in it (SLICE_TO)
- The twinFor and categoryLabel exports

**Leave structurally untouched (restyle only)**

- Tabs, the cohort links on the tiles, the table with its sort and fold, the twin column: these are how operators work the roster

**Not adopted from the mockup**

- The single 'Earning nothing 51' hero, which merges idle with never driven. Live splits them (98 / 90) and each needs a different action
- 'Only Uber publishes who is on the books' and '02 What Uber calls them' as Uber-only: false. /api/roster covers 359 people across Bolt, Hotel, Uber and Yango, and /api/roster/states carries rows from all four
- '03 Working while Uber says they cannot earn' (6 people): under the multi-channel standing only 1 person is stopped everywhere and took a booking. The Uber-only framing reads work on other channels as a violation
- '04 Dormant longest' on this tab: the Last drove column already sorts this. It moves to #roster/idle
- 'No earlier roster snapshot is stored' as a tile subtitle: said once in the band caption instead
- Dropping the tabs and the table

*Tests that pin this page:* test/roster.test.mjs, test/roster_twin.test.mjs, test/cohorts.test.mjs, test/interlinking.test.mjs, test/pinned_identity.test.mjs, test/completeness.test.mjs, test/consistency.test.mjs

#### `roster/pipeline` — effort S

*Today:* Same verdict and tiles. 'Not yet earning — 101 people': a 15-column table (Km and Fares drop out when empty) with the Possibly already driving column, the twin caption and the caveat.

**Change**

- Restyle through the shared foundation only: tokens, hairline table, tiles as on #roster

**Add (from the redesign, with its data source)**

- A 100% bar of the four pipeline states (onboarding/waitlisted, never driven, standing not reported, output not observed) — *source:* /api/roster people[].category
- Absence-band item: waitlisted/rejected rows carry no reason — *source:* people[].reason

**Keep**

- The table and its columns, the twin column and caption, the Standing column that says which of the four pipeline states applies

**Leave structurally untouched (restyle only)**

- The table: operators chase recruits from it

*Tests that pin this page:* test/roster.test.mjs, test/roster_twin.test.mjs

#### `roster/idle` — effort S

*Today:* 'Able to earn, earning nothing — 98 people': a 13-column table, plus the note to widen the range before acting.

**Change**

- Restyle through the shared foundation. The ranked bars are ink, because a person spans channels

**Add (from the redesign, with its data source)**

- 'Dormant longest': the top 12 by days since their last booking, names linked (mockup 04, moved here from Everyone) — *source:* /api/roster people[].days_since_last_trip where category = idle_this_window

**Keep**

- The table, and the widen-the-range note (it moves into the absence band)

**Leave structurally untouched (restyle only)**

- The table

*Tests that pin this page:* test/roster.test.mjs

#### `roster/blocked` — effort S

*Today:* 'Stopped everywhere — 32 people': a 16-column table including Reason given and Possibly already driving, followed by the note on stopped drivers still holding a car, with plate links and ×k counts.

**Change**

- Restyle only. The holding-a-car note sits in the absence/cost band under the table

**Keep**

- The table, and the holding-a-car note with its linked plates and ×k counts

**Leave structurally untouched (restyle only)**

- The table and the plate list: operators recover cars from them

*Tests that pin this page:* test/roster.test.mjs, test/cohorts.test.mjs

#### `roster/states` — effort S

*Today:* 5 tiles (Roster rows 508, oldest and newest observation, words we could not classify 0, providers reporting no state 0). The table 'What each provider says — 12 distinct standings' (Platform, Normalised, As the provider says it, People, With a vehicle attached). An unrecognised-words table appears when there are any.

**Change**

- Restyle. One channel per small multiple, following SPEC §3.4's one-ramp-per-plot rule

**Add (from the redesign, with its data source)**

- Standings per platform as small multiples (mockup 02, all four platforms not just Uber). Bars in that channel's identity, labelled with n people and n with a car — *source:* /api/roster/states by_state[].platform, state, n, with_vehicle

**Keep**

- The table with the provider's raw word, which is the detail layer
- The unrecognised-words table and the no-state note

**Leave structurally untouched (restyle only)**

- The raw-word table

**Not adopted from the mockup**

- The Uber-only framing of mockup 02

*Tests that pin this page:* test/roster.test.mjs

#### `top-performers` — effort M

*Today:* A week select (#top-performers/<monday>) and a week note. Verdict '<a driver> earned most per day worked', AED 639. Tiles: People ranked 98 of 155 · Best per day AED 639 · Fleet per day worked AED 319 · Spread 4.4×. 'Ranked highest': 40 rows × 11 columns (Driver with rank in .rk, Fleet, Platforms, Per day, Money in with a payout/fare/both label, Days, Bookings, Per booking, Km, Completed, Standing); clicking a row opens #performer/<id>/<week>. 'Best and worst, side by side': a 6-measure ratio table. 'Not ranked': 40 rows with the reason. Coverage and hours captions. The page ranks on MONEY per day worked, falling back to bookings per day only when the week has no money.

**Change**

- Order: week control and one-line note in the chrome → 00 tiles (the hero is Best per day, the verdict's figure) → 01 top-12 bars → 02 concentration curve → 03 Ranked highest table (unchanged) → 04 best/worst table → 05 Not ranked → 06 absence band (the NO_MONEY reason when the fallback is active, coverage.note, hours_note)
- Fleet and Platforms pills become text with a 3px channel swatch. Text never wears the channel colour

**Add (from the redesign, with its data source)**

- Hero mark: the top 12 on the page's own basis (AED per day worked) as ranked bars, names linked, value direct-labelled. A bar wears the channel colour when that person's week ran on one platform, achromatic otherwise — *source:* /api/economics/drivers rows[].money, days_worked, platforms
- Concentration curve: cumulative share of the week's bookings by rank, with the even-fleet diagonal (mockup 04) — *source:* rows[].bookings
- Tile 'Worked all seven days — N of M' — *source:* rows[].days_worked
- Delta chips against the previous week on Fleet per day worked and People ranked — *source:* a second /api/economics/drivers fetch for the week before (not warmed, so it costs one uncached request)
- Sparklines on the tiles — *source:* needs a per-week fleet series endpoint — **needs a new endpoint**

**Keep**

- Ranking on money actually received per day worked, with the WORK_BASIS fallback and the reason it prints
- The gate of 4 days and 15 bookings, and the Not ranked list with its reasons
- The week select and #top-performers/<monday> addressing
- The 40-row ranked table with all 11 columns and the row click to #performer/<id>/<week>
- The best/worst ratio table (6 measures in different units, so it stays a table)

**Leave structurally untouched (restyle only)**

- How the ranking is computed, the gate, the week control, the drill into a person's week, the table columns

**Not adopted from the mockup**

- Ranking on jobs completed or trip value as the headline (mockup 01/02). Live ranks on money received, which is more exact; the jobs and trip-value rankings already live on #performance
- The absence claim '10 of 10 payout periods carry earnings null, no per-driver money': false. /api/economics/drivers for 14–20 Sep returns money for 151 of 283 people (AED 254,665.03)
- 'Hours online 0 of 300': false. measured_hours_online is present for 94 people (people_with_availability)
- 05 'What Uber did pay, day by day' and 06 'periods that carry no figure': fleet payout marks that belong on the payouts pages, and they rest on the false premise above
- The 'Most trip value' tile: it duplicates #performance

*Tests that pin this page:* test/performer_week.test.mjs, test/performer_weeks_day_key.test.mjs, test/pinned_identity.test.mjs, test/interlinking.test.mjs, test/completeness.test.mjs, test/audit_tools_detect.test.mjs

#### `low-performers` — effort M

*Today:* The same view as #top-performers in the opposite direction. Verdict 'Henry Martin Motha earned least per day worked', AED 146. The same 4 tiles (Lowest per day). The same three tables. Adds the warning note that the page cannot tell low effort from leave, a car off the road or a lapsed licence.

**Change**

- Order: 00 tiles (the hero is Lowest per day) → 01 bottom-12 bars → 02 days-worked histogram → 03 Ranked lowest table (unchanged) → 04 completion scatter → 05 best/worst → 06 Not ranked → 07 absence band. Bars are measurements, never red

**Add (from the redesign, with its data source)**

- Hero mark: the bottom 12 on the page's basis as ranked bars, names linked — *source:* /api/economics/drivers rows
- 'How much of the week each driver worked': a histogram of days worked 1–7, with the columns under the gate shown as set apart (outline) — *source:* rows[].days_worked
- Completion against bookings as a scatter, drawn only from 30 accepted (the show_at gate) — *source:* rows[].completion_pct, bookings; gate from /api/performance/fleet rate_gates
- 'Which channels the week's work came from': drivers per platform, with the multi-channel overlap stated — *source:* rows[].platforms
- Tile: the bottom quarter's share of the week's bookings against the 25% an even fleet would run — *source:* rows[].bookings

**Keep**

- Everything kept on #top-performers
- The warning note, which moves into the absence band word for word
- The live gate (at least 4 days AND at least 15 bookings)

**Leave structurally untouched (restyle only)**

- The same operational parts as #top-performers

**Not adopted from the mockup**

- The money-absence and hours claims: false, for the same measurements as on #top-performers
- The mockup's days-only gate ('out on 4 days or more'): the live gate also requires 15 bookings

*Tests that pin this page:* test/performer_week.test.mjs, test/pinned_identity.test.mjs, test/interlinking.test.mjs, test/completeness.test.mjs

#### `performance` — effort M

*Today:* Week grain. Tabs By week / By month. Verdict '1 driver of 116 did something different this week'. 6 tiles (Active drivers 116 · Jobs done 5,192 · Trip value AED 331,057 · Jobs a day 7.2 · Changed 1 of 107 · The bar 3.5σ). Period chips. 'Who is doing something different': an up table and a down table (Jobs, Expected, Difference ▲/▼, Because split into days and pace, How unusual σ). 'Ranked on jobs done': 116 rows (rank in .rk, Jobs, Jobs a day, On value, vs usual). 'Ranked on trip value': 113 rows. gapBars of the median driver's jobs per week; clicking a bar ranks that period. 'How to read this': 6 bullets.

**Change**

- Order: grain tabs and chips in the chrome → 00 tiles (the hero is Changed N of M tested, the page's distinctive question) → 01 scatter → 02 movers (tables plus split mark) → 03 jobs and value tables side by side as now → 04 fleet trend (the running period hatched per SPEC §5) plus the drivers chart → 05 absence band, which absorbs How to read this
- Difference and vs usual cells go from 'good'/'warn' amber with no minus sign to ▲ + positive / ▼ − negative through signed(). 'within range' stays grey
- The `?? 0` fallbacks on the tiles (drivers, jobs_median, intensity_median) and `median: p.jobs_median || 0` in the trend render a missing period as 0. They become absent with a reason

**Add (from the redesign, with its data source)**

- Hero scatter: one dot per driver, jobs across and trip value up, value_rankable drivers only. Channel colour for a single-platform driver, achromatic otherwise; only the extreme is labelled — *source:* /api/performance/fleet rows[].completed, value, platforms
- Tile deltas against the previous COMPLETE period, and sparklines, for drivers, jobs done, median trip value and median jobs — *source:* d.periods[]
- Mover mark: each mover's change split into more/fewer days vs pace on the days worked — *source:* movers[].split.days_part, rate_part
- Active drivers per period as its own small chart, not a second axis — *source:* periods[].drivers
- Absence band: drivers with no usual to compare, grouped by reason; accepted − completed − dropped; completion rates shown only from 30 accepted — *source:* rows[].no_verdict, summary.accepted/completed, rows[].dropped, rows[].rates, rate_gates

**Keep**

- Both full ranking tables, each carrying the other ranking's position and vs usual
- The mover tables, including the Because split
- Grain tabs, period chips and click-to-rank on the trend
- The server's threshold sentence (movement.why)
- The substance of How to read this, including 'trip value is gross'

**Leave structurally untouched (restyle only)**

- The two ranking tables and their column set, the chips and tabs, the literal api() keys the warmer checks

**Not adopted from the mockup**

- 'What any of it was worth — None; every payout period null': false. Money is on /api/economics/drivers and #revenue; live says trip value is gross and points there
- The 'One number per driver — Deliberately not computed' tile: a tile with no figure. The rule stays in the band
- The Top-14 bars for jobs and for value (02/03): the full tables already show those rows with both positions, so the bars add no data

*Tests that pin this page:* test/warm.test.mjs, test/pinned_identity.test.mjs, test/interlinking.test.mjs, test/completeness.test.mjs, test/signed.test.mjs, test/performance_record.test.mjs, test/nav_sections.test.mjs

#### `performance/month` — effort S

*Today:* The same view at grain=month: month chips, and the trend by month.

**Change**

- Same plan as #performance. The running month is hatched and never carries a delta

**Add (from the redesign, with its data source)**

- Deltas against the previous complete month, and sparklines — *source:* d.periods[] at grain=month

**Keep**

- Everything kept on #performance

**Leave structurally untouched (restyle only)**

- The month chips and click-to-rank

*Tests that pin this page:* test/warm.test.mjs

#### `retention` — effort M

*Today:* Verdict '170 drivers active — +16 on the month before'; its sub-line prints the raw ISO '2026-08'. 5 tiles (Earning in Aug 2026 170, +16 · Stopped 20 → cohort · Started 8 → cohort · Recruits still working 132 of 324 · Typical run 8 months, with 170 still working 14 months in, 416 people). A flow note. A diverging chart of new and returning up, stopped down, with a headcount line on its own scale, plus a 21-row flow table. A cohort heat grid (21 cohorts × 13 offsets, blue fill). The Stopped-in-Aug table (20 rows, lifetime bookings desc) and the Started table. A tenure note. Covers every channel: 416 people.

**Change**

- Split flowChart. The dashed headcount line on its own scale is a dual axis, which SPEC §4 forbids. 01 becomes headcount; 02 becomes arrivals (new and returning as an achromatic pair) above the line and departures below, on one shared count axis. No semantic or categorical area fills (it currently uses --s1/--s4/--s2)
- Cohort grid fill goes from var(--b400), which is the Uber identity under SPEC, to the achromatic sequential ramp. The cells keep their exact %
- Flow table New/Stopped pills become '▲ +n' / '▼ −n' semantic text with no fills
- The verdict sub-line and meta use MONTH(), not the raw ISO month
- Order: 00 tiles (the hero is Earning in <month>) → 01 headcount → 02 arrivals and departures, with the flow table as its table twin, folded → 03 cohort grid → 04 Stopped / Started tables → 05 absence band (tenure note, excluded month, duplicates)

**Add (from the redesign, with its data source)**

- Headcount per month as its own mark, peak and low labelled — *source:* /api/retention flow[].active
- Tile sparklines, deltas against the previous month, and 'against the peak of N in <month>' — *source:* flow[]
- Absence-band item: leavers listed twice under one driver id (live: 1 id appears twice among 20) — *source:* stopped_last_month[].driver_ext_id
- Absence-band item: why anybody left — no feed carries a reason (the caveat text) — *source:* d.caveat

**Keep**

- The flow table, the cohort grid with its exact % and the 'roster at start' tag, the Stopped table (lifetime bookings desc, last vehicle) and the Started table
- The tile cohort links, excluding the first (left-censored) month from intake, excluding the current month
- The tenure split between leavers and people still working

**Leave structurally untouched (restyle only)**

- The Stopped table, ordered by lifetime bookings: it is the call list for leavers worth a phone call

**Not adopted from the mockup**

- 'Uber records only', 257 people, and the absence item 'Everyone but Uber': false. /api/retention covers every channel, 416 people
- Cohort small multiples limited to intakes of 12 or more (7 panels): less data than the 21-cohort grid
- '05 The fifteen who stopped' as lifetime-booking bars: fewer columns than the live table
- The figure 'People counted twice: 15 on 10 ids': stale. Compute it from live

*Tests that pin this page:* test/retention.test.mjs, test/cohorts.test.mjs, test/completeness.test.mjs, test/consistency.test.mjs, test/mockapi.test.mjs, test/edges.test.mjs, test/signed.test.mjs

#### `compliance` — effort M

*Today:* Verdict '88 drivers have a licence that have already expired', plus the unverifiable-records sentence. 8 tiles: Vehicle docs expired 0 · Expiring in 7 days 7 · in 45 days 23 · Drivers who cannot legally work 88 people (88 records) · Drivers expiring in 45 days 2 · Records disagree 2 · Licence dates that are a default 94 records · No licence date 197 records. Notes on person basis, the caveat, Emirates ID and licence number. 'Vehicle documents': 120 rows × 8, folded to 12. 'Driver licences, by person': 120 rows × 8 (Due, Driver with record count, Records and their documents, Records agree?, Vehicle, Phone, State, Still driving?), folded to 12, soonest first. Counts PEOPLE through the spine (265 people over 437 records).

**Change**

- 00 tiles: the hero is 'Drivers who cannot legally work' (people). The record-level tiles (default date 94, no date 197) move into the absence band as the size of what is missing
- The Due tags' red/amber/green fills: expired becomes negative text with the word 'expired' and a minus; due within 45 days is ink at weight 600; in date is grey
- State tags become ink text
- Order: 00 tiles → 01 expired × last drove → 02 records by channel → 03 checkable dates → 04 Driver licences table (unchanged) → 05 papers by month → 06 Vehicle documents table (unchanged) → 07 absence band (the person-basis, caveat and withheld-number notes)

**Add (from the redesign, with its data source)**

- Hero mark 'Expired, and when each last drove': the expired people by last booking — this week / 30 days / 90 days / older / never / not observed — *source:* /api/compliance/drivers people[].last_ever, lifetime_trips. Use last_ever, NOT days_since_last_trip, until the server bug below is fixed
- Licence records by channel and state, with an outline for undated or placeholder (live: Uber 159 undated, Yango 146 dated, Hotel 94 placeholder + 38 undated) — *source:* people[].accounts[].platform, licence_expires, licence_placeholder
- Checkable licence dates, past and future — *source:* people[].days_left where licence_status is not unknown
- Vehicle papers by the month they run out, the current month hatched — *source:* /api/compliance/vehicles rows[].expires_at
- What each channel files (expiry, licence number, Emirates ID) — *source:* emirates_id_by_platform plus accounts[]
- Absence band: Bolt files no compliance record; only one document type is filed (Vehicle Registration Form), so there is no insurance, permit or test; plates with no document on file — *source:* account platforms, vehPage.doc_types, and /api/vehicles/directory count minus totals.vehicles (130) — one extra fetch

**Keep**

- Driver figures counted in people, with records in the sub-lines
- Both tables with every column, sort and fold
- The withheld / not filled in / placeholder / no-date distinctions
- custodyAsOf and the stale tag
- The Records agree? conflicts column
- The data-panel and data-kpi handles

**Leave structurally untouched (restyle only)**

- Both tables: operators renew and stand down from them. The people basis stays

**Not adopted from the mockup**

- Headline figures counted in records (435 records, '290 nobody can check', 88 as records). Live counts 265 people through the spine, and compliance_person.test.mjs pins it
- 'All 88 still marked working': State is the channel's own word. The live Still driving? column is the evidence
- The 'No earlier snapshot is stored' tile subtitles

*Tests that pin this page:* test/compliance_person.test.mjs, test/kpi_one_tile.test.mjs, test/hotel_licence_date.test.mjs, test/server_redaction.test.mjs, test/redact.test.mjs, test/interlinking.test.mjs, test/completeness.test.mjs, test/nav_sections.test.mjs

#### `identity` — effort M

*Today:* Tiles: Records joined 433 ('424 of them could not have been joined by name') · In every total 155 of 433 · Accounts carrying a phone 433 of 810 · Accounts it cannot see 377. A table of 433 pairs × 7 (The person, Joined by 'phone ···tail', Evidence, Could the names have done it?, Folds the totals too, Checked by a person, Open), shown as one long table. reach_note and applies_note. DEFECT: the page ignores `basis`. 365 of the 433 links are name-based (similar_name 247, same_name 93, shared_car_name 25), yet every one of them prints 'phone ···' with an empty tail and 'No' under 'Could the names have done it?'.

**Change**

- Correctness first: 'Could the names have done it?' reads Yes for name-basis links (the name is the evidence) and keeps the /changes nothing/ logic only for phone links. The Records joined sub-line and the panel subtitle stop describing every link as phone-proved
- Table: foldRows(12) with 'show all 433', columns unchanged apart from the Basis fix. Tags become ink chips
- Order: 00 tiles (the hero is Records joined) → 01 basis × promoted bar → 02 channel pairs (channel identity at each end, direct labels) → 03 first found → 04 pair table → 05 Overruled → 06 absence band (reach, applies, anonymous confirmations)

**Add (from the redesign, with its data source)**

- Split by basis: tiles for shared phone 68 / name 340 (similar 247, identical 93) / same car + name 25; a Basis column; 'Joined by' shows ···tail only for shared_phone — *source:* /api/drivers/identity-links links[].basis
- Channel pairs each link joins (hotel–uber 106, bolt–uber 101, bolt–hotel 87, hotel–yango 48, uber–yango 37, bolt–bolt 36, bolt–yango 18) — *source:* links[].canonical_platform, alias_platform
- When each link was first found, split into promoted vs pages only — *source:* links[].first_seen_at, promoted
- Absence-band item: 'A name on any confirmation — none': 365 links carry confirmed_at and 0 carry confirmed_by — *source:* links[].confirmed_at, confirmed_by

**Keep**

- The pair rows, the Evidence text, Folds the totals too, Checked by a person, the Open link
- The Overruled table
- The reach and applies notes, and the links to the directory and compliance

**Leave structurally untouched (restyle only)**

- The pair table and the Overruled table: they are the audit trail of every merge

**Not adopted from the mockup**

- The two-basis model (phone 66 / name 111): stale. The live API has four bases
- The delta chips '▲ +112 since 7 September' and '▲ +68 more than on 7 Sep': no snapshot is stored, and deriving them from first_seen_at leaves out links rejected since, so they are not measured past counts
- '05 Records each channel brought': duplicates 02
- '06 How far a shared phone can see': two numbers the tiles already carry

**Review corrections (adopted — they override the lines above)**

- *Data source corrected:* identity basis split: the plan lists four bases, but identity_links.js:87 also folds 'shared_email'. Include it.

*Tests that pin this page:* test/identity_link.test.mjs, test/cache.test.mjs, test/interlinking.test.mjs, test/completeness.test.mjs, test/nav_sections.test.mjs

#### `same-person` — effort S

*Today:* The operator's review queue. Tiles: Waiting for you 0 · Confirmed one person 365 · Ruled two people 0. The why note and the refuted note. 'Waiting for an answer' holds pair cards (two symmetric sides with trips, first/last, plates; the evidence; the plate note; the phone tail), each with 'Yes — one person' / 'No — two people' buttons and a hint. 'Already answered' holds 365 cards, each with 'Put back in the queue'. The page is 111,110px tall at 1440. Every decided row has decided_by = null.

**Change**

- Fold 'Already answered' to the 12 most recent, with 'show all 365' and a same/different filter. The card markup is unchanged. The pending queue always shows in full, first
- Order: 00 tiles (the hero is Waiting for you) → 01 Waiting → 02 Already answered (folded) → 03 channel pairs and trips folded → 04 absence band (why, refuted, anonymous verdicts)
- Verdict states shown as text, not as tinted card backgrounds

**Add (from the redesign, with its data source)**

- Absence-band item: 365 of 365 verdicts carry no reviewer (decided_by null — the page never sends one) — *source:* /api/same-person decided[].decided_by
- Tile: lifetime trips folded by 'same' verdicts — *source:* decided[].alias.trips + canonical.trips
- Channel pairs of the decided pairs — *source:* decided[].canonical.platform, alias.platform
- 'How much of the name matched' (the 3-of-4 share) — *source:* needs a structured parts_matched/parts_total field on /api/same-person; today it exists only inside the evidence prose — **needs a new endpoint**
- Recording who decided — *source:* needs decided_by sent with the POST, and a reviewer identity the product does not have (no sign-in). Operator decision — **needs a new endpoint**

**Keep**

- The pair card, with both sides at equal weight
- The Yes / No buttons, their wording and the hint
- Put back in the queue
- POST /api/same-person/decide followed by a redraw

**Leave structurally untouched (restyle only)**

- The pair cards and all three actions: this is the review workflow

**Not adopted from the mockup**

- Removing the pair cards and the Yes / No / Put back actions: the mockup has none
- 'Done in 38 minutes' and 'every verdict by the minute': /api/same-person has proposed_at and no decided time, and the reviewer's pace is not the question a reviewer needs answered
- The delta chip '▲ +111 from none a day earlier': no snapshot is stored

*Tests that pin this page:* test/identity_proposals.test.mjs, test/identity_queue_persists.test.mjs, test/fold_on_confirm.test.mjs, test/identity_shared_car.test.mjs, test/api_refusals.test.mjs, test/cache.test.mjs, test/endpoint_coverage.test.mjs

### Fleet and Sources

#### `#vehicles` — effort L

*Today:* Rendered 1 to 23 Sep through the mirror. Verdict: '3 vehicles moved with nothing paying for it', with a recommendation and a WHO EXACTLY link. Search box. 11 tiles with cohort links: Vehicles 273, Cars by VIN 138, Confirmed by two channels 46, Two channels disagree 41, Took a booking 103, Moved no booking 3, Did not move 167, Tracked 267, Tracker gone quiet 191, Documents due 15. Idle hours between drivers: top-12 bars plus a change-over table folded to 8 of 31, with 3 caveat captions. Every vehicle: 19 columns, sortable, Bookings descending by default, folded to 12 of 273, rows open #vehicle. Fleet spread: top-14 bars by trips, clickable. Which assets serve which tier: plate x tier pivot, top 30, with a premium-concentration sentence.

**Change**

- Merge the verdict figure (3) and the 'Moved, no booking' tile into one hero tile. The verdict sentence and recommendation become the band caption, so the figure no longer appears twice
- 00 At a glance, 6 tiles: Moved no booking (hero, the page's one highlight) · Money the cars brought in · A kilometre returns · Took a booking · Did not move · Tracker gone quiet
- A second tile row, 'The register': Vehicles · Cars by VIN · Confirmed by two channels · Two channels disagree · Tracked · Documents due
- Section order: 00 → 01 Money vs distance → 02 AED/km lowest → Idle hours between drivers → Every vehicle → Fleet spread → Tier pivot → 03 Booked vs tracked → absence band
- Bars (idle hours, fleet spread) turn ink or sequential, because a vehicle is not a channel
- Tile tones: amber 'warn' becomes neutral ink. Negative colour stays only where the figure has a direction, and always with its glyph and sign
- Tables restyled: hairline rules, no zebra, tabular-nums in numeric columns. Tracker and document chips become outline chips; EXPIRED keeps negative text
- Money becomes exact per SPEC §4 (cross-cutting money() decision)

**Add (from the redesign, with its data source)**

- Tile 'Money the cars brought in': sum of each plate's chosen payout, exact, with earning-car count and median. Gross fares on fare-basis channels appear beside it, never added (vehicle_payout_basis rule) — *source:* /api/vehicles/directory payout, revenue, payout_platforms, fares_platforms
- Tile 'A kilometre returns': fleet AED/km over booked km — *source:* /api/vehicles/directory payout and km (sum over sum)
- §01 Money against distance: one dot per car, payout vs booked km. Fare-basis-only cars go in their own panel in their own unit — *source:* /api/vehicles/directory payout, revenue, km
- §02 What a kilometre returned: the 12 lowest-earning cars by AED/km, above a stated km floor, click opens the vehicle. The lowest car is named in the caption — *source:* /api/vehicles/directory
- §03 Booked vs tracked distance scatter with a 1:1 reference line. Today this is only a per-row '+38%' in the table — *source:* /api/vehicles/directory km, telematics_km
- Absence band: what a car costs (no lease, fuel, insurance or Salik feed, so no figure); plates that never moved (167 of 273, because this is a tracker roster, not the fleet); which distance is right (the booked vs tracked gap in km) — *source:* directory + existing tiles

**Keep**

- The verdict claim and recommendation, and every WHO EXACTLY cohort link on the tiles
- All 11 tile figures, including the 4 VIN-identity tiles
- Every vehicle table: search, all 19 columns in their order, Bookings-descending default, fold, plate link to #vehicle
- Idle hours between drivers: the bars, the table, 'Show the other N cars', and the 3 captions (stint rule, gaps of a day or more excluded, custody records with no drop-off time)
- Fleet spread bars with click-through
- The tier pivot, its absent-column reasons and the premium-concentration sentence
- The '20 bookings carry no vehicle' caption

**Leave structurally untouched (restyle only)**

- Every vehicle table (search, sort, fold, 19 columns, row links). It is the fleet lookup list
- The Idle hours change-over table and its fold. It is an actionable handover list
- The cohort drill-downs on the tiles

**Not adopted from the mockup**

- 'How the money is spread' histogram: the §01 scatter already shows the distribution, and the histogram supports no decision
- 'The cars that brought in the most' ranked bars: the Every vehicle table sorted on Payout answers this with 19 columns
- 'Which channels the working cars file on' bars: becomes one caption line under §01
- The mockup's money hero as THE hero: the page's operational question is cars moving with nothing paying, so money is tile 2
- Its figures (17 Aug to 15 Sep) are another window's numbers: illustrative only

*Tests that pin this page:* test/vehicle_identity.test.mjs, test/vehicle_directory.test.mjs, test/vehicle_payout_basis.test.mjs, test/cohorts.test.mjs, test/kpi_one_tile.test.mjs, test/interlinking.test.mjs, test/routes.test.mjs, test/auth_banner_pending_ui.test.mjs

#### `#vehicle/overview` — effort L

*Today:* Identity card: plate, make/model, fleet/tracker/document pills, 'Last held by … as of', colour, VIN, Charge (absent with a reason), last fix, and an in-this-window sentence (trips, days, drivers, telematics journeys). Tab bar with 7 tabs. 10 tiles: Bookings 221, Distance 3,146 km, Money in AED 9,748, Fares AED 236, Utilisation '—', Idle days 1, Drivers 3, Completion 92.8%, Harsh events 3,827, Last fix. Trips and idle days: bookings bars with fixes overlaid on the same axis, today hollow. Who has driven it bars (click opens the driver). 3 donuts: Service type, Platform, Payment. Revenue by day area chart. Built-from footer.

**Change**

- 00 band: Money in (hero, exact AED, the one highlight) · Bookings · Distance · Money per km with delta · Harsh events per 100 km · Utilisation. Second row: Fares · Idle days · Completion
- Utilisation renders ABSENT WITH THE TRUE REASON ('utilisation, hours online, hours on trip, earnings per hour and trips per online hour are all null for this vehicle'). Today it shows '—' over a caption that describes the metric, not why it is missing
- Drop the Drivers and Last fix tiles only because the identity card already prints both ('3 drivers', 'Last fix 14:36'). Move '7,659 fixes in range' into the identity line
- DEFECT, owner ruling needed: the Fares tile shows accounted_fares (AED 236) under a caption of 'over 205 of 221 bookings … AED 4.52 per km', which is the basis of k.revenue (AED 13,995.70). The Earnings tab prints 'Measured fares AED 13,996' for the same window. Proposal: show k.revenue with that caption
- §01 hero chart 'What it earned, day by day': the Revenue by day area becomes columns, with a gap on no-booking days, today hatched, and labels on the best day and the last day only
- 'Trips and idle days' splits in two: bookings per day (idle days drawn as outlines) and §02 fixes per day. Today about 400 fixes share the axis with 11 bookings and flatten them to the baseline
- The 3 donuts become §04 'What it did, by channel': bookings and fares per channel as channel-identity bars, with FMS journeys named in the caption rather than counted. Service type and Payment become 100% bars over bookings only, because the 'unknown 263' slice in both is FMS journeys, not a service or a payment
- Order: identity → tabs → 00 → 01 → 02 → 03 who held it | 04 by channel → 05 verdicts | 06 by hour → 07 by kind | 08 by person → absence band

**Add (from the redesign, with its data source)**

- Money per km tile with a delta vs the fleet rate (▲/▼, sign, semantic) — *source:* /api/vehicle/kpis revenue_per_km vs /api/kpis revenue_per_km
- §02 'What the tracker saw': fixes per day as its own chart — *source:* /api/vehicle/daily fixes
- §02 split into fixes with and without a coordinate (mockup) — *source:* needs a per-day no-position fix count on /api/vehicle/daily. /api/track returns only positioned fixes — **needs a new endpoint**
- §06 When it works: bookings by hour of the Dubai day. This is already fetched and never drawn — *source:* /api/vehicle/mix hours
- §05 Where its journeys stand: seat-occupancy journeys by verdict, with km and minutes — *source:* /api/vehicle/movement by_verdict (a new fetch on this tab)
- §07 Harsh driving by kind, and §08 by person per 100 km, each linking to the Safety tab — *source:* /api/vehicle/safety by_type, by_driver (a new fetch)
- Who held it: each person's fares, days and trips beside the bar — *source:* /api/vehicle/drivers-detail totals
- Absence band: utilisation (all 5 utilisation fields null); a channel statement for this car (accounted_statements null); journeys cut off at the telemetry edge (partial of total); whether N drivers are N people (identity register) — *source:* /api/vehicle/kpis, /api/vehicle/movement

**Keep**

- The whole identity card, including 'as of' custody, Charge 'not reported' with its reason, and first_trip kept inside the window sentence
- The 7-tab bar and its #vehicle/<plate>/<tab> addresses
- The Money in tile (fares on fare-basis channels plus attributed payout, never both for one channel). It is the reconciled figure
- Completion and Idle days tiles with their reasons
- Who has driven it with click-through to the driver
- The Service type and Payment breakdowns (the mockup drops them)
- Today's-bar caption and the idle-day caption

**Leave structurally untouched (restyle only)**

- Tab bar and routes
- Driver click-throughs from the chart

**Not adopted from the mockup**

- Hero 'Fares AED 13,995.70': that is gross booked fare value, including Uber gross the fleet never receives. Money in (AED 9,747.56) is the reconciled figure
- Distance on priced_km (3,086): keep the live km over all measured bookings (3,146) as the single basis
- The with/without-coordinate poll split: no endpoint carries it today. Draw the total and say why the split is missing

**Review corrections (adopted — they override the lines above)**

- *Correction adopted:* instead of “Dropping the Drivers and Last fix tiles 'because the identity card prints both'”: Move the platform count and 'Nh ago' into the identity line. (The card does not carry the tile's 'across N platforms' (k.platforms, vehicle.js:172). It also prints only an absolute timestamp, so the hours-since-fix figure and its freshness judgement (vehicle.js:211) would be lost.)

*Tests that pin this page:* test/kpi_one_tile.test.mjs, test/interlinking.test.mjs, test/routes.test.mjs, test/cohorts.test.mjs, test/assets.test.mjs, test/unauthorized_attribution_page.test.mjs, test/device_fault.test.mjs

#### `#vehicle/drivers` — effort S

*Today:* 'Who has held this car' totals table (driver, accounts, days, as primary, trips, km, fares, held), sortable by trips. 'Who held it, day by day': 120-row custody table (day, driver, platform, trips, km, first, last, primary).

**Change**

- Restyle through the shared table CSS only: hairline rules, tabular-nums
- Platform shown as a channel swatch plus plain-ink text (never coloured text)
- Fares exact per SPEC §4

**Keep**

- Both tables, every column, the trips-descending default sort, driver links

**Leave structurally untouched (restyle only)**

- Both custody tables. They are how an operator reconstructs who had the car on a given day

*Tests that pin this page:* test/routes.test.mjs, test/interlinking.test.mjs

#### `#vehicle/movement` — effort S

*Today:* Day picker (days with stored fixes), Leaflet map with straight lines that break at gaps, 4 day tiles (fixes with a position, distance between fixes, with passenger, driver), movement matched to a booking (bars by verdict, whole window), Where it parks table, Movement periods table, Most recent fixes table.

**Change**

- Restyle only. Verdict bars go neutral ink (verdicts are not channels). Map lines use the feed's channel identity: occupied = identity, running empty = that channel's 'idle' ramp step; never green or red
- DEFECT, owner ruling needed: 'Distance 2,267 km between consecutive fixes' for L45243 on 23 Sep is impossible for one car-day. The sum draws straight lines across two interleaved device streams. Not a restyle item

**Keep**

- Map, day picker and ?day= address, the 4 tiles, the verdict bars, and all 3 tables

**Leave structurally untouched (restyle only)**

- The whole tab. It is the per-car replay operators use

*Tests that pin this page:* test/routes.test.mjs, test/assets.test.mjs, test/vehicle_routes.test.mjs

#### `#vehicle/earnings` — effort S

*Today:* Tiles: Measured fares AED 13,996 on 205 of 221; Fare coverage 93%; Drivers paid 2. An explanatory caption. By channel table (bookings, measured fares, attributed pay, km). By driver table (attributed, trips in the payout period, days, basis, with a period absence note). Day by day as two separate charts (attributed-pay area, measured-fares columns).

**Change**

- Exact money (AED 13,995.70, not 13,996)
- Channel rows get the 3px channel marker in the gutter
- The attributed area becomes a 10% wash with a 2px line; fares become ≤24px columns

**Keep**

- All tiles, both tables and both charts. They are already two charts, not a dual axis. Keep the payout-period caveat

**Leave structurally untouched (restyle only)**

- Both tables and their basis wording

*Tests that pin this page:* test/kpi_one_tile.test.mjs

#### `#vehicle/safety` — effort S

*Today:* Tiles: Per 100 km 121.6 (coverage stated), Worst type, Most events. Event types bars. 'Which driver was holding it' table (events, tracker faults, booked km, per 100 km, unattributed row explained). Events by day bars. Recent events table with location.

**Change**

- Event bars in FMS identity #9974F5 with direct labels (every event comes from the FMS/InfoTrack alert feed). Device faults in ink, kept apart from driving events
- Tables restyled

**Add (from the redesign, with its data source)**

- Per 100 km tile compared with the fleet rate (▲+ worse in negative, ▼− better in positive) — *source:* /api/kpis alerts_per_100km

**Keep**

- All tiles, both tables, the unattributed explanation and the booked-km rate basis

**Leave structurally untouched (restyle only)**

- Recent events and per-driver tables

*Tests that pin this page:* test/device_fault.test.mjs, test/kpi_one_tile.test.mjs

#### `#vehicle/compliance` — effort S

*Today:* Documents table (document, platform, status, expires, days left ascending). Specification key/value list (plate, make, model, year, colour, VIN, fleet, platform record, compliance). Photo absence note.

**Change**

- Restyle. Days-left chip: expired uses negative text; under 30 days uses an ink outline chip (amber is not a token)

**Keep**

- Both blocks, days-left sort, the photo absence note

**Leave structurally untouched (restyle only)**

- Documents table

*Tests that pin this page:* test/routes.test.mjs

#### `#vehicle/trips` — effort S

*Today:* Paged trip-records table across every platform, newest first (requested, driver, platform, from, to, km, product, status, fare), with load-more.

**Change**

- Restyle. Platform gets a swatch; fares exact; status tags become outline chips

**Keep**

- Paging, columns, newest-first order, trip links

**Leave structurally untouched (restyle only)**

- The table and its paging

*Tests that pin this page:* test/routes.test.mjs

#### `#unauthorized` — effort L

*Today:* Verdict: '94 journeys moved a car with no booking behind it', with partial and needs-a-human sentences. 9 tiles: Unexplained trips, Unexplained km, Revenue forgone (with its rate-basis sentence), Matched, Stationary, Seat-pad faults (0 stuck · 6 dead), Inconclusive 851, Could not be verified, Needs a human. Unexplained trips per day: unexplained solid over a pale bar of all intervals, today hollow; click opens #segments/day. What each flagged trip turned out to be: donut, click opens #segments/verdict. Vehicles with unexplained trips: top-12 bars, click opens #segments/plate. Flagged segments: 14-column table folded to 8, rows open #segment. Seat-sensor health table (100 of 138, with a server-cap caption).

**Change**

- The verdict figure merges into the hero tile; the claim sentence becomes the band caption
- 00 band: Unexplained trips (hero, spark) · Unexplained km · Revenue forgone (exact) · Mean a day · Inconclusive. Second row: Matched · Stationary · Seat-pad faults · Could not be verified · Needs a human
- §01 hero chart plots unexplained journeys per day on their own axis. The every-interval total (about 2,184) becomes a caption or a separate small chart; today it shares the axis and flattens the 94. Today hatched; days the sensor did not collect drawn as outlines
- Donut becomes 'What the matcher decided' ranked bars in neutral ink, keeping the click to #segments/verdict/<v>
- Vehicle bars go ink/sequential with km beside the count ('L12615 · 371 km'), click unchanged
- Verdict tags become outline chips; only 'unauthorized' keeps the negative token, as text and never as a fill

**Add (from the redesign, with its data source)**

- Tile 'Mean a day' with a delta vs the previous 7 days, inverted: down is better (▼ − in positive) — *source:* the daily series this page already fetches
- §04 Nearest booking, by channel, plus 'no booking at all on that plate' — *source:* /api/unauthorized/list nearest_platform, nearest_gap_min
- §05 When they happen: count by hour started, Dubai time — *source:* /api/unauthorized/list started_at
- §06 Where they start: top areas, plus a 'no named area' count — *source:* /api/unauthorized/list start_place.area
- §07 How long, how far: scatter of duration_min × distance_km — *source:* /api/unauthorized/list
- An attribution-rung + name column in Flagged segments, beside 'Driver that day'. That column is day-grain custody, which segments.js documents as naming two people on handover days — *source:* /api/unauthorized/attributed attribution_tier, attribution_candidates (a second fetch)
- Absence band: days the tracker filed nothing; journeys nobody could judge (inconclusive); journeys with no driver; why the car moved (nothing records a purpose) — *source:* existing payloads

**Keep**

- All 9 tile figures, including Seat-pad faults and Needs a human
- The three drill paths into #segments (day, verdict, plate)
- Flagged segments: all columns, fold, sort, row link to #segment
- The Seat-sensor health table and its cap caption
- The Revenue forgone rate-basis sentence ('revenue forgone, not a cash cost')

**Leave structurally untouched (restyle only)**

- The day/verdict/plate drill-downs into #segments
- Flagged segments table and fold
- Seat-sensor health table

**Not adopted from the mockup**

- Colouring these journeys as FMS/InfoTrack 'the feed these are cut from': seat-occupancy segments come from CABMAN, the only feed with a seat sensor (per #live and /api/segment's 'CABMAN fixes'). Use CABMAN identity or neutral, never FMS
- 'The ten longest' table: Flagged segments sorts on distance and carries more columns
- Its numbers (115 journeys, 17 Aug to 15 Sep) are another window's

*Tests that pin this page:* test/caption_matches_figure.test.mjs, test/segment_routes.test.mjs, test/audit_tools_detect.test.mjs, test/route_smoke.test.mjs, test/unauthorized_attribution_page.test.mjs

#### `#segments` — effort L

*Today:* Verdict: '63 of 94 carry one name, and 10 of those were narrowed by time'. 8 tiles: Unexplained journeys, Worth of the distance, Narrowed to one person (with a rung split), Cannot be narrowed, Segments in window, Unexplained, Matching this filter, Assessed blind. Seat-evidence window caption. 'Every occupancy interval' toggle. 'How firmly each journey is attributed': 6 rung chips that filter, plus 5 rung definition cards. 'Who the evidence names': per-person table with one column per rung, folded to 10 of 19. What we decided: donut, click filters. Vehicles bars. Recorded reasons table. By day calendar, clickable. Every unauthorized trip table, rows open #segment.

**Change**

- The verdict's figure moves into the band. 00 band: Journeys no booking explains (hero, spark) · Carried with no booking (km, exact) · Revenue forgone (exact) · Cannot be narrowed · People narrowed to. Second row: Segments in window · Matching this filter · Assessed blind · Narrowed to one person (rung split)
- The 5 definition cards become a compact definition list beside §01, same text. The chip row stays as the filter row above it
- Donut 'What we decided' becomes ranked bars, keeping click-to-filter
- Vehicles bars go ink with km
- Rungs are labelled in mono small caps, never colour-coded; tables restyled

**Add (from the redesign, with its data source)**

- §01 'Who the evidence can name': rung counts in ladder order. Filled bar = narrows to one person; outline = does not — *source:* /api/unauthorized/attributed distribution.by_tier
- §02 The same five rungs in kilometres — *source:* distribution.by_tier km
- §03 'Who is named, and how often': people ranked by journeys on the merge key, km beside, spelling count — *source:* rows attribution_candidate_keys / attribution_candidates
- Tile 'People the ladder narrowed to' (distinct merge keys) — *source:* rows attribution_candidate_keys
- §04 'What could corroborate a name': journeys before vs inside Uber's status-feed history — *source:* status_feed.history_from vs rows started_at
- §05 'How many cars can produce one at all': plates with a seat sensor (46) vs plates with at least one journey. The share of fleet stays absent because coverage.plates_held is null — *source:* coverage.plates_with_sensor, rows plate
- Absence band: whether any name here drove; who drove the N un-narrowed; share of the fleet (plates_held null); whether a multi-spelling key is one person — *source:* existing payload

**Keep**

- The rung chips as filters, and every #segments/<kind>/<value> address
- The rung definitions (server tier_means) and the INFERENCE wording
- The per-person table: one column per rung, never summed
- The verdict toggle, Recorded reasons, the By day calendar with click
- Every unauthorized trip table with fold and row link
- The Assessed blind tile and the seat-evidence window caption

**Leave structurally untouched (restyle only)**

- Filter chips and their addresses
- The per-person table
- Every unauthorized trip table and its row link
- The By day calendar click-through

**Not adopted from the mockup**

- §06 'The twelve longest' table: Every unauthorized trip sorted by km answers it
- The mockup's counts (95 journeys) are another capture's

*Tests that pin this page:* test/segment_routes.test.mjs, test/unauthorized_attribution_page.test.mjs, test/unauthorized_attribution.test.mjs, test/caption_matches_figure.test.mjs, test/segment_boundary.test.mjs, test/endpoint_coverage.test.mjs

#### `#segment` — effort M

*Today:* 5 tiles: Verdict, Duration, Distance (with peak speed), Revenue forgone (with rate basis), Observed (largest gap). A start/end place sentence. 'Who the evidence names': rung, name, status-feed note, INFERENCE warning. Links line (vehicle page, custody, the day, other segments). Why this verdict evidence table. Bookings on this vehicle ±4 h. Bookings by the driver who held the car ±90 min. Telemetry through the window: speed area chart plus a 20-row fixes table with lat/lng. Everything this vehicle did that day. Custody either side of this day. Channels that wrote rows that day, as chips.

**Change**

- 00 band: Carried with no booking (km, hero) · To the nearest booking · Revenue forgone · Who was driving · Telemetry through the window (fixes, observed, largest gap). Verdict and Duration move to the band's meta line with their values unchanged
- The telemetry speed area becomes a 2px line with markers, plus a tick strip below for fixes with no seat reading (no speed invented for them). The fixes table stays below as the detail layer
- Channels-that-day chips become ranked bars in channel identity with direct labels

**Add (from the redesign, with its data source)**

- Tile 'To the nearest booking': gap in minutes, platform, when it ended, channels checked — *source:* /api/segment segment.nearest_gap_min, nearest_platform, channels_checked
- Tile 'Who was driving': 'Nobody is recorded' as an absence, kept separate from the inferred name — *source:* segment.drivers/driver_refs null vs the attribution rung
- §01 Day timeline: a bookings lane (every channel) above an occupancy lane (this and the same-day intervals, partial ones hatched) — *source:* segment, same_day_segments, nearby_vehicle_trips
- §03 'What the fixes are': fixes with a seat reading vs none, plus the largest km-in-minutes jump between consecutive fixes — *source:* /api/segment track seat_occupied, lat/lng, captured_at
- 'Which box wrote each fix' — *source:* needs `source` on /api/segment track rows (/api/track already returns it) — **needs a new endpoint**
- Name the second valuation. /api/segment values this journey at the calendar-month fleet rate (live: AED 661 at 4.53/km); the list it opens from uses /api/unauthorized/attributed at the window rate (4.52/km). The mockup shows AED 258.21 vs 257.64 for one journey — *source:* /api/segment value + /api/unauthorized/attributed forgone_aed (a second fetch), or unify the rate server-side (owner ruling)
- Absence band: who was in the car; where it ended (end_place null, so show the coordinate rather than a guessed area); what it was worth (two valuations); which box wrote each fix — *source:* existing payload

**Keep**

- Every evidence table: Why this verdict, ±4 h vehicle bookings, ±90 min driver bookings, same-day segments, custody
- The rung, the name and the INFERENCE wording
- The links line
- The fixes table with lat/lng
- The place sentence (named by N trips)

**Leave structurally untouched (restyle only)**

- The evidence tables. They are what makes an accusation checkable

**Not adopted from the mockup**

- §04 custody small multiples: the custody table below already carries day, driver, platform and trips; the chart adds no data

*Tests that pin this page:* test/segment_routes.test.mjs, test/segment_boundary.test.mjs, test/unauthorized_attribution_page.test.mjs, test/caption_matches_figure.test.mjs

#### `#safety/people` — effort M

*Today:* Tab bar: By driver / By vehicle / By event type. Shared verdict: 'Sharp Turn is 68% of every event', figure 552 events per tracked vehicle. Shared tiles: Driving events 141,987; Device faults 5,297; Vehicles involved 75 of 267 (cohort link); Drivers named 76 (cohort link); Events nobody held the car for 4,942. Platform-filter note when a channel is chosen. 'Who drives hardest': top-12 bars by per-100-km rate with a 200 km floor, km beside each, click opens driver/quality. 'Every driver with an event — N rows' table, default sort driving_alerts.

**Change**

- 00 band, shared by all 3 tabs: Worst rate (hero) · Fleet rate · Driving events · Device faults · Vehicles involved · Drivers named. 'Events nobody held the car for' moves to the band caption with its figure, and the verdict sentence stays as that caption. '552 per tracked vehicle' stays as meta
- Bars in FMS identity #9974F5 with direct labels (every event is from the FMS/InfoTrack alert feed)
- Table restyled; the device-fault column stays ink

**Add (from the redesign, with its data source)**

- Hero tile 'Worst rate on the road': top rated driver's per-100-km rate with its delta vs the fleet rate (▲ + negative = worse) — *source:* /api/alerts/by-driver per_100km + /api/kpis alerts_per_100km
- Tile 'Fleet events per 100 km' (plus the median driver in the caption) — *source:* /api/kpis alerts_per_100km; median from by-driver rows
- A fleet-rate reference rule on the 'Who drives hardest' bars — *source:* /api/kpis alerts_per_100km
- §02 'The shape of the rated drivers': histogram of per-100-km rates — *source:* /api/alerts/by-driver rows
- §03 'Why the rank has a floor': rate vs km scatter with the 200 km fence drawn — *source:* /api/alerts/by-driver alert_km, per_100km
- Absence band: what counts as harsh (no threshold held); events nobody could place; drivers who cannot be rated (under the floor, or no distance); what actually happened (no outcome feed) — *source:* existing payloads

**Keep**

- The 3 tabs and their addresses
- The verdict claim
- All 6 shared figures and both cohort links
- The platform-does-not-apply note
- The 200 km floor and its caption
- The rate bars with km beside, click to the driver
- The driver table, its heading counts and 'Showing 100 of N' caption (safety_cap), and the driving_alerts default sort (device_fault)

**Leave structurally untouched (restyle only)**

- The tab split
- The driver table and its default sort
- Click-through to driver quality pages

**Not adopted from the mockup**

- Merging the 3 tabs into one long page: the tabs are the operators' entry points and are tested
- Drawing bars as 'excess over the fleet rate': keep the rate itself and add the fleet reference rule. The figure printed is the rate either way
- The 500 km fence: keep the live 200 km floor, which its caption and computation are built on. Changing it is an owner call, not a restyle

*Tests that pin this page:* test/safety_cap.test.mjs, test/device_fault.test.mjs, test/kpi_one_tile.test.mjs, test/cohorts.test.mjs

#### `#safety/vehicles` — effort M

*Today:* Shared band. 'Worst vehicles' top-12 bars by raw event count; click opens #vehicle/<plate>/safety. 'Every vehicle with an event — N vehicles' table (per-type counts, drivers, top driver).

**Change**

- Worst-vehicles bars in FMS identity with labels
- Table restyled

**Add (from the redesign, with its data source)**

- §05 'Above the fleet rate, car by car': per-plate events per 100 km vs the fleet rate — *source:* /api/vehicles/directory alerts_per_100km, alert_km (a second fetch) + /api/kpis alerts_per_100km
- §06 'The noisiest cars, split': driving events vs tracker faults as stacked columns, faults in ink — *source:* /api/alerts/by-vehicle harsh_*/sharp_turn/overspeed vs 'other'; confirm 'other' equals device faults before labelling it so (L86970 other=1,315), or use directory device_alerts

**Keep**

- Worst vehicles bars with click to the vehicle's Safety tab
- The full vehicle table

**Leave structurally untouched (restyle only)**

- The vehicle table and its click-through

*Tests that pin this page:* test/device_fault.test.mjs, test/cohorts.test.mjs

#### `#safety/events` — effort S

*Today:* Shared band. 'Driving events' donut (Sharp Turn, Harsh Brake, Harsh Acceleration, OverSpeed). 'Device faults' donut, kept separate (a hardware ticket, not coaching).

**Change**

- The 2 donuts become one '§04 The kinds of alert' ranked-bar list. Driving kinds in FMS identity; device faults in ink with a 'fault in the tracker box' legend. Share of total goes in the caption

**Keep**

- The separation of driving events from device faults
- Every type and count

*Tests that pin this page:* test/device_fault.test.mjs

#### `#live` — effort M

*Today:* Verdict: '179 vehicles have a stale fix', with a per-feed split and a recommendation. 5 tiles: Vehicles tracked 241, Fresh <30 min 88, Silent over a day 94 (quietest N days ago), Moving 50, Engaged 28 of 172. 'Live vehicles' table: plate, driver (as-of), fleet, feed, status, speed, odometer, A/C, seat, fix age, last fix, last polled, on the map. Sortable, default fix age ascending, folded to 12 of 267, rows open #vehicle/<plate>/movement, with a route link. Charge absence caption.

**Change**

- 00 band: Not reporting (hero, the verdict figure, of N) · Fresh <30 min · Silent over a day · Moving · Engaged of N with a seat sensor. 'Vehicles tracked 241' goes into the caption
- The Live vehicles table stays directly under the band. §01 to §04 go BELOW it, so the operational table does not move down the page
- Status and seat chips become outline chips; the fix-age chip is ink (not an amber tone)

**Add (from the redesign, with its data source)**

- §01 'How old the newest fix is': fix-age bands stacked by feed (CABMAN / Uber / FMS identities) — *source:* /api/live fix_age_min, source (same payload, no new fetch)
- §02 'Every tracked car, by feed and freshness': 9 bars (feed × reporting now / late today / silent over a day) — *source:* /api/live
- §03 'What a live row carries': share of rows per feed with coordinate, speed, odometer, seat, named driver, A/C, fuel — *source:* /api/live field non-null counts
- §04 'What the live cars say they are doing': status counts, one small panel per feed (one channel's ramp per plot) — *source:* /api/live status by source
- Absence band: silent cars still drawn on a map with a stale dot; fuel in the tank (no feed fills it); cars with no coordinate (Uber app feed); passenger on board (CABMAN only) — *source:* /api/live

**Keep**

- The verdict and recommendation
- All 5 tiles
- The Live vehicles table: every column, fix-age-ascending default, fold, row click to movement, route link
- The Charge absence caption and the per-feed cadence caption

**Leave structurally untouched (restyle only)**

- The Live vehicles table: position, sort, fold, row click. It is live tracking

**Not adopted from the mockup**

- Dropping the table: the mockup has no per-vehicle list, which is the page's operational core
- The per-feed 'dark ▲+23.1 pp vs fleet' chips: they colour a feed's polling design (CABMAN every 5 min vs FMS vs the Uber app) as good or bad news, which it is not

*Tests that pin this page:* test/live_fix.test.mjs, test/phone_clock.test.mjs, test/spacing.test.mjs, test/swr.test.mjs, test/nav_sections.test.mjs

#### `#map` — effort S

*Today:* Mode toggle (Live fleet / Day replay). Live mode: 4 tiles (On the map 249 of 267 reporting, with an 18-with-no-satellite-lock note; Engaged 29 of 173; Moving 62; Stale 168), a 560px Leaflet map with markers (click one to replay that car), a legend (passenger aboard, moving empty, stopped, moving with no seat sensor, stale), a 0,0-trackers note, and a permalink sentence.

**Change**

- Restyle only. Marker colours come from feed identity, with the occupancy state as that channel's ramp; stale = outline marker (absence), never red. Buttons and tiles take the Arkiv tokens

**Keep**

- Toggle, map, markers and marker-click replay, the 4 tiles, the legend, the no-lock note, and the permalink/replaceState behaviour

**Leave structurally untouched (restyle only)**

- The whole live mode. It is the operators' live map

*Tests that pin this page:* test/routes.test.mjs, test/assets.test.mjs, test/spacing.test.mjs, test/nav_sections.test.mjs, test/window.test.mjs

#### `#map/replay` — effort M

*Today:* Plate picker, day picker built from /api/map/days (days that have a trail, with the day's custodian), Show route. 4 tiles: Fixes; Distance between fixes; With passenger ('not measured' when the feed has no seat sensor); Driver (linked). Journey on the map; legend; a 'link to this replay' + vehicle movement link.

**Change**

- The new marks go BELOW the map, and only in replay mode. Controls, tiles and map keep their position
- DEFECT, owner ruling needed: /api/map/journey for L45243 on 2026-09-22 returns distance_km 5,361.7 (moving_km 2,755.9) for one car-day. Straight lines are summed across interleaved device streams. The Distance tile should not ship restyled with this number unqualified

**Add (from the redesign, with its data source)**

- §02 'When it was reporting': midnight-to-midnight strip of fix times, with gaps longer than N min drawn as blanks — *source:* /api/map/journey segments[].points t
- §03 'How long between one fix and the next' histogram, with unbridged gaps counted — *source:* journey points t
- §04 'What each fix said it was doing': status counts in that feed's ramp — *source:* journey points status
- §05 fixes per day and §08 top speed per day for this plate, with today hatched — *source:* /api/map/days?plate= (fixes, max_speed). The unfiltered list is capped at 400 rows (truncated), so pass the plate
- §06 bookings the driver filed on the same days — *source:* /api/map/days?plate= driver_trips
- §07 'How fast it was going' speed histogram (moving fixes only) — *source:* journey points speed

**Keep**

- Pickers, map, the 4 tiles (including the not-measured passenger absence), the driver link, the permalink

**Leave structurally untouched (restyle only)**

- Pickers, map, permalink

**Not adopted from the mockup**

- 'Distance, at least 305 km' wording: when two devices interleave, the straight-line sum inflates the distance rather than giving a floor, so 'at least' would be a false reason
- The 'Cars on this page 1 of 266' absence item: live mode already shows the fleet

*Tests that pin this page:* test/routes.test.mjs, test/assets.test.mjs, test/window.test.mjs

#### `#sources` — effort L

*Today:* Verdict: '18 collectors failed on their last run', figure 39 needing attention of 54 runs. Collector health table (54 rows: source, fleet, mode, status, rows, windows, last run, detail truncated to 90 chars with the full text in a tooltip), sortable. Data coverage table (dataset, rows, value, from, latest, days collected, missing, largest gap). Pre-built summaries (rollups) table. Windows that did not land: 238 rows, unfolded (source, fleet, standing, mode, from, to, what came back), with distinct-days and re-run captions. Coordinates on the record table. 'What each source actually sends' raw-field census with a source/period picker (field, filled, distinct, kept as a column, examples).

**Change**

- Order: verdict/00 → §01 reasons → §02 by month → Collector health → Data coverage → §04 freshness | §05 rows by source → Windows that did not land → Pre-built summaries → Coordinates → census → absence band
- Windows that did not land: fold to 20 rows with 'Show the other N' (the page is 21,765px tall at 1440, mostly this table). All rows stay one click away and the debt sentence stays visible. OPTIONAL, operator's call
- Status tags: ERROR/PARTIAL become outline chips with ink text; red only where it says worse, and with a glyph
- Caption defect: 'uber and bolt and uber send addresses as text'. timeline:uber and trip:uber both map to 'uber', so de-duplicate the names

**Add (from the redesign, with its data source)**

- 00 band: Collectors failing on last run (hero) · Need attention of N runs · Windows owed (238 refusals / 2,052 distinct days) · Rows on record · Freshest/stalest feed — *source:* /api/status, /api/coverage
- §01 'Why the window was lost': refused windows by reason class (credential refused / outside retention / host never answered / fewer rows), in channel identity — *source:* /api/status failed_windows[].error (classified client-side, from the provider's own sentence)
- §02 'When each provider lost a window': small multiples by month, one per provider, one ruler — *source:* /api/status failed_windows from/to
- §04 'When each feed last wrote': hours since the last write, per source — *source:* /api/status finished_at / /api/coverage latest
- §05 'Rows on record, by source' bars — *source:* /api/coverage dataset rows
- A 'Stored as' column in the census. The payload's mapped_to (e.g. 'Driver first name' → driver_name) is fetched and never shown, while the caption apologises that name-matching can miss a renamed column — *source:* /api/schema/raw-fields fields[].mapped_to

**Keep**

- The verdict
- Collector health table (all 54 rows, all columns, sort)
- Data coverage table, including the Value column caption (source_value)
- Pre-built summaries
- Windows that did not land, with its standing tags (outstanding / gone for good / not yet due) and the debt sentence (collection_debt)
- Coordinates table
- The census and its picker

**Leave structurally untouched (restyle only)**

- Collector health table and its detail column. It is where a failing credential is diagnosed
- The Windows table's columns and standing tags. They say what to re-run

**Not adopted from the mockup**

- §06 'What the providers actually said' as full untruncated message cards: the table's detail column plus its tooltip already carries each message, and the server's credential cut must stay authoritative. Adding a second render of error strings widens the surface for a credential fragment
- §03 'Which run lost them' by mode: this is the Collector health table's mode column; low decision value

*Tests that pin this page:* test/source_value.test.mjs, test/slow_skeleton.test.mjs, test/tracker_speed.test.mjs, test/collection_debt.test.mjs, test/fms_split.test.mjs, test/uber_profile.test.mjs, test/nav_sections.test.mjs

#### `#coverage` — effort M

*Today:* Verdict: '19 days are missing from the record', figure 2 sources with a hole, over the WHOLE record regardless of window. 5 tiles: Sources with data, Sources with a hole, Missing days all history, Missing in last 30 days, Rows on record. Checked against Uber's own report: 4 tiles (windows checked 34, never stored 0, agreement 100%, disagree 0) and a 34-row window table. Trips with no earnings data table (Uber and Yango earnings horizons). One panel per source (Uber, FMS, Bolt, Hotel, Yango) with a week-column calendar over the full history and a gap table (was it asked for?). Closing caveat.

**Change**

- BUG FIRST: coverage.js awaits /api/coverage (line 289) with no alive(gen) check. In the mirror, #nosuchpage rendered 'Trips with no earnings data' and all 5 source calendars under 'Page not found' because it was opened before /api/coverage returned. Add the guard
- Calendar cells: collected = achromatic sequential by row count; missing = outline (grey-2, no fill); today = hatch. The red hatch on failed days goes
- The 'A REQUEST INSIDE IT FAILED' tag becomes an ink outline chip. It is an absence reason, and L5.9 forbids absence in a semantic hue
- The ▲ glyphs on the '0' and '100%' verification tiles stay only if they go through semanticOf, with sign
- Order: verdict/00 → §02 window days → Uber verification (tiles, §01 scatter, table) → §03 → Trips with no earnings → §04 → per-source calendars → absence band

**Add (from the redesign, with its data source)**

- §02 'Rows collected on each day of the window': columns, today hatched, missing days outlined — *source:* /api/coverage/calendar (windowed `win`, already fetched)
- §04 'Days with a reading, per dataset': bars incl. earnings, alerts, tracker feeds, statement ledger — *source:* /api/coverage datasets (days collected)
- §03 'Rows we hold that Uber's report does not list', by month — *source:* the verification rows (we hold − Uber says)
- §01 scatter, Uber says vs we hold, one point per fleet-month: the chart twin of the verification table — *source:* the same verification payload
- Absence band: bookings with no money (236,078, Uber's rolling earnings window); days the ledger missed; ratings before we asked; every channel but Uber has no count of its own to check against — *source:* /api/coverage earnings_gaps, calendar

**Keep**

- Whole-history behaviour (window_honesty)
- Verdict, all 5 tiles
- The Uber verification tiles and 34-row table
- The Trips with no earnings data table
- Every per-source full-history calendar and gap table
- The 'a gap is only counted inside a source's own span' caption

**Leave structurally untouched (restyle only)**

- Per-source calendars and gap tables. They are the page's reason to exist

**Not adopted from the mockup**

- Making 'Agreement 100%' the hero: the page's question is which days are missing, so the live verdict (19 days) stays the hero
- Bounding the calendar to the window (mockup §02 only): the whole-history calendar is the tested, better answer; the window chart is added beside it, not instead

*Tests that pin this page:* test/window_honesty.test.mjs, test/calendar_window.test.mjs, test/fms_split.test.mjs, test/nav_sections.test.mjs

#### `#providers` — effort S

*Today:* Verdict: '10 surfaces would not answer'. Tiles: Refused 10, Surfaces probed 28 across 6 providers, Answering 18 of 28, Refused or missing 10, Fields we are not keeping 180, Providers not configured 0, Last probe. Jump-to links per provider. A 'show only the fields we are not keeping' toggle. Feeds that did not answer table. One panel per surface (28): status, records returned, NOT KEPT list, and a field table (type, filled, distinct seen, values, kept) with click-through to the field page.

**Change**

- 00 band from the existing tiles: Refused (hero) · Surfaces probed · Answering · Fields not kept · Last probe. 'Providers not configured 0' goes to the caption
- Surface panels: provider swatch in the heading; KEPT/NO as outline chips; filled % as a small inline bar in the table (the table stays)

**Add (from the redesign, with its data source)**

- 'Fields not kept, by provider' ranked bars in channel identity — *source:* /api/probe/results

**Keep**

- All 28 surface panels, jump-to, the unkept-only toggle, the refusal table and its 403/404 caption, all tiles, field click-through

**Leave structurally untouched (restyle only)**

- Surface panels and their field tables

**Not adopted from the mockup**

- Replacing the page with one Uber-trips census: the live page covers 28 surfaces across 6 providers. The mockup's census is the #sources raw-field panel (see the 'Stored as' add there)

*Tests that pin this page:* test/server_redaction.test.mjs, test/signed.test.mjs, test/nav_sections.test.mjs

#### `#providers/<provider>/<surface>/<key>` — effort S

*Today:* One field's page: every value it takes in stored records, most common first.

**Change**

- Restyle only

**Keep**

- The value table and ordering

*Tests that pin this page:* test/server_redaction.test.mjs

#### `#settings` — effort M

*Today:* 'Paste a credential, or drop the files' box (paste → /api/settings/paste, proposals table). Admin access (token, Remember). Credentials form: 47 keys in groups, each with label, key, hint, source (settings / environment / default / not set anywhere) and expiry state (EXPIRED, 7D LEFT); Save credentials. Run buttons: incremental, 12-month backfill, describe every provider API, run the analyst. Requested runs table (40 of N jobs).

**Change**

- The band + §01 sit ABOVE the paste box and take no more than one screen. Everything below keeps its order
- Restyle through tokens: expired = negative text with glyph; days-left = ink; source chips = outline

**Add (from the redesign, with its data source)**

- 00 band: Credentials expired (hero) · Keys configured 43 of 47 · Next to expire (key + days) · Keys not set 4 · Held in the environment 14 (changing these needs a redeploy) — *source:* /api/settings (configured, expiry, source)
- §01 'Days left on each credential that expires': 4 bars; an expired key draws no bar and prints '18.8 d ago' — *source:* /api/settings expiry

**Keep**

- The paste box and its proposals flow
- Admin access
- The credentials form: groups, per-key source and expiry chips, Save
- All 4 run buttons
- The Requested runs table

**Leave structurally untouched (restyle only)**

- Paste box, admin token, credentials form, run buttons, runs table: structure untouched (settings_page_layout and the paste tests assert it)

**Not adopted from the mockup**

- Omitting the paste box and the form: the mockup is read-only, but this is the page where credentials get replaced
- §07 'The register': the form already lists every key with its source and expiry state
- §02/§03/§04 key-count charts by provider / unset / where held: summaries of the form, reduced to band tiles
- §05/§06 runs by kind and duration chart: the Requested runs table already lists each run and how long it took

*Tests that pin this page:* test/settings_page_layout.test.mjs, test/paste_files_page.test.mjs, test/paste_multifile.test.mjs, test/uber_oauth_paste.test.mjs, test/credential_save_check.test.mjs, test/credmodel.test.mjs, test/credential_visibility.test.mjs, test/credential_errand.test.mjs, test/auth_banner_pending_ui.test.mjs, test/audit_tools_detect.test.mjs, test/window_honesty.test.mjs, test/routes.test.mjs

#### `#notfound` — effort S

*Today:* Title 'Page not found', sub '#x is not a destination in this product'. A panel saying nothing was filtered or withheld, closest destinations by id/label match, and a link to Money per car and driver. Observed in the mirror: coverage.js's late panels leaked under this page (see #coverage).

**Change**

- Restyle only. The 'err' note becomes an ink notice: a missing page is an absence, not a worse number, so no red
- Fixed by the coverage.js alive(gen) guard: no other view's late panels may render here

**Keep**

- The sentence, closest-destination suggestions and the fallback link

*Tests that pin this page:* test/nav_sections.test.mjs

## 5. Review notes

- COVERAGE IS COMPLETE. All 63 routes in the list are covered (57 VIEWS rows plus action, cohort, driver, vehicle, property, segment, trip, day, slot, performer, notfound). So are the sub-routes: driver ×10 tabs including unauthorized, vehicle ×7, corporate ×5, property ×3, roster ×5, analyst ×5, unit ×3, settlement ×3, platforms ×3, safety ×3, performance week and month, reconcile/<month>, map/replay and the providers field page.
- CONFIRMED IN SOURCE: missingTarget turns Number(null) into 0 (app.js:87). The compliance sinceLast bug (server.js:5464) is real. identity.js never reads basis. cohort.js near() counts negative days_left (l.272). charging.js:79 falls back to the literal 'AED 0.00'. settlement.js:260 always says 'larger of the two'. playbook.js:68 says 'a month'. impact_kind marks every rule except idle_vehicle 'measured' (server.js:4264). compare.js:230-232 still claims Uber has no fare, and the sentence is split across two string literals, which is why the fare_reason_shared regex misses it. Alerts are written only by fms.js, so FMS identity is right for #safety. Seat occupancy is written only by cabman.js, so the #unauthorized rejection of FMS colour is right. is_booking = platform <> 'fms', so FMS identity is right for the journeys behind the bars on #overview.
- SMALLER POINTS, not violations. #insights: the 'What Uber is asking' table ends up below six new charts; place it straight after the ranked list. #settlement/mix: 'Everything else (only when non-zero)' hides a measured-zero remainder that live shows so the tiles add up to 100%. #capacity: hatching all 168 heatmap cells blunts the sequential ramp; say it in a caption instead. #settings: the new band repeats what #authBanner already says.
- The :8200 mirror was not answering (connection refused) during this review. Every check above was made against the source in api and api/public. No payload figure was re-measured.
