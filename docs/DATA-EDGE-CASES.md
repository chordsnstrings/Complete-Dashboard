# Data edge cases — the log

> Every trap in this file was sprung for real, on this data, and produced a number somebody
> believed. Each entry carries the wrong figure it generated, because the wrong figure is the
> thing you will recognise next time — not the abstraction.
>
> **Append-only.** New cases go at the end of their section with the next free `EC-NN`. Never
> edit or delete an entry; supersede it with a new one that references its number. The
> protocol is in `CLAUDE.md`.

Seeded 2026-09-07 from the first four months of this project.

`EC-NN` numbers run in the order the traps were *discovered*; the sections group them by the
kind of mistake they are. So numbers are not sequential within a section, and a newly appended
entry will usually carry the highest number in the file while sitting in the middle of it. That
is intended — the number is a stable handle for citing a case, not a position.

---

## 1 · Silence that looks like an answer

### EC-01 — The signed-out session returns 200 with an empty list
**Bit us:** 2026-09-01 · `getEarnerBreakdownsV2` reported "OK — 0 of 5 drivers" for 10 August
while the stored pull held real money for that day (Sheraz gross 203.40, net 40.65).
**Symptom:** a stage completes, logs success, and writes an empty file.
**Why it fools you:** an expired supplier cookie does not 401. The portal 302s to
`auth.uber.com`, returns its login page as HTML under a **200**, `JSON.parse` fails, the caller
reads its rows off `data?.X || []`, and a refusal is recorded as a quiet day.
**The test:** assert the parsed body is an object before reading fields off it. A non-object
is a refusal, not an empty result.
**Rule:** a source that can return "nothing" must be able to say "I could not answer". If it
cannot, make it — throw, or return an explicit error field.

### EC-02 — A 301 turns a POST into a GET
**Bit us:** 2026-09-01 · Uber renamed the portal to `fleethub.uber.com` and left a 301 on every
path. `fetch` followed it, the method degraded to GET, the GET was unauthenticated, and the
login page came back as a 200.
**Symptom:** a POST endpoint suddenly returns HTML, or returns 200 with no data.
**Why it fools you:** following redirects is on by default and looks like resilience.
**The test:** `curl -s -o /dev/null -D - -X POST <url>` and read the status and `location`.
**Rule:** name the live host in one constant. Never rely on a redirect to reach an API.

### EC-03 — Asking one org about another org's driver
**Bit us:** repeatedly, from the first week.
**Symptom:** `200` and an empty list, identical to a driver who earned nothing.
**Why it fools you:** the org boundary is enforced silently. There is no error.
**The test:** ask each fleet with its own session and compare the answered-driver count to the
count you asked for. A shortfall is a boundary, not a quiet day.
**Rule:** every call names the org it is for, and every result is checked for how many of the
drivers asked about actually came back.

---

## 2 · Nulls, zeros and the difference between them

### EC-04 — `?? 0` on a measurement that was never taken
**Bit us:** 2026-09-02 · `weekcmp.mjs` had `nowGross = f?.gross_fare ?? 0`. Days whose money had
not been collected rendered as a hard zero, and a column of zeros reads as a fleet that stopped
earning rather than a credential that stopped working.
**Symptom:** a clean, confident zero exactly where data is missing.
**Why it fools you:** `?? 0` is written to avoid a `NaN` downstream, and it does — by inventing
a fact.
**The test:** grep the aggregation path for `?? 0`, `|| 0`, `COALESCE(x, 0)` and ask of each
whether the absent case is genuinely zero.
**Rule:** nulls propagate. Sum only what exists and carry the count of what existed alongside
the total, so a short window announces itself.

### EC-08 — An inclusion rule that quietly drops the unproductive rows
**Bit us:** 2026-09-03 · net-per-online-hour was computed over driver-days "present in both" the
payout feed and the availability feed. The payout feed emits a zero row twice in 2,180, so
absence there means *earned nothing* — and the join deleted **780 real online hours**,
proportionally 1.6× more of Sunday's (4.6%) than of the week's (2.9%). Published 16.32 vs 16.47
(−0.9%); honest figure 15.57 vs 15.99 (−2.6%).
**Symptom:** a rate that looks suspiciously clean, and a gap smaller than the day-to-day spread.
**Why it fools you:** an inner join reads as rigour. It is a filter, and it filtered one side
harder than the other.
**The test:** count the rows each side loses to the join, separately, and compare the
proportions. Then recompute with the absent side zero-filled and see whether the answer moves.
**Rule:** decide explicitly whether a missing row is *unknown* or *zero* — the feed's own
behaviour tells you which — and say which you chose.

---

## 3 · Fields that do not mean what they are called

### EC-05 — A ratio whose denominator is a subset of its numerator
**Bit us:** 2026-09-03 · `/api/capacity` gives `bookings_per_occurrence` and
`drivers_per_occurrence`, and their ratio sits near 1.2 at every hour of every day. That was
published as "the fleet is correctly sized, there is no uncovered opportunity". But
`drivers_per_occurrence` counts only drivers who **got** a booking, so the ratio is bounded
below by 1 by construction, is 99.6% correlated with its own numerator, and is blind to the
58–75% of online drivers who are idle. Against drivers actually online, early Sunday returns
**46% more** per hour than an early weekday — the opposite conclusion.
**Symptom:** a ratio that is suspiciously flat across every cell, with a CV far below its
numerator's.
**Why it fools you:** the two fields share an `occurrences` denominator, so the arithmetic is
well formed. The problem is the population, not the algebra.
**The test:** correlate numerator and denominator. Above ~0.95 you are dividing a series by
itself. Then rebuild the denominator from the source that includes the inactive population.
**Rule:** before dividing, name the population of the denominator out loud. "Drivers" and
"drivers who got work" are different denominators and only one answers a sizing question.

### EC-06 — Your own supply, labelled as market demand
**Bit us:** 2026-09-03 · `/api/capacity`'s `observed_bookings` is this fleet's own completed
jobs, and tracks its own roster at r = 0.9955. Published as "Sunday demand is 27% lower, the
commute vanishes 41–62%". Both figures are restatements of driver turnout. Per hour actually
worked, Sunday mornings are ~10% worse, not 50%.
**Symptom:** a "demand" series that moves in lockstep with your headcount.
**Why it fools you:** it is the only hourly series available, and it is genuinely a measurement
— of the wrong thing.
**The test:** divide by supply. If the per-driver figure is flat, the series was supply.
**Rule:** this fleet has no view of market demand (see `docs/analytics-and-reporting-apis.md`).
Every "demand" number here is realised bookings. Label it as such.

### EC-07 — Whole-day idle is not waiting between jobs
**Bit us:** 2026-09-03 · "115 vs 115 minutes idle between jobs — identical" was published,
concluding Sunday waiting was no better. The figure was whole-day online-minus-on-job, which
also contains the wait before the first request and the tail after the last drop-off. Split out:
genuine between-jobs waiting is **52.6 min on a Sunday against 54.6 on a weekday — 3.7% better**.
Shoulder time is 48% of Sunday's idle against 39% of a weekday's.
**Symptom:** two aggregates that are suspiciously equal.
**Why it fools you:** "idle" is one column, so it reads as one quantity. It is three.
**The test:** reconstruct head / between / tail from the online intervals minus the merged trip
intervals, and report the three separately before combining them.
**Rule:** shoulder time is a driver's choice of when to log on; between-jobs time is the
market's answer to him. Never average them into one number called "waiting".

### EC-12 — A weekly statement figure repeated on every day of its week
**Bit us:** 2026-09-02 · `/api/driver/daily` carries a `money` column that is a flat weekly
value smeared across each day — Sheraz reads 244.06 on four consecutive days, then 107.71 on
three. `platform_earnings`, right beside it, is the real per-day figure.
**Symptom:** identical money on consecutive days for every driver at once.
**Why it fools you:** the column is called `money` and sits in a per-day table.
**The test:** the row's own `money_source: 'statement'` and `money_period_days: 7` declare it.
Check both before using any money column.
**Rule:** in this schema, `platform_earnings` is day-real and `money` is statement-derived. Read
`money_period_days` before dividing anything by a day.

---

## 4 · Windows, periods and boundaries

### EC-09 — A calendar month is not a balanced window for weekday comparisons
**Bit us:** 2026-09-03 · August 2026 runs Sat 1 to Mon 31: five Mondays, five Saturdays, five
Sundays, four of everything else. The Sunday side therefore carried 2 Aug (594 fleet-hours, the
month's weakest day) and the weekday side carried 31 Aug (940h, its strongest). Published gap
173 h/Sunday; on four balanced Mon–Sun weeks it is **147 h** (95% CI 92–202).
**Symptom:** a day-of-week effect that shifts when you move the window by a few days.
**Why it fools you:** "the whole month" sounds more complete than "four weeks", and is worse
for this question.
**The test:** count occurrences of each weekday in the window. Unequal counts means the extra
days are doing some of the talking. Re-run on whole weeks and compare.
**Rule:** whole Mon–Sun weeks for anything folded onto day-of-week. State the window and the
occurrence count.

### EC-10 — A mid-day snapshot sitting among finished days
**Bit us:** 2026-09-02 · the 31 August fare pull ran at 10:05 Dubai. Once 31 August scrolled back
into the window it sat among completed days looking completed, dragging every total and every
week-on-week cell with it. Uber's own trip count for the day was 24 against 47 in the trip feed.
**Symptom:** one day materially below its neighbours, with a provider trip count well under the
trip feed's.
**The test:** compare the provider's own count for the day against the finished feed's. A
shortfall of half is a capture time, not a quiet day.
**Rule:** stamp every snapshot with its capture time and mark days captured before they ended.
Never let one silently rejoin the population of finished days.

### EC-11 — Five feeds, five retentions
**Bit us:** ongoing. Verified 2026-09-03.
**The reaches:** FMS telematics ≈ **13 days** (21 Aug was the edge on 3 Sep) · Uber availability
≈ 31 days · Uber earnings ≈ 192 days · the collector's own `driver_payout_day` and
`driver_days` rows outlive both and go back further · the trip feed goes back years.
**Why it fools you:** a query over a longer window returns rows, just fewer, and the thinning is
invisible unless you count.
**The test:** probe the fleet-wide count per day backwards until it hits zero, before choosing a
window. `/api/map/days?day=` for telematics.
**Rule:** state each finding's window separately when the sources behind it differ, and label
the thinnest evidence on the page as thin.

### EC-16 — Which day a shift belongs to changes the answer
**Bit us:** 2026-09-03 · attributing online time to the Dubai calendar day it falls in gives
Sunday −13.4% against Mon–Fri. Sunday has the highest share of driver-days starting at ~00:00
(48.7%, against 25–34% Mon–Thu), so the calendar cut hands Sunday the most Saturday-night spill.
Re-attributing each contiguous shift to the day it **started** gives **−19.7%**.
**Symptom:** a day-of-week effect that moves by a third depending on an arbitrary-seeming choice.
**The test:** compute both attributions and report the difference. If they disagree materially,
the boundary is load-bearing and must be stated.
**Rule:** Dubai day is `[D 00:00 +04, D+1 00:00 +04)`. Where shifts cross midnight, say which
attribution you used and what the other one gives.

---

## 5 · Identity

### EC-14 — One human, several IDs, and a roster row that contradicts the trip feed
**Bit us:** 2026-09-07 · asked what "Muhammad Khalifa Afzal Khalid" earned on Uber. His directory
row said `trips: 0`, `platforms: []`, no plate, `state: offline` — apparently an inactive hotel
driver. The live trip feed showed him driving. He holds **two records**: a Bolt/HR record keyed
by a Mongo ObjectId (`67483c64055e070d79100112`, the full name in capitals) and an Uber record
keyed by a UUID (`76ede4ae-…`, stored as "Muhammad Khalid"). Uber and Bolt issue different driver
IDs and the collector had not linked them: `person_key` was null on both.
**Symptom:** a driver who "does not drive" on a platform you were told he drives on; or two
plausible name matches; or aggregate columns that disagree with the row-level feed.
**Why it fools you:** the name is a shortened form, the ID formats differ by provider, and the
directory's aggregate columns can be stale while the trip endpoint is live.
**The test — vehicle custody, not name.** `GET /api/driver/vehicles?id=` for each candidate and
compare the plate histories. The same human following the same car through every swap is
conclusive; two people do not. Here 7 of 9 plates matched with overlapping date windows
(L46178 → L45232 → L63961 → L44284 → L76092 → L90721), Uber-only on one record and Bolt-only on
the other, with exactly 1 near-overlap in 804 trip pairs — a one-minute boundary.
**Rule:** resolve identity by custody trail. Never by name, never by a single ID, and never
trust a directory aggregate over the row-level feed. When you report an identity, show the trail
you matched on.

---

## 6 · Grading your own work

### EC-13 — Verifying an artefact with the library that produced it
**Bit us:** 2026-08-31 · a delivered workbook opened empty. `openpyxl` writes a formula cell as
`<f>…</f><v/>` — the `<v>` is present but **empty** — and the patch that filled in cached values
appended a second `<v>`, so each cell held `<v>188.99</v><v/>`. Excel reads the empty one. The
verification had read the file back with `openpyxl`, which returns the *first* `<v>`, and passed.
**Symptom:** a file that validates perfectly and is wrong in the reader that matters.
**Why it fools you:** the writing library and the checking library share the same assumptions,
so the check cannot see the defect.
**The test:** verify from the raw format with something that did not produce it — parse the XML
directly, or open it in the real reader.
**Rule:** never grade an artefact with the tool that made it. Name the independent reader in the
verification script's own header.

### EC-15 — Precision the sample cannot carry
**Bit us:** 2026-09-03 · "−13.4%" was printed for the Sunday hours gap. The driver-clustered 95%
CI is **[−18%, −8%]**, and the robustness band across every subset was 12–16%. The direction is
as solid as this data can make it; the second digit is not.
**Symptom:** a percentage to one decimal, from four or five occurrences.
**The test:** cluster-bootstrap over the unit that repeats (drivers, or dates) and print the
interval next to the point estimate. If the interval is wider than the difference you are
claiming, you have a direction, not a quantity.
**Rule:** report the interval, or round to where it stops mattering. "About 13%, roughly an hour
and a half a day" is the claim the evidence supports.
