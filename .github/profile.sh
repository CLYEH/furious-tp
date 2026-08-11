#!/bin/sh
# Profile decision (development-loop §8): reads the changed-file list on
# stdin, prints "true" iff the diff is docs-only — non-empty AND every file
# is *.md or lives under docs/. An empty diff is NOT a docs PR: false.
# Installed at .github/profile.sh by instantiation; ci.yml pipes into it.
changed="$(cat)"
if [ -n "$changed" ] && ! printf '%s\n' "$changed" | grep -qvE '(^docs/|\.md$)'; then
  echo true
else
  echo false
fi

# FTP-62 probe: temporary no-op comment to measure CODEOWNERS review requirement. Do not merge.
