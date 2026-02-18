#!/bin/sh
# Creates database "inventory" if it does not exist (for Docker Postgres).
set -e
psql -v ON_ERROR_STOP=1 -U postgres -tc "SELECT 1 FROM pg_database WHERE datname = 'inventory'" | grep -q 1 || \
  psql -v ON_ERROR_STOP=1 -U postgres -c "CREATE DATABASE inventory;"
echo "Database 'inventory' is ready."
