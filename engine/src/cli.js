#!/usr/bin/env bun
/**
 * forma-data — one executable, several modes:
 *   forma-data serve    [--data-dir DIR]                         MCP server over stdio (used by Claude Desktop / Claude Code)
 *   forma-data build    (--zip FILE | --csv-dir DIR) [--data-dir DIR] [--keep 2] [--force] [--json]
 *   forma-data info     [--data-dir DIR]                         print the live database's metadata as JSON
 *   forma-data rollback [--data-dir DIR]                         point back to the previous database version
 *   forma-data version
 * The data folder defaults to FORMA_DATA_DIR, then %LOCALAPPDATA%\FormaData (Windows) or ~/.forma-data.
 */
import path from 'node:path';
import { resolveDataDir, readPointer, writePointer, listDatabases } from './paths.js';
import { ENGINE_VERSION } from './version.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'help';
const dataDir = resolveDataDir(args['data-dir']);

async function main() {
  switch (cmd) {
    case 'serve': {
      const { startServer } = await import('./server/index.js');
      await startServer({ dataDir });
      return;
    }
    case 'build': {
      const { buildDatabase } = await import('./build/index.js');
      const json = !!args.json;
      const onEvent = (e) => {
        if (json) process.stdout.write(JSON.stringify(e) + '\n');
        else if (e.event === 'table') process.stdout.write(`  [${e.index}/${e.total}] ${e.table.padEnd(50)} ${String(e.rows).padStart(9)} rows\n`);
        else if (e.event === 'phase') process.stdout.write(`… ${e.name}\n`);
        else if (e.event === 'start') process.stdout.write(`Building from ${e.source}: ${e.csv_files} CSV files, ${e.schema_tables} tables in the official schema\n`);
        else if (e.event === 'done') {
          const { table_counts, ...rest } = e;
          process.stdout.write(`\nDone in ${e.seconds}s → ${e.db}\n${JSON.stringify(rest, null, 2)}\n`);
        }
      };
      try {
        await buildDatabase({
          zipPath: args.zip ? path.resolve(args.zip) : undefined,
          csvDir: args['csv-dir'] ? path.resolve(args['csv-dir']) : undefined,
          dataDir,
          keep: Number(args.keep || 2),
          force: !!args.force,
          onEvent,
        });
      } catch (e) {
        if (json) process.stdout.write(JSON.stringify({ event: 'error', message: e.message, rejected: e.name === 'BuildRejectedError' || e.constructor?.name === 'BuildRejectedError' }) + '\n');
        else process.stderr.write(`Build failed: ${e.message}\n`);
        process.exitCode = 2;
      }
      return;
    }
    case 'info': {
      const pointer = readPointer(dataDir);
      if (!pointer) {
        process.stdout.write(JSON.stringify({ dataDir, ready: false, databases: listDatabases(dataDir) }, null, 2) + '\n');
        return;
      }
      const { Database } = await import('bun:sqlite');
      const db = new Database(path.join(dataDir, pointer.db), { readonly: true });
      const meta = Object.fromEntries(db.query('SELECT key, value FROM _meta').all().map((r) => [r.key, r.value]));
      db.close();
      process.stdout.write(JSON.stringify({ dataDir, ready: true, pointer, meta, databases: listDatabases(dataDir) }, null, 2) + '\n');
      return;
    }
    case 'rollback': {
      const pointer = readPointer(dataDir);
      const dbs = listDatabases(dataDir);
      const prev = dbs.find((f) => f !== pointer?.db && f < (pointer?.db ?? '~'));
      if (!prev) {
        process.stderr.write('No previous database version to roll back to.\n');
        process.exitCode = 1;
        return;
      }
      writePointer(dataDir, { ...pointer, db: prev, rolled_back_at: new Date().toISOString(), rolled_back_from: pointer?.db });
      process.stdout.write(JSON.stringify({ ok: true, now_live: prev }) + '\n');
      return;
    }
    case 'version':
    case '--version':
      process.stdout.write(`forma-data ${ENGINE_VERSION}\n`);
      return;
    default:
      process.stdout.write(
        `forma-data ${ENGINE_VERSION}\n\nUsage:\n  forma-data serve [--data-dir DIR]\n  forma-data build (--zip FILE | --csv-dir DIR) [--data-dir DIR] [--keep 2] [--force] [--json]\n  forma-data info [--data-dir DIR]\n  forma-data rollback [--data-dir DIR]\n  forma-data version\n`
      );
  }
}

main().catch((e) => {
  process.stderr.write(`forma-data: ${e.stack || e.message}\n`);
  process.exit(1);
});
