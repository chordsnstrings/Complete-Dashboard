-- v90 — the Yango cookie row the old reading painted green (2026-09-29).
-- Until 2026-09-29 the collector wrote YANGO_COOKIE 'ok' whenever the console
-- answered 403 with the cookie and 401 without it — Yandex's edge and Yango's
-- API, two different machines (docs/COVERAGE.md trap 32). The code that did
-- that is gone (deployment 068e0fc2, live before 11:31Z that day), but the row
-- it wrote stays until the next console attempt — and even then its
-- last_ok_at would keep the unearned time for ever, because a failure never
-- clears last_ok_at (src/auth_state.js).
--
-- So a YANGO_COOKIE 'ok' written before the new code went live, while the
-- console itself is not 'ok', is re-filed as what it is: not checked. Only
-- such rows: a cookie proven by a real answer (the console ok too) and any row
-- written after 11:15Z by the new code are untouched, and once corrected the
-- row is no longer 'ok', so replaying this is a no-op.
UPDATE credential_state c
   SET state = 'unknown',
       last_ok_at = NULL,
       detail = 'not checked — the earlier "ok" came from reading 403-with and 401-without as a working '
             || 'session, which it is not; nothing has read this session since. The console is asked once a day.'
 WHERE c.provider = 'yango' AND c.credential = 'YANGO_COOKIE' AND c.state = 'ok'
   AND c.checked_at < timestamptz '2026-09-29 11:15:00+00'
   AND EXISTS (SELECT 1 FROM credential_state k
                WHERE k.provider = 'yango' AND k.credential = 'YANGO_CONSOLE' AND k.state <> 'ok');
