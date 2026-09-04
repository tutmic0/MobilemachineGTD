const crypto = require("crypto");

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const SESSION_TTL_SECONDS = 6 * 60 * 60; // 6 hours, same as before

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64url(str) {
  const pad = str.length % 4 === 0 ? "" : "====".slice(str.length % 4);
  return Buffer.from((str + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function getSessionSecret() {
  const v = process.env.SESSION_SECRET;
  if (!v) throw new Error("Missing SESSION_SECRET environment variable -- see README.md.");
  return v;
}

// A short-lived, signed "I really am @handle" token issued right after a
// real X OAuth login. Every register/redeem/spin/claim call must present
// a valid one -- so nobody can just POST an arbitrary handle string.
function signSessionToken(handle) {
  const payload = `${handle}|${Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS}`;
  const payloadB64 = base64url(Buffer.from(payload, "utf8"));
  const sig = crypto.createHmac("sha256", getSessionSecret()).update(payloadB64).digest();
  return `${payloadB64}.${base64url(sig)}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  const expectedSig = base64url(crypto.createHmac("sha256", getSessionSecret()).update(payloadB64).digest());
  if (expectedSig !== sigB64) return null;

  let payload;
  try {
    payload = fromBase64url(payloadB64).toString("utf8");
  } catch (e) {
    return null;
  }
  const bits = payload.split("|");
  const handle = bits[0];
  const exp = Number(bits[1]);
  if (!handle || !HANDLE_RE.test(handle)) return null;
  if (!exp || Math.floor(Date.now() / 1000) > exp) return null;
  return handle;
}

module.exports = { HANDLE_RE, signSessionToken, verifySessionToken };
