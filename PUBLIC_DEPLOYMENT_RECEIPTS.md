# Public deployment receipts

The existing `GET /api/status-page/heartbeat/:slug` endpoint can publish a small
deployment receipt alongside an opted-in push monitor's heartbeat. Ordinary
heartbeat messages stay private (`msg` is always empty in public JSON).

Add the monitor tag **public-deployment-receipt**, with value **github.com**, to a
push monitor already displayed on a public status page. Other monitor types,
untagged monitors, private groups and monitors on other status pages cannot opt
in through a heartbeat message.

The producer must send exactly `PASS <full lowercase 40-character Git SHA>
source=github.com` on one line, with status `up`. The endpoint then includes:

```json
{
  "status": 1,
  "time": "2026-10-21 18:24:08.792",
  "msg": "",
  "ping": null,
  "deploymentReceipt": {
    "sha": "34523213ee76c312d77340746993e7899cd92294",
    "source": "github.com",
    "time": "2026-10-21 18:24:08.792"
  }
}
```

The timestamp is that heartbeat's existing Kuma UTC timestamp, not a build time
or a newly generated response time. Malformed messages, extra text and non-UP
heartbeats omit `deploymentReceipt` entirely. Consumers should inspect the newest
heartbeat and its status/time; an older receipt does not establish current
health. The endpoint keeps its existing one-minute server cache.

This is a deployment producer's report authenticated by its existing push token,
not a cryptographic attestation. The producer remains responsible for reporting
only after applying and checking the named revision. Neither the push token nor
arbitrary error/heartbeat messages are published.

The custom image workflow publishes immutable SHA tags and a manifest digest
after merges to `main`. Platform should pin a verified published digest and opt
its converge monitor in through its managed monitor contract before rollout.
