import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const ACCENTS = ["coral", "teal", "mustard", "plum"];
const API_BASE = "https://openapi.etsy.com/v3/application";
const BATCH_SIZE = 100;
const HERO_SRC = "https://i.pinimg.com/736x/3c/ed/fc/3cedfc91311cc8e52ed4f273fd8bbacb.jpg";

function apiKey() {
  const key = process.env.ETSY_API_KEY;
  if (!key) throw new Error("ETSY_API_KEY is not configured");
  return key;
}

async function etsyFetch(path) {
  const res = await fetch(API_BASE + path, { headers: { "x-api-key": apiKey() } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error("Etsy API " + path + " failed (" + res.status + "): " + body);
  }
  return res.json();
}

async function resolveShopId() {
  const shopName = process.env.ETSY_SHOP_NAME || "yumikaai";
  const json = await etsyFetch("/shops?shop_name=" + encodeURIComponent(shopName));
  const shop = (json.results || [])[0];
  if (!shop) throw new Error('No Etsy shop found named "' + shopName + '"');
  return shop.shop_id;
}

async function fetchAllActiveListings(shopId) {
  const items = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const json = await etsyFetch("/shops/" + shopId + "/listings/active?limit=" + limit + "&offset=" + offset);
    items.push(...(json.results || []));
    if (!json.results || json.results.length < limit) break;
    offset += limit;
  }
  return items;
}

async function fetchListingsWithImages(listingIds) {
  const byId = new Map();
  for (let i = 0; i < listingIds.length; i += BATCH_SIZE) {
    const chunk = listingIds.slice(i, i + BATCH_SIZE);
    try {
      const json = await etsyFetch("/listings/batch?listing_ids=" + chunk.join(",") + "&includes=Images");
      for (const listing of json.results || []) byId.set(listing.listing_id, listing);
    } catch (err) {}
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

function extractTag(title) {
  const m = /(\d+)\s*png/i.exec(title || "");
  return m ? m[1] + " PNG bundle" : "Digital PNG bundle";
}

function cleanTitle(title) {
  const t = (title || "").trim();
  if (!t) return "Untitled bundle";
  const head = t.split(",")[0].trim();
  const chosen = head.length >= 12 ? head : t;
  return chosen.length > 70 ? chosen.slice(0, 67) + "..." : chosen;
}

function cleanDesc(listing) {
  const d = (listing.description || "").replace(/\s+/g, " ").trim();
  if (d) return d.length > 150 ? d.slice(0, 147) + "..." : d;
  return "Commercial-use PNG clipart, ready for sublimation, stickers and print on demand.";
}

async function downloadImage(remoteUrl, localPath) {
  try {
    const res = await fetch(remoteUrl);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, buf);
    return "/" + localPath;
  } catch (err) {
    return null;
  }
}

async function main() {
  const shopId = await resolveShopId();
  const listings = await fetchAllActiveListings(shopId);
  const enriched = await fetchListingsWithImages(listings.map((l) => l.listing_id));

  const products = [];
  for (const listing of listings) {
    const full = enriched.get(listing.listing_id) || listing;
    const remoteImg = pickImageUrl(full);
    if (!remoteImg) continue;
    const local = await downloadImage(remoteImg, "assets/products/" + listing.listing_id + ".jpg");
    products.push({
      id: listing.listing_id,
      title: cleanTitle(listing.title),
      desc: cleanDesc(listing),
      tag: extractTag(listing.title),
      img: local || remoteImg,
      url: listing.url || "https://www.etsy.com/listing/" + listing.listing_id,
    });
  }
  products.forEach((p, i) => (p.accent = ACCENTS[i % ACCENTS.length]));

  await mkdir("api", { recursive: true });
  await writeFile("api/products", JSON.stringify(products, null, 2));
  await downloadImage(HERO_SRC, "img/hero.jpg");
  console.log("Done.");
}

main().catch((err) => { console.error(err); process.exit(1); });
