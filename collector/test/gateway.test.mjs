/* ── what a page does when the server takes too long ───────────────────────
   The Data sources page rendered this, verbatim, where a sentence belonged:

     504 <!DOCTYPE html> <html> <head> <meta name="viewport" content="width=…

   Two failures in one screenshot. The reader was shown the platform gateway's
   HTML error page, which tells them nothing and cannot be distinguished from a
   broken view; and the request was abandoned even though our own server was
   still computing the answer and about to cache it — a second request a moment
   later would have been served from memory.

   These tests pin both halves. They run api() against a stub server rather
   than a browser, because the behaviour is in the fetch wrapper, and a browser
   test would need a server that is deliberately slow — which is the one thing
   a test suite must not be. */
import express from 'express';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* data.js is a browser module: it reaches for localStorage and window at
   import time through swr.js, and builds relative URLs. Give it the globals it
   expects and an absolute base. */
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};
global.window = { addEventListener() {}, dispatchEvent() {}, location: { hash: '' } };

const app = express();
let attempts = 0;
// Fails the first time with a gateway timeout and an HTML body, exactly as the
// platform does; succeeds on the retry, as our own server does once its query
// lands in the response cache.
app.get('/api/slow-once', (_q, r) => {
  attempts++;
  if (attempts === 1) {
    return r.status(504).type('html').send(
      '<!DOCTYPE html>\n<html>\n<head>\n<meta name="viewport" content="width=device-width, initial-scale=1">');
  }
  return r.json({ ok: true, attempts });
});
app.get('/api/always-504', (_q, r) => r.status(504).type('html').send('<!DOCTYPE html><html><head>'));
app.get('/api/refused', (_q, r) => r.status(400).json({ error: 'bad window', detail: 'to before from' }));
app.get('/api/broken', (_q, r) => r.status(500).type('text').send('kaboom'));
let posts = 0;
app.post('/api/trigger', (_q, r) => { posts++; r.status(504).type('html').send('<!DOCTYPE html>'); });

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const realFetch = global.fetch;
// data.js builds same-origin paths; give them a host.
global.fetch = (p, o) => realFetch(p.startsWith('http') ? p : `${base}${p}`, o);

const { api } = await import('../api/public/data.js');

console.log('\na gateway timeout is retried once');

const body = await api('/api/slow-once');
check('the retry gets the answer the first attempt was computing',
  body?.ok === true && body.attempts === 2, JSON.stringify(body));
check('and it really was two requests, not one', attempts === 2, String(attempts));

console.log('\nand when it fails anyway, it says something a person can act on');

let msg = '';
try { await api('/api/always-504'); } catch (e) { msg = e.message; }
check('no HTML reaches the reader', !/<!doctype|<html|viewport/i.test(msg), msg.slice(0, 80));
check('the message names the cause and what to do',
  /took too long/.test(msg) && /try again/.test(msg), msg);
check('and still carries the status', msg.startsWith('504'), msg.slice(0, 20));

let refused = '';
try { await api('/api/refused'); } catch (e) { refused = e.message; }
check('a refusal keeps its own explanation rather than being flattened',
  /bad window/.test(refused) && /to before from/.test(refused), refused);

let broken = '';
try { await api('/api/broken'); } catch (e) { broken = e.message; }
check('a plain-text failure is passed through as-is', /kaboom/.test(broken), broken);

console.log('\nbut a write is never repeated');

let postErr = '';
try {
  await api('/api/trigger', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
} catch (e) { postErr = e.message; }
/* One collection trigger must never become two because a gateway was slow —
   the write may well have landed before the timeout. */
check('a POST that times out is not sent twice', posts === 1, String(posts));
check('and the caller is told', /504/.test(postErr), postErr.slice(0, 60));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
