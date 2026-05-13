#!/usr/bin/env bash
set -euo pipefail

# ─── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PKG_JSON="$PROJECT_DIR/package.json"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()  { echo -e "${CYAN}i${RESET}  $*"; }
ok()    { echo -e "${GREEN}✔${RESET}  $*"; }
warn()  { echo -e "${YELLOW}!${RESET}  $*"; }
fail()  { echo -e "${RED}✖${RESET}  $*"; exit 1; }

# ─── Pre-flight ───────────────────────────────────────────────────────────────
cd "$PROJECT_DIR"

command -v node >/dev/null 2>&1 || fail "node is not installed"
command -v pnpm >/dev/null 2>&1 || fail "pnpm is not installed"
command -v git  >/dev/null 2>&1 || fail "git is not installed"

[[ -f "$PKG_JSON" ]] || fail "Missing $PKG_JSON"
npm whoami >/dev/null 2>&1 || fail "Not logged into npm — run 'npm login' first"

if ! git diff --quiet HEAD -- . 2>/dev/null; then
  warn "Working directory has uncommitted changes"
  read -rp "Continue anyway? (y/N) " answer
  [[ "$answer" =~ ^[Yy]$ ]] || { info "Cancelled"; exit 0; }
fi

# ─── Determine new version ────────────────────────────────────────────────────
CURRENT_VERSION=$(node -p "require('$PKG_JSON').version")
info "Current version: ${BOLD}${CURRENT_VERSION}${RESET}"

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
NEW_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"

# Override:  ./scripts/publish.sh 0.2.0
if [[ "${1:-}" != "" ]]; then
  NEW_VERSION="$1"
  info "Using manually specified version: ${BOLD}${NEW_VERSION}${RESET}"
fi

info "About to publish: ${BOLD}drizzleman@${NEW_VERSION}${RESET}"
read -rp "Confirm? (Y/n) " confirm
[[ "${confirm:-Y}" =~ ^[Yy]?$ ]] || { info "Cancelled"; exit 0; }

# ─── Build ────────────────────────────────────────────────────────────────────
info "Building..."
pnpm build || fail "Build failed, aborting publish"
ok "Build succeeded"

# ─── Bump version ─────────────────────────────────────────────────────────────
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$PKG_JSON', 'utf8'));
  pkg.version = '${NEW_VERSION}';
  fs.writeFileSync('$PKG_JSON', JSON.stringify(pkg, null, 2) + '\n');
"
ok "Version updated: ${CURRENT_VERSION} -> ${NEW_VERSION}"

# Rebuild so dist matches the new version (build steps may embed version)
info "Rebuilding with new version..."
pnpm build || fail "Rebuild after version bump failed"

# ─── Publish ──────────────────────────────────────────────────────────────────
info "Publishing drizzleman@${NEW_VERSION}..."
pnpm publish --access public --no-git-checks
ok "Published drizzleman@${NEW_VERSION}"

# ─── Git commit & tag ─────────────────────────────────────────────────────────
info "Committing version change and creating tag..."
git add "$PKG_JSON"
git commit -m "chore: release v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
ok "Committed and tagged: v${NEW_VERSION}"

echo ""
echo -e "${GREEN}${BOLD}Done!${RESET}"
echo -e "  Run ${CYAN}git push && git push --tags${RESET} to push to remote"
