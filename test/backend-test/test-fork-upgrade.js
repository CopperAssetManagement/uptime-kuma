const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { R } = require("redbean-node");
const Database = require("../../server/database");
const TestDB = require("../mock-testdb");
const { Settings } = require("../../server/settings");

const migrations = path.resolve(__dirname, "../../db/knex_migrations");
const addedSince250 = [
    "2026-08-07-0000-add-sftp-monitor.js",
    "2026-08-18-0000-sqlite-only-drop-analytics-type-check.js",
];

test("2.5.0 fork upgrades automatically while preserving cascade settings and data", async () => {
    const testDb = new TestDB("./data/test-fork-upgrade");
    // Create the 2.5.0 schema plus our existing cascade migration. The initial
    // schema and all the remaining migrations are unchanged from that release.
    const legacyMigrations = (await fs.readdir(migrations))
        .filter((name) => name.endsWith(".js") && !addedSince250.includes(name)).sort();
    await fs.mkdir(testDb.dataDir, { recursive: true });
    Database.initDataDir({ "data-dir": testDb.dataDir });
    Database.dbConfig = { type: "sqlite" };
    Database.writeDBConfig(Database.dbConfig);
    await Database.connect(true);
    try {
        await Database.patchSqlite();
        await R.knex.migrate.latest({
            migrationSource: {
                getMigrations: async () => legacyMigrations,
                getMigrationName: (name) => name,
                getMigration: (name) => require(path.join(migrations, name)),
            },
        });
        await R.knex("user").insert({ id: 1, username: "upgrade-fixture", password: "unused-test-password" });
        await R.knex("monitor").insert([
            { id: 1, name: "parent", type: "ping", interval: 60, user_id: 1, suppress_on_parent_down: 0 },
            { id: 2, name: "child", type: "push", user_id: 1, parent: 1, suppress_on_parent_down: 1, interval: 60 },
        ]);
        await R.knex("heartbeat").insert({ monitor_id: 2, status: 1, time: "2026-10-31 12:00:00", msg: "healthy" });
        await R.knex("notification").insert({ id: 1, name: "existing notification", user_id: 1, config: '{"type":"webhook"}' });
        await R.knex("monitor_notification").insert({ monitor_id: 2, notification_id: 1 });
        await R.knex("setting").insert([
            { key: "test-preserved-setting", value: '"unchanged"' },
            { key: "migrateAggregateTableState", value: '"migrated"' },
        ]);
        await R.knex("status_page").insert({ slug: "test", title: "Existing status", icon: "/icon.svg", theme: "auto", analytics_type: "umami" });
        const tables = ["user", "monitor", "heartbeat", "notification", "monitor_notification", "setting", "status_page"];
        const before = {};
        for (const table of tables) {
            before[table] = await R.knex(table).select("*");
        }
        // Exercise the same startup migration entry point as server/server.js.
        await Database.patch();
        for (const table of tables) {
            const rows = await R.knex(table).select("*");
            for (let index = 0; index < rows.length; index++) {
                for (const [key, value] of Object.entries(before[table][index])) {
                    assert.deepEqual(rows[index][key], value, `${table}.${key} must survive upgrade`);
                }
            }
            assert.equal(rows.length, before[table].length, `${table} row count`);
        }
        const applied = await R.knex("knex_migrations").pluck("name");
        for (const name of addedSince250) {
            assert.ok(applied.includes(name), `${name} applied automatically`);
        }
        assert.equal(applied.filter((name) => name.includes("cascade-suppression")).length, 1);
        assert.equal(await R.knex.schema.hasColumn("monitor", "ssh_private_key"), true);
        await R.knex("status_page").where({ slug: "test" }).update({ analytics_type: "custom-analytics" });
        await Database.patch();
        assert.equal((await R.knex("monitor").where({ id: 2 }).first()).suppress_on_parent_down, 1);
    } finally {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    }
});
