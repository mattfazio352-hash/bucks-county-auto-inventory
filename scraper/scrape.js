// Nightly Bucks County, PA dealer-inventory scraper.
// Renders each dealer's JavaScript inventory with Playwright (headless Chromium),
// walks every listing page, opens every vehicle detail page (VDP), and extracts
// real fields — VIN, specs, pricing, description, and ALL photo URLs. It then
// diffs against last night's dataset and writes:
//   data/bucks_inventory_dataset.json   (full current inventory — app reads this)
//   data/change_log.md                  (dated summary of price/availability changes)
//
// Nothing is fabricated: any field a dealer does not publish is left null/empty.
//
// Run: node scraper/scrape.js
// Env knobs: CONCURRENCY (default 4), MAX_PER_DEALER (0 = all), PAGE_SIZE (default 18),
//            MAX_PAGES (default 200), PHOTOS_PER_VEHICLE (0 = all).

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bucks_inventory_dataset.json');
const CHANGELOG = path.join(DATA_DIR, 'change_log.md');
const { dealers } = require('./dealers.json');

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);
const MAX_PER_DEALER = parseInt(process.env.MAX_PER_DEALER || '0', 10);
const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || '18', 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '200', 10);
const PHOTOS_PER_VEHICLE = parseInt(process.env.PHOTOS_PER_VEHICLE || '0', 10);
const NAV_TIMEOUT = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Listing crawl: collect vehicle-detail-page URLs from a dealer's inventory.
// Handles Dealer.com's ?start=N pagination and a generic "next link" fallback.
// ---------------------------------------------------------------------------
async function collectVdpUrls(page, dealer) {
  const found = new Set();
  const base = dealer.inventoryUrl;
  for (let p = 0; p < MAX_PAGES; p++) {
    const url = base.includes('?')
      ? `${base}&start=${p * PAGE_SIZE}`
      : `${base}?start=${p * PAGE_SIZE}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await page.waitForTimeout(1500); // let JS inject the listing
    } catch (e) {
      break;
    }
    const links = await page.$$eval('a[href]', (as) =>
      as.map((a) => a.getAttribute('href')).filter(Boolean)
    );
    const vdps = links
      .filter((h) => /\/(used|certified|certified-used|new)\//i.test(h) && /\.htm/i.test(h))
      .map((h) => (h.startsWith('http') ? h : new URL(h, url).href));

    const before = found.size;
    vdps.forEach((v) => found.add(v.split('#')[0]));
    // Stop when a page adds nothing new (end of inventory) or we hit the cap.
    if (found.size === before) break;
    if (MAX_PER_DEALER && found.size >= MAX_PER_DEALER) break;
    await sleep(500);
  }
  let arr = [...found];
  if (MAX_PER_DEALER) arr = arr.slice(0, MAX_PER_DEALER);
  return arr;
}

// Deep-search JSON-LD blocks for a Vehicle/Car/Product node.
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
  blocks.forEach((b) => {
    try {
      visit(JSON.parse(b));
    } catch (_) {}
  });
  return out;
}

const num = (v) => {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// VDP extraction: JSON-LD first (most reliable across platforms), then a DOM
// / innerText fallback for anything the schema omits.
// ---------------------------------------------------------------------------
async function scrapeVehicle(page, url, dealer) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(1200);

  const ldBlocks = await page
    .$$eval('script[type="application/ld+json"]', (els) => els.map((e) => e.textContent))
    .catch(() => []);
  const nodes = findVehicleLd(ldBlocks);
  const v = nodes[0] || {};

  // Photos: JSON-LD image[] (usually the full gallery) + DOM fallback.
  let photos = [];
  const ldImg = v.image;
  if (Array.isArray(ldImg)) photos = ldImg.map((x) => (typeof x === 'string' ? x : x.url)).filter(Boolean);
  else if (typeof ldImg === 'string') photos = [ldImg];
  if (photos.length === 0) {
    photos = await page
      .$$eval('img', (imgs) =>
        imgs
          .map((i) => i.currentSrc || i.src || i.getAttribute('data-src') || '')
          .filter((s) => /pictures\.dealer\.com|inventoryphotos|vehicle/i.test(s))
      )
      .catch(() => []);
  }
  photos = [...new Set(photos.map((s) => s.split('?')[0]))];
  if (PHOTOS_PER_VEHICLE > 0) photos = photos.slice(0, PHOTOS_PER_VEHICLE);

  // innerText fallback for fields not in JSON-LD (Dealer.com labels are stable).
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  const grab = (label) => {
    const re = new RegExp(label + '\\s*[:\\n]\\s*([^\\n]+)', 'i');
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  const priceMatch = text.match(/Sale Price\s*\$?([0-9,]+)/i) || text.match(/\$([0-9,]{3,})/);
  const marketMatch = text.match(/Market Value Price\s*\$?([0-9,]+)/i);

  const vin =
    v.vehicleIdentificationNumber ||
    grab('VIN') ||
    (url.match(/[A-HJ-NPR-Z0-9]{17}/) || [])[0] ||
    null;

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
    interiorColor: (v.vehicleInteriorColor) || grab('Interior Color'),
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

// Simple concurrency pool.
async function pool(items, worker, size) {
  const results = [];
  let i = 0;
  const runners = Array.from({ length: size }).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (e) {
        results[idx] = null;
      }
    }
  });
  await Promise.all(runners);
  return results.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Diff vs. previous dataset (by VIN): price changes, new, removed.
// ---------------------------------------------------------------------------
function diff(prevVehicles, currVehicles) {
  const byVin = (arr) => Object.fromEntries(arr.filter((v) => v.vin).map((v) => [v.vin, v]));
  const prev = byVin(prevVehicles || []);
  const curr = byVin(currVehicles || []);
  const priceChanges = [];
  const newly = [];
  for (const vin of Object.keys(curr)) {
    if (!prev[vin]) newly.push(curr[vin]);
    else if (prev[vin].salePrice && curr[vin].salePrice && prev[vin].salePrice !== curr[vin].salePrice) {
      priceChanges.push({ vin, title: `${curr[vin].year} ${curr[vin].make} ${curr[vin].model}`, from: prev[vin].salePrice, to: curr[vin].salePrice });
    }
  }
  const removed = Object.keys(prev).filter((vin) => !curr[vin]).map((vin) => prev[vin]);
  return { priceChanges, newly, removed };
}

function writeChangeLog(d) {
  const date = new Date().toISOString().slice(0, 10);
  const drops = d.priceChanges.filter((c) => c.to < c.from).sort((a, b) => (a.to - a.from) - (b.to - b.from));
  let md = `\n## ${date}\n\n`;
  md += `- New listings: ${d.newly.length}\n`;
  md += `- Removed / sold: ${d.removed.length}\n`;
  md += `- Price changes: ${d.priceChanges.length}\n`;
  if (drops.length) {
    const top = drops[0];
    md += `- Biggest price drop: ${top.title} $${top.from.toLocaleString()} → $${top.to.toLocaleString()}\n`;
    md += `\n| VIN | Vehicle | Was | Now | Δ |\n|---|---|---|---|---|\n`;
    drops.slice(0, 25).forEach((c) => {
      md += `| ${c.vin} | ${c.title} | $${c.from.toLocaleString()} | $${c.to.toLocaleString()} | -$${(c.from - c.to).toLocaleString()} |\n`;
    });
  }
  fs.appendFileSync(CHANGELOG, md);
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let previous = { vehicles: [] };
  if (fs.existsSync(DATA_FILE)) {
    try { previous = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) {}
  }

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });

  const allVehicles = [];
  const dealerMeta = {};

  for (const dealer of dealers) {
    dealerMeta[dealer.id] = {
      name: dealer.name, town: dealer.town,
      inventoryUrl: dealer.inventoryUrl, financing: dealer.financing,
    };
    const listPage = await context.newPage();
    listPage.setDefaultTimeout(NAV_TIMEOUT);
    let vdps = [];
    try {
      vdps = await collectVdpUrls(listPage, dealer);
    } catch (e) {
      console.error(`[${dealer.id}] listing failed: ${e.message}`);
    }
    await listPage.close();
    console.log(`[${dealer.id}] ${vdps.length} vehicle pages`);

    const vehicles = await pool(
      vdps,
      async (url) => {
        const p = await context.newPage();
        p.setDefaultTimeout(NAV_TIMEOUT);
        try {
          return await scrapeVehicle(p, url, dealer);
        } finally {
          await p.close();
        }
      },
      CONCURRENCY
    );
    allVehicles.push(...vehicles.filter((v) => v && v.vin));
    console.log(`[${dealer.id}] captured ${vehicles.length}`);
  }

  await browser.close();

  const dataset = {
    meta: {
      source: 'GitHub Actions nightly Playwright scrape',
      county: 'Bucks County, PA',
      generatedAt: new Date().toISOString(),
      vehicleCount: allVehicles.length,
      dealerCount: dealers.length,
    },
    dealers: dealerMeta,
    vehicles: allVehicles,
  };

  const d = diff(previous.vehicles, allVehicles);
  fs.writeFileSync(DATA_FILE, JSON.stringify(dataset, null, 2));
  writeChangeLog(d);

  console.log(
    `DONE: ${allVehicles.length} vehicles across ${dealers.length} dealers. ` +
      `New ${d.newly.length}, removed ${d.removed.length}, price changes ${d.priceChanges.length}.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
