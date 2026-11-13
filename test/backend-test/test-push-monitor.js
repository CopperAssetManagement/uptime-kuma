process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server", "info_monitor", "warn_monitor", "debug"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const dayjs = require("dayjs");
const { R } = require("redbean-node");
const Monitor = require("../../server/model/monitor");
const { Notification } = require("../../server/notification");
const { UptimeCalculator } = require("../../server/uptime-calculator");
const { Prometheus } = require("../../server/prometheus");
const { Settings } = require("../../server/settings");
const { UP, DOWN, PENDING } = require("../../src/util");
const TestDB = require("../mock-testdb");

dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

const testDb = new TestDB("./data/test-push-monitor");

const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until fn() returns a truthy value.
 * @param {Function} fn polled function
 * @param {number} timeout ms before giving up
 * @param {string} label used in the timeout message
 * @returns {Promise<any>} the truthy value
 */
async function waitFor(fn, timeout, label) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await fn();
        if (value) {
            return value;
        }
        await sleep(100);
    }
    throw new Error(`Timed out waiting for: ${label}`);
}

let io;
let server;
let router;
let port;
let userID;

/**
 * Insert a push monitor.
 * @param {string} token push token used by the /api/push route
 * @param {object} options extra monitor columns
 * @returns {Promise<number>} monitor id
 */
async function createPushMonitor(token, options = {}) {
    const monitor = R.dispense("monitor");
    monitor.name = `push-${token}`;
    monitor.type = "push";
    monitor.active = true;
    monitor.user_id = userID;
    monitor.interval = 2;
    monitor.retryInterval = 1;
    monitor.maxretries = MAX_RETRIES;
    monitor.resendInterval = 0;
    monitor.upside_down = false;
    monitor.push_token = token;
    Object.assign(monitor, options);
    await R.store(monitor);
    return monitor.id;
}

/**
 * Insert a heartbeat row, as if the monitor had just been checked.
 * @param {number} monitorID monitor id
 * @param {number} status heartbeat status
 * @param {number} retries retry counter for the beat
 * @param {object} options extra heartbeat columns
 * @returns {Promise<object>} the stored row
 */
async function seedHeartbeat(monitorID, status, retries, options = {}) {
    const { secondsAgo = 5, msg = "No heartbeat in the time window" } = options;

    const heartbeat = R.dispense("heartbeat");
    heartbeat.monitor_id = monitorID;
    heartbeat.status = status;
    heartbeat.retries = retries;
    heartbeat.msg = msg;
    heartbeat.downCount = 0;
    heartbeat.time = R.isoDateTimeMillis(dayjs.utc().subtract(secondsAgo, "second"));
    heartbeat.end_time = heartbeat.time;
    heartbeat.duration = secondsAgo;
    await R.store(heartbeat);
    return heartbeat;
}

/**
 * Read the heartbeats of a monitor ordered the way the monitor reads them.
 * @param {number} monitorID monitor id
 * @returns {Promise<object[]>} heartbeats ordered by time
 */
function heartbeats(monitorID) {
    return R.getAll(
        "SELECT id, status, retries, msg, time, down_count FROM heartbeat WHERE monitor_id = ? ORDER BY time, id",
        [monitorID]
    );
}

/**
 * Push a heartbeat through the real API route.
 * @param {string} token push token
 * @param {string} status "up" or "down"
 * @returns {Promise<object>} parsed response body
 */
async function push(token, status) {
    const response = await fetch(`http://127.0.0.1:${port}/api/push/${token}?status=${status}`, { method: "POST" });
    return response.json();
}

/**
 * Run a test with a fresh push monitor and return its heartbeats.
 * @param {string} token push token, also used as the monitor name suffix
 * @param {Function} fn receives the monitor id
 * @param {object} options extra monitor columns
 * @returns {Promise<void>}
 */
async function withPushMonitor(token, fn, options = {}) {
    const monitorID = await createPushMonitor(token, options);
    await fn(monitorID);
}

describe("Push monitor", () => {
    before(async () => {
        await testDb.create();
        Notification.init();

        // Prometheus and notifications are not exercised by these tests.
        Prometheus.prototype.update = () => {};
        Prometheus.prototype.remove = () => {};
        Monitor.sendNotification = async () => {};

        const user = R.dispense("user");
        user.username = "push-monitor-test";
        user.password = "push-monitor-test";
        user.active = true;
        await R.store(user);
        userID = user.id;

        router = require("../../server/routers/api-router");
        io = { to: () => ({ emit: () => {} }), sockets: { adapter: { rooms: new Map() } } };

        const app = express();
        app.use(router);
        server = app.listen(0);
        port = server.address().port;
    });

    after(async () => {
        Settings.stopCacheCleaner();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await testDb.destroy();
    });

    test("stores the first DOWN heartbeat as PENDING with retries = 1", async () => {
        await withPushMonitor("first-down", async (monitorID) => {
            await push("first-down", "down");

            const rows = await heartbeats(monitorID);
            assert.deepStrictEqual(
                rows.map((row) => [row.status, row.retries]),
                [[PENDING, 1]]
            );
        });
    });

    test("stores the first UP heartbeat with retries = 0", async () => {
        await withPushMonitor("first-up", async (monitorID) => {
            await push("first-up", "up");

            const rows = await heartbeats(monitorID);
            assert.deepStrictEqual(
                rows.map((row) => [row.status, row.retries]),
                [[UP, 0]]
            );
        });
    });

    test("counts retries up to maxretries while the monitor times out", async () => {
        await withPushMonitor("counting", async (monitorID) => {
            await push("counting", "up");
            await push("counting", "down");
            await push("counting", "down");

            const rows = await heartbeats(monitorID);
            assert.deepStrictEqual(
                rows.map((row) => [row.status, row.retries]),
                [
                    [UP, 0],
                    [PENDING, 1],
                    [PENDING, 2],
                ]
            );
        });
    });

    test("resets retries to 0 on an UP heartbeat after the monitor timed out", async () => {
        await withPushMonitor("reset-up", async (monitorID) => {
            await seedHeartbeat(monitorID, PENDING, MAX_RETRIES);

            await push("reset-up", "up");

            const rows = await heartbeats(monitorID);
            assert.deepStrictEqual(
                rows.map((row) => [row.status, row.retries]),
                [
                    [PENDING, MAX_RETRIES],
                    [UP, 0],
                ]
            );
        });
    });

    test("resets retries to 0 on an UP heartbeat after the monitor went DOWN", async () => {
        await withPushMonitor("reset-after-down", async (monitorID) => {
            await seedHeartbeat(monitorID, DOWN, MAX_RETRIES + 3);

            await push("reset-after-down", "up");

            const rows = await heartbeats(monitorID);
            assert.deepStrictEqual(
                rows.map((row) => [row.status, row.retries]),
                [
                    [DOWN, MAX_RETRIES + 3],
                    [UP, 0],
                ]
            );
        });
    });

    test("restarts the retry counter at 1 on the first failing push after UP", async () => {
        await withPushMonitor("reset-then-down", async (monitorID) => {
            await seedHeartbeat(monitorID, PENDING, MAX_RETRIES);

            await push("reset-then-down", "up");
            await push("reset-then-down", "down");

            const rows = await heartbeats(monitorID);
            assert.deepStrictEqual(
                rows.map((row) => [row.status, row.retries]),
                [
                    [PENDING, MAX_RETRIES],
                    [UP, 0],
                    [PENDING, 1],
                ]
            );
        });
    });

    test("treats a DOWN push as UP on an upside-down monitor and resets retries", async () => {
        await withPushMonitor(
            "upside-down",
            async (monitorID) => {
                await seedHeartbeat(monitorID, PENDING, MAX_RETRIES);

                await push("upside-down", "down");

                const rows = await heartbeats(monitorID);
                assert.deepStrictEqual(
                    rows.map((row) => [row.status, row.retries]),
                    [
                        [PENDING, MAX_RETRIES],
                        [UP, 0],
                    ]
                );
            },
            { upside_down: true }
        );
    });

    test("counts downCount and resends after resendInterval while DOWN", async () => {
        await withPushMonitor(
            "resend",
            async (monitorID) => {
                await seedHeartbeat(monitorID, DOWN, MAX_RETRIES);
                await push("resend", "down");
                await push("resend", "down");

                const rows = await heartbeats(monitorID);
                assert.deepStrictEqual(
                    rows.slice(1).map((row) => [row.status, row.down_count]),
                    [
                        [DOWN, 1],
                        [DOWN, 0],
                    ]
                );
            },
            { resendInterval: 2 }
        );
    });

    test("a monitor beat stored during the push request does not cancel the retry reset", async () => {
        await withPushMonitor("raced-up", async (monitorID) => {
            await seedHeartbeat(monitorID, PENDING, MAX_RETRIES);

            const monitor = await R.findOne("monitor", " id = ? ", [monitorID]);

            // Hold the push route between "status decided" and "R.store(bean)": the window in which
            // the route has already stamped bean.time but has not written the row yet.
            const originalUpdate = UptimeCalculator.prototype.update;
            let release;
            let hold = true;
            const parked = new Promise((resolve) => (release = resolve));
            UptimeCalculator.prototype.update = async function (...args) {
                if (hold) {
                    hold = false;
                    await parked;
                }
                return originalUpdate.apply(this, args);
            };

            try {
                await monitor.start(io);

                const before = (await heartbeats(monitorID)).length;
                const pushRequest = push("raced-up", "up");
                await sleep(300);

                // The monitor's own timer fires while the push is parked, so its beat gets a later
                // `time` (the order the monitor reads by) while being stored first.
                await waitFor(async () => (await heartbeats(monitorID)).length > before, 10000, "a monitor beat");

                release();
                await pushRequest;

                await waitFor(
                    async () => {
                        const rows = await heartbeats(monitorID);
                        const upBeat = rows.filter((row) => row.status === UP).at(-1);
                        return rows.filter((row) => row.status !== UP && row.id > upBeat.id).length >= 2;
                    },
                    10000,
                    "beats after the UP heartbeat"
                );

                const rows = await heartbeats(monitorID);
                const upBeat = rows.filter((row) => row.status === UP).at(-1);
                assert.strictEqual(upBeat.retries, 0, "the UP heartbeat itself must reset retries");

                // The monitor reads beats in storage order, so the stale beat that was stored
                // before the UP heartbeat must not restart the counter from its own value.
                const afterUp = rows.find((row) => row.id > upBeat.id);
                assert.deepStrictEqual(
                    [afterUp.status, afterUp.retries],
                    [PENDING, 1],
                    `beats after the UP heartbeat: ${rows.map((row) => `${row.status}/${row.retries}`).join(", ")}`
                );
            } finally {
                UptimeCalculator.prototype.update = originalUpdate;
                await monitor.stop();
            }
        });
    });

    test("a never-pushed monitor created more than one interval ago goes DOWN at its first check after a restart", async () => {
        await withPushMonitor(
            "never-pushed",
            async (monitorID) => {
                const monitor = await R.findOne("monitor", " id = ? ", [monitorID]);
                const started = Date.now();
                try {
                    await monitor.start(io, { stoppedAtMs: Date.now() });
                    const rows = await waitFor(async () => (await heartbeats(monitorID)).length && heartbeats(monitorID), 5000, "the first check");
                    assert.deepStrictEqual(rows.map((row) => row.status), [DOWN]);
                    assert.ok(Date.now() - started < 5000, "the first check did not wait a full interval");
                } finally {
                    await monitor.stop();
                }
            },
            {
                interval: 3600,
                maxretries: 0,
                created_date: R.isoDateTime(dayjs.utc().subtract(2, "hour")),
            }
        );
    });

    test("resuming a paused push monitor keeps a full interval of grace", async () => {
        await withPushMonitor(
            "resumed",
            async (monitorID) => {
                const monitor = await R.findOne("monitor", " id = ? ", [monitorID]);
                try {
                    await monitor.start(io);
                    await sleep(3000);
                    assert.deepStrictEqual(await heartbeats(monitorID), []);
                } finally {
                    await monitor.stop();
                }
            },
            {
                interval: 3600,
                maxretries: 0,
                created_date: R.isoDateTime(dayjs.utc().subtract(2, "hour")),
            }
        );
    });

    test("schedules a push monitor's first check at server start from its last beat and Kuma's downtime", () => {
        const second = 1000;
        const delay = (elapsed, downtime = 0) => Monitor.firstPushCheckDelay(60, elapsed === null ? null : elapsed * second, downtime * second);
        assert.strictEqual(delay(30), 31 * second, "deadline ahead: at the deadline, plus the buffer");
        assert.strictEqual(delay(120, 10), second, "overdue before Kuma stopped: at once");
        assert.strictEqual(delay(75, 45), 46 * second, "due while Kuma was down: at the next expected push");
        assert.strictEqual(delay(120, 100), second, "the next expected push is now");
        assert.strictEqual(delay(130, 100), 51 * second, "due twice while down: at the next expected push");
        // Started 30 s into the startup stagger: downtime is measured to this monitor's start.
        assert.strictEqual(delay(100, 50), 21 * second, "a late-started monitor still waits for the lost push's successor");
        assert.strictEqual(delay(-300), 61 * second, "a future reference waits one interval");
        assert.strictEqual(delay(null), 60 * second, "an unknown reference waits one interval");
    });

    test("a pushed recovery whose DOWN was never delivered is not announced", async () => {
        const parent = R.dispense("monitor");
        Object.assign(parent, { name: "cascade-parent", type: "ping", active: false, user_id: userID, interval: 60 });
        await R.store(parent);
        const originalSend = Monitor.sendNotification;
        const sent = [];
        Monitor.sendNotification = async (_isFirstBeat, _monitor, bean) => {
            sent.push(bean.status);
        };
        try {
            await withPushMonitor(
                "cascade-orphan-up",
                async (monitorID) => {
                    // Held for the parent check, then recovered before it: neither is announced.
                    await seedHeartbeat(monitorID, UP, 0, { msg: "OK" });
                    await push("cascade-orphan-up", "down");
                    await push("cascade-orphan-up", "up");
                    // Suppressed (the parent was DOWN), then recovered: the recovery is not announced.
                    await push("cascade-orphan-up", "down");
                    await R.exec("UPDATE monitor SET cascade_down_withheld = 'suppressed' WHERE id = ?", [monitorID]);
                    await push("cascade-orphan-up", "up");
                    assert.deepStrictEqual(sent, []);
                    // An outage whose DOWN was delivered still announces its recovery.
                    await push("cascade-orphan-up", "down");
                    await R.exec("UPDATE monitor SET cascade_down_withheld = NULL WHERE id = ?", [monitorID]);
                    await push("cascade-orphan-up", "up");
                    assert.deepStrictEqual(sent, [UP]);
                    // A DOWN sent directly (suppression turned off) clears what an earlier outage left.
                    await R.exec("UPDATE monitor SET suppress_on_parent_down = 0, cascade_down_withheld = 'suppressed' WHERE id = ?", [monitorID]);
                    await push("cascade-orphan-up", "down");
                    await push("cascade-orphan-up", "up");
                    assert.deepStrictEqual(sent, [UP, DOWN, UP]);
                },
                { parent: parent.id, suppressOnParentDown: true, maxretries: 0 }
            );
        } finally {
            Monitor.sendNotification = originalSend;
        }
    });

    test("a parent pushed back UP re-checks its still-DOWN child's suppressed DOWN", async () => {
        const { notificationQueue } = require("../../server/notification-queue");
        await withPushMonitor("reannounce-parent", async (parentID) => {
            await withPushMonitor(
                "reannounce-child",
                async (childID) => {
                    await seedHeartbeat(parentID, DOWN, 0);
                    await seedHeartbeat(childID, DOWN, 0);
                    await R.exec("UPDATE monitor SET cascade_down_withheld = 'suppressed' WHERE id = ?", [childID]);
                    try {
                        await push("reannounce-parent", "up");
                        assert.strictEqual(
                            await R.getCell("SELECT cascade_down_withheld FROM monitor WHERE id = ?", [childID]),
                            "queued"
                        );
                        assert.ok(notificationQueue.pending.has(childID), "held again for the parent check");
                    } finally {
                        notificationQueue.clearTimer(childID);
                    }
                },
                { parent: parentID, suppressOnParentDown: true, maxretries: 0 }
            );
        }, { maxretries: 0 });
    });
});
