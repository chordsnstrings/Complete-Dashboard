/* FLEETS, NAMED FROM THE PLATFORMS — the store and its HTTP surface.
   ─────────────────────────────────────────────────────────────────────────
   collector/docs/ULM-DESIGN.md §3 (the rule), §3.3 (discovering and linking
   accounts), §10.3 (the screen). The derivation itself is src/fleet_names.js,
   pure; the collector side that records what each platform reports is
   src/sources/discovery.js; the page is api/public/fleetsadmin.js.

     GET  /api/fleets                         every fleet: its brand, where the name came from   SYS
     GET  /api/fleets/accounts                every platform account, the evidence, the changes   CRED
     GET  /api/fleets/accounts/:id/evidence   the plates and drivers behind the counts            Owner
     POST /api/fleets/accounts/:id            {action: link|new|unlink|ignore|unignore, fleet}    fleets.link
     POST /api/fleets/:id/name                {words}: choose a run of the platforms' words       fleets.link
     POST /api/fleets/changes/:id/approve     an Owner who did not propose it                     Owner
     POST /api/fleets/changes/:id/decline     an Owner, or the proposer withdrawing it             Owner / proposer

   WHY A LINK WAITS FOR AN OWNER. Which fleet an account belongs to decides
   which fleet's history its rows are, so a person scoped to one fleet gains
   or loses that account's rows when it moves (§3.3.5). That is an access
   change, and access changes are confirmed by an Owner who did not propose
   them (§6.4, §8: "Connections admin proposes, Owner confirms"). So link,
   unlink, starting a new fleet from an account, and ignoring an account that
   is LINKED are stored as a pending fleet_change with who gains and who
   loses visibility computed there and then; nothing moves until an Owner
   approves it. Choosing a name and ignoring an account nobody has linked move
   nobody's rows, and apply at once — audited, like everything here.

   THE ONLY OWNER. §6.4: "With a single Owner, such a grant waits 24 hours".
   A company whose only Owner proposes a link would otherwise have no one who
   may ever approve it — the operator taking over this deployment is exactly
   that company. So the proposer may approve their own change only when they
   are the only active Owner and it has waited the company's
   single_owner_delay_hours (0 while sign-in is not required, when a delay
   protects nothing — the same rule api/access/routes.js grantDecision
   applies to grants). Anyone else approving their own change is refused.

   WHAT A LINK DOES TODAY, SAID PLAINLY. The collectors still file each
   credential's rows under the fleet src/config.js names. A link records which
   fleet an account belongs to, names the fleet from it, and is what the
   collectors will follow; it does not move rows already stored, and the
   page says so beside every link. Rows already filed under the wrong fleet
   (CABMAN's 64 "Sahalat" snapshots, filed as Ecosine) are listed so an Owner
   can decide what happens to them (§3.3.4).

   THE HANDLERS DECIDE FOR THEMSELVES as well as the gate. While sign-in is
   'open', api/access/middleware.js lets an anonymous request through to every
   route — "exactly what anonymous visitors always saw" — and these routes are
   new, so nobody saw them before. Every write here therefore checks its own
   actor, CSRF header, capability and step-up; the gate's checks are the first
   line, these are the second, and a route that forgot its manifest entry
   still cannot be written to anonymously. */
import {
  deriveFleetName, candidates as nameCandidates, isCandidate, foldRun, brandOf, wordsOf,
  accountLabel, platformLabel, normaliseName, displayRun,
} from '../src/fleet_names.js';
import * as svc from './access/service.js';
import { appendAudit } from './access/audit.js';
import { computeAccess } from './access/principal.js';
import { safeEqual } from './access/crypto.js';
import { withheldSentence } from './public/access_model.js';

const CSRF_COOKIE = 'fm_csrf';
const STEPUP_MINUTES = 10;
const REASON_MAX = 400;
/* Only these platforms report accounts (src/sources/discovery.js). */
export const PLATFORMS = Object.freeze(['uber', 'yango', 'bolt', 'fms', 'cabman', 'hotel']);

const ACCOUNT_COLS = `id, platform, account_id, fleet_id, status, reported_name, name_reason, reported_at,
  source_call, filed_fleet, link_basis, first_seen, last_seen, detail`;
const acctOut = (r) => (r ? { ...r, id: Number(r.id), detail: r.detail || {} } : null);
/* An id from the address, or null. `/api/fleets/changes/undefined/approve`
   reached Postgres as NaN and answered 500 — found by reverting the manifest
   cap in test/fleet_discovery.test.mjs, where the propose was refused and the
   approve went on with no id. A malformed id is simply "no such thing". */
const idParam = (req) => (/^[1-9][0-9]{0,17}$/.test(String(req.params.id || '')) ? Number(req.params.id) : null);

export async function loadAccounts(q) {
  return (await q(`SELECT ${ACCOUNT_COLS} FROM platform_account ORDER BY platform, account_id`)).map(acctOut);
}
export async function loadFleets(q) {
  return q(`SELECT id, name, brand_choice, name_basis, name_derived_at, created_at, created_from FROM fleet ORDER BY id`);
}

/* ── the name, written back where the rest of the product reads it ──────
   fleet.name is what /api/auth/me returns (api/access/service.js allFleets),
   so every page that asks the server for fleet names gets the derived one.
   Called after discovery re-reads the names and after every applied change.
   Returns what changed; each change is audited as the rename it is. */
export async function syncFleetNames(q, { audit = null } = {}) {
  const [fleets, accounts] = await Promise.all([loadFleets(q), loadAccounts(q)]);
  const changed = [];
  for (const f of fleets) {
    const v = deriveFleetName({ id: f.id, accounts: accounts.filter((a) => a.fleet_id === f.id), choice: f.brand_choice });
    if (v.name !== f.name || v.basis !== f.name_basis) {
      await q(`UPDATE fleet SET name = $2, name_basis = $3, name_derived_at = now() WHERE id = $1`, [f.id, v.name, v.basis]);
      changed.push({ id: f.id, from: f.name, to: v.name, basis: v.basis, was: f.name_basis || 'typed in schema.sql' });
    }
  }
  if (changed.length) {
    svc.resetFleetCache();
    for (const c of changed) {
      await audit?.({ action: 'fleet.renamed', subjectType: 'fleet', subjectId: c.id,
        detail: { from: c.from, to: c.to, basis: c.basis, was: c.was } });
    }
  }
  return changed;
}

/* The discovery run's own record: when names were last read, and what each
   platform answered. Kept in source_state by src/sources/discovery.js. */
async function discoveryState(q) {
  const rows = await q(`SELECT key, value, updated_at FROM source_state WHERE source = 'discovery' AND fleet_id = '-'`)
    .catch(() => []);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  let summary = null;
  try { summary = by.last_summary ? JSON.parse(by.last_summary.value) : null; } catch { summary = null; }
  return {
    lastRun: by.last_run?.value || null,
    steps: summary?.steps || [],
    /* Absent with its reason, never an empty list that reads as "asked, and
       nothing answered". */
    reason: by.last_run ? null
      : 'The platforms have not been asked for their names yet: the nightly discovery run has not run on this deployment.',
  };
}

/* ── one fleet, as every page may read it ─────────────────────────────── */
export async function fleetViews(q) {
  const [fleets, accounts] = await Promise.all([loadFleets(q), loadAccounts(q)]);
  const names = await q(
    `SELECT n.account_pk, n.name, n.source_call, n.first_reported, n.last_reported
       FROM platform_account_name n ORDER BY n.account_pk, n.first_reported`);
  const chosen = await q(
    `SELECT c.fleet_id, c.words, c.status, c.proposed_at, c.approved_at, c.reason, u.name AS by_name, u.email AS by_email
       FROM fleet_change c LEFT JOIN access_user u ON u.id = c.proposed_by
      WHERE c.kind = 'name' AND c.status = 'applied' ORDER BY c.proposed_at DESC`).catch(() => []);
  return fleets.map((f) => {
    const mine = accounts.filter((a) => a.fleet_id === f.id);
    const v = deriveFleetName({ id: f.id, accounts: mine, choice: f.brand_choice });
    /* "Renamed by Uber on <date>": an account of this fleet whose name has
       more than one run in its history. */
    const renames = [];
    for (const a of mine) {
      const hist = names.filter((n) => Number(n.account_pk) === a.id);
      for (let i = 1; i < hist.length; i += 1) {
        renames.push({ platform: a.platform, platformLabel: platformLabel(a.platform), account_id: a.account_id,
          from: hist[i - 1].name, to: hist[i].name, at: hist[i].first_reported });
      }
    }
    renames.sort((x, y) => String(y.at).localeCompare(String(x.at)));
    return {
      ...v,
      stored: { name: f.name, basis: f.name_basis, derivedAt: f.name_derived_at },
      created: f.created_at ? { at: f.created_at, fromAccount: f.created_from == null ? null : Number(f.created_from) } : null,
      linked: mine.map((a) => ({ id: a.id, platform: a.platform, platformLabel: platformLabel(a.platform),
        account_id: a.account_id, label: accountLabel(a), reported_name: a.reported_name, name_reason: a.name_reason,
        reported_at: a.reported_at, link_basis: a.link_basis })),
      renames,
      nameChoices: chosen.filter((c) => c.fleet_id === f.id).slice(0, 20).map((c) => ({
        words: c.words, display: c.words ? displayRun(c.words.split(' '), v.reported.map((r) => r.name)) : null,
        at: c.approved_at || c.proposed_at, by: c.by_name || c.by_email || null, reason: c.reason })),
    };
  });
}

/* ── who gains or loses sight of an account's rows ─────────────────────
   For each active person: which fleets their grants cover (computeAccess, the
   rule the gate itself applies). Moving an account from fleet A to fleet B:
   whoever sees B and not A gains its history, whoever sees A and not B loses
   it, and whoever sees every fleet is unaffected. A new fleet is covered only
   by grants over "every fleet" — a grant naming fleets does not grow. */
export async function visibilityImpact(dbh, { from = null, to = null, newFleet = null }) {
  const users = (await svc.listUsers(dbh)).filter((u) => u.status === 'active');
  const roles = await svc.customRoles(dbh);
  const all = (await svc.allFleets(dbh)).map((f) => f.id);
  const fleets = newFleet ? [...all, newFleet] : all;
  const target = newFleet || to;
  const gains = []; const loses = []; let unaffected = 0;
  for (const u of users) {
    const grants = await svc.effectiveGrants(dbh, u.id);
    if (!grants.length) continue;
    const a = computeAccess({ grants, roles, allFleets: fleets });
    const sees = (f) => Boolean(f) && a.scope.includes(f);
    const who = { id: u.id, label: u.name || u.email };
    if (!sees(from) && sees(target)) gains.push(who);
    else if (sees(from) && !sees(target)) loses.push(who);
    else if (sees(from) || sees(target)) unaffected += 1;
  }
  return {
    from, to: target, gains, loses, unaffected,
    rowsFollow: 'configuration',
    note: 'The collectors still file this account’s rows under the fleet src/config.js names, and rows already '
      + 'stored are not moved by a link. The people above gain or lose this account’s history once collection '
      + 'follows the links.',
  };
}
/* A person reading the impact who does not manage access sees how many, not
   who: the names of staff are access data (Set up → Access). */
const impactFor = (impact, full) => (full || !impact ? impact : {
  ...impact, gains: (impact.gains || []).length, loses: (impact.loses || []).length, namesWithheld: true,
});

/* A new fleet's id: the brand it derives, as a key — the way 'ecosine' and
   'egari' already are — or, when the account reports no name, the account's
   own platform and id. Never a number we made up. */
export function newFleetId(account, taken) {
  const slug = (s) => String(s || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const brand = account.reported_name ? slug(brandOf([account.reported_name]).words) : '';
  const own = slug(`${account.platform}-${account.account_id}`);
  for (const id of [brand, brand && `${brand}-${own}`, own]) {
    if (id && !taken.includes(id)) return id;
  }
  return null;
}

/* ── the evidence, counted from our own rows ────────────────────────────
   An account's PLATES: the vehicles it reported itself (CABMAN's and FMS's
   per-vehicle names put each car under a company), or else the plates on the
   trips filed from it — which exist only for the account today's
   configuration collects (filed_fleet). Its DRIVERS: the people (person_key,
   the identity register's fold) on those trips. Shared with a fleet: the same
   plate or person in that fleet's rows from ANOTHER platform, over the last
   WINDOW_DAYS. A count that cannot be made says why instead of saying 0. */
export const WINDOW_DAYS = 180;
export async function accountPlates(q, a) {
  const own = await q(`SELECT plate FROM platform_account_vehicle WHERE account_pk = $1 ORDER BY plate`, [a.id]);
  if (own.length) return { list: own.map((r) => r.plate), source: 'reported', reason: null };
  if (!a.filed_fleet) {
    return { list: [], source: null,
      reason: 'Nothing is collected from this account, so none of our rows can be compared with it.' };
  }
  const rows = await q(
    `SELECT DISTINCT plate FROM trip WHERE platform = $1 AND fleet_id = $2 AND plate IS NOT NULL
        AND requested_at > now() - make_interval(days => $3) ORDER BY plate`, [a.platform, a.filed_fleet, WINDOW_DAYS]);
  return { list: rows.map((r) => r.plate), source: 'trips',
    reason: rows.length ? null : `No trip from this account in the last ${WINDOW_DAYS} days carries a plate.` };
}
export async function accountPersons(q, a) {
  if (a.platform === 'cabman') {
    return { list: [], reason: 'CABMAN’s vehicle feed names no driver, so drivers cannot be compared.' };
  }
  if (!a.filed_fleet) {
    return { list: [], reason: 'Nothing is collected from this account, so none of our rows can be compared with it.' };
  }
  const rows = await q(
    `SELECT DISTINCT person_key FROM trip WHERE platform = $1 AND fleet_id = $2 AND person_key IS NOT NULL
        AND requested_at > now() - make_interval(days => $3)`, [a.platform, a.filed_fleet, WINDOW_DAYS]);
  if (rows.length) return { list: rows.map((r) => r.person_key), reason: null };
  const any = (await q(`SELECT 1 FROM trip WHERE platform = $1 AND fleet_id = $2
        AND requested_at > now() - make_interval(days => $3) LIMIT 1`, [a.platform, a.filed_fleet, WINDOW_DAYS]))[0];
  return { list: [], reason: any ? `This platform’s trips from this account name no driver we can place.`
    : `No trip from this account in the last ${WINDOW_DAYS} days.` };
}
export async function accountEvidence(q, a) {
  const plates = await accountPlates(q, a);
  const persons = await accountPersons(q, a);
  const byFleet = {};
  if (plates.list.length) {
    for (const r of await q(
      `SELECT fleet_id, count(DISTINCT plate)::int AS n FROM (
         SELECT t.fleet_id, t.plate FROM trip t
          WHERE t.plate = ANY($1::text[]) AND t.platform <> $2 AND t.fleet_id IS NOT NULL
            AND t.requested_at > now() - make_interval(days => $3)
         UNION
         SELECT a.fleet_id, v.plate FROM platform_account_vehicle v JOIN platform_account a ON a.id = v.account_pk
          WHERE v.plate = ANY($1::text[]) AND a.status = 'linked' AND a.platform <> $2 AND a.fleet_id IS NOT NULL
       ) s GROUP BY fleet_id`, [plates.list, a.platform, WINDOW_DAYS])) {
      (byFleet[r.fleet_id] ||= {}).plates = r.n;
    }
  }
  if (persons.list.length) {
    for (const r of await q(
      `SELECT t.fleet_id, count(DISTINCT t.person_key)::int AS n FROM trip t
        WHERE t.person_key = ANY($1::text[]) AND t.platform <> $2 AND t.fleet_id IS NOT NULL
          AND t.requested_at > now() - make_interval(days => $3)
        GROUP BY t.fleet_id`, [persons.list, a.platform, WINDOW_DAYS])) {
      (byFleet[r.fleet_id] ||= {}).drivers = r.n;
    }
  }
  return {
    at: new Date().toISOString(), windowDays: WINDOW_DAYS,
    plates: plates.reason && !plates.list.length ? null : plates.list.length, platesSource: plates.source, platesReason: plates.reason,
    drivers: persons.reason && !persons.list.length ? null : persons.list.length, driversReason: persons.reason,
    byFleet,
  };
}

/* ── the evidence behind "which fleet does this account belong to" ─────
   Names are never matched for equality (§3.3.2). The screen proposes a link
   from the brand, the plates the account shares with each fleet and the
   drivers it shares — counted from our own rows by the discovery run and
   kept in detail.evidence. A proposal is only ever that: nothing here links
   anything. */
function suggestionsFor(account, fleetsView) {
  const out = [];
  const ev = account.detail?.evidence;
  const brand = account.reported_name ? brandOf([account.reported_name]).words : '';
  for (const f of fleetsView) {
    if (account.status === 'linked' && account.fleet_id === f.id) continue;
    const fBrand = f.brand ? foldRun(f.brand) : '';
    const sameBrand = Boolean(brand && fBrand && brand === fBrand);
    const plates = ev?.byFleet?.[f.id]?.plates ?? 0;
    const drivers = ev?.byFleet?.[f.id]?.drivers ?? 0;
    if (sameBrand || plates > 0 || drivers > 0) out.push({ fleet: f.id, name: f.name, sameBrand, plates, drivers });
  }
  out.sort((a, b) => Number(b.sameBrand) - Number(a.sameBrand) || b.plates - a.plates || b.drivers - a.drivers);
  return out;
}

export function fleetNameRoutes(app, { q, wrap, db = null, tx = null, log = { info() {}, warn() {}, error() {} } }) {
  const dbh = db || { query: async (t, p) => ({ rows: await q(t, p) }) };
  const inTx = tx ? (fn) => tx(fn) : (fn) => fn(q);
  const audit = (req, entry) => appendAudit(dbh, {
    actorId: req?.fm?.user?.id ?? null,
    actorLabel: req?.fm?.user?.email || (req ? req.fm?.kind || 'anonymous' : 'system'),
    ip: req?.ip ?? null, ua: req?.get?.('user-agent') ?? null, ...entry,
  }).catch((e) => log.error('fleets', 'audit failed', { err: String(e).slice(0, 200) }));

  const noStore = (res) => res.set('Cache-Control', 'no-store');
  const fail = (res, status, error, detail, extra = {}) => { noStore(res); return res.status(status).json({ error, detail, ...extra }); };
  const isOwner = (fm) => (fm?.grants || []).some((g) => g.role_code === 'OWN');
  const csrfOk = (req) => {
    const want = req.fmCookies?.[CSRF_COOKIE];
    return Boolean(want) && safeEqual(req.get('x-fm-csrf') || '', want);
  };
  const stepupFresh = (fm) => fm.session?.stepup_at
    && Date.now() - new Date(fm.session.stepup_at).getTime() < STEPUP_MINUTES * 60_000;

  /* The actor of a change: signed in as a person, not restricted to finishing
     their account, not previewing a role, carrying the CSRF header, and
     holding fleets.link over every fleet the change touches. */
  const actor = (req, res, fleets = []) => {
    const fm = req.fm;
    if (!fm || fm.kind !== 'user' || !fm.user) { fail(res, 401, 'signin', 'Sign in to change fleets.'); return null; }
    if (fm.restricted) { fail(res, 403, 'restricted', 'Finish setting up your account first.', { need: fm.restricted }); return null; }
    if (fm.access?.preview) { fail(res, 403, 'preview', 'You are previewing a role, which is read-only.'); return null; }
    if (!csrfOk(req)) { fail(res, 403, 'csrf', 'Reload the page and try again.'); return null; }
    const over = fleets.filter(Boolean);
    const caps = over.length ? fm.access.capsOver(over) : (fm.access.capsAny || []);
    if (!caps.includes('fleets.link')) {
      fail(res, 403, 'not_allowed', over.length
        ? `Your role cannot link accounts to ${over.join(' and ')}: fleets.link over ${over.length > 1 ? 'those fleets' : 'that fleet'} is held by the Connections admin and the Owner.`
        : 'Your role cannot change fleets: that is the Connections admin’s and the Owner’s.', { cap: 'fleets.link' });
      return null;
    }
    return fm;
  };
  /* Reading accounts: platform logins' territory (CRED). */
  const reader = (req, res) => {
    const fm = req.fm;
    if (fm?.kind === 'system') return fm;
    if (!fm || fm.kind !== 'user') { fail(res, 401, 'signin', 'Sign in to see platform accounts.'); return null; }
    if (fm.restricted) { fail(res, 403, 'restricted', 'Finish setting up your account first.', { need: fm.restricted }); return null; }
    if (!fm.access?.levelsAny?.CRED && !(fm.access?.capsAny || []).includes('fleets.link')) {
      fail(res, 403, 'withheld', withheldSentence('CRED'), { class: 'CRED', level: '' });
      return null;
    }
    return fm;
  };

  /* ═════════ GET /api/fleets — every fleet's name, for every reader ═════════ */
  app.get('/api/fleets', wrap(async (req, res) => {
    noStore(res);
    const [fleets, discovery] = await Promise.all([fleetViews(q), discoveryState(q)]);
    return res.json({ fleets, discovery, asOf: new Date().toISOString() });
  }));

  /* ═════════ GET /api/fleets/accounts ═════════ */
  app.get('/api/fleets/accounts', wrap(async (req, res) => {
    const fm = reader(req, res);
    if (!fm) return undefined;
    noStore(res);
    const owner = fm.kind === 'system' || isOwner(fm);
    const manager = owner || (fm.access?.capsAny || []).includes('access.manage');
    const [accounts, fleets, names, changes, discovery] = await Promise.all([
      loadAccounts(q), fleetViews(q),
      q(`SELECT account_pk, name, source_call, first_reported, last_reported FROM platform_account_name ORDER BY first_reported`),
      q(`SELECT c.*, p.email AS proposed_email, p.name AS proposed_name, a.email AS approved_email, a.name AS approved_name
           FROM fleet_change c LEFT JOIN access_user p ON p.id = c.proposed_by LEFT JOIN access_user a ON a.id = c.approved_by
          WHERE c.status = 'pending' OR c.proposed_at > now() - interval '60 days'
          ORDER BY c.proposed_at DESC LIMIT 200`),
      discoveryState(q),
    ]);
    const owners = await svc.activeOwners(dbh).catch(() => []);
    const cfg = await svc.getConfig(dbh).catch(() => ({ mode: 'open', single_owner_delay_hours: 24 }));
    const me = fm.user?.id ?? null;
    const changeOut = (c) => {
      const mine = me != null && Number(c.proposed_by) === me;
      const waitH = cfg.mode === 'enforced' ? Number(cfg.single_owner_delay_hours ?? 24) : 0;
      const readyAt = new Date(new Date(c.proposed_at).getTime() + waitH * 3600_000).toISOString();
      const soleOwner = owners.length === 1 && owners[0].id === me;
      return {
        id: Number(c.id), kind: c.kind, account: c.account_pk == null ? null : Number(c.account_pk),
        fleet_id: c.fleet_id, from_fleet: c.from_fleet, words: c.words, status: c.status, basis: c.basis,
        reason: c.reason, proposed_at: c.proposed_at, approved_at: c.approved_at, decided_reason: c.decided_reason,
        proposed_by: c.proposed_by == null ? null : (c.proposed_name || c.proposed_email || `person ${c.proposed_by}`),
        approved_by: c.approved_by == null ? null : (c.approved_name || c.approved_email || `person ${c.approved_by}`),
        impact: impactFor(c.impact, manager),
        mine,
        canApprove: c.status === 'pending' && owner && fm.kind === 'user' && (!mine || (soleOwner && Date.now() >= Date.parse(readyAt))),
        waitsUntil: c.status === 'pending' && mine && soleOwner && Date.now() < Date.parse(readyAt) ? readyAt : null,
        canDecline: c.status === 'pending' && fm.kind === 'user' && (owner || mine),
      };
    };
    /* A chosen run is stored folded ("egari luxury"); it is shown in the
       platforms' own spelling, from the fleet's names as they are now. */
    const namesOf = Object.fromEntries(fleets.map((f) => [f.id, f.reported.map((r) => r.name)]));
    const outChanges = changes.map((c) => ({ ...changeOut(c),
      words_display: c.words ? displayRun(c.words.split(' '), namesOf[c.fleet_id] || []) : null }));
    return res.json({
      accounts: accounts.map((a) => ({
        id: a.id, platform: a.platform, platformLabel: platformLabel(a.platform), account_id: a.account_id,
        label: accountLabel(a), status: a.status, fleet_id: a.fleet_id, filed_fleet: a.filed_fleet, link_basis: a.link_basis,
        reported_name: a.reported_name, name_reason: a.name_reason, reported_at: a.reported_at, source_call: a.source_call,
        first_seen: a.first_seen, last_seen: a.last_seen,
        brand: a.reported_name ? brandOf([a.reported_name]).display || null : null,
        names: names.filter((n) => Number(n.account_pk) === a.id).map((n) => ({
          name: n.name, source_call: n.source_call, first_reported: n.first_reported, last_reported: n.last_reported })),
        /* Stored rows and where they were filed — "rows already filed
           somewhere, with where they went" (§10.3). */
        filed: a.detail.filed || null,
        observations: a.detail.snapshots ?? null,
        vehicles: a.detail.vehicles ?? null,
        clientNames: a.detail.client_names || null,
        nameCheck: a.detail.name_check || null,
        evidence: a.detail.evidence || null,
        evidenceReason: a.detail.evidence ? null
          : 'Not counted yet: the discovery run counts shared plates and drivers after it records an account.',
        suggestions: a.status === 'ignored' ? [] : suggestionsFor(a, fleets),
        pending: outChanges.find((c) => c.status === 'pending' && c.account === a.id) || null,
      })),
      fleets: fleets.map((f) => ({ id: f.id, name: f.name, basis: f.basis, brand: f.brand, accounts: f.accounts })),
      changes: outChanges,
      discovery,
      me: {
        owner, manager,
        canLink: fm.kind === 'user' && !fm.access?.preview && (fm.access?.capsAny || []).includes('fleets.link'),
        linkFleets: fm.kind === 'user' ? (fm.access?.capFleets?.['fleets.link'] || []) : [],
        soleOwner: owners.length === 1 && owners[0].id === me,
        mode: cfg.mode,
        singleOwnerDelayHours: cfg.mode === 'enforced' ? Number(cfg.single_owner_delay_hours ?? 24) : 0,
        configuredDelayHours: Number(cfg.single_owner_delay_hours ?? 24),
      },
    });
  }));

  /* ═════════ GET /api/fleets/accounts/:id/evidence — the lists, for an Owner ═════════
     A Connections admin sees counts only; an Owner can open the lists behind
     them (§10.3). The lists are plates (vehicles) and drivers (names), which
     a Connections admin — "sees no driver" — does not hold. Computed live
     for the one account, over the same 180 days the counts cover. */
  app.get('/api/fleets/accounts/:id/evidence', wrap(async (req, res) => {
    const fm = req.fm;
    if (!fm || (fm.kind !== 'system' && !(fm.kind === 'user' && isOwner(fm) && !fm.access?.preview))) {
      return fail(res, fm?.kind === 'user' ? 403 : 401, fm?.kind === 'user' ? 'not_allowed' : 'signin',
        'Only an Owner opens the plates and drivers behind these counts; everyone else sees the counts.');
    }
    noStore(res);
    const a = idParam(req) == null ? null
      : acctOut((await q(`SELECT ${ACCOUNT_COLS} FROM platform_account WHERE id = $1`, [idParam(req)]))[0]);
    if (!a) return fail(res, 404, 'not_found', 'No such platform account.');
    const plates = await accountPlates(q, a);
    const persons = await accountPersons(q, a);
    const sharedPlates = plates.list.length ? await q(
      `SELECT DISTINCT t.fleet_id, t.plate FROM trip t
        WHERE t.plate = ANY($1::text[]) AND t.platform <> $2 AND t.fleet_id IS NOT NULL
          AND t.requested_at > now() - make_interval(days => $3)
       UNION
       SELECT DISTINCT a.fleet_id, v.plate FROM platform_account_vehicle v JOIN platform_account a ON a.id = v.account_pk
        WHERE v.plate = ANY($1::text[]) AND a.status = 'linked' AND a.platform <> $2
       ORDER BY 1, 2`, [plates.list, a.platform, WINDOW_DAYS]) : [];
    const sharedDrivers = persons.list.length ? await q(
      /* One of the person's platform ids, so the name links to their page
         (test/interlinking: every driver name comes with an id to link by). */
      `SELECT t.fleet_id, t.person_key, max(t.driver_name) AS name, max(t.driver_ext_id) AS driver_ext_id,
              count(*)::int AS trips FROM trip t
        WHERE t.person_key = ANY($1::text[]) AND t.platform <> $2 AND t.fleet_id IS NOT NULL
          AND t.requested_at > now() - make_interval(days => $3)
        GROUP BY 1, 2 ORDER BY 1, 3 NULLS LAST`, [persons.list, a.platform, WINDOW_DAYS]) : [];
    await audit(req, { action: 'read:fleet.account_evidence', subjectType: 'platform_account', subjectId: a.id, detail: {} });
    return res.json({
      account: { id: a.id, label: accountLabel(a) }, windowDays: WINDOW_DAYS,
      plates: { count: plates.list.length, reason: plates.reason, shared: sharedPlates },
      drivers: { count: persons.list.length, reason: persons.reason, shared: sharedDrivers },
    });
  }));

  /* ═════════ POST /api/fleets/accounts/:id — propose or apply a decision ═════════ */
  app.post('/api/fleets/accounts/:id', wrap(async (req, res) => {
    const action = String(req.body?.action || '');
    if (!['link', 'new', 'unlink', 'ignore', 'unignore'].includes(action)) {
      return fail(res, 400, 'bad_action', 'Choose link, new, unlink, ignore or unignore.');
    }
    const a = idParam(req) == null ? null
      : acctOut((await q(`SELECT ${ACCOUNT_COLS} FROM platform_account WHERE id = $1`, [idParam(req)]))[0]);
    /* Who may act is decided before anything about the account is said: an
       unsigned request learns nothing, not even whether the id exists. */
    const fleetIds = (await loadFleets(q)).map((f) => f.id);
    const target = action === 'link' ? String(req.body?.fleet || '') : null;
    const from = a?.status === 'linked' ? a.fleet_id : (a?.filed_fleet || null);
    /* fleets.link over every fleet the change touches — a Connections admin
       scoped to Egari links nothing into or out of Ecosine. An unknown target
       is left to the 400 below rather than read as a fleet they lack. */
    const touches = (action === 'link' ? [target, a?.fleet_id] : [a?.fleet_id]).filter((f) => f && fleetIds.includes(f));
    const fm = actor(req, res, touches);
    if (!fm) return undefined;
    if (!a) return fail(res, 404, 'not_found', 'No such platform account.');
    const reason = String(req.body?.reason || '').trim().slice(0, REASON_MAX);
    const label = accountLabel(a);

    if (action === 'unignore') {
      if (a.status !== 'ignored') return fail(res, 409, 'not_ignored', `${label} is not ignored.`);
      await inTx(async (tq) => {
        await tq(`UPDATE platform_account SET status = 'new', fleet_id = NULL, link_basis = NULL WHERE id = $1`, [a.id]);
        await tq(`INSERT INTO fleet_change (kind, account_pk, status, reason, proposed_by, approved_by, approved_at)
                  VALUES ('unignore', $1, 'applied', $2, $3, $3, now())`, [a.id, reason, fm.user.id]);
      });
      await audit(req, { action: 'fleet.account_unignored', subjectType: 'platform_account', subjectId: a.id, detail: { account: label, reason } });
      return res.json({ ok: true, applied: true, status: 'new' });
    }
    if (action === 'ignore' && a.status === 'new') {
      /* Ignoring an account nobody linked moves nobody's rows: applied now,
         recorded, and reversible with unignore. */
      if (reason.length < 3) return fail(res, 400, 'reason', 'Say why this account is not one of the company’s — for example, “another operator’s cars on our CABMAN interface”.');
      await inTx(async (tq) => {
        await tq(`UPDATE platform_account SET status = 'ignored' WHERE id = $1 AND status = 'new'`, [a.id]);
        await tq(`INSERT INTO fleet_change (kind, account_pk, status, reason, proposed_by, approved_by, approved_at)
                  VALUES ('ignore', $1, 'applied', $2, $3, $3, now())`, [a.id, reason, fm.user.id]);
      });
      await audit(req, { action: 'fleet.account_ignored', subjectType: 'platform_account', subjectId: a.id, detail: { account: label, reason } });
      return res.json({ ok: true, applied: true, status: 'ignored',
        detail: a.detail?.filed ? `Ignored. Rows it already has stay filed where they are (${Object.entries(a.detail.filed).map(([f, n]) => `${n} under ${f}`).join(', ')}) until an Owner decides.` : 'Ignored.' });
    }
    if (action === 'ignore' && a.status === 'ignored') return fail(res, 409, 'already', `${label} is already ignored.`);

    let kind = action;
    let fleetId = null;
    if (action === 'link') {
      if (!fleetIds.includes(target)) return fail(res, 400, 'bad_fleet', target ? `There is no fleet called ${target}.` : 'Choose the fleet to link it to.');
      if (a.status === 'linked' && a.fleet_id === target) return fail(res, 409, 'already', `${label} is already linked to that fleet.`);
      fleetId = target;
    } else if (action === 'new') {
      kind = 'new_fleet';
      fleetId = newFleetId(a, fleetIds);
      if (!fleetId) return fail(res, 409, 'no_id', 'No fleet id can be made from this account that is not already taken.');
    } else if (action === 'unlink' || action === 'ignore') {
      if (a.status !== 'linked') return fail(res, 409, 'not_linked', `${label} is not linked to a fleet.`);
      if (action === 'ignore' && reason.length < 3) return fail(res, 400, 'reason', 'Say why this account is not one of the company’s.');
    }
    const impact = await visibilityImpact(dbh, {
      from, to: kind === 'unlink' || kind === 'ignore' ? null : fleetId, newFleet: kind === 'new_fleet' ? fleetId : null });
    const manager = isOwner(fm) || (fm.access.capsAny || []).includes('access.manage');
    if (req.body?.dry_run === true) {
      noStore(res);
      return res.json({ ok: true, dry_run: true, kind, fleet: fleetId, from, impact: impactFor(impact, manager) });
    }
    let change;
    try {
      [change] = await q(
        `INSERT INTO fleet_change (kind, account_pk, fleet_id, from_fleet, status, reason, impact, proposed_by)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7) RETURNING id, proposed_at`,
        [kind, a.id, fleetId, a.status === 'linked' ? a.fleet_id : null, reason, JSON.stringify(impact), fm.user.id]);
    } catch (e) {
      if (/fleet_change_one_pending|unique/i.test(String(e))) {
        return fail(res, 409, 'pending', `A change to ${label} is already waiting for an Owner. Approve or decline that one first.`);
      }
      throw e;
    }
    await audit(req, { action: 'fleet.change_proposed', subjectType: 'fleet_change', subjectId: Number(change.id),
      detail: { kind, account: label, fleet: fleetId, from, reason, gains: impact.gains.length, loses: impact.loses.length } });
    noStore(res);
    return res.status(202).json({
      ok: true, change: Number(change.id), status: 'pending', kind, fleet: fleetId, from, impact: impactFor(impact, manager),
      detail: 'Saved for an Owner to approve: which fleet an account belongs to changes who can see its rows. Nothing has changed yet.',
    });
  }));

  /* ═════════ POST /api/fleets/:id/name — choose, never type ═════════ */
  app.post('/api/fleets/:id/name', wrap(async (req, res) => {
    const id = String(req.params.id);
    const fm = actor(req, res, [id]);
    if (!fm) return undefined;
    const f = (await loadFleets(q)).find((x) => x.id === id);
    if (!f) return fail(res, 404, 'not_found', `There is no fleet called ${id}.`);
    const accounts = (await loadAccounts(q)).filter((a) => a.fleet_id === id);
    const names = accounts.map((a) => a.reported_name).filter((n) => n && wordsOf(n).length);
    const raw = req.body?.words;
    const words = raw == null || String(raw).trim() === '' ? null : foldRun(String(raw));
    if (words && !isCandidate(words, names)) {
      const offer = nameCandidates(names).map((c) => `“${c.display}”`);
      return fail(res, 400, 'not_a_candidate', offer.length
        ? `A fleet is named with words its platforms send. Choose one of: ${offer.join(', ')}.`
        : 'None of this fleet’s linked accounts reports a name yet, so there is nothing to choose from.');
    }
    if ((f.brand_choice || null) === words) return res.json({ ok: true, unchanged: true });
    const reason = String(req.body?.reason || '').trim().slice(0, REASON_MAX);
    let changed = [];
    await inTx(async (tq) => {
      await tq(`UPDATE fleet SET brand_choice = $2 WHERE id = $1`, [id, words]);
      await tq(`INSERT INTO fleet_change (kind, fleet_id, words, status, reason, proposed_by, approved_by, approved_at)
                VALUES ('name', $1, $2, 'applied', $3, $4, $4, now())`, [id, words, reason, fm.user.id]);
      changed = await syncFleetNames(tq);
    });
    await audit(req, { action: 'fleet.name_chosen', subjectType: 'fleet', subjectId: id,
      detail: { words, from: f.name, to: changed[0]?.to ?? f.name, reason } });
    svc.resetFleetCache();
    const view = (await fleetViews(q)).find((x) => x.id === id);
    return res.json({ ok: true, fleet: view });
  }));

  /* ═════════ POST /api/fleets/changes/:id/approve — an Owner confirms ═════════ */
  app.post('/api/fleets/changes/:id/approve', wrap(async (req, res) => {
    const fm = req.fm;
    if (!fm || fm.kind !== 'user' || !fm.user) return fail(res, 401, 'signin', 'Sign in to approve changes.');
    if (fm.restricted) return fail(res, 403, 'restricted', 'Finish setting up your account first.', { need: fm.restricted });
    if (fm.access?.preview) return fail(res, 403, 'preview', 'You are previewing a role, which is read-only.');
    if (!csrfOk(req)) return fail(res, 403, 'csrf', 'Reload the page and try again.');
    if (!isOwner(fm)) return fail(res, 403, 'not_allowed', 'Only an Owner approves which fleet an account belongs to: it changes who can see its rows.');
    if (!stepupFresh(fm)) return fail(res, 403, 'stepup', 'Confirm it is you to continue.');
    const id = idParam(req);
    const c = id == null ? null : (await q(`SELECT * FROM fleet_change WHERE id = $1`, [id]))[0];
    if (!c || c.status !== 'pending') return fail(res, 404, 'not_found', 'Nothing with that number is waiting for approval.');
    if (Number(c.proposed_by) === fm.user.id) {
      /* §6.4: nobody approves their own request — except the only Owner,
         after the company's wait, so a one-Owner company is not stuck. */
      const owners = await svc.activeOwners(dbh);
      const cfg = await svc.getConfig(dbh, { fresh: true });
      const waitH = cfg.mode === 'enforced' ? Number(cfg.single_owner_delay_hours ?? 24) : 0;
      const ready = new Date(c.proposed_at).getTime() + waitH * 3600_000;
      const sole = owners.length === 1 && owners[0].id === fm.user.id;
      if (!sole) return fail(res, 403, 'four_eyes', 'Someone other than the person who proposed this must approve it: another Owner.');
      if (Date.now() < ready) {
        return fail(res, 403, 'wait', `You are the only Owner, so a change you proposed waits ${waitH} hours before you may approve it yourself. `
          + `It can be approved from ${new Date(ready).toISOString()}, or at once by a second Owner.`, { readyAt: new Date(ready).toISOString() });
      }
    }
    const a = c.account_pk == null ? null
      : acctOut((await q(`SELECT ${ACCOUNT_COLS} FROM platform_account WHERE id = $1`, [c.account_pk]))[0]);
    if (!a) return fail(res, 409, 'gone', 'The account this change was about no longer exists.');
    /* Still describes the account as it is? A change proposed against an
       account that has since moved would undo whatever moved it. */
    const nowFrom = a.status === 'linked' ? a.fleet_id : null;
    if ((nowFrom || null) !== (c.from_fleet || null)) {
      await q(`UPDATE fleet_change SET status = 'superseded', decided_reason = 'the account moved after this was proposed' WHERE id = $1 AND status = 'pending'`, [id]);
      return fail(res, 409, 'superseded', 'This account has moved since the change was proposed, so it was set aside. Propose it again if it is still wanted.');
    }
    const fleetIds = (await loadFleets(q)).map((f) => f.id);
    if (c.kind === 'link' && !fleetIds.includes(c.fleet_id)) return fail(res, 409, 'gone', `The fleet ${c.fleet_id} no longer exists.`);
    let newId = null;
    if (c.kind === 'new_fleet') {
      newId = fleetIds.includes(c.fleet_id) ? newFleetId(a, fleetIds) : c.fleet_id;
      if (!newId) return fail(res, 409, 'no_id', 'No fleet id can be made from this account that is not already taken.');
    }
    const impact = await visibilityImpact(dbh, {
      from: a.status === 'linked' ? a.fleet_id : (a.filed_fleet || null),
      to: ['unlink', 'ignore'].includes(c.kind) ? null : (newId || c.fleet_id), newFleet: newId });
    let renamed = [];
    await inTx(async (tq) => {
      if (c.kind === 'new_fleet') {
        const v = deriveFleetName({ id: newId, accounts: [{ ...a, status: 'linked', fleet_id: newId }] });
        await tq(`INSERT INTO fleet (id, name, name_basis, name_derived_at, created_at, created_from) VALUES ($1, $2, $3, now(), now(), $4)`,
          [newId, v.name, v.basis, a.id]);
      }
      if (c.kind === 'link' || c.kind === 'new_fleet') {
        await tq(`UPDATE platform_account SET status = 'linked', fleet_id = $2, link_basis = 'person' WHERE id = $1`, [a.id, newId || c.fleet_id]);
      } else if (c.kind === 'unlink') {
        await tq(`UPDATE platform_account SET status = 'new', fleet_id = NULL, link_basis = NULL WHERE id = $1`, [a.id]);
      } else if (c.kind === 'ignore') {
        await tq(`UPDATE platform_account SET status = 'ignored', fleet_id = NULL, link_basis = NULL WHERE id = $1`, [a.id]);
      }
      await tq(`UPDATE fleet_change SET status = 'applied', approved_by = $2, approved_at = now(), impact = $3, fleet_id = COALESCE($4, fleet_id)
                 WHERE id = $1 AND status = 'pending'`, [id, fm.user.id, JSON.stringify(impact), newId]);
      renamed = await syncFleetNames(tq);
    });
    svc.resetFleetCache();
    svc.bumpAccess();
    await audit(req, { action: 'fleet.change_approved', subjectType: 'fleet_change', subjectId: id,
      detail: { kind: c.kind, account: accountLabel(a), fleet: newId || c.fleet_id, from: c.from_fleet,
        gains: impact.gains.length, loses: impact.loses.length, self: Number(c.proposed_by) === fm.user.id } });
    for (const r of renamed) {
      await audit(req, { action: 'fleet.renamed', subjectType: 'fleet', subjectId: r.id, detail: { from: r.from, to: r.to, basis: r.basis } });
    }
    return res.json({ ok: true, applied: true, kind: c.kind, fleet: newId || c.fleet_id, renamed, impact });
  }));

  /* ═════════ POST /api/fleets/changes/:id/decline ═════════ */
  app.post('/api/fleets/changes/:id/decline', wrap(async (req, res) => {
    const fm = req.fm;
    if (!fm || fm.kind !== 'user' || !fm.user) return fail(res, 401, 'signin', 'Sign in first.');
    if (fm.restricted) return fail(res, 403, 'restricted', 'Finish setting up your account first.', { need: fm.restricted });
    if (fm.access?.preview) return fail(res, 403, 'preview', 'You are previewing a role, which is read-only.');
    if (!csrfOk(req)) return fail(res, 403, 'csrf', 'Reload the page and try again.');
    const id = idParam(req);
    const c = id == null ? null : (await q(`SELECT * FROM fleet_change WHERE id = $1`, [id]))[0];
    if (!c || c.status !== 'pending') return fail(res, 404, 'not_found', 'Nothing with that number is waiting.');
    const mine = Number(c.proposed_by) === fm.user.id;
    if (!mine && !isOwner(fm)) return fail(res, 403, 'not_allowed', 'Only an Owner, or the person who proposed it, can decline this.');
    const reason = String(req.body?.reason || '').trim().slice(0, REASON_MAX);
    if (!mine && reason.length < 3) return fail(res, 400, 'reason', 'Say why, so the person who proposed it knows.');
    await q(`UPDATE fleet_change SET status = $2, approved_by = $3, approved_at = now(), decided_reason = $4 WHERE id = $1 AND status = 'pending'`,
      [id, mine ? 'withdrawn' : 'declined', fm.user.id, reason]);
    await audit(req, { action: mine ? 'fleet.change_withdrawn' : 'fleet.change_declined', subjectType: 'fleet_change', subjectId: id, detail: { reason } });
    return res.json({ ok: true, status: mine ? 'withdrawn' : 'declined' });
  }));
}

/* For the report and the tests: the names a platform reported, normalised,
   so a test can say "these are one business" without re-implementing it. */
export const sameBusiness = (a, b) => normaliseName(a) === normaliseName(b);
