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
  /* An application the provider turned down. Not "onboarding" — nothing is in
     progress — and not "deactivated", which is somebody who was working and
     was stopped. Uber sends ONBOARDING_STATUS_REJECTED for five people and
     they were being filed as `unknown`, which reports a gap in our knowledge
     where the provider gave a clear answer. */
  rejected: { label: 'Application rejected', can_earn: false, tone: 'critical' },
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
  /* Prefix, not equality. Uber qualifies the word:
     ONBOARDING_STATUS_WAITLISTED_AUTO_REACTIVATION normalises to
     "waitlisted_auto_reactivation", which is not in any list, so eighteen
     people on the live roster were filed as `unknown` — reported by
     /api/roster/states as an unrecognised word, and by the roster itself as
     "standing not reported" for somebody the provider had described plainly. */
  if (/^waitlist/.test(s) || ['waiting', 'queued'].includes(s)) return 'waitlist';
  /* applied and accepted are both "has not started yet": the application is
     in, the provider has not turned them loose. One person each on the live
     roster, both unclassified. */
  if (['onboarding', 'pending', 'in_progress', 'incomplete', 'document_pending', 'review',
    'applied', 'accepted'].includes(s)) return 'onboarding';
  if (/^rejected/.test(s) || ['declined', 'denied'].includes(s)) return 'rejected';
  if (['suspended', 'blocked', 'banned', 'restricted'].includes(s)) return 'suspended';
  /* Yango's own vocabulary, which none of the lists above reached.
     ─────────────────────────────────────────────────────────────────────────
     driver-profiles/list files work_status as `working`, `not_working` or
     `fired` — measured on production 2026-09-07 — and this function returned
     'unknown' for all three, so every one of the 145 Yango drivers would have
     landed with no standing and can_earn NULL: the roster page's "standing not
     reported" for people the provider had described plainly, which is the
     exact defect the waitlist prefix above was added for.

     `fired` is deactivated and not suspended: a suspension is a state somebody
     can come back from and STATES draws it differently. `not_working` is the
     park saying this person is on the books and not driving, which is
     'inactive' — not 'offline', which is an availability word this fold
     already reads as active because a driver between shifts is still earning
     for the fleet. */
  if (['fired', 'deactivated', 'deleted', 'removed', 'terminated', 'churned'].includes(s)) return 'deactivated';
  if (['not_working', 'inactive', 'disabled', 'dormant', 'paused'].includes(s)) return 'inactive';
  if (s === 'working') return 'active';
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

/* A provider record, small enough to store, and always VALID JSON.
   ─────────────────────────────────────────────────────────────────────────
   This was JSON.stringify(raw).slice(0, 20000), which is a truncated string
   the moment a record is bigger than the cap — and every one of these columns
   is JSONB, so Postgres answers `invalid input syntax for type json` and the
   whole upsert batch rolls back. One oversized record would have cost the
   roster of every driver in the same page, and the run would have reported it
   as a refused surface rather than as a row nobody could store.

   The cap stays — a provider record is evidence, not an archive — but what is
   stored past it is a small object that SAYS the record was too big and how
   big, which is a fact a later reader can act on. Never a fragment. */
export function rawJson(raw, cap = 20000) {
  if (raw == null) return null;
  let text;
  try { text = JSON.stringify(raw); } catch { return JSON.stringify({ _unstorable: 'not serialisable' }); }
  if (text == null) return null;
  if (text.length <= cap) return text;
  return JSON.stringify({
    _truncated: true, _bytes: text.length, _cap: cap,
    _why: 'the provider record was larger than the cap this column stores, so it is summarised '
      + 'rather than cut: a sliced JSON string is not JSON and the insert would have failed',
    /* The top-level keys, which is usually all a later reader wants from a raw
       column — enough to know what the provider sent without keeping it. */
    _keys: (raw && typeof raw === 'object' && !Array.isArray(raw)) ? Object.keys(raw).slice(0, 40) : undefined,
  });
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
    raw: rawJson(raw),
  };
}
