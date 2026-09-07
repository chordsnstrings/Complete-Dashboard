/* One person, two records, joined on the phone the roster already carries.
   ═══════════════════════════════════════════════════════════════════════════
   Reported from the product: "Muhammad Khalifa Afzal Khalid has uber trips,
   but it doesn't show that uber is there. it only shows bolt trips." He does:
   the roster holds both records with the same phone number on each, and the
   Uber account carries 4,461 trips against the 822 the page showed.

   The name cannot settle it. Bolt and the hotel channel file the full legal
   name and Uber drops the middle one, and any rule loose enough to fold
   "Zia Ali Said Muhammad" into "Zia Ali Muhammad" also folds "Muhammad Khalid"
   into "Muhammad Khalid Gul" — two men with 77 simultaneous trips on two
   plates, refused by hand in api/identity_map.js.

   This file is mostly about the cases where the rule must REFUSE, because
   being wrong in the direction of "two people" costs a split row and being
   wrong in the direction of "one person" merges two humans' money — which is
   not a mistake a page can help a reader notice. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { phoneKey, linksFrom, refreshIdentityLinks } from '../src/identity_link.js';
import { REFUSED } from '../api/identity_map.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\nthe number, however the channel wrote it');
/* The two channels write the same handset differently — the hotel feed as
   971558089547, Uber as +971558089547 — and rosters also carry 00971… and a
   bare 05…. All four are one line. */
check('every way a channel writes one UAE mobile folds to one key',
  new Set(['971558089547', '+971558089547', '00971 55 808 9547', '0558089547', '558089547']
    .map(phoneKey)).size === 1,
  JSON.stringify(['971558089547', '+971558089547', '0558089547'].map(phoneKey)));
check('…and two different mobiles do not', phoneKey('+971558089547') !== phoneKey('+971554002628'));
check('a number too short to identify anybody is no key at all',
  phoneKey('12345') === null && phoneKey('') === null && phoneKey(null) === null);
/* A placeholder is worse than a blank: it would join everybody who has one. */
check('a repeated-digit placeholder is refused', phoneKey('000000000') === null
  && phoneKey('999999999') === null, JSON.stringify([phoneKey('000000000'), phoneKey('999999999')]));

console.log('\nthe pair the report was about');
const KHALIFA = [
  { platform: 'hotel', driver_ext_id: '67483c64055e070d79100112',
    full_name: 'MUHAMMAD KHALIFA AFZAL KHALID', phone: '971558089547' },
  { platform: 'uber', driver_ext_id: '76ede4ae-768b-4126-804b-0b5c88043682',
    full_name: 'Muhammad Khalid', phone: '+971558089547' },
];
const one = linksFrom(KHALIFA);
check('the two records are linked', one.links.length === 1, JSON.stringify(one));
/* The FULLER name survives — it is the one an operator ringing him wants, and
   the one his documents match. */
check('…and the record with the fuller name is the one that survives',
  one.links[0].canonical_name === 'MUHAMMAD KHALIFA AFZAL KHALID'
  && one.links[0].alias_name === 'Muhammad Khalid',
  JSON.stringify([one.links[0].canonical_name, one.links[0].alias_name]));
check('…under a key every surface already groups by',
  one.links[0].canonical_key === 'muhammad khalifa afzal khalid', one.links[0].canonical_key);
/* THE POINT. A link nobody can check is a merge on trust. */
check('…with an evidence sentence naming both records and the number',
  /MUHAMMAD KHALIFA AFZAL KHALID/.test(one.links[0].evidence)
  && /Muhammad Khalid/.test(one.links[0].evidence)
  && /9547/.test(one.links[0].evidence), one.links[0].evidence);
check('…and it says the names could not have joined them, which is why this exists',
  /do not fold together/.test(one.links[0].evidence), one.links[0].evidence);
/* Four digits is enough to check a link by eye against a record and not enough
   to be a contact detail leaving through a page with no business carrying one. */
check('…and only the last four digits are kept',
  one.links[0].phone_tail === '9547' && !/558089547/.test(JSON.stringify(one.links[0])),
  one.links[0].phone_tail);

console.log('\nand every way it must refuse');
/* THREE RECORDS is a handset the fleet passes round, or the office line typed
   into a form. There is no reading of it that identifies one person. */
const three = linksFrom([
  ...KHALIFA,
  { platform: 'bolt', driver_ext_id: '6628822', full_name: 'Someone Else', phone: '971558089547' },
]);
check('a number on three records links nobody',
  three.links.length === 0 && three.skipped.length === 1, JSON.stringify(three.links));
check('…and says why, rather than going quiet',
  /handset rather than a person/.test(three.skipped[0].why), three.skipped[0].why);

/* TWO ON ONE CHANNEL is a different question — a second Uber account, or two
   people sharing a phone — and the rule was measured on cross-channel pairs. */
const sameChan = linksFrom([
  { platform: 'uber', driver_ext_id: 'u-1', full_name: 'A Person', phone: '971500000011' },
  { platform: 'uber', driver_ext_id: 'u-2', full_name: 'Another Person', phone: '971500000011' },
]);
check('two records on ONE channel link nobody',
  sameChan.links.length === 0 && sameChan.skipped.length === 1, JSON.stringify(sameChan.links));
check('…and says which channel', /both records are on uber/.test(sameChan.skipped[0].why),
  sameChan.skipped[0].why);

/* A HAND REFUSAL WINS. A person looked at these two and said they are not one
   human; a rule that overrules that is a rule that cannot be corrected. */
const ref = REFUSED[0];
const refused = linksFrom([
  { platform: 'uber', driver_ext_id: ref.a.id, full_name: ref.a.name, phone: '971500000022' },
  { platform: 'hotel', driver_ext_id: ref.b.id, full_name: ref.b.name, phone: '971500000022' },
]);
check('a pair a person has already refused is not linked',
  refused.links.length === 0, JSON.stringify(refused.links));
check('…and points at where the refusal is recorded',
  /identity_map/.test(refused.skipped[0].why), refused.skipped[0].why);

/* THE REAL REFUSALS, against the real register. Two of the three pairs a human
   declined are two different men, and the phone agrees — which is the fact
   that makes this rule usable at all rather than a second guess. */
console.log('\nagainst the register’s own refusals');
{
  const rows = [];
  const phones = { [REFUSED[0].a.id]: '971500001001', [REFUSED[0].b.id]: '971500001002',
    [REFUSED[1].a.id]: '971554002628', [REFUSED[1].b.id]: '971558089547' };
  for (const r of REFUSED) {
    for (const side of [r.a, r.b]) {
      rows.push({ platform: side.id.includes('-') ? 'uber' : 'hotel',
        driver_ext_id: side.id, full_name: side.name, phone: phones[side.id] || '971500009999' });
    }
  }
  const out = linksFrom(rows);
  const joined = out.links.filter((l) => REFUSED.some((r) =>
    (r.a.id === l.alias_ext_id && r.b.id === l.canonical_ext_id)
    || (r.b.id === l.alias_ext_id && r.a.id === l.canonical_ext_id)));
  check('no refused pair is joined, whatever number they carry', joined.length === 0,
    JSON.stringify(joined.map((l) => [l.alias_name, l.canonical_name])));
}

/* A link whose names ALREADY fold is real and redundant — personFold has it.
   Kept and flagged, so a page can separate "found" from "found and needed". */
const same = linksFrom([
  { platform: 'hotel', driver_ext_id: 'h-9', full_name: 'Same Person', phone: '971500000033' },
  { platform: 'uber', driver_ext_id: 'u-9', full_name: 'same person', phone: '971500000033' },
]);
check('a pair the name fold already joins is linked but marked redundant',
  same.links.length === 1 && same.links[0].redundant === true, JSON.stringify(same.links));
check('…and says so in the evidence', /changes nothing/.test(same.links[0].evidence),
  same.links[0].evidence);

console.log('\nand it survives a human’s verdict');
const db = new PGlite();
await applySchema(db);
await db.query(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name, phone)
                VALUES ('hotel',$1,$2,$3),('uber',$4,$5,$6)`,
[KHALIFA[0].driver_ext_id, KHALIFA[0].full_name, KHALIFA[0].phone,
  KHALIFA[1].driver_ext_id, KHALIFA[1].full_name, KHALIFA[1].phone]);
const r1 = await refreshIdentityLinks(db);
check('the link is written from the roster', r1.links.length === 1, JSON.stringify(r1.links.length));
const stored = (await db.query('SELECT * FROM driver_identity_link')).rows;
check('…once', stored.length === 1, String(stored.length));
check('…and starts unrejected and unconfirmed',
  stored[0].rejected === false && stored[0].confirmed_at === null,
  JSON.stringify([stored[0].rejected, stored[0].confirmed_at]));

/* A person says "those are two brothers". The collector must never overrule
   that, however many times it runs. */
await db.query(`UPDATE driver_identity_link SET rejected = true, rejected_reason = 'two brothers'`);
await refreshIdentityLinks(db);
const after = (await db.query('SELECT * FROM driver_identity_link')).rows;
check('a rejection survives the next run', after[0].rejected === true, String(after[0].rejected));
check('…with its reason', after[0].rejected_reason === 'two brothers', after[0].rejected_reason);
/* And the evidence is still refreshed underneath it, so a rejected link whose
   basis has changed can be seen to have changed. */
check('…while the evidence is still kept current',
  new Date(after[0].last_seen_at) >= new Date(stored[0].last_seen_at),
  JSON.stringify([stored[0].last_seen_at, after[0].last_seen_at]));

/* A confirmation is the operator's column too. */
await db.query(`UPDATE driver_identity_link SET rejected = false, confirmed_at = now(),
                confirmed_by = 'ops' `);
await refreshIdentityLinks(db);
const conf = (await db.query('SELECT confirmed_at, confirmed_by FROM driver_identity_link')).rows[0];
check('a confirmation survives it too',
  conf.confirmed_at !== null && conf.confirmed_by === 'ops',
  JSON.stringify(conf));

/* A record with no phone is not a candidate, and must not become one by being
   grouped under an empty key with every other record that has none. */
await db.query(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name, phone)
                VALUES ('hotel','h-nophone','No Phone One',NULL),
                       ('uber','u-nophone','No Phone Two','')`);
const r2 = await refreshIdentityLinks(db);
check('records with no phone are not joined to each other',
  r2.links.length === 1, JSON.stringify(r2.links.map((l) => l.alias_name)));

/* ── and the two surfaces that read them ────────────────────────────────── */
/* The directory is the page the report was about. A link that is written and
   not applied is the same defect one layer along. */
console.log('\nthe directory folds the two records into one row');
{
  const { mountAll } = await import('./mount.mjs');
  const { clearIdentityLinkCache } = await import('../api/identity_links.js');
  clearIdentityLinkCache();
  await db.query(`UPDATE driver_identity_link SET confirmed_at = NULL, confirmed_by = NULL`);
  await db.query(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);
  /* One trip on each account, so both records exist on the trip table and the
     directory has two rows to fold. */
  await db.query(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                       requested_at, status)
     VALUES ('hotel','t-h1','ecosine','L44284',$1,$2,'2026-09-02T10:00:00Z','completed'),
            ('uber','t-u1','ecosine','L90721',$3,$4,'2026-09-03T10:00:00Z','completed')`,
    [KHALIFA[0].driver_ext_id, KHALIFA[0].full_name,
      KHALIFA[1].driver_ext_id, KHALIFA[1].full_name]);
  const { get } = await mountAll(db);
  const W = 'from=2026-09-01&to=2026-09-07';
  const dir = await get(`/api/drivers/directory?${W}`);
  const mine = (dir.body || []).filter((r) =>
    (r.ids || []).some((i) => i === KHALIFA[0].driver_ext_id || i === KHALIFA[1].driver_ext_id));
  check('the two records are ONE row in the directory', mine.length === 1,
    JSON.stringify(mine.map((r) => [r.driver_name, r.platforms])));
  /* THE REPORTED SYMPTOM, inverted: "it only shows bolt trips". */
  check('…and that row names both channels',
    mine.length === 1 && ['hotel', 'uber'].every((p) => (mine[0].platforms || []).includes(p)),
    JSON.stringify(mine[0]?.platforms));
  check('…under the fuller of the two names',
    mine[0]?.driver_name === 'MUHAMMAD KHALIFA AFZAL KHALID', mine[0]?.driver_name);
  check('…carrying both accounts', (mine[0]?.ids || []).length === 2,
    JSON.stringify(mine[0]?.ids));

  /* Opening EITHER account has to land on the same person, or the directory
     and the driver page give two answers to one question. */
  for (const [which, id] of [['the hotel record', KHALIFA[0].driver_ext_id],
    ['the Uber record', KHALIFA[1].driver_ext_id]]) {
    const prof = await get(`/api/driver/profile?id=${id}&${W}`);
    check(`opening ${which} finds both accounts`,
      prof.status === 200 && (prof.body?.ids || []).length === 2,
      JSON.stringify([prof.status, prof.body?.ids]));
    check(`…under the fuller name`,
      prof.body?.name === 'MUHAMMAD KHALIFA AFZAL KHALID', String(prof.body?.name));
  }

  /* And the page that makes the rule arguable. */
  const links = await get('/api/drivers/identity-links');
  check('the links endpoint answers', links.status === 200, String(links.status));
  check('…with the link and its evidence',
    links.body.links?.length === 1 && /9547/.test(links.body.links[0].evidence),
    JSON.stringify(links.body.links?.length));
  /* THE HALF A PAGE MUST PRINT. 166 of 434 directory rows carry no phone on
     any record; a list of links that says nothing about them reads as a clean
     roster. */
  check('…and how many roster records it could not see',
    links.body.coverage && typeof links.body.coverage.without_phone === 'number',
    JSON.stringify(links.body.coverage));
  check('…and that a link does not move the stored person_key',
    /does not move person_key/.test(links.body.applies_note || ''), links.body.applies_note);

  /* THE THIRD RECORD. Bolt files no phone, so no link names his Bolt account;
     it reaches him because Bolt and the hotel channel file the same full name.
     That works while the hotel record is the survivor, which on today's roster
     it always is — and the fold must not depend on that being true. */
  await db.query(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                       requested_at, status)
     VALUES ('bolt','t-b1','ecosine','L44284','6628822',$1,'2026-09-04T10:00:00Z','completed')`,
    [KHALIFA[0].full_name]);
  const dir3 = await get(`/api/drivers/directory?${W}`);
  const three = (dir3.body || []).filter((r) => (r.ids || []).some((i) =>
    [KHALIFA[0].driver_ext_id, KHALIFA[1].driver_ext_id, '6628822'].includes(i)));
  check('a third record with no phone still lands on the same person',
    three.length === 1 && (three[0].ids || []).length === 3,
    JSON.stringify(three.map((r) => [r.driver_name, r.ids])));
  check('…and all three channels are on the row',
    three.length === 1 && ['bolt', 'hotel', 'uber'].every((p) => (three[0].platforms || []).includes(p)),
    JSON.stringify(three[0]?.platforms));

  /* And the other way round: if the UBER record were the fuller one, the link
     would run the other way and the Bolt record would carry the alias's name.
     It has to move with it. */
  {
    const { linksFrom } = await import('../src/identity_link.js');
    const flipped = linksFrom([
      { platform: 'hotel', driver_ext_id: 'h-short', full_name: 'Short Name', phone: '971500007777' },
      { platform: 'uber', driver_ext_id: 'u-long', full_name: 'Short Middle Name Longer',
        phone: '971500007777' },
    ]);
    check('the fuller name survives whichever channel filed it',
      flipped.links[0]?.canonical_ext_id === 'u-long'
      && flipped.links[0]?.alias_ext_id === 'h-short',
      JSON.stringify([flipped.links[0]?.canonical_name, flipped.links[0]?.alias_name]));
  }

  /* A rejection has to reach the pages, not just the table. */
  await db.query(`UPDATE driver_identity_link SET rejected = true, rejected_reason = 'two brothers'`);
  clearIdentityLinkCache();
  const after = await get('/api/drivers/identity-links');
  check('a rejected link leaves the applied set', after.body.links?.length === 0,
    JSON.stringify(after.body.links?.length));
  check('…and is reported separately, with the reason',
    after.body.rejected?.length === 1 && after.body.rejected[0].rejected_reason === 'two brothers',
    JSON.stringify(after.body.rejected?.[0]?.rejected_reason));
  const dir2 = await get(`/api/drivers/directory?${W}`);
  const mine2 = (dir2.body || []).filter((r) =>
    (r.ids || []).some((i) => i === KHALIFA[0].driver_ext_id || i === KHALIFA[1].driver_ext_id));
  check('…and the directory splits them again, because the person said so',
    mine2.length === 2, JSON.stringify(mine2.map((r) => r.driver_name)));
}

await db.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
