const { readJsonBody, sendJson } = require("./_lib/respond");
const { verifySessionToken } = require("./_lib/crypto");
const config = require("./_lib/config");
const { withTransaction } = require("./_lib/signups");

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

// Only reachable once a spin has actually landed on "win" -- this is
// where (and only where) a wallet address ever gets collected.
module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  if (config.ENROLLMENT_CLOSED) return sendJson(res, 200, { ok: false, error: "closed" });

  const body = await readJsonBody(req);
  const handle = verifySessionToken(body.token);
  if (!handle) return sendJson(res, 200, { ok: false, error: "invalid" });

  const address = (body.address || "").toString().trim();
  if (!ADDR_RE.test(address)) return sendJson(res, 200, { ok: false, error: "invalid_address" });

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query("select * from signups where handle = $1 for update", [handle]);
      const row = rows[0];
      if (!row) return { ok: false, error: "not_found" };
      if (!row.has_won) return { ok: false, error: "not_a_winner" };

      await client.query("update signups set address = $2, updated_at = now() where handle = $1", [handle, address]);
      return { ok: true, handle: handle, address: address };
    });
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 200, { ok: false, error: "exception" });
  }
};
