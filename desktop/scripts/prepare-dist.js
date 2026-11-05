// Runs before electron-builder: checks the engine exe exists and writes the installer license page
// (MIT license + disclaimer) from the repository root files, so there is one source of truth.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const exe = path.join(root, 'engine', 'dist', 'forma-data.exe');
if (!fs.existsSync(exe)) {
  console.error(`Missing ${exe}\nBuild it first: cd engine && bun install && bun run compile:win`);
  process.exit(1);
}
const disclaimer = fs.readFileSync(path.join(root, 'DISCLAIMER.md'), 'utf8').replace(/^#+\s*/gm, '').replace(/\*\*/g, '');
const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
const text = `PLEASE READ BEFORE INSTALLING\r\n\r\n${disclaimer.trim()}\r\n\r\n------------------------------------------------------------\r\n\r\n${license.trim()}\r\n`;
fs.writeFileSync(path.join(__dirname, '..', 'build', 'license.txt'), text.replace(/\r?\n/g, '\r\n'), 'utf8');
console.log('Prepared build/license.txt; engine found.');
