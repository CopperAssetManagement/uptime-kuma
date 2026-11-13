process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server", "info_notification-queue", "debug"].join(",");

const { after, before, beforeEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { R } = require("redbean-node");
const { DOWN, UP, PENDING, MAINTENANCE } = require("../../src/util");
const { NotificationQueue, QUEUED, SUPPRESSED } = require("../../server/notification-queue");
const { Settings } = require("../../server/settings");
const TestDB = require("../mock-testdb");

const testDb = new TestDB("./data/test-notification-queue");
const PARENT = 7;
const CHILD = 41;

/**
 * The child monitor the queue holds notifications for.
 * @returns {{id: number, name: string, parent: number}} Test monitor
 */
function child() {
    return { id: CHILD, name: "child", parent: PARENT };
}

/**
 * Record a heartbeat.
 * @param {number} monitorId Monitor
 * @param {number} status Heartbeat status
 * @param {string} time UTC time
 * @returns {Promise<void>}
 */
async function beat(monitorId, status, time = "2026-11-12 12:00:00.000") {
    await R.knex("heartbeat").insert({ monitor_id: monitorId, status, time, msg: "", important: 1 });
}

/**
 * The child's persisted undelivered-DOWN state.
 * @returns {Promise<(string|null)>} State
 */
function withheld() {
    return R.getCell("SELECT cascade_down_withheld FROM monitor WHERE id = ?", [CHILD]);
}

/**
 * A send function that counts its calls.
 * @returns {Function & {calls: number}} Counting send function
 */
function counter() {
    const send = async () => {
        send.calls += 1;
    };
    send.calls = 0;
    return send;
}

/**
 * A queue whose timers the test fires itself.
 * @returns {{queue: NotificationQueue, timers: {delay: number, fire: Function}[]}} Queue and its timers
 */
function manual() {
    const timers = [];
    const queue = new NotificationQueue({
        setTimeout: (callback, delay) => {
            const timer = { delay, fire: callback, unref() {} };
            timers.push(timer);
            return timer;
        },
        clearTimeout: (timer) => {
            timer.cleared = true;
        },
    });
    return { queue, timers };
}

describe("NotificationQueue", () => {
    before(async () => {
        await testDb.create();
        await R.knex("user").insert({ id: 1, username: "queue-test", password: "unused-test-password" });
    });

    beforeEach(async () => {
        await R.knex("heartbeat").delete();
        await R.knex("monitor").delete();
        await R.knex("monitor").insert([
            { id: PARENT, name: "parent", type: "ping", interval: 60, user_id: 1, suppress_on_parent_down: 0 },
            { id: CHILD, name: "child", type: "push", interval: 60, user_id: 1, parent: PARENT, suppress_on_parent_down: 1 },
        ]);
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("waits for the parent's interval plus a buffer with a ten-second minimum", async () => {
        const { queue, timers } = manual();
        await queue.enqueue(child(), { status: DOWN }, false, counter(), 60);
        await queue.enqueue({ ...child(), id: PARENT }, { status: DOWN }, false, counter(), 1);
        assert.equal(queue.size, 2);
        assert.deepEqual(timers.map((timer) => timer.delay), [65000, 10000]);
        assert.equal(await withheld(), QUEUED);
    });

    test("suppresses a child DOWN while its parent is down, then withholds its recovery", async () => {
        const { queue, timers } = manual();
        await beat(PARENT, DOWN);
        const send = counter();
        await queue.enqueue(child(), { status: DOWN }, false, send, 60);
        await timers[0].fire();
        assert.equal(send.calls, 0);
        assert.equal(await withheld(), SUPPRESSED);

        assert.equal(await queue.recover(CHILD), true, "the recovery of a suppressed DOWN is not announced");
        assert.equal(await withheld(), null);
        assert.equal(await queue.recover(CHILD), false, "a later recovery is announced again");
    });

    test("sends the DOWN once when the parent is not down, and then announces its recovery", async () => {
        for (const parent of [null, UP, PENDING, MAINTENANCE]) {
            await R.knex("heartbeat").delete();
            if (parent !== null) {
                await beat(PARENT, parent);
            }
            const { queue, timers } = manual();
            const send = counter();
            await queue.enqueue(child(), { status: DOWN }, false, send, 60);
            await timers.at(-1).fire();
            assert.equal(send.calls, 1, `parent ${parent}`);
            assert.equal(await withheld(), null);
            assert.equal(await queue.recover(CHILD), false);
        }
    });

    test("a recovery before the parent check cancels the DOWN and is not announced", async () => {
        const { queue } = manual();
        const send = counter();
        await queue.enqueue(child(), { status: DOWN }, false, send, 60);
        assert.equal(await queue.recover(CHILD), true);
        assert.equal(queue.size, 0);
        assert.equal(send.calls, 0);
    });

    test("a suppressed resend of an announced outage keeps its recovery announced", async () => {
        const { queue, timers } = manual();
        await beat(PARENT, DOWN);
        await queue.enqueue(child(), { status: DOWN }, false, counter(), 60, false);
        await timers[0].fire();
        assert.equal(await withheld(), null);
        assert.equal(await queue.recover(CHILD), false);
    });

    test("a resend that replaces a pending first DOWN still announces the outage", async () => {
        const { queue, timers } = manual();
        await beat(PARENT, DOWN);
        await queue.enqueue(child(), { status: DOWN }, false, counter(), 60, true);
        await queue.enqueue(child(), { status: DOWN }, false, counter(), 60, false);
        assert.equal(queue.size, 1);
        assert.equal(timers[0].cleared, true, "the replaced timer is cleared");
        await timers[1].fire();
        assert.equal(await withheld(), SUPPRESSED);
    });

    test("a suppressed outage is announced once a resend finds the parent up", async () => {
        const { queue, timers } = manual();
        await beat(PARENT, DOWN, "2026-11-12 12:00:00.000");
        await queue.enqueue(child(), { status: DOWN }, false, counter(), 60, true);
        await timers[0].fire();
        assert.equal(await withheld(), SUPPRESSED);
        await beat(PARENT, UP, "2026-11-12 12:05:00.000");
        const send = counter();
        await queue.enqueue(child(), { status: DOWN }, false, send, 60, false);
        await timers[1].fire();
        assert.equal(send.calls, 1);
        assert.equal(await queue.recover(CHILD), false, "its recovery is announced");
    });

    test("stop sends nothing and start resumes the held DOWN with its parent check", async () => {
        const { queue: before } = manual();
        await beat(CHILD, DOWN);
        const send = counter();
        await before.enqueue(child(), { status: DOWN }, false, send, 60);
        await before.stop();
        assert.equal(before.size, 0);
        assert.equal(send.calls, 0, "shutdown sends no held notification");
        assert.equal(await withheld(), QUEUED);

        // The restarted process: the parent is down, so the resumed DOWN is suppressed.
        await beat(PARENT, DOWN);
        const { queue: after, timers } = manual();
        await after.resume(child(), send, 60);
        assert.equal(after.size, 1);
        await timers[0].fire();
        assert.equal(send.calls, 0);
        assert.equal(await withheld(), SUPPRESSED);
    });

    test("start resumes a held DOWN and sends it when the parent is up", async () => {
        const { queue, timers } = manual();
        await beat(CHILD, DOWN);
        await beat(PARENT, UP);
        await R.exec("UPDATE monitor SET cascade_down_withheld = ? WHERE id = ?", [QUEUED, CHILD]);
        const send = counter();
        await queue.resume(child(), send, 60);
        await timers.at(-1).fire();
        assert.equal(send.calls, 1);
        assert.equal(await withheld(), null);
    });

    test("start resumes nothing unless a DOWN was held, and clears a hold whose DOWN was never stored", async () => {
        const { queue } = manual();
        await beat(CHILD, DOWN);
        await queue.resume(child(), counter(), 60);
        await R.exec("UPDATE monitor SET cascade_down_withheld = ? WHERE id = ?", [SUPPRESSED, CHILD]);
        await queue.resume(child(), counter(), 60);
        assert.equal(queue.size, 0);
        assert.equal(await withheld(), SUPPRESSED, "a suppressed outage is settled by its recovery, not by a start");

        await beat(CHILD, UP, "2026-11-12 12:01:00.000");
        await R.exec("UPDATE monitor SET cascade_down_withheld = ? WHERE id = ?", [QUEUED, CHILD]);
        await queue.resume(child(), counter(), 60);
        assert.equal(queue.size, 0);
        assert.equal(await withheld(), null);
    });

    test("a recovery during the parent check and delivery waits for its outcome", async () => {
        await beat(PARENT, UP);
        const { queue, timers } = manual();
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        const sent = [];
        await queue.enqueue(child(), { status: DOWN }, false, async (_first, _monitor, bean) => {
            await gate;
            sent.push(bean.status);
        }, 60);
        const firing = timers[0].fire();
        const recovery = queue.recover(CHILD);
        release();
        await firing;
        assert.equal(await recovery, false, "the DOWN was delivered, so the recovery is announced");
        assert.deepEqual(sent, [DOWN]);
    });

    test("a recovery during a suppressing parent check leaves nothing recorded", async () => {
        await beat(PARENT, DOWN);
        const { queue, timers } = manual();
        await queue.enqueue(child(), { status: DOWN }, false, counter(), 60);
        const firing = timers[0].fire();
        const recovery = queue.recover(CHILD);
        await firing;
        assert.equal(await recovery, true);
        assert.equal(await withheld(), null);
    });

    test("after stop nothing is scheduled, and a held DOWN is recorded for the next start", async () => {
        const { queue, timers } = manual();
        await queue.stop();
        const afterStop = timers.length;
        await queue.enqueue(child(), { status: DOWN }, false, counter(), 60);
        assert.equal(timers.length, afterStop, "nothing is scheduled after stop");
        assert.equal(queue.size, 0);
        assert.equal(await withheld(), QUEUED);
    });

    test("a DOWN delivered without the queue clears an earlier outage's record", async () => {
        await R.exec("UPDATE monitor SET cascade_down_withheld = ? WHERE id = ?", [SUPPRESSED, CHILD]);
        await new NotificationQueue().delivered(CHILD);
        assert.equal(await withheld(), null);
    });

    test("a parent coming UP re-checks a still-DOWN child's suppressed DOWN and sends it once", async () => {
        await beat(CHILD, DOWN);
        await beat(PARENT, UP);
        await R.exec("UPDATE monitor SET cascade_down_withheld = ? WHERE id = ?", [SUPPRESSED, CHILD]);
        const { queue, timers } = manual();
        const send = counter();
        await queue.reannounceChildren({ id: PARENT, name: "parent", interval: 60 }, send, async (id) => ({ ...child(), id }));
        assert.equal(queue.size, 1);
        assert.equal(timers[0].delay, 65000, "through the usual parent check");
        assert.equal(await withheld(), QUEUED);
        await timers[0].fire();
        assert.equal(send.calls, 1);
        assert.equal(await withheld(), null);
    });

    test("a re-checked DOWN is suppressed again if the parent is DOWN by then", async () => {
        await beat(CHILD, DOWN);
        await beat(PARENT, DOWN);
        await R.exec("UPDATE monitor SET cascade_down_withheld = ? WHERE id = ?", [SUPPRESSED, CHILD]);
        const { queue, timers } = manual();
        const send = counter();
        await queue.reannounceChildren({ id: PARENT, name: "parent", interval: 60 }, send, async (id) => ({ ...child(), id }));
        await timers[0].fire();
        assert.equal(send.calls, 0);
        assert.equal(await withheld(), SUPPRESSED);
    });

    test("a parent coming UP leaves alone children that recovered, were announced, or are already held", async () => {
        const { queue } = manual();
        const lookup = async (id) => ({ ...child(), id });
        await beat(CHILD, UP);
        await R.exec("UPDATE monitor SET cascade_down_withheld = ? WHERE id = ?", [SUPPRESSED, CHILD]);
        await queue.reannounceChildren({ id: PARENT, name: "parent", interval: 60 }, counter(), lookup);
        assert.equal(queue.size, 0, "recovered: its own recovery settles it");

        await beat(CHILD, DOWN, "2026-11-12 12:05:00.000");
        await R.exec("UPDATE monitor SET cascade_down_withheld = NULL WHERE id = ?", [CHILD]);
        await queue.reannounceChildren({ id: PARENT, name: "parent", interval: 60 }, counter(), lookup);
        assert.equal(queue.size, 0, "announced: nothing to re-send");

        await R.exec("UPDATE monitor SET cascade_down_withheld = ? WHERE id = ?", [SUPPRESSED, CHILD]);
        await queue.enqueue(child(), { status: DOWN }, false, counter(), 60, false);
        await queue.reannounceChildren({ id: PARENT, name: "parent", interval: 60 }, counter(), lookup);
        assert.equal(queue.size, 1, "already held: not queued twice");
    });

    test("fails open exactly once when parent status cannot be read", async (t) => {
        const original = R.getRow;
        t.after(() => {
            R.getRow = original;
        });
        R.getRow = async () => {
            throw new Error("database unavailable");
        };
        const send = counter();
        await new NotificationQueue().resolve({ monitor: child(), bean: { status: DOWN }, isFirstBeat: false, sendFn: send, announcesOutage: true });
        assert.equal(send.calls, 1);
    });

    test("propagates delivery failure without retrying it, leaving the outage unannounced", async () => {
        await beat(PARENT, UP);
        await R.exec("UPDATE monitor SET cascade_down_withheld = ? WHERE id = ?", [QUEUED, CHILD]);
        let sends = 0;
        await assert.rejects(
            new NotificationQueue().resolve({
                monitor: child(),
                bean: { status: DOWN },
                isFirstBeat: false,
                sendFn: async () => {
                    sends += 1;
                    throw new Error("delivery failed");
                },
                announcesOutage: true,
            }),
            /delivery failed/
        );
        assert.equal(sends, 1);
        assert.equal(await withheld(), QUEUED);
    });

    test("refuses an invalid parent interval instead of inventing a delay", async () => {
        await assert.rejects(
            new NotificationQueue().enqueue(child(), { status: DOWN }, false, counter(), 0),
            /Invalid parent interval/
        );
    });
});
