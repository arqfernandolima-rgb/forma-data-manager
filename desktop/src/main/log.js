'use strict';
/** Append-only log with simple size-based rotation. Never logs tokens. */
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 5 * 1024 * 1024;

function createLogger(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'forma-data-manager.log');
  const listeners = new Set();
  const write = (level, msg) => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${redact(String(msg))}\n`;
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, line);
    } catch {}
    for (const l of listeners) l(line);
  };
  return {
    file,
    dir,
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    onLine: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
  };
}

// Belt and braces: strip anything that looks like a bearer token or signed-URL credentials.
function redact(s) {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, '$1[redacted]')
    .replace(/(access_token|refresh_token|code_verifier|code)=([^&\s"]+)/g, '$1=[redacted]')
    .replace(/(X-Amz-[A-Za-z-]+|AWSAccessKeyId|Signature|x-amz-security-token)=([^&\s"]+)/gi, '$1=[redacted]');
}

module.exports = { createLogger, redact };
