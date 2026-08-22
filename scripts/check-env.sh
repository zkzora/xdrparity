#!/usr/bin/env bash
# XDRParity toolchain check (Fase 0).
# Verifies the tools the harness and all four SDK runners need:
#   node >= 20, python >= 3.11, java >= 17, go >= 1.22,
#   and a working `stellar xdr decode` (the neutral XDR decoder).
# Prints each version; exits nonzero if anything is missing or too old.
#
# Java is resolved via JAVA_HOME when set (some machines pin an old JRE
# early in the system PATH; JAVA_HOME is what Gradle and the harness use).

set -u
STATUS=0

pass() { printf 'PASS  %-8s %s\n' "$1" "$2"; }
fail() { printf 'FAIL  %-8s %s\n' "$1" "$2"; STATUS=1; }

# ver_ge HAVE WANT — dotted-version compare, true when HAVE >= WANT
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

# --- node >= 20 ---
if command -v node >/dev/null 2>&1; then
  v="$(node --version 2>/dev/null | sed 's/^v//')"
  if ver_ge "$v" 20; then pass node "v$v"; else fail node "v$v (need >= 20)"; fi
else
  fail node "not found (need >= 20)"
fi

# --- python >= 3.11 ---
PY="" PYV=""
for c in python3 python; do
  command -v "$c" >/dev/null 2>&1 || continue
  v="$("$c" --version 2>/dev/null | awk '/^Python /{print $2}')"
  [ -n "$v" ] || continue
  PY="$c" PYV="$v"
  break
done
if [ -n "$PY" ]; then
  if ver_ge "$PYV" 3.11; then pass python "$PYV ($PY)"; else fail python "$PYV (need >= 3.11)"; fi
else
  fail python "not found (need >= 3.11)"
fi

# --- java >= 17 (JAVA_HOME preferred) ---
JAVA_BIN=""
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
  JAVA_BIN="$JAVA_HOME/bin/java"
elif command -v java >/dev/null 2>&1; then
  JAVA_BIN="java"
fi
if [ -n "$JAVA_BIN" ]; then
  v="$("$JAVA_BIN" -version 2>&1 | head -n1 | sed -n 's/.*version "\([0-9][0-9._]*\)".*/\1/p')"
  major="${v%%.*}"
  [ "$major" = "1" ] && major="$(printf '%s' "$v" | cut -d. -f2)"   # 1.8.x -> 8
  if [ -n "$major" ] && [ "$major" -ge 17 ]; then
    pass java "$v ($JAVA_BIN)"
  else
    fail java "${v:-unparseable} (need >= 17; set JAVA_HOME to a JDK 17+)"
  fi
else
  fail java "not found (need >= 17)"
fi

# --- go >= 1.22 ---
if command -v go >/dev/null 2>&1; then
  v="$(go version 2>/dev/null | sed -n 's/^go version go\([0-9.]*\).*/\1/p')"
  if [ -n "$v" ] && ver_ge "$v" 1.22; then pass go "$v"; else fail go "${v:-unparseable} (need >= 1.22)"; fi
else
  fail go "not found (need >= 1.22)"
fi

# --- stellar CLI with working xdr decode ---
if command -v stellar >/dev/null 2>&1; then
  if stellar xdr decode --help >/dev/null 2>&1; then
    pass stellar "$(stellar --version 2>/dev/null | head -n1)"
  else
    fail stellar "installed, but 'stellar xdr decode --help' failed"
  fi
else
  fail stellar "not found (need stellar CLI with 'xdr decode')"
fi

echo
if [ "$STATUS" -eq 0 ]; then
  echo "environment OK — all XDRParity toolchain requirements met"
else
  echo "environment NOT ready — fix the FAIL lines above"
fi
exit "$STATUS"
