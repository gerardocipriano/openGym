#!/bin/sh
# Builds the Firebase variant (VITE_FIREBASE=1) and deploys it to Netlify.
# Usage: ./publish.sh. Needs `netlify login` once. Site: https://palerger.netlify.app
set -e
cd "$(dirname "$0")"
PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"
(cd frontend && npm ci --no-audit --no-fund && VITE_FIREBASE=1 npm run build)
node scripts/catalogue/stage-media.mjs frontend/dist
printf 'User-agent: *\nDisallow: /\n' > frontend/dist/robots.txt
printf '/*\n  X-Robots-Tag: noindex\n' > frontend/dist/_headers
netlify deploy --prod --dir frontend/dist --site 5fa162b0-8c06-4976-9c46-c8cb796dbf04 --message "$(git log -1 --format=%h)"
