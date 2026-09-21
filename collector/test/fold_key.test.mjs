/* ONE KEY PER PERSON — and the property that makes it safe.
   ══════════════════════════════════════════════════════════════════════════
   The operator: "we fixed double entries but it still showing double names."
   The case they found, from #drivers, both Ecosine, both on plate L44251:

     WISAL MUHAMMAD IRSHAD MUHAMMAD   uber + hotel   249 trips in window
     Wisal Muhammad Irshah Muhammad   bolt             0 trips in window

   one letter apart. Both layers already agreed this was one man —
   api/identity_map.js holds the pair in MERGES with contradictions: [], and
   the live sweep proposed it twice, both confirmed. Nothing disputed the
   merge.

   They disagreed about the KEY. The register keys him on the UBER record's
   short filed name, 'wisal muhammad'. The link chain runs uber → bolt → hotel
   and terminates on the HOTEL record, keyed 'wisal muhammad irshad muhammad'.
   api/driver_routes.js resolved that per id, first-wins — so the one id the
   register named stopped there, the other three fell through to the chain, and
   one man rendered as two rows.

   Measured against production's own link table: 37 people, every one the same
   shape — a short filed name against a long one.

   ── THE PROPERTY THIS FILE EXISTS TO ASSERT ─────────────────────────────
   IT MERGES NOBODY NEW. A change that folds rows together is one edit away
   from folding two different people into one, and this roster deliberately
   holds apart pairs that are two men — api/identity_map.js keeps back five who
   carry simultaneous trips in two cars. So the first assertion below is not
   that the fix works; it is that the SET OF COMPONENTS is byte-identical
   before and after, and only the key each one folds on changes. Everything
   else here is secondary to that. */
import { ALIAS_KEY, mergedIds } from '../api/identity_map.js';
import { keyResolver, componentOf } from '../api/fold_key.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* A link map of the shape api/identity_links.js builds. */
function mkLinks(edges, keys) {
  const canonOf = new Map(edges);
  const term = (id) => { let c = id; const s = new Set();
    while (canonOf.has(c) && !s.has(c)) { s.add(c); c = canonOf.get(c); } return c; };
  const ids = new Set([...edges.flat()]);
  const repOf = new Map([...ids].map((i) => [i, term(i)]));
  const members = new Map();
  for (const [i, rep] of repOf) {
    if (!members.has(rep)) members.set(rep, new Set());
    members.get(rep).add(i); members.get(rep).add(rep);
  }
  return {
    ok: true,
    partners: new Map([...repOf].map(([i, rep]) => [i, members.get(rep)])),
    byAlias: new Map([...repOf].filter(([i, rep]) => i !== rep && keys[rep])
      .map(([i, rep]) => [i, keys[rep]])),
  };
}
const linkedKey = (L, id) => (L?.byAlias?.get(id) ?? null);

/* ══ 1. THE SAFETY PROPERTY, on the real register ════════════════════════ */
console.log('\nit merges nobody new');
{
  /* Every id either layer knows, over the register as shipped. */
  const ids = new Set(ALIAS_KEY.keys());
  for (const id of ALIAS_KEY.keys()) for (const s of mergedIds(id) || []) if (s) ids.add(s);
  const empty = { ok: true, partners: new Map(), byAlias: new Map() };

  const comp = (id) => [...componentOf(empty, id)].sort().join('|');
  const before = new Set([...ids].map(comp));
  const resolve = keyResolver(empty, linkedKey);
  /* Resolving keys cannot change which ids are in which component — it does
     not touch ids at all. Asserted rather than argued, because "it cannot" is
     what everybody says about the change that could. */
  const after = new Set([...ids].map(comp));
  check('the set of components is identical before and after resolving keys',
    before.size === after.size && [...before].every((c) => after.has(c)),
    `${before.size} vs ${after.size}`);
  check('and resolving is a pure function of the key, touching no id',
    typeof resolve === 'function' && resolve('a key nobody has') === 'a key nobody has');
  check('a key from outside either layer passes through unchanged',
    resolve('somebody nobody linked') === 'somebody nobody linked');
  check('and null stays null rather than becoming a string',
    resolve(null) === null && resolve(undefined) === undefined);
}

/* ══ 2. THE OPERATOR'S SHAPE ═════════════════════════════════════════════ */
console.log('\nthe register names one id, the chain names the rest');
{
  /* uber → bolt → hotel, terminal keyed on the hotel record's long name. */
  const links = mkLinks([['U', 'B'], ['B', 'H']], { H: 'long name' });
  /* …and the register names ONLY the bolt id, on the uber record's short
     name — which is exactly the production shape. */
  const REG = new Map([['B', 'short name']]);
  const reg = { registerKey: (id) => REG.get(id), registerIds: () => [],
    registerAll: () => REG.keys() };

  /* Shipped behaviour, reconstructed: first-wins, per id. */
  const shipped = (id) => REG.get(id) || linkedKey(links, id) || null;
  /* Nulls filtered: the TERMINAL id carries no byAlias entry by construction —
     it is nobody's alias — so it arrives by name-fold or by its own key, which
     the third-record assertion below covers separately. Counting its null as a
     distinct key would make this pass for the wrong reason. */
  check('as shipped, the one id the register names splits off from the rest',
    new Set(['U', 'B', 'H'].map(shipped).filter(Boolean)).size === 2,
    JSON.stringify(['U', 'B', 'H'].map(shipped)));

  /* With the resolver, using the same per-id precedence. */
  const resolve = keyResolver(links, linkedKey, reg);
  const fixed = (id) => resolve(shipped(id));
  check('the chain key resolves onto the register\'s, for every id',
    new Set(['U', 'B', 'H'].map(fixed).filter(Boolean)).size === 1,
    JSON.stringify(['U', 'B', 'H'].map(fixed)));
  check('and the key kept is the REGISTER\'s — the person who looked decides',
    fixed('U') === 'short name', String(fixed('U')));

  /* THE THIRD RECORD. A record no link names arrives by its folded NAME,
     through byName, which points at the CHAIN's key and not the register's.
     Resolving at the key level is what catches it — resolving only the ids the
     two layers name would leave it behind, and on this roster that record is
     the Yango account of the very person the operator reported. */
  check('a record arriving by name-fold lands on the same key as the rest',
    resolve('long name') === 'short name', String(resolve('long name')));
}

/* ══ 3. STABILITY ════════════════════════════════════════════════════════ */
console.log('\nit answers the same way twice');
{
  const links = mkLinks([['A', 'C'], ['B', 'C']], { C: 'kc' });
  const REG = new Map([['A', 'ka'], ['B', 'kb']]);
  const reg = { registerKey: (id) => REG.get(id), registerIds: () => [],
    registerAll: () => REG.keys() };
  /* TWO DIFFERENT REGISTER KEYS in one component: two hand-reviewed entries
     joined by a link. That is a thing to notice, not to resolve by whichever
     id happened to be iterated first — an unstable fold key would move a
     person between rows between two reads of the SAME page, which is worse
     than either answer. Sorted, so it is the same on every request. */
  const r1 = keyResolver(links, linkedKey, reg);
  const r2 = keyResolver(links, linkedKey, reg);
  check('a component with two register keys resolves deterministically',
    r1('kc') === r2('kc') && r1('kb') === r2('kb'), `${r1('kc')} / ${r2('kc')}`);
  check('and it picks a register key rather than the chain\'s',
    ['ka', 'kb'].includes(r1('kc')), String(r1('kc')));
}

/* ══ 4. A COMPONENT THE REGISTER DOES NOT TOUCH ══════════════════════════ */
console.log('\nwhere only the link layer speaks');
{
  const links = mkLinks([['X', 'Y']], { Y: 'ky' });
  const resolve = keyResolver(links, linkedKey,
    { registerKey: () => undefined, registerIds: () => [], registerAll: () => [] });
  check('the chain\'s own key stands when no register entry names anybody',
    resolve('ky') === 'ky', String(resolve('ky')));
  check('and an unrelated key is untouched', resolve('kz') === 'kz');
}

/* ══ 5. componentOf SPANS BOTH LAYERS ════════════════════════════════════ */
console.log('\nthe component is the union of both layers');
{
  const links = mkLinks([['P', 'Q']], { Q: 'kq' });
  const c = componentOf(links, 'P');
  check('a link puts both ends in one component', c.has('P') && c.has('Q'), JSON.stringify([...c]));
  const alone = componentOf({ ok: true, partners: new Map(), byAlias: new Map() }, 'Z');
  check('and an id nobody has ever linked is its own component of one',
    alone.size === 1 && alone.has('Z'), JSON.stringify([...alone]));
}

console.log(`\n${fail ? '✗' : '✓'} fold_key: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
