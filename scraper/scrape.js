// Bucks County, PA dealer-inventory scraper (sharded).
// Renders each dealer's JavaScript inventory with Playwright, walks every listing
// page, opens every vehicle detail page, and extracts real fields — VIN, specs,
// pricing, description, and photo URLs. Nothing is fabricated: unpublished fields
// stay null/empty.
//
// SHARDED MODE (used by GitHub Actions): pass one dealer id and this writes only
//   data/dealers/<id>.json     -> node scraper/scrape.js --dealer fred-beans-gmc
// FULL MODE (local convenience): no dealer arg scrapes every dealer into shards.
// A separate merge.js assembles shards into the master dataset + change log.
//
// Env knobs: CONCURRENCY (default 6), MAX_PER_DEALER (0 = all), PAGE_SIZE (18),
//            MAX_PAGES (200), PHOTOS_PER_VEHICLE (0 = all).

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHARD_DIR = path.join(ROOT, 'data', 'dealers');
const { dealers } = require('./dealers.json');

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '6', 10);
const MAX_PER_DEALER = parseInt(process.env.MAX_PER_DEALER || '0', 10);
const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || '18', 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '200', 10);
const PHOTOS_PER_VEHICLE = parseInt(process.env.PHOTOS_PER_VEHICLE || '0', 10);
const NAV_TIMEOUT = 60000;

// Which dealer(s) this invocation handles.
function targetDealers() {
  const argIdx = process.argv.indexOf('--dealer');
  const id = process.env.DEALER_ID || (argIdx >= 0 ? process.argv[argIdx + 1] : null);
  if (!id) return dealers;
  const d = dealers.find((x) => x.id === id);
  if (!d) {
    console.error(`Unknown dealer id: ${id}`);
    process.exit(1);
  }
  return [d];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collectVdpUrls(page, dealer) {
  const found = new Set();
  const base = dealer.inventoryUrl;
  for (let p = 0; p < MAX_PAGES; p++) {
    const url = base.includes('?') ? `${base}&start=${p * PAGE_SIZE}` : `${base}?start=${p * PAGE_SIZE}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await page.waitForTimeout(1500);
    } catch (e) {
      break;
    }
    const links = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')).filter(Boolean));
    const vdps = links
      .filter((h) => /\/(used|certified|certified-used|new)\//i.test(h) && /\.htm/i.test(h))
      .map((h) => (h.startsWith('http') ? h : new URL(h, url).href));
    const before = found.size;
    vdps.forEach((v) => found.add(v.split('#')[0]));
    if (found.size === before) break;
    if (MAX_PER_DEALER && found.size >= MAX_PER_DEALER) break;
    await sleep(500);
  }
  let arr = [...found];
  if (MAX_PER_DEALER) arr = arr.slice(0, MAX_PER_DEALER);
  return arr;
}

function findVehicleLd(blocks) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const t = node['@type'];
    const types = Array.isArray(t) ? t : [t];
    if (types.some((x) => /Vehicle|Car|Product/i.test(x || ''))) out.push(node);
    Object.values(node).forEach(visit);
  };
  blocks.forEach((b) => { try { visit(JSON.parse(b)); } catch (_) {} });
  return out;
}

const num = (v) => {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

async function scrapeVehicle(page, url, dealer) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(1200);

  const ldBlocks = await page
    .$$eval('script[type="application/ld+json"]', (els) => els.map((e) => e.textContent))
    .catch(() => []);
  const v = findVehicleLd(ldBlocks)[0] || {};

  let photos = [];
  const ldImg = v.image;
  if (Array.isArray(ldImg)) photos = ldImg.map((x) => (typeof x === 'string' ? x : x.url)).filter(Boolean);
  else if (typeof ldImg === 'string') photos = [ldImg];
  if (photos.length === 0) {
    photos = await page
      .$$eval('img', (imgs) => imgs.map((i) => i.currentSrc || i.src || i.getAttribute('data-src') || '')
        .filter((s) => /pictures\.dealer\.com|inventoryphotos|vehicle/i.test(s)))
      .catch(() => []);
  }
  photos = [...new Set(photos.map((s) => s.split('?')[0]))];
  if (PHOTOS_PER_VEHICLE > 0) photos = photos.slice(0, PHOTOS_PER_VEHICLE);

  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  const grab = (label) => {
    const m = text.match(new RegExp(label + '\\s*[:\\n]\\s*([^\\n]+)', 'i'));
    return m ? m[1].trim() : null;
  };
  const priceMatch = text.match(/Sale Price\s*\$?([0-9,]+)/i) || text.match(/\$([0-9,]{3,})/);
  const marketMatch = text.match(/Market Value Price\s*\$?([0-9,]+)/i);

  const vin = v.vehicleIdentificationNumber || grab('VIN') || (url.match(/[A-HJ-NPR-Z0-9]{17}/) || [])[0] || null;

  return {
    dealerId: dealer.id,
    listingUrl: url,
    vin,
    stockNumber: v.sku || grab('Stock Number') || grab('Stock #'),
    year: num(v.vehicleModelDate || v.modelDate || v.productionDate) || num((v.name || '').match(/\b(19|20)\d{2}\b/)),
    make: (v.brand && (v.brand.name || v.brand)) || grab('Make'),
    model: (v.model && (v.model.name || v.model)) || grab('Model'),
    trim: v.vehicleConfiguration || grab('Trim') || null,
    bodyStyle: v.bodyType || grab('Body Style') || null,
    condition: /certified/i.test(url) ? 'Certified' : /\/new\//i.test(url) ? 'New' : 'Used',
    mileage: num(v.mileageFromOdometer && (v.mileageFromOdometer.value || v.mileageFromOdometer)) || num(grab('Odometer')),
    exteriorColor: v.color || grab('Exterior Color'),
    interiorColor: v.vehicleInteriorColor || grab('Interior Color'),
    engine: (v.vehicleEngine && (v.vehicleEngine.name || v.vehicleEngine.engineType)) || grab('Engine'),
    transmission: v.vehicleTransmission || grab('Transmission'),
    drivetrain: v.driveWheelConfiguration || grab('Drivetrain'),
    fuelType: v.fuelType || null,
    fuelEconomyMpg: grab('Fuel Economy'),
    salePrice: num(v.offers && (v.offers.price || (v.offers[0] && v.offers[0].price))) || num(priceMatch && priceMatch[1]),
    marketValuePrice: num(marketMatch && marketMatch[1]),
    availability: /On the Lot|In Stock|In-Stock/i.test(text) ? 'In Stock' : (v.offers && v.offers.availability) || null,
    photoCount: photos.length,
    photos,
    description: (v.description || grab('Dealer Notes') || '').trim().slice(0, 4000) || null,
    scrapedAt: new Date().toISOString(),
  };
}

async function pool(items, worker, size) {
  const results = [];
  let i = 0;
  const runners = Array.from({ length: size }).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await worker(items[idx]); } catch (e) { results[idx] = null; }
    }
  });
  await Promise.all(runners);
  return results.filter(Boolean);
}

// Scrape one dealer and write its shard file.
async function scrapeDealer(context, dealer) {
  const listPage = await context.newPage();
  listPage.setDefaultTimeout(NAV_TIMEOUT);
  let vdps = [];
  try { vdps = await collectVdpUrls(listPage, dealer); }
  catch (e) { console.error(`[${dealer.id}] listing failed: ${e.message}`); }
  await listPage.close();
  console.log(`[${dealer.id}] ${vdps.length} vehicle pages`);

  const vehicles = await pool(vdps, async (url) => {
    const p = await context.newPage();
    p.setDefaultTimeout(NAV_TIMEOUT);
    try { return await scrapeVehicle(p, url, dealer); } finally { await p.close(); }
  }, CONCURRENCY);

  const clean = vehicles.filter((v) => v && v.vin);
  const shard = {
    dealer: { id: dealer.id, name: dealer.name, town: dealer.town, inventoryUrl: dealer.inventoryUrl, financing: dealer.financing },
    vehicleCount: clean.length,
    scrapedAt: new Date().toISOString(),
    vehicles: clean,
  };
  fs.mkdirSync(SHARD_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHARD_DIR, `${dealer.id}.json`), JSON.stringify(shard, null, 2));
  console.log(`[${dealer.id}] wrote shard with ${clean.length} vehicles`);
  return clean.length;
}

async function main() {
  const targets = targetDealers();
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });
  let total = 0;
  for (const d of targets) total += await scrapeDealer(context, d);
  await browser.close();
  console.log(`DONE: ${total} vehicles across ${targets.length} dealer(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
