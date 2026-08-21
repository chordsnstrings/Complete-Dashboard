#!/bin/sh
# Run the suite and print the real assertion count. Two commit messages in a
# row carried an estimated number that was wrong; a number in a commit message
# is a claim, and this makes it a measured one.
set -e
out=$(npm test 2>&1) || { echo "FAILING"; echo "$out" | grep -E '^  ✗' | head; exit 1; }
printf '%s assertions across %s files\n' \
  "$(printf '%s' "$out" | grep -cE '✓')" \
  "$(printf '%s' "$out" | grep -cE 'passed, [0-9]+ failed')"
