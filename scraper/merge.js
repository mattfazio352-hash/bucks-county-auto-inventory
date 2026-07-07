// Assembles the per-dealer shard files (data/dealers/*.json) written by the
// parallel scrape jobs into the single master dataset the app reads, then diffs
// against the previous master to produce the change log, and emits a lightweight
// index the app loads for its list.
//   -> data/bucks_inventory_dataset.json
//   -> data/index.json
//   -> data/change_log.md (appended)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SHARD_DIR = path.join(DATA_DIR, 'dealers');
const MASTER = path.join(DATA_DIR, 'bucks_inventory_dataset.json');
const INDEX = path.join(DATA_DIR, 'index.json');
const CHANGELOG = path.join(DATA_DIR, 'change_log.md');

// Lightweight card record the app loads for its list/map/search/filter.
function toIndexVehicle(v) {
  return {
    vin: v.vin, dealerId: v.dealerId,
    year: v.year, make: v.make, model: v.model, trim: v.trim,
    bodyStyle: v.bodyStyle, fuelType: v.fuelType, transmission: v.transmission,
    condition: v.condition, mileage: v.mileage, salePrice: v.salePrice,
    thumb: (v.photos && v.photos[0]) || null,
    photoCount: v.photoCount != null ? v.photoCount : (v.photos ? v.photos.length : 0),
  };
}

function loadShards() {
  if (!fs.existsSync(SHARD_DIR)) return [];
  return fs.readdirSync(SHARD_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(SHARD_DIR, f), 'utf8')); }
      catch (_) { return null; }
    })
    .filter(Boolean);
}

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
    md += `- Biggest price drop: ${top.title} $${top.from.toLocaleString()} -> $${top.to.toLocaleString()}\n`;
    md += `\n| VIN | Vehicle | Was | Now | Change |\n|---|---|---|---|---|\n`;
    drops.slice(0, 25).forEach((c) => {
      md += `| ${c.vin} | ${c.title} | $${c.from.toLocaleString()} | $${c.to.toLocaleString()} | -$${(c.from - c.to).toLocaleString()} |\n`;
    });
  }
  fs.appendFileSync(CHANGELOG, md);
}

function main() {
  const shards = loadShards();
  const dealersMeta = {};
  const vehicles = [];
  for (const s of shards) {
    if (s.dealer && s.dealer.id) {
      dealersMeta[s.dealer.id] = {
        name: s.dealer.name, town: s.dealer.town,
        inventoryUrl: s.dealer.inventoryUrl, financing: s.dealer.financing,
      };
    }
    (s.vehicles || []).forEach((v) => vehicles.push(v));
  }

  let previous = { vehicles: [] };
  if (fs.existsSync(MASTER)) {
    try { previous = JSON.parse(fs.readFileSync(MASTER, 'utf8')); } catch (_) {}
  }

  const dataset = {
    meta: {
      source: 'GitHub Actions nightly Playwright scrape (sharded)',
      county: 'Bucks County, PA',
      generatedAt: new Date().toISOString(),
      vehicleCount: vehicles.length,
      dealerCount: Object.keys(dealersMeta).length,
    },
    dealers: dealersMeta,
    vehicles,
  };

  const d = diff(previous.vehicles, vehicles);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MASTER, JSON.stringify(dataset, null, 2));

  // Lightweight index the app loads for its list (a fraction of the master size).
  const index = {
    meta: dataset.meta,
    dealers: dealersMeta,
    vehicles: vehicles.map(toIndexVehicle),
  };
  fs.writeFileSync(INDEX, JSON.stringify(index));

  writeChangeLog(d);

  console.log(`MERGED ${vehicles.length} vehicles from ${shards.length} shards. ` +
    `New ${d.newly.length}, removed ${d.removed.length}, price changes ${d.priceChanges.length}.`);
}

main();
