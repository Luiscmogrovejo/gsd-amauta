#!/usr/bin/env bash
# GSD-Amauta Remote Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Luiscmogrovejo/gsd-amauta/master/scripts/install-remote.sh | bash
#
# Installs GSD-Amauta for Claude Code without requiring git clone.
# Downloads the latest release, installs to ~/.claude/, starts services.

set -euo pipefail

REPO="Luiscmogrovejo/gsd-amauta"
BRANCH="master"
INSTALL_DIR="$HOME/.claude/gsd-amauta"
CLAUDE_DIR="$HOME/.claude"
VERSION="2.4.0"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}"
echo "   █████╗ ███╗   ███╗ █████╗ ██╗   ██╗████████╗ █████╗"
echo "  ██╔══██╗████╗ ████║██╔══██╗██║   ██║╚══██╔══╝██╔══██╗"
echo "  ███████║██╔████╔██║███████║██║   ██║   ██║   ███████║"
echo "  ██╔══██║██║╚██╔╝██║██╔══██║██║   ██║   ██║   ██╔══██║"
echo "  ██║  ██║██║ ╚═╝ ██║██║  ██║╚██████╔╝   ██║   ██║  ██║"
echo "  ╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝ ╚═════╝    ╚═╝   ╚═╝  ╚═╝"
echo -e "${NC}"
echo -e "  Amauta ${YELLOW}v${VERSION}${NC} — Remote Installer"
echo ""

# ── Check prerequisites ────────────────────────────────
echo -e "${CYAN}Checking prerequisites...${NC}"

if ! command -v node &>/dev/null; then
    echo -e "${RED}Error: Node.js 18+ is required.${NC}"
    echo "  Install: https://nodejs.org/ or 'brew install node'"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}Error: Node.js 18+ required (found v$(node -v)).${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"

if ! command -v python3 &>/dev/null; then
    echo -e "${RED}Error: Python 3.9+ is required.${NC}"
    echo "  Install: https://python.org/ or 'brew install python'"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Python $(python3 --version | cut -d' ' -f2)"

if command -v claude &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Claude Code CLI"
else
    echo -e "  ${YELLOW}!${NC} Claude Code CLI not found (install will continue)"
fi

# ── Download ────────────────────────────────────────────
echo ""
echo -e "${CYAN}Downloading GSD-Amauta v${VERSION}...${NC}"

if [ -d "$INSTALL_DIR" ]; then
    echo -e "  ${YELLOW}!${NC} Existing installation found at $INSTALL_DIR"
    echo -e "  ${YELLOW}!${NC} Backing up to ${INSTALL_DIR}.bak"
    rm -rf "${INSTALL_DIR}.bak" 2>/dev/null || true
    mv "$INSTALL_DIR" "${INSTALL_DIR}.bak"
fi

mkdir -p "$INSTALL_DIR"

# Try git clone first (faster, preserves history)
if command -v git &>/dev/null; then
    echo -e "  Using git clone..."
    git clone --depth 1 -b "$BRANCH" "https://github.com/${REPO}.git" "$INSTALL_DIR" 2>/dev/null
    echo -e "  ${GREEN}✓${NC} Downloaded via git"
else
    # Fallback: download tarball
    echo -e "  Using tarball download (git not available)..."
    TARBALL_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
    curl -fsSL "$TARBALL_URL" | tar xz -C "$INSTALL_DIR" --strip-components=1
    echo -e "  ${GREEN}✓${NC} Downloaded via tarball"
fi

# ── Install ─────────────────────────────────────────────
echo ""
echo -e "${CYAN}Installing...${NC}"

cd "$INSTALL_DIR"

# Run the Node.js installer
if [ -f "bin/install.js" ]; then
    node bin/install.js
else
    echo -e "${RED}Error: bin/install.js not found in download.${NC}"
    exit 1
fi

# ── Copy Python backend ────────────────────────────────
echo ""
echo -e "${CYAN}Installing Python backend...${NC}"

mkdir -p "$CLAUDE_DIR/get-shit-done/services"
mkdir -p "$CLAUDE_DIR/get-shit-done/scripts"

cp amauta.py "$CLAUDE_DIR/get-shit-done/amauta.py" 2>/dev/null && echo -e "  ${GREEN}✓${NC} amauta.py" || true
for f in amauta-daemon.py rlm-service.py pg_store.py sqlite_store.py backup.py oidc_auth.py infra_detect.py; do
    cp "services/$f" "$CLAUDE_DIR/get-shit-done/services/$f" 2>/dev/null && echo -e "  ${GREEN}✓${NC} $f" || true
done
cp scripts/purge-test-data.py "$CLAUDE_DIR/get-shit-done/scripts/purge-test-data.py" 2>/dev/null || true

# ── Start services ──────────────────────────────────────
echo ""
echo -e "${CYAN}Starting services...${NC}"

# Start daemon if not already running
if curl -s http://127.0.0.1:18799/health &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Daemon already running"
else
    python3 "$CLAUDE_DIR/get-shit-done/services/amauta-daemon.py" start 2>/dev/null &
    sleep 3
    if curl -s http://127.0.0.1:18799/health &>/dev/null; then
        echo -e "  ${GREEN}✓${NC} Daemon started on :18799"
    else
        echo -e "  ${YELLOW}!${NC} Daemon failed to start (run manually: python3 ~/.claude/get-shit-done/services/amauta-daemon.py start)"
    fi
fi

# ── Verify ──────────────────────────────────────────────
echo ""
echo -e "${CYAN}Verifying installation...${NC}"

PASS=0
FAIL=0

if curl -s http://127.0.0.1:18799/health | grep -q '"status":"ok"' 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Daemon healthy"
    PASS=$((PASS + 1))
else
    echo -e "  ${YELLOW}!${NC} Daemon not responding"
    FAIL=$((FAIL + 1))
fi

if curl -s http://127.0.0.1:18798/health | grep -q '"status":"ok"' 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} RLM service healthy"
    PASS=$((PASS + 1))
else
    echo -e "  ${YELLOW}!${NC} RLM service not responding"
    FAIL=$((FAIL + 1))
fi

if [ -f "$CLAUDE_DIR/get-shit-done/bin/gsd-amauta.cjs" ]; then
    echo -e "  ${GREEN}✓${NC} CLI tools installed"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}✗${NC} CLI tools missing"
    FAIL=$((FAIL + 1))
fi

if [ -d "$CLAUDE_DIR/agents" ]; then
    AGENT_COUNT=$(ls "$CLAUDE_DIR/agents"/gsd-*.md 2>/dev/null | wc -l | tr -d ' ')
    echo -e "  ${GREEN}✓${NC} $AGENT_COUNT agents installed"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}✗${NC} Agents not installed"
    FAIL=$((FAIL + 1))
fi

# ── Summary ─────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Amauta v${VERSION} installed!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Checks: ${GREEN}${PASS} passed${NC}, ${YELLOW}${FAIL} warnings${NC}"
echo ""
echo -e "  ${CYAN}Next steps:${NC}"
echo -e "  1. Open a project directory"
echo -e "  2. Run: ${CYAN}/amauta:new-project${NC}"
echo ""
echo -e "  ${CYAN}Optional API keys${NC} (add to ~/.zshrc):"
echo -e "  export PERPLEXITY_API_KEY=\"...\"  # Research chain"
echo -e "  export VOYAGE_API_KEY=\"...\"      # Semantic search"
echo ""
echo -e "  ${CYAN}Docs:${NC} https://github.com/${REPO}"
echo ""
