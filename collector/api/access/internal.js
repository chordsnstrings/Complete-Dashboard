/* The token the API's own warmer and stale-refresh present when they fetch
   their own endpoints over loopback. Random per process and never written
   anywhere: it exists only in this process's memory, and the gate also
   requires the request to come from the loopback address.

   It replaced `x-warm: 1`, which any caller could send. Under sign-in those
   loopback fetches carry no session, so they needed an identity of their own —
   one nobody outside the process can present. */
import { randomBytes } from 'node:crypto';

export const INTERNAL_TOKEN = randomBytes(32).toString('base64url');
export const internalHeaders = () => ({ 'x-fm-internal': INTERNAL_TOKEN });
