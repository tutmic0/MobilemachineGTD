function sendJson(res, status, obj) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(obj));
}

// Vercel's Node runtime auto-parses the body into req.body when
// Content-Type is application/json (which js/main.js now sends, since
// everything is same-origin -- no more CORS-preflight reasons to avoid
// it). Handle a couple of other shapes too, just in case.
async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.length) {
    try {
      return JSON.parse(req.body);
    } catch (e) {
      return {};
    }
  }
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (e) {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

module.exports = { sendJson, readJsonBody };
