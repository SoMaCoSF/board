#!/usr/bin/env bash
# Launch mission control on Vercel, direct from a clone of this repo.
#
#   scripts/launch-mission-control.sh [--project board-mission-control] [--team <slug-or-id>]
#
# What it does: installs the workspace, builds @vercel/board, links a Vercel
# project rooted at apps/mission-control, and deploys it to production.
# The deployment reads the team's board as its project once the team grants
# it the board (see apps/mission-control/README.md). No env vars are required
# for that; BOARD_URL / BOARD_TOKEN point it at a board elsewhere instead.
set -euo pipefail

PROJECT="board-mission-control"
TEAM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --team) TEAM="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/../../.."   # the repo root
APP_DIR="apps/mission-control"

command -v node >/dev/null || { echo "node 22.18 or later is required" >&2; exit 2; }
command -v vercel >/dev/null || { echo "the vercel CLI is required: npm i -g vercel" >&2; exit 2; }
if ! command -v pnpm >/dev/null; then
  echo "pnpm not found; enabling it via corepack"
  corepack enable
  corepack prepare pnpm@11.23.0 --activate
fi

echo "installing the workspace"
pnpm install

echo "building @vercel/board"
pnpm --filter @vercel/board build

SCOPE=()
[ -n "$TEAM" ] && SCOPE=(--scope "$TEAM")

echo "linking project $PROJECT (root: $APP_DIR)"
(cd "$APP_DIR" && vercel link --yes --project "$PROJECT" "${SCOPE[@]}")

echo "deploying to production"
(cd "$APP_DIR" && vercel deploy --prod "${SCOPE[@]}")

echo
echo "Launched. The deployment acts as its project on your team's board once"
echo "someone on the team grants it the board. Routing layer: https://jevie.ai"
