// GET /api/products
// Server-side: reads the yumikaai Etsy shop's live active listings and
// returns them mapped to the shape the front-end sticker cards expect.
// This is the real source of truth for what's for sale -- no OAuth needed,
// just an API key, since shop listings and images are public data.
//
// API-call budget matters here: Etsy's key is capped at 5 requests/second
// and 5,000 requests/day. Fetching images one listing at a time would cost
// ~1 call per product (~95 calls per refresh), which would burn the daily
// quota after ~50 cold starts. Instead this uses the BATCH endpoint
// (/listings/batch?listing_ids=...&includes=Images), which returns up to
// 100 listings *with their images* in a single call -- so a full refresh of
// ~95 products costs about 3 calls total.
//
// Required env vars (set in Netlify -> Project configuration -> Environment
// variables, never committed):
//   ETSY_API_KEY     -- the app's keystring from etsy.com/developers/your-apps
//   ETSY_SHOP_NAME   -- "yumikaai" (defaults to that if unset)

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const ACCENTS = ["coral", "teal", "mustard", "plum"];
const API_BASE = "https://openapi.etsy.com/v3/application";
const BATCH_SIZE = 100; // Etsy's max listing_ids per batch call

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

// One call per 100 listings, images embedded -- instead of one call per listing.
async function fetchListingsWithImages(listingIds) {
  const byId = new Map();
  for (let i = 0; i < listingIds.length; i += BATCH_SIZE) {
    const chunk = listingIds.slice(i, i + BATCH_SIZE);
    try {
      const json = await etsyFetch(
        `/listings/batch?listing_ids=${chunk.join(",")}&includes=Images`
      );
      for (const listing of json.results || []) {
        byId.set(listing.listing_id, listing);
      }
    } catch (err) {
      // A failed batch shouldn't kill the whole catalog -- those listings
      // just fall back to their non-enriched version (and get skipped if
      // they end up with no photo).
      console.warn("batch fetch failed:", String(err));
    }
  }
  return byId;
}

function pickImageUrl(listing) {
  const images = listing && listing.images;
  if (!Array.isArray(images) || images.length === 0) return null;
  const sorted = images.slice().sort((a, b) => (a.rank || 0) - (b.rank || 0));
  const img = sorted[0];
  return img.url_570xN || img.url_fullxfull || img.url_680x540 || img.url_170x135 || null;
}

// Products live behind our own dynamic proxy so the browser never talks to
// i.etsystatic.com directly -- keeps every image request same-origin,
// immune to any ad-blocker / tracker-protection list.
function proxiedImageUrl(etsyImageUrl) {
  return `/api/img?u=${encodeURIComponent(etsyImageUrl)}`;
}

// Most bundle titles already contain a PNG count, e.g.
// "Dog Clipart PNG Bundle, 55 Funny Nurse Dogs..." -> "55 PNG".
function extractTag(title) {
  const m = /(\d+)\s*png/i.exec(title || "");
  if (m) return `${m[1]} PNG bundle`;
  return "Digital PNG bundle";
}

// Etsy titles are long, keyword-stuffed strings. Take the part before the
// first comma as a readable card heading, and keep it to a sane length.
function cleanTitle(title) {
  const t = (title || "").trim();
  if (!t) return "Untitled bundle";
  const head = t.split(",")[0].trim();
  const chosen = head.length >= 12 ? head : t;
  return chosen.length > 70 ? chosen.slice(0, 67) + "…" : chosen;
}

function cleanDesc(listing) {
  const d = (listing.description || "").replace(/\s+/g, " ").trim();
  if (d) return d.length > 150 ? d.slice(0, 147) + "…" : d;
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
    const enriched = await fetchListingsWithImages(listings.map((l) => l.listing_id));

    const products = listings
      .map((listing) => {
        const full = enriched.get(listing.listing_id) || listing;
        const imageUrl = pickImageUrl(full);
        if (!imageUrl) return null; // skip listings with no usable photo
        return {
          id: listing.listing_id,
          title: cleanTitle(listing.title),
          desc: cleanDesc(listing),
          tag: extractTag(listing.title),
          img: proxiedImageUrl(imageUrl),
          url: listing.url || `https://www.etsy.com/listing/${listing.listing_id}`,
        };
      })
      .filter(Boolean)
      .map((p, i) => ({ ...p, accent: ACCENTS[i % ACCENTS.length] }));

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
      // Let Netlify's CDN absorb repeat traffic so the function (and the
      // Etsy quota behind it) is only hit occasionally.
      "Cache-Control": "public, max-age=300, s-maxage=1800",
      ...(fromCache ? { "X-Cache": "HIT" } : { "X-Cache": "MISS" }),
      ...(warning ? { "X-Warning": warning.slice(0, 200) } : {}),
    },
    body: JSON.stringify(data),
  };
}
