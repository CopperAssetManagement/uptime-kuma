const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { R } = require("redbean-node");
const passwordHash = require("../../server/password-hash");
const { loginByAPIKey, apiKeyID } = require("../../server/auth");

// A hash made by Python's bcrypt ($2b$), the format an external issuer such as
// Platform's Kuma converge installs; the secret is a test value.
const PYTHON_SECRET = "python-issued-test-secret-0123456789abcdef";
const PYTHON_HASH = "$2b$10$hJZGBmIvnyY.2qX8bpX4zegK0ynnrj/hdvL06ADSvPNU4botdLabK";
const SECRET = "kuma-issued-test-secret-abcdefghijklmnopqrstuvwxyz";

let db;

/**
 * Insert one API key row
 * @param {object} row Column overrides
 * @returns {Promise<void>}
 */
async function addKey(row) {
    await db("api_key").insert({ name: "test", user_id: 1, active: 1, expires: null, ...row });
}

describe("Login by API key", () => {
    before(async () => {
        const Dialect = require("knex/lib/dialects/sqlite3");
        Dialect.prototype._driver = () => require("@louislam/sqlite3");
        db = require("knex")({ client: Dialect, connection: { filename: ":memory:" }, useNullAsDefault: true });
        R.setup(db);
        await db.schema.createTable("user", (table) => {
            table.increments("id");
            table.string("username");
            table.string("password");
            table.boolean("active");
        });
        await db.schema.createTable("api_key", (table) => {
            table.increments("id");
            table.string("key");
            table.string("name");
            table.integer("user_id");
            table.boolean("active");
            table.datetime("expires");
        });
        await db("user").insert([
            { id: 1, username: "owner", password: "x", active: 1 },
            { id: 2, username: "former", password: "x", active: 0 },
        ]);
        const hash = await passwordHash.generate(SECRET);
        await addKey({ id: 10, key: hash });
        await addKey({ id: 11, key: PYTHON_HASH, expires: "2999-01-01 00:00:00" });
        await addKey({ id: 12, key: hash, active: 0 });
        await addKey({ id: 13, key: hash, expires: "2000-01-01 00:00:00" });
        await addKey({ id: 14, key: hash, user_id: 2 });
    });

    after(async () => {
        await db.destroy();
    });

    test("a valid key logs in as the active user that owns it", async () => {
        assert.equal((await loginByAPIKey(`uk10_${SECRET}`)).username, "owner");
    });

    test("accepts a $2b$ hash installed by an external issuer", async () => {
        assert.equal((await loginByAPIKey(`uk11_${PYTHON_SECRET}`)).username, "owner");
    });

    test("refuses a wrong secret, a key of another ID and an unknown ID", async () => {
        assert.equal(await loginByAPIKey(`uk10_${SECRET}x`), null);
        assert.equal(await loginByAPIKey(`uk11_${SECRET}`), null);
        assert.equal(await loginByAPIKey(`uk99_${SECRET}`), null);
    });

    test("refuses a revoked or expired key, and a key whose user is inactive", async () => {
        assert.equal(await loginByAPIKey(`uk12_${SECRET}`), null);
        assert.equal(await loginByAPIKey(`uk13_${SECRET}`), null);
        assert.equal(await loginByAPIKey(`uk14_${SECRET}`), null);
    });

    test("refuses malformed keys without querying a secret", async () => {
        for (const key of [
            undefined,
            null,
            10,
            {},
            "",
            "uk10",
            "uk10_",
            "ukx_secret",
            `10_${SECRET}`,
            `UK10_${SECRET}`,
        ]) {
            assert.equal(await loginByAPIKey(key), null);
        }
    });

    test("a key deleted after verification logs in nobody", async () => {
        const original = R.findOne;
        let reads = 0;
        R.findOne = async (...args) => (args[0] === "api_key" && ++reads === 2 ? null : original.apply(R, args));
        try {
            assert.equal(await loginByAPIKey(`uk10_${SECRET}`), null);
        } finally {
            R.findOne = original;
        }
    });

    test("a session opened with an API key cannot manage API keys", () => {
        const { checkNotAPIKeySession } = require("../../server/auth");
        assert.throws(() => checkNotAPIKeySession({ apiKeyID: 10 }), /cannot be managed/);
        assert.doesNotThrow(() => checkNotAPIKeySession({ apiKeyID: null }));
        assert.doesNotThrow(() => checkNotAPIKeySession({}));
    });

    test("revoking a key disconnects exactly the sessions it opened", () => {
        const { UptimeKumaServer } = require("../../server/uptime-kuma-server");
        const session = (apiKeyID) => ({
            apiKeyID,
            events: [],
            emit(e) {
                this.events.push(e);
            },
            disconnect() {
                this.events.push("disconnect");
            },
        });
        const sockets = [session(10), session(11), session(null), session(undefined)];
        UptimeKumaServer.prototype.disconnectAPIKeySessions.call(
            { io: { sockets: { sockets: new Map(sockets.map((s, i) => [i, s])) } } },
            "10"
        );
        assert.deepEqual(
            sockets.map((s) => s.events.length),
            [2, 0, 0, 0]
        );
    });

    test("log lines name only the key ID", () => {
        assert.equal(apiKeyID(`uk10_${SECRET}`), "10");
        assert.equal(apiKeyID("not-a-key"), null);
    });
});
