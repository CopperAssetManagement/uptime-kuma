# Agents

Coding agents in this repository act as the GitHub account `cam-agent`, never as a person.

Before the first commit in a session, run:

    git config user.name cam-agent
    git config user.email 345532944+cam-agent@users.noreply.github.com

Push branches, open pull requests, and merge your own pull request once every required check
passes; if it changes a file listed in CODEOWNERS, the Operator approves it first (GitHub enforces this). Never create, move or delete a `release-*` tag: production ships only through a release
request the Operator approves. The rules behind this are in the Platform repository, `docs/WORKSHOP.md`.

These instructions govern the Copper fork. Contributions to the upstream `louislam/uptime-kuma` project must follow its current contribution policy.
