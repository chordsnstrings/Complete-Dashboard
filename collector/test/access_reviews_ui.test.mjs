/* THE PAGES OF ULM PHASE 4 — who is on a finding, and the review cards.
   ═════════════════════════════════════════════════════════════════════════
   In a real browser against mockapi.mjs, with the access answers given by
   this file (page.route), the way the server answers them
   (api/access/findings.js, api/access/reviews.js — whose rules
   test/access_reviews.test.mjs proves on a real database):

     #action/<rule>/<subject>  "Who is on it" (api/public/findingowner.js):
       a visitor while sign-in is optional is told it is for signed-in
       people and nothing is asked of the server; a signed-in Operations
       manager takes it, closes it saying what was done, and a refusal shows
       the server's own sentence; the absence band no longer claims that
       nothing records who acted.
     #account  a team lead's "Access reviews waiting for you"
       (api/public/reviews_ui.js): their team's lines, Keep / Take out, one
       Attest that sends each line's choice and the reason.
     #access/reviews  an Owner's open review: a card per team and one for
       roles given directly; their own line says why they cannot decide it;
       "Open this quarter's review" reports what it opened.

   Synthetic people only (@example.test).

   REVERSIONS, each run on 2026-11-12 and each failing as named:
     findingowner.js draw(): fetch /api/access/findings for a visitor too →
       "a visitor … nothing is asked of the server" fails.
     reviews_ui.js card(): send keep: true for every line → "the Attest sends
       each line's choice, and the reason" fails.
     app.js actionContract: drop the ownerSlot import → every #action check
       but the visitor's fails ("Who is on it" never appears). */
import { app as mock } from '../mockapi.mjs';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const srv = mock.listen(0); await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const finding = (await (await fetch(`${base}/api/insights`)).json()).insights.find((i) => i.entity_id && i.entity_type === 'vehicle');

const LEVELS = Object.fromEntries(['ID', 'CT', 'EARN', 'COND', 'ACCUSE', 'REV', 'BK', 'LOC', 'VEH', 'SYS'].map((c) => [c, 'F']));
const meAs = ({ id, name, caps, teams = [], owner = false }) => ({
  mode: 'open', fleets: [{ id: 'ecosine', name: 'Ecosine' }, { id: 'egari', name: 'Egari' }], now: new Date().toISOString(),
  signedIn: true, kind: 'user', user: { id, email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.test`, name, prefs: {}, totp: owner },
  restricted: null, mfaRequired: owner, owner, preview: null, roles: owner ? ['OWN'] : ['OPS'], grants: [], teams,
  access: { levels: LEVELS, levelsAny: LEVELS, byFleet: { ecosine: LEVELS, egari: LEVELS }, caps, capsAny: caps,
    scope: ['ecosine', 'egari'], allScope: true, preview: null },
  stepupFresh: true,
});
const OPS = meAs({ id: 4, name: 'Test Ops', caps: ['finding.own', 'export', 'agent.ask'] });

const browser = await launchChromium();
async function open(hash, { me = null, routes = {} } = {}) {
  /* serviceWorkers blocked (integration, 2026-11-12): the desktop now registers
     /sw.js (ARK), and Playwright's route() does not see a request the worker
     answers — the findings stub went unread once the worker took the page, the
     panel read the mock server's answer instead and said "its rule no longer
     finds it", and the Close button the test waits for never came. */
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  const asked = [];
  if (me) await page.route('**/api/auth/me*', (r) => r.fulfill({ json: me }));
  for (const [pattern, fn] of Object.entries(routes)) {
    await page.route(pattern, async (r) => { asked.push(`${r.request().method()} ${new URL(r.request().url()).pathname}`); return fn(r); });
  }
  await page.goto(`${base}/#${hash}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  return { page, errs, asked, close: () => ctx.close() };
}
const text = async (page, sel) => (await page.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ');

console.log('\n1. who is on a finding, on its own page');
const actionHash = `action/${finding.code}/${finding.entity_id}`;
{
  const v = await open(actionHash, { routes: { '**/api/access/findings**': (r) => r.fulfill({ json: { signedIn: false, findings: [] } }) } });
  const t = await text(v.page, '[data-panel="act-owner"]');
  check('a visitor while sign-in is optional is told it is for signed-in people, and nothing is asked of the server',
    /recorded for signed-in people/.test(t) && /Sign in/.test(t) && !v.asked.some((a) => a.includes('/api/access/findings')), `${t} ${JSON.stringify(v.asked)}`);
  const band = await v.page.locator('body').innerText();
  check('the page no longer says nothing records who acted', !/Whether anyone acted/i.test(band) && /Whether the fix worked/i.test(band), band.slice(-600));
  check('…and no script error', v.errs.length === 0, v.errs.join(' | '));
  await v.close();
}
{
  let state = { signedIn: true, findings: [], open: true, canOwn: true, me: 4, computed_at: new Date().toISOString(),
    people: [{ id: 4, name: 'Test Ops' }, { id: 5, name: 'Test Ops Egari' }],
    outcomes: { acted: 'Dealt with', no_action: 'No action needed', wrong: 'The finding is wrong' } };
  const posts = [];
  let refuseNext = false;
  const s = await open(actionHash, { me: OPS, routes: {
    '**/api/access/findings?**': (r) => r.fulfill({ json: state }),
    '**/api/access/findings/*': async (r) => {
      const body = JSON.parse(r.request().postData() || '{}');
      const act = new URL(r.request().url()).pathname.split('/').pop();
      posts.push([act, body]);
      if (refuseNext) { refuseNext = false; return r.fulfill({ status: 403, json: { error: 'not_allowed', detail: 'Your role cannot take, assign or close findings about egari.' } }); }
      const now = new Date().toISOString();
      if (act === 'take') state = { ...state, findings: [{ state: 'taken', owner: { id: 4, name: 'Test Ops' }, assigned_by: null, taken_at: now }] };
      if (act === 'close') state = { ...state, findings: [{ state: 'closed', owner: { id: 4, name: 'Test Ops' }, closed_by: { id: 4, name: 'Test Ops' }, closed_at: now, outcome: body.outcome, outcome_text: 'Dealt with', note: body.note }] };
      return r.fulfill({ json: { ok: true } });
    },
  } });
  const p = s.page;
  const t0 = await text(p, '[data-panel="act-owner"]');
  check('a signed-in Operations manager sees that nobody is on it, and can take it',
    /Nobody is on this finding/.test(t0) && await p.locator('[data-owner="take"]').count() === 1, t0);
  await p.locator('[data-owner="take"]').click();
  await p.waitForTimeout(400);
  const t1 = await text(p, '[data-panel="act-owner"]');
  check('taking it sends the finding’s key, and the panel then says who is on it',
    posts[0]?.[0] === 'take' && posts[0][1].code === finding.code && posts[0][1].entity_id === finding.entity_id && /On it\s*You/i.test(t1),
    `${JSON.stringify(posts)} ${t1}`);
  await p.locator('[data-owner="close"]').click();
  await p.waitForTimeout(200);
  check('closing without saying what was done is stopped on the page, with the reason',
    posts.length === 1 && /Say what was done/.test(await text(p, '[data-panel="act-owner"] .fo-msg')));
  refuseNext = true;
  await p.locator('.fo-note-in').fill('Moved the car to the airport rank.');
  await p.locator('[data-owner="close"]').click();
  await p.waitForTimeout(400);
  check('a refusal shows the server’s own sentence beside the buttons',
    /cannot take, assign or close findings about egari/.test(await text(p, '[data-panel="act-owner"] .fo-msg')));
  await p.locator('[data-owner="close"]').click();
  await p.waitForTimeout(400);
  const t2 = await text(p, '[data-panel="act-owner"]');
  check('closed: by whom, how it ended and what was done',
    posts[posts.length - 1][0] === 'close' && posts[posts.length - 1][1].note === 'Moved the car to the airport rank.'
      && /Closed by Test Ops/i.test(t2) && /Dealt with/.test(t2) && /airport rank/.test(t2) && /reopen/i.test(t2), t2);
  check('…and no script error', s.errs.length === 0, s.errs.join(' | '));
  await s.close();
}

console.log('\n2. a team lead’s reviews, on their account page');
{
  const LEAD = meAs({ id: 2, name: 'Test Lead', caps: ['export', 'agent.ask'], teams: [{ id: 1, name: 'Night shift', lead: true }] });
  const cycle = { id: 7, kind: 'quarterly', period: '2026-Q4', opened_at: new Date().toISOString(), due_at: new Date(Date.now() + 9 * 864e5).toISOString(),
    closed_at: null, counts: { pending: 2 }, overdue: false };
  const line = (id, uid, name) => ({ id, cycle_id: 7, kind: 'membership', team_id: 1, team_name: 'Night shift', user_id: uid, user_name: name,
    user_status: 'active', roles: ['TEC'], fleets: null, reviewer_id: 2, state: 'pending', canDecide: true, why: null });
  let answer = { cycles: [cycle], items: [line(31, 3, 'Test Cash'), line(32, 4, 'Test Ops')], me: { id: 2, manager: false } };
  let sent = null;
  const s = await open('account', { me: LEAD, routes: {
    '**/api/access/reviews': (r) => r.fulfill({ json: answer }),
    '**/api/access/reviews/7/attest': (r) => {
      sent = JSON.parse(r.request().postData() || '{}');
      answer = { cycles: [], items: [], me: answer.me };
      return r.fulfill({ json: { ok: true, kept: 1, revoked: 1, gone: 0, refused: 0, results: [{ item: 31, ok: true, state: 'kept' }, { item: 32, ok: true, state: 'revoked' }] } });
    },
  } });
  const p = s.page;
  const t0 = await text(p, '[data-panel="acct-reviews"]');
  check('the lead is shown their team’s lines to attest', /Access reviews waiting for you/i.test(t0) && /Test Cash/.test(t0) && /Test Ops/.test(t0)
    && /Night shift/.test(t0), t0);
  await p.locator('[data-line="32"] input[value="remove"]').check();
  await p.locator('[data-acx="review-reason"]').fill('moved to days');
  await p.locator('[data-panel="acct-reviews"] [data-acx="attest"]').click();
  await p.waitForTimeout(500);
  check('the Attest sends each line’s choice, and the reason', JSON.stringify(sent) === JSON.stringify({ decisions: [
    { item: 31, keep: true }, { item: 32, keep: false, reason: 'moved to days' }] }), JSON.stringify(sent));
  const after = await p.locator('#view').innerText();
  check('…and says what happened, even with nothing left waiting', /Team Night shift attested for 2026-Q4: 1 line taken out/.test(after), after.slice(0, 400));
  check('…and no script error', s.errs.length === 0, s.errs.join(' | '));
  await s.close();
}

console.log('\n3. the Owner’s open review, on Set up → Access → Reviews');
{
  const OWN = meAs({ id: 1, name: 'Test Owner', caps: ['access.manage', 'export', 'finding.own', 'agent.ask'], owner: true });
  const overview = { users: [{ id: 1, email: 'test.owner@example.test', name: 'Test Owner', status: 'active' },
    { id: 3, email: 'test.cash@example.test', name: 'Test Cash', status: 'active' }],
  teams: [{ id: 1, name: 'Night shift', members: [3], lead_user_id: 2 }], grants: [], requests: [], devices: [], owners: [1],
  fleets: [{ id: 'ecosine', name: 'Ecosine' }, { id: 'egari', name: 'Egari' }], roles: [], classes: [], caps: [],
  config: { mode: 'open' }, me: { id: 1, owner: true, levels: LEVELS, caps: ['access.manage'], scope: ['ecosine', 'egari'] } };
  const cycle = { id: 7, kind: 'quarterly', period: '2026-Q4', opened_at: new Date().toISOString(), opened_by: 1,
    due_at: new Date(Date.now() + 9 * 864e5).toISOString(), closed_at: null, counts: { pending: 3 }, overdue: false };
  const answer = { cycles: [cycle], me: { id: 1, manager: true, owner: true },
    rules: { openDays: 14, unattestedDays: 14, dormantDays: 60 },
    schedule: { automatic: false, mode: 'open', thisMonth: { kind: 'monthly', period: '2026-11' }, why: 'Sign-in is optional, so reviews do not open by themselves.' },
    items: [
      { id: 1, cycle_id: 7, kind: 'grant', grant_id: 1, user_id: 1, user_name: 'Test Owner', user_status: 'active', roles: ['OWN'], fleets: null,
        owner_only: true, state: 'pending', canDecide: false, why: 'You cannot attest your own access. Another Owner or Access admin must.' },
      { id: 2, cycle_id: 7, kind: 'grant', grant_id: 2, user_id: 3, user_name: 'Test Cash', user_status: 'active', roles: ['CLK'], fleets: ['egari'],
        state: 'pending', canDecide: true, why: null },
      { id: 3, cycle_id: 7, kind: 'membership', team_id: 1, team_name: 'Night shift', user_id: 3, user_name: 'Test Cash', user_status: 'active',
        roles: ['TEC'], fleets: null, reviewer_id: 2, state: 'pending', canDecide: true, why: null },
    ] };
  let opened = null;
  const s = await open('access/reviews', { me: OWN, routes: {
    '**/api/access/overview': (r) => r.fulfill({ json: overview }),
    '**/api/access/reviews': (r) => r.fulfill({ json: answer }),
    '**/api/access/reviews/open': (r) => { opened = JSON.parse(r.request().postData() || '{}');
      return r.fulfill({ json: { ok: true, cycle: 8, kind: 'quarterly', period: '2026-Q4', items: 9, grants: 6, memberships: 3, due_at: cycle.due_at } }); },
  } });
  const p = s.page;
  const direct = await text(p, '[data-review-group="direct"]');
  const team = await text(p, '[data-review-group="team-1"]');
  check('a card for roles given directly, and one per team', /Roles given directly/.test(direct) && /Team Night shift/.test(team), `${direct} | ${team}`);
  check('the Owner’s own line says why they cannot decide it, with no buttons',
    /cannot attest your own access/.test(direct) && await p.locator('[data-line="1"] input').count() === 0, direct);
  check('…the others can be kept or revoked', await p.locator('[data-line="2"] input[value="remove"]').count() === 1
    && await p.locator('[data-line="3"] input[value="remove"]').count() === 1);
  check('the schedule says why nothing opens by itself while sign-in is optional',
    /do not open by themselves/.test(await text(p, '[data-panel="acx-review-open"]')));
  await p.locator('[data-acx="review-open"]').click();
  await p.waitForTimeout(600);
  const flash = await text(p, '[data-acx="flash"]');
  check('opening this quarter’s review says what it opened', opened?.kind === 'quarterly'
    && /Opened the 2026-Q4 quarterly review: 9 lines to attest \(6 roles given directly, 3 team places\)/.test(flash), `${JSON.stringify(opened)} ${flash}`);
  check('…and no script error', s.errs.length === 0, s.errs.join(' | '));
  await s.close();
}

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
