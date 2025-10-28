const https = require("https");

function postJson(urlString, apiKey, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const data = JSON.stringify(payload);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + (url.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        Authorization: apiKey ? `ApiKey ${apiKey}` : undefined,
        "kbn-xsrf": "true"
      }
    };
    const req = https.request(options, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve({ statusCode: res.statusCode }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

exports.handler = async (event = {}) => {
  const url = process.env.POLICY_LOG_URL;
  const apiKey = process.env.POLICY_LOG_API_KEY;

  if (!url) throw new Error("POLICY_LOG_URL must be set.");

  const payload = {
    timestamp: new Date().toISOString(),
    query: event.query ?? null,
    action: event.action ?? null,
    resolved_action: event.resolvedAction ?? null,
    complexity: event.complexity ?? null,
    reason: event.reason ?? null,
    metadata: event.metadata ?? event,
  };

  await postJson(url, apiKey, payload);
  return { status: "logged" };
};
