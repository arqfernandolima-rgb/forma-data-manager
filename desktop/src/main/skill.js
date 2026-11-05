'use strict';
/**
 * The bundled "forma-data-dashboards" skill.
 *  - Claude Desktop / claude.ai: skills are uploaded by the user (Settings → Capabilities → Skills → Upload),
 *    so we write a ready-to-upload ZIP and open the folder. There is no supported way to install it silently.
 *  - Claude Code: skills are folders under ~/.claude/skills, so we can copy it there directly.
 * The same guidance is also served by the MCP server as the "forma_dashboard" prompt.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const SKILL_NAME = 'forma-data-dashboards';

function skillSourceDir({ isPackaged, resourcesPath, appRoot }) {
  return isPackaged ? path.join(resourcesPath, 'skill', SKILL_NAME) : path.join(appRoot, '..', 'skill', SKILL_NAME);
}

function readSkill(dir) {
  return fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
}

// ── Minimal ZIP writer (deflate), enough for a skill folder ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

/** @param {Array<{name:string, data:Buffer}>} files */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  for (const f of files) {
    const name = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8');
    const comp = zlib.deflateRawSync(f.data);
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function listFiles(dir, rel = '') {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...listFiles(path.join(dir, d.name), r));
    else out.push(r);
  }
  return out;
}

function skillNameOf(md) {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(md || '');
  const n = m && /^name:\s*["']?([a-z0-9-]+)["']?\s*$/m.exec(m[1]);
  return n ? n[1] : SKILL_NAME;
}

/** Write <destDir>/<skill-name>.zip with the skill folder inside, as Claude's uploader expects. */
function writeSkillZip(sourceDir, destDir, { skillMd } = {}) {
  const name = skillNameOf(skillMd || readSkill(sourceDir));
  const files = listFiles(sourceDir).map((r) => ({
    name: `${name}/${r}`,
    data: r === 'SKILL.md' && skillMd ? Buffer.from(skillMd, 'utf8') : fs.readFileSync(path.join(sourceDir, r)),
  }));
  fs.mkdirSync(destDir, { recursive: true });
  const out = path.join(destDir, `${name}.zip`);
  fs.writeFileSync(out, makeZip(files));
  return out;
}

/** Copy into ~/.claude/skills/forma-data-dashboards for Claude Code. */
function installForClaudeCode(sourceDir, { skillMd, home = os.homedir() } = {}) {
  const dest = path.join(home, '.claude', 'skills', skillNameOf(skillMd || readSkill(sourceDir)));
  fs.mkdirSync(dest, { recursive: true });
  for (const r of listFiles(sourceDir)) {
    const target = path.join(dest, r);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (r === 'SKILL.md' && skillMd) fs.writeFileSync(target, skillMd);
    else fs.copyFileSync(path.join(sourceDir, r), target);
  }
  return dest;
}

/** Basic checks before packaging an edited SKILL.md. */
function validateSkillMd(md) {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(md);
  if (!m) return 'SKILL.md must start with a --- front-matter block.';
  if (!/^name:\s*["']?[a-z0-9-]+["']?\s*$/m.test(m[1])) return 'Front matter needs a "name:" line using lowercase letters, numbers and hyphens.';
  if (!/^description:\s*\S+/m.test(m[1])) return 'Front matter needs a "description:" line.';
  if (/[<>]/.test(/^description:(.*)$/m.exec(m[1])?.[1] ?? '')) return 'The description cannot contain < or >.';
  return null;
}

module.exports = { SKILL_NAME, skillSourceDir, readSkill, writeSkillZip, installForClaudeCode, validateSkillMd, skillNameOf, makeZip, crc32 };
