const { afterEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { R } = require("redbean-node");
const { DOWN, UP } = require("../../src/util");
const { NotificationQueue } = require("../../server/notification-queue");

const originalGetRow = R.getRow;

afterEach(() => {
    R.getRow = originalGetRow;
});

/**
 * Build a minimal child monitor used by the queue tests.
 * @returns {{id: number, name: string, parent: number}} Test monitor
 */
function subject() {
    return {
        id: 41,
        name: "child",
        parent: 7,
    };
}

describe("NotificationQueue", () => {
    test("suppresses a child notification when its parent is down", async () => {
        R.getRow = async () => ({ status: DOWN });
        let sends = 0;
        await new NotificationQueue().resolve(subject(), { status: DOWN }, false, async () => {
            sends += 1;
        });
        assert.equal(sends, 0);
    });

    test("sends exactly once when the parent is not down", async () => {
        R.getRow = async () => ({ status: UP });
        let sends = 0;
        await new NotificationQueue().resolve(subject(), { status: DOWN }, false, async () => {
            sends += 1;
        });
        assert.equal(sends, 1);
    });

    test("fails open exactly once when parent status cannot be read", async () => {
        R.getRow = async () => {
            throw new Error("database unavailable");
        };
        let sends = 0;
        await new NotificationQueue().resolve(subject(), { status: DOWN }, false, async () => {
            sends += 1;
        });
        assert.equal(sends, 1);
    });

    test("propagates delivery failure without retrying it", async () => {
        R.getRow = async () => ({ status: UP });
        let sends = 0;
        await assert.rejects(
            new NotificationQueue().resolve(subject(), { status: DOWN }, false, async () => {
                sends += 1;
                throw new Error("delivery failed");
            }),
            /delivery failed/
        );
        assert.equal(sends, 1);
    });

    test("cancels a delayed down notification after recovery", () => {
        const queue = new NotificationQueue();
        queue.enqueue(subject(), { status: DOWN }, false, async () => {}, 60);
        assert.equal(queue.size, 1);
        assert.equal(queue.cancel(41), true);
        assert.equal(queue.size, 0);
        assert.equal(queue.cancel(41), false);
    });

    test("flush attempts every delivery and reports the failures", async () => {
        const queue = new NotificationQueue();
        let successful = 0;
        queue.enqueue(subject(), { status: DOWN }, false, async () => {
            throw new Error("first failed");
        }, 60);
        queue.enqueue({ ...subject(), id: 42, name: "other child" }, { status: DOWN }, false, async () => {
            successful += 1;
        }, 60);

        await assert.rejects(queue.flush(), AggregateError);
        assert.equal(successful, 1);
        assert.equal(queue.size, 0);
    });

    test("refuses an invalid parent interval instead of inventing a delay", () => {
        assert.throws(
            () => new NotificationQueue().enqueue(subject(), { status: DOWN }, false, async () => {}, 0),
            /Invalid parent interval/
        );
    });
});
