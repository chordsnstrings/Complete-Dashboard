-- v89 — the Yango console surface the probe no longer asks (2026-09-29).
-- The nightly probe asked the park ledger at fleet.yango.com
-- /api/v1/reports/transactions/park/list with the session cookie. The
-- collector has read the ledger from fleet-api.yango.tech
-- /v2/parks/transactions/list since 2026-09-16, and the probe now asks that
-- path under the surface name 'transactions/list'. The old row would
-- otherwise sit on the Data sources page for ever, dated the night it was
-- last refused at Yandex's edge, describing a surface nothing reads.
-- Idempotent: once the row is gone this deletes nothing.
DELETE FROM provider_probe
 WHERE provider = 'yango' AND surface = 'transactions/park/list';
