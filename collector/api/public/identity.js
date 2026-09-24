/* Who this product thinks is one person, and on what evidence.
   ═══════════════════════════════════════════════════════════════════════════
   It started with one report: "Muhammad Khalifa Afzal Khalid has uber trips,
   but it doesn't show that uber is there. it only shows bolt trips." He did —
   4,461 of them, on an Uber account filed under the shorter name "Muhammad
   Khalid", against the 822 his row showed. The two records carry the same
   phone number and nothing joined on it.

   Fifty-eight people were in that state. This page exists because the fix is a
   RULE, and a rule that folds two humans into one has to be readable by the
   person who knows them. Every row here names both records, both channels and
   the last four digits of the number that joined them, and says whether the
   names could have joined them without it.

   Three things it is careful to keep apart, because they are three different
   claims and the page is worthless if they blur:

     what the rule DID       — the links, with their evidence
     what a person OVERRULED — kept and shown, not filtered away, because an
                               operator who said "those are two brothers"
                               should see that they did
     what the rule CANNOT SEE — 166 of 434 rows carry no phone on any record,
                               and a page listing sixty links without saying so
                               reads as "the roster is now clean" */
import { el, esc, panel, loading, tableFrom, kpiRow, note, sourceLabel, countOf,
  entity, dtStr, contract, glance, glanceBand, bandTiles, absenceBand, pageFoot, foldRows, pill, swatch } from './ui.js';
import { fmt, empty, hbars, gapBars } from './charts.js';
import { q, href } from './data.js';

/* THE BASIS OF A LINK, and what each one lets the page say.
   ─────────────────────────────────────────────────────────────────────────
   The page was written when every link was a shared phone, and it still reads
   as if they all were: "Joined by: phone ···" with an empty tail and "Could
   the names have done it? No" on every row. Measured on production (plan
   pass, 2026-09-24): 365 of 433 links rest on a NAME — similar_name 247,
   same_name 93, shared_car_name 25 — so for those the name IS the evidence
   and "No" is false. /api/drivers/identity-links sends `basis` on every link
   (and folds shared_email too, api/identity_links.js); under the page
   contract the page reads it. The old skin is frozen and still says "No". */
const BASIS = {
  shared_phone: 'a shared phone', shared_email: 'a shared email', similar_name: 'similar names',
  same_name: 'the same name', shared_car_name: 'the same car and name',
};
const basisOf = (r) => BASIS[r.basis] || String(r.basis || 'a shared phone').replace(/_/g, ' ');
const byName = (r) => /name/.test(String(r.basis || ''));

const pair = (r) => `<b>${esc(r.canonical_name || r.canonical_ext_id)}</b>`
  + `<span class="dim"> · ${esc(sourceLabel(r.canonical_platform))}</span>`
  + `<br><span class="dim">also filed as</span> ${esc(r.alias_name || r.alias_ext_id)}`
  + `<span class="dim"> · ${esc(sourceLabel(r.alias_platform))}</span>`;

export async function renderIdentity(root) {
  root.innerHTML = '';
  loading(root);
  const d = await q('/api/drivers/identity-links').catch(() => null);
  root.innerHTML = '';
  if (!d) {
    empty(root, 'The identity links could not be read',
      'They are written by the collector on every roster pull; Collection gaps says when it last ran.');
    return;
  }

  const links = d.links || [];
  const rejected = d.rejected || [];
  const cov = d.coverage || {};
  /* Promoted: the rule found it AND somebody moved it into the register, so it
     is in the stored person_key column and every rollup in the product folds
     it. Un-promoted links fold the driver pages and nothing else, and the two
     look identical on this page unless it says which is which. */
  const promoted = links.filter((r) => r.promoted);
  /* A link whose two names already fold is real and redundant — the name rule
     has it. Separating them is the difference between "the rule found sixty
     people" and "the rule found sixty people, of whom fifty-eight were being
     counted twice". */
  const needed = links.filter((r) => !/changes nothing/.test(r.evidence || ''));

  /* Under the page contract (plan §4 identity): correctness first — the
     Joined-by and "Could the names have done it?" columns read the link's
     basis — then a 00 band with the joins split by basis; what each basis
     joined and how much of it is in every total; the channel pairs each link
     joins; when each was first found; the pair table folded to twelve; the
     Overruled table unchanged; a † band holding the reach and applies notes
     and the confirmations that carry no name. */
  const ak = contract();
  const AKB = ak ? glanceBand(root, null) : null;
  const ID_TILES = [
    { label: 'Records joined', value: fmt(links.length),
      sub: needed.length === links.length
        ? 'every one of them a pair no name rule could have reached'
        : `${fmt(needed.length)} of them could not have been joined by name` },
    promoted.length
      ? { label: 'In every total', value: fmt(promoted.length),
        sub: `of ${fmt(links.length)} — these are in the stored key, so the money and trip `
          + 'rollups fold them too; the rest fold the driver pages only',
        tone: 'ok' }
      : null,
    { label: 'Accounts carrying a phone', value: fmt(cov.with_phone ?? 0),
      sub: `of ${fmt(cov.accounts ?? 0)} the product counts work for — this rule can only see `
        + 'an account that carries one' },
    /* THE LIMIT, as a tile rather than a footnote. It is the figure that stops
       this page being read as a clean bill of health. */
    cov.without_phone
      ? { label: 'Accounts it cannot see', value: fmt(cov.without_phone),
        sub: 'no phone number on any of their records — mostly Bolt, which files none at all, '
          + 'so nothing on this page says anything about them',
        tone: 'warn' }
      : null,
    rejected.length
      ? { label: 'Links a person overruled', value: fmt(rejected.length),
        sub: 'kept below, because a rule that quietly drops a correction is a rule nobody can correct' }
      : null,
  ];
  if (ak) {
    const count = (k) => links.filter((r) => (r.basis || 'shared_phone') === k).length;
    const names = links.filter(byName).length;
    const split = [
      { label: 'Joined on a shared phone', value: fmt(count('shared_phone')), sub: 'the last four digits are on the row' },
      { label: 'Joined on a name', value: fmt(names),
        sub: `${fmt(count('similar_name'))} similar · ${fmt(count('same_name'))} identical · ${fmt(count('shared_car_name'))} the same car too` },
      ...(count('shared_email') ? [{ label: 'Joined on an email', value: fmt(count('shared_email')), sub: 'the same address on both records' }] : []),
    ];
    /* The old sub-line described every link as a pair no NAME could have
       reached; for a name-basis link the name did reach it. */
    const recJoined = { ...ID_TILES[0], hero: true,
      sub: `${fmt(links.length - names)} on a number or an address, ${fmt(names)} on a name` };
    glance(AKB.tilesHost, bandTiles([recJoined, ...split, ...ID_TILES.slice(1)]).tiles);
    if (links.length) { identityBasis(root, links); identityPairs(root, links); identityFound(root, links); }
  } else root.append(kpiRow(ID_TILES));

  if (!links.length) {
    const p0 = panel('No two records have been joined this way',
      'Which is either a roster with no duplicates in it, or a collector that has not run since '
      + 'this rule shipped.');
    empty(p0.body, 'Nothing to show', d.reach_note || '');
    root.append(p0.panel);
  } else {
    /* The subtitle was the API's basis_note — "two records the roster gave the
       same phone number" — over a table most of whose rows are joined on a
       name. Under the contract it names what the rows rest on. */
    const lp = panel(ak ? `${countOf(links.length, 'pair')} joined as one person` : `${countOf(links.length, 'pair')} the roster proved are one person`,
      ak ? 'Each pair, and what joined it — a shared phone, a shared email, or the names themselves' : d.basis_note);
    const LINK_COLS = [
      { label: 'The person', key: 'canonical_name', render: pair },
      { label: 'Joined by', key: 'phone_tail',
        render: (r) => (ak
          ? ((r.basis || 'shared_phone') === 'shared_phone' ? pill(`phone ···${esc(r.phone_tail || '')}`) : pill(basisOf(r)))
          : `<span class="tag">phone ···${esc(r.phone_tail || '')}</span>`) },
      /* The sentence, in full. It is the column somebody argues with. */
      { label: 'Evidence', key: 'evidence',
        render: (r) => `<span class="dim">${esc(r.evidence)}</span>` },
      { label: 'Could the names have done it?', key: 'evidence',
        render: (r) => (ak && byName(r)
          ? pill('Yes — the name is the evidence')
          : ak ? pill(/changes nothing/.test(r.evidence || '') ? 'Yes — already folded' : 'No')
          : /changes nothing/.test(r.evidence || '')
          ? '<span class="tag ok" title="the two names fold together, so the existing name rule already joined these">Yes — already folded</span>'
          : '<span class="tag warn" title="the two channels file different names for this person, so nothing but the phone could have joined them">No</span>') },
      { label: 'Folds the totals too', key: 'promoted',
        render: (r) => (ak ? pill(r.promoted ? 'Yes — in the stored key' : 'Pages only')
          : r.promoted
          ? '<span class="tag ok" title="this pair is in api/identity_map.js, so the stored person_key column carries it and every rollup in the product folds the two records">Yes — in the stored key</span>'
          : '<span class="tag" title="this link folds the driver directory and the driver pages on the next request, but person_key is a stored column and still counts the two records apart">Pages only</span>') },
      { label: 'Checked by a person', key: 'confirmed_at',
        render: (r) => (r.confirmed_at
          ? `${dtStr(r.confirmed_at)}${r.confirmed_by ? `<span class="dim"> · ${esc(r.confirmed_by)}</span>` : ''}`
          : '<span class="ent-off" title="the rule decided this one and nobody has looked at it yet">not yet</span>') },
      { label: 'Open', key: 'canonical_ext_id',
        render: (r) => entity('driver', r.canonical_ext_id, 'the person') },
    ];
    const tbl = tableFrom(links, LINK_COLS, { sortable: true, sortId: 'idlink' });
    if (ak) foldRows(lp.body, tbl, { shown: 12, total: links.length, noun: 'pair', key: 'id-links' });
    else lp.body.append(tbl);
    root.append(lp.panel);
  }

  if (rejected.length) {
    const rp = panel('Overruled by a person',
      'The rule proposed these and somebody said no. They stay refused through every later run, '
      + 'and they stay here so the disagreement is on the record rather than in somebody’s memory.');
    rp.body.append(tableFrom(rejected, [
      { label: 'The pair', key: 'canonical_name', render: pair },
      { label: 'Why not', key: 'rejected_reason',
        render: (r) => (r.rejected_reason
          ? esc(r.rejected_reason)
          : '<span class="ent-off" title="rejected without a reason recorded">no reason recorded</span>') },
      { label: 'What the rule saw', key: 'evidence',
        render: (r) => `<span class="dim">${esc(r.evidence)}</span>` },
      { label: 'Last proposed', key: 'last_seen_at', render: (r) => dtStr(r.last_seen_at) },
    ], { sortable: true, sortId: 'idrej' }));
    root.append(rp.panel);
  }

  /* The two caveats that decide how far a reader may trust this. Printed, not
     implied — the second one in particular is the difference between a page
     figure and a finance figure. */
  if (ak) identityAbsence(root, d, links);
  else {
    root.append(note(d.reach_note, cov.without_phone ? 'warn' : null));
    root.append(note(d.applies_note));
  }
  const links2 = el('p', 'cap');
  links2.innerHTML = 'The hand-checked merges this sits beside are in '
    + '<code>api/identity_map.js</code>, one pair at a time with the measurement that decided '
    + `each. Next to this: <a class="lnk" href="${href('drivers')}">the directory these links fold</a> `
    + `and <a class="lnk" href="${href('compliance')}">the roster they are read from</a>.`;
  root.append(links2);
}

/* ── #identity under the page contract ───────────────────────────────────── */
/* What each basis joined, and how much of it is in every total. */
function identityBasis(root, links) {
  const p = panel('What joined them', 'Links by the evidence they rest on; the count beside each is how many are in every total', 'id-basis');
  root.append(p.panel);
  const by = new Map();
  links.forEach((r) => { const k = r.basis || 'shared_phone'; const x = by.get(k) || { n: 0, promoted: 0 };
    x.n++; if (r.promoted) x.promoted++; by.set(k, x); });
  const box = el('div'); p.body.append(box);
  hbars(box, [...by.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, x]) => ({ label: BASIS[k] || k, n: x.n, promoted: x.promoted })),
    { signed: false, color: '--mk-fill', shareOf: (x) => `${fmt(x.promoted)} in every total` });
}
/* The channel pairs each link joins, one bar per pair, channel order. */
function identityPairs(root, links) {
  const p = panel('Which channels each link joins', 'One bar per pair of channels a link sits across', 'id-pairs');
  root.append(p.panel);
  const by = new Map();
  links.forEach((r) => {
    const k = [sourceLabel(r.canonical_platform), sourceLabel(r.alias_platform)].sort().join(' – ');
    by.set(k, (by.get(k) || 0) + 1);
  });
  const box = el('div'); p.body.append(box);
  hbars(box, [...by.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label, n })), { signed: false, color: '--mk-fill' });
}
/* When each link was first found, a column a day; the part in every total
   drawn over the whole. */
function identityFound(root, links) {
  const p = panel('When each link was first found', 'Links by the day the rule first proposed them; the solid part is in every total', 'id-found');
  root.append(p.panel);
  const days = new Map();
  links.forEach((r) => { const d = String(r.first_seen_at || '').slice(0, 10); if (!d) return;
    const x = days.get(d) || { total: 0, promoted: 0 }; x.total++; if (r.promoted) x.promoted++; days.set(d, x); });
  const undated = links.filter((r) => !r.first_seen_at).length;
  if (!days.size) { p.body.append(note('No link carries the day it was first found.')); return; }
  const box = el('div'); p.body.append(box);
  gapBars(box, [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, x]) => ({ d, ...x })),
    { x: 'd', y: 'promoted', label: 'in every total', secondary: 'total', secondaryLabel: 'found', inProgress: false,
      aria: 'Identity links by the day they were first found' });
  if (undated) p.body.append(el('p', 'cap', `${countOf(undated, 'link')} carry no first-found day and are not drawn.`));
}
function identityAbsence(root, d, links) {
  const confirmed = links.filter((r) => r.confirmed_at);
  const anon = confirmed.filter((r) => !r.confirmed_by).length;
  const absHost = el('div'); root.append(absHost);
  absenceBand(absHost, [
    { label: 'A name on a confirmation', hl: anon > 0, fig: anon ? `${fmt(anon)} of ${fmt(confirmed.length)}` : null,
      none: confirmed.length ? 'Every one named' : 'None confirmed',
      why: anon ? 'These links carry the time somebody confirmed them and no name — the product has no sign-in, so it cannot say who.' : confirmed.length ? 'Every confirmation names who made it.' : 'Nobody has confirmed a link yet.' },
    { label: 'What the rule can see', fig: null, none: 'See the note', why: d.reach_note || 'The rule sees only accounts that carry a phone number.' },
    { label: 'Where a link applies', fig: null, none: 'See the note', why: d.applies_note || 'A link folds the driver pages; only a promoted link folds the totals.' },
  ]);
  pageFoot({ colophon: ['identity links', `${fmt(links.length)} pairs`] }, root);
}
