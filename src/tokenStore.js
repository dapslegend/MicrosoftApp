import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_DIR = path.join(process.cwd(), "tokens");

export class TokenStore {
  constructor(baseDir = DEFAULT_DIR) {
    this.baseDir = baseDir;
  }

  _safeFileName(userKey) {
    // keep stable + filesystem safe
    const s = String(userKey || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
    return s.slice(0, 180) + ".json";
  }

  async _ensureDir() {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  _filePathFor(userKey) {
    return path.join(this.baseDir, this._safeFileName(userKey));
  }

  async list() {
    await this._ensureDir();
    const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => path.join(this.baseDir, e.name));

    const out = [];
    for (const f of files) {
      try {
        const raw = await fs.readFile(f, "utf8");
        const json = JSON.parse(raw);
        out.push({
          user_key: json.user_key,
          user: json.user,
          saved_at: json.saved_at,
          expires_at: json.expires_at,
          scope: json.scope,
        });
      } catch {
        // ignore broken entries
      }
    }
    // newest first
    out.sort((a, b) => String(b.saved_at || "").localeCompare(String(a.saved_at || "")));
    return out;
  }

  async load(userKey) {
    try {
      await this._ensureDir();
      const raw = await fs.readFile(this._filePathFor(userKey), "utf8");
      return JSON.parse(raw);
    } catch (e) {
      if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return null;
      throw e;
    }
  }

  async save(userKey, tokens) {
    await this._ensureDir();
    const safe = {
      ...tokens,
      user_key: userKey,
      saved_at: new Date().toISOString(),
    };
    await fs.writeFile(this._filePathFor(userKey), JSON.stringify(safe, null, 2), "utf8");
    return safe;
  }

  async clear(userKey) {
    try {
      await this._ensureDir();
      await fs.unlink(this._filePathFor(userKey));
    } catch (e) {
      if (e && e.code === "ENOENT") return;
      throw e;
    }
  }

  async clearAll() {
    await this._ensureDir();
    const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => fs.unlink(path.join(this.baseDir, e.name)).catch(() => {})),
    );
  }
}

export function isExpired(tokenInfo, skewSeconds = 60) {
  if (!tokenInfo?.expires_at) return true;
  const msLeft = new Date(tokenInfo.expires_at).getTime() - Date.now();
  return msLeft <= skewSeconds * 1000;
}


