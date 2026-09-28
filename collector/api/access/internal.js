/* The token the API's own warmer and stale-refresh present when they fetch
   their own endpoints over loopback. Random per process and never written
   anywhere: it exists only in this process's memory, and the gate also
   requires the request to come from the loopback address.

   It replaced `x-warm: 1`, which any caller could send. Under sign-in those
   loopback fetches carry no session, so they needed an identity of their own —
   one nobody outside the process can present. */
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const INTERNAL_TOKEN = randomBytes(32).toString('base64url');
export const internalHeaders = () => ({ 'x-fm-internal': INTERNAL_TOKEN });

const loopback = (req) => {
  const a = String(req.socket?.remoteAddress || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};
/* Is this request the process fetching itself? Both conditions: the token
   only this process knows, AND the loopback address. The access layer's
   identify() asks this; so does the response cache when it is mounted without
   the access layer in front of it (its own tests) — one rule, one place. */
export function isInternal(req) {
  const got = Buffer.from(String(req.get?.('x-fm-internal') || ''));
  const want = Buffer.from(INTERNAL_TOKEN);
  return loopback(req) && got.length === want.length && timingSafeEqual(got, want);
}
