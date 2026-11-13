const { R } = require("redbean-node");
const { log, DOWN } = require("../src/util");

/**
 * The monitor's persisted record of a DOWN notification that has not been
 * delivered: QUEUED while it waits for the parent check, SUPPRESSED once the
 * parent was found DOWN. NULL means there is no undelivered DOWN.
 */
const QUEUED = "queued";
const SUPPRESSED = "suppressed";

/**
 * Delayed notification queue for cascade suppression.
 *
 * When a child monitor with suppressOnParentDown=true goes DOWN, the
 * notification is held for the parent's interval plus a buffer. Then the
 * parent's latest heartbeat is checked: if the parent is also DOWN, the child
 * notification is suppressed, otherwise it is sent.
 *
 * Whether the outage's DOWN was delivered is persisted on the monitor row
 * (monitor.cascade_down_withheld), so it survives a restart:
 * - the recovery UP is sent only when its DOWN was delivered (no orphan "Up");
 * - a shutdown sends nothing; a DOWN still waiting for its parent check is
 *   resumed, with the parent check, when the monitor starts again.
 */
class NotificationQueue {

    /**
     * Create an empty delayed-notification queue.
     * @param {{setTimeout: Function, clearTimeout: Function}} timers Timer functions (tests substitute their own)
     */
    constructor(timers = globalThis) {
        this.timers = timers;
        /** @type {Map<number, {timer: NodeJS.Timeout, monitor: object, bean: object, isFirstBeat: boolean, sendFn: Function, announcesOutage: boolean}>} */
        this.pending = new Map();
    }

    /**
     * Hold a DOWN notification for a delayed parent check.
     * Only one pending notification per monitor — newer replaces older.
     * @param {object} monitor The child monitor instance
     * @param {object} bean The heartbeat bean
     * @param {boolean} isFirstBeat Whether this is the first beat
     * @param {Function} sendFn The function to call if notification should send: (isFirstBeat, monitor, bean) => Promise<void>
     * @param {number} parentInterval Parent monitor interval in seconds
     * @param {boolean} announcesOutage True for the outage's first DOWN, false for a resend
     * @throws {TypeError} When the parent interval is not a positive number
     * @returns {Promise<void>}
     */
    async enqueue(monitor, bean, isFirstBeat, sendFn, parentInterval, announcesOutage = true) {
        if (!Number.isFinite(parentInterval) || parentInterval <= 0) {
            throw new TypeError(`Invalid parent interval for monitor ${monitor.id}: ${parentInterval}`);
        }

        // A resend that replaces a still-pending first DOWN still announces the outage.
        const replaced = this.pending.get(monitor.id);
        announcesOutage = announcesOutage || Boolean(replaced?.announcesOutage);
        this.clearTimer(monitor.id);

        if (announcesOutage) {
            await setWithheld(monitor.id, QUEUED);
        }

        // Calculate delay: parent's interval + 5s buffer, minimum 10s
        const delayMs = Math.max(10000, parentInterval * 1000 + 5000);

        log.info("notification-queue", `[${monitor.name}] Queuing notification for ${delayMs}ms (parent interval: ${parentInterval}s)`);

        const entry = { monitor, bean, isFirstBeat, sendFn, announcesOutage };
        entry.timer = this.timers.setTimeout(async () => {
            this.pending.delete(monitor.id);
            try {
                await this.resolve(entry);
            } catch (e) {
                log.error("notification-queue", `[${monitor.name}] Delayed notification failed: ${e.message}`);
            }
        }, delayMs);

        // Don't let the timer prevent Node.js from exiting
        if (entry.timer.unref) {
            entry.timer.unref();
        }

        this.pending.set(monitor.id, entry);
    }

    /**
     * Resolve a held notification by checking the parent's latest status.
     * @param {{monitor: object, bean: object, isFirstBeat: boolean, sendFn: Function, announcesOutage: boolean}} entry Held notification
     * @returns {Promise<void>}
     */
    async resolve({ monitor, bean, isFirstBeat, sendFn, announcesOutage }) {
        let parentHeartbeat;
        try {
            parentHeartbeat = await R.getRow(
                "SELECT status FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT 1",
                [monitor.parent]
            );
        } catch (e) {
            log.error("notification-queue", `[${monitor.name}] Parent status could not be read; sending without suppression: ${e.message}`);
            await this.deliver(monitor, bean, isFirstBeat, sendFn);
            return;
        }

        if (parentHeartbeat && parentHeartbeat.status === DOWN) {
            log.info("notification-queue", `[${monitor.name}] Notification SUPPRESSED: parent [#${monitor.parent}] is DOWN`);
            if (announcesOutage) {
                await setWithheld(monitor.id, SUPPRESSED);
            }
            return;
        }

        // Parent is UP or PENDING or has no heartbeat — send the notification.
        log.info("notification-queue", `[${monitor.name}] Parent is not DOWN, sending delayed notification`);
        await this.deliver(monitor, bean, isFirstBeat, sendFn);
    }

    /**
     * Send a DOWN notification, then record that the outage was announced.
     * A delivery failure propagates once and leaves the outage unannounced.
     * @param {object} monitor The child monitor
     * @param {object} bean The heartbeat bean
     * @param {boolean} isFirstBeat Whether this is the first beat
     * @param {Function} sendFn The send function
     * @returns {Promise<void>}
     */
    async deliver(monitor, bean, isFirstBeat, sendFn) {
        await sendFn(isFirstBeat, monitor, bean);
        await setWithheld(monitor.id, null);
    }

    /**
     * The child left DOWN: cancel any held notification and settle the outage.
     * @param {number} monitorId Child monitor identifier
     * @returns {Promise<boolean>} True when the outage's DOWN was never delivered,
     * so its recovery must not be announced either
     */
    async recover(monitorId) {
        if (this.clearTimer(monitorId)) {
            log.info("notification-queue", `[#${monitorId}] Cancelled delayed notification`);
        }
        const withheld = await R.getCell("SELECT cascade_down_withheld FROM monitor WHERE id = ?", [monitorId]);
        if (withheld) {
            await setWithheld(monitorId, null);
        }
        return Boolean(withheld);
    }

    /**
     * Resume a DOWN that was still waiting for its parent check when the
     * monitor last stopped (e.g. a restart), so it is neither lost nor sent
     * without the check.
     * @param {object} monitor The child monitor instance, starting
     * @param {Function} sendFn The send function
     * @param {number} parentInterval Parent monitor interval in seconds
     * @returns {Promise<void>}
     */
    async resume(monitor, sendFn, parentInterval) {
        if (this.pending.has(monitor.id)) {
            return;
        }
        const withheld = await R.getCell("SELECT cascade_down_withheld FROM monitor WHERE id = ?", [monitor.id]);
        if (withheld !== QUEUED) {
            return;
        }
        const latest = await R.findOne("heartbeat", " monitor_id = ? ORDER BY time DESC ", [monitor.id]);
        if (!latest || latest.status !== DOWN) {
            // It recovered while stopped; its DOWN was never delivered, so stays withheld
            // until the next beat settles it (recover()).
            return;
        }
        log.info("notification-queue", `[${monitor.name}] Resuming a DOWN notification held before the last stop`);
        await this.enqueue(monitor, latest, false, sendFn, parentInterval, true);
    }

    /**
     * Stop every timer without sending (used on shutdown). Held DOWNs stay
     * recorded as queued and are resumed with their parent check on start.
     * @returns {void}
     */
    stop() {
        log.info("notification-queue", `Stopping with ${this.pending.size} held notification(s); they resume on start`);
        for (const entry of this.pending.values()) {
            this.timers.clearTimeout(entry.timer);
        }
        this.pending.clear();
    }

    /**
     * Clear a monitor's pending timer.
     * @param {number} monitorId Child monitor identifier
     * @returns {boolean} Whether a pending notification was cleared
     */
    clearTimer(monitorId) {
        const entry = this.pending.get(monitorId);
        if (!entry) {
            return false;
        }
        this.timers.clearTimeout(entry.timer);
        this.pending.delete(monitorId);
        return true;
    }

    /**
     * Get the number of pending notifications.
     * @returns {number} Pending notification count
     */
    get size() {
        return this.pending.size;
    }
}

/**
 * Persist the monitor's undelivered-DOWN state.
 * @param {number} monitorId Monitor identifier
 * @param {(string|null)} state QUEUED, SUPPRESSED or null
 * @returns {Promise<void>}
 */
async function setWithheld(monitorId, state) {
    await R.exec("UPDATE monitor SET cascade_down_withheld = ? WHERE id = ?", [state, monitorId]);
}

// Singleton instance
const notificationQueue = new NotificationQueue();

module.exports = {
    notificationQueue,
    NotificationQueue,
    QUEUED,
    SUPPRESSED,
};
