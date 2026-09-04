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

  const code = (body.code || "").toString().trim();
  if (code.toUpperCase() !== config.CURRENT_CODE.toUpperCase()) {
    return sendJson(res, 200, { ok: false, error: "invalid_code" });
  }

  try {
    const result = await withTransaction(async (client) => {
      const row = await getOrCreate(client, handle);
      const redeemed = (row.redeemed_codes || "")
        .split(",")
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean);
      if (redeemed.indexOf(config.CURRENT_CODE.toUpperCase()) !== -1) {
        return { ok: false, error: "already_redeemed" };
      }
      redeemed.push(config.CURRENT_CODE.toUpperCase());
      const newCodeSpins = Number(row.code_spins || 0) + config.SPINS_PER_CODE;

      const { rows } = await client.query(
        `update signups set redeemed_codes = $2, code_spins = $3, updated_at = now() where handle = $1 returning *`,
        [handle, redeemed.join(","), newCodeSpins]
      );
      const updated = rows[0];
      const totalWinners = await countWinners(client);

      return {
        ok: true,
        spinsAvailable: spinsAvailable(updated),
        totalWinners,
        maxWinners: config.MAX_WINNERS,
      };
    });
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 200, { ok: false, error: "exception" });
  }
};
