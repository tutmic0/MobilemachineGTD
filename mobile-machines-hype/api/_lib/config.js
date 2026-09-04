// Everything tunable about the campaign lives here, same idea as the top
// of the old Code.gs -- edit a value, commit, push, Vercel redeploys it.
// Secrets (X_CLIENT_SECRET, SESSION_SECRET, the database connection) are
// NOT here -- those live in Vercel Project Settings -> Environment
// Variables, never in git.
module.exports = {
  MAX_WINNERS: 1000,        // hard cap on GTD winners for this campaign
  WIN_PROBABILITY: 0.05,    // 5% per spin, while spots remain
  BONUS_PROBABILITY: 0.12,  // 12% per spin -- grants +1 spin
  CURRENT_CODE: "SIGNAL01", // change this every time you post a new announcement
  SPINS_PER_CODE: 10,       // how many extra spins CURRENT_CODE is worth
  ENROLLMENT_CLOSED: false, // keep in sync with CONFIG.enrollmentClosed in js/main.js

  X_CLIENT_ID: "MVJQLVhKbWRMTkxkM3BIay1aSXk6MTpjaQ",
  SITE_URL: "https://www.mobilemachine.xyz/", // must exactly match js/main.js CONFIG.xOauthRedirectUri and the X Developer Portal Callback URI
};
