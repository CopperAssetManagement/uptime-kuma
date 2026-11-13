const { R } = require("redbean-node");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
const { log, DOWN, UP } = require("../src/util");

/**
 * The monitor's persisted record of a DOWN notification that has not been
 * delivered: QUEUED while it waits for the parent check, SUPPRESSED once the
 * parent was found DOWN. NULL means there is no undelivered DOWN.
 */
const QUEUED = "queued";
const SUPPRESSED = "suppressed";
/** A suppressed DOWN re-checked after its parent's recovery, awaiting a fresh beat. */
const RECHECKING = "rechecking";

/** Node's longest timer (2^31 - 1 ms). */
const MAX_TIMEOUT_MS = 2147483647;

/** How long past its own interval a re-checked child may take to report a fresh beat. */
const FRESH_BEAT_MARGIN_MS = 60000;

/** How long shutdown waits for deliveries under way. */
const STOP_WAIT_MS = 10000;

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
        /** @type {Map<number, Promise<void>>} Resolutions under way (parent check and delivery) */
        this.inflight = new Map();
        /** Set on shutdown: nothing is scheduled or sent any more */
        this.stopped = false;
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

        if (!this.stopped) {
            // Calculate delay: parent's interval + 5s buffer, minimum 10s
            const delayMs = Math.max(10000, parentInterval * 1000 + 5000);
            log.info("notification-queue", `[${monitor.name}] Queuing notification for ${delayMs}ms (parent interval: ${parentInterval}s)`);

            // Registered before any await, so a recovery arriving meanwhile cancels it.
            const entry = { monitor, bean, isFirstBeat, sendFn, announcesOutage };
            entry.timer = this.timers.setTimeout(() => this.fire(entry), delayMs);
            // Don't let the timer prevent Node.js from exiting
            if (entry.timer.unref) {
                entry.timer.unref();
            }
            this.pending.set(monitor.id, entry);
        } else {
            // Shutting down: send nothing now; recorded as queued, it resumes on start.
            log.info("notification-queue", `[${monitor.name}] Holding a DOWN notification until the next start`);
        }

        if (announcesOutage) {
            await setWithheld(monitor.id, QUEUED);
        }
    }

    /**
     * A held notification's delay elapsed: resolve it, and let a recovery that
     * arrives meanwhile wait for the outcome (recover()).
     * @param {{monitor: object, bean: object, isFirstBeat: boolean, sendFn: Function, announcesOutage: boolean}} entry Held notification
     * @returns {Promise<void>}
     */
    async fire(entry) {
        const id = entry.monitor.id;
        if (this.pending.get(id) !== entry) {
            return;
        }
        this.pending.delete(id);
        const resolution = this.resolve(entry);
        this.inflight.set(id, resolution);
        try {
            await resolution;
        } catch (e) {
            log.error("notification-queue", `[${entry.monitor.name}] Delayed notification failed: ${e.message}`);
        } finally {
            if (this.inflight.get(id) === resolution) {
                this.inflight.delete(id);
            }
        }
    }

    /**
     * Resolve a held notification by checking the parent's latest status.
     * @param {{monitor: object, bean: object, isFirstBeat: boolean, sendFn: Function, announcesOutage: boolean}} entry Held notification
     * @returns {Promise<void>}
     */
    async resolve({ monitor, bean, isFirstBeat, sendFn, announcesOutage, since, freshBean }) {
        if (since !== undefined) {
            // A re-check after the parent's recovery decides on a fresh beat only.
            const fresh = freshBean ?? (await R.findOne("heartbeat", " monitor_id = ? AND time > ? ORDER BY time DESC ", [monitor.id, since]));
            if (!fresh) {
                log.info("notification-queue", `[${monitor.name}] No fresh beat since its parent recovered; its DOWN stays suppressed`);
                await setWithheld(monitor.id, SUPPRESSED);
                return;
            }
            if (fresh.status !== DOWN) {
                await setWithheld(monitor.id, null);
                return;
            }
            bean = fresh;
        }
        // A DOWN is sent only for a monitor that is still DOWN: one that
        // recovered meanwhile had its recovery withheld, so it sends nothing.
        let latestStatus = null;
        try {
            // getCell adds its own LIMIT 1.
            latestStatus = await R.getCell(
                "SELECT status FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC",
                [monitor.id]
            );
        } catch (e) {
            log.error("notification-queue", `[${monitor.name}] Own status could not be read; treating it as DOWN: ${e.message}`);
        }
        if (latestStatus !== null && latestStatus !== undefined && latestStatus !== DOWN) {
            log.info("notification-queue", `[${monitor.name}] Recovered before its parent check; nothing to send`);
            if (announcesOutage) {
                await setWithheld(monitor.id, null);
            }
            return;
        }
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
     * A resolution already under way is awaited first, so its outcome (sent or
     * suppressed) decides whether the recovery is announced.
     * @param {number} monitorId Child monitor identifier
     * @returns {Promise<boolean>} True when the outage's DOWN was never delivered,
     * so its recovery must not be announced either
     */
    async recover(monitorId) {
        if (this.clearTimer(monitorId)) {
            log.info("notification-queue", `[#${monitorId}] Cancelled delayed notification`);
        }
        const resolution = this.inflight.get(monitorId);
        if (resolution) {
            await resolution.catch(() => {});
        }
        const withheld = await R.getCell("SELECT cascade_down_withheld FROM monitor WHERE id = ?", [monitorId]);
        if (withheld) {
            await setWithheld(monitorId, null);
        }
        return Boolean(withheld);
    }

    /**
     * A DOWN was delivered without the queue (no cascade suppression, or its
     * parent is absent): the outage is announced, whatever an earlier one left.
     * @param {number} monitorId Monitor identifier
     * @returns {Promise<void>}
     */
    async delivered(monitorId) {
        await setWithheld(monitorId, null);
    }

    /**
     * The parent came UP: re-queue each opted-in child whose DOWN was
     * suppressed and which is still DOWN, through the parent check, so it is
     * sent once (or suppressed again if the parent is DOWN by then).
     * @param {object} parent The parent monitor that came UP
     * @param {Function} sendFn The send function
     * @param {Function} monitorById Returns a child monitor instance by id
     * @param {string} since The parent's stored UP heartbeat time (UTC)
     * @returns {Promise<void>}
     */
    async reannounceChildren(parent, sendFn, monitorById, since) {
        const children = await R.getCol(
            // Any recorded state: the atomic claim in reannounce() decides, so a
            // child whose state settles to SUPPRESSED meanwhile is not missed.
            "SELECT id FROM monitor WHERE parent = ? AND active = 1 AND suppress_on_parent_down = 1 AND cascade_down_withheld IS NOT NULL",
            [parent.id]
        );
        for (const id of children) {
            try {
                await this.reannounce(id, parent, sendFn, monitorById, since);
            } catch (e) {
                log.error("notification-queue", `[#${id}] Could not re-check its suppressed DOWN: ${e.message}`);
            }
        }
    }

    /**
     * Hold one child's suppressed DOWN again, claiming it atomically, so a
     * recovery that settles the child meanwhile wins.
     * @param {number} id Child monitor identifier
     * @param {object} parent The parent monitor that came UP
     * @param {Function} sendFn The send function
     * @param {Function} monitorById Returns a child monitor instance by id
     * @param {string} since The parent's stored UP heartbeat time (UTC)
     * @returns {Promise<void>}
     */
    async reannounce(id, parent, sendFn, monitorById, since) {
        const resolution = this.inflight.get(id);
        if (resolution) {
            await resolution.catch(() => {});
        }
        if (this.pending.has(id)) {
            // Its parent check runs after this UP was stored, so it sends.
            return;
        }
        const latest = await R.findOne("heartbeat", " monitor_id = ? ORDER BY time DESC ", [id]);
        if (!latest || latest.status !== DOWN) {
            // Not DOWN any more: its own recovery settles it, unannounced.
            return;
        }
        const child = await monitorById(id);
        if (!child) {
            return;
        }
        if (!Number.isFinite(parent.interval) || parent.interval <= 0) {
            throw new TypeError(`Invalid parent interval for monitor ${id}: ${parent.interval}`);
        }
        const entry = this.holdForFreshBeat(child, latest, sendFn, parent.interval, since);
        const claimed = await R.knex("monitor")
            .where({ id, cascade_down_withheld: SUPPRESSED })
            .update({ cascade_down_withheld: RECHECKING });
        if (!claimed) {
            // Settled meanwhile (its recovery, or another re-check): nothing to send.
            if (this.pending.get(id) === entry) {
                this.clearTimer(id);
            }
            return;
        }
        log.info("notification-queue", `[${child.name}] Parent [${parent.name}] is UP; waiting for a fresh beat to re-check its suppressed DOWN`);
    }

    /**
     * Hold a child's stale (outage-time) DOWN until it reports a heartbeat
     * newer than its parent's recovery, at most its own check interval (or
     * retry interval) plus a margin, and never less than the parent check.
     * @param {object} child The child monitor
     * @param {object} latest Its latest (stale DOWN) heartbeat
     * @param {Function} sendFn The send function
     * @param {number} parentInterval Parent monitor interval in seconds
     * @param {string} since The parent's UP heartbeat time (UTC)
     * @returns {object} The registered entry
     */
    holdForFreshBeat(child, latest, sendFn, parentInterval, since) {
        const childIntervalS = Math.max(Number(child.interval) || 0, Number(child.retryInterval) || 0);
        const delayMs = Math.min(
            MAX_TIMEOUT_MS,
            Math.max(10000, parentInterval * 1000 + 5000, childIntervalS * 1000 + FRESH_BEAT_MARGIN_MS)
        );
        const entry = { monitor: child, bean: latest, isFirstBeat: false, sendFn, announcesOutage: true, since };
        entry.timer = this.timers.setTimeout(() => this.fire(entry), delayMs);
        if (entry.timer.unref) {
            entry.timer.unref();
        }
        this.pending.set(child.id, entry);
        return entry;
    }

    /**
     * A monitor stored a heartbeat. A child re-checked after its parent's
     * recovery that is still DOWN on this fresh beat is resolved now (parent
     * check, then sent once) instead of at the end of its wait.
     * @param {number} monitorId Monitor identifier
     * @param {object} bean The stored heartbeat
     * @returns {Promise<void>}
     */
    async freshBeat(monitorId, bean) {
        const entry = this.pending.get(monitorId);
        if (!entry || entry.since === undefined || bean.status !== DOWN || !(String(bean.time) > String(entry.since))) {
            return;
        }
        this.timers.clearTimeout(entry.timer);
        // The triggering beat itself: re-querying could miss it where times
        // are stored at whole seconds (MariaDB DATETIME).
        entry.freshBean = bean;
        await this.fire(entry);
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
        if (this.pending.has(monitor.id) || this.inflight.has(monitor.id)) {
            return;
        }
        const withheld = await R.getCell("SELECT cascade_down_withheld FROM monitor WHERE id = ?", [monitor.id]);
        if (withheld !== QUEUED && withheld !== RECHECKING) {
            return;
        }
        const latest = await R.findOne("heartbeat", " monitor_id = ? ORDER BY time DESC ", [monitor.id]);
        if (!latest || latest.status !== DOWN) {
            // Stopped before the DOWN was stored, or recovered while stopped: nothing to send.
            await setWithheld(monitor.id, null);
            return;
        }
        if (withheld === RECHECKING) {
            // Its DOWN is from before the parent's recovery: wait for a fresh beat
            // again, newer than the parent's latest recovery.
            const since = await R.getCell(
                "SELECT MAX(time) FROM heartbeat WHERE monitor_id = ? AND important = 1 AND status = ?",
                [monitor.parent, UP]
            );
            log.info("notification-queue", `[${monitor.name}] Resuming a re-check held before the last stop`);
            this.holdForFreshBeat(monitor, latest, sendFn, parentInterval, since ?? R.isoDateTimeMillis(dayjs.utc()));
            return;
        }
        log.info("notification-queue", `[${monitor.name}] Resuming a DOWN notification held before the last stop`);
        await this.enqueue(monitor, latest, false, sendFn, parentInterval, true);
    }

    /**
     * Stop every timer without sending (used on shutdown, after the monitors
     * have stopped, before the database closes). Held DOWNs stay recorded as
     * queued and are resumed with their parent check on start; nothing is
     * scheduled afterwards. Resolutions already under way are awaited so their
     * outcome is recorded.
     * @returns {Promise<void>}
     */
    async stop() {
        this.stopped = true;
        log.info("notification-queue", `Stopping with ${this.pending.size} held notification(s); they resume on start`);
        for (const entry of this.pending.values()) {
            this.timers.clearTimeout(entry.timer);
        }
        this.pending.clear();
        // Bounded, so a hung provider cannot hold shutdown; an unrecorded
        // delivery is at worst sent once more after the restart.
        let timeout;
        await Promise.race([
            Promise.allSettled(this.inflight.values()),
            new Promise((resolve) => {
                timeout = this.timers.setTimeout(resolve, STOP_WAIT_MS);
            }),
        ]);
        this.timers.clearTimeout(timeout);
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
    RECHECKING,
};
