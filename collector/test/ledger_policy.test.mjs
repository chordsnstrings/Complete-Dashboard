/* THE LINE ITSELF — and the three ways storing one goes wrong.
   ══════════════════════════════════════════════════════════════════════════
   The operator: "that percentage will change based on admin / operational head
   / management - so don't hardcode it keep it as a variable in settings which
   will be allocated to the usergroup later."

   Until this route existed there was no way to store one, and every exposure
   figure on production read "no threshold has been stored, so no exposure can
   be judged" — true, honest, and useless.

   1. APPEND-ONLY IS NOT A STYLE. A decision taken in September was taken
      against September's line. An UPDATE would rewrite the reason somebody was
      told they were over it, months after they were told.

   2. 0.35 IS NOT 35. It is a valid percentage and an implausible lending line,
      and under it every driver in the fleet reads as over. It is also exactly
      what a caller sends when they think the field is a fraction — so it is
      refused by name, with the override spelled out, rather than stored.

   3. THE SETTER IS NOT A SUPERVISOR. Those four record money at a car; moving
      the lending line is a management decision. Checking this against
      SUPERVISORS would write a false attribution into a permanent record, and
      would not be enforcement either way. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const { get, port } = await mountAll(db);
const post = async (body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/ledger/policy`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const stored = async () => (await q(`SELECT count(*)::int n FROM ledger_policy`))[0].n;

/* ── NOTHING STORED IS ABSENT WITH A REASON, NEVER A DEFAULT ──────────── */
const empty = (await get('/api/ledger/policy')).body;
check('with no policy on file, current is null and not a default',
  empty.current === null, JSON.stringify(empty.current));
check('and the reason says what that costs, not merely that it is missing',
  /every driver's exposure reads as not measurable/.test(empty.absent_reason || ''),
  empty.absent_reason);
check('and the route says plainly that it authenticates nobody',
  /not authentication/.test(empty.attribution_only || ''), empty.attribution_only);

/* ── THE DRY RUN IS THE DEFAULT ────────────────────────────────────────── */
const preview = await post({ pct: 35, effective_from: '2026-01-01', set_by: 'Operations',
  note: 'opening policy, as instructed' });
check('a request with no dry_run flag PREVIEWS rather than writing',
  preview.body.ok === true && preview.body.dry_run === true, JSON.stringify(preview.body.dry_run));
check('and nothing reached the table', await stored() === 0, String(await stored()));
check('the preview says so in words rather than leaving it to be assumed',
  /Nothing was written/.test(preview.body.note || ''), preview.body.note);
check('and the sentence is in the conditional, not the past tense',
  /^Would set the line to 35%/.test(preview.body.sentence), preview.body.sentence);

/* ── 0.35 IS NOT 35 ────────────────────────────────────────────────────── */
const frac = await post({ pct: 0.35, effective_from: '2026-01-01', set_by: 'Operations',
  note: 'the fraction mistake', dry_run: false });
check('a fraction sent where a percentage was meant is REFUSED, not stored',
  frac.status === 400 && frac.body.ok === false, JSON.stringify(frac.body).slice(0, 120));
check('and the refusal names the consequence, not just the rule',
  /every driver in the fleet reads as over the line/.test(JSON.stringify(frac.body.refused)),
  JSON.stringify(frac.body.refused));
check('nothing was written by the refused call', await stored() === 0);
/* AND IT IS A GUARD, NOT A WALL. A tiny line is implausible, not impossible. */
const tiny = await post({ pct: 0.35, effective_from: '2026-01-01', set_by: 'Operations',
  note: 'genuinely a third of a percent', allow_implausible: true });
check('an operator who says they meant it is believed',
  tiny.body.ok === true, JSON.stringify(tiny.body.refused || tiny.body.ok));

/* ── THE OTHER REFUSALS, EACH BY NAME ──────────────────────────────────── */
const bad = await post({ pct: 35, effective_from: '2026-13-99', set_by: 'X', note: 'ok then',
  dry_run: false });
check('an impossible date is refused — a shape check passes 2026-13-99',
  /is not a real date/.test(JSON.stringify(bad.body.refused)), JSON.stringify(bad.body.refused));
const noNote = await post({ pct: 35, effective_from: '2026-01-01', set_by: 'Operations', note: '' });
check('a policy with no reason is refused, because the reason IS the record',
  /a year from now/.test(JSON.stringify(noNote.body.refused)), JSON.stringify(noNote.body.refused));
const noBy = await post({ pct: 35, effective_from: '2026-01-01', note: 'nobody set this' });
check('and one with nobody attached to it is refused',
  /attribution and not authentication/.test(JSON.stringify(noBy.body.refused)),
  JSON.stringify(noBy.body.refused));
const scoped = await post({ pct: 35, effective_from: '2026-01-01', set_by: 'Ops',
  note: 'per usergroup', scope: 'drivers-tier-2' });
check('a scope nothing reads is refused rather than accepted and ignored',
  /in force over nobody/.test(JSON.stringify(scoped.body.refused)),
  JSON.stringify(scoped.body.refused));
check('still nothing written', await stored() === 0, String(await stored()));

/* ── THE SETTER IS NOT CHECKED AGAINST THE SUPERVISOR LIST ─────────────── */
/* A name that is nobody on that list must be accepted here, and the same name
   must be refused by /api/ledger/entry. Two assertions, because either alone
   passes against a route that checks nothing and one that checks everything. */
const mgmt = await post({ pct: 35, effective_from: '2026-01-01',
  set_by: 'Operational Head', note: 'opening policy at 35% of revenue to the bank',
  dry_run: false });
check('a management name nobody supervises under is accepted for a POLICY',
  mgmt.body.ok === true && mgmt.body.dry_run === false, JSON.stringify(mgmt.body).slice(0, 200));
const asEntry = await fetch(`http://127.0.0.1:${port}/api/ledger/entry`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ entered_by: 'Operational Head', type_code: 'cash_advance',
    amount: 100, effective_on: '2026-01-01', note: 'x', person_id: 1 }),
}).then((r) => r.json());
check('and the SAME name is refused for an entry — the two lists are not one',
  /is not one of the people who may record money/.test(JSON.stringify(asEntry.refused)),
  JSON.stringify(asEntry.refused));

check('the committed policy is on the table', await stored() === 1, String(await stored()));
check('and the sentence is in the past tense once it is',
  /^Set the line to 35%/.test(mgmt.body.sentence), mgmt.body.sentence);
check('carrying who set it and from when',
  /recorded against Operational Head/.test(mgmt.body.sentence)
  && /from 2026-01-01/.test(mgmt.body.sentence), mgmt.body.sentence);
check('the IP is recorded, because it is half of what makes this traceable',
  (await q(`SELECT set_ip FROM ledger_policy`))[0].set_ip != null,
  JSON.stringify(await q(`SELECT set_ip FROM ledger_policy`)));

/* ── AND EXPOSURE CAN NOW JUDGE ─────────────────────────────────────────── */
const ex = (await get('/api/ledger/exposure')).body;
check('with a line stored, exposure stops refusing for want of one',
  ex.policy != null && ex.policy.pct === 35, JSON.stringify(ex.policy));
check('and no longer carries the absent reason', ex.policy_absent_reason === null,
  String(ex.policy_absent_reason));

/* ── APPEND-ONLY, AND EFFECTIVE-DATED ARE TWO DIFFERENT THINGS ─────────── */
const moved = await post({ pct: 30, effective_from: '2026-06-01', set_by: 'Management',
  note: 'tightened after the June review', dry_run: false });
check('moving the line writes a NEW row', await stored() === 2, String(await stored()));
check('and the old one is untouched, so September reads as September did',
  (await q(`SELECT pct FROM ledger_policy WHERE effective_from='2026-01-01'`))[0].pct == 35);
check('the response says it appended rather than edited',
  /nothing was edited/.test(moved.body.append_only || ''), moved.body.append_only);
check('and names the line it replaces, with who set that one',
  moved.body.prior?.pct === 35 && moved.body.prior?.set_by === 'Operational Head',
  JSON.stringify(moved.body.prior));

/* A POLICY FILED AHEAD OF ITS START DATE IS NOT THE ONE IN FORCE. The newest
   row and the row in force are different things the moment a planned change is
   recorded, which is the normal way one gets recorded. */
await post({ pct: 20, effective_from: '2099-01-01', set_by: 'Management',
  note: 'planned, starts much later', dry_run: false });
const now = (await get('/api/ledger/policy')).body;
check('a policy that starts in the future is stored but NOT in force',
  now.current.pct === 30, JSON.stringify(now.current));
check('and is flagged as starting later rather than quietly listed',
  now.history.find((h) => h.pct === 20)?.starts_later === true,
  JSON.stringify(now.history.map((h) => ({ pct: h.pct, later: h.starts_later }))));
check('exactly one row in the history is in force',
  now.history.filter((h) => h.in_force).length === 1,
  JSON.stringify(now.history.map((h) => ({ pct: h.pct, f: h.in_force }))));
/* FALSE, NOT NULL. With nothing in force the subquery behind in_force is NULL
   and `id = NULL` is NULL rather than false — a boolean field that answers
   null is one a caller writing `=== false` silently gets wrong. */
check('and the others answer false rather than null',
  now.history.filter((h) => !h.in_force).every((h) => h.in_force === false),
  JSON.stringify(now.history.map((h) => h.in_force)));
check('a history read before anything is in force says false for every row',
  (empty.history || []).every((h) => h.in_force === false), JSON.stringify(empty.history));
check('the history is newest first, so the current decision reads first',
  now.history[0].effective_from === '2099-01-01', JSON.stringify(now.history.map((h) => h.effective_from)));

/* ── AND EXPOSURE READS THE LINE IN FORCE ON THE WINDOW, NOT TODAY'S ───── */
const march = (await get('/api/ledger/exposure?from=2026-03-01&to=2026-03-31')).body;
check('a question about March is answered against the line that applied in March',
  march.policy.pct === 35, JSON.stringify(march.policy));
const july = (await get('/api/ledger/exposure?from=2026-07-01&to=2026-07-31')).body;
check('and one about July against July\'s', july.policy.pct === 30, JSON.stringify(july.policy));

console.log(`\n${fail ? '✗' : '✓'} ledger_policy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
