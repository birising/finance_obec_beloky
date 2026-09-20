#!/usr/bin/env bash
# Copy the static site to the web server (served by Caddy as a static SPA).
# Usage: DEPLOY_TARGET=user@host:/path/to/webroot ./deploy.sh
set -euo pipefail
: "${DEPLOY_TARGET:?set DEPLOY_TARGET=user@host:/path/to/webroot}"
cd "$(dirname "$0")/web"
scp -q budget.json historie.json odpady.json index.html app.js "$DEPLOY_TARGET/"
scp -q interni/index.html interni/app.js interni/data.json "$DEPLOY_TARGET/interni/"
echo "deployed to $DEPLOY_TARGET"
