const { describe, test, mock } = require("node:test");
const assert = require("node:assert/strict");
const Heartbeat = require("../../server/model/heartbeat");

const SHA = "34523213ee76c312d77340746993e7899cd92294";
const TIME = "2026-10-21 18:24:08.792";
const MESSAGE = `PASS ${SHA} source=github.com`;

/**
 * Serialize a heartbeat without depending on a database.
 * @param {object} overrides Heartbeat attributes
 * @param {boolean} optIn Whether this monitor publishes deployment receipts
 * @returns {object} Public heartbeat
 */
function serialize(overrides = {}, optIn = true) {
    return Heartbeat.prototype.toPublicJSON.call({ status: 1, time: TIME, msg: MESSAGE, ping: null, ...overrides }, optIn);
}

describe("Public deployment receipts", () => {
    test("publishes only SHA, fixed source and the corresponding heartbeat timestamp", () => {
        assert.deepEqual(serialize(), {
            status: 1, time: TIME, msg: "", ping: null,
            deploymentReceipt: { sha: SHA, source: "github.com", time: TIME },
        });
    });

    test("ordinary monitors and serializers keep the complete message private", () => {
        assert.equal(serialize({}, false).deploymentReceipt, undefined);
        assert.equal(Heartbeat.prototype.toPublicJSON.call({ status: 1, time: TIME, msg: MESSAGE }).deploymentReceipt, undefined);
        assert.equal(serialize({}, "true").deploymentReceipt, undefined);
    });

    test("rejects failures, malformed receipts and appended private data", () => {
        for (const msg of [
            "private diagnostic value", `FAIL ${SHA} source=github.com`,
            `PASS ${SHA.slice(0, 7)} source=github.com`, `PASS ${SHA.toUpperCase()} source=github.com`,
            `PASS ${SHA} source=github.com.evil`, `PASS ${SHA} source=gitlab.com`,
            `${MESSAGE}\n`, `${MESSAGE}\r\n`, `${MESSAGE}\nprivate diagnostic value`,
            `${MESSAGE} private diagnostic value`, `prefix ${MESSAGE}`, "", null, {},
        ]) {
            const data = serialize({ msg });
            assert.equal(data.deploymentReceipt, undefined);
            assert.equal(data.msg, "");
        }
        for (const status of [0, 2, 3]) {
            assert.equal(serialize({ status }).deploymentReceipt, undefined);
        }
    });

    test("public polling API requires the exact tag on a public push monitor", async () => {
        const { R } = require("redbean-node");
        const Dialect = require("knex/lib/dialects/sqlite3");
        Dialect.prototype._driver = () => require("@louislam/sqlite3");
        const db = require("knex")({ client: Dialect, connection: { filename: ":memory:" }, useNullAsDefault: true });
        R.setup(db);
        R.modelList.heartbeat = Heartbeat;
        const { UptimeKumaServer } = require("../../server/uptime-kuma-server");
        const StatusPage = require("../../server/model/status_page");
        const { UptimeCalculator } = require("../../server/uptime-calculator");
        const apicache = require("../../server/modules/apicache");
        mock.method(UptimeKumaServer, "getInstance", () => ({}));
        mock.method(StatusPage, "slugToID", async () => 1);
        mock.method(UptimeCalculator, "getUptimeCalculator", async () => ({ get24Hour: () => ({ uptime: 1 }) }));
        const app = require("express")();
        app.use(require("../../server/routers/status-page-router"));
        let listener;
        try {
            await db.schema.createTable("monitor", (table) => {
                table.integer("id");
                table.string("type");
            });
            await db.schema.createTable("group", (table) => {
                table.integer("id");
                table.integer("public");
                table.integer("status_page_id");
            });
            await db.schema.createTable("monitor_group", (table) => {
                table.integer("monitor_id");
                table.integer("group_id");
            });
            await db.schema.createTable("tag", (table) => {
                table.integer("id");
                table.string("name");
            });
            await db.schema.createTable("monitor_tag", (table) => {
                table.integer("monitor_id");
                table.integer("tag_id");
                table.string("value");
            });
            await db.schema.createTable("heartbeat", (table) => {
                table.integer("monitor_id");
                table.integer("status");
                table.string("time");
                table.string("msg");
                table.integer("ping");
            });
            await db("group").insert([{ id: 1, public: 1, status_page_id: 1 }, { id: 2, public: 0, status_page_id: 1 }, { id: 3, public: 1, status_page_id: 2 }]);
            await db("tag").insert([{ id: 1, name: "public-deployment-receipt" }, { id: 2, name: "infra" }]);
            // Untagged push, opted-in push, opted-in HTTP, wrong value/name,
            // private group and a different status page, respectively.
            for (let id = 1; id <= 8; id++) {
                await db("monitor").insert({ id, type: id === 3 ? "http" : "push" });
                await db("monitor_group").insert({ monitor_id: id, group_id: id === 6 ? 2 : id === 7 ? 3 : 1 });
                if (id !== 1) {
                    await db("monitor_tag").insert({ monitor_id: id, tag_id: id === 5 ? 2 : 1, value: id === 4 ? "elsewhere" : "github.com" });
                }
                await db("heartbeat").insert({ monitor_id: id, status: 1, time: TIME, msg: id === 8 ? `${MESSAGE}\nprivate diagnostic value` : MESSAGE, ping: null });
            }
            listener = await new Promise((resolve) => {
                const socket = app.listen(0, "127.0.0.1", () => resolve(socket));
            });
            const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/status-page/heartbeat/test`);
            assert.equal(response.status, 200);
            const body = await response.json();
            assert.deepEqual(Object.keys(body.heartbeatList), ["1", "2", "3", "4", "5", "8"]);
            for (const [id, heartbeats] of Object.entries(body.heartbeatList)) {
                assert.equal(heartbeats[0].msg, "");
                assert.deepEqual(heartbeats[0].deploymentReceipt, id === "2" ? { sha: SHA, source: "github.com", time: TIME } : undefined);
            }
            assert.equal(JSON.stringify(body).includes("private diagnostic value"), false);
        } finally {
            if (listener) {
                await new Promise((resolve) => listener.close(resolve));
            }
            for (const key of apicache.getIndex().all) {
                apicache.clear(key);
            }
            mock.restoreAll();
            await db.destroy();
        }
    });
});
