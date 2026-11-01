process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, mock, before, after } = require("node:test");
const assert = require("node:assert");
const DomainExpiry = require("../../server/model/domain_expiry");
const mockWebhook = require("./notification-providers/mock-webhook");
const TestDB = require("../mock-testdb");
const { R } = require("redbean-node");
const { Notification } = require("../../server/notification");
const { Settings } = require("../../server/settings");
const { setSetting } = require("../../server/util-server");
const dayjs = require("dayjs");
const dns = require("node:dns");
const { retryExternalService } = require("./test-util");
dayjs.extend(require("dayjs/plugin/utc"));

const testDb = new TestDB();

/**
 * Control RDAP transport without depending on real registration renewals.
 * @param {import("node:test").TestContext} t Test context
 * @param {string} domain Domain queried by the production RDAP client
 * @param {string} expiry Registry expiration timestamp
 * @returns {object} Mutable registry fixture and request count
 */
function mockRegistry(t, domain, expiry) {
    const bootstrap = require("../../extra/rdap-dns.json");
    const suffix = domain.split(".").pop();
    const [, servers] = bootstrap.services.find(([suffixes]) => suffixes.includes(suffix));
    const fixture = { expiry, requests: 0 };
    t.mock.method(globalThis, "fetch", async (url) => {
        if (url === "https://data.iana.org/rdap/dns.json") {
            return new Response(JSON.stringify(bootstrap));
        }
        assert.strictEqual(url, `${servers[0]}domain/${domain}`);
        fixture.requests += 1;
        return new Response(JSON.stringify({
            objectClassName: "domain",
            ldhName: domain,
            events: [
                { eventAction: "registration", eventDate: "2013-11-26T12:00:00.000Z" },
                { eventAction: "expiration", eventDate: fixture.expiry },
            ],
        }));
    });
    return fixture;
}

describe("Domain Expiry", () => {
    const monHttpCom = {
        type: "http",
        url: "https://www.google.com",
        domainExpiryNotification: true,
    };

    before(async () => {
        await testDb.create();
        Notification.init();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("getExpiryDate() returns correct expiry date for .wiki domain with no A record", async (t) => {
        // Registrations renew. Control the registry response rather than pinning
        // this regression to a live domain's ever-changing expiration date.
        const registry = mockRegistry(t, "google.wiki", "2026-11-26T23:59:59.000Z");
        t.mock.method(dns, "lookup", () => {
            assert.fail("Domain expiry must use RDAP without resolving the domain's A record");
        });
        const d = DomainExpiry.createByName("google.wiki");
        assert.deepEqual(await d.getExpiryDate(), new Date("2026-11-26T23:59:59.000Z"));
        registry.expiry = "2027-11-26T23:59:59.000Z";
        assert.deepEqual(await d.getExpiryDate(), new Date("2027-11-26T23:59:59.000Z"));
        assert.strictEqual(registry.requests, 2);
        assert.strictEqual(dns.lookup.mock.callCount(), 0);
    });

    describe("checkSupport()", () => {
        test("allows and correctly parses http monitor with valid domain", async () => {
            const supportInfo = await DomainExpiry.checkSupport(monHttpCom);
            let expected = {
                domain: "google.com",
                tld: "com",
            };
            assert.deepStrictEqual(supportInfo, expected);
        });

        describe("Target Validation", () => {
            test("throws error for empty string target", async () => {
                const monitor = {
                    type: "http",
                    url: "",
                    domainExpiryNotification: true,
                };
                await assert.rejects(
                    async () => await DomainExpiry.checkSupport(monitor),
                    (error) => {
                        assert.strictEqual(error.constructor.name, "TranslatableError");
                        assert.strictEqual(error.message, "domain_expiry_unsupported_missing_target");
                        return true;
                    }
                );
            });

            test("throws error for undefined target", async () => {
                const monitor = {
                    type: "http",
                    domainExpiryNotification: true,
                };
                await assert.rejects(
                    async () => await DomainExpiry.checkSupport(monitor),
                    (error) => {
                        assert.strictEqual(error.constructor.name, "TranslatableError");
                        assert.strictEqual(error.message, "domain_expiry_unsupported_missing_target");
                        return true;
                    }
                );
            });

            test("throws error for null target", async () => {
                const monitor = {
                    type: "http",
                    url: null,
                    domainExpiryNotification: true,
                };
                await assert.rejects(
                    async () => await DomainExpiry.checkSupport(monitor),
                    (error) => {
                        assert.strictEqual(error.constructor.name, "TranslatableError");
                        assert.strictEqual(error.message, "domain_expiry_unsupported_missing_target");
                        return true;
                    }
                );
            });
        });

        describe("Domain Parsing", () => {
            test("throws error for non-ICANN TLD (e.g. .local)", async () => {
                const monitor = {
                    type: "http",
                    url: "https://example.local",
                    domainExpiryNotification: true,
                };
                await assert.rejects(
                    async () => await DomainExpiry.checkSupport(monitor),
                    (error) => {
                        assert.strictEqual(error.constructor.name, "TranslatableError");
                        assert.strictEqual(error.message, "domain_expiry_unsupported_is_icann");
                        return true;
                    }
                );
            });
        });

        describe("Edge Cases & RDAP Support", () => {
            test("handles subdomain correctly", async () => {
                const monitor = {
                    type: "http",
                    url: "https://api.staging.example.com/v1/users",
                    domainExpiryNotification: true,
                };
                const supportInfo = await DomainExpiry.checkSupport(monitor);
                assert.strictEqual(supportInfo.domain, "example.com");
                assert.strictEqual(supportInfo.tld, "com");
            });

            test("supports multi-level public suffix via RDAP fallback (e.g. com.br)", async () => {
                await retryExternalService(async () => {
                    const monitor = {
                        type: "http",
                        url: "https://record.com.br",
                        domainExpiryNotification: true,
                    };
                    const supportInfo = await DomainExpiry.checkSupport(monitor);
                    assert.strictEqual(supportInfo.domain, "record.com.br");
                    assert.strictEqual(supportInfo.tld, "br");
                });
            });

            test("handles complex subdomain correctly", async () => {
                const monitor = {
                    type: "http",
                    url: "https://mail.subdomain.example.org",
                    domainExpiryNotification: true,
                };
                const supportInfo = await DomainExpiry.checkSupport(monitor);
                assert.strictEqual(supportInfo.domain, "example.org");
                assert.strictEqual(supportInfo.tld, "org");
            });

            test("handles URL with port correctly", async () => {
                const monitor = {
                    type: "http",
                    url: "https://example.com:8080/api",
                    domainExpiryNotification: true,
                };
                const supportInfo = await DomainExpiry.checkSupport(monitor);
                assert.strictEqual(supportInfo.domain, "example.com");
                assert.strictEqual(supportInfo.tld, "com");
            });

            test("handles URL with query parameters correctly", async () => {
                const monitor = {
                    type: "http",
                    url: "https://example.com/search?q=test&page=1",
                    domainExpiryNotification: true,
                };
                const supportInfo = await DomainExpiry.checkSupport(monitor);
                assert.strictEqual(supportInfo.domain, "example.com");
                assert.strictEqual(supportInfo.tld, "com");
            });
        });
    });

    test("findByDomainNameOrCreate() retrieves expiration date for .com domain from RDAP", async (t) => {
        const registry = mockRegistry(t, "google.com", "2028-09-14T04:00:00.000Z");
        const domain = await DomainExpiry.findByDomainNameOrCreate("google.com");
        const expiryFromRdap = await domain.getExpiryDate();
        assert.deepEqual(expiryFromRdap, new Date("2028-09-14T04:00:00.000Z"));
        assert.strictEqual(registry.requests, 1);
    });

    test("checkExpiry() caches expiration date in database", async (t) => {
        const registry = mockRegistry(t, "google.com", "2028-09-14T04:00:00.000Z");
        await DomainExpiry.checkExpiry("google.com");
        const domain = await DomainExpiry.findByName("google.com");
        assert(dayjs.utc().diff(dayjs.utc(domain.lastCheck), "second") < 5);
        assert.deepEqual(new Date(domain.expiry), new Date("2028-09-14T04:00:00.000Z"));
        assert.strictEqual(registry.requests, 1);
    });

    test("sendNotifications() triggers notification for expiring domain", async () => {
        await DomainExpiry.findByName("google.com");
        const hook = {
            port: 3010,
            url: "capture",
        };
        const manyDays = 3650;
        await setSetting("domainExpiryNotifyDays", [manyDays], "general");
        const notif = R.convertToBean("notification", {
            config: JSON.stringify({
                type: "webhook",
                httpMethod: "post",
                webhookContentType: "json",
                webhookURL: `http://127.0.0.1:${hook.port}/${hook.url}`,
            }),
            active: 1,
            user_id: 1,
            name: "Testhook",
        });
        const [, data] = await Promise.all([
            DomainExpiry.sendNotifications("google.com", [notif]),
            mockWebhook(hook.port, hook.url),
        ]);
        assert.match(data.msg, /will expire in/);
    });

    test("sendNotifications() handles domain with null expiry without sending NaN", async () => {
        // Regression test for bug: "Domain name will expire in NaN days"
        // Mock findByDomainNameOrCreate to return a bean with null expiry
        const mockDomain = {
            domain: "test-null.com",
            expiry: null,
            lastExpiryNotificationSent: null,
        };

        mock.method(DomainExpiry, "findByDomainNameOrCreate", async () => mockDomain);

        try {
            const hook = {
                port: 3012,
                url: "should-not-be-called-null",
            };

            const notif = {
                name: "TestNullExpiry",
                config: JSON.stringify({
                    type: "webhook",
                    httpMethod: "post",
                    webhookContentType: "json",
                    webhookURL: `http://127.0.0.1:${hook.port}/${hook.url}`,
                }),
            };

            // Race between sendNotifications and mockWebhook timeout
            // If webhook is called, we fail. If it times out, we pass.
            const result = await Promise.race([
                DomainExpiry.sendNotifications("test-null.com", [notif]),
                mockWebhook(hook.port, hook.url, 500)
                    .then(() => {
                        throw new Error("Webhook was called but should not have been for null expiry");
                    })
                    .catch((e) => {
                        if (e.reason === "Timeout") {
                            return "timeout"; // Expected - webhook was not called
                        }
                        throw e;
                    }),
            ]);

            assert.ok(result === undefined || result === "timeout", "Should not send notification for null expiry");
        } finally {
            mock.restoreAll();
        }
    });

    test("sendNotifications() handles domain with undefined expiry without sending NaN", async () => {
        try {
            // Mock findByDomainNameOrCreate to return a bean with undefined expiry (newly created bean scenario)
            const mockDomain = {
                domain: "test-undefined.com",
                expiry: undefined,
                lastExpiryNotificationSent: null,
            };

            mock.method(DomainExpiry, "findByDomainNameOrCreate", async () => mockDomain);

            const hook = {
                port: 3013,
                url: "should-not-be-called-undefined",
            };

            const notif = {
                name: "TestUndefinedExpiry",
                config: JSON.stringify({
                    type: "webhook",
                    httpMethod: "post",
                    webhookContentType: "json",
                    webhookURL: `http://127.0.0.1:${hook.port}/${hook.url}`,
                }),
            };

            // Race between sendNotifications and mockWebhook timeout
            // If webhook is called, we fail. If it times out, we pass.
            const result = await Promise.race([
                DomainExpiry.sendNotifications("test-undefined.com", [notif]),
                mockWebhook(hook.port, hook.url, 500)
                    .then(() => {
                        throw new Error("Webhook was called but should not have been for undefined expiry");
                    })
                    .catch((e) => {
                        if (e.reason === "Timeout") {
                            return "timeout"; // Expected - webhook was not called
                        }
                        throw e;
                    }),
            ]);

            assert.ok(
                result === undefined || result === "timeout",
                "Should not send notification for undefined expiry"
            );
        } finally {
            mock.restoreAll();
        }
    });
});
