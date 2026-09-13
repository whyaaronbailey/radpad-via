// Builds public/definitions from the converter's own VIA definitions only, in
// place of the full via-keyboards catalogue (bun run build:kbs), which this app
// does not need. The app then finds these keyboards by VID/PID on connect, with
// no Design-tab sideloading.
//
// Usage: node scripts/build-converter-definitions.cjs <definition.json>...
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  keyboardDefinitionV3ToVIADefinitionV3,
  getTheme,
} = require('@the-via/reader');

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: build-converter-definitions.cjs <definition.json>...');
  process.exit(1);
}

const out = path.join(__dirname, '..', 'public', 'definitions');
fs.rmSync(out, {recursive: true, force: true});
fs.mkdirSync(path.join(out, 'v3'), {recursive: true});

const ids = [];
const digest = crypto.createHash('sha256');
for (const file of files) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const def = keyboardDefinitionV3ToVIADefinitionV3(raw);
  fs.writeFileSync(path.join(out, 'v3', `${def.vendorProductId}.json`), JSON.stringify(def));
  ids.push(def.vendorProductId);
  digest.update(JSON.stringify(def));
  console.log(`${def.name}: ${raw.vendorId}:${raw.productId} -> v3/${def.vendorProductId}.json`);
}

const index = {
  generatedAt: Date.now(),
  version: 'converter',
  theme: getTheme(),
  vendorProductIds: {v2: [], v3: ids},
};
digest.update(JSON.stringify({...index, generatedAt: undefined}));
fs.writeFileSync(path.join(out, 'supported_kbs.json'), JSON.stringify(index));
fs.writeFileSync(path.join(out, 'hash.json'), JSON.stringify(digest.digest('hex').slice(0, 16)));
console.log(`supported_kbs.json: ${ids.length} keyboard(s)`);
