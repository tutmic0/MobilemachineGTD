const { sendJson } = require("./_lib/respond");
const { getPool } = require("./_lib/db");
const { countWinners } = require("./_lib/signups");
const config = require("./_lib/config");

module.exports = async (req, res) => {
  try {
    const pool = getPool();
    const totalWinners = await countWinners(pool);
    return sendJson(res, 200, { ok: true, totalWinners, maxWinners: config.MAX_WINNERS });
  } catch (err) {
    return sendJson(res, 200, { ok: false, error: "exception" });
  }
};
