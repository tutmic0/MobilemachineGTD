"use strict";

/**
 * Everything you need to edit before going live is right here.
 *
 * GOOGLE_SCRIPT_URL: paste the Web App URL you get from deploying
 *   google-apps-script/Code.gs (see README.md step 2). This is also
 *   the exact URL you register as the X app's OAuth redirect URI.
 * xHandle: your X handle, WITHOUT the @.
 * xPostUrl: the link to the actual announcement post people need to
 *   like/repost/comment on -- update this the moment you post it.
 * enrollmentClosed: flip to true once you're done spinning entirely
 *   (also flip ENROLLMENT_CLOSED in Code.gs to match -- that's what
 *   actually blocks the backend, this just controls the UI).
 *
 * The odds (win/bonus probability) and the total GTD cap for this
 * campaign live in Code.gs, not here -- the browser is never trusted
 * to decide or even know the exact odds, only the backend is.
 *
 * Identity: there's no typed "X handle" field anymore. Clicking
 * "Connect X" sends people through a real X OAuth 2.0 login (handled
 * entirely by Code.gs, see its "Connect X" section) and they come back
 * with a signed session token that proves the handle. The 4 actions
 * below are still just "open the link, and if you're gone at least 5
 * seconds, we trust you did it" -- see README.md for why.
 */
var CONFIG = {
  GOOGLE_SCRIPT_URL: "PASTE_YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE",
  xHandle: "MobileMachines",
  xPostUrl: "https://x.com/MobileMachines/status/REPLACE_ME",
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
  expired_state: "That login link expired -- click Connect X again.",
  token_exchange_failed: "Couldn't complete the X login -- try again in a moment.",
  profile_read_failed: "Connected to X but couldn't read your handle -- try again.",
  exception: "Something went wrong connecting to X -- try again.",
};

var el = {
  xConnectBtn: document.getElementById("x-connect-btn"),
  xConnectedChip: document.getElementById("x-connected-chip"),
  xConnectedHandle: document.getElementById("x-connected-handle"),
  xDisconnectBtn: document.getElementById("x-disconnect-btn"),
  connectError: document.getElementById("connect-error"),
  address: document.getElementById("address"),
  addressError: document.getElementById("address-error"),
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
  successCard: document.getElementById("success-card"),
  receipt: document.getElementById("receipt"),
  statusCount: document.getElementById("status-count"),
  progressFill: document.getElementById("progress-fill"),
  statusNote: document.getElementById("status-note"),
};

var state = {
  xHandle: null,
  xToken: null,
  registered: false,
  spinsAvailable: 0,
  hasWon: false,
  wheelRotation: 0,
  spinning: false,
  actionsDone: { follow: false, like: false, repost: false, comment: false },
};

// key -> timestamp when the user clicked out. Checked on every
// visibility/focus change; cleared once ACTION_MIN_AWAY_MS has passed.
var pendingActions = {};

function wireLinks() {
  var profileUrl = "https://x.com/" + CONFIG.xHandle;
  var heroLink = document.getElementById("hero-x-link");
  var followLink = document.getElementById("step-follow-link");
  if (heroLink) heroLink.href = profileUrl;
  if (followLink) followLink.href = profileUrl;
  ["step-post-link-1", "step-post-link-2", "step-post-link-3"].forEach(function (id) {
    var node = document.getElementById(id);
    if (node) node.href = CONFIG.xPostUrl;
  });
  var stepHandle = document.getElementById("step-handle-1");
  if (stepHandle) stepHandle.textContent = "@" + CONFIG.xHandle;
  var actFollowHandle = document.getElementById("act-follow-handle");
  if (actFollowHandle) actFollowHandle.textContent = "@" + CONFIG.xHandle;
}

function setMsg(text, type) {
  el.formMsg.textContent = text;
  el.formMsg.className = "form-msg" + (text ? " show" : "") + (type ? " " + type : "");
}

// ---------------- session storage (per-tab, matches the token's own TTL) ----------------

function saveSession(handle, token) {
  try {
    sessionStorage.setItem("mm_x_handle", handle);
    sessionStorage.setItem("mm_x_token", token);
  } catch (e) { /* private mode etc -- session just won't survive a reload */ }
}

function loadSession() {
  try {
    var handle = sessionStorage.getItem("mm_x_handle");
    var token = sessionStorage.getItem("mm_x_token");
    if (handle && token) return { handle: handle, token: token };
  } catch (e) { /* ignore */ }
  return null;
}

function clearSession() {
  try {
    sessionStorage.removeItem("mm_x_handle");
    sessionStorage.removeItem("mm_x_token");
  } catch (e) { /* ignore */ }
}

function saveAddress(addr) {
  try { sessionStorage.setItem("mm_address", addr); } catch (e) { /* ignore */ }
}

function loadAddress() {
  try { return sessionStorage.getItem("mm_address") || ""; } catch (e) { return ""; }
}

// ---------------- "Connect X" redirect handling ----------------

function consumeConnectHash() {
  var hash = window.location.hash || "";
  if (hash.indexOf("#connected") === 0) {
    var qs = hash.slice(hash.indexOf("&") + 1);
    var params = new URLSearchParams(qs);
    var handle = params.get("handle");
    var token = params.get("token");
    history.replaceState(null, "", window.location.pathname + window.location.search);
    if (handle && token) {
      state.xHandle = handle;
      state.xToken = token;
      saveSession(handle, token);
      setMsg("", null);
    }
    return;
  }
  if (hash.indexOf("#connect_error") === 0) {
    var qs2 = hash.slice(hash.indexOf("&") + 1);
    var params2 = new URLSearchParams(qs2);
    var reason = params2.get("reason") || "";
    history.replaceState(null, "", window.location.pathname + window.location.search);
    el.connectError.textContent = CONNECT_ERROR_MESSAGES[reason] || "Couldn't connect X -- try again.";
    return;
  }
}

function renderConnectState() {
  var connected = !!(state.xHandle && state.xToken);
  el.xConnectBtn.hidden = connected;
  el.xConnectedChip.hidden = !connected;
  if (connected) el.xConnectedHandle.textContent = "@" + state.xHandle;
}

el.xConnectBtn.addEventListener("click", function () {
  if (!backendReady()) { setMsg("This page isn't connected to a backend yet -- see README.md.", "error"); return; }
  window.location.href = CONFIG.GOOGLE_SCRIPT_URL + "?action=oauth_start";
});

el.xDisconnectBtn.addEventListener("click", function () {
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
  ctx.arc(cx, cy, r * 0.14, 0, Math.PI * 2);
  ctx.fillStyle = "#090b0c";
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#2fae95";
  ctx.stroke();

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

function backendReady() {
  return CONFIG.GOOGLE_SCRIPT_URL && CONFIG.GOOGLE_SCRIPT_URL.indexOf("PASTE_YOUR") !== 0;
}

async function postAction(action, payload) {
  var res = await fetch(CONFIG.GOOGLE_SCRIPT_URL, {
    method: "POST",
    body: JSON.stringify(Object.assign({ action: action }, payload)),
  });
  return res.json();
}

async function loadGlobalStatus() {
  if (!backendReady()) {
    el.statusNote.textContent = "Backend not connected yet -- see README.md.";
    return;
  }
  try {
    var res = await fetch(CONFIG.GOOGLE_SCRIPT_URL + "?action=status");
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

function addressValue() {
  return el.address.value.trim();
}

function currentIdentity() {
  var address = addressValue();
  var ok = true;

  if (!state.xToken || !state.xHandle) {
    el.connectError.textContent = "Connect X first.";
    ok = false;
  } else {
    el.connectError.textContent = "";
  }
  if (!ADDR_RE.test(address)) {
    el.addressError.textContent = "Enter a valid EVM wallet address (0x... 42 characters).";
    ok = false;
  } else {
    el.addressError.textContent = "";
  }
  return ok ? { token: state.xToken, address: address } : null;
}

function updateBalanceLabel() {
  if (state.hasWon) {
    el.spinBalance.innerHTML = "You already landed the GTD slice -- no more spins needed.";
    el.spinBtn.disabled = true;
    return;
  }
  if (!state.xToken) {
    el.spinBalance.innerHTML = "Connect X to unlock spins";
  } else {
    el.spinBalance.innerHTML = "Spins available: <b>" + state.spinsAvailable + "</b>";
  }
  el.spinBtn.disabled = state.spinsAvailable <= 0 || CONFIG.enrollmentClosed || state.spinning;
}

async function syncActions() {
  if (!state.xToken) return; // nothing to sync until they've connected X
  var address = addressValue();
  if (!ADDR_RE.test(address)) return; // wait until a real address is entered
  if (!backendReady()) {
    setMsg("This page isn't connected to a backend yet -- see README.md.", "error");
    return;
  }
  try {
    var data = await postAction("register", {
      token: state.xToken,
      address: address,
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
    state.registered = true;
    state.spinsAvailable = data.spinsAvailable;
    state.hasWon = !!data.hasWon;
    setMsg("", null);
    updateBalanceLabel();
    if (typeof data.totalWinners === "number") updateGlobalStatus(data.totalWinners, data.maxWinners);
  } catch (e) {
    setMsg("Couldn't reach the server -- try again in a moment.", "error");
  }
}

el.address.addEventListener("blur", function () {
  if (addressValue()) saveAddress(addressValue());
  syncActions();
});

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
    var urlFn = ACTION_LINKS[key];
    window.open(urlFn(), "_blank", "noopener");
    pendingActions[key] = Date.now();
    renderActionButtons();
  });
});

el.redeemBtn.addEventListener("click", async function () {
  el.redeemError.textContent = "";
  var identity = currentIdentity();
  if (!identity) { el.redeemError.textContent = "Connect X and enter your wallet address first."; return; }
  var code = el.redeemCode.value.trim();
  if (!code) { el.redeemError.textContent = "Enter a code."; return; }
  if (!backendReady()) { setMsg("This page isn't connected to a backend yet -- see README.md.", "error"); return; }

  el.redeemBtn.disabled = true;
  try {
    var data = await postAction("redeem", Object.assign({}, identity, { code: code }));
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
  var identity = currentIdentity();
  if (!identity) { setMsg("Connect X and enter your wallet address first.", "error"); return; }
  if (!backendReady()) { setMsg("This page isn't connected to a backend yet -- see README.md.", "error"); return; }
  if (state.spinning || state.spinsAvailable <= 0) return;

  state.spinning = true;
  el.spinBtn.disabled = true;
  el.spinBtnLabel.textContent = "...";
  setMsg("", null);

  try {
    var data = await postAction("spin", identity);
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
      el.successCard.hidden = false;
      el.receipt.textContent = "@" + state.xHandle + "  ·  " + identity.address;
      el.successCard.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  } catch (e) {
    setMsg("Couldn't reach the server -- try again in a moment.", "error");
  } finally {
    state.spinning = false;
    el.spinBtnLabel.textContent = "SPIN";
    updateBalanceLabel();
  }
});

// ---------------- boot ----------------

consumeConnectHash();

var restored = state.xToken ? null : loadSession();
if (restored) {
  state.xHandle = restored.handle;
  state.xToken = restored.token;
}
var restoredAddress = loadAddress();
if (restoredAddress) el.address.value = restoredAddress;

drawWheel();
wireLinks();
renderConnectState();
renderActionButtons();
loadGlobalStatus();
updateBalanceLabel();

// If we just came back connected (or restored from a prior visit) and
// already have a wallet address, sync right away so spins are ready.
if (state.xToken && ADDR_RE.test(addressValue())) syncActions();
