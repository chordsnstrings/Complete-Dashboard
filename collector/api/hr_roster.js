/* THE HR ROSTER, AGAINST WHAT THIS PRODUCT ALREADY HOLDS.
   ═════════════════════════════════════════════════════════════════════════
   src/hr_roster.js reads the export and checks its shape. This file does
   everything that needs the database: which platform accounts each row is,
   what the rows imply about who is one person, where they contradict a link
   this product already holds, where HR's licence date disagrees with Yango's,
   the snapshot write, and the reads the pages make.

   ── MATCHED BY A PLATFORM ID, THEN BY PHONE, NEVER BY NAME ───────────────
   An id HR typed is the provider's own key for the account and is checked
   against every table that files one. Only a row none of whose ids is held
   falls back to the phone — compared on the last nine digits, the same
   phoneKey() the identity rule uses, because HR writes +9715… on 95 rows and
   9715… on 47. A NAME is never consulted: CLAUDE.md, and the directory's
   `byName` fold that put two different fathers' sons on one row.

   ── A PROPOSAL, NEVER A MERGE, AND NEVER IN driver_identity_link ─────────
   Platform ids HR files under one employee are strong evidence and not an
   identifier the platforms share: an id pasted into the wrong row joins two
   people. So they become proposals on #same-person under basis `hr_roster`,
   in their own table. driver_identity_link was the obvious home and is the
   wrong one: src/identity_link.js DELETEs every unconfirmed row there that its
   own rules did not produce on the current run, so a proposal written there
   would be gone within the half hour. And api/identity_map.js is edited by a
   person, never by an import.

   ── THE NUMBERS ───────────────────────────────────────────────────────────
   passport_no and rta_permit_no are selected by no read in this file.
   emirates_id and licence_no are selected by exactly one, hrForProfile(),
   which feeds /api/driver/profile — the operator's decision of 2026-09-23 —
   and every other read asks `x IS NOT NULL` instead, so the value never
   becomes a string in this process. test/hr_roster_numbers.test.mjs sweeps
   every route's body for the values themselves. */
import { createHash } from 'node:crypto';
import { readRoster, exportDateFromName, dayOf, DOCS, PLATFORM_COLUMNS, COMPARED,
  docStatus, expirySummary, daysBetween, STATUS_ORDER } from '../src/hr_roster.js';
import { phoneKey } from '../src/identity_link.js';
import { personMap } from './person_map.js';
import { REFUSED, MERGES } from './identity_map.js';
import { dubaiDay } from './window.js';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const FLEET = { ecosine: 'Ecosine', egari: 'Egari' };
const PLATFORM = { uber: 'Uber', yango: 'Yango', bolt: 'Bolt', hotel: 'Hotel', yay: 'YAY',
  careem: 'Careem', cabman: 'CABMAN', fms: 'FMS' };
const RANK = { uber: 0, yango: 1, bolt: 2, hotel: 3 };
const byRank = (a, b) => ((RANK[a.platform] ?? 9) - (RANK[b.platform] ?? 9))
  || String(a.ext_id).localeCompare(String(b.ext_id));
const short = (id) => (String(id).length > 12 ? `${String(id).slice(0, 8)}…` : String(id));
const acctText = (a) => `${PLATFORM[a.platform] || a.platform} account ${short(a.ext_id)}`;
export const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
const empText = (r) => `${FLEET[r.fleet_id] || r.fleet_id} employee ${r.employee_id}`
  + (r.full_name ? ` (${r.full_name})` : '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ── WHICH ACCOUNTS EACH ROW IS ───────────────────────────────────────────
   Every table that files a provider's account id: the roster standing, the
   compliance record, the person spine, and the trips themselves (the one
   place an account with no roster entry still shows up). Trip is asked only
   about the ids in hand, on its driver_ext_id index. */
export async function matchRows(q, rows) {
  const low = (v) => String(v).toLowerCase();
  const ids = [...new Set(rows.flatMap((r) => Object.keys(PLATFORM_COLUMNS)
    .map((c) => r[c]).filter(Boolean).flatMap((v) => [String(v), low(v)])))];
  const held = new Map();
  if (ids.length) {
    const found = await q(
      `SELECT platform, ext_id, max(fleet_id) AS fleet_id, max(name) AS name FROM (
         SELECT platform, driver_ext_id AS ext_id, fleet_id, full_name AS name
           FROM driver_platform_state WHERE lower(driver_ext_id) = ANY($1::text[])
         UNION ALL
         SELECT platform, driver_ext_id, fleet_id, full_name
           FROM driver_compliance WHERE lower(driver_ext_id) = ANY($1::text[])
         UNION ALL
         SELECT platform, external_id, NULL, display_name
           FROM driver_platform_id WHERE detached_at IS NULL AND lower(external_id) = ANY($1::text[])
         UNION ALL
         SELECT DISTINCT platform, driver_ext_id, fleet_id, driver_name
           FROM trip WHERE driver_ext_id = ANY($1::text[])
       ) x GROUP BY platform, ext_id`, [ids]);
    for (const a of found) held.set(`${a.platform}\u0000${String(a.ext_id).toLowerCase()}`, a);
  }
  /* The phone index, over every record that files one. */
  const byPhone = new Map();
  for (const a of await q(
    `SELECT platform, driver_ext_id AS ext_id, fleet_id, full_name AS name, phone
       FROM driver_compliance WHERE coalesce(btrim(phone), '') <> ''`)) {
    const k = phoneKey(a.phone);
    if (!k) continue;
    if (!byPhone.has(k)) byPhone.set(k, []);
    byPhone.get(k).push(a);
  }
  return rows.map((r) => {
    const byId = [];
    const unmatched = [];
    for (const [col, platform] of Object.entries(PLATFORM_COLUMNS)) {
      if (!r[col]) continue;
      const a = held.get(`${platform}\u0000${low(r[col])}`);
      if (a) {
        byId.push({ platform, ext_id: a.ext_id, via: col, fleet_id: a.fleet_id || null,
          name: a.name || null });
      } else unmatched.push({ platform, column: col });
    }
    const pk = phoneKey(r.phone);
    const byTel = !byId.length && pk ? (byPhone.get(pk) || []).map((a) => ({
      platform: a.platform, ext_id: a.ext_id, via: 'phone', fleet_id: a.fleet_id || null,
      name: a.name || null })) : [];
    const accounts = byId.length ? byId : byTel;
    return {
      ...r,
      accounts,
      match_basis: byId.length ? 'platform_id' : byTel.length ? 'phone' : 'none',
      unmatched_ids: unmatched,
      /* An id the database files under the OTHER fleet. Zero on the first
         export; counted so the day it is not zero is visible. */
      fleet_mismatch: byId.some((a) => a.fleet_id && r.fleet_id && a.fleet_id !== r.fleet_id),
    };
  });
}

/* ── WHO THIS PRODUCT ALREADY SAYS IS ONE PERSON, OR TWO ──────────────────
   Three sources of "one person" — the link table (every row that is not
   rejected, confirmed or not, because an unconfirmed link is still a claim a
   reviewer is looking at), the hand-reviewed register, and the materialised
   spine — and two of "two people": the register's REFUSED list and every
   link a person rejected on #same-person.

   `same()` answers "already one person" from the APPLIED joins only — the
   spine, the register, and links that are conclusive or confirmed — because
   that is what every page folds on. An unconfirmed name proposal is not an
   answer, and a pair it proposes is still a pair HR's evidence can speak to. */
export async function identityContext(q) {
  const spine = await personMap(q);
  let links = [];
  let linksOk = true;
  try {
    links = await q(
      `SELECT alias_ext_id, alias_platform, canonical_ext_id, canonical_platform, basis,
              confirmed_at, confirmed_by, rejected, rejected_reason
         FROM driver_identity_link`);
  } catch { linksOk = false; links = []; }

  const refused = new Map();
  for (const r of REFUSED) {
    refused.set(pairKey(r.a.id, r.b.id), { source: 'register', why: r.why });
  }
  for (const l of links.filter((x) => x.rejected)) {
    refused.set(pairKey(l.alias_ext_id, l.canonical_ext_id), { source: 'same-person',
      why: l.rejected_reason || 'ruled two people on #same-person' });
  }

  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
    let c = x;
    while (parent.has(c) && parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; }
    return r;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  /* Every join, applied or proposed, with where it came from — the
     contradiction check reads all of them. */
  const edges = [];
  for (const l of links.filter((x) => !x.rejected)) {
    const applied = ['shared_phone', 'shared_email'].includes(l.basis) || l.confirmed_at != null;
    edges.push({ a: l.alias_ext_id, a_platform: l.alias_platform, b: l.canonical_ext_id,
      b_platform: l.canonical_platform, source: 'link', basis: l.basis,
      confirmed: l.confirmed_at != null, confirmed_by: l.confirmed_by || null, applied });
    if (applied) union(l.alias_ext_id, l.canonical_ext_id);
  }
  for (const m of MERGES) {
    const ids = (m.merge?.ids || [m.merge?.id]).filter(Boolean);
    for (const id of ids) {
      edges.push({ a: id, a_platform: null, b: m.keep.id, b_platform: null, source: 'register',
        basis: m.basis || 'register', confirmed: true, applied: true });
      union(id, m.keep.id);
    }
  }
  if (spine.ok) {
    for (const p of spine.person.values()) {
      const [first, ...rest] = p.accounts;
      for (const a of rest) {
        edges.push({ a: a.ext_id, a_platform: a.platform, b: first.ext_id, b_platform: first.platform,
          source: 'spine', basis: a.basis || 'spine', confirmed: true, applied: true });
        union(a.ext_id, first.ext_id);
      }
    }
  }
  const same = (a, b) => a === b || (parent.has(a) && parent.has(b) && find(a) === find(b));
  return { ok: spine.ok && linksOk, spine, links, refused, edges, same, rep: (a) => (parent.has(a) ? find(a) : a) };
}

/* ── WHAT HR'S ROWS PROPOSE ───────────────────────────────────────────────
   For each employee holding two or more accounts matched BY PLATFORM ID —
   HR's own grouping; a phone match is this product's inference, not HR's
   claim — one pair per account that is not already the same person as the
   first. Accounts already folded together are one component and are proposed
   once, by their first member, so a reviewer is not asked the same question
   twice in two spellings. */
export function proposalsOf(matched, ctx, exportDate) {
  const out = [];
  let alreadyOne = 0;
  let people = 0;
  for (const r of matched) {
    const accts = r.accounts.filter((a) => a.via !== 'phone').slice().sort(byRank);
    if (accts.length < 2) continue;
    const anchor = accts[0];
    const seenComp = new Set([ctx.rep(anchor.ext_id)]);
    let any = false;
    for (const a of accts.slice(1)) {
      if (ctx.same(anchor.ext_id, a.ext_id)) { alreadyOne += 1; continue; }
      const comp = ctx.rep(a.ext_id);
      if (seenComp.has(comp)) continue;
      seenComp.add(comp);
      any = true;
      out.push({
        fleet_id: r.fleet_id, employee_id: r.employee_id, employee_name: r.full_name || null,
        alias_platform: a.platform, alias_ext_id: a.ext_id, alias_name: a.name,
        canonical_platform: anchor.platform, canonical_ext_id: anchor.ext_id, canonical_name: anchor.name,
        accounts: accts.map((x) => ({ platform: x.platform, ext_id: x.ext_id })),
        evidence: `HR's roster (export of ${exportDate}) files ${accts.map(acctText).join(', ')} `
          + `under one employee, ${empText(r)}. Each was matched by the platform id HR typed, never `
          + 'by a name. An employer\'s roster is strong evidence but it is not an identifier the '
          + 'platforms share — an id pasted into the wrong row joins two people — so nothing has '
          + 'been merged. This asks.',
      });
    }
    if (any) people += 1;
  }
  return { pairs: out, people, already_one: alreadyOne };
}

/* ── WHERE HR CONTRADICTS WHAT IS ALREADY HELD ────────────────────────────
   Four shapes, each a sentence a reviewer can check:

     link_joins_two_employees  a link, merge or spine person joins two
                               accounts HR lists under two employees
     link_to_refused_partner   a link attaches an account HR lists to a
                               record this product has RULED a different
                               person from one HR lists beside it
     hr_groups_refused         HR lists under one employee two accounts this
                               product has ruled two people
     hr_lists_account_twice    one account id on two HR rows

   The second is the shape the 2026-09-23 export found: an unconfirmed
   `same_name` link attaching a Yango account to one member of a refused
   pair, while HR files that Yango account with the OTHER member. */
export function contradictionsOf(matched, ctx) {
  const owners = new Map();
  for (const r of matched) {
    for (const a of r.accounts.filter((x) => x.via !== 'phone')) {
      if (!owners.has(a.ext_id)) owners.set(a.ext_id, []);
      owners.get(a.ext_id).push(r);
    }
  }
  const out = [];
  const seen = new Set();
  const push = (c, dedupe) => { if (!seen.has(dedupe)) { seen.add(dedupe); out.push(c); } };
  const accOf = (id, platform) => ({ platform: platform || null, ext_id: id });
  /* "Confirmed" is said with who, because it matters: on the 2026-09-23
     export the one contradiction was a `same_name` link carrying a
     confirmed_at and NO confirmed_by — stamped, not reviewed by anybody the
     table names. */
  const linkText = (e) => (e.source === 'link'
    ? `${e.confirmed ? (e.confirmed_by ? `confirmed (by ${e.confirmed_by})` : 'confirmed (no reviewer recorded)')
      : 'unconfirmed'} “${e.basis}” link`
    : e.source === 'register' ? 'entry in the merge register (api/identity_map.js)'
      : 'person record on the spine');
  const emp = (r) => ({ fleet_id: r.fleet_id, employee_id: r.employee_id, name: r.full_name || null });

  for (const [id, rs] of owners) {
    const keys = new Set(rs.map((r) => `${r.fleet_id}\u0000${r.employee_id}`));
    if (keys.size > 1) {
      push({ kind: 'hr_lists_account_twice', employees: rs.map(emp), accounts: [accOf(id)], link: null,
        evidence: `HR files the same account, ${short(id)}, under ${rs.map(empText).join(' and ')}. `
          + 'One of those rows carries somebody else\'s id.' }, `twice\u0000${id}`);
    }
  }
  const ranked = { link: 0, register: 1, spine: 2 };
  const edges = ctx.edges.slice().sort((x, y) => ranked[x.source] - ranked[y.source]);
  for (const e of edges) {
    const oa = owners.get(e.a) || [];
    const ob = owners.get(e.b) || [];
    if (oa.length && ob.length) {
      const ka = new Set(oa.map((r) => `${r.fleet_id}\u0000${r.employee_id}`));
      if (ob.some((r) => ka.has(`${r.fleet_id}\u0000${r.employee_id}`))) continue;
      /* …and whether HR's grouping of either end sits beside a record this
         product has RULED a different person from the other end. That is the
         shape the first export found: the link joins a Yango account to one
         member of a refused pair, and HR files that Yango account with the
         OTHER member. Said, because it is what makes the link, not HR, the
         likelier one to be wrong. */
      const ruled = [];
      for (const [mine, other] of [[e.a, e.b], [e.b, e.a]]) {
        for (const r of owners.get(mine)) {
          for (const x of r.accounts.filter((y) => y.via !== 'phone' && y.ext_id !== mine)) {
            const ref = ctx.refused.get(pairKey(other, x.ext_id));
            if (ref) ruled.push(`HR files ${short(mine)} with ${acctText(x)}, which this product has ruled a `
              + `different person from ${short(other)} (${ref.why})`);
          }
        }
      }
      push({ kind: 'link_joins_two_employees', employees: [emp(oa[0]), emp(ob[0])],
        accounts: [accOf(e.a, e.a_platform), accOf(e.b, e.b_platform)],
        link: { source: e.source, alias_ext_id: e.a, canonical_ext_id: e.b, basis: e.basis,
          confirmed: e.confirmed, confirmed_by: e.confirmed_by || null },
        touches_refused_pair: ruled.length > 0,
        evidence: `An existing ${linkText(e)} joins ${short(e.a)} and ${short(e.b)} as one person; `
          + `HR lists them under two employees — ${empText(oa[0])} and ${empText(ob[0])}.`
          + (ruled.length ? ` ${ruled.join('; ')}. Either the link is wrong or HR's rows are.` : '') },
      `pair\u0000${pairKey(e.a, e.b)}`);
      continue;
    }
    /* One end on HR's list, the other not: is the other end a record this
       product has ruled a DIFFERENT person from someone HR lists beside the
       first? */
    const [mine, other, otherPlat] = oa.length ? [e.a, e.b, e.b_platform] : ob.length
      ? [e.b, e.a, e.a_platform] : [null, null, null];
    if (!mine) continue;
    for (const r of owners.get(mine)) {
      for (const x of r.accounts.filter((y) => y.via !== 'phone' && y.ext_id !== mine)) {
        const ref = ctx.refused.get(pairKey(other, x.ext_id));
        if (!ref) continue;
        push({ kind: 'link_to_refused_partner', employees: [emp(r)],
          accounts: [accOf(mine), accOf(other, otherPlat), { platform: x.platform, ext_id: x.ext_id }],
          link: { source: e.source, alias_ext_id: e.a, canonical_ext_id: e.b, basis: e.basis,
            confirmed: e.confirmed, confirmed_by: e.confirmed_by || null },
          touches_refused_pair: true,
          evidence: `An existing ${linkText(e)} attaches ${short(mine)} to ${short(other)}. HR files `
            + `${short(mine)} with ${acctText(x)} under ${empText(r)} — and ${short(other)} and `
            + `${short(x.ext_id)} are a pair this product has ruled two people (${ref.why}). `
            + 'Both cannot be right: either the link is wrong or HR\'s row is.' },
        `refp\u0000${pairKey(e.a, e.b)}\u0000${x.ext_id}`);
      }
    }
  }
  for (const r of matched) {
    const accts = r.accounts.filter((x) => x.via !== 'phone');
    for (let i = 0; i < accts.length; i += 1) {
      for (let j = i + 1; j < accts.length; j += 1) {
        const ref = ctx.refused.get(pairKey(accts[i].ext_id, accts[j].ext_id));
        if (!ref) continue;
        push({ kind: 'hr_groups_refused', employees: [emp(r)],
          accounts: [accts[i], accts[j]].map((a) => ({ platform: a.platform, ext_id: a.ext_id })), link: null,
          evidence: `HR files ${acctText(accts[i])} and ${acctText(accts[j])} under one employee, `
            + `${empText(r)} — and this product has ruled them two people (${ref.why}).` },
        `grp\u0000${pairKey(accts[i].ext_id, accts[j].ext_id)}`);
      }
    }
  }
  return out;
}

/* ── HR'S LICENCE DATE AGAINST YANGO'S ────────────────────────────────────
   Yango is the only other source of a licence expiry, and on the first
   export 34 of its 59 dates were about five years older than HR's: renewals
   Yango's profile never picked up. Compared against every Yango account a
   row matched, by id or by phone. */
export async function licenceVsYango(q, matched, today) {
  const ids = [...new Set(matched.flatMap((r) => r.accounts.filter((a) => a.platform === 'yango')
    .map((a) => a.ext_id)))];
  const yango = new Map(ids.length ? (await q(
    `SELECT driver_ext_id, to_char(licence_expires, 'YYYY-MM-DD') AS licence_expires
       FROM driver_compliance
      WHERE platform = 'yango' AND licence_expires IS NOT NULL AND driver_ext_id = ANY($1::text[])`,
    [ids])).map((r) => [r.driver_ext_id, r.licence_expires]) : []);
  const s = { compared: 0, agree: 0, differ: 0, yango_older: 0, yango_later: 0,
    yango_older_by_over_a_year: 0, hr_valid_yango_expired: 0, rows: [] };
  for (const r of matched) {
    if (!r.licence_expires) continue;
    for (const a of r.accounts.filter((x) => x.platform === 'yango')) {
      const y = yango.get(a.ext_id);
      if (!y) continue;
      s.compared += 1;
      const gap = daysBetween(y, r.licence_expires);
      if (gap === 0) { s.agree += 1; continue; }
      s.differ += 1;
      if (gap > 0) s.yango_older += 1; else s.yango_later += 1;
      if (gap > 365) s.yango_older_by_over_a_year += 1;
      const hrLeft = daysBetween(today, r.licence_expires);
      const yLeft = daysBetween(today, y);
      if (hrLeft >= 0 && yLeft < 0) s.hr_valid_yango_expired += 1;
      s.rows.push({ fleet_id: r.fleet_id, employee_id: r.employee_id, name: r.full_name || null,
        yango_ext_id: a.ext_id, hr_expires: r.licence_expires, yango_expires: y,
        days_apart: gap });
    }
  }
  return s;
}

/* ── THE UPLOADS ──────────────────────────────────────────────────────────
   Ordered by the day HR exported them, then by arrival: an older export
   uploaded late is history, not the current list. */
export async function uploads(q) {
  return q(`SELECT id, sha256, to_char(export_date, 'YYYY-MM-DD') AS export_date, export_date_from,
                   filename, byte_len, rows_read, uploaded_by, uploaded_at
              FROM hr_roster_upload ORDER BY export_date DESC, id DESC`);
}

/* The columns an earlier upload is compared on, as PRESENCE. The "went
   blank" report needs to know a value was there and is not now; it never
   needs the value, so it never reads one. */
const PRESENCE = COMPARED.map(({ col }) => `(${col} IS NOT NULL) AS ${col}`).join(', ');

async function diffAgainst(q, base, rows) {
  const prev = await q(
    `SELECT fleet_id, employee_id, full_name AS name_kept, ${PRESENCE}
       FROM hr_roster_row WHERE upload_id = $1`, [base.id]);
  const now = new Map(rows.map((r) => [`${r.fleet_id}\u0000${r.employee_id}`, r]));
  const was = new Map(prev.map((r) => [`${r.fleet_id}\u0000${r.employee_id}`, r]));
  const blanked = [];
  for (const { heading, col } of COMPARED) {
    const who = [];
    for (const [k, p] of was) {
      const n = now.get(k);
      if (n && p[col] && n[col] == null) who.push(n.employee_id);
    }
    if (who.length) blanked.push({ column: heading, rows: who.length, employees: who.slice(0, 20) });
  }
  const dropped = [...was.entries()].filter(([k]) => !now.has(k))
    .map(([, p]) => ({ fleet_id: p.fleet_id, employee_id: p.employee_id, name: p.name_kept }));
  const added = [...now.keys()].filter((k) => !was.has(k)).length;
  return { against: { upload_id: Number(base.id), export_date: base.export_date }, blanked,
    dropped, added,
    note: blanked.length
      ? 'A column that is filled in the earlier export and blank in this one is REPORTED, not '
        + 'read as documents vanishing: the roster page keeps showing the earlier value, marked as '
        + 'coming from the earlier export, until HR files a new one.'
      : null };
}

const isDay = (v) => dayOf(v).ok && dayOf(v).day === String(v || '').trim();

/* ── THE PREVIEW ──────────────────────────────────────────────────────────
   Everything the commit would do, computed and not written. Shared with the
   commit, which runs it again inside its transaction — so what was shown is
   what is written, not a second opinion computed by different code. No
   document number is in what this returns: the rows it read are never put on
   the result, only counts, ids of accounts and employees, and dates. */
export async function previewOf(q, bytes, { filename = null, exportDate = null, today = null } = {}) {
  const day = today || dubaiDay(new Date());
  const sha = sha256(bytes);
  const parsed = readRoster(bytes);
  const refusals = [...parsed.refusals];
  const fromName = exportDateFromName(filename);
  const entered = exportDate ? String(exportDate).trim() : null;
  let exportDay = null;
  let exportFrom = null;
  let needDate = false;
  if (entered && !isDay(entered)) refusals.push(`“${entered}” is not a YYYY-MM-DD date`);
  if (fromName) {
    exportDay = fromName; exportFrom = 'filename';
    if (entered && isDay(entered) && entered !== fromName) {
      refusals.push(`the filename says HR exported this on ${fromName} and the date entered is `
        + `${entered}. One of them is wrong; the filename is what HR's system wrote.`);
    }
  } else if (entered && isDay(entered)) {
    exportDay = entered; exportFrom = 'entered';
  } else {
    needDate = true;
    refusals.push('the filename does not carry the export date (HR names it '
      + 'active-drivers-YYYY-MM-DD.xlsx), so enter the day HR exported it');
  }
  if (exportDay && exportDay > day) {
    refusals.push(`the export date ${exportDay} is after today in Dubai (${day})`);
  }
  const [dupe] = await q(
    `SELECT id, to_char(export_date, 'YYYY-MM-DD') AS export_date, uploaded_by, uploaded_at
       FROM hr_roster_upload WHERE sha256 = $1`, [sha]);
  if (dupe) {
    refusals.push(`this exact file was already imported — upload ${dupe.id}, the export of `
      + `${dupe.export_date}, by ${dupe.uploaded_by}. The same bytes twice are not a second snapshot.`);
  }
  const base = { sha256: sha, byte_len: bytes.length, filename, export_date: exportDay,
    export_date_from: exportFrom, needs_export_date: needDate, today: day,
    rows_read: parsed.rows.length, duplicate_of: dupe ? Number(dupe.id) : null };
  if (!parsed.ok || refusals.length) {
    return { ok: false, ...base, refusals, written: false,
      note: 'Nothing was written. Every reason above has to be answered before this file can be '
        + 'imported.' };
  }

  const matched = await matchRows(q, parsed.rows);
  const ctx = await identityContext(q);
  const props = proposalsOf(matched, ctx, exportDay);
  const known = new Map((await q(
    `SELECT fleet_id, employee_id, alias_ext_id, canonical_ext_id, verdict FROM hr_roster_proposal`))
    .map((p) => [`${p.fleet_id}\u0000${p.employee_id}\u0000${p.alias_ext_id}\u0000${p.canonical_ext_id}`, p]));
  const keyOf = (p) => `${p.fleet_id}\u0000${p.employee_id}\u0000${p.alias_ext_id}\u0000${p.canonical_ext_id}`;
  const contradictions = contradictionsOf(matched, ctx);
  const yango = await licenceVsYango(q, matched, day);
  const all = await uploads(q);
  const latest = all[0] || null;
  const baseUpload = all.find((u) => u.export_date <= exportDay) || null;
  const diff = baseUpload ? await diffAgainst(q, baseUpload, parsed.rows) : null;

  const fleets = {};
  for (const r of parsed.rows) fleets[r.fleet_id] = (fleets[r.fleet_id] || 0) + 1;
  const count = (b) => matched.filter((r) => r.match_basis === b).length;
  const unheld = {};
  for (const r of matched) for (const u of r.unmatched_ids) unheld[u.platform] = (unheld[u.platform] || 0) + 1;
  const out = {
    ok: true, ...base, refusals: [], written: false,
    fleet_split: fleets,
    match: {
      by_platform_id: count('platform_id'), by_phone: count('phone'), unmatched: count('none'),
      fleet_disagreements: matched.filter((r) => r.fleet_mismatch).length,
      ids_not_held: unheld,
      how: 'By a platform id HR typed first; by phone (last nine digits) only for a row none of '
        + 'whose ids is held; never by name.',
    },
    proposals: {
      pairs: props.pairs.length,
      people: props.people,
      new: props.pairs.filter((p) => !known.has(keyOf(p))).length,
      already_proposed: props.pairs.filter((p) => known.has(keyOf(p)) && !known.get(keyOf(p)).verdict).length,
      already_decided: props.pairs.filter((p) => known.get(keyOf(p))?.verdict).length,
      already_one_person: props.already_one,
      list: props.pairs.map((p) => ({ fleet_id: p.fleet_id, employee_id: p.employee_id,
        name: p.employee_name, accounts: p.accounts,
        alias: { platform: p.alias_platform, ext_id: p.alias_ext_id },
        canonical: { platform: p.canonical_platform, ext_id: p.canonical_ext_id },
        status: known.get(keyOf(p))?.verdict || (known.has(keyOf(p)) ? 'pending' : 'new') })),
      note: 'Proposals go to the same-person queue under basis hr_roster. None is a merge.',
    },
    contradictions,
    licence_vs_yango: yango,
    expiry: expirySummary(parsed.rows, day),
    emirates_id_not_15_digits: parsed.notes.eid_not_15_digits || 0,
    against: diff,
    latest_on_file: latest ? { upload_id: Number(latest.id), export_date: latest.export_date } : null,
    older_than_latest: Boolean(latest && exportDay < latest.export_date),
    note: 'Nothing was written. Commit sends this same file again and writes exactly this.',
  };
  /* The rows themselves, for the commit — never serialised. Non-enumerable,
     so JSON.stringify of this preview cannot carry a document number even if
     a caller forgets to strip it, and a spread of it (`{ ...p }`) drops it. */
  Object.defineProperty(out, '_internal', { value: { matched, props }, enumerable: false });
  return out;
}

/* The counts a committed upload keeps as its summary. */
const summaryOf = (p) => ({
  fleet_split: p.fleet_split, match: p.match,
  proposals: { pairs: p.proposals.pairs, people: p.proposals.people, new: p.proposals.new },
  contradictions: p.contradictions.length,
  licence_vs_yango: { compared: p.licence_vs_yango.compared, differ: p.licence_vs_yango.differ,
    yango_older_by_over_a_year: p.licence_vs_yango.yango_older_by_over_a_year,
    hr_valid_yango_expired: p.licence_vs_yango.hr_valid_yango_expired },
  expiry: p.expiry,
  blanked: p.against ? p.against.blanked.map((b) => ({ column: b.column, rows: b.rows })) : [],
  dropped: p.against ? p.against.dropped.length : 0,
});

const ROW_COLS = ['upload_id', 'fleet_id', 'employee_id', 'full_name', 'phone', 'email',
  'hr_compliance_status', 'passport_no', 'passport_expires', 'emirates_id', 'emirates_id_expires',
  'licence_no', 'licence_expires', 'visa_expires', 'rta_permit_no', 'rta_permit_expires',
  'uber_id', 'careem_id', 'bolt_id', 'yango_id', 'yay_id', 'match_basis', 'matched_accounts'];
const DATE_COLS = new Set(['passport_expires', 'emirates_id_expires', 'licence_expires',
  'visa_expires', 'rta_permit_expires']);

/* ── THE COMMIT ───────────────────────────────────────────────────────────
   One transaction: the upload, every row, the proposals. The preview is run
   again INSIDE it, so a file that stopped being importable between preview
   and commit — the same bytes committed from a second tab — is refused here
   rather than written twice. Every JSONB value is bound as a string (the
   trap in docs/COVERAGE.md: an array binds as a Postgres array literal on
   node-postgres and is refused by a JSONB column; PGlite accepts it). */
export async function commitRoster(tq, bytes, { filename, exportDate, by, ip, expectSha, today }) {
  const p = await previewOf(tq, bytes, { filename, exportDate, today });
  if (!p.ok) return { ok: false, status: p.duplicate_of ? 409 : 400, preview: p };
  if (expectSha && expectSha !== p.sha256) {
    return { ok: false, status: 409, preview: { ...p, ok: false,
      refusals: ['this is not the file that was previewed — its sha256 differs. Preview it again.'] } };
  }
  const { matched, props } = p._internal;
  const [u] = await tq(
    `INSERT INTO hr_roster_upload
       (sha256, export_date, export_date_from, filename, byte_len, rows_read, uploaded_by,
        uploaded_ip, summary)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING id`,
    [p.sha256, p.export_date, p.export_date_from, filename || null, p.byte_len, p.rows_read,
      by, ip || null, JSON.stringify(summaryOf(p))]);
  const uploadId = Number(u.id);
  const rowVals = matched.map((r) => ROW_COLS.map((c) => {
    if (c === 'upload_id') return uploadId;
    if (c === 'matched_accounts') {
      return JSON.stringify(r.accounts.map((a) => ({ platform: a.platform, ext_id: a.ext_id,
        via: a.via, fleet_id: a.fleet_id, name: a.name })));
    }
    return r[c] ?? null;
  }));
  const per = ROW_COLS.length;
  const cast = (c, i) => `$${i}${DATE_COLS.has(c) ? '::date' : c === 'matched_accounts' ? '::jsonb' : ''}`;
  for (let s = 0; s < rowVals.length; s += 200) {
    const chunk = rowVals.slice(s, s + 200);
    const tuples = chunk.map((_, k) => `(${ROW_COLS.map((c, j) => cast(c, k * per + j + 1)).join(',')})`);
    await tq(`INSERT INTO hr_roster_row (${ROW_COLS.join(',')}) VALUES ${tuples.join(',')}`, chunk.flat());
  }
  let proposalsNew = 0;
  for (const x of props.pairs) {
    const [row] = await tq(
      `INSERT INTO hr_roster_proposal
         (fleet_id, employee_id, alias_platform, alias_ext_id, canonical_platform,
          canonical_ext_id, evidence, first_upload_id, last_upload_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
       ON CONFLICT (fleet_id, employee_id, alias_ext_id, canonical_ext_id) DO UPDATE SET
         evidence = EXCLUDED.evidence,
         last_upload_id = GREATEST(hr_roster_proposal.last_upload_id, EXCLUDED.last_upload_id)
       RETURNING (xmax = 0) AS inserted`,
      [x.fleet_id, x.employee_id, x.alias_platform, x.alias_ext_id, x.canonical_platform,
        x.canonical_ext_id, x.evidence, uploadId]);
    if (row?.inserted) proposalsNew += 1;
  }
  return { ok: true, status: 200, upload_id: uploadId, preview: p,
    wrote: { rows: matched.length, proposals: props.pairs.length, proposals_new: proposalsNew } };
}

/* ── READING IT BACK ──────────────────────────────────────────────────────
   Every column the pages may see, and for each document number only whether
   one is on file. */
const PUBLIC_COLS = `r.upload_id, r.fleet_id, r.employee_id, r.full_name, r.phone, r.email,
  r.hr_compliance_status, r.uber_id, r.careem_id, r.bolt_id, r.yango_id, r.yay_id,
  r.match_basis, r.matched_accounts,
  to_char(r.passport_expires, 'YYYY-MM-DD') AS passport_expires,
  to_char(r.emirates_id_expires, 'YYYY-MM-DD') AS emirates_id_expires,
  to_char(r.licence_expires, 'YYYY-MM-DD') AS licence_expires,
  to_char(r.visa_expires, 'YYYY-MM-DD') AS visa_expires,
  to_char(r.rta_permit_expires, 'YYYY-MM-DD') AS rta_permit_expires,
  (r.passport_no IS NOT NULL) AS passport_on_file,
  (r.emirates_id IS NOT NULL) AS emirates_id_on_file,
  (r.licence_no IS NOT NULL) AS licence_on_file,
  (r.rta_permit_no IS NOT NULL) AS rta_permit_on_file,
  to_char(u.export_date, 'YYYY-MM-DD') AS export_date`;

const accountsOf = (v) => {
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v || '[]'); } catch { return []; }
};

/* Why an HR platform id is not matched — measured, never assumed. */
async function unheldReasons(q) {
  let bolt = [];
  try {
    bolt = await q(
      `SELECT fleet_id, count(*) FILTER (WHERE driver_ext_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-')::int AS uuids
         FROM driver_platform_state WHERE platform = 'bolt' GROUP BY fleet_id`);
  } catch { bolt = []; }
  const boltUuids = new Map(bolt.map((b) => [b.fleet_id, b.uuids]));
  return (u, fleet) => {
    if (u.platform === 'yay') return 'nothing in this product collects YAY, so a YAY id cannot be matched to anything';
    if (u.platform === 'careem') return 'nothing in this product collects Careem';
    if (u.platform === 'bolt' && !(boltUuids.get(fleet) > 0)) {
      return `no ${FLEET[fleet] || fleet} Bolt account is held under Bolt's user UUID — Bolt's `
        + 'fleet roster, the one source that files it, is refused for this fleet — so this id '
        + 'cannot be matched until it is';
    }
    return `no ${PLATFORM[u.platform] || u.platform} account with this id is held in anything collected`;
  };
}

/* The whole roster as the page sees it: one entry per (fleet, employee_id)
   ever uploaded, the latest upload's people first and the ones a newer
   upload dropped marked "off the HR list since". */
export async function rosterView(q, { today = null } = {}) {
  const day = today || dubaiDay(new Date());
  const ups = await uploads(q);
  if (!ups.length) {
    return { latest: null, uploads: [], people: [], totals: null, today: day,
      absent_reason: 'No HR roster has been uploaded yet. Nothing on this page can be counted until '
        + 'one is — the figures are absent, not zero.' };
  }
  const order = [...ups].reverse();                // oldest export first
  const pos = new Map(order.map((u, i) => [Number(u.id), i]));
  const latest = ups[0];
  const rows = await q(
    `SELECT ${PUBLIC_COLS} FROM hr_roster_row r JOIN hr_roster_upload u ON u.id = r.upload_id
      ORDER BY u.export_date, u.id`);
  const spine = await personMap(q);
  const reason = await unheldReasons(q);
  const byEmp = new Map();
  for (const r of rows) {
    const k = `${r.fleet_id}\u0000${r.employee_id}`;
    if (!byEmp.has(k)) byEmp.set(k, []);
    byEmp.get(k).push(r);
  }
  const people = [];
  for (const hist of byEmp.values()) {
    hist.sort((a, b) => pos.get(Number(a.upload_id)) - pos.get(Number(b.upload_id)));
    const last = hist[hist.length - 1];
    const lastPos = pos.get(Number(last.upload_id));
    const onList = Number(last.upload_id) === Number(latest.id);
    const offSince = onList ? null : (order[lastPos + 1]?.export_date || null);
    const documents = {};
    const renewals = [];
    for (const doc of DOCS) {
      /* A blank in the latest export is REPORTED, not read as the document
         vanishing: the last value HR filed is kept and marked with the export
         it came from. */
      const withDate = [...hist].reverse().find((h) => h[doc.expires]);
      const expires = withDate ? withDate[doc.expires] : null;
      const st = docStatus(expires, day);
      const onFileRow = doc.number ? [...hist].reverse().find((h) => h[`${doc.key}_on_file`]) : null;
      documents[doc.key] = {
        expires, days_left: st.days_left, status: st.status,
        expires_from_export: withDate && withDate !== last ? withDate.export_date : null,
        number_on_file: doc.number ? Boolean(onFileRow) : null,
        number_from_export: onFileRow && onFileRow !== last ? onFileRow.export_date : null,
        absent_reason: expires ? null
          : `no HR export on file carries a ${doc.label.toLowerCase()} expiry for this person`,
      };
      let prev = null;
      for (const h of hist) {
        const v = h[doc.expires];
        if (!v) continue;
        if (prev && v !== prev) renewals.push({ document: doc.key, from: prev, to: v, seen_in_export: h.export_date });
        prev = v;
      }
    }
    const accounts = accountsOf(last.matched_accounts).map((a) => ({ ...a,
      person_id: spine.ok ? (spine.byAccount.get(a.ext_id) ?? null) : null }));
    const pids = [...new Set(accounts.map((a) => a.person_id).filter((x) => x != null))];
    const heldIds = new Set(accounts.map((a) => `${a.platform}\u0000${String(a.ext_id).toLowerCase()}`));
    const unmatched = Object.entries(PLATFORM_COLUMNS).filter(([col, plat]) => last[col]
      && !heldIds.has(`${plat}\u0000${String(last[col]).toLowerCase()}`))
      .map(([col, plat]) => ({ platform: plat, ext_id: last[col], column: col,
        reason: reason({ platform: plat }, last.fleet_id) }));
    const live = Object.entries(documents).filter(([, d]) => ['expired', 'd30', 'd45', 'd90'].includes(d.status));
    const soonest = Object.entries(documents).filter(([, d]) => d.days_left != null)
      .sort((a, b) => a[1].days_left - b[1].days_left)[0] || null;
    people.push({
      fleet_id: last.fleet_id, employee_id: last.employee_id, name: last.full_name,
      phone: last.phone, email: last.email,
      hr_compliance_status: last.hr_compliance_status,
      on_list: onList, off_list_since: offSince, last_export_date: last.export_date,
      first_export_date: hist[0].export_date,
      match_basis: last.match_basis, accounts,
      person_id: pids.length === 1 ? pids[0] : null,
      person_ids: pids,
      unmatched_ids: unmatched,
      documents, renewals,
      anything_expiring: live.length > 0,
      soonest: soonest ? { document: soonest[0], days_left: soonest[1].days_left, status: soonest[1].status } : null,
    });
  }
  people.sort((a, b) => (Number(b.on_list) - Number(a.on_list))
    || ((a.soonest?.days_left ?? Infinity) - (b.soonest?.days_left ?? Infinity))
    || String(a.name || '').localeCompare(String(b.name || '')));
  const on = people.filter((p) => p.on_list);
  const expiring = Object.fromEntries(DOCS.map((d) => [d.key,
    Object.fromEntries(STATUS_ORDER.map((s) => [s, on.filter((p) => p.documents[d.key].status === s).length]))]));
  return {
    latest: { upload_id: Number(latest.id), export_date: latest.export_date, sha256: latest.sha256,
      rows_read: latest.rows_read, uploaded_by: latest.uploaded_by, uploaded_at: latest.uploaded_at },
    uploads: ups.map((u) => ({ ...u, id: Number(u.id) })),
    today: day,
    people,
    totals: {
      on_list: on.length,
      off_list: people.length - on.length,
      by_fleet: Object.fromEntries(['ecosine', 'egari'].map((f) => [f, on.filter((p) => p.fleet_id === f).length])),
      matched: { platform_id: on.filter((p) => p.match_basis === 'platform_id').length,
        phone: on.filter((p) => p.match_basis === 'phone').length,
        none: on.filter((p) => p.match_basis === 'none').length },
      anything_expiring: on.filter((p) => p.anything_expiring).length,
      expiring,
    },
    absent_reason: null,
  };
}

/* What /api/compliance/drivers needs: the people on the LATEST export, each
   with the accounts they matched and their documents — expiry dates and
   whether a number is on file, never a number. */
export async function hrForCompliance(q, { today = null } = {}) {
  const v = await rosterView(q, { today });
  if (!v.latest) return { latest: null, people: [], absent_reason: v.absent_reason };
  return { latest: v.latest, people: v.people.filter((p) => p.on_list), absent_reason: null };
}

/* ── THE ONE READ THAT SELECTS NUMBERS ────────────────────────────────────
   For /api/driver/profile, and only that route: the Emirates ID and the UAE
   licence number HR filed for the person whose accounts are `ids`, with
   HR's licence expiry. The operator's decision, 2026-09-23 — the driver page
   is where these two are shown. Passport and RTA-permit numbers are not
   selected here or anywhere. */
const eidText = (d) => (/^\d{15}$/.test(String(d || ''))
  ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7, 14)}-${d.slice(14)}` : (d || null));

export async function hrForProfile(q, ids, { today = null } = {}) {
  const day = today || dubaiDay(new Date());
  const want = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!want.length) return null;
  let rows;
  try {
    rows = await q(
      `SELECT r.fleet_id, r.employee_id, r.full_name, r.hr_compliance_status, r.emirates_id,
              r.licence_no, to_char(r.licence_expires, 'YYYY-MM-DD') AS licence_expires,
              to_char(u.export_date, 'YYYY-MM-DD') AS export_date, u.id AS upload_id
         FROM hr_roster_row r JOIN hr_roster_upload u ON u.id = r.upload_id
        WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(r.matched_accounts) a
                       WHERE a ->> 'ext_id' = ANY($1::text[]))
        ORDER BY u.export_date DESC, u.id DESC`, [want]);
  } catch { return null; }
  if (!rows.length) return null;
  const [top] = await q(`SELECT id, to_char(export_date, 'YYYY-MM-DD') AS export_date
                           FROM hr_roster_upload ORDER BY export_date DESC, id DESC LIMIT 1`);
  const first = rows[0];
  const employees = [...new Set(rows.map((r) => `${r.fleet_id}\u0000${r.employee_id}`))];
  const lic = docStatus(first.licence_expires, day);
  return {
    fleet_id: first.fleet_id, employee_id: first.employee_id, name: first.full_name,
    hr_compliance_status: first.hr_compliance_status,
    export_date: first.export_date,
    on_list: Number(first.upload_id) === Number(top?.id),
    emirates_id: eidText(first.emirates_id),
    licence_no: first.licence_no || null,
    licence_expires: first.licence_expires,
    licence_days_left: lic.days_left,
    licence_status: lic.status,
    other_employees: employees.length - 1,
    source: `HR roster, ${FLEET[first.fleet_id] || first.fleet_id} employee ${first.employee_id}, `
      + `export of ${first.export_date}`,
  };
}

/* ── THE QUEUE'S HALF ─────────────────────────────────────────────────────
   What #same-person shows of HR: proposals from the latest export that are
   not yet one person, the ones already answered, and every contradiction the
   latest export makes with what is held NOW — computed at read time, so a
   link somebody has since rejected stops being reported. */
export async function hrQueue(q) {
  let ups;
  try { ups = await uploads(q); } catch { return null; }
  if (!ups.length) return { latest: null, pending: [], decided: [], contradictions: [], withdrawn: 0, already_one: 0 };
  const latest = ups[0];
  const props = await q(
    `SELECT id, fleet_id, employee_id, alias_platform, alias_ext_id, canonical_platform,
            canonical_ext_id, evidence, first_upload_id, last_upload_id, verdict, decided_by,
            decided_at, decided_note
       FROM hr_roster_proposal ORDER BY fleet_id, employee_id, id`);
  const rows = await q(
    `SELECT fleet_id, employee_id, full_name, matched_accounts FROM hr_roster_row WHERE upload_id = $1`,
    [latest.id]);
  const matched = rows.map((r) => ({ ...r, accounts: accountsOf(r.matched_accounts) }));
  const ctx = await identityContext(q);
  const contradictions = contradictionsOf(matched, ctx);
  const emp = new Map(matched.map((r) => [`${r.fleet_id}\u0000${r.employee_id}`, r]));
  let withdrawn = 0;
  let alreadyOne = 0;
  const pending = [];
  const decided = [];
  for (const p of props) {
    const e = emp.get(`${p.fleet_id}\u0000${p.employee_id}`);
    const item = {
      proposal_id: Number(p.id), source: 'hr_roster', basis: 'hr_roster',
      fleet_id: p.fleet_id, employee_id: p.employee_id, employee_name: e?.full_name || null,
      alias: { platform: p.alias_platform, ext_id: p.alias_ext_id,
        name: e?.accounts.find((a) => a.ext_id === p.alias_ext_id)?.name || null },
      canonical: { platform: p.canonical_platform, ext_id: p.canonical_ext_id,
        name: e?.accounts.find((a) => a.ext_id === p.canonical_ext_id)?.name || null },
      accounts: (e?.accounts || []).filter((a) => a.via !== 'phone')
        .map((a) => ({ platform: a.platform, ext_id: a.ext_id })),
      evidence: p.evidence,
      verdict: p.verdict || null, decided_by: p.decided_by || null,
      decided_at: p.decided_at || null, decided_note: p.decided_note || null,
      on_latest_export: Number(p.last_upload_id) === Number(latest.id),
      contradicts: contradictions.filter((c) => c.accounts.some((a) =>
        a.ext_id === p.alias_ext_id || a.ext_id === p.canonical_ext_id)).map((c) => c.evidence),
    };
    if (p.verdict) { decided.push(item); continue; }
    if (!item.on_latest_export) { withdrawn += 1; continue; }
    if (ctx.same(p.alias_ext_id, p.canonical_ext_id)) { alreadyOne += 1; continue; }
    pending.push(item);
  }
  return { latest: { upload_id: Number(latest.id), export_date: latest.export_date },
    pending, decided, contradictions, withdrawn, already_one: alreadyOne };
}

/* A verdict on an HR proposal. Recorded HERE and nowhere else: it folds
   nobody, writes nothing to driver_identity_link, and does not touch the
   register. */
export async function decideHr(q, id, verdict, { by = null, note = null } = {}) {
  const [row] = await q(`SELECT id FROM hr_roster_proposal WHERE id = $1`, [id]);
  if (!row) return null;
  if (verdict === 'undecided') {
    await q(`UPDATE hr_roster_proposal SET verdict = NULL, decided_by = NULL, decided_at = NULL,
               decided_note = NULL WHERE id = $1`, [id]);
  } else {
    await q(`UPDATE hr_roster_proposal SET verdict = $2, decided_by = $3, decided_at = now(),
               decided_note = $4 WHERE id = $1`, [id, verdict, by, note]);
  }
  return { id };
}
