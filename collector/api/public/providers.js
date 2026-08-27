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
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, dtStr, dateStr, pct,
  sourceLabel, countOf, plural, foldRows } from './ui.js';
import { api, href, state, store } from './data.js';
import { dubaiDay } from './tz.js';

/* Whether a surface actually ANSWERED.
   ─────────────────────────────────────────────────────────────────────────
   The probe records ok:true for any response it managed to parse, so a Yango
   403 and an Uber 404 both arrive as `{http_status: 403, ok: true}` and the
   page counted them under "ANSWERING". Three refused Yango surfaces and one
   missing Uber one were reported as healthy while `failing` was empty.
   Judged here from the status code, which is the thing that decides it, so
   this page tells the truth before and after the collector is fixed. */
const answered = (s) => {
  const st = s.http_status;
  if (st != null && !(st >= 200 && st < 300)) return false;
  if (s.ok === false) return false;
  /* A 200 whose body is only an error object is a refusal wearing a success
     code — FMS answers `{"error":"Authentication failed"}` with a 200 and no
     rows, and it was offered as an unmapped field we could go and keep. */
  const keys = (s.fields || []).map((f) => String(f.key).toLowerCase());
  if (keys.length && keys.length <= 4 && keys.every((k) => /^(error|message|fault|status|code)$/.test(k))) return false;
  return true;
};
const refusal = (s) => {
  if (s.error) return String(s.error);
  const st = s.http_status;
  if (st != null && !(st >= 200 && st < 300)) return `HTTP ${st}`;
  const errField = (s.fields || []).find((f) => /^error|message|fault$/i.test(f.key));
  if (errField && (errField.values || []).length) return String(errField.values[0]);
  return 'no detail recorded';
};

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

/* ── one field's values ───────────────────────────────────────────────────
   `#providers/<provider>/<surface>/<key>`. "Fields we are not keeping: 109" is
   the most valuable number on this page and it was unopenable — the endpoint
   that answers it, /api/schema/raw-values, existed and was called from
   nowhere. Deciding whether a raw field is worth a column means seeing what is
   actually in it. */
export async function renderProviderField(root, provider, surface, key) {
  root.innerHTML = '';
  const crumb = el('p', 'cap');
  crumb.innerHTML = `<a class="lnk" href="${href('providers')}">What each API offers</a> / `
    + `<b>${esc(sourceLabel(provider))} · ${esc(surface)}</b> / <code>${esc(key)}</code>`;
  root.append(crumb);
  const p = panel(`${key}`, `Every value this field takes in the stored records, most common first.`);
  root.append(p.panel); loading(p.body);
  const to = dubaiDay();
  const from = dubaiDay(new Date(Date.now() - 364 * 864e5));
  const TABLE = { alert: 'alert', telemetry: 'telemetry_snapshot', driver: 'driver_performance',
    vehicle: 'vehicle_profile' };
  const table = Object.entries(TABLE).find(([k]) => new RegExp(k, 'i').test(surface))?.[1] || 'trip';
  let rows;
  try {
    rows = await api(`/api/schema/raw-values?${new URLSearchParams({
      key, table, platform: provider, from, to })}`);
  } catch (e) {
    p.body.innerHTML = '';
    p.body.append(note(`Could not read the values: ${e.message}`, 'err'));
    return;
  }
  p.body.innerHTML = '';
  if (!rows.length) {
    p.body.append(note(`No stored record from ${sourceLabel(provider)} between ${dateStr(from)} and `
      + `${dateStr(to)} carries this field. That is a statement about the last twelve months, not about `
      + 'the field — the probe describes a live sample and this reads what was actually stored.'));
    return;
  }
  const total = rows.reduce((a, r) => a + (+r.n || 0), 0);
  p.body.append(tableFrom(rows, [
    { label: 'Value', key: 'value',
      render: (r) => (r.value == null || r.value === ''
        ? '<span class="ent-off" title="present in the record and empty">(empty)</span>'
        : `<code>${esc(String(r.value).slice(0, 120))}</code>`) },
    { label: 'Records', key: 'n', num: true, render: (r) => fmt(r.n) },
    { label: 'Share', key: '_s', num: true,
      sortValue: (r) => (total ? (r.n / total) * 100 : null),
      render: (r) => pct(total ? (r.n / total) * 100 : 0, 1) },
  ], { sortable: true, sortId: 'rawvals', defaultSort: { key: 'n', dir: 'desc' } }));
  p.body.append(el('p', 'cap',
    `${countOf(rows.length, 'distinct value')} across ${fmt(total)} stored records between `
    + `${dateStr(from)} and ${dateStr(to)}, capped at the 60 commonest. A field with few values is a `
    + 'dimension worth a column; a field with as many values as records is an identifier or free text.'));
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
  const unconfigured = d.surfaces.filter((s) => s.surface === '(not configured)');
  const probed = d.surfaces.filter((s) => s.surface !== '(not configured)');
  /* Recomputed from the status codes rather than taken from `ok`. See
     `answered` above: the probe's own flag counted a 403 as a success. */
  const live = probed.filter(answered);
  const refused = probed.filter((s) => !answered(s));
  const unmapped = live.reduce((a, s) => a + (s.unmapped_n || 0), 0);
  root.append(kpiRow([
    { label: 'Surfaces probed', value: fmt(probed.length),
      sub: `across ${countOf(new Set(probed.map((s) => s.provider)).size, 'provider')}` },
    { label: 'Answering', value: `${fmt(live.length)} of ${fmt(probed.length)}`,
      tone: refused.length ? 'warn' : 'good',
      sub: 'returned a 2xx with something in it' },
    { label: 'Refused or missing', value: fmt(refused.length),
      tone: refused.length ? 'critical' : null,
      sub: refused.length
        ? refused.slice(0, 3).map((f) => `${f.surface} ${f.http_status || ''}`.trim()).join(', ')
        : 'every surface answered' },
    { label: 'Fields we are not keeping', value: fmt(unmapped),
      sub: 'sent by a provider, with no column on our side — click a field below to see its values',
      tone: unmapped ? 'warn' : null },
    { label: 'Providers not configured', value: fmt(unconfigured.length),
      sub: unconfigured.length ? unconfigured.map((s) => sourceLabel(s.provider)).join(', ') : 'all credentials present',
      tone: unconfigured.length ? 'warn' : 'good' },
    { label: 'Last probe', value: d.last_probe ? dtStr(d.last_probe) : '—',
      sub: d.last_probe ? 'the probe runs from the collector, not from this page' : 'never run' },
  ]));

  /* A jump list. This page is 11,897 pixels tall with zero links and zero
     controls on it, so finding one provider's surface meant scrolling past
     every other one. */
  const jump = el('div', 'chips');
  jump.innerHTML = '<b class="chips-l">jump to:</b>'
    + [...new Set(probed.map((s) => s.provider))].map((p2) =>
      `<a class="chip" href="#prov-${encodeURIComponent(p2)}">${esc(sourceLabel(p2))}</a>`).join('');
  root.append(jump);

  /* A filter for the column this page exists for. */
  const bar = el('div', 'toolbar');
  const onlyUnkept = store.get('provUnkept') === '1';
  bar.innerHTML = `<label class="cap"><input type="checkbox" id="pvUnkept" ${onlyUnkept ? 'checked' : ''}> `
    + 'show only the fields we are not keeping</label>';
  root.append(bar);

  if (unconfigured.length) {
    host_note(root, unconfigured);
  }

  if (refused.length) {
    const { panel: p, body } = panel('Surfaces that did not answer',
      'A credential that has expired looks exactly like a provider that is down until somebody reads the '
      + 'status code. Each of these returned a refusal; none of them is evidence about what the provider offers.');
    body.append(tableFrom(refused, [
      { label: 'Provider', key: 'provider', render: (s) => esc(sourceLabel(s.provider)) },
      { label: 'Surface', key: 'surface' },
      { label: 'Status', key: 'http_status',
        render: (s) => (s.http_status != null
          ? `<span class="tag ${s.http_status >= 500 ? 'err' : 'bad'}">HTTP ${esc(String(s.http_status))}</span>`
          : '<span class="tag warn">answered 200 with an error body</span>') },
      { label: 'What came back', key: 'error', render: (s) => `<span class="wrap">${esc(refusal(s))}</span>` },
      { label: 'Probed', key: 'probed_at', render: (s) => (s.probed_at ? dtStr(s.probed_at) : '—') },
    ], { sortable: true, sortId: 'refused' }));
    body.append(el('p', 'cap',
      'A 403 is a permission the credential does not carry; a 404 is a surface that has moved or never '
      + 'existed. Neither is a provider that is down, and neither belongs in the answering count.'));
    root.append(p);
  }

  const byProvider = new Map();
  d.surfaces.forEach((s) => {
    if (!byProvider.has(s.provider)) byProvider.set(s.provider, []);
    byProvider.get(s.provider).push(s);
  });

  const drawPanels = (unkeptOnly) => {
    root.querySelectorAll('[data-surface]').forEach((n) => n.remove());
    for (const [provider, list] of byProvider) {
      let first = true;
      list.filter((s) => s.surface !== '(not configured)').forEach((s) => {
        const ok = answered(s);
        const { panel: p, body } = panel(`${sourceLabel(provider)} · ${s.surface}`,
          [s.note,
            // The status code, on every panel, whatever the verdict.
            s.http_status != null ? `HTTP ${s.http_status}` : null,
            ok
              ? `${countOf(s.record_count, 'record')} returned, first `
                + `${fmt(s.described_n ?? Math.min(s.record_count ?? 0, 300))} described`
              : 'did not answer',
            s.probed_at ? dtStr(s.probed_at) : null].filter(Boolean).join(' · '));
        p.setAttribute('data-surface', '');
        if (first) { p.id = `prov-${provider}`; first = false; }
        /* The provider's own collector status, as the first line. A surface
           that refused and a provider whose credential expired are the same
           story told from two pages, and neither named the other. */
        const st = (d.status || []).find((x) => x.source === provider);
        if (st) {
          const line = el('p', 'cap');
          line.innerHTML = `Collector: <span class="tag ${st.status === 'ok' ? 'ok' : 'bad'}">${esc(st.status)}</span> `
            + `${st.error ? `<span class="dim">${esc(String(st.error).slice(0, 120))}</span> · ` : ''}`
            + `<a class="lnk" href="${href('sources')}">what this source has actually delivered</a>`;
          body.append(line);
        }
        if (!ok) {
          /* Never falls through to a field table. A refusal drew tableFrom's
             default empty state — "No data for this range yet" — on a page
             with no date range, about a 403. */
          body.append(note(`${sourceLabel(provider)} refused this surface: ${refusal(s)}`, 'err'));
          body.append(el('p', 'cap', 'Nothing below this line: the fields a refused surface would have '
            + 'sent are unknown, which is not the same as none.'));
          root.append(p); return;
        }
        const fields = (s.fields || []).filter((f) => !unkeptOnly || s.unmapped?.includes(f.key));
        if (s.unmapped_n) {
          const strip = el('div', 'chips');
          strip.innerHTML = `<b class="chips-l">not kept:</b>${s.unmapped.map((u) =>
            `<a class="chip warn" href="${href('providers', provider, s.surface)}/${encodeURIComponent(u)}">${esc(u)}</a>`).join('')}`;
          body.append(strip);
        }
        if (!fields.length) {
          body.append(el('p', 'cap', unkeptOnly
            ? 'Every field this surface sends is already kept as a column.'
            : 'This surface answered and described no fields.'));
          root.append(p); return;
        }
        const fieldTable = tableFrom(fields, [
          { label: 'Field', key: 'key',
            render: (f) => `<a class="ent" href="${href('providers', provider, s.surface)}/${encodeURIComponent(f.key)}"><code>${esc(f.key)}</code></a>` },
          { label: 'Type', key: 'type' },
          { label: 'Filled', key: 'fill_pct', num: true, render: (f) => pct(f.fill_pct, 0) },
          /* The cap, stated. `distinct_seen` saturates at the probe's own
             sample ceiling, so every wide field in the corpus reported the
             same number — which reads as a coincidence rather than as a cap. */
          { label: 'Distinct seen (sample, capped)', key: 'distinct_seen', num: true,
            render: (f) => {
              // `+` unless the probe says it counted them all. Without it every
              // wide field in the corpus reported the same figure, which reads
              // as a striking coincidence rather than as the sample ceiling.
              const capped = f.distinct_capped !== false;
              return `<span title="${capped
                ? 'the probe samples a fixed number of records, so this is a floor'
                : 'counted over every sampled record'}">${fmt(f.distinct_seen)}${capped ? '+' : ''}</span>`;
            } },
          /* A JSON null in a sample renders as the WORD "null" in a chip, which
             is indistinguishable from a provider that literally sends the
             four-character string "null" — and fourteen of those appeared on
             this page. Marked as an absence instead, so the two readings stay
             apart: the chip says what it is, and a real string keeps its
             quotes-free chip. */
          { label: 'Values', key: 'values', render: (f) => (f.values
            ? f.values.map((v) => (v == null || v === 'null'
              ? '<span class="chip dim" title="the provider sent no value in this field for the '
                + 'sampled records — a JSON null, not the text &quot;null&quot;">(no value)</span>'
              : `<span class="chip">${esc(v)}</span>`)).join(' ')
            : '<span class="dim">wide — an identifier or free text, contents not recorded</span>') },
          { label: 'Kept', key: 'k', render: (f) => (s.unmapped?.includes(f.key)
            ? pill('no', 'warn') : pill('yes', 'ok')) },
        ], { compact: true, sortable: true, sortId: `pf-${provider}-${s.surface}` });
        foldRows(body, fieldTable,
          { shown: 8, total: fields.length, noun: 'field', key: `pf-${provider}-${s.surface}` });
        root.append(p);
      });
    }
    root.append(note(d.note));
    root.lastChild.setAttribute('data-surface', '');
  };
  drawPanels(onlyUnkept);
  bar.querySelector('#pvUnkept').onchange = (e) => {
    store.set('provUnkept', e.target.checked ? '1' : '');
    drawPanels(e.target.checked);
  };
}
