const { describe, test } = require("node:test");
const assert = require("node:assert");
const dayjs = require("dayjs");

const { SQL_DATETIME_FORMAT } = require("../../src/util");

/**
 * Retries a test function with exponential backoff for external service reliability.
 * Propagates the last failure when all retries are exhausted.
 * @param {Function} testFn - Async function to retry
 * @param {number} maxAttempts - Maximum number of retry attempts (default: 5)
 * @returns {Promise<void>}
 */
async function retryExternalService(testFn, maxAttempts = 5) {
    console.warn(`[WARN] It is better to reimplement the test to avoid relying on external services.`);

    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await testFn();
            return; // Success, exit retry loop
        } catch (error) {
            lastError = error;
            // Wait a bit before retrying with exponential backoff
            if (attempt < maxAttempts) {
                await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
            }
        }
    }
    throw lastError;
}

module.exports = { retryExternalService };

dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

describe("Server Utilities", () => {
    test("SQL_DATETIME_FORMAT constant matches MariaDB/MySQL format", () => {
        assert.strictEqual(SQL_DATETIME_FORMAT, "YYYY-MM-DD HH:mm:ss");
    });

    test("SQL_DATETIME_FORMAT produces valid SQL datetime string", () => {
        const current = dayjs.utc("2025-12-19T01:04:02.129Z");
        const sqlFormat = current.utc().format(SQL_DATETIME_FORMAT);

        assert.strictEqual(sqlFormat, "2025-12-19 01:04:02");

        // Verify it can be parsed back
        const parsedDate = dayjs.utc(sqlFormat, SQL_DATETIME_FORMAT);
        assert.strictEqual(parsedDate.unix(), current.unix());
    });
});


describe("External service retries", () => {
    test("propagates an exhausted assertion failure", async () => {
        const failure = new assert.AssertionError({ message: "incorrect expiry" });
        let attempts = 0;
        await assert.rejects(retryExternalService(async () => {
            attempts += 1;
            throw failure;
        }, 1), (error) => error === failure);
        assert.strictEqual(attempts, 1);
    });

    test("returns after success without another attempt", async () => {
        let attempts = 0;
        await retryExternalService(async () => {
            attempts += 1;
        });
        assert.strictEqual(attempts, 1);
    });
});
