/* Who did this — the signed-in person, when there is one.
   ─────────────────────────────────────────────────────────────────────────
   Before sign-in existed, money and identity writes were ATTRIBUTED: the form
   named one of four supervisors, or took a free-text `by`, and the name, an
   address and a timestamp were what made an entry traceable. Signed in, the
   person recording is the person whose session made the request — whatever
   the form sends (ULM-DESIGN §5.3). The typed name is still honoured for a
   visitor while signing in is optional, exactly as before. */
export const signedInActor = (req) => (req?.fm?.kind === 'user' && req.fm.user?.email
  ? String(req.fm.user.email).toLowerCase() : null);
