/* What each provider sends, and what we are not keeping.
   ──────────────────────────────────────────────────────────────────────────
   Every collector maps a chosen subset of a response into columns and drops
   the rest at the door. That decision was made once, per provider, and has
   never been visible anywhere. This page is the audit of it: per surface, the
   fields that arrive, how often each is filled, the values where a field is
   narrow enough to be a dimension — and, in its own column, the fields we have
   nowhere to put.

   The last column is the useful one. It is the list that answers "what else
   could this dashboard be showing", from evidence rather than from memory. */

import { empty, fmt } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, dtStr, pct } from './ui.js';
import { api } from './data.js';

/* A provider with no credential produces no data, and a provider with nothing
   to offer produces no data. Those are opposite situations and they looked
   identical — the first live pass returned no Uber rows at all because a guard
   read a config path that does not exist, and the page showed an Uber-shaped
   silence. */
function host_note(root, unconfigured) {
  const { panel: p, body } = panel('Providers that could not be probed',
    'Nothing was asked of these, so their absence from the tables below says nothing about what they offer.');
  body.append(tableFrom(unconfigured, [
    { label: 'Provider', key: 'provider' },
    { label: 'Why', key: 'note' },
  ]));
  root.append(p);
}

export async function renderProviders(root) {
  root.innerHTML = '';
  loading(root);
  const d = await api('/api/probe/results');
  root.innerHTML = '';
  if (!d.surfaces.length) {
    root.append(note('No provider has been probed yet. The probe runs from the collector, because that '
      + 'is where the credentials live — a page load must never be able to spend an API quota. Trigger '
      + 'one from Settings, or wait for the daily pass.'));
    return;
  }
  const unmapped = d.surfaces.reduce((a, s) => a + (s.unmapped_n || 0), 0);
  const unconfigured = d.surfaces.filter((s) => s.surface === '(not configured)');
  root.append(kpiRow([
    { label: 'Surfaces probed', value: fmt(d.surfaces.length),
      sub: `across ${new Set(d.surfaces.map((s) => s.provider)).size} providers` },
    { label: 'Answering', value: fmt(d.surfaces.filter((s) => s.ok).length),
      tone: d.failing.length ? 'warn' : 'good' },
    { label: 'Not answering', value: fmt(d.failing.length),
      tone: d.failing.length ? 'critical' : null,
      sub: d.failing.length ? d.failing.map((f) => f.surface).slice(0, 2).join(', ') : null },
    { label: 'Fields we are not keeping', value: fmt(unmapped),
      sub: 'sent by a provider, with no column on our side', tone: unmapped ? 'warn' : null },
    { label: 'Providers not configured', value: fmt(unconfigured.length),
      sub: unconfigured.length ? unconfigured.map((s) => s.provider).join(', ') : 'all credentials present',
      tone: unconfigured.length ? 'warn' : 'good' },
    { label: 'Last probe', value: d.last_probe ? dtStr(d.last_probe) : '—' },
  ]));

  if (unconfigured.length) {
    host_note(root, unconfigured);
  }

  if (d.failing.length) {
    const { panel: p, body } = panel('Surfaces that did not answer',
      'A credential that has expired looks exactly like a provider that is down until somebody reads the error.');
    body.append(tableFrom(d.failing, [
      { label: 'Provider', key: 'provider' },
      { label: 'Surface', key: 'surface' },
      { label: 'What came back', key: 'error' },
    ]));
    root.append(p);
  }

  const byProvider = new Map();
  d.surfaces.forEach((s) => {
    if (!byProvider.has(s.provider)) byProvider.set(s.provider, []);
    byProvider.get(s.provider).push(s);
  });

  for (const [provider, list] of byProvider) {
    list.filter((s) => s.surface !== '(not configured)').forEach((s) => {
      const { panel: p, body } = panel(`${provider} · ${s.surface}`,
        [s.note, s.ok ? `${fmt(s.record_count)} records sampled` : 'did not answer',
          s.probed_at ? dtStr(s.probed_at) : null].filter(Boolean).join(' · '));
      if (!s.ok) {
        body.append(el('p', 'cap', esc(s.error || 'no detail')));
        root.append(p); return;
      }
      if (s.unmapped_n) {
        const strip = el('div', 'chips');
        strip.innerHTML = `<b class="chips-l">not kept:</b>${s.unmapped.map((u) => `<span class="chip warn">${esc(u)}</span>`).join('')}`;
        body.append(strip);
      }
      body.append(tableFrom(s.fields || [], [
        { label: 'Field', key: 'key', render: (f) => `<code>${esc(f.key)}</code>` },
        { label: 'Type', key: 'type' },
        { label: 'Filled', key: 'fill_pct', num: true, render: (f) => pct(f.fill_pct, 0) },
        { label: 'Distinct', key: 'distinct_seen', num: true },
        { label: 'Values', key: 'values', render: (f) => (f.values
          ? f.values.map((v) => `<span class="chip">${esc(v)}</span>`).join(' ')
          : '<span class="dim">wide — an identifier or free text, contents not recorded</span>') },
        { label: 'Kept', key: 'k', render: (f) => (s.unmapped?.includes(f.key)
          ? pill('no', 'warn') : pill('yes', 'ok')) },
      ], { compact: true }));
      root.append(p);
    });
  }
  root.append(note(d.note));
}
