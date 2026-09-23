/* The pairs a rule cannot settle, put in front of somebody who can.
   ──────────────────────────────────────────────────────────────────────────
   The operator: "names can be different it needs to be automatically merged.
   If you need human involvement create a page in people which will have
   similar name and a human will confirm or deny if they are the same people or
   not."

   Automatic merging happens on an IDENTIFIER — a phone, an email — and
   src/identity_link.js applies those without asking. This file is the other
   half: the pairs whose only evidence is that one name sits inside another,
   which is what one person filed twice looks like and also what two brothers
   look like. Nothing in the strings says which, so nothing here folds until a
   person answers it.

   ── WHAT A REVIEWER IS SHOWN, AND WHY EACH PIECE IS THERE ────────────────
   A verdict on two names alone is a coin toss, so the queue carries the facts
   that actually settle these:

     the channels       one person on two channels is the ordinary case;
                        two accounts on the same channel is usually two people
     trips and dates    a record with four trips two years ago beside one with
                        nine hundred is a re-registration, not a twin
     the cars           the same plate on both is strong; never the same car is
                        not evidence either way, and the page says so
     a shared phone     masked to its last four, which is enough to check by
                        eye and not enough to be a contact detail leaving
                        through a page with no business carrying one

   The one thing that DISPROVES a pair — a trip in each record at the same
   moment in two different cars — is checked before the proposal is written at
   all (src/identity_link.js), so a refuted pair never reaches this queue.

   ── A DECISION IS NOT A RULE'S TO OVERTURN ───────────────────────────────
   Both verdicts are permanent against the collector: `rejected` survives every
   recomputation and `confirmed_at` keeps a link the rule would have withdrawn.
   That precedence already existed for the phone rule and this changes none of
   it. What it adds is that the decision can now be made on a PAGE — before
   this, promoting a pair meant editing api/identity_map.js, regenerating
   sql/schema_v53.sql and deploying. */
import { identityLinks, clearIdentityLinkCache } from './identity_links.js';
/* The spine, folded in the same request as the confirmation that earns it —
   see the block in the decide route for the half-hour of invisibility this
   removes. */
import { foldComponent } from '../src/persons.js';
import { clearPersonMapCache } from './person_map.js';
/* The HR roster's proposals and contradictions. Kept in their own table
   (hr_roster_proposal), never in driver_identity_link — see api/hr_roster.js
   for why that table would delete them — and shown here beside the rule's,
   marked basis `hr_roster` so the reviewer sees where each came from. */
import { hrQueue, decideHr } from './hr_roster.js';

/* The bases that merge on their own. Anything else is a proposal, and this
   list is the single definition of that split — api/identity_links.js applies
   exactly these without confirmation. */
export const CONCLUSIVE = ['shared_phone', 'shared_email'];

export function samePersonRoutes(app, { q, wrap }) {
  /* ── the queue ─────────────────────────────────────────────────────────── */
  app.get('/api/same-person', wrap(async (req, res) => {
    /* COUNTS ONLY, for a page that wants to name the backlog without carrying
       it. #drivers prints "N people · K pairs awaiting review" beside its
       count, and pulling the full queue — every pair with its evidence
       sentence — to render one number would be several hundred kilobytes on a
       page that is already the heaviest in the product. */
    if (req.query.counts) {
      const [c] = await q(
        `SELECT count(*) FILTER (WHERE NOT rejected AND confirmed_at IS NULL)::int AS pending,
                count(*) FILTER (WHERE confirmed_at IS NOT NULL)::int AS confirmed,
                count(*) FILTER (WHERE rejected)::int AS rejected
           FROM driver_identity_link WHERE basis <> ALL($1::text[])`, [CONCLUSIVE]);
      const byBasis = await q(
        `SELECT basis, count(*)::int AS n FROM driver_identity_link
          WHERE NOT rejected AND confirmed_at IS NULL AND basis <> ALL($1::text[])
          GROUP BY basis ORDER BY 2 DESC`, [CONCLUSIVE]);
      /* The spine's own size travels with the backlog, because the two are one
         question: how many people this fleet has, and how many pairs are
         waiting to change that. It also lets a page check its OWN row count
         against the truth — #drivers capped its query at 800 for months and
         quietly dropped three people the month the roster passed it. */
      const [spine] = await q(
        `SELECT (SELECT count(*)::int FROM driver) AS people,
                (SELECT count(*)::int FROM driver_platform_id WHERE detached_at IS NULL)
                  AS accounts`);
      /* HR's proposals are pairs waiting for an answer too, and a backlog
         count that left them out would tell #drivers the queue is empty
         while it is not. Counted under their own basis. */
      const hrq = await hrQueue(q).catch(() => null);
      const hrPending = hrq ? hrq.pending.length : 0;
      const hrDecided = hrq ? hrq.decided : [];
      return res.json({ pending: c.pending + hrPending,
        confirmed: c.confirmed + hrDecided.filter((p) => p.verdict === 'same').length,
        rejected: c.rejected + hrDecided.filter((p) => p.verdict === 'different').length,
        people: spine.people, accounts: spine.accounts,
        by_basis: Object.fromEntries([...byBasis.map((r) => [r.basis, r.n]),
          ...(hrPending ? [['hr_roster', hrPending]] : [])]),
        note: 'Pairs a rule proposed and nobody has answered. They fold nobody until somebody '
          + 'does — api/identity_links.js applies a link only where the basis is conclusive or '
          + 'a person confirmed it.' });
    }
    const rows = await q(
      `SELECT l.alias_ext_id, l.alias_platform, l.alias_name,
              l.canonical_ext_id, l.canonical_platform, l.canonical_name, l.canonical_key,
              l.basis, l.evidence, l.phone_tail, l.first_seen_at,
              l.confirmed_at, l.confirmed_by, l.rejected, l.rejected_reason
         FROM driver_identity_link l
        WHERE l.basis <> ALL($1::text[])
        ORDER BY l.rejected, l.confirmed_at NULLS FIRST, l.canonical_name`,
      [CONCLUSIVE]);

    /* HR's half of the queue. A failure to read it is said, not swallowed
       into "HR proposes nothing". */
    let hrq = null;
    let hrError = null;
    try { hrq = await hrQueue(q); } catch (e) { hrError = String(e?.message || e).slice(0, 160); }
    const hrItems = hrq ? [...hrq.pending, ...hrq.decided] : [];

    /* The evidence, fetched for the pairs on screen rather than joined into
       the query above — two lookups over a handful of ids, against a join that
       would multiply the row count by every trip either record ever took. */
    const ids = [...new Set([...rows.flatMap((r) => [r.alias_ext_id, r.canonical_ext_id]),
      ...hrItems.flatMap((p) => [p.alias.ext_id, p.canonical.ext_id])])];
    const facts = ids.length ? await q(
      `SELECT driver_ext_id,
              count(*)::int                                    AS trips,
              min(requested_at)                                AS first_trip,
              max(requested_at)                                AS last_trip,
              (array_agg(DISTINCT plate) FILTER (WHERE plate IS NOT NULL AND plate <> ''))
                                                               AS plates,
              (array_agg(DISTINCT fleet_id) FILTER (WHERE fleet_id IS NOT NULL)) AS fleets
         FROM trip
        WHERE driver_ext_id = ANY($1::text[]) AND platform <> 'fms'
        GROUP BY 1`, [ids]) : [];
    const by = new Map(facts.map((f) => [f.driver_ext_id, f]));
    const side = (id, name, platform) => {
      const f = by.get(id) || {};
      return { driver_ext_id: id, name, platform,
        trips: f.trips || 0, first_trip: f.first_trip || null, last_trip: f.last_trip || null,
        plates: f.plates || [], fleets: f.fleets || [] };
    };

    /* A LINK HR'S ROSTER CONTRADICTS, said on the link's own card. The
       first export found one: an unconfirmed `same_name` link attaching a
       Yango account to one member of a pair this product has ruled two
       people, while HR files that Yango account with the other member. The
       reviewer answering the link needs to see that, where they answer it. */
    const hrAgainst = (r) => (hrq?.contradictions || []).filter((c) => c.link
      && c.link.source === 'link' && c.link.alias_ext_id === r.alias_ext_id
      && c.link.canonical_ext_id === r.canonical_ext_id).map((c) => c.evidence);
    const pairs = rows.map((r) => {
      const a = side(r.alias_ext_id, r.alias_name, r.alias_platform);
      const b = side(r.canonical_ext_id, r.canonical_name, r.canonical_platform);
      const shared = (a.plates || []).filter((p) => (b.plates || []).includes(p));
      const against = hrAgainst(r);
      return {
        hr_contradiction: against.length ? against.join(' ') : null,
        alias_ext_id: r.alias_ext_id,
        basis: r.basis,
        evidence: r.evidence,
        phone_tail: r.phone_tail,
        proposed_at: r.first_seen_at,
        verdict: r.rejected ? 'different' : r.confirmed_at ? 'same' : null,
        decided_by: r.confirmed_by || null,
        decided_note: r.rejected_reason || null,
        alias: a,
        canonical: b,
        shared_plates: shared,
        /* Said rather than left to be inferred from an empty array. Two drivers
           who never shared a car is the ordinary state of a fleet with ninety
           of them, and reading it as evidence against a merge would reject
           almost every true pair. */
        plate_note: shared.length
          ? `Both records have driven ${shared.join(', ')} — the same car, which one person doing `
            + 'two jobs looks like.'
          : 'These records have never driven the same car. On a fleet this size that is the '
            + 'ordinary case and is not evidence either way.',
      };
    });

    /* HR's proposals in the queue's own shape, so the page draws them with
       the same two sides and the same facts. `proposal_id` is how a verdict
       addresses one; there is deliberately NO alias_ext_id on them, so a
       client that only knows the link table's key cannot send a verdict meant
       for an HR proposal to a link that happens to share the alias. */
    const hrPairs = hrItems.map((p) => {
      const a = side(p.alias.ext_id, p.alias.name, p.alias.platform);
      const b = side(p.canonical.ext_id, p.canonical.name, p.canonical.platform);
      const shared = (a.plates || []).filter((x) => (b.plates || []).includes(x));
      return {
        proposal_id: p.proposal_id,
        source: 'hr_roster',
        basis: 'hr_roster',
        evidence: p.evidence,
        phone_tail: null,
        proposed_at: null,
        verdict: p.verdict,
        decided_by: p.decided_by,
        decided_note: p.decided_note,
        alias: a,
        canonical: b,
        shared_plates: shared,
        plate_note: shared.length
          ? `Both records have driven ${shared.join(', ')} — the same car.`
          : 'These records have never driven the same car. HR’s roster is the evidence here, '
            + 'not the car.',
        employee: { fleet_id: p.fleet_id, employee_id: p.employee_id, name: p.employee_name },
        accounts: p.accounts,
        hr_contradiction: p.contradicts.length ? p.contradicts.join(' ') : null,
      };
    });

    res.json({
      pending: [...pairs.filter((p) => !p.verdict), ...hrPairs.filter((p) => !p.verdict)],
      decided: [...pairs.filter((p) => p.verdict), ...hrPairs.filter((p) => p.verdict)],
      /* Every contradiction HR's latest export makes with what is held NOW,
         including ones whose link is not in this queue (a conclusive phone
         link, the register, the spine). */
      hr_contradictions: hrq ? hrq.contradictions : [],
      hr_roster: hrq?.latest ? { ...hrq.latest, withdrawn: hrq.withdrawn,
        already_one_person: hrq.already_one } : null,
      hr_note: hrError
        ? `HR's roster proposals could not be read just now (${hrError}); the pairs above are the `
          + 'rule\'s only, and that is a failure to read, not an empty HR list.'
        : hrq?.latest
          ? `Pairs marked HR come from HR's roster (export of ${hrq.latest.export_date}): platform `
            + 'ids HR filed under one employee. A verdict on one is RECORDED and folds nobody — '
            + 'an HR proposal is never applied by this product; promoting a pair into the merge '
            + 'register is a separate, deliberate edit.'
          : 'No HR roster has been uploaded, so HR proposes nothing yet.',
      conclusive_bases: CONCLUSIVE,
      /* How the two halves differ, in the words the page prints, so the
         reviewer knows what they are being asked and what they are not. */
      why: 'A phone number or an email address on two records is an identifier, so those merge '
        + 'without asking. These are pairs where the only evidence is that one name sits inside '
        + 'the other — which is what one person filed twice looks like, and equally what two '
        + 'relatives look like. Nothing here has been applied.',
      refuted_note: 'A pair where both records carry a trip at the same moment in two different '
        + 'cars is two people, and never reaches this queue — it is ruled out before the '
        + 'proposal is written.',
    });
  }));

  /* ── the verdict ───────────────────────────────────────────────────────── */
  app.post('/api/same-person/decide', wrap(async (req, res) => {
    /* AN HR PROPOSAL, addressed by its own id. The verdict is recorded on
       hr_roster_proposal and NOTHING ELSE MOVES: no link is written, no spine
       fold runs, the register is not touched. That is the operator's rule for
       HR's evidence — never an automatic merge — and the effect sentence says
       so in as many words, because a "Yes" that visibly changes nothing reads
       as a broken button unless the page says why (docs/COVERAGE.md, "A
       CONFIRMED MERGE WAS INVISIBLE"). */
    if (req.body && req.body.proposal_id != null) {
      const id = Number(req.body.proposal_id);
      const v = String(req.body.verdict || '');
      if (!Number.isInteger(id) || !['same', 'different', 'undecided'].includes(v)) {
        return res.status(400).json({ error: 'proposal_id and verdict (same | different | undecided) required' });
      }
      const done = await decideHr(q, id, v, { by: req.body.by || null, note: req.body.note || null });
      if (!done) return res.status(404).json({ error: 'no such HR proposal', proposal_id: id });
      return res.json({ ok: true, proposal_id: id, verdict: v, source: 'hr_roster',
        applied_now: false, spine: null,
        effect: v === 'same'
          ? 'Recorded: you agree with HR that these are one person. Nothing was merged — an HR '
            + 'proposal is never applied by this product. The records stay apart on every page '
            + 'until the pair is promoted into the merge register, which is a separate edit.'
          : v === 'different'
            ? 'Recorded: these are two people, whatever HR\'s roster says. HR\'s row for this '
              + 'employee is probably carrying somebody else\'s id.'
            : 'Back in the queue, unanswered.' });
    }
    const { alias_ext_id: alias, verdict, by = null, note = null } = req.body || {};
    if (!alias || !['same', 'different', 'undecided'].includes(String(verdict))) {
      return res.status(400).json({ error: 'alias_ext_id and verdict (same | different | undecided) required' });
    }
    const [row] = await q(`SELECT basis FROM driver_identity_link WHERE alias_ext_id = $1`, [alias]);
    if (!row) return res.status(404).json({ error: 'no such proposal', alias_ext_id: alias });
    /* A conclusive link is not this queue's to overturn. Rejecting one is a
       real thing an operator may want to do — the phone was reassigned — but it
       belongs to the links page that shows the phone evidence, not to a screen
       whose whole subject is names. Refused by name rather than silently
       ignored, so a caller aiming at the wrong surface is told. */
    if (CONCLUSIVE.includes(row.basis)) {
      return res.status(409).json({ error: 'this pair was merged on an identifier, not on a name',
        basis: row.basis, where: 'decide it on the identity links page' });
    }

    if (verdict === 'same') {
      await q(`UPDATE driver_identity_link
                  SET confirmed_at = now(), confirmed_by = $2,
                      rejected = false, rejected_reason = NULL
                WHERE alias_ext_id = $1`, [alias, by]);
    } else if (verdict === 'different') {
      await q(`UPDATE driver_identity_link
                  SET rejected = true, rejected_reason = $2,
                      confirmed_at = NULL, confirmed_by = NULL
                WHERE alias_ext_id = $1`, [alias, note || `ruled two people${by ? ` by ${by}` : ''}`]);
    } else {
      await q(`UPDATE driver_identity_link
                  SET confirmed_at = NULL, confirmed_by = NULL,
                      rejected = false, rejected_reason = NULL
                WHERE alias_ext_id = $1`, [alias]);
    }
    /* The read layer holds the map for thirty seconds. Cleared here so the
       reviewer sees the fold change on the page they are standing on, rather
       than half a minute later on a page they have left. */
    clearIdentityLinkCache();
    const links = await identityLinks(q);

    /* AND THE SPINE, NOW — not in up to half an hour.
       ─────────────────────────────────────────────────────────────────
       THE DEFECT, 2026-09-21. An operator answered 93 pairs here, went back
       to the drivers page, and still saw one man as two rows. Nothing was
       broken: every confirmation was in, the link layer had all four of his
       accounts in one component, and src/persons.js — which turns components
       into person rows — rebuilds on the collector's THIRTY-MINUTE cycle.
       Measured at that moment: 407 people on the spine, 349 once it next ran.
       Fifty-eight folds already earned and invisible.

       So the merge worked and the page said it had not, which is worse than a
       broken merge: the operator's next move is to do it again.

       The half-hourly pass still runs and still catches everything. This makes
       the answer visible before the reviewer looks away. */
    let spine = null;
    if (verdict === 'same') {
      try { spine = await foldComponent(q, alias); }
      catch (e) {
        /* A fold that fails is a delay, not a lost decision — the
           confirmation is already stored and the collector will apply it. Said
           rather than swallowed, because "it did nothing" is exactly the
           impression this whole change exists to remove. */
        spine = { refused: true, why: `the fold could not be applied just now (${String(e).slice(0, 80)}). `
          + 'The confirmation is stored and the collector\'s next pass will apply it.' };
      }
      clearPersonMapCache();
    }

    res.json({ ok: true, alias_ext_id: alias, verdict,
      applied_now: links.byAlias.has(alias),
      /* What the spine did about it, in the same breath. */
      spine,
      /* What the verdict actually did, in words. "Confirmed" is not
         self-explanatory: it folds the two records on every page from the next
         request, and it does NOT move the stored person_key that the rollups
         group by — the same distinction api/identity_links.js documents. */
      effect: verdict === 'same'
        ? 'The two records now read as one person on the driver pages and the directory'
          + (spine && spine.folded
            ? `, and the person spine folded ${spine.folded + 1} records into one immediately`
            : spine && spine.needs_merge
              ? ', but one of them already carries money — folding them moves a balance, which '
                + 'is an authorised operation and is recorded. Nothing was moved here.'
              : '')
          + '. The stored key the monthly rollups group by is unchanged until the pair is '
          + 'promoted into api/identity_map.js.'
        : verdict === 'different'
          ? 'They stay apart, and the collector will not propose this pair again.'
          : 'Back in the queue, unanswered.' });
  }));
}
