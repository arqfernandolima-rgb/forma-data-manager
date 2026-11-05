/**
 * Input sources for a build: a Data Connector ZIP (as downloaded by the desktop
 * app) or a folder of extracted CSVs. Both expose the same interface:
 *   list()          -> [{ name, size }]  (paths inside the extract, forward slashes)
 *   readText(name)  -> Promise<string>  (small files only, e.g. schema.json)
 *   stream(name)    -> Promise<Readable> (CSV files, streamed, never fully in memory)
 *   close()
 * ZIPs are read through the central directory (yauzl), which handles ZIP64,
 * so multi-GB extracts from large hubs work.
 */
import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

function readAllEntries(zip) {
  return new Promise((resolve, reject) => {
    const entries = new Map();
    zip.on('entry', (e) => {
      if (!/\/$/.test(e.fileName)) entries.set(e.fileName.replace(/\\/g, '/'), e);
      zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.on('error', reject);
    zip.readEntry();
  });
}

export async function openSource({ zipPath, csvDir }) {
  if (zipPath) {
    const zip = await openZip(zipPath);
    const entries = await readAllEntries(zip);
    const stream = (name) =>
      new Promise((resolve, reject) => {
        const e = entries.get(name);
        if (!e) return reject(new Error(`Not in ZIP: ${name}`));
        zip.openReadStream(e, (err, s) => (err ? reject(err) : resolve(s)));
      });
    return {
      kind: 'zip',
      label: path.basename(zipPath),
      list: () => [...entries.values()].map((e) => ({ name: e.fileName, size: e.uncompressedSize })),
      has: (name) => entries.has(name),
      stream,
      async readText(name) {
        const s = await stream(name);
        const chunks = [];
        for await (const c of s) chunks.push(c);
        return Buffer.concat(chunks).toString('utf8');
      },
      close: () => zip.close(),
    };
  }

  if (csvDir) {
    const files = [];
    const walk = (dir, rel = '') => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) walk(path.join(dir, d.name), r);
        else files.push({ name: r, size: fs.statSync(path.join(dir, d.name)).size });
      }
    };
    walk(csvDir);
    const set = new Set(files.map((f) => f.name));
    return {
      kind: 'dir',
      label: path.basename(csvDir),
      list: () => files,
      has: (name) => set.has(name),
      stream: async (name) => fs.createReadStream(path.join(csvDir, name)),
      readText: async (name) => fs.readFileSync(path.join(csvDir, name), 'utf8'),
      close: () => {},
    };
  }

  throw new Error('Build needs --zip <file> or --csv-dir <folder>.');
}
