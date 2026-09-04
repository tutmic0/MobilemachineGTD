const { readJsonBody, sendJson } = require("./_lib/respond");
const { verifySessionToken } = require("./_lib/crypto");
const config = require("./_lib/config");
const { spinsAvailable, withTransaction } = require("./_lib/signups");

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  if (config.ENROLLMENT_CLOSED) return sendJson(res, 200, { ok: false, error: "closed" });

  const body = await readJsonBody(req);
  const handle = verifySessionToken(body.token);
  if (!handle) return sendJson(res, 200, { ok: false, error: "invalid" });

  try {
    const result = await withTransaction(async (client) => {
      const { rows: signupRows } = await client.query("select * from signups where handle = $1 for update", [handle]);
      const row = signupRows[0];
      if (!row) return { ok: false, error: "no_spins" };
      if (row.has_won) return { ok: false, error: "already_won" };
      if (spinsAvailable(row) <= 0) return { ok: false, error: "no_spins" };

      // Locks the single campaign_state row for the moment it takes to
      // decide + commit this spin's outcome -- this is the only place
      // any spin ever blocks on another spin, and only when either one
      // might actually land on "win". Register/redeem/claim, and every
      // OTHER visitor's non-winning spin, never touch this lock at all.
      const { rows: stateRows } = await client.query("select winners_count from campaign_state where id = 1 for update");
      const winnersSoFar = stateRows[0] ? Number(stateRows[0].winners_count) : 0;
      const canWin = winnersSoFar < config.MAX_WINNERS;

      const r = Math.random();
      let outcome;
      if (canWin && r < config.WIN_PROBABILITY) {
        outcome = "win";
      } else if (r < (canWin ? config.WIN_PROBABILITY : 0) + config.BONUS_PROBABILITY) {
        outcome = "bonus";
      } else {
        outcome = "lose";
      }

      const newSpinsUsed = Number(row.spins_used || 0) + 1;
      const newCodeSpins = outcome === "bonus" ? Number(row.code_spins || 0) + 1 : Number(row.code_spins || 0);
      const newHasWon = outcome === "win" ? true : row.has_won;

      const { rows: updatedRows } = await client.query(
        `update signups set spins_used = $2, code_spins = $3, has_won = $4, updated_at = now() where handle = $1 returning *`,
        [handle, newSpinsUsed, newCodeSpins, newHasWon]
      );
      const updated = updatedRows[0];

      let totalWinners = winnersSoFar;
      if (outcome === "win") {
        totalWinners = winnersSoFar + 1;
        await client.query("update campaign_state set winners_count = $1 where id = 1", [totalWinners]);
      }

      return {
        ok: true,
        outcome: outcome,
        spinsAvailable: spinsAvailable(updated),
        totalWinners: totalWinners,
        maxWinners: config.MAX_WINNERS,
      };
    });
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 200, { ok: false, error: "exception" });
  }
};
