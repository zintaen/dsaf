#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Non-Blocking Update Check & Passive CLI Freshness Cache.
 * Checks npm registry `latest` tag once per 24h in `~/.dsaf/update-check.json`,
 * fails open offline/on timeout, and emits at most one concise stderr notice
 * when a newer version is published (never polluting stdout/JSON/SARIF/MCP).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const UPDATE_CHECK_VERSION = "0.9.3";
export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/%40zintaen%2Fdsaf/latest";
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function parseSemver(raw) {
  const clean = String(raw || "").trim().replace(/^v/i, "");
  const m = clean.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  );
  if (!m) return null;
  return {
    major: Number.parseInt(m[1], 10),
    minor: Number.parseInt(m[2], 10),
    patch: Number.parseInt(m[3], 10),
    pre: m[4] ? m[4].split(".") : [],
  };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (const k of ["major", "minor", "patch"]) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const maxLen = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < maxLen; i++) {
    const ia = pa.pre[i];
    const ib = pb.pre[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const na = /^\d+$/.test(ia) ? Number(ia) : null;
    const nb = /^\d+$/.test(ib) ? Number(ib) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (na !== null) {
      return -1;
    } else if (nb !== null) {
      return 1;
    } else if (ia !== ib) {
      return ia < ib ? -1 : 1;
    }
  }
  return 0;
}

export function getDefaultCachePath() {
  if (process.env.DSAF_UPDATE_CACHE) return resolve(process.env.DSAF_UPDATE_CACHE);
  const dir = process.env.DSAF_UPDATE_CACHE_DIR ? resolve(process.env.DSAF_UPDATE_CACHE_DIR) : join(homedir(), ".dsaf");
  return join(dir, "update-check.json");
}

export function shouldSuppressUpdateCheck({ command = "", argv = [], env = process.env } = {}) {
  if (env.DSAF_NO_UPDATE_CHECK === "1" || env.DSAF_NO_UPDATE_CHECK === "true") return true;
  if (env.CI === "true" || env.CI === "1") return true;
  if (["mcp", "hook", "integrity", "verify", "version", "update", "upgrade", "doctor"].includes(String(command || "").toLowerCase())) {
    return true;
  }
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const low = String(args[i]).toLowerCase();
    if (
      low === "--json" ||
      low === "--sarif" ||
      low.startsWith("--sarif=") ||
      low === "--github" ||
      low === "--self-test" ||
      low === "--offline"
    ) {
      return true;
    }
    if (low === "--format=json" || low === "--format=sarif") return true;
    if (low === "--format" && ["json", "sarif"].includes(String(args[i + 1] || "").toLowerCase())) return true;
  }
  return false;
}

export function readCachedUpdate(
  currentVersion = UPDATE_CHECK_VERSION,
  cachePath = getDefaultCachePath(),
  ttlMs = DEFAULT_TTL_MS,
  nowMs = Date.now()
) {
  if (!cachePath || !existsSync(cachePath)) {
    return {
      ok: false,
      currentVersion,
      latestVersion: null,
      outdated: false,
      fromCache: false,
      stale: false,
      checkedAt: null,
      reason: "cache_missing",
    };
  }
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8"));
    const latestVersion = typeof raw?.latestVersion === "string" && parseSemver(raw.latestVersion) ? raw.latestVersion : null;
    const checkedMs = raw?.checkedAt ? Date.parse(raw.checkedAt) : 0;
    if (!latestVersion || !Number.isFinite(checkedMs) || checkedMs <= 0) {
      return {
        ok: false,
        currentVersion,
        latestVersion: null,
        outdated: false,
        fromCache: false,
        stale: false,
        checkedAt: null,
        reason: "cache_invalid",
      };
    }
    const stale = nowMs - checkedMs > ttlMs || checkedMs > nowMs + 60_000;
    const cmp = compareSemver(currentVersion, latestVersion);
    const outdated = cmp !== null && cmp < 0;
    return {
      ok: true,
      currentVersion,
      latestVersion,
      outdated,
      fromCache: true,
      stale,
      checkedAt: raw.checkedAt,
    };
  } catch (err) {
    return {
      ok: false,
      currentVersion,
      latestVersion: null,
      outdated: false,
      fromCache: false,
      stale: false,
      checkedAt: null,
      reason: err?.message || "cache_read_error",
    };
  }
}

export async function checkLatestVersion(opts = {}) {
  const currentVersion = opts.currentVersion || UPDATE_CHECK_VERSION;
  const cachePath = opts.cachePath || getDefaultCachePath();
  const ttlMs = typeof opts.ttlMs === "number" && opts.ttlMs >= 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  const timeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 1500;
  const cacheOnly = Boolean(opts.cacheOnly);
  const forceRefresh = Boolean(opts.forceRefresh);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const registryUrl = opts.registryUrl || DEFAULT_REGISTRY_URL;

  const cached = readCachedUpdate(currentVersion, cachePath, ttlMs);
  if (cached.ok && !cached.stale && !forceRefresh) {
    return {
      ok: true,
      currentVersion,
      latestVersion: cached.latestVersion,
      outdated: cached.outdated,
      fromCache: true,
      checkedAt: cached.checkedAt,
    };
  }

  if (cacheOnly) {
    if (cached.ok) {
      return {
        ok: true,
        currentVersion,
        latestVersion: cached.latestVersion,
        outdated: cached.outdated,
        fromCache: true,
        checkedAt: cached.checkedAt,
        reason: cached.stale ? "offline_stale_cache" : undefined,
      };
    }
    return {
      ok: false,
      currentVersion,
      latestVersion: null,
      outdated: false,
      fromCache: false,
      checkedAt: null,
      reason: "offline_cache_miss",
    };
  }

  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      currentVersion,
      latestVersion: cached.latestVersion,
      outdated: cached.outdated,
      fromCache: Boolean(cached.ok),
      checkedAt: cached.checkedAt,
      reason: "fetch_unavailable",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(registryUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res || !res.ok) {
      throw new Error(`HTTP ${res?.status ?? "error"}`);
    }
    const payload = await res.json();
    const latestVersion = typeof payload?.version === "string" ? payload.version.trim() : "";
    if (!parseSemver(latestVersion)) {
      throw new Error("Invalid version in npm registry response");
    }
    const checkedAt = new Date().toISOString();
    const tmpCachePath = `${cachePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(
        tmpCachePath,
        JSON.stringify({ schema: "dsaf-update-cache/1", latestVersion, checkedAt, registryUrl }, null, 2) + "\n",
        "utf8"
      );
      renameSync(tmpCachePath, cachePath);
    } catch {
      try {
        rmSync(tmpCachePath, { force: true });
      } catch {}
    }
    const cmp = compareSemver(currentVersion, latestVersion);
    return {
      ok: true,
      currentVersion,
      latestVersion,
      outdated: cmp !== null && cmp < 0,
      fromCache: false,
      checkedAt,
    };
  } catch (err) {
    return {
      ok: false,
      currentVersion,
      latestVersion: cached.latestVersion,
      outdated: cached.outdated,
      fromCache: Boolean(cached.ok),
      checkedAt: cached.checkedAt,
      reason: err?.name === "AbortError" ? "timeout" : err?.message || "network_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function maybeNotifyUpdate(opts = {}) {
  if (shouldSuppressUpdateCheck(opts)) return null;
  try {
    const res = await checkLatestVersion({
      ...opts,
      timeoutMs: opts.timeoutMs ?? 1200,
    });
    if (res.outdated && res.latestVersion) {
      const stderr = opts.stderr || process.stderr;
      stderr.write(
        `[dsaf] Update available: v${res.currentVersion} -> v${res.latestVersion} — run \`npx @zintaen/dsaf@latest update\` (silence: DSAF_NO_UPDATE_CHECK=1)\n`
      );
    }
    return res;
  } catch {
    return null;
  }
}

async function runSelfTest() {
  assert.equal(compareSemver("0.9.2", "0.9.3"), -1);
  assert.equal(compareSemver("v0.9.3", "0.9.3"), 0);
  assert.equal(compareSemver("0.10.0", "0.9.9"), 1);
  assert.equal(compareSemver("0.9.3-rc.1", "0.9.3"), -1);
  assert.equal(compareSemver("0.10.0-custom_tag", "0.9.3"), null, "Invalid semver suffix must not sort lexicographically < 0");

  assert.equal(shouldSuppressUpdateCheck({ command: "mcp", env: {} }), true);
  assert.equal(shouldSuppressUpdateCheck({ command: "hook", env: {} }), true);
  assert.equal(shouldSuppressUpdateCheck({ command: "update", env: {} }), true);
  assert.equal(shouldSuppressUpdateCheck({ command: "upgrade", env: {} }), true);
  assert.equal(shouldSuppressUpdateCheck({ command: "doctor", env: {} }), true);
  assert.equal(shouldSuppressUpdateCheck({ command: "doctor", argv: ["--offline"], env: {} }), true);
  assert.equal(shouldSuppressUpdateCheck({ command: "audit", argv: ["--sarif=out.sarif"], env: {} }), true);
  assert.equal(shouldSuppressUpdateCheck({ command: "audit", argv: ["--format=JSON"], env: {} }), true);
  assert.equal(shouldSuppressUpdateCheck({ command: "check", argv: ["--json"], env: {} }), true);
  assert.equal(shouldSuppressUpdateCheck({ command: "audit", argv: ["--format", "sarif"], env: {} }), true);
  assert.equal(shouldSuppressUpdateCheck({ command: "check", argv: ["."], env: { CI: "true" } }), true);
  assert.equal(shouldSuppressUpdateCheck({ command: "check", argv: ["."], env: { DSAF_NO_UPDATE_CHECK: "1" } }), true);
  assert.equal(shouldSuppressUpdateCheck({ command: "check", argv: ["."], env: {} }), false);

  const scratch = mkdtempSync(join(tmpdir(), "dsaf-update-check-"));
  try {
    const cachePath = join(scratch, "update-check.json");
    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: "0.9.9" }),
      };
    };

    const fresh = await checkLatestVersion({
      currentVersion: UPDATE_CHECK_VERSION,
      cachePath,
      fetchImpl: mockFetch,
    });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.latestVersion, "0.9.9");
    assert.equal(fresh.outdated, true);
    assert.equal(fresh.fromCache, false);
    assert.equal(fetchCount, 1);

    const cachedHit = await checkLatestVersion({
      currentVersion: UPDATE_CHECK_VERSION,
      cachePath,
      fetchImpl: mockFetch,
    });
    assert.equal(cachedHit.ok, true);
    assert.equal(cachedHit.fromCache, true);
    assert.equal(cachedHit.outdated, true);
    assert.equal(fetchCount, 1, "Second call within TTL must use local cache");

    let stderrBuf = "";
    const notified = await maybeNotifyUpdate({
      currentVersion: UPDATE_CHECK_VERSION,
      cachePath,
      command: "check",
      argv: ["."],
      env: {},
      fetchImpl: mockFetch,
      stderr: { write: (s) => { stderrBuf += s; } },
    });
    assert.equal(notified?.outdated, true);
    assert.match(stderrBuf, /Update available: v0\.9\.3 -> v0\.9\.9/);

    // Fail-open offline/network error never throws
    const missPath = join(scratch, "missing.json");
    const offlineMiss = await checkLatestVersion({
      currentVersion: UPDATE_CHECK_VERSION,
      cachePath: missPath,
      cacheOnly: true,
    });
    assert.equal(offlineMiss.ok, false);
    assert.equal(offlineMiss.outdated, false);

    const networkErr = await checkLatestVersion({
      currentVersion: UPDATE_CHECK_VERSION,
      cachePath: missPath,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    assert.equal(networkErr.ok, false);
    assert.equal(networkErr.outdated, false);

    // Future-skewed cache timestamp must be treated as stale
    const futureCache = join(scratch, "future-cache.json");
    writeFileSync(futureCache, JSON.stringify({ latestVersion: "0.9.9", checkedAt: new Date(Date.now() + 86_400_000).toISOString() }));
    assert.equal(readCachedUpdate("0.9.3", futureCache).stale, true, "Future clock skew must invalidate cache TTL");

    const concCache = join(scratch, "concurrent-cache.json");
    const [cr1, cr2] = await Promise.all([
      checkLatestVersion({ currentVersion: "0.9.3", forceRefresh: true, cachePath: concCache, fetchImpl: mockFetch }),
      checkLatestVersion({ currentVersion: "0.9.3", forceRefresh: true, cachePath: concCache, fetchImpl: mockFetch }),
    ]);
    assert.equal(cr1.ok, true);
    assert.equal(cr2.ok, true);
    assert.equal(JSON.parse(readFileSync(concCache, "utf8")).latestVersion, "0.9.9");

    // Round 9 regressions (R9-A1-05): strict dot-separated SemVer pre-release & build identifier validation
    assert.equal(parseSemver("0.9.3-."), null);
    assert.equal(parseSemver("0.9.3-rc..1"), null);
    assert.equal(parseSemver("0.9.3+."), null);
    assert.equal(parseSemver("0.9.3-rc.1."), null);
    assert.deepEqual(parseSemver("v0.9.3-rc.1+build.2"), { major: 0, minor: 9, patch: 3, pre: ["rc", "1"] });

    console.log("UPDATE_CHECK_SELF_TEST_PASSED (semver + suppression + 24h cache + offline fail-open + stderr notice)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function canonPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

const isEntry = Boolean(process.argv[1]) && canonPath(process.argv[1]) === canonPath(fileURLToPath(import.meta.url));
if (isEntry) {
  try {
    const { values } = parseArgs({
      options: {
        offline: { type: "boolean", default: false },
        refresh: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "self-test": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (values.help) {
      console.log("Usage: node skill/scripts/update-check.mjs [--offline] [--refresh] [--json] [--self-test] [--help]");
      process.exit(0);
    }
    if (values["self-test"]) {
      process.exit(await runSelfTest());
    }
    const res = await checkLatestVersion({
      cacheOnly: Boolean(values.offline),
      forceRefresh: Boolean(values.refresh),
    });
    if (values.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    } else if (res.outdated) {
      console.log(`Update available: v${res.currentVersion} -> v${res.latestVersion} (cached=${res.fromCache})`);
    } else if (res.ok) {
      console.log(`Up to date: v${res.currentVersion} (latest=v${res.latestVersion}, cached=${res.fromCache})`);
    } else {
      console.log(`Update check skipped/unavailable: ${res.reason || "offline"} (installed=v${res.currentVersion})`);
    }
  } catch (err) {
    console.error("ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
