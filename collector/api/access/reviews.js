/* Access reviews as a CYCLE, and dormant suspension — ULM Phase 4.
   ─────────────────────────────────────────────────────────────────────────
   docs/ULM-DESIGN.md §11.2 (a user's lifecycle), §11.3 (reviews), §12
   (audit), §13 phase 4. Until 2026-11-12 a "review" was one row per team per
   quarter (sql/schema_v86.sql access_review) and three routes: an admin
   pressed Open, a lead ticked people, and that was the end of it. It could
   not say anything about a DIRECT grant — and most grants are direct, since
   an invitation carries its roles — nobody was ever reminded, nothing opened
   by itself, and access that nobody looked at simply carried on. §11.3 asks
   for the opposite on each count:

     · Every quarter each team lead attests their team's access, keeping or
       removing it person by person. What no lead covers — a direct grant, a
       team with no lead, a lead's own place in their team — is attested by an
       Access admin or the Owner.
     · Access nobody attested expires 14 days after the review closes.
     · Holders of the sensitive classes (DOC at F, CASH, CRED, ACCUSE, AUDIT
       and RAW — access_model.js SENSITIVE_CLASSES, the same list the second-
       Owner rule uses) are reviewed MONTHLY.

   THE CYCLE, as built (sql/schema_v122.sql):

     open    on the schedule — the 1st of each Dubai month: the quarterly
             review in a quarter's first month, the monthly one in the other
             two — or when an Access admin opens one. Opening SNAPSHOTS every
             line to decide: one per direct grant, one per person in a team
             that holds a role. Each line has an OWNER (`reviewer_id`: the
             team's lead for a team place; empty for "any Access admin or
             Owner") and a STATE. Due 14 days after opening.
     decide  keep or revoke, line by line, each decision in the hash-chained
             audit log with who, what and why. Nobody decides their own
             access. An Owner's access is decided by another Owner only.
             Revoking takes the grant away, or takes the person out of the
             team, at once — and the last Owner can never be revoked (§11.2).
     close   on the due date (the schedule) or early by an Access admin.
             Every undecided line becomes `unattested` and ends 14 days later
             unless someone attests it first. The grant is not shortened in
             the meantime: the hourly sweep ends it at that moment, after
             checking again that it is not the last Owner's.
     expire  the hourly sweep ends each unattested line whose 14 days are
             up: the grant revoked, or the team place removed.

   OPEN MODE. The schedule opens reviews only once sign-in is REQUIRED
   (access_config.mode 'enforced'). While sign-in is optional nobody is
   obliged to sign in, so nobody may be there to attest, and a review that
   opened by itself would end — fourteen days after it closed — access the
   company is still setting up. An Access admin can still open one by hand in
   either mode; closing and expiring then follow the rules above, because
   opening it was the admin asking for them.

   DORMANT SUSPENSION (§11.2 "dormant: no sign-in for 60 days → suspended
   automatically"; "suspended → reinstated"). The hourly housekeeping has
   suspended such accounts since 2026-09-28 (api/access/routes.js), with two
   defects this module fixes:
     · a reinstated person's last sign-in was still 60 days old, so the next
       hourly pass suspended them again within the hour — the "way back" the
       design allows did not work. `reinstated_at` restarts the clock, as does
       a password set from an invitation or reset (password_changed_at);
     · sign-in said only "This account is suspended". It now says why, since
       when, and what to do — for a dormancy suspension, which the sweep
       marks with `dormant_since`. An admin's own suspension keeps the plain
       sentence: the reason an admin typed may be about the person, and is
       for other admins (the Access page shows it to them).
   Every Owner used to be exempt. Now only the LAST active Owner is: with two
   Owners, a dormant one is exactly the account nobody would notice being
   used, and §11.2 exempts nobody; with one, suspending them would lock the
   company out of its own access controls. */
import * as svc from './service.js';
import { appendAudit } from './audit.js';
import { ROLE, SENSITIVE_CLASSES, rank } from '../public/access_model.js';

export const REVIEW_OPEN_DAYS = 14;   // a review is due this long after it opens
export const UNATTESTED_DAYS = 14;    // §11.3: unattested access ends this long after the close
export const DORMANT_DAYS = 60;       // §11.2: no sign-in for this long → suspended
export const DORMANT_REASON = `no sign-in for ${DORMANT_DAYS} days`;
const DAY = 864e5;
const KINDS = ['quarterly', 'monthly', 'adhoc'];

const num = (v) => (v == null ? null : Number(v));
const iso = (v) => (v == null ? null : new Date(v).toISOString());
/* A row id from a request: a positive whole number, else null. */
const idOf = (v) => {
  const n = typeof v === 'number' ? v : (/^\d{1,18}$/.test(String(v ?? '')) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
/* Dubai's calendar: every calendar key in this product is Dubai's, and a
   quarter that turned at midnight UTC would open its review at 04:00. */
const dubai = (d) => new Date(new Date(d).getTime() + 4 * 3600_000);
export const dayText = (v) => new Date(v).toLocaleDateString('en-GB',
  { timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', year: 'numeric' });

export function periodOf(kind, now = new Date()) {
  const t = dubai(now);
  const y = t.getUTCFullYear(); const m = t.getUTCMonth();
  if (kind === 'quarterly') return `${y}-Q${Math.floor(m / 3) + 1}`;
  if (kind === 'monthly') return `${y}-${String(m + 1).padStart(2, '0')}`;
  return t.toISOString().slice(0, 16).replace('T', ' ');
}
/* What the schedule opens in the month `now` falls in. */
export const scheduledKind = (now = new Date()) => (dubai(now).getUTCMonth() % 3 === 0 ? 'quarterly' : 'monthly');
export const KIND_WORD = Object.freeze({ quarterly: 'quarterly', monthly: 'monthly sensitive-access', adhoc: 'extra' });

/* Does this role confer a class §11.3 reviews monthly, at the level named? */
export function monthlyReviewed(role) {
  if (!role) return false;
  return Object.entries(SENSITIVE_CLASSES).some(([c, min]) => rank(role.levels?.[c]) >= rank(min));
}

/* ── what a review covers ──────────────────────────────────────────────── */
/* Every line to decide, as access stands now. Grants that confer nothing
   yet because they wait for a second Owner are left out: approving them is
   its own decision. An offboarded person holds nothing; an archived team
   gives nothing. */
export async function collectItems(db, { kind }) {
  const custom = await svc.customRoles(db);
  const roleOf = (code) => ROLE[code] || custom[code] || null;
  const covered = (code) => kind !== 'monthly' || monthlyReviewed(roleOf(code));
  const { rows: grants } = await db.query(
    `SELECT g.id, g.user_id, g.team_id, g.role_code, g.fleets
       FROM access_grant g
       LEFT JOIN access_user u ON u.id = g.user_id
       LEFT JOIN access_team t ON t.id = g.team_id
      WHERE g.status = 'active' AND (g.expires_at IS NULL OR g.expires_at > now())
        AND (g.user_id IS NULL OR u.status <> 'offboarded')
        AND (g.team_id IS NULL OR t.archived_at IS NULL)
      ORDER BY g.id`);
  const items = [];
  const teams = new Map();
  for (const g of grants) {
    if (!covered(g.role_code)) continue;
    if (g.user_id != null) {
      items.push({ kind: 'grant', grant_id: num(g.id), team_id: null, user_id: num(g.user_id), roles: [g.role_code],
        fleets: g.fleets && g.fleets.length ? g.fleets : null, reviewer_id: null, owner_only: g.role_code === 'OWN' });
    } else {
      const t = teams.get(num(g.team_id)) || { roles: new Set(), own: false };
      t.roles.add(g.role_code);
      if (g.role_code === 'OWN') t.own = true;
      teams.set(num(g.team_id), t);
    }
  }
  if (teams.size) {
    const { rows: members } = await db.query(
      `SELECT m.team_id, m.user_id, t.lead_user_id, l.status AS lead_status
         FROM access_team_member m
         JOIN access_team t ON t.id = m.team_id
         JOIN access_user u ON u.id = m.user_id
         LEFT JOIN access_user l ON l.id = t.lead_user_id
        WHERE t.archived_at IS NULL AND u.status <> 'offboarded' AND m.team_id = ANY($1::bigint[])
        ORDER BY m.team_id, m.user_id`, [[...teams.keys()]]);
    for (const m of members) {
      const t = teams.get(num(m.team_id));
      const lead = num(m.lead_user_id);
      /* The lead attests the people in their team — never their own place,
         and only while their own account is active. */
      const reviewer = lead != null && lead !== num(m.user_id) && m.lead_status === 'active' && !t.own ? lead : null;
      items.push({ kind: 'membership', grant_id: null, team_id: num(m.team_id), user_id: num(m.user_id),
        roles: [...t.roles], fleets: null, reviewer_id: reviewer, owner_only: t.own });
    }
  }
  return items;
}

/* ── open ──────────────────────────────────────────────────────────────── */
/* Returns { opened: true, cycle, items } — or { opened: false, period,
   existing } when that period's review exists, or { opened: false, empty:
   true } when nothing would be reviewed (the schedule then opens nothing,
   rather than an empty review every month). */
export async function openCycle(db, { kind = 'quarterly', by = null, now = new Date() } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown review kind ${kind}`);
  const period = periodOf(kind, now);
  if (kind !== 'adhoc') {
    const { rows } = await db.query('SELECT * FROM access_review_cycle WHERE kind = $1 AND period = $2', [kind, period]);
    if (rows[0]) return { opened: false, kind, period, existing: cycleOut(rows[0]) };
  }
  const items = await collectItems(db, { kind });
  if (!items.length) return { opened: false, kind, period, empty: true };
  const due = new Date(new Date(now).getTime() + REVIEW_OPEN_DAYS * DAY);
  const ins = await db.query(
    `INSERT INTO access_review_cycle (kind, period, opened_at, opened_by, due_at, items)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (kind, period) WHERE kind <> 'adhoc' DO NOTHING RETURNING *`,
    [kind, period, now, by, due, items.length]);
  if (!ins.rows[0]) {
    const { rows } = await db.query('SELECT * FROM access_review_cycle WHERE kind = $1 AND period = $2', [kind, period]);
    return { opened: false, kind, period, existing: rows[0] ? cycleOut(rows[0]) : null };
  }
  const cycle = cycleOut(ins.rows[0]);
  for (let i = 0; i < items.length; i += 200) {
    const chunk = items.slice(i, i + 200);
    const vals = []; const ph = [];
    for (const it of chunk) {
      const b = vals.length;
      vals.push(cycle.id, it.kind, it.grant_id, it.team_id, it.user_id, it.roles, it.fleets, it.reviewer_id, it.owner_only);
      ph.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::text[], $${b + 7}::text[], $${b + 8}, $${b + 9})`);
    }
    await db.query(
      `INSERT INTO access_review_item (cycle_id, kind, grant_id, team_id, user_id, roles, fleets, reviewer_id, owner_only)
       VALUES ${ph.join(', ')}`, vals);
  }
  return { opened: true, kind, period, cycle, items: items.length,
    grants: items.filter((x) => x.kind === 'grant').length, memberships: items.filter((x) => x.kind === 'membership').length };
}

function cycleOut(r) {
  return { id: num(r.id), kind: r.kind, period: r.period, opened_at: iso(r.opened_at), opened_by: num(r.opened_by),
    due_at: iso(r.due_at), closed_at: iso(r.closed_at), closed_by: num(r.closed_by), expires_at: iso(r.expires_at),
    items: Number(r.items) || 0 };
}

/* ── who may decide a line ─────────────────────────────────────────────── */
/* `actor` { id, manager (holds access.manage), owner }. Returns null when
   they may, or { status, error, detail } — the true reason, in words. */
export function mayDecide(it, actor, now = new Date()) {
  if (it.state !== 'pending' && it.state !== 'unattested') {
    return { status: 409, error: 'decided', detail: `This line was already decided: ${STATE_WORD[it.state] || it.state}.` };
  }
  if (it.state === 'pending' && it.cycle_closed_at) {
    return { status: 409, error: 'closed', detail: 'This review has closed.' };
  }
  if (it.state === 'unattested' && it.expires_at && new Date(it.expires_at).getTime() <= new Date(now).getTime()) {
    return { status: 409, error: 'expired', detail: 'Nobody attested this in time, so it has ended.' };
  }
  if (num(it.user_id) === num(actor.id)) {
    return { status: 403, error: 'self', detail: 'You cannot attest your own access. Another Owner or Access admin must.' };
  }
  if (it.owner_only) {
    return actor.owner ? null : { status: 403, error: 'not_allowed', detail: 'Only another Owner can attest an Owner’s access.' };
  }
  if (actor.manager) return null;
  /* THE TEAM'S LEAD NOW — never whoever led it when the review opened.
     `reviewer_id` is a snapshot, kept to show who the line was for. Judging
     by it let a lead who had since been replaced (moved, demoted, or taken
     off the team for cause) go on keeping their old team's access — which
     stops it ending unattested — and taking people out of it, until the
     review closed and beyond, on every unattested line (independent review,
     2026-11-12). `team_lead` is read with the line (ITEM_SQL), so a change
     of lead moves the lines to the new lead at once, and a team with no
     lead leaves them to an Access admin or the Owner. */
  const lead = it.kind === 'membership' && it.team_lead != null && num(it.team_lead) === num(actor.id);
  if (lead) return null;
  return { status: 403, error: 'not_allowed', detail: it.kind === 'membership'
    ? 'This line is for the team’s lead, or an Access admin, to decide.'
    : 'A role given to a person directly is attested by an Access admin or the Owner.' };
}
export const STATE_WORD = Object.freeze({ pending: 'waiting for a decision', kept: 'kept', revoked: 'revoked',
  unattested: 'not attested — ending', expired: 'ended: nobody attested it', gone: 'already ended before anyone decided' });

const ITEM_SQL = `SELECT i.*, c.closed_at AS cycle_closed_at, c.kind AS cycle_kind, c.period, t.lead_user_id AS team_lead
                    FROM access_review_item i JOIN access_review_cycle c ON c.id = i.cycle_id
                    LEFT JOIN access_team t ON t.id = i.team_id`;

async function stillHeld(db, it) {
  if (it.kind === 'grant') {
    const { rows } = await db.query(
      `SELECT 1 FROM access_grant WHERE id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())`, [it.grant_id]);
    return rows.length > 0;
  }
  /* The SAME team place: one that was there when the line was written.
     A grant line names its grant by id, so a grant made after the review
     opened is never its line's to end. A team place has no id — and a
     person taken out of the team and put back after the review opened (an
     admin's fresh decision, ceiling-checked when it was made) was treated as
     the place the review listed: left undecided, the close made it
     unattested and the sweep took them out of the team 14 days later, as
     access "nobody attested" (independent review, 2026-11-12). The line's
     own created_at and the place's added_at are both the database's clock,
     so a test's simulated `now` cannot skew the comparison. */
  const { rows } = await db.query(
    `SELECT 1 FROM access_team_member m JOIN access_team t ON t.id = m.team_id
      WHERE m.team_id = $1 AND m.user_id = $2 AND t.archived_at IS NULL
        AND ($3::timestamptz IS NULL OR m.added_at <= $3::timestamptz)`, [it.team_id, it.user_id, it.created_at ?? null]);
  return rows.length > 0;
}
/* Would ending this line leave the company with no active Owner? */
async function lastOwner(db, it) {
  if (it.kind !== 'grant' || !(it.roles || []).includes('OWN')) return false;
  const owners = await svc.activeOwners(db);
  return owners.some((o) => o.id === num(it.user_id)) && owners.length <= 1;
}

/* ── decide ────────────────────────────────────────────────────────────── */
/* Keep or revoke one line. Returns { ok: true, state, late, … } or
   { ok: false, status, error, detail }. The route writes the audit row. */
export async function decideItem(db, { itemId, cycleId = null, keep, reason = '', actor, now = new Date() }) {
  const { rows } = await db.query(`${ITEM_SQL} WHERE i.id = $1`, [itemId]);
  const it = rows[0];
  if (!it || (cycleId != null && num(it.cycle_id) !== num(cycleId))) {
    return { ok: false, status: 404, error: 'not_found', detail: 'No line with that number in this review.' };
  }
  const no = mayDecide(it, actor, now);
  if (no) return { ok: false, ...no };
  const facts = { kind: it.kind, user: num(it.user_id), grant: num(it.grant_id), team: num(it.team_id),
    roles: it.roles || [], cycle: num(it.cycle_id), late: it.state === 'unattested' };
  let state = keep ? 'kept' : 'revoked';
  if (!(await stillHeld(db, it))) state = 'gone';
  else if (!keep && (await lastOwner(db, it))) {
    return { ok: false, status: 403, error: 'last_owner', detail: 'This is the only Owner. Make someone else an Owner first.' };
  }
  /* Claimed with the state it was read in: two reviewers deciding the same
     line at once — one of them is told it was already decided. */
  const claim = await db.query(
    `UPDATE access_review_item SET state = $2, decided_by = $3, decided_at = $4, reason = $5
      WHERE id = $1 AND state = $6 RETURNING id`, [itemId, state, actor.id, now, String(reason || '').slice(0, 500), it.state]);
  if (!claim.rows.length) return { ok: false, status: 409, error: 'decided', detail: 'Someone decided this line a moment ago.' };
  if (state === 'revoked') {
    if (it.kind === 'grant') await svc.endGrant(db, num(it.grant_id), actor.id, 'revoked');
    else await svc.setMember(db, num(it.team_id), num(it.user_id), false, actor.id);
  }
  /* ONE ATTESTATION, EVERY OPEN LINE FOR THE SAME ACCESS.
     ───────────────────────────────────────────────────────────────────────
     Reviews can overlap: the Reviews tab opens a quarterly, a monthly and an
     extra review side by side, and the schedule's monthly review can be open
     while an admin opens the quarter's. A sensitive grant is then a line in
     two reviews. Kept in one, its line in the other stayed pending — the
     close made it unattested, and 14 days later the sweep ENDED a grant
     someone had attested (independent review, 2026-11-12). §11.3 ends access
     "nobody attested"; this access was attested. So a keep also settles
     every other undecided line for the same grant, or the same team place
     (a line written after the person last joined the team: an older line
     was about a place that has since ended), saying where it was attested.
     An Owner's line is settled only by an Owner's keep, as it would be
     decided. A revoke needs no such step: the access is gone, and the other
     lines read "already ended" when they are decided or closed. */
  let alsoKept = [];
  if (state === 'kept') {
    const { rows: more } = await db.query(
      `UPDATE access_review_item o SET state = 'kept', decided_by = $2, decided_at = $3, reason = $4
        WHERE o.id <> $1 AND o.state IN ('pending', 'unattested') AND o.user_id = $7
          AND NOT (o.state = 'unattested' AND o.expires_at <= $3)
          AND (o.owner_only = false OR $8::boolean)
          AND ((o.kind = 'grant' AND o.grant_id = $5)
            OR (o.kind = 'membership' AND o.team_id = $6 AND o.created_at >= (
                  SELECT m.added_at FROM access_team_member m WHERE m.team_id = $6 AND m.user_id = $7)))
        RETURNING o.id`,
      [itemId, actor.id, now, `Attested with line ${num(itemId)} of review ${num(it.cycle_id)}.`,
        it.kind === 'grant' ? num(it.grant_id) : null, it.kind === 'membership' ? num(it.team_id) : null,
        num(it.user_id), Boolean(actor.owner)]);
    alsoKept = more.map((r) => num(r.id));
  }
  return { ok: true, state, ...facts, alsoKept };
}

/* ── close ─────────────────────────────────────────────────────────────── */
/* Every undecided line becomes unattested, ending UNATTESTED_DAYS after the
   close — except access that already ended ('gone'), and the last active
   Owner's own grant, which is kept (§11.2: the last Owner cannot be
   removed; with no other Owner, nobody else could have attested it). */
export async function closeCycle(db, { cycleId, by = null, now = new Date() }) {
  const ends = new Date(new Date(now).getTime() + UNATTESTED_DAYS * DAY);
  const claim = await db.query(
    `UPDATE access_review_cycle SET closed_at = $2, closed_by = $3, expires_at = $4
      WHERE id = $1 AND closed_at IS NULL RETURNING *`, [cycleId, now, by, ends]);
  if (!claim.rows[0]) return { closed: false };
  const { rows: pending } = await db.query(
    `SELECT i.*, u.last_login_at FROM access_review_item i JOIN access_user u ON u.id = i.user_id
      WHERE i.cycle_id = $1 AND i.state = 'pending' ORDER BY i.id`, [cycleId]);
  const owners = (await svc.activeOwners(db)).map((o) => o.id);
  const ownerLines = pending.filter((it) => it.kind === 'grant' && (it.roles || []).includes('OWN') && owners.includes(num(it.user_id)));
  /* Owners whose own access is not on the line here stay Owners. If every
     active Owner's grant would become unattested, the one who signed in
     most recently keeps theirs. */
  const keepOwner = owners.some((id) => !ownerLines.some((it) => num(it.user_id) === id)) ? null
    : [...ownerLines].sort((a, b) => new Date(b.last_login_at || 0) - new Date(a.last_login_at || 0))[0] || null;
  const out = { closed: true, cycle: cycleOut(claim.rows[0]), unattested: 0, gone: 0, keptOwner: null, expires_at: ends.toISOString() };
  for (const it of pending) {
    if (!(await stillHeld(db, it))) {
      await db.query(`UPDATE access_review_item SET state = 'gone', decided_at = $2 WHERE id = $1 AND state = 'pending'`, [it.id, now]);
      out.gone += 1;
    } else if (keepOwner && num(it.id) === num(keepOwner.id)) {
      await db.query(
        `UPDATE access_review_item SET state = 'kept', decided_at = $2, reason = $3 WHERE id = $1 AND state = 'pending'`,
        [it.id, now, 'Kept without a decision: the only active Owner, and the last Owner cannot be removed (§11.2).']);
      out.keptOwner = num(it.user_id);
    } else {
      await db.query(`UPDATE access_review_item SET state = 'unattested', expires_at = $2 WHERE id = $1 AND state = 'pending'`, [it.id, ends]);
      out.unattested += 1;
    }
  }
  return out;
}

/* ── expire ────────────────────────────────────────────────────────────── */
export async function expireUnattested(db, { now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM access_review_item WHERE state = 'unattested' AND expires_at <= $1 ORDER BY id`, [now]);
  const out = { grants: [], memberships: [], keptOwner: [], gone: [] };
  for (const it of rows) {
    if (await lastOwner(db, it)) {
      await db.query(
        `UPDATE access_review_item SET state = 'kept', decided_at = $2, reason = $3 WHERE id = $1 AND state = 'unattested'`,
        [it.id, now, 'Kept without a decision: by the time it was due to end this was the only active Owner (§11.2).']);
      out.keptOwner.push(num(it.user_id));
      continue;
    }
    const held = await stillHeld(db, it);
    const claim = await db.query(
      `UPDATE access_review_item SET state = $3, decided_at = $2 WHERE id = $1 AND state = 'unattested' RETURNING id`,
      [it.id, now, held ? 'expired' : 'gone']);
    if (!claim.rows.length) continue;
    if (!held) { out.gone.push(num(it.id)); continue; }
    if (it.kind === 'grant') {
      await svc.endGrant(db, num(it.grant_id), null, 'revoked');
      out.grants.push(num(it.grant_id));
    } else {
      await svc.setMember(db, num(it.team_id), num(it.user_id), false, null);
      out.memberships.push({ team: num(it.team_id), user: num(it.user_id) });
    }
  }
  return out;
}

/* ── the hourly sweep ──────────────────────────────────────────────────── */
/* In this order: what is due to END first, then reviews past their due
   date CLOSED, then this month's review OPENED. Opening first snapshotted
   access the same pass was about to end, and listed it in the new review
   as a line that would read "already ended" a minute later. */
export async function reviewSweep(db, { now = new Date(), log = { info() {} } } = {}) {
  const out = { opened: null, closed: [], expired: null };
  const ex = await expireUnattested(db, { now });
  if (ex.grants.length || ex.memberships.length || ex.keptOwner.length || ex.gone.length) {
    out.expired = ex;
    svc.bumpAccess();
    await appendAudit(db, { actorLabel: 'system:schedule', action: 'access.review_expired', subjectType: 'system',
      detail: { grants_ended: ex.grants, memberships_ended: ex.memberships, kept_last_owner: ex.keptOwner, already_gone: ex.gone } });
    log.info('access', 'unattested access ended', { grants: ex.grants.length, memberships: ex.memberships.length });
  }
  const { rows: due } = await db.query(
    'SELECT id, period, kind FROM access_review_cycle WHERE closed_at IS NULL AND due_at <= $1 ORDER BY id', [now]);
  for (const c of due) {
    const r = await closeCycle(db, { cycleId: num(c.id), by: null, now });
    if (!r.closed) continue;
    out.closed.push({ cycle: num(c.id), unattested: r.unattested, gone: r.gone, keptOwner: r.keptOwner });
    await appendAudit(db, { actorLabel: 'system:schedule', action: 'access.review_closed', subjectType: 'review',
      subjectId: num(c.id), detail: { kind: c.kind, period: c.period, unattested: r.unattested, gone: r.gone,
        kept_last_owner: r.keptOwner, ends: r.expires_at } });
  }
  const cfg = await svc.getConfig(db, { fresh: true });
  if (cfg.mode === 'enforced') {
    const kind = scheduledKind(now);
    const r = await openCycle(db, { kind, by: null, now });
    if (r.opened) {
      out.opened = { cycle: r.cycle.id, kind, period: r.period, items: r.items };
      await appendAudit(db, { actorLabel: 'system:schedule', action: 'access.review_opened', subjectType: 'review',
        subjectId: r.cycle.id, detail: { kind, period: r.period, items: r.items, grants: r.grants, memberships: r.memberships } });
      log.info('access', 'review opened', out.opened);
    }
  }
  return out;
}

/* ── dormant accounts ──────────────────────────────────────────────────── */
/* Suspends every active account with no sign-in for DORMANT_DAYS — counted
   from the latest of: the last sign-in, the account's creation, its last
   reinstatement, and a password set from a link. Returns the ids suspended.
   Never the last active Owner (see the header). */
export async function dormantSweep(db, { now = new Date() } = {}) {
  const cutoff = new Date(new Date(now).getTime() - DORMANT_DAYS * DAY);
  const { rows } = await db.query(
    `SELECT id FROM access_user
      WHERE status = 'active'
        AND GREATEST(created_at, last_login_at, reinstated_at, password_changed_at) < $1
      ORDER BY id`, [cutoff]);
  if (!rows.length) return [];
  const owners = (await svc.activeOwners(db)).map((o) => o.id);
  const dormant = rows.map((r) => num(r.id));
  const liveOwners = owners.filter((id) => !dormant.includes(id));
  const out = [];
  for (const id of dormant) {
    if (owners.includes(id) && !liveOwners.length) continue;   // the last active Owner(s): never
    const { rows: done } = await db.query(
      `UPDATE access_user SET status = 'suspended', suspended_reason = $2, dormant_since = $3
        WHERE id = $1 AND status = 'active' RETURNING id, last_login_at`, [id, DORMANT_REASON, now]);
    if (!done.length) continue;
    await svc.revokeUserSessions(db, id, `suspended: ${DORMANT_REASON}`);
    await appendAudit(db, { actorLabel: 'system:housekeeping', action: 'access.user_dormant', subjectType: 'user', subjectId: id,
      detail: { last_sign_in: iso(done[0].last_login_at), days: DORMANT_DAYS } });
    out.push(id);
  }
  if (out.length) svc.bumpAccess();
  return out;
}

/* Reinstatement restarts the dormancy clock and forgets the dormancy. */
export async function markReinstated(db, id, now = new Date()) {
  /* Called AFTER the reinstatement is written. Where v122's guarded ALTER
     was refused the two columns do not exist (sql/schema_v122.sql); the
     dormancy sweep cannot run there either, so there is no clock to restart
     — and throwing turned a reinstatement that had succeeded into a 500 on
     the admin's screen. Only a missing column (42703) is passed; any other
     failure still reaches the admin, who can try again. */
  await db.query('UPDATE access_user SET reinstated_at = $2, dormant_since = NULL WHERE id = $1', [id, now])
    .catch((e) => { if (e?.code !== '42703') throw e; });
  svc.bumpAccess();
}

/* What sign-in says to someone whose password was right but whose account
   is not active. Only ever reached AFTER a correct password, so it tells
   the account's holder, and nobody else, why it is closed. */
export async function inactiveDetail(db, user) {
  if (user.status === 'suspended') {
    /* Without v122's columns (a refused migration, sql/schema_v122.sql) the
       plain sentence below is still true; a sign-in must not fail on it. */
    const { rows } = await db.query(
      'SELECT dormant_since, suspended_reason, last_login_at, created_at FROM access_user WHERE id = $1', [user.id]).catch(() => ({ rows: [] }));
    const u = rows[0];
    /* …and only while the sweep's reason is still the reason. An admin who
       suspends an account the sweep had already closed writes their own
       reason over it without reinstating first, so dormant_since is still
       set: sign-in went on saying "because nobody had signed in" when the
       account was closed for something else (independent review,
       2026-11-12). The admin's reason is for admins; the plain sentence is
       the true one to give the holder. */
    if (u?.dormant_since && u.suspended_reason === DORMANT_REASON) {
      const last = u.last_login_at ? `the last sign-in was on ${dayText(u.last_login_at)}`
        : `nobody had signed in to it since it was set up on ${dayText(u.created_at)}`;
      return `This account was suspended on ${dayText(u.dormant_since)} because nobody had signed in to it for `
        + `${DORMANT_DAYS} days (${last}). It is suspended, not deleted: its roles, teams and history are kept. `
        + 'Ask the Owner or an Access admin to reinstate it — after that, sign in at least once every '
        + `${DORMANT_DAYS} days to keep it open.`;
    }
    return 'This account is suspended. Ask the Owner or an Access admin.';
  }
  return 'This account is not active. Use the link you were sent, or ask an admin for a new one.';
}

/* ── the routes (mounted from api/access/routes.js accessRoutes) ───────── */
/* `h` carries accessRoutes' own helpers — me, manager, fail, audit, noStore,
   isOwner, stepupFresh — so these routes decide exactly as their siblings
   do. Every path is under /api/access/, which the manifest declares `self`
   (the handler decides) and the response cache never stores. */
export function reviewRoutes(app, { db, layer, wrap, h }) {
  const { me, manager, fail, audit, noStore, isOwner, stepupFresh } = h;
  const actorOf = (fm) => ({ id: fm.user.id, manager: (fm.access.caps || []).includes('access.manage') && !fm.access.preview,
    owner: isOwner(fm) });

  /* The reviews, and every line the caller may see: an Access admin or the
     Owner sees all of them; a team lead sees the lines that are theirs. */
  app.get('/api/access/reviews', wrap(async (req, res) => {
    const fm = me(req, res);
    if (!fm) return undefined;
    noStore(res);
    const actor = actorOf(fm);
    const cfg = await svc.getConfig(db);
    const { rows: cyc } = await db.query(
      `SELECT c.*, COALESCE((SELECT json_object_agg(s.state, s.n) FROM
                (SELECT state, count(*)::int AS n FROM access_review_item i WHERE i.cycle_id = c.id GROUP BY state) s), '{}'::json) AS counts
         FROM access_review_cycle c ORDER BY c.opened_at DESC, c.id DESC LIMIT 24`);
    const { rows: lines } = await db.query(
      `SELECT i.*, c.closed_at AS cycle_closed_at, c.kind AS cycle_kind, c.period, c.due_at,
              t.lead_user_id AS team_lead, t.name AS team_name,
              u.name AS user_name, u.email AS user_email, u.status AS user_status
         FROM access_review_item i
         JOIN access_review_cycle c ON c.id = i.cycle_id
         JOIN access_user u ON u.id = i.user_id
         LEFT JOIN access_team t ON t.id = i.team_id
        WHERE (i.state = 'pending' AND c.closed_at IS NULL) OR i.state = 'unattested'
        ORDER BY c.opened_at DESC, i.kind, i.team_id NULLS FIRST, lower(u.name), i.id
        LIMIT 2000`);
    const now = new Date();
    /* A lead's own place in their team is not theirs to see here: it is an
       Access admin's line, like any other line about themselves. And only
       the team's lead NOW sees its lines (mayDecide): a lead who has been
       replaced no longer sees their old team's names. */
    const visible = lines.filter((it) => actor.manager
      || (it.kind === 'membership' && num(it.user_id) !== actor.id
        && it.team_lead != null && num(it.team_lead) === actor.id));
    const items = visible.map((it) => {
      const no = mayDecide(it, actor, now);
      return {
        id: num(it.id), cycle_id: num(it.cycle_id), kind: it.kind, grant_id: num(it.grant_id), team_id: num(it.team_id),
        /* A lead is shown the name; the email only where there is no name
           to show — they attest people, they do not manage accounts. */
        team_name: it.team_name || null, user_id: num(it.user_id), user_name: it.user_name,
        user_email: actor.manager || !it.user_name ? it.user_email : null,
        user_status: it.user_status, roles: it.roles || [], fleets: it.fleets || null,
        /* The line's owner as the review opened (null: any Access admin or
           the Owner), and the team's lead now — who may also decide it. */
        reviewer_id: num(it.reviewer_id), team_lead: num(it.team_lead),
        owner_only: Boolean(it.owner_only), state: it.state, expires_at: iso(it.expires_at), due_at: iso(it.due_at),
        canDecide: !no, why: no ? no.detail : null,
      };
    });
    const mine = new Set(items.map((x) => x.cycle_id));
    const cycles = cyc.filter((c) => actor.manager || mine.has(num(c.id))).map((c) => ({
      ...cycleOut(c), counts: typeof c.counts === 'string' ? JSON.parse(c.counts) : (c.counts || {}),
      overdue: !c.closed_at && new Date(c.due_at).getTime() < now.getTime(),
    }));
    const nextKind = scheduledKind(now);
    return res.json({
      cycles, items,
      me: { id: actor.id, manager: actor.manager, owner: actor.owner },
      rules: { openDays: REVIEW_OPEN_DAYS, unattestedDays: UNATTESTED_DAYS, dormantDays: DORMANT_DAYS },
      schedule: { automatic: cfg.mode === 'enforced', mode: cfg.mode, thisMonth: { kind: nextKind, period: periodOf(nextKind, now) },
        why: cfg.mode === 'enforced'
          ? 'Reviews open by themselves on the 1st of each month: the quarterly review in January, April, July and October, the monthly sensitive-access review in the other months.'
          : 'Sign-in is optional, so reviews do not open by themselves: nobody is obliged to sign in to attest, and unattested access would end. Open one here; once sign-in is required they open on the 1st of each month.' },
    });
  }));

  app.post('/api/access/reviews/open', wrap(async (req, res) => {
    const fm = manager(req, res, { write: true });
    if (!fm) return undefined;
    const kind = KINDS.includes(req.body?.kind) ? req.body.kind : 'quarterly';
    const r = await openCycle(db, { kind, by: fm.user.id });
    if (r.empty) {
      return fail(res, 409, 'empty', kind === 'monthly'
        ? 'Nobody holds a sensitive class (ID documents in full, driver cash, platform logins, accusations, the audit log or raw records), so there is nothing for a monthly review to cover.'
        : 'Nobody holds a role, so there is nothing to review.');
    }
    if (!r.opened) {
      return fail(res, 409, 'exists', `The ${r.period} ${KIND_WORD[kind]} review is already ${r.existing?.closed_at ? 'finished' : 'open'}.`,
        { period: r.period, cycle: r.existing?.id ?? null });
    }
    await audit(req, 'access.review_opened', 'review', r.cycle.id, { kind, period: r.period, items: r.items, grants: r.grants, memberships: r.memberships });
    return res.json({ ok: true, cycle: r.cycle.id, kind, period: r.period, items: r.items, grants: r.grants,
      memberships: r.memberships, due_at: r.cycle.due_at });
  }));

  /* Keep or revoke, several lines of one review at once. Each line is
     judged on its own: a refusal of one does not stop the others, and the
     answer says, line by line, what happened and why. Revoking needs a
     fresh re-confirmation, as revoking a role does on the Access page. */
  app.post('/api/access/reviews/:id/attest', wrap(async (req, res) => {
    const fm = me(req, res, { write: true });
    if (!fm) return undefined;
    if (fm.access.preview) return fail(res, 403, 'preview', 'You are previewing a role, which is read-only.');
    /* Ids are whole numbers: "1.5" or "abc" reached a bigint comparison in
       Postgres and came back as a 500 rather than the true reason. */
    const cycleId = idOf(req.params.id);
    if (cycleId == null) return fail(res, 404, 'not_found', 'No review has that number.');
    const decisions = Array.isArray(req.body?.decisions) ? req.body.decisions.slice(0, 500) : [];
    if (!decisions.length || decisions.some((d) => idOf(d?.item) == null || typeof d?.keep !== 'boolean')) {
      return fail(res, 400, 'bad_request', 'Send each line as { item, keep: true or false }.');
    }
    if (decisions.some((d) => d.keep === false) && !stepupFresh(fm)) return fail(res, 403, 'stepup', 'Confirm it is you to continue.');
    const actor = actorOf(fm);
    const results = [];
    for (const d of decisions) {
      const reason = String(d.reason || '').trim().slice(0, 500);
      const r = await decideItem(db, { itemId: Number(d.item), cycleId, keep: d.keep, reason, actor });
      results.push({ item: Number(d.item), ok: r.ok, state: r.state || null, error: r.error || null, detail: r.detail || null,
        ...(r.alsoKept?.length ? { alsoKept: r.alsoKept } : {}) });
      if (r.ok) {
        /* `also_kept`: the same access's lines in other open reviews, which
           this keep settled (decideItem) — so the log names every line it
           decided, not only the one asked about. */
        await audit(req, `access.review_${r.state}`, 'review_item', Number(d.item), {
          cycle: r.cycle, line: r.kind, user: r.user, grant: r.grant, team: r.team, roles: r.roles, reason, late: r.late,
          ...(r.alsoKept?.length ? { also_kept: r.alsoKept } : {}) });
      }
    }
    if (results.some((r) => r.ok && r.state === 'revoked')) layer.cache.clear();
    const done = results.filter((r) => r.ok);
    if (!done.length) {
      const first = results[0];
      return fail(res, first.error === 'not_found' ? 404 : first.error === 'decided' || first.error === 'closed' || first.error === 'expired' ? 409 : 403,
        first.error, first.detail, { results });
    }
    return res.json({ ok: true, results, kept: done.filter((r) => r.state === 'kept').length,
      revoked: done.filter((r) => r.state === 'revoked').length, gone: done.filter((r) => r.state === 'gone').length,
      refused: results.length - done.length });
  }));

  app.post('/api/access/reviews/:id/close', wrap(async (req, res) => {
    const fm = manager(req, res, { write: true, stepup: true });
    if (!fm) return undefined;
    const id = idOf(req.params.id);
    if (id == null) return fail(res, 404, 'not_found', 'No open review with that number.');
    const r = await closeCycle(db, { cycleId: id, by: fm.user.id });
    if (!r.closed) return fail(res, 404, 'not_found', 'No open review with that number.');
    layer.cache.clear();
    await audit(req, 'access.review_closed', 'review', id, { unattested: r.unattested, gone: r.gone,
      kept_last_owner: r.keptOwner, ends: r.expires_at });
    return res.json({ ok: true, unattested: r.unattested, gone: r.gone, keptOwner: r.keptOwner, expires_at: r.expires_at });
  }));
}
