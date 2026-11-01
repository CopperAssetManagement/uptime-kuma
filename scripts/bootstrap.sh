#!/bin/sh
# Prepare this checkout or worktree for work: install exactly the locked dependencies. Safe to rerun.
set -eu
cd "$(git rev-parse --show-toplevel)"
npm ci
