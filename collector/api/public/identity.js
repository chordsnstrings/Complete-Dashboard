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
  entity, dtStr } from './ui.js';
import { fmt, empty } from './charts.js';
import { q, href } from './data.js';

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
  /* A link whose two names already fold is real and redundant — the name rule
     has it. Separating them is the difference between "the rule found sixty
     people" and "the rule found sixty people, of whom fifty-eight were being
     counted twice". */
  const needed = links.filter((r) => !/changes nothing/.test(r.evidence || ''));

  root.append(kpiRow([
    { label: 'Records joined', value: fmt(links.length),
      sub: needed.length === links.length
        ? 'every one of them a pair no name rule could have reached'
        : `${fmt(needed.length)} of them could not have been joined by name` },
    { label: 'Roster records with a phone', value: fmt(cov.with_phone ?? 0),
      sub: `of ${fmt(cov.roster_rows ?? 0)} — this rule can only see a record that carries one` },
    /* THE LIMIT, as a tile rather than a footnote. It is the figure that stops
       this page being read as a clean bill of health. */
    cov.without_phone
      ? { label: 'Records it cannot see', value: fmt(cov.without_phone),
        sub: 'no phone number on file, so nothing here says anything about them',
        tone: 'warn' }
      : null,
    rejected.length
      ? { label: 'Links a person overruled', value: fmt(rejected.length),
        sub: 'kept below, because a rule that quietly drops a correction is a rule nobody can correct' }
      : null,
  ]));

  if (!links.length) {
    const p0 = panel('No two records have been joined this way',
      'Which is either a roster with no duplicates in it, or a collector that has not run since '
      + 'this rule shipped.');
    empty(p0.body, 'Nothing to show', d.reach_note || '');
    root.append(p0.panel);
  } else {
    const lp = panel(`${countOf(links.length, 'pair')} the roster proved are one person`,
      d.basis_note);
    lp.body.append(tableFrom(links, [
      { label: 'The person', key: 'canonical_name', render: pair },
      { label: 'Joined by', key: 'phone_tail',
        render: (r) => `<span class="tag">phone ···${esc(r.phone_tail || '')}</span>` },
      /* The sentence, in full. It is the column somebody argues with. */
      { label: 'Evidence', key: 'evidence',
        render: (r) => `<span class="dim">${esc(r.evidence)}</span>` },
      { label: 'Could the names have done it?', key: 'evidence',
        render: (r) => (/changes nothing/.test(r.evidence || '')
          ? '<span class="tag ok" title="the two names fold together, so the existing name rule already joined these">Yes — already folded</span>'
          : '<span class="tag warn" title="the two channels file different names for this person, so nothing but the phone could have joined them">No</span>') },
      { label: 'Checked by a person', key: 'confirmed_at',
        render: (r) => (r.confirmed_at
          ? `${dtStr(r.confirmed_at)}${r.confirmed_by ? `<span class="dim"> · ${esc(r.confirmed_by)}</span>` : ''}`
          : '<span class="ent-off" title="the rule decided this one and nobody has looked at it yet">not yet</span>') },
      { label: 'Open', key: 'canonical_ext_id',
        render: (r) => entity('driver', r.canonical_ext_id, 'the person') },
    ], { sortable: true, sortId: 'idlink' }));
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
  root.append(note(d.reach_note, cov.without_phone ? 'warn' : null));
  root.append(note(d.applies_note));
  const links2 = el('p', 'cap');
  links2.innerHTML = 'The hand-checked merges this sits beside are in '
    + '<code>api/identity_map.js</code>, one pair at a time with the measurement that decided '
    + `each. Next to this: <a class="lnk" href="${href('drivers')}">the directory these links fold</a> `
    + `and <a class="lnk" href="${href('compliance')}">the roster they are read from</a>.`;
  root.append(links2);
}
