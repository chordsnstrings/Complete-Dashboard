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

/* Read the roster, work out the links, and write them — without ever clearing
   a human's verdict.
   ─────────────────────────────────────────────────────────────────────────
   `rejected` and `confirmed_at` are the operator's columns and this function
   does not touch them on conflict. A link that is no longer supported has its
   `last_seen_at` left behind rather than being deleted, so a page can show
   that the evidence has gone without the row disappearing and taking the
   argument with it. */
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
  const keep = links.map((l) => l.alias_ext_id);
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
