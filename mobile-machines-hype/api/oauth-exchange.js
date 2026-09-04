const { readJsonBody, sendJson } = require("./_lib/respond");
const pkce = require("./_lib/pkce");
const { HANDLE_RE, signSessionToken } = require("./_lib/crypto");
const config = require("./_lib/config");

// Exchanges an X authorization code for the visitor's handle, entirely as
// a background API call. body.code and body.state come straight from the
// URL X redirected back to -- the verifier itself is looked up here
// server-side (stashed by oauth-stash.js) rather than trusted from the
// browser, since the browser that receives this redirect may not be the
// same one that started the login.
module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });

  const body = await readJsonBody(req);
  const code = (body.code || "").toString();
  const state = (body.state || "").toString();
  if (!code || !state) return sendJson(res, 200, { ok: false, error: "missing_params" });

  let verifier;
  try {
    verifier = await pkce.take(state);
  } catch (err) {
    return sendJson(res, 200, { ok: false, error: "exception" });
  }
  if (!verifier) return sendJson(res, 200, { ok: false, error: "expired_state" });

  try {
    const clientSecret = process.env.X_CLIENT_SECRET;
    if (!clientSecret) throw new Error("Missing X_CLIENT_SECRET environment variable.");

    const basicAuth = Buffer.from(`${config.X_CLIENT_ID}:${clientSecret}`).toString("base64");
    const tokenRes = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: config.SITE_URL,
        code_verifier: verifier,
        client_id: config.X_CLIENT_ID,
      }),
    });
    const tokenBody = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenBody.access_token) {
      return sendJson(res, 200, { ok: false, error: "token_exchange_failed" });
    }

    const meRes = await fetch("https://api.x.com/2/users/me", {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    });
    const meBody = await meRes.json().catch(() => ({}));
    const handle = meBody && meBody.data && meBody.data.username;
    if (!handle || !HANDLE_RE.test(handle)) {
      return sendJson(res, 200, { ok: false, error: "profile_read_failed" });
    }

    return sendJson(res, 200, { ok: true, handle: handle, token: signSessionToken(handle) });
  } catch (err) {
    return sendJson(res, 200, { ok: false, error: "exception" });
  }
};
