const { Pool } = require("pg");

let pool;

// Serverless-friendly: a small pool, reused across invocations of the
// same warm function instance, created lazily on first use.
function getPool() {
  if (!pool) {
    const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "Missing POSTGRES_URL environment variable -- add a Postgres database " +
        "to this Vercel project (Storage tab) or set POSTGRES_URL/DATABASE_URL yourself."
      );
    }
    pool = new Pool({
      connectionString,
      ssl: connectionString.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000,
    });
  }
  return pool;
}

module.exports = { getPool };
