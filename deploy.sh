#!/usr/bin/env bash
# Deploy WatchParty to Render as a free web service.
# Prereq: run `render login` once (interactive browser OAuth).
set -euo pipefail

REPO="https://github.com/Mukund2/watchparty"

echo "🎬 Creating WatchParty web service on Render…"
render services create \
  --name watchparty \
  --type web_service \
  --repo "$REPO" \
  --branch main \
  --runtime node \
  --plan free \
  --region oregon \
  --build-command "npm install" \
  --start-command "npm start" \
  --health-check-path "/" \
  --env-var "NODE_VERSION=22" \
  --auto-deploy \
  --confirm \
  --output json

echo
echo "✅ Service created. Render is now building from $REPO."
echo "   Watch progress / get the URL with:  render services"
