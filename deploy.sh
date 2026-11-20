#!/usr/bin/env bash
# Build locally, sync to the Lighthouse VPS, (re)start under PM2 on port 3000 behind Nginx.
#
#   ./deploy.sh                      # uses your default SSH key / agent
#   SSH_KEY=~/.ssh/lighthouse ./deploy.sh
#
# Overridable: DEPLOY_HOST, DEPLOY_DIR, APP_NAME, APP_PORT, SSH_KEY.
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-ubuntu@43.156.117.143}"
DEPLOY_DIR="${DEPLOY_DIR:-app}"          # relative to the remote home directory (~/app)
APP_NAME="${APP_NAME:-dashboard}"
APP_PORT="${APP_PORT:-3000}"
DIST_DIR=".next-prod"                    # separate from .next so `npm run dev` keeps working
PUBLIC_URL="https://${DEPLOY_HOST#*@}"

cd "$(dirname "$0")"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
if [[ -n "${SSH_KEY:-}" ]]; then SSH_OPTS+=(-i "$SSH_KEY" -o IdentitiesOnly=yes); fi
ssh_run() { ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "$@"; }

step() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

step "Checking SSH access to $DEPLOY_HOST"
ssh_run 'command -v node >/dev/null && command -v pm2 >/dev/null && command -v rsync >/dev/null' \
  || { echo "SSH failed, or node / pm2 / rsync missing on the VPS." >&2; exit 1; }

step "Type-checking"
npx tsc --noEmit

step "Building locally into $DIST_DIR (keeps memory pressure off the 2GB VPS)"
rm -rf "$DIST_DIR"
NEXT_DIST_DIR="$DIST_DIR" NEXT_TELEMETRY_DISABLED=1 npm run build

step "Syncing to $DEPLOY_HOST:~/$DEPLOY_DIR"
ssh_run "mkdir -p ~/$DEPLOY_DIR"
# Excluded paths are also protected from --delete, so the server's node_modules and .env survive.
rsync -avz --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude node_modules \
  --exclude .git \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '*.pem' \
  --exclude .next \
  --exclude "$DIST_DIR/cache" \
  --exclude .claude \
  --exclude '*.tsbuildinfo' \
  --exclude .DS_Store \
  ./ "$DEPLOY_HOST:$DEPLOY_DIR/"

# A local .env / .env.production is copied once; an existing server copy is never overwritten.
for f in .env.production .env; do
  if [[ -f "$f" ]]; then
    if ssh_run "test -e ~/$DEPLOY_DIR/.env"; then
      echo "Remote ~/$DEPLOY_DIR/.env already exists — leaving it alone."
    else
      step "Copying $f to ~/$DEPLOY_DIR/.env (first deploy only)"
      scp "${SSH_OPTS[@]}" "$f" "$DEPLOY_HOST:$DEPLOY_DIR/.env"
      ssh_run "chmod 600 ~/$DEPLOY_DIR/.env"
    fi
    break
  fi
done

step "Installing production dependencies and restarting PM2 app '$APP_NAME' on port $APP_PORT"
ssh_run bash -s -- "$DEPLOY_DIR" "$APP_NAME" "$APP_PORT" "$DIST_DIR" <<'REMOTE'
set -euo pipefail
cd ~/"$1"
npm install --omit=dev --no-audit --no-fund
export PORT="$3" NEXT_DIST_DIR="$4" NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
pm2 restart "$2" --update-env 2>/dev/null || pm2 start npm --name "$2" -- start
pm2 save
REMOTE

step "Waiting for the app to answer"
for i in $(seq 1 30); do
  if ssh_run "curl -fsS -o /dev/null http://127.0.0.1:$APP_PORT"; then break; fi
  [[ $i == 30 ]] && { echo "App did not come up on :$APP_PORT. Recent logs:" >&2; ssh_run "pm2 logs $APP_NAME --lines 40 --nostream" >&2; exit 1; }
  sleep 2
done

ssh_run "pm2 status $APP_NAME"
step "Public check: $PUBLIC_URL"
curl -sSI --max-time 20 "$PUBLIC_URL" | head -1
