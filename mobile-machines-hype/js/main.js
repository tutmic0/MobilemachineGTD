"use strict";

/**
 * Everything you need to edit before going live is right here.
 *
 * The backend is a set of Vercel Functions under /api (same domain as
 * this page, no separate URL to paste anywhere) backed by Postgres --
 * see db/schema.sql and api/_lib/config.js for the backend-side knobs
 * (odds, MAX_WINNERS, CURRENT_CODE, etc). The browser is never trusted
 * to decide or even know the exact odds, only the backend is.
 *
 * xHandle: your X handle, WITHOUT the @.
 * xPostUrl: the link to the actual announcement post people need to
 *   like/repost/comment on -- update this the moment you post it.
 * enrollmentClosed: flip to true once you're done spinning entirely
 *   (also flip ENROLLMENT_CLOSED in api/_lib/config.js to match --
 *   that's what actually blocks the backend, this just controls the UI).
 *
 * Flow: Connect X -> do the 4 steps (each just opens an X link and
 * trusts you did it once you're back for 5+ seconds, see README) ->
 * spin. A wallet address is only ever asked for at the very end, if a
 * spin actually lands on the GTD slice -- everything before that only
 * needs your X identity.
 *
 * The "Connect X" login itself never leaves this page for an
 * in-between screen: this page builds the X login URL itself (PKCE,
 * right below) and navigates straight to x.com, and when X sends the
 * visitor straight back here with a code, this page hands that code to
 * /api/oauth-exchange as a plain background request (not a redirect) to
 * get back a handle + session token. xClientId/xOauthRedirectUri/
 * xOauthScopes below have to match what's registered on X Developer
 * Portal and in api/_lib/config.js -- see README.md section 2b.
 */
var CONFIG = {
  xHandle: "mobilemachineOS",
  xPostUrl: "https://x.com/mobilemachineOS/status/2096135311696732240",
  xClientId: "MVJQLVhKbWRMTkxkM3BIay1aSXk6MTpjaQ",
  xOauthRedirectUri: "https://www.mobilemachine.xyz/",
  xOauthScopes: "users.read tweet.read",
  enrollmentClosed: false,
};

// Purely cosmetic -- only used to draw the wheel and to know which
// slice to spin to for a given outcome type. The actual outcome
// ("win" / "bonus" / "lose") always comes from the server.
var WHEEL_SEGMENTS = [
  { type: "win", label: "GTD WON" },
  { type: "lose", label: "No luck" },
  { type: "lose", label: "Try again" },
  { type: "bonus", label: "+1 SPIN" },
  { type: "lose", label: "So close" },
  { type: "lose", label: "Nothing" },
  { type: "lose", label: "No luck" },
  { type: "lose", label: "Almost" },
];
var SEGMENT_COLORS = {
  win: { fill: "#f0a94e", text: "#2b1a00" },
  bonus: { fill: "#4fe0c4", text: "#052821" },
  loseA: { fill: "#161d1f", text: "#94aaa5" },
  loseB: { fill: "#1e2729", text: "#94aaa5" },
};

var ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

// How long (ms) someone needs to be away from the tab before an action
// click is trusted as "done". Matches the click -> new tab -> back here
// flow -- there is no server-side check behind this on purpose (see
// README.md), it's just enough friction to stop a blind auto-clicker.
var ACTION_MIN_AWAY_MS = 5000;

var ACTION_LINKS = {
  follow: function () { return "https://x.com/" + CONFIG.xHandle; },
  like: function () { return CONFIG.xPostUrl; },
  repost: function () { return CONFIG.xPostUrl; },
  comment: function () { return CONFIG.xPostUrl; },
};

var CONNECT_ERROR_MESSAGES = {
  access_denied: "You cancelled the X login.",
  missing_code: "X didn't send back a login code -- try again.",
  missing_params: "That login link was incomplete -- click Connect X again.",
  expired_state: "That login link expired -- click Connect X again.",
  token_exchange_failed: "Couldn't complete the X login -- try again in a moment.",
  profile_read_failed: "Connected to X but couldn't read your handle -- try again.",
  exception: "Something went wrong connecting to X -- try again.",
  unreachable: "Couldn't reach the server -- try again in a moment.",
};

var el = {
  connectGate: document.getElementById("connect-gate"),
  xConnectBtn: document.getElementById("x-connect-btn"),
  spinFlow: document.getElementById("spin-flow"),
  xConnectedHandle: document.getElementById("x-connected-handle"),
  xDisconnectBtn: document.getElementById("x-disconnect-btn"),
  connectError: document.getElementById("connect-error"),
  actionButtons: {
    follow: document.getElementById("act-follow"),
    like: document.getElementById("act-like"),
    repost: document.getElementById("act-repost"),
    comment: document.getElementById("act-comment"),
  },
  redeemCode: document.getElementById("redeem-code"),
  redeemBtn: document.getElementById("redeem-btn"),
  redeemError: document.getElementById("redeem-error"),
  formMsg: document.getElementById("form-msg"),
  canvas: document.getElementById("wheel-canvas"),
  spinBtn: document.getElementById("spin-btn"),
  spinBtnLabel: document.getElementById("spin-btn-label"),
  spinBalance: document.getElementById("spin-balance"),
  spinLog: document.getElementById("spin-log"),
  claimCard: document.getElementById("claim-card"),
  claimForm: document.getElementById("claim-form"),
  claimAddress: document.getElementById("claim-address"),
  claimBtn: document.getElementById("claim-btn"),
  claimError: document.getElementById("claim-error"),
  claimIntro: document.getElementById("claim-intro"),
  receipt: document.getElementById("receipt"),
  statusCount: document.getElementById("status-count"),
  progressFill: document.getElementById("progress-fill"),
  statusNote: document.getElementById("status-note"),
};

var state = {
  xHandle: null,
  xToken: null,
  spinsAvailable: 0,
  hasWon: false,
  claimed: false,
  claimedAddress: "", // set once the backend confirms an address is on file for this win
  wheelRotation: 0,
  spinning: false,
  actionsDone: { follow: false, like: false, repost: false, comment: false },
};

// key -> timestamp when the user clicked out. Checked on every
// visibility/focus change; cleared once ACTION_MIN_AWAY_MS has passed.
//
// Also mirrored to localStorage (below), for the same reason the session
// token moved there: if Chrome reloads this page from scratch after the
// X app hand-off, this in-memory object is gone and a click that
// genuinely happened would otherwise just be forgotten -- "ništa od
// procesa" even though the visitor did everything right.
var pendingActions = {};

function actionsStorageKeys(handle) {
  return {
    done: "mm_actions_done_" + handle,
    pending: "mm_actions_pending_" + handle,
  };
}

function saveActionsDone() {
  if (!state.xHandle) return;
  try { localStorage.setItem(actionsStorageKeys(state.xHandle).done, JSON.stringify(state.actionsDone)); } catch (e) { /* ignore */ }
}

function savePendingActions() {
  if (!state.xHandle) return;
  try { localStorage.setItem(actionsStorageKeys(state.xHandle).pending, JSON.stringify(pendingActions)); } catch (e) { /* ignore */ }
}

// Called once on boot, after we know which handle (if any) is signed in --
// pulls back anything this browser already knew about that handle before
// whatever reload just happened.
function restoreActionsState() {
  if (!state.xHandle) return;
  var keys = actionsStorageKeys(state.xHandle);
  try {
    var doneRaw = localStorage.getItem(keys.done);
    if (doneRaw) {
      var doneParsed = JSON.parse(doneRaw);
      Object.keys(state.actionsDone).forEach(function (k) {
        if (doneParsed[k]) state.actionsDone[k] = true;
      });
    }
    var pendingRaw = localStorage.getItem(keys.pending);
    if (pendingRaw) {
      var pendingParsed = JSON.parse(pendingRaw);
      Object.keys(pendingParsed).forEach(function (k) {
        if (!state.actionsDone[k]) pendingActions[k] = pendingParsed[k];
      });
    }
  } catch (e) { /* ignore */ }
}

function clearActionsState(handle) {
  if (!handle) return;
  var keys = actionsStorageKeys(handle);
  try {
    localStorage.removeItem(keys.done);
    localStorage.removeItem(keys.pending);
  } catch (e) { /* ignore */ }
}

function wireLinks() {
  var heroLink = document.getElementById("hero-x-link");
  if (heroLink) heroLink.href = "https://x.com/" + CONFIG.xHandle;
  var actFollowHandle = document.getElementById("act-follow-handle");
  if (actFollowHandle) actFollowHandle.textContent = "@" + CONFIG.xHandle;
}

function setMsg(text, type) {
  el.formMsg.textContent = text;
  el.formMsg.className = "form-msg" + (text ? " show" : "") + (type ? " " + type : "");
}

// ---------------- session storage ----------------
//
// localStorage, not sessionStorage: on mobile, tapping a Follow/Like/etc
// button hands off to the X app, and Android is free to fully kill
// Chrome's background tab while X is in the foreground. When the user
// comes back, Chrome (or the user, picking a tab from the switcher) may
// reload the page from scratch -- sessionStorage for that browsing
// context can come back empty even though it's "the same tab" as far as
// the user's concerned, which is exactly what showed up as "connected
// on PC, but the phone says not connected after coming back from X".
// localStorage survives a process kill/reload and is shared by every
// tab of this origin, so it doesn't matter which tab/reload the user
// ends up looking at. The token itself still expires server-side after
// 6h (see api/_lib/crypto.js) regardless of how long it sits here.

function saveSession(handle, token) {
  try {
    localStorage.setItem("mm_x_handle", handle);
    localStorage.setItem("mm_x_token", token);
  } catch (e) { /* private mode etc -- session just won't survive a reload */ }
}

function loadSession() {
  try {
    var handle = localStorage.getItem("mm_x_handle");
    var token = localStorage.getItem("mm_x_token");
    if (handle && token) return { handle: handle, token: token };
  } catch (e) { /* ignore */ }
  return null;
}

function clearSession() {
  try {
    localStorage.removeItem("mm_x_handle");
    localStorage.removeItem("mm_x_token");
  } catch (e) { /* ignore */ }
}

// ---------------- "Connect X" -- client-side PKCE, no in-between page ----------------

function base64UrlEncodeBytes(bytes) {
  var bin = "";
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomPkceString() {
  var bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeBytes(bytes);
}

async function pkceChallengeFor(verifier) {
  var data = new TextEncoder().encode(verifier);
  var digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

async function beginXConnect() {
  var verifier = randomPkceString();
  var state_ = randomPkceString();
  var challenge = await pkceChallengeFor(verifier);

  // Keep a local copy too (fast path when the return trip lands back in
  // this exact same browser tab/context) --
  try {
    sessionStorage.setItem("mm_pkce_verifier", verifier);
    sessionStorage.setItem("mm_pkce_state", state_);
  } catch (e) { /* private mode etc -- fine, the server-side stash below is what actually matters */ }

  // ... but the real source of truth is this server-side stash, keyed by
  // "state". On mobile, clicking Connect X very often hands off to a
  // *different* browser/app context (the X app itself, or an in-app
  // browser's own separate storage) than the one that receives X's
  // redirect back -- sessionStorage from this tab wouldn't be visible
  // there at all. "state" always comes back correctly in the redirect
  // URL no matter which context receives it, so that's what we key on.
  //
  // Fire this with keepalive so it survives the page navigating away
  // right after -- but deliberately DON'T await it. Apps Script can take
  // a second or more to respond, and this click should feel instant:
  // navigate to X immediately, let the stash land in the background.
  postAction("oauth_stash", { state: state_, verifier: verifier }, { keepalive: true }).catch(function () {
    // If this fails (offline, etc.) we still try the login -- the local
    // sessionStorage copy above is the fallback for the same-tab case.
  });

  var url = "https://x.com/i/oauth2/authorize"
    + "?response_type=code"
    + "&client_id=" + encodeURIComponent(CONFIG.xClientId)
    + "&redirect_uri=" + encodeURIComponent(CONFIG.xOauthRedirectUri)
    + "&scope=" + encodeURIComponent(CONFIG.xOauthScopes)
    + "&state=" + encodeURIComponent(state_)
    + "&code_challenge=" + encodeURIComponent(challenge)
    + "&code_challenge_method=S256";
  window.location.href = url;
}

// Runs once on page load. If we just came back from X (this page IS
// CONFIG.xOauthRedirectUri), the URL carries ?code=...&state=... --
// exchange it for a handle+token over a plain background request and
// never touch the address bar's path, so this never looks like a
// separate "callback page" to the visitor.
async function consumeOAuthReturn() {
  var params = new URLSearchParams(window.location.search);
  var code = params.get("code");
  var errorParam = params.get("error");
  var returnedState = params.get("state");
  if (!code && !errorParam) return;

  history.replaceState(null, "", window.location.pathname + window.location.hash);

  if (errorParam) {
    el.connectError.textContent = CONNECT_ERROR_MESSAGES[errorParam] || "Couldn't connect X -- try again.";
    return;
  }

  // Clean up whatever local copy this tab might have -- it's only ever a
  // fast-path hint now, never required. The actual verifier lookup below
  // happens server-side, keyed by "state", so this works even if X handed
  // the login off to a different browser/app than the one that started it.
  try {
    sessionStorage.removeItem("mm_pkce_state");
    sessionStorage.removeItem("mm_pkce_verifier");
  } catch (e) { /* ignore */ }

  if (!returnedState) {
    el.connectError.textContent = CONNECT_ERROR_MESSAGES.expired_state;
    return;
  }
  if (!backendReady()) { setMsg("This page isn't connected to a backend yet -- see README.md.", "error"); return; }

  try {
    var data = await postAction("oauth_exchange", { code: code, state: returnedState });
    if (data.ok && data.handle && data.token) {
      state.xHandle = data.handle;
      state.xToken = data.token;
      saveSession(data.handle, data.token);
    } else {
      el.connectError.textContent = CONNECT_ERROR_MESSAGES[data.error] || "Couldn't complete X login -- try again.";
    }
  } catch (e) {
    el.connectError.textContent = CONNECT_ERROR_MESSAGES.unreachable;
  }
}

function renderConnectState() {
  var connected = !!(state.xHandle && state.xToken);
  el.connectGate.hidden = connected;
  el.spinFlow.hidden = !connected;
  if (connected) el.xConnectedHandle.textContent = "@" + state.xHandle;
}

el.xConnectBtn.addEventListener("click", function () {
  if (!backendReady()) { setMsg("This page isn't connected to a backend yet -- see README.md.", "error"); return; }
  beginXConnect().catch(function () {
    el.connectError.textContent = "Couldn't start the X login -- try again.";
  });
});

el.xDisconnectBtn.addEventListener("click", function () {
  clearActionsState(state.xHandle);
  state.xHandle = null;
  state.xToken = null;
  clearSession();
  renderConnectState();
});

// ---------------- wheel drawing ----------------

function drawWheel() {
  var ctx = el.canvas.getContext("2d");
  var w = el.canvas.width, h = el.canvas.height;
  var cx = w / 2, cy = h / 2, r = w / 2 - 8;
  var n = WHEEL_SEGMENTS.length;
  var seg = (Math.PI * 2) / n;
  var start0 = -Math.PI / 2 - seg / 2;

  ctx.clearRect(0, 0, w, h);

  for (var i = 0; i < n; i++) {
    var a0 = start0 + i * seg;
    var a1 = a0 + seg;
    var colorKey = WHEEL_SEGMENTS[i].type === "win" ? "win"
      : WHEEL_SEGMENTS[i].type === "bonus" ? "bonus"
      : (i % 2 === 0 ? "loseA" : "loseB");
    var colors = SEGMENT_COLORS[colorKey];

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1);
    ctx.closePath();
    ctx.fillStyle = colors.fill;
    ctx.fill();
    ctx.strokeStyle = "rgba(9,11,12,0.8)";
    ctx.lineWidth = 3;
    ctx.stroke();

    // label
    var mid = a0 + seg / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(mid);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = colors.text;
    ctx.font = "600 22px 'IBM Plex Mono', monospace";
    ctx.fillText(WHEEL_SEGMENTS[i].label, r - 22, 0);
    ctx.restore();
  }

  // hub
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.2, 0, Math.PI * 2);
  ctx.fillStyle = "#eaf6f2";
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = "#090b0c";
  ctx.stroke();
  ctx.fillStyle = "#0a1413";
  ctx.font = "700 " + Math.round(r * 0.16) + "px 'IBM Plex Mono', monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("MM", cx, cy);

  // outer rim
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#2fae95";
  ctx.stroke();
}

function segmentIndexForOutcome(outcome) {
  var candidates = [];
  WHEEL_SEGMENTS.forEach(function (s, i) {
    if (s.type === outcome) candidates.push(i);
  });
  if (candidates.length === 0) candidates = [1]; // fallback to a "lose" slice
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function spinToOutcome(outcome) {
  return new Promise(function (resolve) {
    var n = WHEEL_SEGMENTS.length;
    var segDeg = 360 / n;
    var index = segmentIndexForOutcome(outcome);
    var centerDeg = index * segDeg; // segment 0's center sits at the top (pointer) when rotation=0
    var jitter = (Math.random() - 0.5) * (segDeg - 14);
    var targetMod = ((360 - centerDeg + jitter) % 360 + 360) % 360;
    var fullSpins = 6;
    var current = state.wheelRotation;
    var newRotation = current - (current % 360) + fullSpins * 360 + targetMod;

    state.wheelRotation = newRotation;
    el.canvas.style.transform = "rotate(" + newRotation + "deg)";
    setTimeout(resolve, 4300);
  });
}

// ---------------- backend calls ----------------

// The backend now lives right alongside this page (Vercel Functions
// under /api), so there's no separate URL to paste/misconfigure anymore.
var API_PATHS = {
  oauth_stash: "/api/oauth-stash",
  oauth_exchange: "/api/oauth-exchange",
  register: "/api/register",
  redeem: "/api/redeem",
  spin: "/api/spin",
  claim: "/api/claim",
};

function backendReady() {
  return true;
}

async function postAction(action, payload, opts) {
  var res = await fetch(API_PATHS[action], {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
    keepalive: !!(opts && opts.keepalive),
  });
  return res.json();
}

async function loadGlobalStatus() {
  try {
    var res = await fetch("/api/status");
    var data = await res.json();
    if (data.ok) updateGlobalStatus(data.totalWinners, data.maxWinners);
  } catch (e) {
    console.warn("Could not load campaign status", e);
  }
}

function updateGlobalStatus(totalWinners, maxWinners) {
  el.statusCount.textContent = totalWinners.toLocaleString() + " / " + maxWinners.toLocaleString();
  el.progressFill.style.width = Math.min(100, (totalWinners / maxWinners) * 100).toFixed(1) + "%";
  if (totalWinners >= maxWinners) {
    el.statusNote.textContent = "All GTD slices for this campaign are gone.";
  }
}

// Handles the one failure mode that's specific to the new identity model:
// a session token that Code.gs no longer accepts (expired, or the whole
// campaign redeployed with a new signing secret). Bounces the visitor
// back to a clean "Connect X" state instead of a dead-end error.
function handleMaybeExpiredSession() {
  if (!state.xToken) return;
  state.xHandle = null;
  state.xToken = null;
  clearSession();
  renderConnectState();
  setMsg("Your X connection expired -- connect again to keep spinning.", "info");
}

function updateBalanceLabel() {
  if (state.hasWon) {
    el.spinBalance.innerHTML = "You already landed the GTD slice -- no more spins needed.";
    el.spinBtn.disabled = true;
    return;
  }
  el.spinBalance.innerHTML = "Spins available: <b>" + state.spinsAvailable + "</b>";
  el.spinBtn.disabled = state.spinsAvailable <= 0 || CONFIG.enrollmentClosed || state.spinning;
}

async function syncActions() {
  if (!state.xToken) return; // nothing to sync until they've connected X
  if (!backendReady()) {
    setMsg("This page isn't connected to a backend yet -- see README.md.", "error");
    return;
  }
  try {
    var data = await postAction("register", {
      token: state.xToken,
      follow: state.actionsDone.follow,
      like: state.actionsDone.like,
      repost: state.actionsDone.repost,
      comment: state.actionsDone.comment,
    });
    if (!data.ok) {
      if (data.error === "closed") setMsg("Spinning is closed.", "info");
      else if (data.error === "invalid") handleMaybeExpiredSession();
      return;
    }
    state.spinsAvailable = data.spinsAvailable;
    state.hasWon = !!data.hasWon;
    if (state.hasWon) state.claimedAddress = data.address || "";
    setMsg("", null);
    updateBalanceLabel();
    if (state.hasWon) {
      showClaimCard();
      renderClaimState();
    }
    if (typeof data.totalWinners === "number") updateGlobalStatus(data.totalWinners, data.maxWinners);
  } catch (e) {
    setMsg("Couldn't reach the server -- try again in a moment.", "error");
  }
}

// ---------------- action buttons (open link -> mark done on return) ----------------

function renderActionButtons() {
  Object.keys(el.actionButtons).forEach(function (key) {
    var btn = el.actionButtons[key];
    var done = state.actionsDone[key];
    var pending = !!pendingActions[key];
    btn.classList.toggle("done", done);
    btn.classList.toggle("pending", pending && !done);
  });
}

function checkPendingActions() {
  var changed = false;
  Object.keys(pendingActions).forEach(function (key) {
    if (Date.now() - pendingActions[key] >= ACTION_MIN_AWAY_MS) {
      state.actionsDone[key] = true;
      delete pendingActions[key];
      changed = true;
    }
  });
  if (changed) {
    saveActionsDone();
    savePendingActions();
    renderActionButtons();
    syncActions();
  }
}

document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible") checkPendingActions();
});
window.addEventListener("focus", checkPendingActions);

Object.keys(el.actionButtons).forEach(function (key) {
  el.actionButtons[key].addEventListener("click", function () {
    if (state.actionsDone[key]) return;
    if (!state.xToken) { setMsg("Connect X first.", "error"); return; }
    var urlFn = ACTION_LINKS[key];
    window.open(urlFn(), "_blank", "noopener");
    pendingActions[key] = Date.now();
    savePendingActions();
    renderActionButtons();

    // On mobile, an x.com link very often hands off to the native X app
    // entirely (universal links) instead of opening a browser tab -- in
    // that case this page's tab never regains focus/visibility (the
    // visitor's "back" press just moves around inside the X app), so
    // the visibilitychange/focus listeners below never fire and the
    // action would be stuck "pending" forever even though the visitor
    // really did it. This timer is a fallback that marks it done after
    // ACTION_MIN_AWAY_MS regardless of whether focus ever comes back --
    // this whole check was already trust-based (never verified against
    // the X API), so this doesn't loosen anything that mattered.
    setTimeout(checkPendingActions, ACTION_MIN_AWAY_MS + 300);
  });
});

el.redeemBtn.addEventListener("click", async function () {
  el.redeemError.textContent = "";
  if (!state.xToken) { el.redeemError.textContent = "Connect X first."; return; }
  var code = el.redeemCode.value.trim();
  if (!code) { el.redeemError.textContent = "Enter a code."; return; }
  if (!backendReady()) { setMsg("This page isn't connected to a backend yet -- see README.md.", "error"); return; }

  el.redeemBtn.disabled = true;
  try {
    var data = await postAction("redeem", { token: state.xToken, code: code });
    if (data.ok) {
      state.spinsAvailable = data.spinsAvailable;
      updateBalanceLabel();
      el.redeemCode.value = "";
      setMsg("Code redeemed -- extra spins added.", "ok");
    } else if (data.error === "invalid_code") {
      el.redeemError.textContent = "That code isn't valid right now.";
    } else if (data.error === "already_redeemed") {
      el.redeemError.textContent = "You've already redeemed this code.";
    } else if (data.error === "invalid") {
      handleMaybeExpiredSession();
    } else {
      el.redeemError.textContent = "Couldn't redeem that code.";
    }
  } catch (e) {
    el.redeemError.textContent = "Couldn't reach the server -- try again.";
  } finally {
    el.redeemBtn.disabled = false;
  }
});

function logSpin(outcome) {
  var item = document.createElement("div");
  item.className = "spin-log-item" + (outcome === "win" ? " win" : outcome === "bonus" ? " bonus" : "");
  item.textContent = outcome === "win" ? "GTD WON!" : outcome === "bonus" ? "+1 bonus spin" : "No luck this time";
  el.spinLog.prepend(item);
  while (el.spinLog.children.length > 6) el.spinLog.removeChild(el.spinLog.lastChild);
}

el.spinBtn.addEventListener("click", async function () {
  if (!state.xToken) { setMsg("Connect X first.", "error"); return; }
  if (!backendReady()) { setMsg("This page isn't connected to a backend yet -- see README.md.", "error"); return; }
  if (state.spinning || state.spinsAvailable <= 0) return;

  state.spinning = true;
  el.spinBtn.disabled = true;
  el.spinBtnLabel.textContent = "...";
  setMsg("", null);

  try {
    var data = await postAction("spin", { token: state.xToken });
    if (!data.ok) {
      if (data.error === "no_spins") setMsg("No spins left -- follow, like, repost, comment, or redeem a code for more.", "error");
      else if (data.error === "closed") setMsg("Spinning is closed.", "info");
      else if (data.error === "invalid") handleMaybeExpiredSession();
      else setMsg("Couldn't spin right now -- try again.", "error");
      return;
    }

    await spinToOutcome(data.outcome);
    logSpin(data.outcome);
    state.spinsAvailable = data.spinsAvailable;
    updateGlobalStatus(data.totalWinners, data.maxWinners);

    if (data.outcome === "win") {
      state.hasWon = true;
      state.claimedAddress = "";
      showClaimCard();
      renderClaimState();
    }
  } catch (e) {
    setMsg("Couldn't reach the server -- try again in a moment.", "error");
  } finally {
    state.spinning = false;
    el.spinBtnLabel.textContent = "SPIN";
    updateBalanceLabel();
  }
});

// ---------------- claim (only reachable after an actual win) ----------------

function showClaimCard() {
  el.claimCard.hidden = false;
  el.claimCard.scrollIntoView({ behavior: "smooth", block: "center" });
}

// Reflects state.claimedAddress in the claim card. Split out from the
// claim button's success handler so the SAME "already locked in" view
// shows up on a plain page load/reload too -- previously the card always
// re-rendered as an empty input form on every visit even for someone
// who'd already locked an address in a past session, because that
// already-claimed check only ever ran right after a successful submit,
// never on load.
function renderClaimState() {
  if (!state.hasWon) return;
  if (state.claimedAddress) {
    el.claimForm.hidden = true;
    el.claimIntro.textContent = "Locked in. Keep an eye on X -- the guaranteed-mint window and exact mint date go out there first.";
    el.receipt.hidden = false;
    el.receipt.textContent = "@" + state.xHandle + "  ·  " + state.claimedAddress;
  } else {
    el.claimForm.hidden = false;
    el.claimIntro.textContent = "Enter the wallet you want your guaranteed mint on — this locks in your spot.";
    el.receipt.hidden = true;
  }
}

el.claimBtn.addEventListener("click", async function () {
  el.claimError.textContent = "";
  if (!state.xToken) { el.claimError.textContent = "Connect X first."; return; }
  var address = el.claimAddress.value.trim();
  if (!ADDR_RE.test(address)) { el.claimError.textContent = "Enter a valid EVM wallet address (0x... 42 characters)."; return; }
  if (!backendReady()) { el.claimError.textContent = "This page isn't connected to a backend yet."; return; }

  el.claimBtn.disabled = true;
  try {
    var data = await postAction("claim", { token: state.xToken, address: address });
    if (data.ok) {
      state.claimed = true;
      state.claimedAddress = address;
      renderClaimState();
    } else if (data.error === "invalid_address") {
      el.claimError.textContent = "Enter a valid EVM wallet address (0x... 42 characters).";
    } else if (data.error === "not_a_winner") {
      el.claimError.textContent = "This X account hasn't landed the GTD slice.";
    } else if (data.error === "invalid") {
      handleMaybeExpiredSession();
    } else {
      el.claimError.textContent = "Couldn't lock in that address -- try again.";
    }
  } catch (e) {
    el.claimError.textContent = "Couldn't reach the server -- try again.";
  } finally {
    el.claimBtn.disabled = false;
  }
});

// ---------------- boot ----------------

async function boot() {
  var restored = loadSession();
  if (restored) {
    state.xHandle = restored.handle;
    state.xToken = restored.token;
  }

  await consumeOAuthReturn(); // may overwrite state.xHandle/xToken with a fresh login

  drawWheel();
  wireLinks();
  renderConnectState();

  if (state.xHandle) {
    restoreActionsState();
    // Resolve anything that already cleared ACTION_MIN_AWAY_MS while this
    // page was gone/reloaded, and schedule the rest to resolve once their
    // own remaining time is up (covers the reload happening mid-wait).
    checkPendingActions();
    Object.keys(pendingActions).forEach(function (key) {
      var remaining = ACTION_MIN_AWAY_MS - (Date.now() - pendingActions[key]);
      setTimeout(checkPendingActions, Math.max(remaining, 0) + 300);
    });
  }
  renderActionButtons();
  loadGlobalStatus();
  updateBalanceLabel();

  // If we're connected (restored, or just came back from X), pull our
  // current spin balance / win status right away.
  if (state.xToken) syncActions();
}

boot();
