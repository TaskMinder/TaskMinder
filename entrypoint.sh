#!/bin/sh
set -e

# ==============================================================================
# ----- Load Docker Secrets into Environment Variables -----
# ==============================================================================
SESSION_SECRET="$(cat /run/secrets/session_secret)"
export SESSION_SECRET

DATABASE_URL="$(cat /run/secrets/database_url)"
export DATABASE_URL

ENCRYPTION_KEY="$(cat /run/secrets/encryption_key)"
export ENCRYPTION_KEY

ENCRYPTION_KEY_SECONDARY="$(cat /run/secrets/encryption_key_secondary)"
export ENCRYPTION_KEY_SECONDARY

ENCRYPTION_KEY_LOOKUP="$(cat /run/secrets/encryption_key_lookup)"
export ENCRYPTION_KEY_LOOKUP

PROXY_HOP="$(cat /run/secrets/proxy_hop)"
export PROXY_HOP

RESEND_API_KEY="$(cat /run/secrets/resend_api_key)"
export RESEND_API_KEY

MODERATION_LINK_SECRET="$(cat /run/secrets/moderation_link_secret)"
export MODERATION_LINK_SECRET

MODERATION_EMAIL_TO="$(cat /run/secrets/moderation_email_to)"
export MODERATION_EMAIL_TO

MODERATION_EMAIL_FROM="$(cat /run/secrets/moderation_email_from)"
export MODERATION_EMAIL_FROM

PUBLIC_BASE_URL="$(cat /run/secrets/public_base_url)"
export PUBLIC_BASE_URL

# ==============================================================================
# Ensure permissions for data are returned to bun user
# ==============================================================================
echo "Returning data directory permissions to bun..."
chown -R bun:bun /usr/src/app/data

# ==============================================================================
# Ensure permissions for ClamAV directories
# ==============================================================================
echo "Returning ClamAV directory permissions to clamav..."
chown -R clamav:clamav /var/lib/clamav /run/clamav

# ==============================================================================
# Run DB Migrations (as bun)
# ==============================================================================
echo "Running database migrations..."
su-exec bun:bun bunx prisma migrate deploy

# ==============================================================================
# Regular migration cmds for server encryption key rotation (>= v2.2.5)
# Ignore if first time setting up server or your current version is < v2.2.5
# ==============================================================================
# su-exec bun:bun bun run encrypt:rotate

# ======================================================================
# Update ClamDB (as clamav)
# ======================================================================
echo "Updating ClamAV virus database..."
su-exec clamav:clamav freshclam --foreground || echo "Warning: ClamAV database update failed."

# ======================================================================
# Start clamd (as clamav)
# ======================================================================
echo "Starting clamd..."
su-exec clamav:clamav clamd &

# Wait until clamd is ready
echo "Waiting for clamd to become ready..."
for i in $(seq 1 20); do
    if su-exec clamav:clamav clamdscan --version >/dev/null 2>&1; then
        echo "clamd is ready."
        break
    fi
    echo "Waiting... $i"
    sleep 1
done

# Check if clamd is actually ready after waiting
if ! su-exec clamav:clamav clamdscan --version >/dev/null 2>&1; then
    echo "Error: clamd failed to start within 20 seconds"
    exit 1
fi

# ======================================================================
# Flush specific Redis key prefixes (cache:, auth_user:, auth_class:)
# ======================================================================
echo "Flushing targeted Redis keys..."
su-exec bun:bun sh -c '
  for pattern in "cache:*" "auth_user:*" "auth_class:*"; do
    redis-cli -h redis --scan --pattern "$pattern" | xargs -r redis-cli -h redis DEL
  done
' || echo "Redis targeted flush failed"
echo "Initialization complete. Starting application as '"'"'bun'"'"'..."

# ==============================================================================
# ----- Start the Main Application -----
# ==============================================================================
exec su-exec bun:bun "$@"