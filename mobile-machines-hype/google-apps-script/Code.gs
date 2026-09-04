/**
 * Mobile Machines "spin for a GTD spot" backend.
 *
 * Paste this file into the Apps Script editor of the Google Sheet you
 * want to use as the roster (Extensions > Apps Script), save, then
 * deploy it as a Web App (Deploy > New deployment > Web app).
 * See ../README.md for the full step-by-step, including the "Connect
 * X" OAuth setup below.
 *
 * All odds and caps live here, server-side, on purpose -- the frontend
 * only ever draws the wheel and asks this script "what did I land on?".
 * It never decides the outcome itself, so there's no way to rig a win
 * by editing the page's JS.
 *
 * Identity model: the X handle is no longer something the visitor types
 * in a box -- it comes from a real "Connect X" OAuth 2.0 login (see the
 * oauth* functions below), so nobody can register under someone else's
 * handle. The 4 actions (follow/like/repost/comment) are still NOT
 * verified against the X API on purpose (that would cost money per
 * check) -- the frontend just opens the relevant X link and trusts that
 * the visitor did it once they come back to the tab. That's an accepted,
 * intentionally cheap trade-off for a prize that's a mint spot, not cash
 * -- see README.md section 7 for the manual-review step before any spin
 * winner becomes a real GTD entry.
 *
 * Sheet layout (created automatically on first submission if missing):
 *   Column A: Address        -- first on purpose, see README for why
 *   Column B: Handle
 *   Column C: ActionSpins    -- 0-4, one per follow/like/repost/comment
 *   Column D: CodeSpins      -- from redeemed codes + bonus-spin wins
 *   Column E: SpinsUsed
 *   Column F: HasWon         -- TRUE once, never resets
 *   Column G: RedeemedCodes  -- comma-separated, so a code can't be reused
 *   Column H: Timestamp (ISO string, last-updated)
 */

var HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
var ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

// ---- Tune these before/while the campaign is live ----
var MAX_WINNERS = 150;          // hard cap for THIS campaign -- separate from
                                 // the contract's full GTD_SUPPLY of 1000; the
                                 // rest of the 1000 spots can come from other
                                 // channels. Once this many rows have HasWon
                                 // = TRUE, every future spin is forced to
                                 // never land on "win" again.
var WIN_PROBABILITY = 0.05;     // 5% per spin, while spots remain
var BONUS_PROBABILITY = 0.12;   // 12% per spin -- grants +1 spin, doesn't cost the one just used
var CURRENT_CODE = "SIGNAL01";  // change this every time you post a new announcement
var SPINS_PER_CODE = 2;         // how many extra spins CURRENT_CODE is worth
var ENROLLMENT_CLOSED = false;  // TODO: keep in sync with CONFIG.enrollmentClosed in js/main.js

// ---- "Connect X" OAuth 2.0 (PKCE) ----
// Fill these in from your X Developer Portal app (developer.x.com):
//   1. Create a project + app. Under "User authentication settings",
//      turn on OAuth 2.0, app type "Web App, Automated App or Bot"
//      (a CONFIDENTIAL client -- this is what lets the Client Secret
//      live only here on the server, never in the visitor's browser).
//   2. App permissions: "Read" is enough (scopes below only need
//      users.read + tweet.read).
//   3. Callback URI / Redirect URL: this script's OWN Web App URL
//      (the same .../exec URL from README.md step 2.8). X checks this
//      for an EXACT match, so: deploy once first to get the URL, paste
//      it into BOTH the X app settings and X_REDIRECT_URI below, then
//      redeploy (Deploy > Manage deployments > edit) so the change
//      takes effect.
//   4. Copy the Client ID into X_CLIENT_ID below. Copy the Client
//      Secret into a Script Property instead -- Project Settings (gear
//      icon, left sidebar) > Script Properties > add a property named
//      X_CLIENT_SECRET with the secret as its value. Never paste the
//      secret into this file (or anywhere in chat).
var X_CLIENT_ID = "PASTE_YOUR_X_CLIENT_ID_HERE";
var X_REDIRECT_URI = "PASTE_THIS_SCRIPTS_OWN_WEB_APP_URL_HERE"; // ends in /exec
var X_OAUTH_SCOPES = "users.read tweet.read";
var SITE_URL = "PASTE_YOUR_HYPE_SITE_URL_HERE"; // e.g. https://mobile-machines-hype.vercel.app/
var SESSION_TTL_SECONDS = 6 * 60 * 60; // how long a "Connect X" login stays valid (6h)

var HEADER = ["Address", "Handle", "ActionSpins", "CodeSpins", "SpinsUsed", "HasWon", "RedeemedCodes", "Timestamp"];
var COL = { ADDRESS: 0, HANDLE: 1, ACTION_SPINS: 2, CODE_SPINS: 3, SPINS_USED: 4, HAS_WON: 5, CODES: 6, TIMESTAMP: 7 };

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADER);
  }
  return sheet;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function countWinners_(sheet) {
  var last = sheet.getLastRow();
  if (last <= 1) return 0;
  var vals = sheet.getRange(2, COL.HAS_WON + 1, last - 1, 1).getValues();
  var count = 0;
  for (var i = 0; i < vals.length; i++) if (vals[i][0] === true) count++;
  return count;
}

// Returns { rowIndex (1-based sheet row), row (array) } or null.
function findRow_(sheet, address) {
  var last = sheet.getLastRow();
  if (last <= 1) return null;
  var data = sheet.getRange(2, 1, last - 1, HEADER.length).getValues();
  var addrLower = address.toLowerCase();
  for (var i = 0; i < data.length; i++) {
    if ((data[i][COL.ADDRESS] || "").toString().toLowerCase() === addrLower) {
      return { rowIndex: i + 2, row: data[i] };
    }
  }
  return null;
}

function writeRow_(sheet, rowIndex, row) {
  sheet.getRange(rowIndex, 1, 1, HEADER.length).setValues([row]);
}

function spinsAvailable_(row) {
  var earned = (Number(row[COL.ACTION_SPINS]) || 0) + (Number(row[COL.CODE_SPINS]) || 0);
  var used = Number(row[COL.SPINS_USED]) || 0;
  return Math.max(0, earned - used);
}

// ---------------- OAuth: PKCE + signed session-token helpers ----------------

function getClientSecret_() {
  var v = PropertiesService.getScriptProperties().getProperty("X_CLIENT_SECRET");
  if (!v) throw new Error("Missing Script Property X_CLIENT_SECRET -- see README.md.");
  return v;
}

// Auto-generates itself on first use so you never have to think about it --
// it's not a secret you get from X, just a random string this script uses
// to sign its own session tokens.
function getSessionSecret_() {
  var props = PropertiesService.getScriptProperties();
  var v = props.getProperty("SESSION_SECRET");
  if (!v) {
    v = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty("SESSION_SECRET", v);
  }
  return v;
}

function base64UrlFromBytes_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, "");
}

function base64UrlFromString_(str) {
  return base64UrlFromBytes_(Utilities.newBlob(str).getBytes());
}

function stringFromBase64Url_(str) {
  var pad = str.length % 4 === 0 ? "" : "====".slice(str.length % 4);
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(str + pad)).getDataAsString();
}

function randomUrlSafeString_(byteLen) {
  var bytes = [];
  for (var i = 0; i < byteLen; i++) bytes.push(Math.floor(Math.random() * 256));
  return base64UrlFromBytes_(bytes);
}

function sha256Base64Url_(input) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input);
  return base64UrlFromBytes_(digest);
}

// A short-lived, signed "I really am @handle" token issued right after a
// real X OAuth login. Every register/redeem/spin call must present a
// valid one -- so nobody can just POST an arbitrary handle string.
function signSessionToken_(handle) {
  var payloadB64 = base64UrlFromString_(handle + "|" + (Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS));
  var sigB64 = base64UrlFromBytes_(Utilities.computeHmacSha256Signature(payloadB64, getSessionSecret_()));
  return payloadB64 + "." + sigB64;
}

function verifySessionToken_(token) {
  if (!token || typeof token !== "string") return null;
  var parts = token.split(".");
  if (parts.length !== 2) return null;
  var payloadB64 = parts[0], sigB64 = parts[1];
  var expectedSig = base64UrlFromBytes_(Utilities.computeHmacSha256Signature(payloadB64, getSessionSecret_()));
  if (expectedSig !== sigB64) return null;

  var payload;
  try {
    payload = stringFromBase64Url_(payloadB64);
  } catch (err) {
    return null;
  }
  var bits = payload.split("|");
  var handle = bits[0];
  var exp = Number(bits[1]);
  if (!handle || !HANDLE_RE.test(handle)) return null;
  if (!exp || Math.floor(Date.now() / 1000) > exp) return null;
  return handle;
}

function oauthStart_() {
  var state = randomUrlSafeString_(24);
  var verifier = randomUrlSafeString_(48);
  var challenge = sha256Base64Url_(verifier);

  // 10 minutes is plenty to log into X and approve the app.
  CacheService.getScriptCache().put("pkce_" + state, verifier, 600);

  var authorizeUrl = "https://x.com/i/oauth2/authorize"
    + "?response_type=code"
    + "&client_id=" + encodeURIComponent(X_CLIENT_ID)
    + "&redirect_uri=" + encodeURIComponent(X_REDIRECT_URI)
    + "&scope=" + encodeURIComponent(X_OAUTH_SCOPES)
    + "&state=" + encodeURIComponent(state)
    + "&code_challenge=" + encodeURIComponent(challenge)
    + "&code_challenge_method=S256";

  return htmlRedirect_(authorizeUrl);
}

function htmlRedirect_(url) {
  return HtmlService.createHtmlOutput(
    "<!doctype html><html><body>Redirecting…" +
    "<script>window.location.replace(" + JSON.stringify(url) + ");</script>" +
    "</body></html>"
  );
}

function redirectToSite_(hash) {
  var base = SITE_URL.indexOf("#") === -1 ? SITE_URL : SITE_URL.split("#")[0];
  if (base.charAt(base.length - 1) !== "/") base += "/";
  return htmlRedirect_(base + "#" + hash);
}

function oauthCallback_(e) {
  var params = e.parameter || {};
  if (params.error) {
    return redirectToSite_("connect_error&reason=" + encodeURIComponent(params.error));
  }
  if (!params.code || !params.state) {
    return redirectToSite_("connect_error&reason=missing_code");
  }

  var cache = CacheService.getScriptCache();
  var verifier = cache.get("pkce_" + params.state);
  if (!verifier) {
    return redirectToSite_("connect_error&reason=expired_state");
  }
  cache.remove("pkce_" + params.state);

  try {
    var tokenRes = UrlFetchApp.fetch("https://api.x.com/2/oauth2/token", {
      method: "post",
      contentType: "application/x-www-form-urlencoded",
      headers: {
        Authorization: "Basic " + Utilities.base64Encode(X_CLIENT_ID + ":" + getClientSecret_()),
      },
      payload: {
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: X_REDIRECT_URI,
        code_verifier: verifier,
        client_id: X_CLIENT_ID,
      },
      muteHttpExceptions: true,
    });

    var tokenBody = JSON.parse(tokenRes.getContentText() || "{}");
    if (tokenRes.getResponseCode() !== 200 || !tokenBody.access_token) {
      return redirectToSite_("connect_error&reason=token_exchange_failed");
    }

    var meRes = UrlFetchApp.fetch("https://api.x.com/2/users/me", {
      method: "get",
      headers: { Authorization: "Bearer " + tokenBody.access_token },
      muteHttpExceptions: true,
    });
    var meBody = JSON.parse(meRes.getContentText() || "{}");
    var handle = meBody && meBody.data && meBody.data.username;
    if (!handle || !HANDLE_RE.test(handle)) {
      return redirectToSite_("connect_error&reason=profile_read_failed");
    }

    var sessionToken = signSessionToken_(handle);
    return redirectToSite_("connected&handle=" + encodeURIComponent(handle) + "&token=" + encodeURIComponent(sessionToken));
  } catch (err) {
    return redirectToSite_("connect_error&reason=exception");
  }
}

function doGet(e) {
  var params = (e && e.parameter) || {};

  // This same Web App URL is both the site's "start login" link AND the
  // exact redirect_uri X sends people back to -- branch on which one this
  // request is before anything else.
  if (params.code || params.error) return oauthCallback_(e);
  if (params.action === "oauth_start") return oauthStart_();

  var sheet = getSheet_();
  if (params.action === "status") {
    return jsonOut_({ ok: true, totalWinners: countWinners_(sheet), maxWinners: MAX_WINNERS });
  }
  return jsonOut_({ ok: true, message: "Mobile Machines spin API is running." });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet_();
    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      return jsonOut_({ ok: false, error: "invalid_json" });
    }

    var action = (body.action || "").toString();
    if (action === "register") return handleRegister_(sheet, body);
    if (action === "redeem") return handleRedeem_(sheet, body);
    if (action === "spin") return handleSpin_(sheet, body);
    return jsonOut_({ ok: false, error: "unknown_action" });
  } finally {
    lock.releaseLock();
  }
}

// identity now comes from a real "Connect X" login: body.token is the
// signed session token issued by oauthCallback_ above, not a typed
// handle -- so a visitor can never register under someone else's name.
function validateIdentity_(body) {
  var address = (body.address || "").toString().trim();
  if (!ADDR_RE.test(address)) return null;
  var handle = verifySessionToken_(body.token);
  if (!handle) return null;
  return { handle: handle, address: address };
}

function getOrCreateRow_(sheet, address, handle) {
  var found = findRow_(sheet, address);
  if (found) return found;
  var row = [address, handle, 0, 0, 0, false, "", new Date().toISOString()];
  sheet.appendRow(row);
  return { rowIndex: sheet.getLastRow(), row: row };
}

function handleRegister_(sheet, body) {
  if (ENROLLMENT_CLOSED) return jsonOut_({ ok: false, error: "closed" });
  var identity = validateIdentity_(body);
  if (!identity) return jsonOut_({ ok: false, error: "invalid" });

  var found = getOrCreateRow_(sheet, identity.address, identity.handle);
  var row = found.row;
  var actionCount = [body.follow, body.like, body.repost, body.comment].filter(function (v) { return v === true; }).length;

  row[COL.HANDLE] = identity.handle;
  row[COL.ACTION_SPINS] = Math.max(Number(row[COL.ACTION_SPINS]) || 0, actionCount);
  row[COL.TIMESTAMP] = new Date().toISOString();
  writeRow_(sheet, found.rowIndex, row);

  return jsonOut_({
    ok: true,
    spinsAvailable: spinsAvailable_(row),
    hasWon: row[COL.HAS_WON] === true,
    totalWinners: countWinners_(sheet),
    maxWinners: MAX_WINNERS,
  });
}

function handleRedeem_(sheet, body) {
  if (ENROLLMENT_CLOSED) return jsonOut_({ ok: false, error: "closed" });
  var identity = validateIdentity_(body);
  if (!identity) return jsonOut_({ ok: false, error: "invalid" });

  var code = (body.code || "").toString().trim();
  if (code.toUpperCase() !== CURRENT_CODE.toUpperCase()) {
    return jsonOut_({ ok: false, error: "invalid_code" });
  }

  var found = getOrCreateRow_(sheet, identity.address, identity.handle);
  var row = found.row;
  var redeemed = (row[COL.CODES] || "").toString().split(",").map(function (c) { return c.trim().toUpperCase(); }).filter(Boolean);
  if (redeemed.indexOf(CURRENT_CODE.toUpperCase()) !== -1) {
    return jsonOut_({ ok: false, error: "already_redeemed" });
  }

  redeemed.push(CURRENT_CODE.toUpperCase());
  row[COL.CODES] = redeemed.join(",");
  row[COL.CODE_SPINS] = (Number(row[COL.CODE_SPINS]) || 0) + SPINS_PER_CODE;
  row[COL.TIMESTAMP] = new Date().toISOString();
  writeRow_(sheet, found.rowIndex, row);

  return jsonOut_({
    ok: true,
    spinsAvailable: spinsAvailable_(row),
    totalWinners: countWinners_(sheet),
    maxWinners: MAX_WINNERS,
  });
}

function handleSpin_(sheet, body) {
  if (ENROLLMENT_CLOSED) return jsonOut_({ ok: false, error: "closed" });
  var identity = validateIdentity_(body);
  if (!identity) return jsonOut_({ ok: false, error: "invalid" });

  var found = findRow_(sheet, identity.address);
  if (!found) return jsonOut_({ ok: false, error: "no_spins" });
  var row = found.row;

  if (row[COL.HAS_WON] === true) return jsonOut_({ ok: false, error: "already_won" });
  if (spinsAvailable_(row) <= 0) return jsonOut_({ ok: false, error: "no_spins" });

  var winnersSoFar = countWinners_(sheet);
  var canWin = winnersSoFar < MAX_WINNERS;
  var r = Math.random();
  var outcome;
  if (canWin && r < WIN_PROBABILITY) {
    outcome = "win";
  } else if (r < (canWin ? WIN_PROBABILITY : 0) + BONUS_PROBABILITY) {
    outcome = "bonus";
  } else {
    outcome = "lose";
  }

  row[COL.SPINS_USED] = (Number(row[COL.SPINS_USED]) || 0) + 1;
  if (outcome === "bonus") {
    row[COL.CODE_SPINS] = (Number(row[COL.CODE_SPINS]) || 0) + 1;
  } else if (outcome === "win") {
    row[COL.HAS_WON] = true;
  }
  row[COL.TIMESTAMP] = new Date().toISOString();
  writeRow_(sheet, found.rowIndex, row);

  return jsonOut_({
    ok: true,
    outcome: outcome,
    spinsAvailable: spinsAvailable_(row),
    totalWinners: countWinners_(sheet),
    maxWinners: MAX_WINNERS,
  });
}
