const { getPool } = require("./db");

// Must be called with a client that's inside a transaction that also
// took the row lock (see withTransaction + "for update" below) --
// otherwise two concurrent first-time calls for the same brand-new
// handle could both try to insert and one would just fail on the
// primary key instead of seeing the other's row.
async function getOrCreate(client, handle) {
  const existing = await client.query("select * from signups where handle = $1 for update", [handle]);
  if (existing.rows[0]) return existing.rows[0];
  const inserted = await client.query(
    `insert into signups (handle) values ($1)
     on conflict (handle) do update set handle = excluded.handle
     returning *`,
    [handle]
  );
  return inserted.rows[0];
}

function spinsAvailable(row) {
  const earned = Number(row.action_spins || 0) + Number(row.code_spins || 0);
  const used = Number(row.spins_used || 0);
  return Math.max(0, earned - used);
}

async function withTransaction(fn) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (e) { /* connection may already be broken -- ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function countWinners(clientOrPool) {
  const { rows } = await clientOrPool.query("select winners_count from campaign_state where id = 1");
  return rows[0] ? Number(rows[0].winners_count) : 0;
}

module.exports = { getOrCreate, spinsAvailable, withTransaction, countWinners };
