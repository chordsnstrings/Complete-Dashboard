#!/bin/sh
# A backtick inside a SQL comment inside a template literal ends the literal
# early. It has cost four separate debugging sessions on this codebase, and it
# always looks like valid SQL. Run this before every commit.
fail=0
for f in $(find src api -name '*.js' -not -path '*/node_modules/*'); do
  node --check "$f" || { echo "  ✗ $f"; fail=1; }
done
[ $fail -eq 0 ] && echo "all files parse"
exit $fail
