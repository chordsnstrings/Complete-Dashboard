# Working in this repository

This is a fleet dashboard and its collector. It joins five providers (Uber, Bolt, Yango, a
hotel dispatch platform, and FMS telematics) into one picture of who drove what, when, and
for how much.

Almost every hard bug here has been the same bug wearing a different coat: **a question was
answered confidently from data that could not answer it.** Not a crash, not a wrong formula —
a real number, correctly computed, that measured something other than what its name said.

## Before you answer a data question

Read **`docs/DATA-EDGE-CASES.md`** first. It is the log of every trap this codebase has
actually sprung, each with the numbers it produced and the test that catches it. It is not
background reading; several entries invert an answer you would otherwise give.

Then run this pre-flight. It is short because each line cost something to learn.

1. **Does an empty result mean "none" or "not asked"?** A dead session, the wrong org, and a
   genuinely quiet day all return `200 []` here. If you cannot tell them apart, you do not
   have an answer yet. (EC-01, EC-02, EC-03)
2. **Is a `?? 0` or `|| 0` standing where a null belongs?** A missing measurement summed as
   zero is how "we did not collect this" becomes "they earned nothing". (EC-04)
3. **Does the field mean what it is called?** Check the denominator, the population, and the
   period of every rate before you divide. Several fields here do not. (EC-05, EC-06, EC-07,
   EC-12)
4. **Is the window balanced?** Whole weeks for weekday comparisons; a calendar month puts its
   extra weekdays on one side of the scale. (EC-09)
5. **Do the numerator and denominator come from the same rows?** An inclusion rule that drops
   unproductive rows flatters every rate built on it. (EC-08)
6. **How far back does *this* source reach, and when was it captured?** The five feeds have
   five different retentions, and a snapshot taken at 10am will sit among finished days
   looking finished. (EC-10, EC-11)
7. **Is one human wearing several IDs?** Identity here is resolved by vehicle custody, never
   by name and never by a single ID. (EC-14)
8. **Who is grading this?** Never verify an artefact with the library that produced it.
   (EC-13)
9. **Does the precision survive a bootstrap?** Do not print a second digit the sample cannot
   carry. (EC-15)

## When you get one wrong — append it

The log is append-only and grows by one entry every time this repository teaches something
new. Add an entry when **any** of these happens:

- a figure you stated or shipped turns out to be wrong;
- a review, a test, or a colleague breaks a claim you made;
- you discover a field, endpoint or table means something other than its name;
- you find a source whose reach, freshness or population differs from what was assumed.

Append to the end of the matching section of `docs/DATA-EDGE-CASES.md`, using the next free
`EC-NN`, in the existing template:

```
### EC-NN — Short name of the trap
**Bit us:** YYYY-MM-DD · what was believed or published, with the wrong number
**Symptom:** what it looks like from outside
**Why it fools you:** the mechanism, in one or two sentences
**The test:** the specific check that catches it, runnable
**Rule:** the imperative, phrased so it can be followed without reading the rest
```

Two conventions that keep the log usable:

- **Never edit or delete an existing entry.** If one turns out to be wrong or is superseded,
  add a new entry that says so and references the old number. The log is a record of what was
  believed and when, and rewriting it destroys exactly the evidence that makes it worth having.
- **Carry the real numbers.** "Sunday looked flat" teaches nothing; "115 vs 115 minutes, of
  which 47% was shoulder time" teaches the reader to check the same thing tomorrow.

If a new entry produces a check that is not already in the pre-flight above, add one line
here too. The pre-flight is the index; the log is the evidence.

## Conventions

- **Dubai is UTC+4, no DST.** A Dubai day runs `[D 00:00 +04, D+1 00:00 +04)`. Day boundaries
  are not cosmetic — see EC-16.
- **Money.** `net` is Uber's remittance after commission and before driver pay, fuel, Salik
  and the vehicle. It is not margin. Say which one you mean.
- **The deployed collector can be ahead of this checkout.** Endpoints and columns exist in
  production that are not in the source here; verify against the live API, not only the code.
