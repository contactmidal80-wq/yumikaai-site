// GET /api/products
// Server-side: reads the yumikaai Etsy shop's live active listings and
// returns them mapped to the shape the front-end sticker cards expect.
// This is the real source of truth for what's for sale -- no OAuth needed,
// just an API key, since shop listings and images are public data.
// Cached in-memory for CACHE_TTL_MS so a burst of visitors doesn't cost
// one Etsy call per pageview.
//
// Required env vars (set in Netlify -> Project configuration -> Environment
// variables, never committed):
//   ETSY_API_KEY    -- the app's keystring from etsy.com/developers/your-apps
//   ETSY_SHOP_NAME   -- "yumikaai" (defaults to that if unset)

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const ACCENTS = ["coral", "teal", "mustard", "plum"];
const API_BASE = "https://openapi.etsy.com/v3/application";
const IMAGE_CONCURRENCY = 6; // stay polite to Etsy's per-second rate limit

let cache = { at: 0, data: null };
let shopIdCache = null; // shop_id barely ever changes -- resolve once per cold start

function apiKey() {
  const key = process.env.ETSY_API_KEY;
  if (!key) throw new Error("ETSY_API_KEY is not configured (missing env var)");
  return key;
}

async function etsyFetch(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "x-api-key": apiKey() },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Etsy API ${path} failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function resolveShopId() {
  if (shopIdCache) return shopIdCache;
  const shopName = process.env.ETSY_SHOP_NAME || "yumikaai";
  const json = await etsyFetch(`/shops?shop_name=${encodeURIComponent(shopName)}`);
  const shop = (json.results || [])[0];
  if (!shop) throw new Error(`No Etsy shop found named "${shopName}"`);
  shopIdCache = shop.shop_id;
  return shopIdCache;
}

async function fetchAllActiveListings(shopId) {
  const items = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const json = await etsyFetch(
      `/shops/${shopId}/listings/active?limit=${limit}&offset=${offset}`
    );
    items.push(...(json.results || []));
    if (!json.results || json.results.length < limit) break;
    offset += limit;
  }
  return items;
}

// Products live behind our own dynamic proxy so the browser never talks to
// i.etsystatic.com directly -- keeps every image request same-origin,
// immune to any ad-blocker / tracker-protection list.
function proxiedImageUrl(etsyImageUrl) {
  return `/api/img?u=${encodeURIComponent(etsyImageUrl)}`;
}

async function fetchPrimaryImage(listingId) {
  try {
    const json = await etsyFetch(`/listings/${listingId}/images`);
    const images = (json.results || []).slice().sort((a, b) => (a.rank || 0) - (b.rank || 0));
    const img = images[0];
    if (!img) return null;
    return img.url_570xN || img.url_fullxfull || img.url_170x135 || null;
  } catch {
    return null; // skip this listing's photo rather than fail the whole batch
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Most bundle titles already contain a PNG count, e.g.
// "Dog Clipart PNG Bundle, 55 Funny Nurse Dogs..." -> "55 PNG".
function extractTag(title) {
  const m = /(\d+)\s*png/i.exec(title || "");
  if (m) return `${m[1]} PNG bundle`;
  return "Digital PNG bundle";
}

function cleanDesc(listing) {
  const d = (listing.description || "").trim();
  if (d) return d.length > 160 ? d.slice(0, 157) + "…" : d;
  return "Commercial-use PNG clipart, ready for sublimation, stickers and print on demand.";
}

exports.handler = async function () {
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_TTL_MS) {
    return respond(200, cache.data, true);
  }

  try {
    const shopId = await resolveShopId();
    const listings = await fetchAllActiveListings(shopId);

    const withImages = await mapWithConcurrency(listings, IMAGE_CONCURRENCY, async (listing) => {
      const imageUrl = await fetchPrimaryImage(listing.listing_id);
      return { listing, imageUrl };
    });

    const products = withImages
      .map(({ listing, imageUrl }, i) => {
        if (!imageUrl) return null; // skip listings with no usable photo
        return {
          id: listing.listing_id,
          title: listing.title || "Untitled bundle",
          desc: cleanDesc(listing),
          tag: extractTag(listing.title),
          accent: ACCENTS[i % ACCENTS.length],
          img: proxiedImageUrl(imageUrl),
          url: listing.url || null,
        };
      })
      .filter(Boolean);

    cache = { at: now, data: products };
    return respond(200, products, false);
  } catch (err) {
    // Serve stale cache rather than a broken page, if we have one.
    if (cache.data) {
      return respond(200, cache.data, true, String(err));
    }
    return respond(502, { error: String(err) }, false);
  }
};

function respond(statusCode, data, fromCache, warning) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60", // browsers/CDN can cache briefly too
      ...(fromCache ? { "X-Cache": "HIT" } : { "X-Cache": "MISS" }),
      ...(warning ? { "X-Warning": warning.slice(0, 200) } : {}),
    },
    body: JSON.stringify(data),
  };
}
