// Derives the lightweight app files from the EXISTING master dataset without
// re-scraping — fast (seconds). Produces:
//   data/index.json            (small card feed the app loads for its list)
//   data/dealers/<id>.json     (per-dealer detail shards the app lazy-loads)
//
// Use this once to enable the performance split on data already scraped; the
// nightly merge.js keeps them up to date afterward.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SHARD_DIR = path.join(DATA_DIR, 'dealers');
const MASTER = path.join(DATA_DIR, 'bucks_inventory_dataset.json');
const INDEX = path.join(DATA_DIR, 'index.json');

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

function main() {
  if (!fs.existsSync(MASTER)) {
    console.error('No master dataset found at', MASTER);
    process.exit(1);
  }
  const master = JSON.parse(fs.readFileSync(MASTER, 'utf8'));
  const vehicles = master.vehicles || [];
  const dealers = master.dealers || {};

  const index = {
    meta: master.meta,
    dealers,
    vehicles: vehicles.map(toIndexVehicle),
  };
  fs.writeFileSync(INDEX, JSON.stringify(index));

  fs.mkdirSync(SHARD_DIR, { recursive: true });
  const byDealer = {};
  vehicles.forEach((v) => {
    (byDealer[v.dealerId] = byDealer[v.dealerId] || []).push(v);
  });
  for (const [id, vs] of Object.entries(byDealer)) {
    const meta = dealers[id] || {};
    const shard = {
      dealer: { id, name: meta.name, town: meta.town, inventoryUrl: meta.inventoryUrl, financing: meta.financing },
      vehicleCount: vs.length,
      vehicles: vs,
    };
    fs.writeFileSync(path.join(SHARD_DIR, `${id}.json`), JSON.stringify(shard, null, 2));
  }

  console.log(`Reindexed ${vehicles.length} vehicles into index.json + ${Object.keys(byDealer).length} dealer shards.`);
}

main();
