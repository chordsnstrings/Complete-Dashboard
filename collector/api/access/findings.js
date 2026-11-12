/* Who is on a finding — take, assign and close a finding on #insights.
   ─────────────────────────────────────────────────────────────────────────
   docs/ULM-DESIGN.md §8 act:finding.own ("take, assign and close a finding
   on #insights — records who acted"; held by the Operations managers,
   Safety & compliance, Management and the Owner), §13 phase 4 ("finding
   ownership"). Until 2026-11-12 both #insights and each finding's own page
   (#action/<rule>/<subject>) said, truthfully, "Whether anyone acted: not
   recorded — a finding carries no acknowledgement and no owner". A finding
   left the list when its rule stopped finding it, and nothing could tell a
   person's fix from the fact simply changing.

   A FINDING is the insight table's own key: its rule (`code`) and what it is
   about (`entity_type`, `entity_id`) — the key /api/insights deduplicates on,
   so ownership survives every recomputation of the rule. NULL parts of the
   key are stored as ''. sql/schema_v122.sql finding_owner holds the CURRENT
   state; every change is also appended to the hash-chained audit log
   (finding.taken / .assigned / .closed / .reopened), which is the history.

     state   open    nobody is on it (no row at all means the same)
             taken   `owner_id` is on it — took it, or was assigned it
             closed  someone closed it, saying how: dealt with (acted), no
                     action needed (no_action), or the finding is wrong
                     (wrong), and what they did (a note)

   WHO. Reading: a signed-in person who may read #insights' findings (driver
   identity at any level — the class /api/insights is declared under) or who
   may take findings; each row only where they hold driver identity (or
   finding.own) over that row's fleet (seesFleet, below). Acting: a
   signed-in person holding finding.own OVER THE FINDING'S FLEET — the fleet
   is read from the finding itself, never from the request. A visitor while
   sign-in is optional sees nothing here and can do nothing: taking a finding
   records who acted, and a visitor has no name to record. So open mode is
   unchanged until somebody signs in.

   Under /api/access/, which the manifest declares `self` (the handler
   decides) and the response cache never stores — an ownership changed by a
   click must show on the next read, which a cached answer would not. */
import * as svc from './service.js';

export const OUTCOMES = Object.freeze({ acted: 'Dealt with', no_action: 'No action needed', wrong: 'The finding is wrong' });
const ACTIONS = ['take', 'assign', 'close', 'reopen'];
const MIN_NOTE = 3;
const num = (v) => (v == null ? null : Number(v));
const iso = (v) => (v == null ? null : new Date(v).toISOString());

export const findingKey = (src = {}) => ({
  code: String(src.code ?? '').trim().slice(0, 80),
  entity_type: String(src.entity_type ?? '').trim().slice(0, 40),
  entity_id: String(src.entity_id ?? '').trim().slice(0, 200),
});

/* The finding as the rules last wrote it, or null when no rule finds it. */
export async function currentFinding(db, key) {
  const { rows } = await db.query(
    `SELECT fleet_id, computed_at, title FROM insight
      WHERE code = $1 AND COALESCE(entity_type, '') = $2 AND COALESCE(entity_id, '') = $3
      ORDER BY computed_at DESC LIMIT 1`, [key.code, key.entity_type, key.entity_id]);
  return rows[0] || null;
}
async function ownerRow(db, key) {
  const { rows } = await db.query(
    'SELECT * FROM finding_owner WHERE code = $1 AND entity_type = $2 AND entity_id = $3', [key.code, key.entity_type, key.entity_id]);
  return rows[0] || null;
}
async function write(db, key, v) {
  await db.query(
    `INSERT INTO finding_owner (code, entity_type, entity_id, fleet_id, state, owner_id, assigned_by, taken_at,
                                closed_at, closed_by, outcome, note, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13)
     ON CONFLICT (code, entity_type, entity_id) DO UPDATE SET
       fleet_id = EXCLUDED.fleet_id, state = EXCLUDED.state, owner_id = EXCLUDED.owner_id,
       assigned_by = EXCLUDED.assigned_by, taken_at = EXCLUDED.taken_at, closed_at = EXCLUDED.closed_at,
       closed_by = EXCLUDED.closed_by, outcome = EXCLUDED.outcome, note = EXCLUDED.note,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key.code, key.entity_type, key.entity_id, v.fleet_id, v.state, v.owner_id, v.assigned_by, v.taken_at,
      v.closed_at, v.closed_by, v.outcome, v.note, v.updated_by]);
}

/* May this person act on findings about `fleet` (null: every fleet)? */
const canOwn = (access, fleet) => access.capsOver(fleet ? [fleet] : access.allFleets).includes('finding.own');
/* …and may they read who is on findings at all? */
const mayRead = (access) => Boolean(access.levelsAny?.ID) || (access.capsAny || []).includes('finding.own');
/* WHICH ROWS: a finding about a fleet, to a reader who holds driver identity
   — or finding.own — OVER THAT FLEET; a finding about every fleet (no
   fleet), only to one who holds it over every fleet. This is /api/insights'
   own judgement (manifest subject ID, fleet 'param': the levels are those
   held over the fleet asked about, the minimum over every fleet when none
   is). It was `access.scope.includes(fleet)` — the fleets the reader holds
   ANY class over — so an Access admin (SYS and AUDIT, no driver identity)
   who was also a Dispatcher over Egari read Ecosine's ownership rows: what
   each finding is about, who is on it, and the closing note, which is free
   text about a driver or a car — rows /api/insights itself refuses them
   (independent review, 2026-11-12). */
const seesFleet = (access, fleet) => (fleet
  ? Boolean(access.byFleet?.[fleet]?.ID) || access.capsOver([fleet]).includes('finding.own')
  : Boolean(access.levels?.ID) || (access.caps || []).includes('finding.own'));
/* Acting still asks, besides finding.own over the finding's fleet, that the
   fleet be one the person holds any class over — unchanged from the build. */
const inScope = (access, fleet) => (fleet ? access.scope.includes(fleet) : access.allScope);
const notYours = (fleet) => (fleet
  ? `This finding is about ${fleet}, and driver identity for ${fleet} is not shown to your role, so who is on it is not either.`
  : 'This finding is about every fleet, and driver identity for every fleet is not shown to your role, so who is on it is not either.');

export function findingRoutes(app, { db, wrap, h }) {
  const { me, fail, audit, noStore } = h;
  const names = async (ids) => {
    const want = [...new Set(ids.filter((x) => x != null).map(Number))];
    if (!want.length) return new Map();
    const { rows } = await db.query('SELECT id, name, email FROM access_user WHERE id = ANY($1::bigint[])', [want]);
    return new Map(rows.map((r) => [num(r.id), r.name || r.email]));
  };
  /* People who could be given this finding: active, and holding finding.own
     over its fleet. Only asked for one finding at a time, for the assign
     list; a company has tens of accounts, not thousands. */
  const assignable = async (fleet) => {
    const out = [];
    for (const u of await svc.listUsers(db)) {
      if (u.status !== 'active') continue;
      const { access } = await svc.accessForUser(db, u.id);
      if (canOwn(access, fleet)) out.push({ id: u.id, name: u.name || u.email });
    }
    return out;
  };

  app.get('/api/access/findings', wrap(async (req, res) => {
    noStore(res);
    if (!req.fm || req.fm.kind === 'anonymous') {
      /* Not a 401: the page asks on behalf of a visitor while sign-in is
         optional, and a 401 would send that visitor to the sign-in page. */
      return res.json({ signedIn: false, findings: [],
        why: 'Who is on a finding is recorded for signed-in people, and shown to them. Sign in to see it, or to take one.' });
    }
    const fm = me(req, res);
    if (!fm) return undefined;
    if (!mayRead(fm.access)) {
      return fail(res, 403, 'not_allowed', 'Findings name drivers and cars, and driver identity is not shown to your role, so who is on them is not either.');
    }
    const one = req.query.code != null ? findingKey(req.query) : null;
    const { rows } = one
      ? await db.query('SELECT * FROM finding_owner WHERE code = $1 AND entity_type = $2 AND entity_id = $3', [one.code, one.entity_type, one.entity_id])
      : await db.query(`SELECT * FROM finding_owner WHERE state <> 'open' ORDER BY updated_at DESC LIMIT 500`);
    const live = one ? await currentFinding(db, one) : null;
    const fleetOfOne = live ? live.fleet_id : rows[0]?.fleet_id ?? null;
    if (one && (live || rows[0]) && !seesFleet(fm.access, fleetOfOne)) {
      return fail(res, 403, 'not_allowed', notYours(fleetOfOne));
    }
    const shown = rows.filter((r) => seesFleet(fm.access, r.fleet_id));
    const who = await names(shown.flatMap((r) => [r.owner_id, r.assigned_by, r.closed_by, r.updated_by]));
    const person = (id) => (id == null ? null : { id: num(id), name: who.get(num(id)) || `person ${id}` });
    const findings = shown.map((r) => ({
      code: r.code, entity_type: r.entity_type, entity_id: r.entity_id, fleet_id: r.fleet_id, state: r.state,
      owner: person(r.owner_id), assigned_by: person(r.assigned_by), taken_at: iso(r.taken_at),
      closed_at: iso(r.closed_at), closed_by: person(r.closed_by), outcome: r.outcome, outcome_text: OUTCOMES[r.outcome] || null,
      note: r.note || '', updated_at: iso(r.updated_at), updated_by: person(r.updated_by),
    }));
    const out = { signedIn: true, findings, outcomes: OUTCOMES, me: fm.user.id };
    if (one) {
      const exists = Boolean(live || rows[0]);
      out.open = Boolean(live);
      out.computed_at = iso(live?.computed_at);
      out.fleet_id = fleetOfOne;
      out.canOwn = exists && !fm.access.preview && canOwn(fm.access, fleetOfOne);
      out.why = out.canOwn ? null
        : !exists ? 'No rule finds this any more, and nobody took it, so there is nothing to act on.'
          : fm.access.preview ? 'You are previewing a role, which is read-only.'
            : 'Taking a finding is for the Operations managers, Safety & compliance, Management and the Owner — your role cannot take findings about this fleet.';
      if (out.canOwn && live) out.people = await assignable(fleetOfOne);
    }
    return res.json(out);
  }));

  app.post('/api/access/findings/:action', wrap(async (req, res) => {
    const action = String(req.params.action);
    if (!ACTIONS.includes(action)) return fail(res, 404, 'not_found', 'A finding can be taken, assigned, closed or reopened — nothing else.');
    if (!req.fm || req.fm.kind === 'anonymous') {
      return fail(res, 401, 'signin', 'Sign in to act on a finding: taking, assigning and closing one records who acted, and a visitor who has not signed in has no name to record.');
    }
    const fm = me(req, res, { write: true });
    if (!fm) return undefined;
    if (fm.access.preview) return fail(res, 403, 'preview', 'You are previewing a role, which is read-only.');
    const key = findingKey(req.body || {});
    if (!key.code) return fail(res, 400, 'bad_request', 'Name the finding: its rule (code) and what it is about (entity_type, entity_id).');
    const [live, row] = await Promise.all([currentFinding(db, key), ownerRow(db, key)]);
    if (!live && !row) return fail(res, 404, 'not_found', 'No finding has that rule and subject.');
    if (!live && (action === 'take' || action === 'assign')) {
      return fail(res, 409, 'gone', 'This finding is no longer open — its rule stopped finding it — so it can be closed, not taken.');
    }
    /* The fleet from the finding itself; a stale ownership row keeps the
       fleet it was taken under. */
    const fleet = live ? live.fleet_id : row.fleet_id;
    if (!inScope(fm.access, fleet) || !canOwn(fm.access, fleet)) {
      return fail(res, 403, 'not_allowed', fleet
        ? `Your role cannot take, assign or close findings about ${fleet}.`
        : 'This finding is about every fleet, and your role cannot take findings for every fleet.');
    }
    const now = new Date();
    const was = row ? { state: row.state, owner: num(row.owner_id), outcome: row.outcome } : { state: 'open', owner: null, outcome: null };
    const base = { fleet_id: fleet, owner_id: num(row?.owner_id), assigned_by: num(row?.assigned_by), taken_at: row?.taken_at || null,
      closed_at: row?.closed_at || null, closed_by: num(row?.closed_by), outcome: row?.outcome || null, note: row?.note || '',
      updated_by: fm.user.id };
    let next; let detail = {};
    if (action === 'take') {
      if (was.state === 'taken' && was.owner === fm.user.id) return fail(res, 409, 'already', 'You are already on this finding.');
      next = { ...base, state: 'taken', owner_id: fm.user.id, assigned_by: null, taken_at: now, closed_at: null, closed_by: null, outcome: null, note: '' };
    } else if (action === 'assign') {
      const to = Number(req.body?.userId);
      const target = Number.isFinite(to) ? await svc.getUser(db, to) : null;
      if (!target || target.status !== 'active') return fail(res, 400, 'bad_person', 'Choose someone whose account is active.');
      const { access: theirs } = await svc.accessForUser(db, to);
      if (!canOwn(theirs, fleet)) {
        return fail(res, 400, 'cannot_own', `${target.name || target.email}’s role cannot take findings ${fleet ? `about ${fleet}` : 'about every fleet'}.`);
      }
      if (was.state === 'taken' && was.owner === to) return fail(res, 409, 'already', `${target.name || target.email} is already on this finding.`);
      next = { ...base, state: 'taken', owner_id: to, assigned_by: to === fm.user.id ? null : fm.user.id, taken_at: now,
        closed_at: null, closed_by: null, outcome: null, note: '' };
      detail = { to };
    } else if (action === 'close') {
      const outcome = String(req.body?.outcome || '');
      const note = String(req.body?.note || '').trim().slice(0, 1000);
      if (!OUTCOMES[outcome]) return fail(res, 400, 'outcome', 'Say how it ended: dealt with, no action needed, or the finding is wrong.');
      if (note.length < MIN_NOTE) return fail(res, 400, 'note', 'Say what was done — it is what “who acted” means.');
      if (was.state === 'closed') return fail(res, 409, 'already', 'This finding is already closed.');
      next = { ...base, state: 'closed', closed_at: now, closed_by: fm.user.id, outcome, note };
      detail = { outcome, note };
    } else {
      if (was.state === 'open') return fail(res, 409, 'already', 'Nobody is on this finding, so there is nothing to reopen.');
      const note = String(req.body?.note || '').trim().slice(0, 1000);
      next = { ...base, state: 'open', owner_id: null, assigned_by: null, taken_at: null, closed_at: null, closed_by: null, outcome: null, note };
      detail = { note };
    }
    await write(db, key, next);
    await audit(req, `finding.${{ take: 'taken', assign: 'assigned', close: 'closed', reopen: 'reopened' }[action]}`, 'finding',
      `${key.code}/${key.entity_type}/${key.entity_id}`, { ...key, fleet, was: was.state, was_owner: was.owner, ...detail });
    return res.json({ ok: true, state: next.state, owner: next.owner_id });
  }));
}
