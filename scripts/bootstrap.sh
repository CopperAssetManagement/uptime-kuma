#!/bin/sh
# Install exactly the locked dependencies and enable native publication guards. Safe to rerun.
set -eu

if ! command -v git-publication-secrets >/dev/null 2>&1; then
  echo 'Missing shared scanner; agent installation/repair: https://github.com/CopperAssetManagement/platform/blob/main/docs/operations/git-publication-secrets.md' >&2
  exit 1
fi
git-publication-secrets check
cd "$(git rev-parse --show-toplevel)"
npm ci
git config core.hooksPath .githooks
