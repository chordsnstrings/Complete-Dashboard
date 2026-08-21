/* Normalising what four providers each call "state".
   ──────────────────────────────────────────────────────────────────────────
   Uber says ONBOARDING_STATUS_WAITLIST, Bolt says suspended, Yango says
   deactivated, the corporate channel says inactive. They are not synonyms and
   they must not be flattened into a boolean, because the difference between
   "has not started yet" and "has been stopped" is the whole finding.

   Two things come out of this: a normalised state for grouping, and `can_earn`
   — whether the state permits taking work at all. A driver who cannot earn and
   has no trips is not idle. A driver who CAN earn and has no trips is, and that
   is a car and a licence sitting still. */

export const STATES = {
  active: { label: 'Active', can_earn: true, tone: 'good' },
  waitlist: { label: 'On the waitlist', can_earn: false, tone: 'warn' },
  onboarding: { label: 'Onboarding', can_earn: false, tone: 'warn' },
  suspended: { label: 'Suspended', can_earn: false, tone: 'critical' },
  deactivated: { label: 'Deactivated', can_earn: false, tone: 'critical' },
  inactive: { label: 'Inactive', can_earn: false, tone: 'serious' },
  unknown: { label: 'Not reported', can_earn: null, tone: null },
};

/* The provider's own word, mapped. An unrecognised word becomes `unknown` and
   keeps its original text rather than being guessed into a bucket — a wrong
   bucket here would describe somebody's employment incorrectly. */
export function normaliseState(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
    .replace(/^onboarding_status_/, '').replace(/^driver_status_/, '').replace(/[\s-]+/g, '_');
  if (!s) return 'unknown';
  if (['active', 'online', 'available', 'approved', 'enabled', 'on_trip', 'offline'].includes(s)) return 'active';
  if (['waitlist', 'waiting', 'waitlisted', 'queued'].includes(s)) return 'waitlist';
  if (['onboarding', 'pending', 'in_progress', 'incomplete', 'document_pending', 'review'].includes(s)) return 'onboarding';
  if (['suspended', 'blocked', 'banned', 'restricted'].includes(s)) return 'suspended';
  if (['deactivated', 'deleted', 'removed', 'terminated', 'churned'].includes(s)) return 'deactivated';
  if (['inactive', 'disabled', 'dormant', 'paused'].includes(s)) return 'inactive';
  return 'unknown';
}

export const canEarn = (state) => STATES[state]?.can_earn ?? null;

/* Provider payloads carry HTML in their reason fields — Uber's suspension text
   arrives as a styled <p> block. A reason is a sentence for a human, not markup
   to render, and this page must never be a place where a provider's HTML
   executes. */
export function cleanReason(v) {
  if (v == null) return null;
  const text = String(v).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 400) : null;
}

export function stateRow({ platform, driverExtId, fleetId, name, rawState, reason,
  vehicleExtId, plate, score, raw }) {
  const state = normaliseState(rawState);
  return {
    platform, driver_ext_id: String(driverExtId), fleet_id: fleetId || null,
    full_name: name ? String(name).trim() || null : null,
    state, state_raw: rawState == null ? null : String(rawState).slice(0, 80),
    state_reason: cleanReason(reason),
    vehicle_ext_id: vehicleExtId || null, plate: plate || null,
    score: Number.isFinite(Number(score)) ? Number(score) : null,
    can_earn: canEarn(state),
    observed_at: new Date().toISOString(),
    raw: raw ? JSON.stringify(raw).slice(0, 20000) : null,
  };
}
