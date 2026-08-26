/* Live API probes — "what does this provider actually give us?"
   ──────────────────────────────────────────────────────────────────────────
   The collectors map a chosen subset of each provider's response into columns.
   When a question comes up that the mapped data cannot answer — "does Uber
   segregate business trips?" — the only honest way to settle it is to call the
   provider and look, rather than reason from what we happened to keep.

   Two rules make this safe to leave enabled:

   1. Every upstream call is from a fixed allowlist below. There is no
      pass-through of a caller-supplied URL, operation or body, so this cannot
      be turned into an open proxy onto the fleet's credentials.
   2. Responses are reduced to SHAPE before they are returned — field names,
      value cardinality, and sample values only for fields with few enough
      distinct values to be a dimension rather than personal data. Full records
      never leave this module.

   Nothing here writes. */

import { config } from '../src/config.js';
import { http, qs } from '../src/http.js';
import { uberOAuthToken, uberWebHeaders } from '../src/auth/uber.js';
import { probeEarnerWindow } from '../src/sources/uber.js';
import { loadSettings } from '../src/settings.js';
import { log } from '../src/log.js';

/* The org a probe asks about: the first with a full credential pair. The
   legacy fields carry Ecosine's values where they are set, but on a component
   that holds only one org's cookie the pair must come from ONE entry — the
   Ecosine uuid with the Egari cookie is a 401 wearing a confusing hat. */
const uberOrg = () => config.uber.orgs?.[0] || config.uber;

const REPORTS = 'https://supplier.uber.com/api/vs-sp-reports-management';

/* Report types worth testing for existence. Uber answers an unknown name with
   REPORT_TYPE_INVALID, so this enumerates the surface cheaply — the report is
   never downloaded, only asked for. */
const CANDIDATE_REPORTS = [
  'REPORT_TYPE_TRIP_ACTIVITY',
  'REPORT_TYPE_DRIVER_ACTIVITY',
  'REPORT_TYPE_PAYMENT_DETAILS',
  'REPORT_TYPE_PAYMENTS',
  'REPORT_TYPE_EARNINGS',
  'REPORT_TYPE_TRIP_DETAILS',
  'REPORT_TYPE_VEHICLE_ACTIVITY',
  'REPORT_TYPE_ORGANIZATION_TRIPS',
  'REPORT_TYPE_BUSINESS_TRIPS',
  'REPORT_TYPE_U4B_TRIPS',
  'REPORT_TYPE_RIDER_ACTIVITY',
  'REPORT_TYPE_INVOICE',
  'REPORT_TYPE_TAX',
  'REPORT_TYPE_FLEET_PERFORMANCE',
];

/* Reduce any JSON to a description of its shape. Values are only echoed for
   fields with few distinct values — a product tier is a dimension worth seeing,
   an address is not. */
function describe(records, { maxValues = 12 } = {}) {
  const rows = Array.isArray(records) ? records : [records];
  const fields = new Map();
  const walk = (obj, prefix = '') => {
    if (obj == null || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) { walk(v, path); continue; }
      const f = fields.get(path) || { key: path, present: 0, filled: 0, values: new Set(), type: null };
      f.present++;
      if (v !== null && v !== '' && !(Array.isArray(v) && !v.length)) f.filled++;
      f.type = f.type || (Array.isArray(v) ? 'array' : typeof v);
      if (f.values.size <= maxValues + 1 && !Array.isArray(v)) f.values.add(String(v).slice(0, 48));
      fields.set(path, f);
    }
  };
  rows.slice(0, 200).forEach((r) => walk(r));
  return [...fields.values()].map((f) => ({
    key: f.key, type: f.type,
    fill_pct: f.present ? Math.round((f.filled / f.present) * 100) : 0,
    distinct_seen: f.values.size,
    // A field with a handful of values is a dimension; anything wider is
    // free text or an identifier and its contents are not reported.
    values: f.values.size <= maxValues ? [...f.values] : null,
  })).sort((a, b) => b.fill_pct - a.fill_pct || a.key.localeCompare(b.key));
}

export function probeRoutes(app, { wrap }) {
  /* Which report types this org can actually generate. */
  app.get('/api/probe/uber/report-types', wrap(async (req, res) => {
    await loadSettings();
    if (!uberOrg().orgUuid) return res.status(400).json({ error: 'no Uber org configured' });
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const from = req.query.from || new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
    const out = [];
    for (const reportType of CANDIDATE_REPORTS) {
      try {
        const { data } = await http(`${REPORTS}/GenerateReport?localeCode=en-GB`, {
          method: 'POST', timeoutMs: 30000, retries: 0, headers: uberWebHeaders(uberOrg()),
          body: JSON.stringify({
            orgId: { uuid: { value: uberOrg().orgUuid } }, reportType,
            startDate: { value: from }, endDate: { value: to },
            childOrgUuids: [{ uuid: { value: uberOrg().orgUuid } }],
          }),
        });
        const ok = data?.status === 'success';
        out.push({ reportType, valid: ok,
          detail: ok ? 'accepted' : String(JSON.stringify(data?.data?.meta?.details || data?.data || data)).slice(0, 160) });
      } catch (e) { out.push({ reportType, valid: false, detail: String(e).slice(0, 160) }); }
    }
    res.json({ window: [from, to], types: out });
  }));

  /* The shape of one generated report's CSV header — column names only. */
  app.get('/api/probe/uber/report-columns', wrap(async (req, res) => {
    await loadSettings();
    const reportType = CANDIDATE_REPORTS.includes(req.query.type) ? req.query.type : 'REPORT_TYPE_TRIP_ACTIVITY';
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const from = req.query.from || new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
    const { data: gen } = await http(`${REPORTS}/GenerateReport?localeCode=en-GB`, {
      method: 'POST', timeoutMs: 30000, headers: uberWebHeaders(uberOrg()),
      body: JSON.stringify({
        orgId: { uuid: { value: uberOrg().orgUuid } }, reportType,
        startDate: { value: from }, endDate: { value: to },
        childOrgUuids: [{ uuid: { value: uberOrg().orgUuid } }],
      }),
    });
    if (gen?.status !== 'success') {
      return res.json({ reportType, error: String(JSON.stringify(gen?.data?.meta?.details || gen)).slice(0, 300) });
    }
    const id = gen.data.reportId.uuid.value;
    let url = null;
    for (let i = 0; i < 30 && !url; i++) {
      const { data } = await http(`${REPORTS}/DownloadReport?localeCode=en-GB`, {
        method: 'POST', timeoutMs: 30000, headers: uberWebHeaders(uberOrg()),
        body: JSON.stringify({ orgId: { uuid: { value: uberOrg().orgUuid } }, reportId: { uuid: { value: id } } }),
      });
      url = data?.data?.signedUrl?.value;
      if (!url) await new Promise((r2) => setTimeout(r2, 5000));
    }
    if (!url) return res.json({ reportType, error: 'report did not finish generating within 150s' });
    const { data: csv } = await http(url, { expect: 'text', timeoutMs: 120000 });
    const lines = String(csv).split(/\r?\n/).filter(Boolean);
    const header = (lines[0] || '').split(',').map((h) => h.replace(/^"|"$/g, ''));
    // Cardinality per column, so a low-cardinality column (a dimension) is
    // distinguishable from an identifier without echoing the rows.
    const cells = lines.slice(1, 400).map((l) => l.split(','));
    res.json({
      reportType, window: [from, to], rows_sampled: cells.length,
      columns: header.map((h, i) => {
        const vals = new Set(cells.map((c) => (c[i] || '').replace(/^"|"$/g, '')).filter(Boolean));
        return { column: h, distinct_seen: vals.size, values: vals.size <= 12 ? [...vals] : null };
      }),
    });
  }));

  /* Shape of the OAuth REST surfaces the trip report does not cover. */
  const REST = {
    /* Which organisations this credential can actually reach, and what Uber
       calls each of them.
       ─────────────────────────────────────────────────────────────────────
       Every other surface here needs an org_id and answers 403 "bad key" for a
       wrong one, which is a question you cannot answer with the thing you are
       trying to find. This one takes no org at all — the OAuth scope list
       already asks for vehicle_suppliers.organizations.read — so it is the one
       endpoint that can say what the right value IS.
       
       Egari's REST org id has been refused on every call for as long as there
       are logs, while its GraphQL surface works: the two want different
       identifiers, and the uuid that satisfies GraphQL is not what REST calls
       an org. Confirmed by setting it and watching the 403 persist. An org
       list has two rows, so describe() reports the ids rather than suppressing
       them as free text, which is exactly what makes this answerable. */
    organizations: () => 'https://api.uber.com/v1/vehicle-suppliers/organizations',
    'driver-actions': (org) => `https://api.uber.com/v1/vehicle-suppliers/drivers/actions?org_id=${encodeURIComponent(org)}`,
    transactions: (org) => `https://api.uber.com/v1/vehicle-suppliers/transactions?org_id=${encodeURIComponent(org)}&limit=50`,
    'earner-payments': (org) => `https://api.uber.com/v1/vehicle-suppliers/earners/payments?org_id=${encodeURIComponent(org)}&limit=50`,
    vehicles: (org) => `https://api.uber.com/v1/vehicle-suppliers/vehicles?org_id=${encodeURIComponent(org)}&limit=50`,
    drivers: (org) => `https://api.uber.com/v1/vehicle-suppliers/drivers?org_id=${encodeURIComponent(org)}&limit=50`,
  };

  app.get('/api/probe/uber/rest', wrap(async (req, res) => {
    await loadSettings();
    const only = req.query.endpoint;
    const names = only && REST[only] ? [only] : Object.keys(REST);
    const token = await uberOAuthToken();
    const out = [];
    for (const name of names) {
      try {
        const { data, status } = await http(REST[name](config.uber.org), {
          timeoutMs: 30000, retries: 0, headers: { authorization: `Bearer ${token}` },
        });
        // Find the first array of objects in the response — providers wrap
        // their lists under varying keys.
        const arr = Array.isArray(data) ? data
          : Object.values(data || {}).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object');
        out.push({ endpoint: name, status: status || 200,
          count: Array.isArray(arr) ? arr.length : 0,
          top_level_keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 20) : [],
          fields: arr ? describe(arr) : describe(data || {}) });
      } catch (e) {
        out.push({ endpoint: name, error: String(e).slice(0, 220) });
      }
    }
    res.json({ endpoints: out });
  }));

  /* ── is a gap in our history recoverable, or is it gone? ──────────────────
     Uber earnings are absent for every month before about March 2026 — 20,016
     bookings in September 2025 with no payout row against any of them. The
     backfill DID ask for those windows: 65 chunks, none failed. They came back
     empty.

     That leaves two possibilities with opposite consequences. Either the
     provider no longer serves data that old, in which case the half-year is
     gone and the product must say so instead of showing a blank; or we asked
     wrongly, in which case re-collecting recovers it. Guessing between them
     decides whether to spend a day on a backfill or on an explanation, and the
     only honest way to settle it is to ask the provider for a window we know
     we are missing and see what comes back.

     Read-only, on the same allowlisted surface the daily probe already calls —
     only the window is a parameter, and it is parsed as a date rather than
     passed through. Counts and field names only; no records leave here. */
  app.get('/api/probe/uber/window', wrap(async (req, res) => {
    await loadSettings();
    const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    if (!isDay(req.query.from) || !isDay(req.query.to)) {
      return res.status(400).json({ error: 'from and to are required, as YYYY-MM-DD' });
    }
    const from = new Date(`${req.query.from}T00:00:00Z`).getTime();
    const to = new Date(`${req.query.to}T23:59:59Z`).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return res.status(400).json({ error: 'window is not a range' });
    }
    const org = config.uber.org;
    if (!org) return res.status(400).json({ error: 'no Uber org configured' });

    /* Both money surfaces, because they fail differently: earner-payments is
       what driver_performance is built from, transactions is the ledger beside
       it, and a window that one serves and the other does not is itself the
       answer to a different question. */
    const windowed = {
      'earner-payments': `https://api.uber.com/v1/vehicle-suppliers/earners/payments?${qs({
        org_id: org, start_time: from, end_time: to, page_size: 50 })}`,
      transactions: `https://api.uber.com/v1/vehicle-suppliers/transactions?${qs({
        org_id: org, start_time: from, end_time: to, limit: 50 })}`,
    };
    /* The surface that actually feeds driver_performance. The two REST
       endpoints below are the ones the daily probe already watches, and it
       turns out neither is the source: earner-payments returns an empty list
       even for a month we hold AED 140,379 of earnings for, and transactions
       404s outright. Probing only those would have said "the provider serves
       nothing" about a window that is demonstrably served. */
    /* `to` is inclusive to whoever typed it and exclusive to Uber, so the day
       asked about has to be pushed past. Without this a probe for a single day
       asks for a zero-length range and reports "the provider serves nothing"
       about a day it serves — the same off-by-one that was quietly costing the
       collector one day in seven. */
    const until = new Date(to); until.setUTCDate(until.getUTCDate() + 1);
    const graph = await probeEarnerWindow(new Date(from), until)
      .catch((e) => ({ err: String(e).slice(0, 200) }));

    const token = await uberOAuthToken();
    const out = [];
    for (const [name, url] of Object.entries(windowed)) {
      try {
        const { data, status } = await http(url, {
          timeoutMs: 45000, retries: 0, headers: { authorization: `Bearer ${token}` } });
        const arr = Array.isArray(data) ? data
          : Object.values(data || {}).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object');
        out.push({ surface: name, status: status || 200,
          count: Array.isArray(arr) ? arr.length : 0,
          /* An empty list and a refusal look identical in a row count, and they
             mean opposite things: one says the data is gone, the other says we
             asked wrongly. */
          top_level_keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 20) : [],
          message: data?.message || data?.error || null,
          fields: arr ? describe(arr) : [] });
      } catch (e) { out.push({ surface: name, error: String(e).slice(0, 220) }); }
    }
    res.json({
      window: [req.query.from, req.query.to],
      // The one that answers the question; the REST pair is context.
      earner_breakdowns: graph,
      surfaces: out,
    });
  }));

  /* Is the FMS history actually gone, or did we ask for it wrongly?
     ─────────────────────────────────────────────────────────────────────────
     The record says six consecutive monthly windows covering August 2025 to
     February 2026 were asked and answered ok with zero rows, while every
     window after them returned thousands. That is the provider's answer as far
     as our collector can tell — but "returned an empty list" and "returned an
     empty list because the request was subtly wrong" are indistinguishable in
     a row count, and the difference decides whether five months of telematics
     are recoverable or gone.

     So this asks FMS the same question the collector asks, for a window the
     caller names, and reports the SHAPE of what comes back: the HTTP status,
     the top-level keys, how many records, and the field names of the first one.
     Same operation, same parameters, same credentials as the collector — a
     different answer here would mean the collector is at fault, and an
     identical empty one means the data is not there.

     Read-only: GetTripPassenger is a report endpoint, the operation name is
     fixed here rather than taken from the caller, and only the shape is
     returned. */
  app.get('/api/probe/fms/window', wrap(async (req, res) => {
    await loadSettings();
    const from = String(req.query.from || '').slice(0, 10);
    const to = String(req.query.to || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'from and to are required as YYYY-MM-DD' });
    }
    const dot = (d) => d.replace(/-/g, '.');
    const out = [];
    for (const f of (config.fms.fleets || [])) {
      if (!f.username || !f.password) { out.push({ fleet: f.fleet, skipped: 'no credential' }); continue; }
      try {
        const url = `${config.fms.base}/GetTripPassenger?${qs({
          username: f.username, Password: f.password, vehicleno: 'ALL',
          fromdate: dot(from), todate: dot(to),
        })}`;
        const { status, data } = await http(url, { timeoutMs: 120000, retries: 0 });
        const arr = Array.isArray(data?.Data) ? data.Data : null;
        out.push({
          fleet: f.fleet,
          http: status,
          top_level_keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 20) : [],
          message: data?.Message || data?.message || data?.error || null,
          records: arr ? arr.length : null,
          /* Field NAMES only. A telematics row carries positions and a plate,
             which is the fleet's own data and does not need to leave here to
             answer whether the window is empty. */
          fields: arr && arr.length ? Object.keys(arr[0]).slice(0, 40) : [],
          first_start: arr && arr.length ? String(arr[0]['Start Time'] || '').slice(0, 19) : null,
        });
      } catch (e) { out.push({ fleet: f.fleet, error: String(e).slice(0, 220) }); }
    }
    res.json({ window: [from, to], operation: 'GetTripPassenger', fleets: out });
  }));

  log.info('api', 'probe routes mounted (read-only, allowlisted)');
}
