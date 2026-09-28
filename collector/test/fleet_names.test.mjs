/* A FLEET'S NAME, FROM WHAT THE PLATFORMS CALL IT — the pure rule.
   ═════════════════════════════════════════════════════════════════════════
   src/fleet_names.js against the REAL names the platforms reported,
   measured on production 2026-09-26 (docs/COVERAGE.md, "What each platform
   calls the fleets"), and the names CABMAN's Ecosine interface has carried
   for other companies (docs/audit/verdicts-2026-09-05.json, H5). These are
   businesses' registered names as the platforms publish them — no person, no
   number beyond the Bolt company ids already written into src/config.js.

   Every block names the reversion that proves it: undo the guard named and
   the block fails. Each was run that way before this file was committed. */
import {
  normaliseName, wordsOf, commonLeading, brandOf, candidates, deriveFleetName,
  isCandidate, shouts, tradeIndex, accountLabel, foldRun,
} from '../src/fleet_names.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* The measured names. */
const UBER_ECOSINE = 'ECOSINE TRANSPORTS';
const YANGO_ECOSINE = 'ECOSINE TRANSPORTS LLC';
const CABMAN_ECOSINE = 'Ecosine Transports LLC';
const UBER_EGARI = 'Egari Luxury Cars Transport LLC';
const CABMAN_SAHALAT = 'Sahalat';
const CABMAN_STAR = 'Star Skyline Luxury Transport LLC';
const CABMAN_VOLYA = 'VOLYA LIMOUSINE SERVICES L.L.C';

/* ══ 1. normalising a name ═══════════════════════════════════════════════
   REVERSION: remove the trailing legal-form loop in wordsOf — "the legal
   form is dropped" and every "same business" line fails. */
console.log('\n1. normalising: case, punctuation, legal form');
{
  check('the three Ecosine spellings normalise alike',
    normaliseName(UBER_ECOSINE) === 'ecosine transports'
    && normaliseName(YANGO_ECOSINE) === 'ecosine transports'
    && normaliseName(CABMAN_ECOSINE) === 'ecosine transports',
    [UBER_ECOSINE, YANGO_ECOSINE, CABMAN_ECOSINE].map(normaliseName).join(' | '));
  check('the legal form is dropped: LLC', normaliseName(UBER_EGARI) === 'egari luxury cars transport', normaliseName(UBER_EGARI));
  check('…and L.L.C (with and without the last dot)', normaliseName(CABMAN_VOLYA) === 'volya limousine services'
    && normaliseName('Volya Limousine Services L.L.C.') === 'volya limousine services', normaliseName(CABMAN_VOLYA));
  for (const form of ['FZE', 'FZCO', 'FZ-LLC', 'Ltd', 'Ltd.', 'Est', 'Est.', 'Co', 'Co.']) {
    check(`…and ${form}`, normaliseName(`Harbour Fleet ${form}`) === 'harbour fleet', normaliseName(`Harbour Fleet ${form}`));
  }
  check('two legal forms in a row both go', normaliseName('Harbour Fleet L.L.C. FZE') === 'harbour fleet');
  check('a legal form INSIDE a name is part of the name', normaliseName('Harbour Co Transport LLC') === 'harbour co transport');
  check('a name that is only a legal form keeps it (an empty name was not reported)', normaliseName('LLC') === 'llc');
  check('punctuation around a word is folded', normaliseName('ECOSINE, TRANSPORTS.') === 'ecosine transports');
  check('a lone ampersand is not a word', eq(wordsOf('Harbour & Fleet').map((w) => w.key), ['harbour', 'fleet']));
  check('letters of another script survive', normaliseName('سهلات للنقل') !== '' && wordsOf('سهلات للنقل').length === 2);
  check('blank and missing names normalise to nothing', normaliseName('') === '' && normaliseName(null) === '' && normaliseName('  ') === '');
}

/* ══ 2. the common name and the brand, from the real names ═══════════════
   REVERSION: in brandKeys return the whole common run (no cut) — "Ecosine's
   brand is Ecosine" and "Egari's brand is Egari" fail. REVERSION: compare
   the raw strings instead of their keys in commonLeadingKeys — "the three
   Ecosine names share Ecosine Transports" fails (they share nothing raw). */
console.log('\n2. the common name and the brand (ULM-DESIGN §3.2 rules 3–5)');
{
  const eco = [CABMAN_ECOSINE, UBER_ECOSINE, YANGO_ECOSINE];
  check('the three Ecosine names share "Ecosine Transports"', commonLeading(eco).display === 'Ecosine Transports', commonLeading(eco).display);
  check('…and the brand is "Ecosine"', brandOf(eco).display === 'Ecosine', brandOf(eco).display);
  check('the order the names arrive in does not change either',
    commonLeading([UBER_ECOSINE, YANGO_ECOSINE, CABMAN_ECOSINE]).display === 'Ecosine Transports'
    && brandOf([YANGO_ECOSINE, UBER_ECOSINE, CABMAN_ECOSINE]).display === 'Ecosine');
  check('Egari, named by one platform: common "Egari Luxury Cars Transport"',
    commonLeading([UBER_EGARI]).display === 'Egari Luxury Cars Transport', commonLeading([UBER_EGARI]).display);
  check('…brand "Egari" (cut at the first trade word, "Luxury")', brandOf([UBER_EGARI]).display === 'Egari', brandOf([UBER_EGARI]).display);
  check('Sahalat alone is "Sahalat" (no trade word to cut at)', brandOf([CABMAN_SAHALAT]).display === 'Sahalat'
    && commonLeading([CABMAN_SAHALAT]).display === 'Sahalat');
  check('Star Skyline Luxury Transport LLC → "Star Skyline" (a two-word brand)', brandOf([CABMAN_STAR]).display === 'Star Skyline', brandOf([CABMAN_STAR]).display);
  check('"rent a car" is cut as a phrase', brandOf(['Harbour Rent A Car LLC']).display === 'Harbour', brandOf(['Harbour Rent A Car LLC']).display);
  check('a name that OPENS with a trade word is its own brand, never an empty one',
    brandOf(['Luxury Cars LLC']).display === 'Luxury Cars', brandOf(['Luxury Cars LLC']).display);
  check('trade words are found where they are', tradeIndex(['egari', 'luxury', 'cars']) === 1 && tradeIndex(['sahalat']) === -1);
}

/* ══ 3. title case only where the platform shouts ════════════════════════
   REVERSION: in displayRun return the shouted words as they arrive (no
   titleWord) — "a shouting-only fleet is re-cased" fails. REVERSION: take
   the first name instead of the first calm one — "a calm spelling beats a
   shouted one" fails. */
console.log('\n3. shown as written, re-cased only where the platform shouts (rule 5)');
{
  check('ECOSINE TRANSPORTS shouts; Egari Luxury Cars Transport LLC does not', shouts(UBER_ECOSINE) && !shouts(UBER_EGARI));
  check('a shouting-only fleet is re-cased: "Ecosine"', brandOf([UBER_ECOSINE, YANGO_ECOSINE]).display === 'Ecosine'
    && commonLeading([UBER_ECOSINE, YANGO_ECOSINE]).display === 'Ecosine Transports',
  commonLeading([UBER_ECOSINE, YANGO_ECOSINE]).display);
  check('a calm spelling beats a shouted one, whichever arrives first',
    commonLeading([UBER_ECOSINE, 'EcoSine Transports LLC']).display === 'EcoSine Transports',
    commonLeading([UBER_ECOSINE, 'EcoSine Transports LLC']).display);
  check('the Volya name is re-cased word by word', commonLeading([CABMAN_VOLYA]).display === 'Volya Limousine Services'
    && brandOf([CABMAN_VOLYA]).display === 'Volya', commonLeading([CABMAN_VOLYA]).display);
}

/* ══ 4. what the admin may choose from ═══════════════════════════════════
   REVERSION: make isCandidate return Boolean(k) (any run at all) — "a word
   the platforms never sent is not" fails. */
console.log('\n4. choosing, not typing (rule 6)');
{
  const c = candidates([UBER_EGARI]).map((x) => x.display);
  check('the design’s own example: Egari, Egari Luxury, …, Egari Luxury Cars Transport',
    eq(c, ['Egari', 'Egari Luxury', 'Egari Luxury Cars', 'Egari Luxury Cars Transport']), JSON.stringify(c));
  const e = candidates([CABMAN_ECOSINE, UBER_ECOSINE, YANGO_ECOSINE]).map((x) => x.display);
  check('three names of one business offer two runs, once each', eq(e, ['Ecosine', 'Ecosine Transports']), JSON.stringify(e));
  check('a run from the names is a candidate, in any case or spacing', isCandidate('egari   LUXURY', [UBER_EGARI]));
  check('a word the platforms never sent is not', !isCandidate('Egari Limo', [UBER_EGARI]) && !isCandidate('Egari Cars', [UBER_EGARI]));
  check('the legal form is never offered', !c.some((d) => /\bLLC\b/.test(d)), JSON.stringify(c));
  check('…and choosing the full legal name folds to the run without it',
    isCandidate(UBER_EGARI, [UBER_EGARI]) && foldRun(UBER_EGARI) === 'egari luxury cars transport');
  check('nothing is not a candidate', !isCandidate('', [UBER_EGARI]) && !isCandidate('   ', [UBER_EGARI]));
}

/* ══ 5. the whole rule, over accounts ════════════════════════════════════
   REVERSION: drop the `status === 'linked'` filter in deriveFleetName —
   "an unlinked CABMAN company does not join the name" fails (Sahalat would
   turn Ecosine into a disagreement). REVERSION: in the no-name branch return
   name null — "a Bolt-only fleet is shown by its real account" fails. */
console.log('\n5. deriveFleetName: linked accounts only; no name; disagreement; choice');
{
  const acct = (platform, account_id, reported_name, status = 'linked', extra = {}) => ({ platform, account_id, reported_name, status, ...extra });
  const eco = deriveFleetName({ id: 'ecosine', accounts: [
    acct('uber', 'org-ecosine-enc', UBER_ECOSINE), acct('yango', 'park-ecosine', YANGO_ECOSINE),
    acct('cabman', `81/${CABMAN_ECOSINE}`, CABMAN_ECOSINE), acct('bolt', '142868', null),
    acct('cabman', `81/${CABMAN_SAHALAT}`, CABMAN_SAHALAT, 'new'),
  ] });
  check('Ecosine: brand "Ecosine", common "Ecosine Transports"', eco.name === 'Ecosine' && eco.basis === 'brand'
    && eco.common === 'Ecosine Transports', JSON.stringify({ n: eco.name, b: eco.basis, c: eco.common }));
  check('…an unlinked CABMAN company does not join the name', !eco.reported.some((r) => r.name === CABMAN_SAHALAT));
  check('…every platform name stays visible with its platform (the legal names)',
    eq(eco.reported.map((r) => `${r.name} · ${r.platform}`).sort(),
      [`${CABMAN_ECOSINE} · cabman`, `${UBER_ECOSINE} · uber`, `${YANGO_ECOSINE} · yango`].sort()));
  check('…a linked account with no name is counted, not named', eco.accounts === 4);

  const egari = deriveFleetName({ id: 'egari', accounts: [acct('uber', 'org-egari-enc', UBER_EGARI), acct('bolt', '142897', null)] });
  check('Egari: "Egari", common "Egari Luxury Cars Transport"', egari.name === 'Egari' && egari.common === 'Egari Luxury Cars Transport');

  const bolt = deriveFleetName({ id: 'ecosine', accounts: [acct('bolt', '142868', null)] });
  check('a Bolt-only fleet is shown by its real account: "Unnamed fleet — Bolt company 142868"',
    bolt.name === 'Unnamed fleet — Bolt company 142868' && bolt.basis === 'unnamed', bolt.name);
  check('…with the true reason beside it', /fleet-integration API returns no company name; connect the fleet-owner portal/.test(bolt.unnamedReason || ''), bolt.unnamedReason);
  const recorded = deriveFleetName({ id: 'ecosine', accounts: [acct('yango', 'park-ecosine', null, 'linked',
    { name_reason: 'Yango’s console refused the profile call (HTTP 403).' })] });
  check('a reason the last discovery run recorded wins over the standing one', recorded.unnamedReason === 'Yango’s console refused the profile call (HTTP 403).', recorded.unnamedReason);
  const none = deriveFleetName({ id: 'egari', accounts: [] });
  check('a fleet with no linked account is shown by its own id, and says why',
    none.name === 'Unnamed fleet — egari' && /No platform account is linked/.test(none.unnamedReason || ''), none.name);
  const onlyNew = deriveFleetName({ id: 'egari', accounts: [acct('uber', 'x', UBER_EGARI, 'new'), acct('bolt', '1', null, 'ignored')] });
  check('new and ignored accounts name nothing', onlyNew.basis === 'unnamed' && onlyNew.accounts === 0);

  const split = deriveFleetName({ id: 'ecosine', accounts: [acct('cabman', `81/${CABMAN_ECOSINE}`, CABMAN_ECOSINE), acct('cabman', `81/${CABMAN_SAHALAT}`, CABMAN_SAHALAT)] });
  check('no common word: every reported name, never one picked', split.basis === 'disagree'
    && split.name === 'Ecosine Transports / Sahalat', split.name);
  check('…and the reason "the platforms name this fleet differently — choose one"',
    split.disagreeReason === 'The platforms name this fleet differently — choose one.');
  check('…and the admin can choose from either name', split.candidates.some((c) => c.display === 'Sahalat')
    && split.candidates.some((c) => c.display === 'Ecosine Transports'));

  const chosen = deriveFleetName({ id: 'egari', accounts: [acct('uber', 'org-egari-enc', UBER_EGARI)], choice: 'egari luxury' });
  check('an admin’s choice from the candidates is the name', chosen.name === 'Egari Luxury' && chosen.basis === 'chosen', chosen.name);
  const stale = deriveFleetName({ id: 'egari', accounts: [acct('uber', 'org-egari-enc', 'Egari Limousine LLC')], choice: 'egari luxury' });
  check('a choice whose words the platforms no longer send lapses, and says so (rule 9)',
    stale.name === 'Egari' && stale.basis === 'brand' && stale.choiceStale === true, JSON.stringify({ n: stale.name, s: stale.choiceStale }));
  const splitChosen = deriveFleetName({ id: 'ecosine', accounts: split.reported.map((r) => acct(r.platform, r.account_id, r.name)), choice: 'Sahalat' });
  check('a disagreement is settled by choosing one of the names', splitChosen.name === 'Sahalat' && splitChosen.basis === 'chosen');
}

/* ══ 6. account labels ═══════════════════════════════════════════════════ */
console.log('\n6. an account named by what it really is');
check('Bolt company 142897', accountLabel({ platform: 'bolt', account_id: '142897' }) === 'Bolt company 142897');
check('a CABMAN company names its interface', accountLabel({ platform: 'cabman', account_id: `81/${CABMAN_SAHALAT}` }) === 'CABMAN company “Sahalat” (interface 81)',
  accountLabel({ platform: 'cabman', account_id: `81/${CABMAN_SAHALAT}` }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
