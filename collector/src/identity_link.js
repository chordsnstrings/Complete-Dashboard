/* One person, two records — joined on the phone number the roster already
   carries on both of them.
   ═══════════════════════════════════════════════════════════════════════════
   Reported from the product: "Muhammad Khalifa Afzal Khalid has uber trips,
   but it doesn't show that uber is there. it only shows bolt trips."

   He does. The roster holds both records, and the same phone number on each:

     hotel  67483c64055e070d79100112  MUHAMMAD KHALIFA AFZAL KHALID
     uber   76ede4ae-768b-4126-804b-0b5c88043682  Muhammad Khalid

   The Uber account carries 4,461 trips over 302 days on eight vehicles and a
   statement gross of AED 38,380.87. The row an operator sees reports 822 trips
   and AED 15,636, on Bolt.

   ── why the name cannot do it ───────────────────────────────────────────
   personFold decides two records are one person from the NAME, and
   api/identity_map.js argues at length — correctly — that it must never learn
   to do more. The pattern here is that Bolt and the hotel channel file the
   full legal name and Uber drops the middle one:

     Zubair Khan Shaukat Ali       Zubair Khan Ali
     Nauman Hassan Shida Muhammad  Nauman Hassan Muhammad
     Zia Ali Said Muhammad         Zia Ali Muhammad

   A rule that folds one name into the other when its words are a subsequence
   would catch all three — and would also merge "Muhammad Khalid" into
   "Muhammad Khalid Gul", who are two different men with 77 simultaneous trips
   on two plates, refused by hand in that same file. The name genuinely cannot
   settle it.

   ── what the phone can, and what it cannot ──────────────────────────────
   Measured over the 289 roster rows on 2026-09-07:

     217 distinct phone numbers
       0 phones on more than two rows
       0 phones twice within one channel
      72 phones shared across two channels
      61 of those carrying names no fold can reach
      58 still rendering as two directory rows
         — 13,056 trips and AED 393,731 on the smaller row of each pair

   So on this roster the phone is a clean one-to-one cross-channel join, and
   the guards below are written to fail closed the day it stops being one: a
   phone on three records, or twice within a channel, links nothing and says
   why. Being wrong in the direction of "two people" costs a split row; being
   wrong in the direction of "one person" merges two humans' work and money,
   which is not a mistake a page can help a reader notice.

   And it agrees with the refusals, which is what makes it usable at all. Of
   the three pairs a human declined to merge, this rule keeps two apart —
   both have different numbers. The third shares a phone and is the entry
   marked UNDECIDABLE ("0 trips, 0 custody rows and 0 money … settled by a
   phone call, not by this file"), so it is a pair the register could not
   decide rather than one it decided against. REFUSED still wins here
   regardless: a hand refusal is evidence and a rule is not.

   ── the limit, which the page has to print ──────────────────────────────
   166 of the 434 directory rows carry no phone on any of their records — 93
   Bolt-only, 51 Uber-only, 80,443 trips between them. This rule is blind to
   every one of them. Bolt files no phone at all in driver_platform_state; a
   Bolt record reaches Uber only because Bolt and the hotel channel file the
   same full name and the existing fold already joins those two. */
import { pool } from './db.js';
import { log } from './log.js';
import { foldName, REFUSED, PENDING } from '../api/identity_map.js';

const SRC = 'identity';

/* The last nine digits, which is the UAE national significant number.
   ─────────────────────────────────────────────────────────────────────────
   The two channels write the same handset differently — the hotel feed as
   971558089547 and Uber as +971558089547 — and a fleet's roster also carries
   00971… and 0558089547 for the same line. Comparing the tail is what makes
   those one key. Nine rather than the full number because the country code is
   the part that varies, and shorter than nine would start joining people:
   eight digits is a one-in-a-hundred-million collision on a 434-person roster
   and nine is not, but eight is also where a UAE mobile stops being unique. */
export function phoneKey(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length < 9) return null;
  const tail = d.slice(-9);
  /* A number that is all one digit, or the placeholder a form fills in when
     somebody skips the field. Neither identifies anybody, and both would join
     everyone who has one into a single person. */
  if (/^(\d)\1{8}$/.test(tail) || /^0{4}/.test(tail)) return null;
  return tail;
}

/* Which channel's record survives.
   ─────────────────────────────────────────────────────────────────────────
   The one with the fuller name, because that is the one an operator ringing a
   driver wants on screen and the one the legal documents match. Ties go to the
   channel that carries the most other information about a person — Uber, which
   files a rating, a lifetime trip count, a licence expiry and a photograph
   where the hotel channel files none of them. Stated as an order rather than
   left to the planner: which record survives decides which NAME every page
   shows, and that must not change between runs. */
const CHANNEL_RANK = { uber: 3, hotel: 2, bolt: 1, yango: 1 };
const survivorOf = (a, b) => {
  const wa = (a.full_name || '').trim().split(/\s+/).length;
  const wb = (b.full_name || '').trim().split(/\s+/).length;
  if (wa !== wb) return wa > wb ? [a, b] : [b, a];
  const ra = CHANNEL_RANK[a.platform] ?? 0, rb = CHANNEL_RANK[b.platform] ?? 0;
  if (ra !== rb) return ra > rb ? [a, b] : [b, a];
  /* Neither is fuller and neither channel outranks the other, so the tie is
     broken on the id — arbitrary, but STABLE, which is the property that
     matters. A survivor that changes between runs renames a person on every
     page that shows them. */
  return a.driver_ext_id < b.driver_ext_id ? [a, b] : [b, a];
};

/* Pairs a human has already ruled on. Both directions, because a refusal is
   about two people and not about an ordering. */
/* Pairs a person has already ruled on, in BOTH directions of the register's
   vocabulary — and PENDING belongs here as much as REFUSED does.
   ─────────────────────────────────────────────────────────────────────────
   This read REFUSED alone. PENDING is not "not looked at yet": it is VERIFIED
   AND DELIBERATELY NOT APPLIED — five pairs where both records took a trip at
   the same time in two different cars, which is the one observation a shared
   phone cannot explain away. api/identity_map.js says so at length and then
   holds them back on purpose.

   Two of those five also share a phone number, so this rule proposed them
   anyway — and on 2026-09-07, with the Yango roster newly landed, it proposed
   exactly one of them: Tariq Afzal, held back for a contradiction on
   2026-06-10. A rule that re-raises a decision somebody has already made is
   not a rule anybody can trust the second time, and it puts the pair back in
   front of a reviewer with none of the reasoning that settled it.

   An alias may carry SEVERAL ids, so every id on a held-back entry is paired
   with every other, not just the first two. */
const ruledOn = [
  ...REFUSED.map((r) => [r.a.id, r.b.id]),
  ...PENDING.map((m) => [m.keep.id, ...(m.merge?.ids || [m.merge?.id])].filter(Boolean))
    .flatMap((ids) => ids.flatMap((x) => ids.filter((y) => y !== x).map((y) => [x, y]))),
];
const refusedPairs = new Set(ruledOn.flatMap(([x, y]) => [`${x}|${y}`, `${y}|${x}`]));

/* The candidates, from a roster in memory. Pure, so the whole rule can be
   tested without a database — and so the guards can be exercised against
   rosters this fleet does not have yet. */
export function linksFrom(rows) {
  const byPhone = new Map();
  for (const r of rows) {
    const k = phoneKey(r.phone);
    if (!k || !r.driver_ext_id || !r.platform) continue;
    if (!byPhone.has(k)) byPhone.set(k, []);
    byPhone.get(k).push(r);
  }
  const links = [], skipped = [];
  for (const [key, group] of byPhone) {
    const tail = key.slice(-4);
    if (group.length === 1) continue;
    /* FAIL CLOSED. Three records on one number is a handset the fleet is
       passing round, or a form filled in with the office line, and there is no
       reading of it that identifies one person. */
    if (group.length > 2) {
      skipped.push({ tail, n: group.length, why: 'more than two records share this number, '
        + 'so it identifies a handset rather than a person' });
      continue;
    }
    const [a, b] = group;
    if (a.platform === b.platform) {
      /* Two accounts on ONE channel is a different question — a person with a
         second Uber account, or two people sharing a phone — and this rule was
         measured against cross-channel pairs only. */
      skipped.push({ tail, n: 2, why: `both records are on ${a.platform}, and this rule `
        + 'only joins records the two channels filed separately' });
      continue;
    }
    if (refusedPairs.has(`${a.driver_ext_id}|${b.driver_ext_id}`)) {
      skipped.push({ tail, n: 2, why: 'a person has already looked at this pair and either '
        + 'declined to merge it or held it back over a simultaneous trip in two cars '
        + '— see api/identity_map.js' });
      continue;
    }
    const [keep, alias] = survivorOf(a, b);
    const sameName = foldName(keep.full_name) === foldName(alias.full_name);
    links.push({
      alias_ext_id: alias.driver_ext_id,
      alias_platform: alias.platform,
      alias_name: alias.full_name || null,
      canonical_ext_id: keep.driver_ext_id,
      canonical_platform: keep.platform,
      canonical_name: keep.full_name || null,
      canonical_key: foldName(keep.full_name) || keep.driver_ext_id,
      basis: 'shared_phone',
      phone_tail: tail,
      /* The sentence a page prints, built here so every reader of the table
         says the same thing about the same link. It names both records because
         "these are one person" is a claim about two rows and a reader has to be
         able to check it against both. */
      evidence: `${keep.platform} filed “${keep.full_name || keep.driver_ext_id}” and `
        + `${alias.platform} filed “${alias.full_name || alias.driver_ext_id}” against the same `
        + `phone number, ending ${tail}`
        + (sameName ? ' — the names also fold together, so this link changes nothing'
          : ' — the names do not fold together, so nothing else could have joined them'),
      /* A link whose names already fold is real and redundant: personFold has
         it. Kept, because a page listing the links should show the whole
         picture, and flagged so the counts can separate "found" from "found
         and needed". */
      redundant: sameName,
    });
  }
  return { links, skipped };
}

/* ── THE NAMES THAT LOOK LIKE ONE PERSON, WHICH ONLY A HUMAN CAN SETTLE ───
   The operator: "We work with different feeds, names can be different, it
   needs to be automatically merged. If you need human involvement create a
   page in people which will have similar name and a human will confirm or
   deny if they are the same people or not."

   Both halves of that, and the split between them is the whole design.

   AUTOMATIC is for a conclusive key — a phone above, an email below. Those are
   identifiers: two records carrying one are one person, and the rule applies
   without asking anybody.

   A SIMILAR NAME IS NOT AN IDENTIFIER. On this roster "MUHAMMAD SHAFIQ" is a
   strict subset of "MUHAMMAD SHAFIQ UMAR RAZIQ", and so it would be of
   "MUHAMMAD SHAFIQ AHMED" — one of those is the same man and the other is
   somebody else, and nothing in the two strings says which. Merging on a name
   rule pools two people's work and money, which is the failure CLAUDE.md
   forbids in as many words: "Who is one person lives in api/identity_map.js, a
   hand-reviewed LIST of verified pairs — never a name rule."

   So these are written as PROPOSALS. api/identity_links.js applies a link only
   where the basis is conclusive or a human has confirmed it, and these are
   neither until somebody says so on the page.

   ── THE RULE, AND WHY IT IS A SUBSET AND NOT A SIMILARITY ────────────────
   A trigram score would propose "Muhammad Khalid" against "Muhammad Khalifa"
   at a high score and be wrong, and would miss "Shafiq" against "Shafiq Umar
   Raziq" at a low one — the real case. What actually happens on this roster is
   that one channel files a SHORTER version of the same name: Uber files the
   short one in every one of the sixty-one pairs the phone rule already found.
   So the rule is a strict token subset, with at least two tokens shared, which
   is what "the same name with fewer parts" means.

   Two tokens minimum, because one is "Muhammad" and this fleet has forty of
   them. */
const tokensOf = (name) => foldName(name).split(' ').filter((t) => t.length >= 2);
const subsetOf = (a, b) => a.length < b.length && a.every((t) => b.includes(t));

export function nameCandidates(rows, { skipPairs = new Set() } = {}) {
  const people = rows
    .map((r) => ({ ...r, tokens: tokensOf(r.full_name), key: foldName(r.full_name) }))
    .filter((r) => r.driver_ext_id && r.tokens.length >= 2);

  const out = [], skipped = [];
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const a = people[i], b = people[j];
      /* CROSS-CHANNEL ONLY, matching the phone rule above. Two accounts on one
         channel with similar names are a real thing — a driver re-registered
         after a gap — but they are also what a fleet of forty Muhammads looks
         like, and proposing those would bury the pairs worth looking at. */
      if (a.platform === b.platform) continue;
      /* The name fold already joined them: there is nothing to propose. */
      if (a.key === b.key) continue;
      const [long, short] = a.tokens.length > b.tokens.length ? [a, b] : [b, a];
      if (!subsetOf(short.tokens, long.tokens)) continue;
      const shared = short.tokens.length;
      const pair = `${a.driver_ext_id}|${b.driver_ext_id}`;
      if (refusedPairs.has(pair)) { skipped.push({ pair, why: 'ruled on in the register' }); continue; }
      if (skipPairs.has(pair) || skipPairs.has(`${b.driver_ext_id}|${a.driver_ext_id}`)) {
        skipped.push({ pair, why: 'already linked or already decided' });
        continue;
      }
      const [keep, alias] = survivorOf(a, b);
      out.push({
        alias_ext_id: alias.driver_ext_id,
        alias_platform: alias.platform,
        alias_name: alias.full_name,
        canonical_ext_id: keep.driver_ext_id,
        canonical_platform: keep.platform,
        canonical_name: keep.full_name,
        canonical_key: foldName(keep.full_name),
        basis: 'similar_name',
        evidence: `${keep.platform} filed “${keep.full_name}” and ${alias.platform} filed `
          + `“${alias.full_name}”. Every part of the shorter name appears in the longer one `
          + `(${shared} of ${long.tokens.length}), which is what one person filed twice usually `
          + 'looks like — and is also what two relatives look like. Nothing here proves it '
          + 'either way, which is why it is being asked rather than applied.',
        phone_tail: null,
        shared_tokens: shared,
      });
    }
  }
  /* ONE ALIAS, ONE PROPOSAL. driver_identity_link is keyed on alias_ext_id —
     "a record can be an alias of at most one person: a chain would be an
     ambiguity" — so a Bolt record that is a token subset of BOTH an Uber and a
     hotel record cannot be stored twice. Where the two point at the same
     canonical_key they are the same merge said twice and the fuller record
     wins; where they point at different people the alias is genuinely
     ambiguous and proposing either one would be picking a person at random, so
     it is dropped and counted.

     survivorOf is the tie-break, so the choice is the same one the rest of
     this file makes and is stable between runs. */
  const byAlias = new Map();
  for (const c of out) {
    const held = byAlias.get(c.alias_ext_id);
    if (!held) { byAlias.set(c.alias_ext_id, c); continue; }
    if (held.canonical_key !== c.canonical_key) {
      byAlias.set(c.alias_ext_id, { ...held, ambiguous: true });
      continue;
    }
    const [keep] = survivorOf(
      { platform: held.canonical_platform, driver_ext_id: held.canonical_ext_id, full_name: held.canonical_name },
      { platform: c.canonical_platform, driver_ext_id: c.canonical_ext_id, full_name: c.canonical_name });
    if (keep.driver_ext_id === c.canonical_ext_id) byAlias.set(c.alias_ext_id, c);
  }
  const kept = [], ambiguous = [];
  for (const c of byAlias.values()) (c.ambiguous ? ambiguous : kept).push(c);
  for (const c of ambiguous) {
    skipped.push({ pair: `${c.alias_ext_id}|${c.canonical_ext_id}`,
      why: 'the shorter name is inside two different fuller ones, so it names nobody in particular' });
  }
  return { candidates: kept, skipped };
}

/* An email is an identifier, so it merges without asking — the same standing
   as the phone above and for the same reason. It matters now because the live
   driver feed carries one for every Uber account (sql/schema_v70.sql), where
   before this the only contact this product held came from a per-driver portal
   call that reached 157 people.

   The same two guards the phone rule uses, and they are not optional: an
   address on three records identifies a shared mailbox rather than a person,
   and one appearing twice inside a single channel identifies a duplicate
   account rather than a second channel. */
export function emailLinks(rows) {
  const byEmail = new Map();
  for (const r of rows) {
    const k = String(r.email || '').trim().toLowerCase();
    if (!k || !k.includes('@')) continue;
    if (!byEmail.has(k)) byEmail.set(k, []);
    byEmail.get(k).push(r);
  }
  const links = [], skipped = [];
  for (const [email, group] of byEmail) {
    if (group.length !== 2) {
      if (group.length > 2) skipped.push({ email: email.slice(0, 2) + '…', why: 'on more than two records' });
      continue;
    }
    const [a, b] = group;
    if (a.platform === b.platform) {
      skipped.push({ email: email.slice(0, 2) + '…', why: 'twice within one channel' });
      continue;
    }
    if (refusedPairs.has(`${a.driver_ext_id}|${b.driver_ext_id}`)) continue;
    const [keep, alias] = survivorOf(a, b);
    links.push({
      alias_ext_id: alias.driver_ext_id, alias_platform: alias.platform, alias_name: alias.full_name,
      canonical_ext_id: keep.driver_ext_id, canonical_platform: keep.platform,
      canonical_name: keep.full_name, canonical_key: foldName(keep.full_name),
      basis: 'shared_email',
      evidence: `${keep.platform} filed “${keep.full_name}” and ${alias.platform} filed `
        + `“${alias.full_name}” against the same email address, which appears on no other `
        + 'record and not twice within either channel.',
      phone_tail: null,
    });
  }
  return { links, skipped };
}

/* Read the roster, work out the links, and write them — without ever clearing
   a human's verdict.
   ─────────────────────────────────────────────────────────────────────────
   `rejected` and `confirmed_at` are the operator's columns and this function
   does not touch them on conflict. A link that is no longer supported has its
   `last_seen_at` left behind rather than being deleted, so a page can show
   that the evidence has gone without the row disappearing and taking the
   argument with it. */
/* DID THEY EVER DRIVE AT THE SAME TIME?
   ─────────────────────────────────────────────────────────────────────────
   The one observation that DISPROVES a merge. api/identity_map.js holds back
   five otherwise-good pairs on exactly this: two records carrying a trip at
   the same moment in two different cars are two people, whatever their names
   or their phone say. A name proposal is much weaker evidence than a phone, so
   it must be checked against this before a human is asked to look at it —
   putting a pair in front of a reviewer that the trip record already refutes
   wastes the reviewer and teaches them the queue is noise.

   EXISTS rather than a count: the question is whether it ever happened, and
   the planner can stop at the first one. A trip with no end is given twenty
   minutes, which is the median this fleet's completed trips run at and is
   deliberately short — a generous window would manufacture overlaps out of
   two drivers working the same busy hour. */
/* Each side is matched on (platform, driver_ext_id) and not on the id alone.
   A driver_ext_id is unique WITHIN a provider and nowhere else — Uber issues a
   UUID, but the hotel channel issues a short numeric id and CABMAN issues
   another, so two providers can name different people with one string. Matched
   on the id alone, such a collision pulls a THIRD person's trips in under one
   side of the pair and manufactures an overlap out of them. That fails in the
   safe direction — a proposal suppressed, never a merge applied — but it
   suppresses it silently and for a reason that is not the true one, and a
   reviewer would never learn the pair existed. */
async function clashingPairs(db, pairs) {
  if (!pairs.length) return new Set();
  const { rows } = await db.query(
    `WITH p(a, ap, b, bp) AS (
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]))
     SELECT p.a, p.b,
            EXISTS (
              SELECT 1
                FROM trip ta
                JOIN trip tb ON tb.driver_ext_id = p.b AND tb.platform = p.bp
                 AND ta.requested_at < coalesce(tb.ended_at, tb.requested_at + interval '20 minutes')
                 AND tb.requested_at < coalesce(ta.ended_at, ta.requested_at + interval '20 minutes')
               WHERE ta.driver_ext_id = p.a AND ta.platform = p.ap
                 AND ta.platform <> 'fms' AND tb.platform <> 'fms'
            ) AS clash
       FROM p`,
    [pairs.map((x) => x[0]), pairs.map((x) => x[1]),
      pairs.map((x) => x[2]), pairs.map((x) => x[3])]);
  return new Set(rows.filter((r) => r.clash).map((r) => `${r.a}|${r.b}`));
}

export async function refreshIdentityLinks(db = pool) {
  const { rows } = await db.query(
    `SELECT platform, driver_ext_id, full_name, phone
       FROM driver_compliance
      WHERE phone IS NOT NULL AND btrim(phone) <> ''`);
  const { links, skipped } = linksFrom(rows);
  const live = links.filter((l) => !l.redundant);
  for (const l of links) {
    await db.query(
      `INSERT INTO driver_identity_link
         (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
          canonical_name, canonical_key, basis, evidence, phone_tail, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (alias_ext_id) DO UPDATE SET
         alias_platform = EXCLUDED.alias_platform,
         alias_name = EXCLUDED.alias_name,
         canonical_ext_id = EXCLUDED.canonical_ext_id,
         canonical_platform = EXCLUDED.canonical_platform,
         canonical_name = EXCLUDED.canonical_name,
         canonical_key = EXCLUDED.canonical_key,
         basis = EXCLUDED.basis,
         evidence = EXCLUDED.evidence,
         phone_tail = EXCLUDED.phone_tail,
         last_seen_at = now()`,
      [l.alias_ext_id, l.alias_platform, l.alias_name, l.canonical_ext_id, l.canonical_platform,
        l.canonical_name, l.canonical_key, l.basis, l.evidence, l.phone_tail]);
  }
  /* A LINK THE RULE NO LONGER MAKES HAS TO STOP BEING APPLIED.
     ─────────────────────────────────────────────────────────────────────────
     This only ever inserted and updated, so the fail-closed guards above
     failed OPEN over time: a pair linked when their number appeared on two
     records stayed linked for ever once a THIRD record appeared on it — the
     exact case the guard skips, because a number on three records identifies a
     handset rather than a person. The row simply stopped being refreshed, and
     api/identity_links.js went on folding two people together on the strength
     of a run that no longer supports it.

     Not hypothetical: this collector now writes 145 Yango compliance rows with
     phone numbers, which is precisely how a two-record group becomes three.

     A person's decision is not a rule's to withdraw, so a link somebody has
     REJECTED or CONFIRMED survives regardless — the same precedence the rest
     of this file keeps. Everything else the run did not produce goes, and the
     count is logged rather than left to be noticed. */
  /* ── the second conclusive key, and the proposals ──────────────────────
     Email merges on its own, like the phone. A similar name does not: it is
     written as a proposal and api/identity_links.js will not apply it until
     somebody confirms it on the page. */
  const { rows: withEmail } = await db.query(
    /* A NAMED record only. The live driver feed writes contact details for
       every Uber account the moment it meets one, so a record can carry an
       email before anything has filed a name against it — and survivorOf on a
       nameless record yields canonical_key '', which is not a person. The
       phone rule above reads a roster that has always been named; this one
       has to say so. */
    `SELECT platform, driver_ext_id, full_name, email
       FROM driver_compliance
      WHERE email IS NOT NULL AND btrim(email) <> ''
        AND coalesce(btrim(full_name), '') <> ''`);
  const { links: byEmail } = emailLinks(withEmail);
  /* An alias already linked by phone keeps that link: the phone rule ran first
     and a second basis for the same alias is not new information. */
  const claimed = new Set(links.map((l) => l.alias_ext_id));
  const emailNew = byEmail.filter((l) => !claimed.has(l.alias_ext_id));
  for (const l of emailNew) {
    await db.query(
      `INSERT INTO driver_identity_link
         (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
          canonical_name, canonical_key, basis, evidence, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (alias_ext_id) DO UPDATE SET
         canonical_ext_id = EXCLUDED.canonical_ext_id, canonical_key = EXCLUDED.canonical_key,
         canonical_name = EXCLUDED.canonical_name, basis = EXCLUDED.basis,
         evidence = EXCLUDED.evidence, last_seen_at = now()`,
      [l.alias_ext_id, l.alias_platform, l.alias_name, l.canonical_ext_id, l.canonical_platform,
        l.canonical_name, l.canonical_key, l.basis, l.evidence]);
    claimed.add(l.alias_ext_id);
  }

  /* THE PROPOSALS. Over every account this fleet knows of, not only the ones
     carrying a phone — the whole point is to reach the records a contact
     detail never will, which on this roster is every Bolt account. */
  const { rows: everyone } = await db.query(
    `SELECT DISTINCT platform, driver_ext_id, full_name FROM (
       SELECT platform, driver_ext_id, full_name FROM driver_compliance
       UNION
       SELECT platform, driver_ext_id, full_name FROM driver_platform_state
       UNION
       SELECT platform, driver_ext_id, driver_name FROM trip
     ) s
     WHERE coalesce(btrim(driver_ext_id), '') <> ''
       AND coalesce(btrim(full_name), '') <> ''`);
  const decided = await db.query(
    `SELECT alias_ext_id, canonical_ext_id FROM driver_identity_link`);
  const skipPairs = new Set(decided.rows.flatMap((r) => [
    `${r.alias_ext_id}|${r.canonical_ext_id}`, `${r.canonical_ext_id}|${r.alias_ext_id}`]));
  /* An alias a conclusive key already merged is dropped here rather than in
     skipPairs: skipPairs is keyed on a PAIR, and what is known about these is
     the alias alone — whoever it turned out to be, it is spoken for, and a
     name proposal against some third record would be a second answer to a
     question the phone or the email has already settled. */
  const { candidates } = nameCandidates(everyone, { skipPairs });
  const fresh = candidates.filter((c) => !claimed.has(c.alias_ext_id));
  const clash = await clashingPairs(db, fresh.map(
    (c) => [c.alias_ext_id, c.alias_platform, c.canonical_ext_id, c.canonical_platform]));
  let proposed = 0, refutedByTrips = 0;
  for (const c of fresh) {
    if (clash.has(`${c.alias_ext_id}|${c.canonical_ext_id}`)) { refutedByTrips++; continue; }
    await db.query(
      `INSERT INTO driver_identity_link
         (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
          canonical_name, canonical_key, basis, evidence, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (alias_ext_id) DO NOTHING`,
      [c.alias_ext_id, c.alias_platform, c.alias_name, c.canonical_ext_id, c.canonical_platform,
        c.canonical_name, c.canonical_key, c.basis, c.evidence]);
    proposed++;
  }
  log.info('identity', 'proposals', { proposed, refuted_by_simultaneous_trips: refutedByTrips,
    merged_on_email: emailNew.length });

  /* Only the CONCLUSIVE links are subject to the withdrawal below. A proposal
     nobody has answered yet is not a link the rule stopped supporting; deleting
     it every run would empty the review queue between passes. */
  const keep = [...links.map((l) => l.alias_ext_id), ...emailNew.map((l) => l.alias_ext_id),
    ...fresh.map((c) => c.alias_ext_id)];
  /* RETURNING, not rowCount. node-postgres names it rowCount and PGlite names
     it affectedRows, so a count read off one of those two is zero under the
     other — and the tests run on PGlite while production runs on the pool,
     which is the shape where a guard passes locally and reports nothing live. */
  const gone = await db.query(
    `DELETE FROM driver_identity_link
      WHERE NOT rejected AND confirmed_at IS NULL
        AND alias_ext_id <> ALL($1::text[])
      RETURNING alias_ext_id`, [keep]);
  const withdrawn = (gone.rows || []).length;
  /* Said out loud on every run, because a rule that quietly starts linking
     nothing looks exactly like a fleet whose roster is clean. */
  log.info(SRC, 'identity links from the roster phone', {
    roster_rows: rows.length, linked: links.length,
    changing_something: live.length, already_folded_by_name: links.length - live.length,
    not_linked: skipped.length,
    withdrawn,
  });
  return { rows: rows.length, links, live, skipped, withdrawn };
}
