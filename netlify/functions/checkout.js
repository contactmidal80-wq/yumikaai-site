checkout.js// GET /checkout?products=id:qty,id:qty&coupon=CODE
// -> /.netlify/functions/checkout (see _redirects)
//
// This is the "Checkout URL" Meta Commerce Manager calls when a shopper
// taps checkout from the Yumikaai shop on Facebook or Instagram (Settings
// > Shop details > Checkout URL). See:
//   https://business.facebook.com/commerce/.../settings/checkout_url/
//
// Every product we sell is really an Etsy digital download -- there's no
// cart or payment to run on our own site. So this endpoint just resolves
// each Meta "product ID" (the catalog's Content ID / retailer_id, e.g.
// "985cd94d5092") back to the real Etsy listing URL, using
// data/product-links.json (exported from the same feed CSV that powers
// the Facebook/Instagram catalog), then sends the shopper straight to
// Etsy to actually buy.
//
//   - Exactly one distinct product  -> 302 redirect straight to Etsy.
//   - Several different listings    -> Etsy has no cross-listing cart URL,
//                                     so render a small branded page with
//                                     one "Continue on Etsy" button per
//                                     item instead of a dead end.
//   - Unknown / unmapped product ID -> fall back to the Etsy storefront.
//
// IMPORTANT: keep data/product-links.json in sync with the CSV used to
// build the Facebook/Instagram catalog feed -- when new products are
// added there, re-export and replace that file so checkout can resolve
// them too.

const productLinks = require("../../data/product-links.json");

const ETSY_SHOP_URL = "https://www.etsy.com/shop/yumikaai";

function parseProductIds(raw) {
  if (!raw) return [];
  // Meta sends "id:qty,id:qty" -- quantity doesn't matter here since each
  // Etsy listing's own page is where quantity/variations get picked.
  return raw
    .split(",")
    .map((entry) => entry.split(":")[0].trim())
    .filter(Boolean);
}

exports.handler = async function (event) {
  const params = event.queryStringParameters || {};
  const ids = parseProductIds(params.products);

  const resolved = ids
    .map((id) => productLinks[id])
    .filter(Boolean);

  // Nothing we recognize (bad/missing id) -- send them to the shop itself
  // rather than a dead end.
  if (resolved.length === 0) {
    return redirect(ETSY_SHOP_URL);
  }

  // One distinct listing: skip the extra click, go straight to Etsy.
  const uniqueUrls = [...new Set(resolved)];
  if (uniqueUrls.length === 1) {
    return redirect(uniqueUrls[0]);
  }

  // Multiple different listings in the same order: show a small page with
  // one button per item.
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: renderMultiItemPage(uniqueUrls),
  };
};

function redirect(url) {
  return {
    statusCode: 302,
    headers: { Location: url, "Cache-Control": "no-store" },
    body: "",
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function renderMultiItemPage(urls) {
  const rows = urls
    .map(
      (url, i) => `
      <a class="item" href="${escapeHtml(url)}" target="_blank" rel="noopener">
        <span class="num">${i + 1}</span>
        <span class="label">Continue to item ${i + 1} on Etsy</span>
        <span class="arrow">&rarr;</span>
      </a>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Continue your order on Etsy — Yumikaai</title>
<style>
  :root{ --paper:#fbf3e7; --ink:#241c15; --ink-soft:#5a4d3f; --coral:#e2552b; --teal:#177f77; }
  *{box-sizing:border-box;}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:Karla,system-ui,-apple-system,sans-serif;
       min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
  .card{max-width:440px;width:100%;background:#fff;border-radius:20px;padding:32px 28px;
        box-shadow:0 10px 30px rgba(36,28,21,0.10);}
  h1{font-family:"Baloo 2",sans-serif;font-size:22px;margin:0 0 8px;}
  p.sub{color:var(--ink-soft);margin:0 0 24px;font-size:14px;line-height:1.5;}
  .item{display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px;
        border:1px solid #eee0cc;text-decoration:none;color:var(--ink);margin-bottom:10px;
        transition:border-color .15s;}
  .item:hover{border-color:var(--coral);}
  .num{width:24px;height:24px;border-radius:50%;background:var(--teal);color:#fff;
       display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex:none;}
  .label{flex:1;font-weight:600;font-size:14px;}
  .arrow{color:var(--coral);font-weight:700;}
  .note{margin-top:20px;font-size:12px;color:var(--ink-soft);}
</style>
</head>
<body>
  <div class="card">
    <h1>Almost there!</h1>
    <p class="sub">Your order includes ${urls.length} items from different listings. Etsy checks out one listing at a time, so open each one below to finish your purchase securely on Etsy.</p>
    ${rows}
    <p class="note">You'll pay securely on Etsy — Yumikaai's official storefront.</p>
  </div>
</body>
</html>`;
}
