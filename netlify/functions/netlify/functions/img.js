// GET /api/img?u=<encoded i.etsystatic.com URL>
// Dynamic version of the old static _redirects image proxy: fetches an
// Etsy-hosted product photo server-side and streams it back from our own
// domain, so browsers never make a third-party request to i.etsystatic.com
// (that cross-origin request is what was getting silently blocked for some
// visitors' ad blockers / tracker-protection lists).
//
// Locked down to the i.etsystatic.com host only -- this must never become
// an open proxy for arbitrary URLs.

const ALLOWED_HOST = "i.etsystatic.com";

exports.handler = async function (event) {
  const raw = event.queryStringParameters && event.queryStringParameters.u;
  if (!raw) {
    return { statusCode: 400, body: "Missing ?u=" };
  }

  let target;
  try {
    target = new URL(raw);
  } catch {
    return { statusCode: 400, body: "Invalid URL" };
  }

  if (target.hostname !== ALLOWED_HOST || target.protocol !== "https:") {
    return { statusCode: 400, body: "Host not allowed" };
  }

  const upstream = await fetch(target.toString());
  if (!upstream.ok) {
    return { statusCode: upstream.status, body: "Upstream fetch failed" };
  }

  const contentType = upstream.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await upstream.arrayBuffer());

  return {
    statusCode: 200,
    headers: {
      "Content-Type": contentType,
      // Long, immutable cache -- pin images at a given URL don't change.
      "Cache-Control": "public, max-age=604800, immutable",
    },
    body: buf.toString("base64"),
    isBase64Encoded: true,
  };
};
