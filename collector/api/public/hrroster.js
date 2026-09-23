/* HR ROSTER — the operator's HR export, the documents on it, and the upload.
   ──────────────────────────────────────────────────────────────────────────
   Two parts. The roster: one row per person on the latest HR export, each
   document with its expiry, a status and whether a number is on file — never
   the number — plus the people a newer export dropped, marked "off the HR list
   since". And the import: choose the .xlsx, see what it would do, then commit
   it on purpose.

   ── WHAT THE PAGE WILL NOT SAY ───────────────────────────────────────────
   It does not show a document number. The API does not send one (the driver
   page is the one place the Emirates ID and the licence number are shown,
   by the operator's decision), so every document cell says "number on file"
   or "no number on file", and the visa says its number is not kept.

   It does not present HR's "Compliance Status" as this product's verdict.
   It is HR's own word, labelled as HR's.

   It does not count what it cannot count. Before the first upload there is no
   roster, and every figure is absent with that reason — not zero. A document
   with no date is "missing", with the reason, and sorts last; it is never
   "ok" and never "expired". */
import { el, esc, panel, note, loading, kpiRow, tableFrom, entity, pill, sourceLabel,
  dateStr, fmt, foldRows, countOf } from './ui.js';
import { api, state, href } from './data.js';

const DOCS = [
  ['passport', 'Passport'], ['emirates_id', 'Emirates ID'], ['licence', 'Licence'],
  ['visa', 'Visa'], ['rta_permit', 'RTA permit'],
];
const STATUS = {
  expired: ['expired', 'err'], d30: ['≤30 days', 'err'], d45: ['≤45 days', 'warn'],
  d90: ['≤90 days', 'warn'], ok: ['ok', 'ok'], missing: ['missing', 'dim'],
};
const BUCKETS = [['expired', 'Expired'], ['d30', '≤30 days'], ['d45', '31–45'], ['d90', '46–90'],
  ['ok', 'Over 90'], ['missing', 'No date']];
const FLEET = { ecosine: 'Ecosine', egari: 'Egari' };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const dateFromName = (n) => (/active-drivers-(\d{4}-\d{2}-\d{2})\.xlsx$/i.exec(String(n || '')) || [])[1] || null;

/* One document, as a cell: when, how soon, whether a number is held. */
function docCell(d) {
  if (!d) return '<span class="ent-off">—</span>';
  const [label, tone] = STATUS[d.status] || ['—', 'dim'];
  const when = d.expires ? esc(dateStr(d.expires))
    : `<span class="ent-off" title="${esc(d.absent_reason || '')}">no date</span>`;
  const days = d.days_left == null ? ''
    : ` <span class="dim">${d.days_left < 0 ? `${fmt(Math.abs(d.days_left))}d ago` : `${fmt(d.days_left)}d`}</span>`;
  const tag = ` <span class="tag ${tone}"${d.status === 'missing' ? ` title="${esc(d.absent_reason || '')}"` : ''}>${label}</span>`;
  /* A blank in the latest export is not the document vanishing: this is the
     last date HR filed, and it says which export it came from. */
  const carried = d.expires_from_export
    ? `<div class="dim" title="blank in the latest HR export — this is the last date HR filed">from the ${esc(dateStr(d.expires_from_export))} export</div>` : '';
  const num = d.number_on_file == null
    ? '<div class="dim" title="this product does not keep visa numbers">number not kept</div>'
    : d.number_on_file ? '<div class="dim">number on file</div>'
      : '<div class="dim" title="HR’s export carries no number for this document">no number on file</div>';
  return `${when}${days}${tag}${carried}${num}`;
}

/* Where a person's row opens: their person page when the spine places them,
   the account's page when one account and no person, plain text otherwise. */
function whoCell(p) {
  const target = p.person_id != null ? `p${p.person_id}`
    : (p.accounts.length === 1 ? p.accounts[0].ext_id : null);
  return (target ? entity('driver', target, p.name || p.employee_id) : esc(p.name || '—'))
    + (p.person_ids.length > 1 ? `<div class="dim" title="HR files these accounts under one employee; this product holds them as ${p.person_ids.length} people — see Same person?">${p.person_ids.length} people here</div>` : '');
}

/* Each matched account opens the existing driver page — by person where the
   spine places it, by the account otherwise — and degrades to a plain pill,
   never a broken link, if it has neither (test/interlinking.test.mjs). */
function accountsCell(p) {
  const held = p.accounts.map((a) => {
    const target = a.person_id != null ? `p${a.person_id}` : a.ext_id;
    const label = `${esc(sourceLabel(a.platform))}${a.via === 'phone' ? ' · phone' : ''}`;
    const title = esc(`${sourceLabel(a.platform)} account ${a.ext_id} — matched ${a.via === 'phone' ? 'by phone' : 'by the id HR filed'}`);
    return target
      ? `<a class="pill plat" href="${href('driver', target)}" title="${title}">${label}</a>`
      : `<span class="pill plat" title="${title}">${label}</span>`;
  }).join(' ');
  const not = p.unmatched_ids.map((u) => `<span class="tag dim" title="${esc(u.reason)}">${esc(sourceLabel(u.platform))} id not held</span>`).join(' ');
  if (!held && !not) {
    return '<span class="ent-off" title="HR files no platform id for this person and their phone is on no record this product holds">no account matched</span>';
  }
  return [held, not].filter(Boolean).join(' ');
}

function rosterTable(people) {
  return tableFrom(people, [
    { label: 'Fleet', key: 'fleet_id', render: (p) => esc(FLEET[p.fleet_id] || p.fleet_id) },
    { label: 'Employee', key: 'employee_id', render: (p) => `<span class="mono">${esc(p.employee_id)}</span>` },
    { label: 'Name', key: 'name', render: whoCell },
    { label: 'Platform accounts', key: 'accounts', sortValue: (p) => p.accounts.length, render: accountsCell },
    ...DOCS.map(([k, label]) => ({ label, key: `doc_${k}`,
      sortValue: (p) => p.documents[k]?.days_left ?? null,
      render: (p) => docCell(p.documents[k]) })),
    /* HR's word, labelled as HR's. */
    { label: 'HR’s status', key: 'hr_compliance_status',
      render: (p) => (p.hr_compliance_status
        ? `<span class="tag dim" title="HR’s own compliance label, as their export files it — not this product’s verdict">HR: ${esc(p.hr_compliance_status)}</span>`
        : '<span class="ent-off" title="HR’s export carries no compliance status for this person">—</span>') },
    { label: 'On HR’s list', key: 'on_list', sortValue: (p) => (p.on_list ? 1 : 0),
      render: (p) => (p.on_list ? '<span class="tag ok">on the list</span>'
        : `<span class="tag warn" title="on the ${esc(dateStr(p.last_export_date))} export and not on the next one">off the HR list since ${esc(dateStr(p.off_list_since))}</span>`) },
  ], { sortable: true, sortId: 'hr-roster', defaultSort: { key: 'doc_licence', dir: 'asc' } });
}

/* ── the preview, as a reader needs it ───────────────────────────────────── */
function renderPreview(host, p) {
  host.innerHTML = '';
  if (!p.ok) {
    host.append(note(`This file cannot be imported${p.refusals?.length > 1 ? `, for ${p.refusals.length} reasons` : ''}:`, 'warn'));
    const ul = el('ul', 'hr-refusals');
    (p.refusals || ['the server gave no reason']).forEach((r) => ul.append(el('li', null, esc(r))));
    host.append(ul);
    host.append(el('p', 'cap', 'Nothing was written.'));
    return;
  }
  const m = p.match || {};
  host.append(kpiRow([
    { key: 'hrp-rows', label: 'Rows read', value: fmt(p.rows_read),
      sub: Object.entries(p.fleet_split || {}).map(([f, n]) => `${FLEET[f] || f} ${fmt(n)}`).join(' · ') },
    { key: 'hrp-id', label: 'Matched by platform id', value: fmt(m.by_platform_id), sub: 'the id HR typed' },
    { key: 'hrp-phone', label: 'Matched by phone', value: fmt(m.by_phone), sub: 'no id of theirs is held' },
    { key: 'hrp-none', label: 'Not matched', value: fmt(m.unmatched), sub: 'never matched by name' },
    { key: 'hrp-props', label: 'New same-person proposals', value: fmt(p.proposals?.new),
      sub: `${countOf(p.proposals?.people || 0, 'person', 'people')} · none is a merge` },
    { key: 'hrp-contra', label: 'Contradictions', value: fmt((p.contradictions || []).length),
      sub: 'with links already held' },
    { key: 'hrp-lic', label: 'Licence dates unlike Yango’s', value: fmt(p.licence_vs_yango?.differ),
      sub: `of ${fmt(p.licence_vs_yango?.compared || 0)} compared` },
  ]));
  host.append(el('p', 'cap', `The export of ${dateStr(p.export_date)} (${p.export_date_from === 'filename'
    ? 'from the filename' : 'as entered'}). ${esc(m.how || '')}`));
  if (m.fleet_disagreements) {
    host.append(note(`${countOf(m.fleet_disagreements, 'row')} name a platform id this product files under the other fleet.`, 'warn'));
  }
  if (p.older_than_latest) {
    host.append(note(`This export is older than the latest one on file (${dateStr(p.latest_on_file?.export_date)}). `
      + 'It will be kept as history; it does not change who is on the list.', 'warn'));
  }
  if (p.emirates_id_not_15_digits) {
    host.append(note(`${countOf(p.emirates_id_not_15_digits, 'Emirates ID')} on this file ${p.emirates_id_not_15_digits === 1 ? 'is' : 'are'} not fifteen digits. `
      + 'Kept as typed and not corrected.', 'warn'));
  }

  /* The expiry summary, per document, relative to today in Dubai. */
  const ex = p.expiry || {};
  const exRows = DOCS.map(([k, label]) => ({ doc: label, ...(ex[k] || {}) }));
  const exP = panel('Document expiry on this file', `Relative to today in Dubai, ${dateStr(p.today)}`, 'hr-preview-expiry');
  exP.body.append(tableFrom(exRows, [
    { label: 'Document', key: 'doc' },
    ...BUCKETS.map(([k, label]) => ({ label, key: k, num: true, render: (r) => fmt(r[k] ?? 0) })),
  ], { compact: true }));
  host.append(exP.panel);

  if ((p.contradictions || []).length) {
    const cp = panel('Where HR contradicts a link already held',
      'Each will also show on Same person?, beside the link or the proposal it concerns', 'hr-preview-contra');
    const ul = el('ul', 'hr-refusals');
    p.contradictions.forEach((c) => ul.append(el('li', null, esc(c.evidence))));
    cp.body.append(ul);
    host.append(cp.panel);
  }
  if ((p.proposals?.list || []).length) {
    const pp = panel('Same-person proposals this file makes',
      'Platform ids HR files under one employee. They go to the Same person? queue under basis hr_roster; nothing is merged', 'hr-preview-props');
    pp.body.append(tableFrom(p.proposals.list, [
      { label: 'Employee', key: 'employee_id', render: (x) => `${esc(FLEET[x.fleet_id] || x.fleet_id)} <span class="mono">${esc(x.employee_id)}</span>` },
      { label: 'Name', key: 'name' },
      { label: 'Accounts HR groups', key: 'accounts', render: (x) => x.accounts.map((a) => pill(sourceLabel(a.platform), 'plat', a.ext_id)).join(' ') },
      { label: 'Status', key: 'status', render: (x) => ({ new: pill('new', 'info'), pending: pill('already waiting'),
        same: pill('answered: one person', 'ok'), different: pill('answered: two people') }[x.status] || esc(x.status)) },
    ], { compact: true }));
    host.append(pp.panel);
  }
  const y = p.licence_vs_yango || {};
  if ((y.rows || []).length) {
    const lp = panel('Licence dates HR and Yango disagree on',
      `${fmt(y.yango_older)} where Yango's date is older, ${fmt(y.yango_older_by_over_a_year)} of them by more than a year; `
      + `${fmt(y.hr_valid_yango_expired)} HR says valid and Yango says expired. HR's date is the one this product uses.`, 'hr-preview-yango');
    lp.body.append(tableFrom(y.rows, [
      { label: 'Employee', key: 'employee_id', render: (x) => `${esc(FLEET[x.fleet_id] || x.fleet_id)} <span class="mono">${esc(x.employee_id)}</span>` },
      { label: 'Name', key: 'name' },
      { label: 'HR', key: 'hr_expires', render: (x) => esc(dateStr(x.hr_expires)) },
      { label: 'Yango', key: 'yango_expires', render: (x) => esc(dateStr(x.yango_expires)) },
      { label: 'Days apart', key: 'days_apart', num: true, render: (x) => fmt(x.days_apart) },
    ], { compact: true, sortable: true, sortId: 'hr-yango', defaultSort: { key: 'days_apart', dir: 'desc' } }));
    host.append(lp.panel);
  }
  const a = p.against;
  if (a) {
    const ap = panel(`Against the export of ${dateStr(a.against.export_date)}`, null, 'hr-preview-against');
    ap.body.append(el('p', 'cap', `${countOf(a.dropped.length, 'person', 'people')} on that export ${a.dropped.length === 1 ? 'is' : 'are'} not on this one and will read “off the HR list since ${dateStr(p.export_date)}” — never deleted. `
      + `${countOf(a.added, 'person', 'people')} ${a.added === 1 ? 'is' : 'are'} new.`));
    if (a.dropped.length) {
      ap.body.append(el('p', 'cap', `Leaving the list: ${a.dropped.slice(0, 12).map((d) => `${FLEET[d.fleet_id] || d.fleet_id} ${d.employee_id}`).join(', ')}${a.dropped.length > 12 ? ` and ${a.dropped.length - 12} more` : ''}.`));
    }
    if (a.blanked.length) {
      ap.body.append(note(`Columns filled on the earlier export and blank on this one: ${a.blanked.map((b) => `${b.column} (${countOf(b.rows, 'row')})`).join(', ')}. ${a.note}`, 'warn'));
    }
    host.append(ap.panel);
  }
}

export async function renderHrRoster(root) {
  root.innerHTML = '';
  const head = el('div'); root.append(head); loading(head);
  const rosterP = panel('The roster', 'One row per person on the latest HR export, and the people a newer export dropped', 'hr-roster');
  const importP = panel('Bring in an HR export', 'The HR system’s active-drivers workbook, exactly as it exports it. See what it would do first; nothing is written until you commit.', 'hr-import');
  const histP = panel('Upload history', 'Every export ever brought in. Each is kept as it was — a newer one never overwrites an older one', 'hr-uploads');
  root.append(rosterP.panel, importP.panel, histP.panel);
  [rosterP.body, histP.body].forEach((b) => loading(b));

  /* ── the import form ─────────────────────────────────────────────────── */
  const form = el('div', 'depform');
  const fileW = el('div', 'depfield');
  fileW.append(el('label', 'deplabel', 'The .xlsx'));
  const file = el('input', 'depinput depfile');
  file.type = 'file'; file.accept = '.xlsx,' + XLSX;
  const drop = el('div', 'depnote hr-drop', 'Choose the file, or drop it anywhere on this panel. The sheet must be “Drivers” with the export’s 44 columns in order; anything else is refused with the reason.');
  fileW.append(file, drop);
  const dateW = el('div', 'depfield');
  dateW.append(el('label', 'deplabel', 'Export date'));
  const dateIn = el('input', 'depinput');
  dateIn.type = 'date';
  const dateNote = el('div', 'depnote', 'Taken from the filename when it says (active-drivers-YYYY-MM-DD.xlsx); otherwise enter the day HR exported it.');
  dateW.append(dateIn, dateNote);
  dateW.hidden = true;
  const whoW = el('div', 'depfield');
  whoW.append(el('label', 'deplabel', 'Who is uploading'));
  const whoIn = el('input', 'depinput');
  whoIn.type = 'text'; whoIn.maxLength = 60; whoIn.placeholder = 'your name';
  whoW.append(whoIn);
  form.append(fileW, dateW, whoW);
  importP.body.append(form);
  const actions = el('div', 'btnrow');
  const previewBtn = el('button', 'btn', 'Preview');
  const commitBtn = el('button', 'btn primary', 'Commit this export');
  previewBtn.type = 'button'; commitBtn.type = 'button';
  previewBtn.disabled = true; commitBtn.disabled = true;
  actions.append(previewBtn, commitBtn);
  importP.body.append(actions);
  const out = el('div', 'hr-preview');
  out.dataset.panel = 'hr-preview';
  importP.body.append(out);

  let bytes = null;
  let fname = null;
  let previewed = null;
  const headers = () => ({ 'content-type': XLSX, ...(state.admin ? { 'x-admin-token': state.admin } : {}) });
  const qs = (extra = {}) => {
    const u = new URLSearchParams({ filename: fname || '' });
    if (!dateFromName(fname) && dateIn.value) u.set('export_date', dateIn.value);
    for (const [k, v] of Object.entries(extra)) if (v) u.set(k, v);
    return u.toString();
  };
  const take = async (f) => {
    if (!f) return;
    fname = f.name; bytes = await f.arrayBuffer();
    previewed = null; commitBtn.disabled = true; out.innerHTML = '';
    dateW.hidden = Boolean(dateFromName(fname));
    previewBtn.disabled = false;
    drop.textContent = `${f.name} — ${fmt(Math.round(f.size / 1024))} KB. Preview it to see what it would do.`;
  };
  file.onchange = () => take(file.files && file.files[0]);
  importP.panel.addEventListener('dragover', (e) => { e.preventDefault(); });
  importP.panel.addEventListener('drop', (e) => {
    e.preventDefault();
    take(e.dataTransfer?.files?.[0]);
  });
  const send = async (path) => {
    const r = await fetch(path, { method: 'POST', headers: headers(), body: bytes });
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    if (r.status === 401) {
      return { ok: false, refusals: ['this server requires the admin token for an import. Enter it on the Settings page — it is kept in this browser only.'] };
    }
    return body || { ok: false, refusals: [`the server answered ${r.status} with no reason`] };
  };
  previewBtn.onclick = async () => {
    if (!bytes) return;
    loading(out);
    const p = await send(`/api/hr-roster/preview?${qs()}`);
    if (p.needs_export_date) dateW.hidden = false;
    renderPreview(out, p);
    previewed = p.ok ? p : null;
    commitBtn.disabled = !previewed;
  };
  commitBtn.onclick = async () => {
    if (!previewed) return;
    if (whoIn.value.trim().length < 2) {
      out.prepend(note('Say who is uploading before committing — it is recorded against the upload.', 'warn'));
      whoIn.focus();
      return;
    }
    commitBtn.disabled = true;
    const r = await send(`/api/hr-roster/commit?${qs({ by: whoIn.value.trim(), expect_sha: previewed.sha256 })}`);
    const res = el('div', 'hr-result');
    res.dataset.panel = 'hr-result';
    if (r.ok) {
      res.append(note(r.note || 'Written.', null));
      previewed = null;
      await draw();
    } else {
      res.append(note(`Not written: ${(r.refusals || []).join(' · ') || 'the server gave no reason'}`, 'warn'));
      commitBtn.disabled = false;
    }
    out.prepend(res);
  };

  /* ── the roster and the history ──────────────────────────────────────── */
  let fleetPick = state.fleet || '';
  let expiringOnly = false;
  let showOff = true;
  const draw = async () => {
    let v;
    /* With options, so the answer is never served from the page's own
       stale-while-revalidate copy: after a commit the redraw must be the
       roster the commit wrote, not the one from before it. */
    try { v = await api('/api/hr-roster', { method: 'GET' }); } catch (e) {
      head.innerHTML = '';
      head.append(note(`The HR roster could not be read: ${String(e && e.message ? e.message : e)}`, 'warn'));
      rosterP.body.innerHTML = ''; histP.body.innerHTML = '';
      return;
    }
    head.innerHTML = '';
    if (!v.latest) {
      /* ABSENT WITH THE REASON — no tiles, no zeros. */
      head.append(note(v.absent_reason, 'warn'));
      rosterP.body.innerHTML = '';
      rosterP.body.append(el('p', 'cap', 'Bring in the HR system’s export below; the roster appears here once one is committed.'));
      histP.body.innerHTML = '';
      histP.body.append(el('p', 'cap', 'Nothing has been uploaded.'));
      return;
    }
    const t = v.totals;
    head.append(kpiRow([
      { key: 'hr-on-list', label: 'On HR’s list', value: fmt(t.on_list),
        sub: `${FLEET.ecosine} ${fmt(t.by_fleet.ecosine)} · ${FLEET.egari} ${fmt(t.by_fleet.egari)}` },
      { key: 'hr-expiring', label: 'Anything expiring in 90 days', value: fmt(t.anything_expiring),
        sub: 'people with at least one document expired or due' },
      { key: 'hr-matched', label: 'Matched to a platform account', value: fmt(t.matched.platform_id + t.matched.phone),
        sub: `${fmt(t.matched.platform_id)} by id · ${fmt(t.matched.phone)} by phone · ${fmt(t.matched.none)} not matched` },
      { key: 'hr-off-list', label: 'Off the HR list', value: fmt(t.off_list),
        sub: 'dropped by a newer export — kept, not deleted' },
    ]));
    head.append(el('p', 'cap', `From HR’s export of ${dateStr(v.latest.export_date)}, uploaded by ${v.latest.uploaded_by}. `
      + `Expiry is counted against today in Dubai, ${dateStr(v.today)}. Document numbers are held and never shown here.`));

    /* filters */
    rosterP.body.innerHTML = '';
    const bar = el('div', 'filters');
    const fleetSel = el('select');
    fleetSel.setAttribute('aria-label', 'Fleet');
    fleetSel.innerHTML = [['', 'Both fleets'], ['ecosine', 'Ecosine'], ['egari', 'Egari']]
      .map(([k, l]) => `<option value="${k}"${k === fleetPick ? ' selected' : ''}>${l}</option>`).join('');
    const expBtn = el('button', expiringOnly ? 'on' : '', expiringOnly ? '✓ Anything expiring' : 'Anything expiring');
    expBtn.type = 'button';
    expBtn.dataset.filter = 'expiring';
    const offBtn = el('button', showOff ? 'on' : '', showOff ? '✓ Include off the list' : 'Include off the list');
    offBtn.type = 'button';
    bar.append(fleetSel, expBtn, offBtn);
    const shown = el('p', 'cap');
    const tableHost = el('div');
    /* A handle for the roster's own table: the expiry summary below is a
       second table inside the same panel. */
    tableHost.dataset.hr = 'roster-table';
    rosterP.body.append(bar, shown, tableHost);
    const paint = () => {
      const rows = v.people.filter((p) => (!fleetPick || p.fleet_id === fleetPick)
        && (!expiringOnly || p.anything_expiring) && (showOff || p.on_list));
      tableHost.innerHTML = '';
      if (!rows.length) {
        tableHost.append(note(expiringOnly ? 'Nobody in this selection has a document expired or due within 90 days.'
          : 'Nobody in this selection.'));
      } else {
        foldRows(tableHost, rosterTable(rows), { shown: 25, total: rows.length, noun: 'person', key: 'hr-roster' });
      }
      shown.textContent = `Showing ${countOf(rows.length, 'person', 'people')} of ${fmt(v.people.length)}`
        + `${fleetPick ? ` in ${FLEET[fleetPick]}` : ''}${expiringOnly ? ', with a document expired or due within 90 days' : ''}.`
        + ' Each document: its expiry, how soon, and whether HR filed a number — the number itself is never shown on this page.';
    };
    fleetSel.onchange = () => { fleetPick = fleetSel.value; paint(); };
    expBtn.onclick = () => { expiringOnly = !expiringOnly; expBtn.className = expiringOnly ? 'on' : '';
      expBtn.textContent = expiringOnly ? '✓ Anything expiring' : 'Anything expiring'; paint(); };
    offBtn.onclick = () => { showOff = !showOff; offBtn.className = showOff ? 'on' : '';
      offBtn.textContent = showOff ? '✓ Include off the list' : 'Include off the list'; paint(); };
    paint();

    /* The expiry picture for the people on the list, per document. */
    const exRows = DOCS.map(([k, label]) => ({ doc: label, ...(t.expiring[k] || {}) }));
    const exP = panel('Documents by how soon they expire', `The ${fmt(t.on_list)} people on the latest export`, 'hr-expiry');
    exP.body.append(tableFrom(exRows, [
      { label: 'Document', key: 'doc' },
      ...BUCKETS.map(([k, label]) => ({ label, key: k, num: true, render: (r) => fmt(r[k] ?? 0) })),
    ], { compact: true }));
    rosterP.body.append(exP.panel);

    histP.body.innerHTML = '';
    histP.body.append(tableFrom(v.uploads, [
      { label: 'Export date', key: 'export_date', render: (u) => `${esc(dateStr(u.export_date))}<span class="dim"> ${u.export_date_from === 'filename' ? 'from the filename' : 'entered'}</span>` },
      { label: 'Rows', key: 'rows_read', num: true, render: (u) => fmt(u.rows_read) },
      { label: 'Who', key: 'uploaded_by' },
      { label: 'Uploaded', key: 'uploaded_at', render: (u) => esc(dateStr(u.uploaded_at)) },
      { label: 'sha256', key: 'sha256', render: (u) => `<span class="mono" title="${esc(u.sha256)}">${esc(String(u.sha256).slice(0, 12))}…</span>` },
      { label: 'File', key: 'filename', render: (u) => esc(u.filename || '—') },
    ], { compact: true }));
    histP.body.append(el('p', 'cap', `${countOf(v.uploads.length, 'export')} on file. The same file twice is refused; an older export uploaded late is kept as history and does not change who is on the list.`));
  };
  await draw();
}
