const { readJsonBody, sendJson } = require("./_lib/respond");
const { verifySessionToken } = require("./_lib/crypto");
const config = require("./_lib/config");
const { getOrCreate, spinsAvailable, withTransaction, countWinners } = require("./_lib/signups");

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  if (config.ENROLLMENT_CLOSED) return sendJson(res, 200, { ok: false, error: "closed" });

  const body = await readJsonBody(req);
  const handle = verifySessionToken(body.token);
  if (!handle) return sendJson(res, 200, { ok: false, error: "invalid" });

  try {
    const result = await withTransaction(async (client) => {
      const row = await getOrCreate(client, handle);
      const actionCount = [body.follow, body.like, body.repost, body.comment].filter((v) => v === true).length;
      const newActionSpins = Math.max(Number(row.action_spins || 0), actionCount);

      const { rows } = await client.query(
        `update signups set action_spins = $2, updated_at = now() where handle = $1 returning *`,
        [handle, newActionSpins]
      );
      const updated = rows[0];
      const totalWinners = await countWinners(client);

      return {
        ok: true,
        spinsAvailable: spinsAvailable(updated),
        hasWon: !!updated.has_won,
        hasAddress: !!updated.address,
        totalWinners,
        maxWinners: config.MAX_WINNERS,
      };
    });
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 200, { ok: false, error: "exception" });
  }
};
