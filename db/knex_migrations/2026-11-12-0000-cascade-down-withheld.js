// Records a cascade-suppressed monitor's DOWN notification that has not been
// delivered ("queued" or "suppressed"), so a restart neither sends it without
// the parent check nor announces a recovery whose DOWN was never sent.
exports.up = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.string("cascade_down_withheld", 20).nullable().defaultTo(null);
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.dropColumn("cascade_down_withheld");
    });
};
