#!/bin/sh
set -e

# Generate the runtime env script from the GATEWAY_URL environment variable.
# Leave it empty (same-origin) when the variable is not set.
cat > /usr/share/nginx/html/env.js <<ENVEOF
window.__GATEWAY_URL__ = "${GATEWAY_URL:-}";
ENVEOF

exec nginx -g 'daemon off;'