// „Umgebung“ und „Änderungen“ für die Info-Leiste im Chat: Git-Branch, letzte Commits und ein offener PR
// des Ordners, in dem Claude arbeitet. Nur lesen – nie etwas am Repository ändern.
const { execFile } = require('child_process');
const path = require('path');

const CACHE_MS = 60 * 1000;
const GIT_TIMEOUT_MS = 4000;
const GH_TIMEOUT_MS = 8000;
const MAX_COMMITS = 3;

function run(bin, args, { cwd, timeout }) {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

function parseCommits(text) {
  return String(text || '').split('\n').filter(Boolean).slice(0, MAX_COMMITS).map((line) => {
    const sp = line.indexOf(' ');
    return sp > 0 ? { hash: line.slice(0, sp), subject: line.slice(sp + 1) } : { hash: line, subject: '' };
  });
}

function parsePr(text) {
  try {
    const pr = JSON.parse(text);
    if (!pr || !Number.isInteger(pr.number) || !/^https:\/\/github\.com\//.test(String(pr.url))) return null;
    return { number: pr.number, title: String(pr.title || ''), url: pr.url, state: String(pr.state || '') };
  } catch { return null; }
}

// exec ist austauschbar, damit sich das ohne echtes Git testen lässt.
function createChatEnv({ exec = run, now = Date.now } = {}) {
  const cache = new Map();
  async function load(cwd) {
    const root = await exec('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: GIT_TIMEOUT_MS });
    if (!root) return { cwd, folder: path.basename(cwd) || cwd, git: false };
    const branch = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: GIT_TIMEOUT_MS });
    const log = await exec('git', ['log', '--oneline', `-${MAX_COMMITS}`], { cwd, timeout: GIT_TIMEOUT_MS });
    const prText = branch && branch !== 'HEAD'
      ? await exec('gh', ['pr', 'view', branch, '--json', 'number,title,url,state'], { cwd, timeout: GH_TIMEOUT_MS }) : null;
    return { cwd, folder: path.basename(cwd) || cwd, git: true, repo: path.basename(root), branch: branch || null,
      commits: parseCommits(log), pr: prText ? parsePr(prText) : null };
  }
  return async function chatEnv(cwd, { force = false } = {}) {
    const key = path.resolve(String(cwd || '/'));
    const hit = cache.get(key);
    if (!force && hit && now() - hit.at < CACHE_MS) return hit.value;
    const value = await load(key);
    cache.set(key, { at: now(), value });
    return value;
  };
}

module.exports = { createChatEnv, parseCommits, parsePr };
