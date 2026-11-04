/* "Wallets to confirm" — PowerDrive's review queue, ONE drawing for the two
   pages that show it.
   ─────────────────────────────────────────────────────────────────────────
   src/sources/yocharge.js links a PowerDrive customer (a charging wallet) to
   one of our drivers by itself only when the link is certain; every other
   possible match is a 'candidate' (or 'held': a fold's contradictory
   decisions, sql/schema_v114.sql) that a person confirms or refuses through
   POST /api/charging/link. Until 2026-11-04 that queue was a panel on the
   Charging page only. The operator, that day: "yes add it to the same person
   page too". On production it held 124 suggestions (101 PowerDrive accounts,
   91 drivers), and 48 of them existed because one driver has two records on
   our side — the very question the Same person page decides — so the people
   who answer one queue now find the other beside it.

   WHY A MODULE AND NOT A COPY. Two pages drawing one queue from two copies of
   this code drift the first time one of them is fixed — a fold added on one
   page, a reason worded differently, a decision posted with a different body
   — and the person deciding would be answering one question two ways. So the
   read, the drawing, the fold and the POST live here once, moved out of
   charging.js unchanged (its tests and the old skin's frozen rendering of
   #charging prove the move changed nothing), and each page says only where to
   draw it and what to read again after a decision: the Charging page its
   wallets and cars as well (a confirmation lists its wallet at once and takes
   its charges off their cars until the next run works them out again), the
   Same person page the queue alone (a PowerDrive link changes no same-person
   pair).

   NOT ON THE FIRST SCREEN, NOR THE PHONE'S. Only the two page modules import
   this, so it is fetched when one of them opens (test/lazy_pages.test.mjs),
   it is not on the phone's static import path that sw.js precaches
   (test/tokens.test.mjs §8), and nothing in it runs at load. */
import { el, esc, note } from './ui.js';
import { fmt } from './charts.js';
import { qAll } from './data.js';
import { post } from './access.js';

/** The queue's one read, as both pages ask for it. A failure comes back as
    { _err } for drawReview to say in words — never a rejection that leaves
    the panel on its skeleton. The route takes no window (it is a queue, not a
    span), and answers `no-store`, so nothing serves it from a cache. */
export const readReview = () => qAll('/api/charging/review').catch((e) => ({ _err: e }));

/** Draw the queue `w` (GET /api/charging/review, or { _err }) into `host`.
    `again` is awaited after a decision is saved: it must read the queue again
    and call this once more, with whatever else the page wants redrawn. */
export function drawReview(host, w, again) {
  host.innerHTML = '';
  if (w?._err) { host.append(note(`The queue could not be read: ${w._err.message}`, 'bad')); return; }
  if (!w || w.why || !Array.isArray(w.review)) { host.append(el('p', 'cap', esc(w?.why || 'Nothing to confirm until PowerDrive has been read.'))); return; }
  if (!w.review.length && !w.unplaced.length) { host.append(el('p', 'cap', 'Nothing waiting: every PowerDrive customer we can see is linked, refused, or not one of ours.')); return; }
  if (w.review.length) {
    const ul = el('ul', 'bul pd-review');
    for (const r of w.review) {
      const li = el('li');
      li.innerHTML = `${r.tier === 'held' ? '<b>Held</b> — ' : ''}PowerDrive's <b>${esc(r.yc_name || 'unnamed customer')}</b>${r.yc_phone ? ` (${esc(r.yc_phone)})` : ''}`
        + `${r.yc_fleet_group ? ` in ${esc(r.yc_fleet_group)}` : ''} — is it our <b>${esc(r.our_name || `person ${r.person_id}`)}</b>? `
        + `<span class="dim">${esc(r.reason)}.</span> `;
      const yes = el('button', 'btn sm', 'Same person');
      const no = el('button', 'btn sm ghost', 'Not this person');
      const msg = el('span', 'cap');
      const decide = async (decision) => {
        yes.disabled = true; no.disabled = true; msg.textContent = ' Saving…';
        try { await post('/api/charging/link', { yc_user_id: r.yc_user_id, person_id: Number(r.person_id), decision }); await again(); }
        catch (e) { msg.textContent = ` ${e.message}`; yes.disabled = false; no.disabled = false; }
      };
      yes.addEventListener('click', () => decide('confirm'));
      no.addEventListener('click', () => decide('refuse'));
      li.append(yes, ' ', no, msg);
      ul.append(li);
    }
    host.append(ul);
    /* The first ten, then the rest on request: the first production read
       queued 124 suggestions, one long scroll of buttons. Held pairs sort
       first, so a fold never hides one. */
    const SHOWN = 10;
    const items = [...ul.children];
    if (items.length > SHOWN) {
      const more = el('button', 'foldbtn');
      let open = false;
      const draw = () => {
        items.forEach((li, i) => { li.hidden = !open && i >= SHOWN; });
        more.textContent = open ? `Show fewer — the first ${fmt(SHOWN)}` : `Show the other ${fmt(items.length - SHOWN)} suggestions →`;
      };
      more.addEventListener('click', () => { open = !open; draw(); });
      draw();
      host.append(more);
    }
  }
  if (w.unplaced.length) {
    const d = el('details', 'pd-unplaced');
    const n = w.unplaced.length;
    d.innerHTML = `<summary class="cap">${esc(`${fmt(n)} PowerDrive ${n === 1 ? 'customer' : 'customers'} in our fleet groups `
      + `${n === 1 ? 'matches' : 'match'} none of our drivers by mobile, email or name — a driver who has left, or one registered `
      + 'with a number we do not hold')}</summary>`
      + `<p class="cap">${w.unplaced.map((u) => `${esc(u.yc_name || 'unnamed')} <span class="dim">${esc(u.yc_phone || '')}`
        + `${u.yc_fleet_group ? ` · ${esc(u.yc_fleet_group)}` : ''}${u.stranded ? ' · a decision about them named a person record since removed' : ''}</span>`).join(' · ')}</p>`;
    host.append(d);
  }
  host.append(el('p', 'cap', 'Confirming says the PowerDrive customer IS that driver; it needs a signed-in Owner, Management or HR '
    + 'officer — whoever decides same-person pairs. Refusing keeps the pair from being offered again. A run never changes either.'));
}
