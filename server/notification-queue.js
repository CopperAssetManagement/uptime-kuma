const { R } = require("redbean-node");
const { log, DOWN } = require("../src/util");

/**
 * Delayed notification queue for cascade suppression.
 *
 * When a child monitor with suppressOnParentDown=true goes DOWN,
 * the notification is held for a delay period. After the delay,
 * the parent's latest heartbeat is checked. If the parent is also
 * DOWN, the child notification is suppressed. Otherwise it sends.
 */
class NotificationQueue {

    /** Create an empty delayed-notification queue. */
    constructor() {
        /** @type {Map<number, {timer: NodeJS.Timeout, monitor: object, bean: object, isFirstBeat: boolean}>} */
        this.pending = new Map();
    }

    /**
     * Enqueue a notification for delayed sending with parent check.
     * Only one pending notification per monitor — newer replaces older.
     * @param {object} monitor The child monitor instance
     * @param {object} bean The heartbeat bean
     * @param {boolean} isFirstBeat Whether this is the first beat
     * @param {Function} sendFn The function to call if notification should send: (isFirstBeat, monitor, bean) => Promise<void>
     * @param {number} parentInterval Parent monitor interval in seconds
     * @throws {TypeError} When the parent interval is not a positive number
     * @returns {void}
     */
    enqueue(monitor, bean, isFirstBeat, sendFn, parentInterval) {
        if (!Number.isFinite(parentInterval) || parentInterval <= 0) {
            throw new TypeError(`Invalid parent interval for monitor ${monitor.id}: ${parentInterval}`);
        }

        // Cancel any existing pending notification for this monitor
        this.cancel(monitor.id);

        // Calculate delay: parent's interval + 5s buffer, minimum 10s
        const delayMs = Math.max(10000, parentInterval * 1000 + 5000);

        log.info("notification-queue", `[${monitor.name}] Queuing notification for ${delayMs}ms (parent interval: ${parentInterval}s)`);

        const timer = setTimeout(async () => {
            this.pending.delete(monitor.id);
            await this.resolve(monitor, bean, isFirstBeat, sendFn);
        }, delayMs);

        // Don't let the timer prevent Node.js from exiting
        if (timer.unref) {
            timer.unref();
        }

        this.pending.set(monitor.id, { timer, monitor, bean, isFirstBeat, sendFn });
    }

    /**
     * Cancel a delayed notification after the child monitor recovers.
     * @param {number} monitorId Child monitor identifier
     * @returns {boolean} Whether a pending notification was cancelled
     */
    cancel(monitorId) {
        const entry = this.pending.get(monitorId);
        if (!entry) {
            return false;
        }
        clearTimeout(entry.timer);
        this.pending.delete(monitorId);
        log.info("notification-queue", `[${entry.monitor.name}] Cancelled delayed notification`);
        return true;
    }

    /**
     * Resolve a pending notification by checking parent status.
     * @param {object} monitor The child monitor
     * @param {object} bean The heartbeat bean
     * @param {boolean} isFirstBeat Whether this is the first beat
     * @param {Function} sendFn The send function
     * @returns {Promise<void>}
     */
    async resolve(monitor, bean, isFirstBeat, sendFn) {
        let parentHeartbeat;
        try {
            parentHeartbeat = await R.getRow(
                "SELECT status FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT 1",
                [monitor.parent]
            );
        } catch (e) {
            log.error("notification-queue", `[${monitor.name}] Parent status could not be read; sending without suppression: ${e.message}`);
            await sendFn(isFirstBeat, monitor, bean);
            return;
        }

        if (parentHeartbeat && parentHeartbeat.status === DOWN) {
            log.info("notification-queue", `[${monitor.name}] Notification SUPPRESSED: parent [#${monitor.parent}] is DOWN`);
            return;
        }

        // Parent is UP or PENDING or has no heartbeat — send the notification.
        // This call intentionally sits outside the database catch above: a
        // delivery failure must propagate once, never be retried as though the
        // parent lookup had failed and never be reduced to a log line.
        log.info("notification-queue", `[${monitor.name}] Parent is not DOWN, sending delayed notification`);
        await sendFn(isFirstBeat, monitor, bean);
    }

    /**
     * Flush all pending notifications immediately (used on shutdown).
     * Sends all queued notifications without checking parent status.
     * @returns {Promise<void>}
     */
    async flush() {
        log.info("notification-queue", `Flushing ${this.pending.size} pending notification(s)`);
        const entries = Array.from(this.pending.values());
        this.pending.clear();

        const failures = [];
        for (const entry of entries) {
            clearTimeout(entry.timer);
            try {
                await entry.sendFn(entry.isFirstBeat, entry.monitor, entry.bean);
            } catch (e) {
                log.error("notification-queue", `Failed to flush notification for [${entry.monitor.name}]: ${e.message}`);
                failures.push(new Error(`Failed to flush notification for monitor ${entry.monitor.id}`, { cause: e }));
            }
        }
        if (failures.length) {
            throw new AggregateError(failures, `${failures.length} delayed notification(s) failed during flush`);
        }
    }

    /**
     * Get the number of pending notifications.
     * @returns {number} Pending notification count
     */
    get size() {
        return this.pending.size;
    }
}

// Singleton instance
const notificationQueue = new NotificationQueue();

module.exports = {
    notificationQueue,
    NotificationQueue,
};
