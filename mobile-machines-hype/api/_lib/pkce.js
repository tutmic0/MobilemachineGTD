const { getPool } = require("./db");

// 10 minutes -- plenty of time for an X login, short enough that stale
// rows don't pile up (they're also always deleted on first read below).
async function stash(state, verifier) {
  const pool = getPool();
  await pool.query(
    `insert into pkce_stash (state, verifier, created_at)
     values ($1, $2, now())
     on conflict (state) do update set verifier = excluded.verifier, created_at = now()`,
    [state, verifier]
  );
}

// One-time use: deletes the row as it reads it, and only returns a
// verifier if it hasn't expired.
async function take(state) {
  const pool = getPool();
  const { rows } = await pool.query(
    `delete from pkce_stash
     where state = $1 and created_at > now() - interval '600 seconds'
     returning verifier`,
    [state]
  );
  return rows[0] ? rows[0].verifier : null;
}

module.exports = { stash, take };
