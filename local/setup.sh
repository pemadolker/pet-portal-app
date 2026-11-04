#!/bin/sh
# Generates local secrets once: database passwords, the bootstrap admin, and the
# RS256 key pair (login signs with the private key, the gateway verifies with the public key).
# Everything goes to local/.secrets/, which is git-ignored.
set -eu
cd "$(dirname "$0")"
mkdir -p .secrets
[ -f .secrets/.env ] && { echo "local/.secrets/.env already exists; delete it to regenerate"; exit 0; }
rand() { openssl rand -base64 24 | tr -d '/+=' | cut -c1-24; }
{
  echo "POSTGRES_PASSWORD=$(rand)"
  for s in SIGNUP LOGIN PROFILE PET SEARCH SHELTER FAVORITES ADOPTION REVIEW HISTORY NOTIFICATION REPORTING; do
    echo "${s}_DB_PASSWORD=$(rand)"
  done
  echo "ADMIN_EMAIL=admin@portal.local"
  echo "ADMIN_PASSWORD=$(rand)"
} > .secrets/.env
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out .secrets/jwt-private.pem 2>/dev/null
openssl pkey -in .secrets/jwt-private.pem -pubout -out .secrets/jwt-public.pem
chmod 644 .secrets/jwt-private.pem .secrets/jwt-public.pem   # read by the non-root container user
echo "Secrets written to local/.secrets/. Admin login:"
grep ADMIN_ .secrets/.env
