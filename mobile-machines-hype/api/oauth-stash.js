const { readJsonBody, sendJson } = require("./_lib/respond");
const pkce = require("./_lib/pkce");

// Called right before the browser navigates to X (see beginXConnect in
// js/main.js) -- stashes the PKCE verifier here, keyed by "state", so
// oauth-exchange.js can find it even if the tab that eventually receives
// the redirect back from X is a *different* browser/app context than the
// one that started the login (very common on mobile).
module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });

  const body = await readJsonBody(req);
  const state = (body.state || "").toString();
  const verifier = (body.verifier || "").toString();
  if (!state || !verifier) return sendJson(res, 200, { ok: false, error: "missing_params" });

  try {
    await pkce.stash(state, verifier);
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    return sendJson(res, 200, { ok: false, error: "exception" });
  }
};
