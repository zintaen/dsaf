#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Zero-Dependency Stdio MCP Server & Client Config Installer (`dsaf mcp`).
 * Exposes 8 audit & dry-run preview tools (read-only unless `dsaf_audit` receives optional `outDir`) over JSON-RPC 2.0 stdio (Content-Length & NDJSON),
 * plus `dsaf mcp install` to wire Claude, Cursor, Codex, or Antigravity MCP JSON.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analyzeDirectory } from "./recon.mjs";
import { scanTarget } from "./audit-tokens.mjs";
import { assertPathWithinRoot } from "./ci-report.mjs";
import { runDoctor } from "./doctor.mjs";
import { checkTarget, discoverExternalDsCss } from "./dsaf-hook.mjs";
import { readCachedUpdate } from "./update-check.mjs";
import { compareDefinedToShipped, compareVertices } from "./audit-figma-diff.mjs";
import { resolveScopedDir, runAuditPipeline } from "./audit-pipeline.mjs";
import { planFloorFixes } from "./fix-floor.mjs";
import { generatePersonas } from "./generate-personas.mjs";

export const MCP_SERVER_VERSION = "0.9.3";
export const MCP_PROTOCOL_VERSION = "2024-11-05";

export const TOOL_DEFINITIONS = [
  {
    name: "dsaf_recon",
    description: "Read-only repository recon: detect DSAF mode (S/C/P), Surface Mode (Persuade/Operate/Read/Experience), frameworks, and token files.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target directory path." },
      },
      required: ["target"],
    },
  },
  {
    name: "dsaf_tokens",
    description: "Measure W3C DTCG tokens, CSS custom property parity, hardcoded colors, SVG/swatch separation, !important overrides, and spacing grid.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target directory or file path." },
        scope: { type: "string", description: "Optional scope subpath." },
        includeDemos: { type: "boolean", description: "Include demo files." },
        reportUnusedIgnores: { type: "boolean", description: "Report unused dsaf-ignore annotations." },
      },
      required: ["target"],
    },
  },
  {
    name: "dsaf_doctor",
    description: "Run setup health diagnostics for hooks, guardrails, tokens, CLI freshness, and DSAF prerequisites.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target workspace directory." },
        scope: { type: "string", description: "Optional subdirectory scope." },
        dsCss: { type: "array", items: { type: "string" }, description: "Optional external DS stylesheet paths." },
        offline: { type: "boolean", description: "Skip remote npm registry check (default: false)." },
      },
      required: ["target"],
    },
  },
  {
    name: "dsaf_hook_check",
    description: "Run Floor/Reflex discipline scanner (removed focus outlines across all selector branches, unnamed controls, aria mismatches).",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target directory or file path." },
        tier: { type: "string", enum: ["floor", "reflex", "all"], description: "Severity gate tier ('floor', 'reflex', or 'all')." },
        dsCss: { type: "array", items: { type: "string" }, description: "Optional external DS stylesheet paths." },
        reportUnusedIgnores: { type: "boolean", description: "Report unused dsaf-ignore annotations." },
      },
      required: ["target"],
    },
  },
  {
    name: "dsaf_figma_diff",
    description: "Compare Defined tokens against Shipped runtime vars (2-vertex) or Designed Figma vars + Shipped (3-vertex).",
    inputSchema: {
      type: "object",
      properties: {
        tokens: { type: "string", description: "Tokens directory, JSON, or report path." },
        figma: { type: "string", description: "Optional Figma variables JSON path for 3-vertex mode." },
        runtime: { type: "string", description: "Optional audit-runtime --json report path." },
        codeConnect: { type: "string", description: "Optional Code Connect directory." },
        prefix: { type: "string", description: "Optional CSS variable prefix override." },
      },
      required: ["tokens"],
      anyOf: [{ required: ["figma"] }, { required: ["runtime"] }],
    },
  },
  {
    name: "dsaf_audit",
    description: "Execute the unified DSAF static + triangulation + scorecard audit pipeline and return JSON findings.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target directory path." },
        scope: { type: "string", description: "Optional scope subpath." },
        figmaPath: { type: "string", description: "Optional Figma variables JSON path." },
        outDir: { type: "string", description: "Optional output directory." },
        dsCss: { type: "array", items: { type: "string" }, description: "Optional external DS stylesheet paths." },
      },
      required: ["target"],
    },
  },
  {
    name: "dsaf_fix_preview",
    description: "Read-only dry-run planner for deterministic Floor remediations (respects .dsaf/rules.json protectedFiles).",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target directory or file path." },
        rule: { type: "array", items: { type: "string" }, description: "Optional Floor rule ID filter." },
        maxFiles: { type: "integer", minimum: 1, description: "Optional maximum files budget." },
        ignoreProtected: { type: "boolean", description: "Include protectedFiles in preview." },
        dsCss: { type: "array", items: { type: "string" }, description: "Optional external DS stylesheet paths." },
      },
      required: ["target"],
    },
  },
  {
    name: "dsaf_personas",
    description: "Uncapped signal-driven Multi-Axis Persona Matrix generator seeded from repository topology, surface mode, and optional .dsaf/personas.custom.json.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target repository directory." },
        depth: { type: "string", enum: ["auto", "quick", "deep"], description: "Persona depth: auto (uncapped signal-driven), quick (5 baseline), or deep (full signal scan)." },
        customPath: { type: "string", description: "Optional custom personas JSON file overriding .dsaf/personas.custom.json." },
        max: { type: "integer", minimum: 1, description: "Optional ceiling if caller wants a cap (default uncapped)." },
      },
      required: ["target"],
    },
  },
];

function requireTarget(args) {
  if (typeof args.target !== "string" || args.target.trim().length === 0) {
    throw new Error("Parameter 'target' is required.");
  }
  return args.target;
}

function optString(args, key) {
  if (args[key] === undefined || args[key] === null) return undefined;
  if (typeof args[key] !== "string") {
    throw new Error(`Parameter '${key}' must be a string.`);
  }
  if (args[key].trim().length === 0) {
    throw new Error(`Parameter '${key}' must not be empty or whitespace-only.`);
  }
  return args[key];
}

function optStringArray(args, key) {
  if (args[key] === undefined || args[key] === null) return undefined;
  if (!Array.isArray(args[key]) || !args[key].every((x) => typeof x === "string" && x.trim().length > 0)) {
    throw new Error(`Parameter '${key}' must be an array of non-empty strings.`);
  }
  return args[key];
}

function optBool(args, key) {
  if (args[key] === undefined || args[key] === null) return false;
  if (typeof args[key] !== "boolean") {
    throw new Error(`Parameter '${key}' must be a boolean.`);
  }
  return args[key];
}

function optPosInt(args, key) {
  if (args[key] === undefined || args[key] === null) return undefined;
  if (typeof args[key] !== "number" || !Number.isInteger(args[key]) || args[key] < 1) {
    throw new Error(`Parameter '${key}' must be a positive integer.`);
  }
  return args[key];
}

function validateJsonObjectFile(filePath, label) {
  const abs = resolve(filePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error(`${label} file not found: ${abs}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(`Invalid JSON in ${label} file ${abs}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label} JSON in ${abs}: expected a JSON object.`);
  }
  return abs;
}

function executeTool(name, args = {}) {
  switch (name) {
    case "dsaf_recon":
      return analyzeDirectory(resolve(requireTarget(args)));
    case "dsaf_tokens": {
      const absTarget = resolve(requireTarget(args));
      const rawScope = optString(args, "scope");
      let normScope;
      if (rawScope !== undefined) {
        if (!existsSync(absTarget) || !statSync(absTarget).isDirectory()) {
          throw new Error(`Target must be a directory when 'scope' is specified: ${absTarget}`);
        }
        ({ normScope } = resolveScopedDir(absTarget, rawScope));
      }
      return scanTarget(absTarget, {
        scope: normScope || undefined,
        includeDemos: optBool(args, "includeDemos"),
        reportUnusedIgnores: optBool(args, "reportUnusedIgnores"),
      });
    }
    case "dsaf_doctor": {
      const absTarget = resolve(requireTarget(args));
      const scope = optString(args, "scope");
      const dsCss = optStringArray(args, "dsCss");
      const offline =
        optBool(args, "offline") ||
        process.env.DSAF_NO_UPDATE_CHECK === "1" ||
        process.env.DSAF_NO_UPDATE_CHECK === "true" ||
        process.env.CI === "true" ||
        process.env.CI === "1";
      if (dsCss && dsCss.some((x) => x.split(",").some((p) => p.trim().length === 0))) {
        throw new Error("Parameter 'dsCss' must not contain empty file paths.");
      }
      if (!existsSync(absTarget) || !statSync(absTarget).isDirectory()) {
        throw new Error(`Target directory not found: ${absTarget}`);
      }
      const scopedDir = scope !== undefined ? resolveScopedDir(absTarget, scope).scopedDir : absTarget;
      if (dsCss && dsCss.length > 0) {
        discoverExternalDsCss(scopedDir, dsCss);
      }
      let updateStatus;
      if (!offline) {
        const cached = readCachedUpdate(MCP_SERVER_VERSION);
        if (cached.ok && !cached.stale) {
          updateStatus = cached;
        } else {
          const probe = spawnSync(
            process.execPath,
            [fileURLToPath(new URL("./update-check.mjs", import.meta.url)), "--json"],
            { encoding: "utf8", timeout: 2200, stdio: ["ignore", "pipe", "ignore"] }
          );
          if (probe.status === 0 && probe.stdout) {
            try {
              const parsed = JSON.parse(probe.stdout);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                updateStatus = parsed;
              }
            } catch {}
          }
        }
      }
      return runDoctor(absTarget, {
        scope,
        dsCss,
        offline,
        ...(updateStatus ? { updateStatus } : {}),
      });
    }
    case "dsaf_hook_check": {
      const rawTier = optString(args, "tier");
      if (rawTier !== undefined && rawTier !== "floor" && rawTier !== "reflex" && rawTier !== "all") {
        throw new Error("Parameter 'tier' must be 'floor', 'reflex', or 'all'.");
      }
      return checkTarget(resolve(requireTarget(args)), {
        tier: rawTier || "floor",
        dsCss: optStringArray(args, "dsCss"),
        reportUnusedIgnores: optBool(args, "reportUnusedIgnores"),
      });
    }
    case "dsaf_figma_diff": {
      if (typeof args.tokens !== "string" || args.tokens.trim().length === 0) {
        throw new Error("Parameter 'tokens' is required.");
      }
      const figmaPath = optString(args, "figma");
      const runtimePath = optString(args, "runtime");
      const rawCodeConnect = optString(args, "codeConnect") || null;
      let codeConnectDir = null;
      if (rawCodeConnect) {
        codeConnectDir = resolve(rawCodeConnect);
        if (!existsSync(codeConnectDir) || !statSync(codeConnectDir).isDirectory()) {
          throw new Error(`Parameter 'codeConnect' must be an existing directory: ${rawCodeConnect}`);
        }
      }
      const prefix = optString(args, "prefix") || null;
      if (!figmaPath && !runtimePath) {
        throw new Error("Either 'figma' (3-vertex) or 'runtime' (2-vertex) must be supplied.");
      }
      if (figmaPath) validateJsonObjectFile(figmaPath, "Figma variables");
      if (runtimePath) validateJsonObjectFile(runtimePath, "Runtime audit");
      if (figmaPath) {
        return compareVertices({
          figmaPath,
          tokensArg: args.tokens,
          codeConnectDir,
          runtimePath: runtimePath || null,
          prefix,
        });
      }
      return compareDefinedToShipped({
        tokensArg: args.tokens,
        runtimePath,
        codeConnectDir,
        prefix,
      });
    }
    case "dsaf_audit": {
      const scope = optString(args, "scope");
      const figmaPath = optString(args, "figmaPath");
      const outDir = optString(args, "outDir");
      const dsCss = optStringArray(args, "dsCss");
      return runAuditPipeline({
        target: requireTarget(args),
        scope,
        figmaPath,
        outDir,
        dsCss,
      });
    }
    case "dsaf_fix_preview": {
      const plan = planFloorFixes(resolve(requireTarget(args)), {
        rules: optStringArray(args, "rule"),
        maxFiles: optPosInt(args, "maxFiles"),
        ignoreProtected: optBool(args, "ignoreProtected"),
        dsCss: optStringArray(args, "dsCss"),
      });
      return {
        ...plan,
        files: plan.files.map(({ file, rel, patchCount, patches, skipped, changed }) => ({
          file,
          rel,
          patchCount,
          patches,
          skipped,
          changed,
        })),
      };
    }
    case "dsaf_personas": {
      const rawDepth = optString(args, "depth");
      if (rawDepth !== undefined && rawDepth !== "auto" && rawDepth !== "quick" && rawDepth !== "deep") {
        throw new Error("Parameter 'depth' must be 'auto', 'quick', or 'deep'.");
      }
      return generatePersonas(resolve(requireTarget(args)), {
        depth: rawDepth || "auto",
        customPath: optString(args, "customPath"),
        max: optPosInt(args, "max") ?? null,
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function createMcpDispatcher() {
  return function dispatchMessage(msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || !msg.method) {
      return {
        jsonrpc: "2.0",
        id: msg?.id ?? null,
        error: { code: -32600, message: "Invalid JSON-RPC 2.0 request" },
      };
    }

    const hasId = Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== undefined;
    if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") {
      return null;
    }

    if (msg.method === "initialize") {
      if (!hasId) return null;
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "dsaf", version: MCP_SERVER_VERSION },
        },
      };
    }

    if (msg.method === "ping") {
      return hasId ? { jsonrpc: "2.0", id: msg.id, result: {} } : null;
    }

    if (msg.method === "tools/list") {
      if (!hasId) return null;
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: TOOL_DEFINITIONS },
      };
    }

    if (msg.method === "tools/call") {
      if (!hasId) return null;
      if (!msg.params || typeof msg.params !== "object" || Array.isArray(msg.params)) {
        return {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "Invalid params: expected object" },
        };
      }
      const toolName = msg.params.name;
      if (typeof toolName !== "string" || toolName.trim().length === 0 || !TOOL_DEFINITIONS.some((t) => t.name === toolName)) {
        return {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Unknown or invalid tool name: ${String(toolName)}` },
        };
      }
      const rawArgs = msg.params.arguments;
      if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
        return {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "Invalid params.arguments: expected object" },
        };
      }
      const toolArgs = rawArgs || {};
      try {
        const result = executeTool(toolName, toolArgs);
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: false,
          },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          },
        };
      }
    }

    if (!hasId) return null;
    return {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    };
  };
}

const MAX_FRAME_BYTES = 10 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;

function isPotentialIncompleteHeaderBlock(headerSlice) {
  if (!headerSlice) return false;
  const lines = headerSlice.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (!/^[A-Za-z][A-Za-z0-9-]{0,127}[ \t]*:[^\r\n]*$/.test(line)) return false;
  }
  const tail = lines[lines.length - 1].replace(/\r$/, "");
  return (
    tail === "" ||
    /^[A-Za-z][A-Za-z0-9-]{0,127}[ \t]*:[^\r\n]*$/.test(tail) ||
    /^[A-Za-z][A-Za-z0-9-]{0,127}[ \t]*$/.test(tail)
  );
}

function isLooseIncompleteHeaderBlock(headerSlice) {
  if (!headerSlice) return false;
  const lines = headerSlice.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (!/^[A-Za-z][^\r\n:]*:[^\r\n]*$/.test(line)) return false;
  }
  const tail = lines[lines.length - 1].replace(/\r$/, "");
  return (
    tail === "" ||
    /^[A-Za-z][^\r\n:]*:[^\r\n]*$/.test(tail) ||
    /^[A-Za-z][A-Za-z0-9_ .-]{0,511}$/.test(tail)
  );
}

function isValidCompleteHeaderBlock(headerSlice) {
  if (!headerSlice) return false;
  const lines = headerSlice.split("\n");
  if (lines.length === 0) return false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (!/^[A-Za-z][A-Za-z0-9-]{0,127}[ \t]*:[^\r\n]*$/.test(line)) return false;
  }
  return true;
}

export function createFrameReader(onMessage, onError) {
  let buf = Buffer.alloc(0);
  let detectedMode = null;
  let awaitingHeaderResync = false;
  let resyncAtBoundary = true;
  let resyncOversizeEmitted = false;
  let discardingOversizedHeader = false;
  let discardingOversizedLine = false;
  let discardingOversizedArray = false;
  let discardLineHasColon = false;
  let discardLinePrefixNonEmpty = false;
  let discardLineDroppedBytes = false;
  let discardLineTrimEmpty = true;

  const isBoundaryByte = (b) => b === 0x0d || b === 0x0a || b === 0x7d || b === 0x5d;

  const rejectContentLengthHeader = (err, keepDiscardingHeader = false, nextOffset = -1) => {
    if (nextOffset >= 0) {
      resyncAtBoundary = nextOffset > 0 ? isBoundaryByte(buf[nextOffset - 1]) : true;
      buf = buf.subarray(nextOffset);
      discardLineHasColon = false;
      discardLinePrefixNonEmpty = false;
      discardLineDroppedBytes = false;
      discardLineTrimEmpty = true;
    } else if (keepDiscardingHeader) {
      const lastNl = buf.lastIndexOf(0x0a);
      const tailLine = lastNl === -1 ? buf : buf.subarray(lastNl + 1);
      discardLineHasColon = tailLine.includes(0x3a);
      discardLineTrimEmpty = tailLine.toString("latin1").trim() === "";
      if (discardLineHasColon) {
        discardLinePrefixNonEmpty = tailLine.toString("latin1").trim().length > 0;
        discardLineDroppedBytes = buf.length > 3;
        buf = buf.subarray(Math.max(0, buf.length - 3));
      } else if (tailLine.length > 256) {
        const dropLen = tailLine.length - 256;
        discardLinePrefixNonEmpty = tailLine.subarray(0, dropLen).toString("latin1").trim().length > 0;
        discardLineDroppedBytes = true;
        buf = Buffer.from(tailLine.subarray(dropLen));
      } else {
        discardLinePrefixNonEmpty = false;
        discardLineDroppedBytes = false;
        buf = Buffer.from(tailLine);
      }
      resyncAtBoundary = true;
    } else {
      buf = Buffer.alloc(0);
      discardLineHasColon = false;
      discardLinePrefixNonEmpty = false;
      discardLineDroppedBytes = false;
      discardLineTrimEmpty = true;
      resyncAtBoundary = true;
    }
    awaitingHeaderResync = true;
    resyncOversizeEmitted = false;
    discardingOversizedHeader = keepDiscardingHeader;
    if (onError) onError(err, "content-length");
    else throw err;
  };

  const findOversizedHeaderStop = (buffer, limit) => {
    const bound = Math.min(buffer.length, limit);
    let pos = 0;
    while (pos < bound) {
      const nlIdx = buffer.indexOf(0x0a, pos);
      const isCompleteLine = nlIdx !== -1 && nlIdx < bound;
      const lineEnd = isCompleteLine ? nlIdx : bound;
      const lineSlice = buffer.subarray(pos, lineEnd);
      const lineStr = lineSlice.toString("latin1").replace(/\r$/, "");
      const trimmedStart = lineStr.trimStart();
      if (trimmedStart[0] === "{" || trimmedStart[0] === "[") {
        return { stopped: true, nextOffset: pos };
      }
      if (!isCompleteLine) break;
      const trimmedLine = lineStr.trim();
      if (trimmedLine === "") {
        return { stopped: true, nextOffset: nlIdx + 1 };
      }
      if (!lineSlice.includes(0x3a) && trimmedLine !== "") {
        return { stopped: true, nextOffset: nlIdx + 1 };
      }
      pos = nlIdx + 1;
    }
    return { stopped: false, nextOffset: -1 };
  };

  const rejectOversizedUnseparatedHeader = () => {
    const stop = findOversizedHeaderStop(buf, buf.length);
    if (stop.stopped) {
      rejectContentLengthHeader(new Error("MCP header block exceeded 16KB without terminator"), false, stop.nextOffset);
      return true;
    }
    rejectContentLengthHeader(new Error("MCP header block exceeded 16KB without terminator"), true);
    return false;
  };

  return function pushChunk(chunk) {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")]);
    while (buf.length > 0) {
      if (discardingOversizedLine) {
        const nlIdx = buf.indexOf(0x0a);
        if (nlIdx === -1) {
          buf = Buffer.alloc(0);
          resyncAtBoundary = false;
          break;
        }
        const lineTrimmed = buf.subarray(0, nlIdx).toString("latin1").trim();
        buf = buf.subarray(nlIdx + 1);
        discardingOversizedLine = false;
        resyncAtBoundary = true;
        if (discardingOversizedArray && lineTrimmed.endsWith("]")) {
          discardingOversizedArray = false;
        }
        continue;
      }
      if (discardingOversizedArray) {
        const latinHead = buf.subarray(0, Math.min(buf.length, 64)).toString("latin1");
        if (/^[ \t]*Content-(?:Length|Type)[ \t]*:/i.test(latinHead) && (resyncAtBoundary || /^[ \t]+/.test(latinHead))) {
          discardingOversizedArray = false;
        } else {
          const nlIdx = buf.indexOf(0x0a);
          if (nlIdx === -1) {
            if (buf.length > MAX_FRAME_BYTES) {
              resyncAtBoundary = buf.length > 0 && isBoundaryByte(buf[buf.length - 1]);
              buf = Buffer.alloc(0);
              discardingOversizedLine = true;
            }
            break;
          }
          const lineTrimmed = buf.subarray(0, nlIdx).toString("latin1").trim();
          buf = buf.subarray(nlIdx + 1);
          resyncAtBoundary = true;
          if (lineTrimmed.endsWith("]")) {
            discardingOversizedArray = false;
          }
          continue;
        }
      }
      if (discardingOversizedHeader) {
        let pos = 0;
        let ended = false;
        while (pos < buf.length) {
          const nlIdx = buf.indexOf(0x0a, pos);
          const lineSlice = buf.subarray(pos, nlIdx === -1 ? buf.length : nlIdx);
          const lineStr = lineSlice.toString("latin1").replace(/\r$/, "");
          const trimmedStart = lineStr.trimStart();
          if (!discardLineHasColon) {
            if (!discardLineDroppedBytes && !discardLinePrefixNonEmpty && (trimmedStart[0] === "{" || trimmedStart[0] === "[")) {
              buf = buf.subarray(pos);
              discardingOversizedHeader = false;
              resyncAtBoundary = true;
              ended = true;
              break;
            }
          }
          if (nlIdx === -1) {
            const hasColon = discardLineHasColon || lineSlice.includes(0x3a);
            if (hasColon) {
              discardLineHasColon = true;
              discardLinePrefixNonEmpty = discardLinePrefixNonEmpty || lineStr.trim().length > 0;
              discardLineDroppedBytes = discardLineDroppedBytes || buf.length - pos > 3;
              discardLineTrimEmpty = false;
              buf = buf.subarray(Math.max(pos, buf.length - 3));
            } else {
              const avail = buf.length - pos;
              const keep = Math.min(256, avail);
              if (avail > keep) {
                const droppedStr = lineSlice.subarray(0, avail - keep).toString("latin1");
                if (droppedStr.trim().length > 0) discardLinePrefixNonEmpty = true;
                discardLineDroppedBytes = true;
              }
              discardLineTrimEmpty = discardLineTrimEmpty && lineStr.trim() === "";
              buf = buf.subarray(buf.length - keep);
            }
            break;
          }
          const trimmedLine = lineStr.trim();
          if (discardLineTrimEmpty && trimmedLine === "") {
            buf = buf.subarray(nlIdx + 1);
            discardingOversizedHeader = false;
            resyncAtBoundary = true;
            ended = true;
            break;
          }
          const hasColon = discardLineHasColon || lineSlice.includes(0x3a);
          if (!hasColon && trimmedLine !== "") {
            buf = buf.subarray(nlIdx + 1);
            discardingOversizedHeader = false;
            resyncAtBoundary = true;
            ended = true;
            break;
          }
          pos = nlIdx + 1;
          discardLineHasColon = false;
          discardLinePrefixNonEmpty = false;
          discardLineDroppedBytes = false;
          discardLineTrimEmpty = true;
        }
        if (!ended && discardingOversizedHeader) {
          if (pos > 0) buf = buf.subarray(pos);
          break;
        }
        continue;
      }

      let lead = 0;
      while (lead < buf.length) {
        if (buf[lead] === 0x0d || buf[lead] === 0x0a) {
          lead++;
          continue;
        }
        if (buf[lead] === 0x20 || buf[lead] === 0x09) {
          let j = lead;
          while (j < buf.length && (buf[j] === 0x20 || buf[j] === 0x09)) j++;
          if (j < buf.length && (buf[j] === 0x0a || buf[j] === 0x0d)) {
            lead = buf[j] === 0x0d && j + 1 < buf.length && buf[j + 1] === 0x0a ? j + 2 : j + 1;
            continue;
          }
        }
        break;
      }
      if (lead > 0) {
        buf = buf.subarray(lead);
        resyncAtBoundary = true;
        if (buf.length === 0) break;
      }

      if (awaitingHeaderResync) {
        const latin = buf.toString("latin1");
        const resyncHdrRe = /(Content-(?:Length|Type)[ \t]*:)/gi;
        let hdrMatch = null;
        let rm;
        while ((rm = resyncHdrRe.exec(latin)) !== null) {
          const atBound = rm.index === 0 ? resyncAtBoundary : /[\r\n}\]]/.test(latin[rm.index - 1]);
          if (atBound) {
            hdrMatch = rm;
            break;
          }
        }
        if (!hdrMatch) {
          if (buf.length > MAX_FRAME_BYTES) {
            const tailStart = Math.max(0, buf.length - 32);
            const tail = buf.subarray(tailStart).toString("latin1");
            let partialLen = -1;
            for (let ti = 0; ti < tail.length; ti++) {
              if (tail[ti] !== "c" && tail[ti] !== "C") continue;
              const absIdx = tailStart + ti;
              const atBound = absIdx === 0 ? resyncAtBoundary : isBoundaryByte(buf[absIdx - 1]);
              if (!atBound) continue;
              const cand = tail.slice(ti).replace(/[ \t]+(?=:|$)/g, "").toLowerCase();
              if ("content-length:".startsWith(cand) || "content-type:".startsWith(cand)) {
                partialLen = tail.length - ti;
                break;
              }
            }
            if (partialLen > 0) {
              buf = buf.subarray(buf.length - partialLen);
              resyncAtBoundary = true;
              break;
            }
            resyncAtBoundary = buf.length > 0 && isBoundaryByte(buf[buf.length - 1]);
            buf = Buffer.alloc(0);
            if (!resyncOversizeEmitted) {
              resyncOversizeEmitted = true;
              const err = new Error("Oversized malformed frame exceeded 10MB limit");
              if (onError) onError(err, detectedMode || "content-length");
              else throw err;
            }
          }
          break;
        }
        const hStart = hdrMatch.index;
        if (hStart > 0) {
          buf = buf.subarray(hStart);
          resyncAtBoundary = true;
          continue;
        }
      }

      let peek = 0;
      while (peek < buf.length && (buf[peek] === 0x20 || buf[peek] === 0x09)) peek++;
      const firstByte = peek < buf.length ? buf[peek] : null;
      if (firstByte === 0x7b || firstByte === 0x5b) {
        const firstNl = buf.indexOf("\n");
        if (firstNl === -1) {
          if (buf.length > MAX_FRAME_BYTES) {
            buf = Buffer.alloc(0);
            discardingOversizedLine = true;
            if (firstByte === 0x5b) discardingOversizedArray = true;
            const err = new Error("NDJSON frame exceeded 10MB limit");
            if (onError) onError(err, detectedMode || "ndjson");
            else throw err;
          }
          break;
        }
        if (firstNl > MAX_FRAME_BYTES) {
          const lineTrimmed = buf.subarray(0, firstNl).toString("latin1").trim();
          buf = buf.subarray(firstNl + 1);
          resyncAtBoundary = true;
          if (firstByte === 0x5b && !lineTrimmed.endsWith("]")) {
            discardingOversizedArray = true;
          }
          const err = new Error("NDJSON frame exceeded 10MB limit");
          if (onError) onError(err, detectedMode || "ndjson");
          else throw err;
          continue;
        }
        const line = buf.subarray(0, firstNl).toString("utf8").trim();
        buf = buf.subarray(firstNl + 1);
        resyncAtBoundary = true;
        if (awaitingHeaderResync || !line) continue;
        if (!detectedMode) detectedMode = "ndjson";
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          if (onError) onError(err, detectedMode);
          else throw err;
          continue;
        }
        onMessage(parsed, "ndjson");
        continue;
      }

      const sepCrlf = buf.indexOf("\r\n\r\n");
      const sepLf = buf.indexOf("\n\n");
      const head = buf.subarray(0, Math.min(buf.length, 256)).toString("utf8");
      const hasSep = sepCrlf !== -1 || sepLf !== -1;
      const useCrlf = sepCrlf !== -1 && (sepLf === -1 || sepCrlf <= sepLf);
      const hdrEnd = useCrlf ? sepCrlf : sepLf;
      const sepLen = useCrlf ? 4 : 2;
      if (hasSep && hdrEnd > MAX_HEADER_BYTES) {
        const headerPreview = buf.subarray(0, MAX_HEADER_BYTES + 1).toString("utf8");
        const blockText = buf.subarray(0, Math.min(hdrEnd, MAX_FRAME_BYTES)).toString("utf8").replace(/\r/g, "");
        const hasCoreHeaderInBlock = /(?:^|\n)Content-(?:Length|Type)[ \t]*:/im.test(blockText);
        const hasJsonLineInBlock = /(?:^|\n)[ \t]*[\[{]/.test(blockText);
        const previewLooksHeader =
          detectedMode === "content-length" ||
          /^Content-(?:Length|Type)[ \t]*:/i.test(head) ||
          ((isPotentialIncompleteHeaderBlock(headerPreview) || isLooseIncompleteHeaderBlock(headerPreview)) && detectedMode !== "ndjson") ||
          (hasCoreHeaderInBlock && !hasJsonLineInBlock);
        if (previewLooksHeader) {
          const stop = findOversizedHeaderStop(buf, hdrEnd + sepLen);
          rejectContentLengthHeader(
            new Error("MCP header block exceeded 16KB"),
            false,
            stop.stopped ? stop.nextOffset : hdrEnd + sepLen
          );
          continue;
        }
      }
      if (!hasSep && buf.length > MAX_HEADER_BYTES) {
        const oversizePreview = buf.subarray(0, MAX_HEADER_BYTES + 1).toString("utf8");
        const bufTextForJson = buf.subarray(0, Math.min(buf.length, MAX_FRAME_BYTES)).toString("utf8").replace(/\r/g, "");
        const hasJsonLine = /(?:^|\n)[ \t]*[\[{]/.test(bufTextForJson);
        const startsWithCoreHeader = /^Content-(?:Length|Type)[ \t]*:/i.test(head);
        const hasCoreHeader = startsWithCoreHeader || /(?:^|\n)Content-(?:Length|Type)[ \t]*:/im.test(bufTextForJson);
        if (!hasJsonLine && (detectedMode === "content-length" || startsWithCoreHeader || hasCoreHeader || isLooseIncompleteHeaderBlock(oversizePreview))) {
          if (rejectOversizedUnseparatedHeader()) continue;
          break;
        }
      }
      const headerSlice =
        hasSep && hdrEnd <= MAX_HEADER_BYTES
          ? buf.subarray(0, hdrEnd).toString("utf8")
          : !hasSep
          ? buf.subarray(0, Math.min(buf.length, MAX_HEADER_BYTES)).toString("utf8")
          : "";
      const headerSliceNorm = headerSlice.replace(/\r/g, "");
      const hasPartialJsonLine = !hasSep && /(?:^|\n)[ \t]*[\[{]/.test(headerSliceNorm);
      const startsWithCoreHeader = /^Content-(?:Length|Type)[ \t]*:/i.test(head);
      const hasPartialCoreHeader = !hasSep && /(?:^|\n)Content-(?:Length|Type)[ \t]*:/im.test(headerSliceNorm);
      const hasPartialHeader =
        !hasSep &&
        !hasPartialJsonLine &&
        (detectedMode === "content-length" ||
          startsWithCoreHeader ||
          hasPartialCoreHeader ||
          isPotentialIncompleteHeaderBlock(headerSlice) ||
          isLooseIncompleteHeaderBlock(headerSlice));
      let isHeaderBlockWithSep = false;
      if (hasSep && hdrEnd <= MAX_HEADER_BYTES) {
        if (detectedMode === "content-length") {
          isHeaderBlockWithSep = true;
        } else {
          const hdrLines = headerSlice.split("\n").map((l) => l.replace(/\r$/, ""));
          const firstLine = hdrLines[0] || "";
          const startsWithCoreHeader = /^Content-(?:Length|Type)[ \t]*:/i.test(firstLine);
          const hasCoreHeaderLine = /(?:^|\n)Content-(?:Length|Type)[ \t]*:/im.test(headerSlice.replace(/\r/g, ""));
          const hasJsonBodyLine = hdrLines.some((l) => /^[ \t]*[\[{]/.test(l));
          isHeaderBlockWithSep =
            startsWithCoreHeader ||
            (!hasJsonBodyLine && hasCoreHeaderLine) ||
            (isValidCompleteHeaderBlock(headerSlice) && hasCoreHeaderLine);
        }
      }
      const looksLikeHeader = hasSep && hdrEnd <= MAX_HEADER_BYTES ? isHeaderBlockWithSep : hasPartialHeader;

      if (!looksLikeHeader) {
        const firstNl = buf.indexOf("\n");
        if (firstNl === -1) {
          if (buf.length > MAX_HEADER_BYTES) {
            buf = Buffer.alloc(0);
            discardingOversizedLine = true;
            const err = new Error("Oversized malformed frame before delimiter");
            if (onError) onError(err, detectedMode || "ndjson");
            else throw err;
          }
          break;
        }
        if (firstNl > MAX_FRAME_BYTES) {
          buf = buf.subarray(firstNl + 1);
          resyncAtBoundary = true;
          const err = new Error("Malformed frame exceeded 10MB limit");
          if (onError) onError(err, detectedMode || "ndjson");
          else throw err;
          continue;
        }
        const badLine = buf.subarray(0, firstNl).toString("utf8").trim();
        buf = buf.subarray(firstNl + 1);
        resyncAtBoundary = true;
        if (awaitingHeaderResync || !badLine) continue;
        let parsedBad;
        try {
          parsedBad = JSON.parse(badLine);
        } catch (err) {
          if (onError) onError(err, detectedMode || "ndjson");
          else throw err;
          continue;
        }
        onMessage(parsedBad, detectedMode || "ndjson");
        continue;
      }

      if (!hasSep) {
        if (buf.length > MAX_HEADER_BYTES) {
          if (rejectOversizedUnseparatedHeader()) continue;
        }
        break;
      }

      detectedMode = "content-length";
      if (hdrEnd > MAX_HEADER_BYTES) {
        rejectContentLengthHeader(new Error("MCP header block exceeded 16KB"), false, hdrEnd + sepLen);
        continue;
      }
      const headerText = headerSlice;
      if (!isValidCompleteHeaderBlock(headerText)) {
        rejectContentLengthHeader(new Error("Malformed MCP header block"), false, hdrEnd + sepLen);
        continue;
      }
      const clMatches = [...headerText.matchAll(/(?:^|\r?\n)Content-Length[ \t]*:[ \t]*([^\r\n]*)/gi)];
      if (clMatches.length === 0) {
        rejectContentLengthHeader(new Error("Missing Content-Length header"), false, hdrEnd + sepLen);
        continue;
      }
      if (clMatches.length > 1) {
        rejectContentLengthHeader(new Error("Duplicate Content-Length header"), false, hdrEnd + sepLen);
        continue;
      }
      const rawLen = clMatches[0][1].trim();
      const bodyLen = /^\d+$/.test(rawLen) ? Number.parseInt(rawLen, 10) : Number.NaN;
      if (!Number.isSafeInteger(bodyLen) || bodyLen < 0 || bodyLen > MAX_FRAME_BYTES) {
        rejectContentLengthHeader(new Error(`Invalid Content-Length: ${rawLen}`), false, hdrEnd + sepLen);
        continue;
      }
      awaitingHeaderResync = false;
      resyncOversizeEmitted = false;
      resyncAtBoundary = true;
      const totalNeed = hdrEnd + sepLen + bodyLen;
      if (buf.length < totalNeed) break;
      const bodyStr = buf.subarray(hdrEnd + sepLen, totalNeed).toString("utf8");
      buf = buf.subarray(totalNeed);
      let parsedBody;
      try {
        parsedBody = JSON.parse(bodyStr);
      } catch (err) {
        if (onError) onError(err, "content-length");
        else throw err;
        continue;
      }
      onMessage(parsedBody, "content-length");
    }
  };
}

export function formatMcpResponse(payload, mode = "ndjson") {
  const json = JSON.stringify(payload);
  if (mode === "content-length") {
    const byteLen = Buffer.byteLength(json, "utf8");
    return `Content-Length: ${byteLen}\r\n\r\n${json}`;
  }
  return `${json}\n`;
}

export function resolveMcpTargets({ agent = "claude", scope = "project", dir, cwd = process.cwd(), home = homedir() }) {
  const normScope = typeof scope === "string" ? scope.trim().toLowerCase() : scope;
  if (normScope !== "user" && normScope !== "project") {
    throw new Error(`Unsupported --scope '${scope}'. Expected 'user' or 'project'.`);
  }
  const userRoots = {
    claude: [".claude.json"],
    cursor: [".cursor", "mcp.json"],
    codex: [".codex", "mcp.json"],
    antigravity: [".gemini", "antigravity", "mcp_config.json"],
  };
  const projectRoots = {
    claude: [".mcp.json"],
    cursor: [".cursor", "mcp.json"],
    codex: [".codex", "mcp.json"],
    antigravity: [".agent", "mcp.json"],
  };
  const roots = normScope === "user" ? userRoots : projectRoots;
  const parsedRequested = String(agent || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const key of parsedRequested) {
    if (key !== "all" && !Object.hasOwn(roots, key)) {
      throw new Error(`Unknown --agent '${key}'. Supported: ${Object.keys(roots).join(", ")}, all`);
    }
  }
  const requested = parsedRequested.includes("all") ? Object.keys(roots) : parsedRequested;
  if (requested.length === 0) {
    throw new Error("No valid agent selected. Pass --agent claude|cursor|codex|antigravity|all.");
  }
  if (dir !== undefined) {
    if (typeof dir !== "string" || dir.trim().length === 0) {
      throw new Error("Parameter '--dir' must be a non-empty path.");
    }
    const resolvedDir = resolve(dir.trim());
    const isDirPath = (existsSync(resolvedDir) && statSync(resolvedDir).isDirectory()) || !/\.json$/i.test(resolvedDir);
    return [{ agent: "custom", scope: "custom", path: isDirPath ? join(resolvedDir, "mcp.json") : resolvedDir }];
  }
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim().length === 0)) {
    throw new Error("Parameter '--cwd' must be a non-empty path.");
  }
  const base = normScope === "user" ? resolve(home) : resolve(cwd);
  const seen = new Set();
  const out = [];
  for (const key of requested) {
    if (!Object.hasOwn(roots, key)) {
      throw new Error(`Unknown --agent '${key}'. Supported: ${Object.keys(roots).join(", ")}, all`);
    }
    const dest = join(base, ...roots[key]);
    if (seen.has(dest)) continue;
    seen.add(dest);
    out.push({ agent: key, scope: normScope, path: dest });
  }
  return out;
}

function assertWritableMcpPath(targetPath, projectRoot = null) {
  const abs = resolve(targetPath);
  if (projectRoot) {
    assertPathWithinRoot(projectRoot, abs, abs, { allowEqual: false });
  }
  const dirsToCheck = [];
  let cur = dirname(abs);
  while (true) {
    dirsToCheck.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const d of dirsToCheck.reverse()) {
    let lst;
    try {
      lst = lstatSync(d);
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }
    if (lst.isSymbolicLink()) {
      if (!existsSync(d) || !statSync(d).isDirectory()) {
        throw new Error(`MCP config parent path is not a valid directory: ${d}`);
      }
    } else if (!lst.isDirectory()) {
      throw new Error(`MCP config parent path is not a directory: ${d}`);
    }
  }
  try {
    const tLst = lstatSync(abs);
    if (tLst.isSymbolicLink()) {
      throw new Error(
        existsSync(abs)
          ? `Refusing symlinked MCP config target: ${abs}`
          : `MCP config target is a broken symlink: ${abs}`
      );
    }
    if (tLst.isDirectory()) {
      throw new Error(`Existing MCP config path is a directory: ${abs}`);
    }
    if (!tLst.isFile()) {
      throw new Error(`Existing MCP config path is not a regular file: ${abs}`);
    }
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

export function installMcpConfig(opts = {}) {
  if (opts.pin && opts.packageTag !== undefined && opts.packageTag !== null) {
    throw new Error("Cannot combine --pin and --tag; choose one package specifier.");
  }
  let cleanTag = null;
  if (opts.packageTag !== undefined && opts.packageTag !== null) {
    if (typeof opts.packageTag !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.packageTag.trim())) {
      throw new Error(`Invalid --tag '${opts.packageTag}': expected a valid npm version or dist-tag.`);
    }
    cleanTag = opts.packageTag.trim();
  }
  const targets = resolveMcpTargets(opts);
  const pkgSpec = cleanTag
    ? `@zintaen/dsaf@${cleanTag}`
    : opts.pin
    ? `@zintaen/dsaf@${MCP_SERVER_VERSION}`
    : "@zintaen/dsaf@latest";
  const serverEntry = {
    command: "npx",
    args: ["-y", pkgSpec, "mcp"],
  };
  const projectRoot = opts.dir === undefined && opts.scope !== "user" ? resolve(opts.cwd || process.cwd()) : null;
  const planned = [];
  for (const t of targets) {
    assertWritableMcpPath(t.path, t.scope === "project" ? projectRoot : null);
    let existing = {};
    if (existsSync(t.path)) {
      const raw = readFileSync(t.path, "utf8").trim();
      if (raw) {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error(`Existing MCP config is not valid JSON: ${t.path}`);
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(`Existing MCP config root must be a JSON object: ${t.path}`);
        }
        if (
          parsed.mcpServers !== undefined &&
          (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers))
        ) {
          throw new Error(`Existing MCP config 'mcpServers' must be a JSON object: ${t.path}`);
        }
        existing = parsed;
      }
    }
    const merged = {
      ...existing,
      mcpServers: {
        ...(existing.mcpServers || {}),
        dsaf: serverEntry,
      },
    };
    planned.push({ t, merged });
  }
  const results = [];
  for (const { t, merged } of planned) {
    if (!opts.dryRun) {
      mkdirSync(dirname(t.path), { recursive: true });
      writeFileSync(t.path, JSON.stringify(merged, null, 2) + "\n", "utf8");
    }
    results.push({
      agent: t.agent,
      scope: t.scope,
      path: t.path,
      dryRun: Boolean(opts.dryRun),
      serverKey: "dsaf",
      packageSpec: pkgSpec,
    });
  }
  return results;
}

function runStdioServer() {
  const dispatch = createMcpDispatcher();
  const push = createFrameReader(
    (msg, mode) => {
      try {
        const res = dispatch(msg);
        if (res) {
          process.stdout.write(formatMcpResponse(res, mode));
        }
      } catch (err) {
        const hasId = msg && typeof msg === "object" && Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== undefined;
        if (hasId) {
          const errResp = {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: err instanceof Error ? err.message : "Internal error" },
          };
          process.stdout.write(formatMcpResponse(errResp, mode));
        }
      }
    },
    (err, mode) => {
      const errResp = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: err instanceof Error ? err.message : "Parse error" },
      };
      process.stdout.write(formatMcpResponse(errResp, mode || "ndjson"));
    }
  );
  process.stdin.on("data", (chunk) => push(chunk));
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-mcp-test-"));
  try {
    mkdirSync(join(scratch, "src"), { recursive: true });
    writeFileSync(join(scratch, "src/tokens.css"), ":root { --bg: #FFFDF8; --ink: #45210E; }\n.card { background: var(--bg); color: var(--ink); }\n", "utf8");
    writeFileSync(join(scratch, "src/App.tsx"), "export function App() { return <button type=\"button\">Save</button>; }\n", "utf8");
    const runtimeJson = join(scratch, "runtime.json");
    writeFileSync(
      runtimeJson,
      JSON.stringify({
        schema: "dsaf-runtime/2",
        allPassed: true,
        files: [{ file: "index.html", computedVars: { "--bg": "#FFFDF8", "--ink": "#45210E" }, checks: [] }],
      })
    );

    const dispatch = createMcpDispatcher();
    const responses = [];
    const reader = createFrameReader((msg, mode) => {
      const out = dispatch(msg);
      if (out) responses.push(formatMcpResponse(out, mode));
    });

    // 1. Test Content-Length framing (initialize + notification)
    const initReq = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const notifReq = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    reader(`Content-Length: ${Buffer.byteLength(initReq)}\r\n\r\n${initReq}Content-Length: ${Buffer.byteLength(notifReq)}\r\n\r\n${notifReq}`);
    assert.equal(responses.length, 1);
    assert.match(responses[0], /^Content-Length: \d+\r\n\r\n/);
    const initParsed = JSON.parse(responses[0].split("\r\n\r\n")[1]);
    assert.equal(initParsed.result.serverInfo.name, "dsaf");
    assert.equal(initParsed.result.serverInfo.version, MCP_SERVER_VERSION);

    // 2. Test NDJSON framing (tools/list + tool calls + unknown method)
    responses.length = 0;
    reader(
      [
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "dsaf_recon", arguments: { target: scratch } } }),
        JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "dsaf_tokens", arguments: { target: join(scratch, "src") } } }),
        JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "dsaf_hook_check", arguments: { target: join(scratch, "src"), tier: "all" } } }),
        JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "dsaf_doctor", arguments: { target: scratch, offline: true } } }),
        JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "dsaf_figma_diff", arguments: { tokens: join(scratch, "src"), runtime: runtimeJson } } }),
        JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "dsaf_fix_preview", arguments: { target: join(scratch, "src") } } }),
        JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "dsaf_personas", arguments: { target: scratch, depth: "deep" } } }),
        JSON.stringify({ jsonrpc: "2.0", id: 10, method: "unknown/method" }),
      ].join("\n") + "\n"
    );

    assert.equal(responses.length, 9);
    const listRes = JSON.parse(responses[0]);
    assert.equal(listRes.result.tools.length, 8);

    const reconRes = JSON.parse(JSON.parse(responses[1]).result.content[0].text);
    assert.ok(["S", "C", "P"].includes(reconRes.recommendedMode));

    const tokRes = JSON.parse(JSON.parse(responses[2]).result.content[0].text);
    assert.equal(tokRes.drift.hardcodedColorHits, 0);

    const hookRes = JSON.parse(JSON.parse(responses[3]).result.content[0].text);
    assert.equal(hookRes.counts.floor, 0);

    const docRes = JSON.parse(JSON.parse(responses[4]).result.content[0].text);
    assert.equal(docRes.version, MCP_SERVER_VERSION);

    const diffRes = JSON.parse(JSON.parse(responses[5]).result.content[0].text);
    assert.equal(diffRes.triangulationStatus, "2-vertex (Defined <-> Shipped)");
    assert.equal(diffRes.summary.matchedCount, 2);

    const fixRes = JSON.parse(JSON.parse(responses[6]).result.content[0].text);
    assert.equal(fixRes.dryRun, true);
    assert.equal(fixRes.beforeFloor, 0);

    const persRes = JSON.parse(JSON.parse(responses[7]).result.content[0].text);
    assert.equal(persRes.schema, "dsaf-personas/1");
    assert.equal(persRes.uncapped, true);
    assert.ok(persRes.personaCount >= 6);

    const unknownRes = JSON.parse(responses[8]);
    assert.equal(unknownRes.error.code, -32601);

    // 2b. Test dsaf_audit (all 8 tools) + multi-header split multibyte UTF-8 frame + parse error isolation
    responses.length = 0;
    const frameErrors = [];
    const utfReader = createFrameReader(
      (msg, mode) => {
        const out = dispatch(msg);
        if (out) responses.push(formatMcpResponse(out, mode));
      },
      (err) => frameErrors.push(err.message)
    );
    const auditReq = JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "dsaf_audit", arguments: { target: scratch } },
    });
    const framed = Buffer.from(
      `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(auditReq)}\r\n\r\n${auditReq}`,
      "utf8"
    );
    utfReader(framed.subarray(0, 42));
    utfReader(framed.subarray(42));
    assert.equal(responses.length, 1);
    const auditRes = JSON.parse(JSON.parse(responses[0].split("\r\n\r\n")[1]).result.content[0].text);
    assert.equal(auditRes.schema, "dsaf-audit/1");
    assert.equal(auditRes.engine_version, MCP_SERVER_VERSION);

    utfReader("{broken-json}\n" + JSON.stringify({ jsonrpc: "2.0", id: 13, method: "ping" }) + "\n");
    assert.equal(frameErrors.length, 1, "Malformed line must report error without breaking subsequent frame");
    assert.equal(responses.length, 2);

    // 3. Test installMcpConfig merge, default @latest vs --pin & dry-run
    const existingCfg = join(scratch, ".mcp.json");
    writeFileSync(existingCfg, JSON.stringify({ mcpServers: { other: { command: "echo" } }, unrelated: true }, null, 2));
    const dryMcp = installMcpConfig({ agent: "cursor", scope: "project", cwd: scratch, dryRun: true });
    assert.equal(dryMcp[0].dryRun, true);
    assert.equal(existsSync(join(scratch, ".cursor/mcp.json")), false);
    const written = installMcpConfig({ agent: "all", scope: "project", cwd: scratch });
    assert.equal(written.length, 4);
    const parsedClaude = JSON.parse(readFileSync(existingCfg, "utf8"));
    assert.equal(parsedClaude.unrelated, true);
    assert.equal(parsedClaude.mcpServers.other.command, "echo");
    assert.deepEqual(parsedClaude.mcpServers.dsaf, { command: "npx", args: ["-y", "@zintaen/dsaf@latest", "mcp"] });
    installMcpConfig({ agent: "claude", scope: "project", cwd: scratch, pin: true });
    assert.deepEqual(
      JSON.parse(readFileSync(existingCfg, "utf8")).mcpServers.dsaf,
      { command: "npx", args: ["-y", `@zintaen/dsaf@${MCP_SERVER_VERSION}`, "mcp"] }
    );

    // 4. Round 2 regressions: split CRLF header across chunks, NDJSON with "Content-Length:" text, ALL/comma all agents, dir -> dir/mcp.json
    const r2Msgs = [];
    const r2Errs = [];
    const r2Reader = createFrameReader(
      (msg, mode) => r2Msgs.push({ msg, mode }),
      (err) => r2Errs.push(err.message)
    );
    const pingBody = JSON.stringify({ jsonrpc: "2.0", id: 21, method: "ping" });
    r2Reader(`Content-Length: ${Buffer.byteLength(pingBody)}\r\n`);
    r2Reader(`\r\n${pingBody}`);
    r2Reader(JSON.stringify({ jsonrpc: "2.0", id: 22, method: "ping", note: "Content-Length: 99" }) + "\n\n");
    assert.equal(r2Errs.length, 0);
    assert.equal(r2Msgs.length, 2);
    assert.equal(r2Msgs[0].mode, "content-length");
    assert.equal(r2Msgs[1].mode, "ndjson");
    assert.equal(resolveMcpTargets({ agent: "claude,ALL", cwd: scratch }).length, 4);
    const dirTarget = join(scratch, "custom-mcp-dir");
    mkdirSync(dirTarget, { recursive: true });
    const dirWritten = installMcpConfig({ dir: dirTarget });
    assert.equal(dirWritten[0].path, join(dirTarget, "mcp.json"));

    // 5. Round 3 regressions: JSON-RPC notifications (no id) -> null, non-string method -> -32600,
    // Content-Length: 40garbage rejected, oversized NDJSON frame rejected, typo,all validation
    assert.equal(dispatch({ jsonrpc: "2.0", method: "tools/list" }), null, "Notification without id must return null");
    assert.equal(dispatch({ jsonrpc: "2.0", method: "initialize" }), null);
    assert.equal(dispatch({ jsonrpc: "2.0", id: 99, method: 123 }).error.code, -32600, "Non-string method must return -32600");
    assert.throws(() => resolveMcpTargets({ agent: "typo,all", scope: "project", cwd: scratch }), /Unknown --agent 'typo'/);

    const r3Errs = [];
    const r3Msgs = [];
    const r3Reader = createFrameReader(
      (msg, mode) => r3Msgs.push({ msg, mode }),
      (err) => r3Errs.push(err.message)
    );
    r3Reader(`Content-Length: 40garbage\r\n\r\n${pingBody}`);
    assert.equal(r3Errs.length, 1, "Malformed Content-Length suffix must trigger error");
    assert.equal(r3Msgs.length, 0);
    r3Reader("{" + "x".repeat(MAX_FRAME_BYTES + 16));
    assert.equal(r3Errs.length, 2, "Oversized unterminated NDJSON buffer must trigger error");

    // 6. Round 4 regressions: -32602 on bad params/arguments/unknown tool, missing target error, partial MCP write prevention, --agent constructor
    assert.equal(dispatch({ jsonrpc: "2.0", id: 30, method: "tools/call", params: "bad" }).error.code, -32602);
    assert.equal(dispatch({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "unknown_tool", arguments: {} } }).error.code, -32602);
    assert.equal(dispatch({ jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "dsaf_recon", arguments: "invalid" } }).error.code, -32602);
    const missTargetRes = dispatch({ jsonrpc: "2.0", id: 33, method: "tools/call", params: { name: "dsaf_recon", arguments: {} } });
    assert.equal(missTargetRes.result.isError, true, "Missing required target must fail rather than scan process.cwd()");
    assert.match(missTargetRes.result.content[0].text, /Parameter 'target' is required/);
    assert.throws(() => resolveMcpTargets({ agent: "constructor", scope: "project", cwd: scratch }), /Unknown --agent 'constructor'/);

    const atomicDir = join(scratch, "atomic-mcp");
    mkdirSync(join(atomicDir, ".cursor"), { recursive: true });
    writeFileSync(join(atomicDir, ".mcp.json"), JSON.stringify({ keep: "before" }));
    writeFileSync(join(atomicDir, ".cursor/mcp.json"), "{ invalid");
    assert.throws(() => installMcpConfig({ agent: "all", scope: "project", cwd: atomicDir }), /Existing MCP config is not valid JSON/);
    assert.deepEqual(JSON.parse(readFileSync(join(atomicDir, ".mcp.json"), "utf8")), { keep: "before" }, "Malformed target #2 must prevent partial overwrite of target #1");

    // 7. Round 5 regression: NDJSON session recovers immediately after malformed header-like colon line
    const ndMsgs = [];
    const ndErrs = [];
    const ndReader = createFrameReader(
      (msg, mode) => ndMsgs.push({ msg, mode }),
      (err) => ndErrs.push(err.message)
    );
    ndReader('{"jsonrpc":"2.0","id":40,"method":"ping"}\nfoo: bar\n{"jsonrpc":"2.0","id":41,"method":"ping"}\n');
    assert.equal(ndErrs.length, 1, "Malformed header-like line in NDJSON must emit error immediately");
    assert.deepEqual(ndMsgs.map((m) => m.msg.id), [40, 41], "Subsequent NDJSON frames after malformed colon line must parse");

    // 8. Round 6 regressions: chunk-split custom header before Content-Length; handler exceptions not misreported as -32700 parse errors
    const r6HdrMsgs = [];
    const r6HdrErrs = [];
    const r6HdrReader = createFrameReader(
      (msg, mode) => r6HdrMsgs.push({ msg, mode }),
      (err) => r6HdrErrs.push(err.message)
    );
    const p6 = JSON.stringify({ jsonrpc: "2.0", id: 50, method: "ping" });
    r6HdrReader(`X-Trace-Id: abc\r\nContent-Length: ${Buffer.byteLength(p6)}\r\n`);
    r6HdrReader(`\r\n${p6}`);
    assert.equal(r6HdrErrs.length, 0, "Chunk-split custom header + Content-Length must not emit parse error");
    assert.equal(r6HdrMsgs.length, 1);

    const r6Hdr2Msgs = [];
    const r6Hdr2Errs = [];
    const r6Hdr2Reader = createFrameReader(
      (msg, mode) => r6Hdr2Msgs.push({ msg, mode }),
      (err) => r6Hdr2Errs.push(err.message)
    );
    r6Hdr2Reader("X-Trace-Id: abc\r\n");
    r6Hdr2Reader(`Content-Length: ${Buffer.byteLength(p6)}\r\n\r\n${p6}`);
    assert.equal(r6Hdr2Errs.length, 0, "Multi-chunk custom header before Content-Length must not emit parse error");
    assert.equal(r6Hdr2Msgs.length, 1);

    const r7SplitMsgs = [];
    const r7SplitErrs = [];
    const r7SplitReader = createFrameReader(
      (msg, mode) => r7SplitMsgs.push({ msg, mode }),
      (err) => r7SplitErrs.push(err.message)
    );
    const r7Full = `X-Trace-Id: abc\r\nContent-Length: ${Buffer.byteLength(p6)}\r\n\r\n${p6}`;
    r7SplitReader(r7Full.slice(0, 24));
    r7SplitReader(r7Full.slice(24));
    assert.equal(r7SplitErrs.length, 0, "Chunk-split mid-header-name before Content-Length must not emit parse error");
    assert.equal(r7SplitMsgs.length, 1);

    const r7Bad1Errs = [];
    const r7Bad1Msgs = [];
    const r7Bad1Reader = createFrameReader(
      (msg, mode) => r7Bad1Msgs.push({ msg, mode }),
      (err) => r7Bad1Errs.push(err.message)
    );
    r7Bad1Reader('foo: bar\n{"jsonrpc":"2.0","id":41,"method":"ping"}\n');
    assert.ok(r7Bad1Errs.length >= 1, "Malformed header before JSON line must emit parse error immediately");

    const r7Bad2Errs = [];
    const r7Bad2Reader = createFrameReader(
      () => {},
      (err) => r7Bad2Errs.push(err.message)
    );
    r7Bad2Reader("X-Trace-Id: abc\r\n{bad");
    assert.ok(r7Bad2Errs.length >= 1, "Custom header followed by malformed body must emit parse error immediately");

    const handlerErrs = [];
    const throwReader = createFrameReader(
      () => {
        throw new Error("handler boom");
      },
      (err) => handlerErrs.push(err.message)
    );
    assert.throws(() => throwReader(`${p6}\n`), /handler boom/);
    assert.equal(handlerErrs.length, 0, "Handler exceptions must not invoke parse onError callback");

    // Round 8 regression: oversized non-brace line > MAX_FRAME_BYTES must fail with size limit error
    const r8Errs = [];
    const r8Msgs = [];
    const r8Reader = createFrameReader(
      (msg, mode) => r8Msgs.push({ msg, mode }),
      (err) => r8Errs.push(err.message)
    );
    const oversizedBad = Buffer.concat([Buffer.alloc(10 * 1024 * 1024 + 16, 0x78), Buffer.from(`\n${p6}\n`)]);
    r8Reader(oversizedBad);
    assert.equal(r8Errs.length, 1, "Oversized non-brace frame must invoke onError");
    assert.match(r8Errs[0], /exceeded 10MB limit/);
    assert.equal(r8Msgs.length, 1, "Decoder must recover and parse subsequent valid frame");

    // Round 9 regressions (R9-A1-01): silent NDJSON frame loss before Content-Length, stream stall on Content-Type + NDJSON,
    // duplicate Content-Length smuggling, and oversized header block rejection
    const r9MixMsgs = [];
    const r9MixErrs = [];
    const r9MixReader = createFrameReader(
      (msg, mode) => r9MixMsgs.push({ msg, mode }),
      (err) => r9MixErrs.push(err.message)
    );
    const pPing2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
    r9MixReader(`bad-garbage\n{"jsonrpc":"2.0","id":1,"method":"ping"}\nContent-Length: ${Buffer.byteLength(pPing2)}\r\n\r\n${pPing2}`);
    assert.equal(r9MixErrs.length, 1, "Invalid line before NDJSON + Content-Length must emit error without dropping NDJSON");
    assert.deepEqual(
      r9MixMsgs.map((x) => [x.msg.id, x.mode]),
      [
        [1, "ndjson"],
        [2, "content-length"],
      ]
    );

    const r9StallMsgs = [];
    const r9StallErrs = [];
    const r9StallReader = createFrameReader(
      (msg, mode) => r9StallMsgs.push({ msg, mode }),
      (err) => r9StallErrs.push(err.message)
    );
    r9StallReader('Content-Type: application/json\r\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    assert.equal(r9StallErrs.length, 1, "Dangling header followed by NDJSON line must error and deliver NDJSON immediately");
    assert.equal(r9StallMsgs.length, 1);
    assert.equal(r9StallMsgs[0].msg.id, 1);

    const r9DupErrs = [];
    const r9DupMsgs = [];
    const r9DupReader = createFrameReader(
      (msg, mode) => r9DupMsgs.push({ msg, mode }),
      (err) => r9DupErrs.push(err.message)
    );
    r9DupReader(`Content-Length: ${Buffer.byteLength(pPing2)}\r\nContent-Length: 999\r\n\r\n${pPing2}`);
    assert.equal(r9DupErrs.length, 1);
    assert.match(r9DupErrs[0], /Duplicate Content-Length header/);
    assert.equal(r9DupMsgs.length, 0);

    const r9BigHdrErrs = [];
    const r9BigHdrReader = createFrameReader(
      () => {},
      (err) => r9BigHdrErrs.push(err.message)
    );
    r9BigHdrReader(`X-Huge: ${"a".repeat(17_000)}\r\nContent-Length: 2\r\n\r\n{}`);
    assert.equal(r9BigHdrErrs.length, 1);
    assert.match(r9BigHdrErrs[0], /exceeded 16KB/);

    // Round 11 regression (R11-A1-04): Content-Length header matching must not span CRLF/LF newlines via \s*
    const r11FoldCases = [
      {
        raw: `Content-Length:\r\nContent-Length: ${Buffer.byteLength(pPing2)}\r\n\r\n${pPing2}`,
        errRe: /Duplicate Content-Length header/,
        forbidRe: null,
      },
      {
        raw: "Content-Length:\r\nX-Trace-Id: secret\r\n\r\n{}",
        errRe: /Invalid Content-Length:/,
        forbidRe: /X-Trace-Id|secret/,
      },
      {
        raw: "Content-Length:\r\nFoo: 2\r\n\r\n{}",
        errRe: /Invalid Content-Length:/,
        forbidRe: /Foo/,
      },
    ];
    for (const tc of r11FoldCases) {
      const r11FoldErrs = [];
      const r11FoldMsgs = [];
      const r11FoldReader = createFrameReader(
        (msg, mode) => r11FoldMsgs.push({ msg, mode }),
        (err) => r11FoldErrs.push(err.message)
      );
      r11FoldReader(tc.raw);
      assert.equal(r11FoldErrs.length, 1, `Newline-folded Content-Length must reject: ${JSON.stringify(tc.raw)}`);
      assert.match(r11FoldErrs[0], tc.errRe);
      if (tc.forbidRe) assert.doesNotMatch(r11FoldErrs[0], tc.forbidRe);
      assert.equal(r11FoldMsgs.length, 0, "Newline-folded Content-Length must not deliver messages");
    }

    // Round 13 regression (R13-A1-01): dsaf_tokens must enforce scope containment, non-string guard, and directory target
    const r13Outside = mkdtempSync(join(tmpdir(), "dsaf-mcp-outside-"));
    try {
      writeFileSync(join(r13Outside, "leak.css"), ".x { color: #ff00aa; }\n");
      symlinkSync(r13Outside, join(scratch, "esc-link"));
      for (const [label, args] of [
        ["parent traversal", { target: join(scratch, "src"), scope: ".." }],
        ["file target with scope", { target: join(scratch, "src/tokens.css"), scope: ".." }],
        ["escaping symlink scope", { target: scratch, scope: "esc-link" }],
        ["non-string scope", { target: scratch, scope: 123 }],
        ["root escape scope", { target: scratch, scope: "/" }],
      ]) {
        const badRes = dispatch({ jsonrpc: "2.0", id: 910, method: "tools/call", params: { name: "dsaf_tokens", arguments: args } });
        assert.equal(badRes.result.isError, true, `dsaf_tokens must reject ${label}`);
      }
      const r13AbsOk = dispatch({
        jsonrpc: "2.0",
        id: 911,
        method: "tools/call",
        params: { name: "dsaf_tokens", arguments: { target: scratch, scope: join(scratch, "src") } },
      });
      assert.notEqual(r13AbsOk.result.isError, true, "dsaf_tokens must accept valid intra-repo absolute scope");
      const r13AbsPayload = JSON.parse(r13AbsOk.result.content[0].text);
      assert.equal(r13AbsPayload.filesScanned.uiAndStyle, 2);
    } finally {
      rmSync(r13Outside, { recursive: true, force: true });
    }

    // Round 14 regressions (R14-A1-02, R14-A1-03): dsaf_audit non-string guards & CLI positional/install-flag validation
    for (const [label, badScope] of [
      ["boolean false", false],
      ["number 0", 0],
      ["array", ["bin"]],
    ]) {
      const badAudit = dispatch({ jsonrpc: "2.0", id: 920, method: "tools/call", params: { name: "dsaf_audit", arguments: { target: scratch, scope: badScope } } });
      assert.equal(badAudit.result.isError, true, `dsaf_audit must reject non-string scope (${label})`);
      assert.match(badAudit.result.content[0].text, /Parameter 'scope' must be a string\./);
    }

    const r14CliCwd = join(scratch, "r14-cli");
    mkdirSync(r14CliCwd, { recursive: true });
    const mcpSelfPath = fileURLToPath(import.meta.url);
    const badPosRun = spawnSync(process.execPath, [mcpSelfPath, "install", "./examples", "--dry-run"], { cwd: r14CliCwd, encoding: "utf8" });
    assert.equal(badPosRun.status, 2, "Extra positional argument to 'dsaf mcp install' must exit 2");
    assert.equal(existsSync(join(r14CliCwd, ".mcp.json")), false, "Rejected install command must not write .mcp.json");
    const badStdioRun = spawnSync(process.execPath, [mcpSelfPath, "--dry-run", "--pin"], { cwd: r14CliCwd, input: "", encoding: "utf8" });
    assert.equal(badStdioRun.status, 2, "Install-only flags on stdio mode must exit 2 immediately");

    // Round 15 regressions (R15-A1-02, R15-A1-03): reject empty/whitespace --dir/--cwd/--tag & invalid optional tool param types
    assert.throws(() => resolveMcpTargets({ dir: "" }), /--dir.*non-empty/);
    assert.throws(() => resolveMcpTargets({ dir: "   " }), /--dir.*non-empty/);
    assert.throws(() => resolveMcpTargets({ scope: "project", cwd: "" }), /--cwd.*non-empty/);
    assert.throws(() => resolveMcpTargets({ scope: "project", cwd: "   " }), /--cwd.*non-empty/);
    assert.equal(spawnSync(process.execPath, [mcpSelfPath, "install", "--dir", "", "--dry-run"], { cwd: r14CliCwd, encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [mcpSelfPath, "install", "--cwd", " ", "--dry-run"], { cwd: r14CliCwd, encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [mcpSelfPath, "install", "--tag", " ", "--dry-run"], { cwd: r14CliCwd, encoding: "utf8" }).status, 2);
    for (const [toolName, badArgs] of [
      ["dsaf_doctor", { target: scratch, dsCss: "bad" }],
      ["dsaf_hook_check", { target: scratch, tier: "bad" }],
      ["dsaf_hook_check", { target: scratch, dsCss: [123] }],
      ["dsaf_fix_preview", { target: scratch, rule: "bad" }],
      ["dsaf_fix_preview", { target: scratch, maxFiles: "2" }],
      ["dsaf_fix_preview", { target: scratch, maxFiles: 0 }],
      ["dsaf_personas", { target: scratch, max: -1 }],
      ["dsaf_personas", { target: scratch, depth: "invalid" }],
      ["dsaf_figma_diff", { tokens: join(scratch, "src/tokens.css"), figma: 123 }],
      ["dsaf_figma_diff", { tokens: join(scratch, "src/tokens.css"), runtime: {} }],
      ["dsaf_figma_diff", { tokens: join(scratch, "src/tokens.css"), runtime: join(scratch, "src/tokens.css"), codeConnect: [] }],
      ["dsaf_figma_diff", { tokens: join(scratch, "src/tokens.css"), runtime: join(scratch, "src/tokens.css"), prefix: 42 }],
      ["dsaf_tokens", { target: scratch, includeDemos: "yes" }],
    ]) {
      const badCall = dispatch({ jsonrpc: "2.0", id: 925, method: "tools/call", params: { name: toolName, arguments: badArgs } });
      assert.equal(badCall.result.isError, true, `${toolName} must reject invalid args: ${JSON.stringify(badArgs)}`);
    }

    // Round 16 regressions (R16-A1-01, R16-A1-02): Content-Length smuggling must never execute body as NDJSON; whitespace outDir must reject
    const r16Body = '{"jsonrpc":"2.0","id":1,"method":"ping"}\n';
    for (const smugglePayload of [
      `Content-Length: ${Buffer.byteLength(r16Body)}\r\nContent-Length: 999\r\n\r\n${r16Body}`,
      `Content-Length:\r\nContent-Length: ${Buffer.byteLength(r16Body)}\r\n\r\n${r16Body}`,
      `Content-Type: application/json\r\n\r\n${r16Body}`,
      `Content-Length: 40garbage\r\n\r\n${r16Body}`,
      `X-Huge: ${"a".repeat(17_000)}\r\nContent-Length: ${Buffer.byteLength(r16Body)}\r\n\r\n${r16Body}`,
    ]) {
      const sMsgs = [], sErrs = [];
      const sReader = createFrameReader((m, mode) => sMsgs.push({ m, mode }), (e) => sErrs.push(e.message));
      sReader(smugglePayload);
      assert.equal(sErrs.length, 1, `Smuggled header must emit 1 error: ${smugglePayload.slice(0, 48)}`);
      assert.equal(sMsgs.length, 0, `Smuggled frame body must never execute as NDJSON: ${smugglePayload.slice(0, 48)}`);
    }

    const r16SplitMsgs = [], r16SplitErrs = [];
    const r16SplitReader = createFrameReader((m, mode) => r16SplitMsgs.push({ m, mode }), (e) => r16SplitErrs.push(e.message));
    const r16ValidNext = JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" });
    r16SplitReader(`Content-Length: ${Buffer.byteLength(r16Body)}\r\nContent-Length: 999\r\n\r\n`);
    r16SplitReader(r16Body);
    r16SplitReader(`Content-Length: ${Buffer.byteLength(r16ValidNext)}\r\n\r\n${r16ValidNext}`);
    assert.equal(r16SplitErrs.length, 1);
    assert.deepEqual(r16SplitMsgs, [{ m: { jsonrpc: "2.0", id: 99, method: "ping" }, mode: "content-length" }]);

    const r16BigSplitMsgs = [], r16BigSplitErrs = [];
    const r16BigSplitReader = createFrameReader((m, mode) => r16BigSplitMsgs.push({ m, mode }), (e) => r16BigSplitErrs.push(e.message));
    r16BigSplitReader(`X-Huge: ${"a".repeat(17_000)}`);
    r16BigSplitReader(`tail\r\nContent-Length: ${Buffer.byteLength(r16Body)}\r\n\r\n${r16Body}`);
    assert.equal(r16BigSplitErrs.length, 1);
    assert.equal(r16BigSplitMsgs.length, 0);

    const wsAuditCall = dispatch({ jsonrpc: "2.0", id: 926, method: "tools/call", params: { name: "dsaf_audit", arguments: { target: scratch, outDir: "   " } } });
    assert.equal(wsAuditCall.result.isError, true, "dsaf_audit must reject whitespace-only outDir");

    // Round 17 regressions (R17-A1-02, R17-A1-05, R17-A1-06, R17-A1-07):
    // 1. Malformed header line alongside Content-Length must reject header & enter resync instead of falling back to NDJSON execution
    for (const badHdrPayload of [
      `Content-Length: 999\r\nX_Bad: 1\r\n\r\n${r16Body}`,
      `X-Ok: 1\r\nX_Bad: 2\r\nContent-Length: 999\r\n\r\n${r16Body}`,
    ]) {
      const mMsgs = [], mErrs = [];
      const mReader = createFrameReader((m, mode) => mMsgs.push({ m, mode }), (e) => mErrs.push(e.message));
      mReader(badHdrPayload);
      assert.equal(mErrs.length, 1, `Malformed header block must emit 1 error: ${badHdrPayload.slice(0, 48)}`);
      assert.equal(mMsgs.length, 0, "Malformed Content-Length header block must never execute body as NDJSON");
    }

    // 2. Reject --tag with invalid chars / empty & rejecting --pin + --tag together
    assert.throws(() => installMcpConfig({ agent: "claude", scope: "project", cwd: r14CliCwd, pin: true, packageTag: "next" }), /Cannot combine --pin and --tag/);
    assert.throws(() => installMcpConfig({ agent: "claude", scope: "project", cwd: r14CliCwd, packageTag: "foo bar" }), /Invalid --tag/);
    assert.throws(() => installMcpConfig({ agent: "claude", scope: "project", cwd: r14CliCwd, packageTag: "@bad" }), /Invalid --tag/);
    assert.equal(spawnSync(process.execPath, [mcpSelfPath, "install", "--tag", "foo bar", "--dry-run"], { cwd: r14CliCwd, encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [mcpSelfPath, "install", "--pin", "--tag", "next", "--dry-run"], { cwd: r14CliCwd, encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [mcpSelfPath, "install", "--tag", "", "--dry-run"], { cwd: r14CliCwd, encoding: "utf8" }).status, 2);

    // 3. dsaf_tokens rejects whitespace-only / empty scope and unknown removed dsaf_evolve_status returns -32602
    for (const wsScope of ["", "   "]) {
      const tokWs = dispatch({ jsonrpc: "2.0", id: 930, method: "tools/call", params: { name: "dsaf_tokens", arguments: { target: scratch, scope: wsScope } } });
      assert.equal(tokWs.result.isError, true, `dsaf_tokens must reject scope=${JSON.stringify(wsScope)}`);
    }
    const evRemoved = dispatch({ jsonrpc: "2.0", id: 931, method: "tools/call", params: { name: "dsaf_evolve_status", arguments: { target: scratch } } });
    assert.equal(evRemoved.error.code, -32602, "Removed dsaf_evolve_status tool must return -32602");
    const persMissing = dispatch({ jsonrpc: "2.0", id: 932, method: "tools/call", params: { name: "dsaf_personas", arguments: { target: join(scratch, "nonexistent-dir") } } });
    assert.equal(persMissing.result.isError, true, "dsaf_personas must return isError for missing target");

    // Round 18 regressions (R18-A1-01, R18-A1-02, R18-A1-03):
    // 1. First-line malformed header before Content-Length: must reject & resync without executing body
    const r18Msgs = [], r18Errs = [];
    const r18Reader = createFrameReader((m, mode) => r18Msgs.push({ m, mode }), (e) => r18Errs.push(e.message));
    r18Reader(`X_Bad: 1\r\nContent-Length: ${Buffer.byteLength(r16Body)}\r\n\r\n${r16Body}`);
    assert.equal(r18Errs.length, 1);
    assert.equal(r18Msgs.length, 0, "Malformed first header line before Content-Length must never execute body");

    // 2. Empty string optional params must return isError across all tools using optString
    for (const [toolName, badArgs] of [
      ["dsaf_audit", { target: scratch, scope: "" }],
      ["dsaf_audit", { target: scratch, figmaPath: "" }],
      ["dsaf_audit", { target: scratch, outDir: "" }],
      ["dsaf_hook_check", { target: scratch, tier: "" }],
      ["dsaf_personas", { target: scratch, depth: "" }],
      ["dsaf_personas", { target: scratch, customPath: "" }],
      ["dsaf_figma_diff", { tokens: join(scratch, "src/tokens.css"), figma: "" }],
      ["dsaf_figma_diff", { tokens: join(scratch, "src/tokens.css"), runtime: "" }],
    ]) {
      const r18EmptyCall = dispatch({ jsonrpc: "2.0", id: 935, method: "tools/call", params: { name: toolName, arguments: badArgs } });
      assert.equal(r18EmptyCall.result.isError, true, `${toolName} must reject empty string args: ${JSON.stringify(badArgs)}`);
    }

    // 3. installMcpConfig aborts atomically before writing earlier agents and rejects regular-file cwd/dir even in dryRun
    const r18Home = join(scratch, "r18-home-mcp");
    const r18RegularFile = join(scratch, "r18-not-a-dir.txt");
    mkdirSync(r18Home, { recursive: true });
    writeFileSync(join(r18Home, ".gemini"), "not-a-dir\n");
    writeFileSync(r18RegularFile, "not a dir\n");
    assert.throws(
      () => installMcpConfig({ agent: "claude,antigravity", scope: "user", home: r18Home }),
      /not a (?:valid )?directory/
    );
    assert.equal(existsSync(join(r18Home, ".claude.json")), false, "Blocked later target must prevent writing .claude.json");
    assert.throws(
      () => installMcpConfig({ agent: "claude", scope: "project", cwd: r18RegularFile, dryRun: true }),
      /not a (?:valid )?directory/
    );
    assert.throws(
      () => installMcpConfig({ agent: "claude", dir: r18RegularFile, dryRun: true }),
      /not a (?:valid )?directory/
    );

    // Round 19 regressions (R19-A1-01, R19-A4-LOW-1): Content-Length header resync with orphaned body lacking trailing newline & schema constraints
    {
      const r19Msgs = [];
      const r19Errs = [];
      const r19Reader = createFrameReader((m, mode) => r19Msgs.push({ id: m.id, mode }), (e) => r19Errs.push(e.message));
      const b1 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
      r19Reader(`Content-Length: ${Buffer.byteLength(b1)}\r\nContent-Length: 999\r\n\r\n`);
      r19Reader(b1);
      r19Reader(formatMcpResponse({ jsonrpc: "2.0", id: 2, method: "ping" }, "content-length"));
      r19Reader(formatMcpResponse({ jsonrpc: "2.0", id: 3, method: "ping" }, "content-length"));
      assert.deepEqual(r19Errs, ["Duplicate Content-Length header"]);
      assert.deepEqual(r19Msgs, [{ id: 2, mode: "content-length" }, { id: 3, mode: "content-length" }]);
    }
    const hookTool = TOOL_DEFINITIONS.find((t) => t.name === "dsaf_hook_check");
    assert.deepEqual(hookTool.inputSchema.properties.tier.enum, ["floor", "reflex", "all"]);
    assert.equal(TOOL_DEFINITIONS.find((t) => t.name === "dsaf_fix_preview").inputSchema.properties.maxFiles.type, "integer");
    assert.equal(TOOL_DEFINITIONS.find((t) => t.name === "dsaf_personas").inputSchema.properties.max.type, "integer");

    // Round 20 regressions (R20-A1-H1, R20-A1-M1, R20-A4-M2, R20-A4-L1):
    {
      const r20CoalMsgs = [];
      const r20CoalErrs = [];
      const r20CoalReader = createFrameReader((m, mode) => r20CoalMsgs.push({ id: m.id, mode }), (e) => r20CoalErrs.push(e.message));
      const b1 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
      const coalesced =
        `Content-Length: ${Buffer.byteLength(b1)}\r\nContent-Length: 999\r\n\r\n${b1}` +
        formatMcpResponse({ jsonrpc: "2.0", id: 2, method: "ping" }, "content-length") +
        formatMcpResponse({ jsonrpc: "2.0", id: 3, method: "ping" }, "content-length");
      r20CoalReader(coalesced);
      assert.deepEqual(r20CoalErrs, ["Duplicate Content-Length header"]);
      assert.deepEqual(r20CoalMsgs, [{ id: 2, mode: "content-length" }, { id: 3, mode: "content-length" }]);

      const r20CtMsgs = [];
      const r20CtErrs = [];
      const r20CtReader = createFrameReader((m, mode) => r20CtMsgs.push({ id: m.id, mode }), (e) => r20CtErrs.push(e.message));
      r20CtReader(
        `Content-Type: application/json\r\n\r\n${b1}` +
          formatMcpResponse({ jsonrpc: "2.0", id: 4, method: "ping" }, "content-length")
      );
      assert.deepEqual(r20CtErrs, ["Missing Content-Length header"]);
      assert.deepEqual(r20CtMsgs, [{ id: 4, mode: "content-length" }]);

      for (const [pfx, rest] of [
        ["Content-Len", "gth: "],
        ["Con", "tent-Length: "],
      ]) {
        const pMsgs = [];
        const pErrs = [];
        const pReader = createFrameReader((m, mode) => pMsgs.push({ id: m.id, mode }), (e) => pErrs.push(e.message));
        const okPayload = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" });
        pReader("Content-Type: application/json\r\n\r\n");
        pReader(Buffer.concat([Buffer.from("{"), Buffer.alloc(10 * 1024 * 1024 + 32, 0x78), Buffer.from(`\n${pfx}`)]));
        pReader(`${rest}${Buffer.byteLength(okPayload)}\r\n\r\n${okPayload}`);
        assert.deepEqual(pErrs, ["Missing Content-Length header"], `Split partial '${pfx}' across >10MB garbage must not emit spurious limit error`);
        assert.deepEqual(pMsgs, [{ id: 5, mode: "content-length" }]);
      }
    }
    const r20MixedDir = join(scratch, "r20-mixed");
    mkdirSync(r20MixedDir, { recursive: true });
    writeFileSync(join(r20MixedDir, "floorOnly.css"), ".a:focus { outline: none; }\n");
    const r20FloorOnlyReflex = JSON.parse(
      dispatch({
        jsonrpc: "2.0",
        id: 940,
        method: "tools/call",
        params: { name: "dsaf_hook_check", arguments: { target: join(r20MixedDir, "floorOnly.css"), tier: "reflex" } },
      }).result.content[0].text
    );
    assert.equal(r20FloorOnlyReflex.passed, true);
    assert.equal(r20FloorOnlyReflex.counts.floor, 0);
    assert.equal(r20FloorOnlyReflex.counts.reflex, 0);
    writeFileSync(join(r20MixedDir, "both.css"), ".a:focus { outline: none; }\n.b { color: #ff00aa; }\n");
    const r20BothReflex = JSON.parse(
      dispatch({
        jsonrpc: "2.0",
        id: 941,
        method: "tools/call",
        params: { name: "dsaf_hook_check", arguments: { target: join(r20MixedDir, "both.css"), tier: "reflex" } },
      }).result.content[0].text
    );
    assert.equal(r20BothReflex.passed, false);
    assert.equal(r20BothReflex.counts.floor, 0);
    assert.equal(r20BothReflex.counts.reflex, 1);

    const figmaDiffTool = TOOL_DEFINITIONS.find((t) => t.name === "dsaf_figma_diff");
    assert.deepEqual(figmaDiffTool.inputSchema.anyOf, [{ required: ["figma"] }, { required: ["runtime"] }]);
    const docTool = TOOL_DEFINITIONS.find((t) => t.name === "dsaf_doctor");
    assert.equal(docTool.inputSchema.properties.scope.type, "string");
    assert.equal(docTool.inputSchema.properties.offline.type, "boolean");
    const docSubDir = join(scratch, "r20-doc-sub");
    mkdirSync(join(docSubDir, "apps/web"), { recursive: true });
    writeFileSync(join(docSubDir, "bad.css"), ".bad:focus { outline: none; }\n");
    writeFileSync(join(docSubDir, "apps/web/btn.css"), ".b { color: var(--fg); }\n");
    const docOptCall = JSON.parse(
      dispatch({
        jsonrpc: "2.0",
        id: 942,
        method: "tools/call",
        params: { name: "dsaf_doctor", arguments: { target: docSubDir, scope: "apps/web", offline: true } },
      }).result.content[0].text
    );
    assert.equal(docOptCall.schema, "dsaf-doctor/1");
    assert.match(docOptCall.checks.find((c) => c.id === "waiver_and_floor_hygiene").detail, /Scanned 1 UI file\(s\): 0 Floor findings/);
    assert.match(docOptCall.checks.find((c) => c.id === "cli_update_freshness").detail, /(?:offline mode|cached|latest)/i);

    // Round 21 regressions (R21-A1-L5, R21-A1-L6):
    // 1. >16KB malformed X_Bad header preceding Content-Length rejects whole block & resyncs trailing ping
    const r21BigMsgs = [];
    const r21BigErrs = [];
    const r21BigReader = createFrameReader(
      (msg, mode) => r21BigMsgs.push({ msg, mode }),
      (err) => r21BigErrs.push(err.message)
    );
    const r21PingBody = JSON.stringify({ jsonrpc: "2.0", id: 943, method: "ping" });
    r21BigReader(
      `X_Bad: ${"a".repeat(17_000)}\r\nContent-Length: 2\r\n\r\n{}Content-Length: ${Buffer.byteLength(r21PingBody)}\r\n\r\n${r21PingBody}`
    );
    assert.equal(r21BigErrs.length, 1);
    assert.match(r21BigErrs[0], /exceeded 16KB/);
    assert.equal(r21BigMsgs.length, 1, "Discarded oversized block body must not run; trailing valid frame must recover");
    assert.equal(r21BigMsgs[0].msg.id, 943);

    // 2. dsaf_doctor offline: false reads DSAF_UPDATE_CACHE and emits online/cached comparison cleanly (clearing CI env during online check)
    const prevUpCache = process.env.DSAF_UPDATE_CACHE;
    const prevNoUp = process.env.DSAF_NO_UPDATE_CHECK;
    const prevCi = process.env.CI;
    const r21CacheFile = join(scratch, "r21-update-cache.json");
    writeFileSync(
      r21CacheFile,
      JSON.stringify({ schema: "dsaf-update-cache/1", latestVersion: "9.9.9", checkedAt: new Date().toISOString() })
    );
    try {
      process.env.DSAF_UPDATE_CACHE = r21CacheFile;
      delete process.env.DSAF_NO_UPDATE_CHECK;
      delete process.env.CI;
      const docOnlineCall = JSON.parse(
        dispatch({
          jsonrpc: "2.0",
          id: 944,
          method: "tools/call",
          params: { name: "dsaf_doctor", arguments: { target: docSubDir, scope: "apps/web", offline: false } },
        }).result.content[0].text
      );
      assert.equal(
        docOnlineCall.checks.find((c) => c.id === "cli_update_freshness").status,
        "WARN",
        "dsaf_doctor with offline: false must read update status and warn on newer 9.9.9 cache"
      );
    } finally {
      if (prevUpCache === undefined) delete process.env.DSAF_UPDATE_CACHE;
      else process.env.DSAF_UPDATE_CACHE = prevUpCache;
      if (prevNoUp === undefined) delete process.env.DSAF_NO_UPDATE_CHECK;
      else process.env.DSAF_NO_UPDATE_CHECK = prevNoUp;
      if (prevCi === undefined) delete process.env.CI;
      else process.env.CI = prevCi;
    }

    // Round 22 regressions (R22-A1-01, R22-A1-02, R22-A1-05):
    // 1. Mixed-mode NDJSON followed by single-chunk >16KB X_Bad + Content-Length rejects & resyncs cleanly
    const r22Ping2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
    const r22Ping3 = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" });
    const r22PingFrame3 = formatMcpResponse({ jsonrpc: "2.0", id: 3, method: "ping" }, "content-length");
    {
      const mMsgs = [];
      const mErrs = [];
      const mReader = createFrameReader((m, mode) => mMsgs.push({ id: m.id, mode }), (e) => mErrs.push(e.message));
      mReader(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n` +
          `X_Bad: ${"a".repeat(17_000)}\r\nContent-Length: ${Buffer.byteLength(r22Ping2)}\r\n\r\n${r22Ping2}` +
          r22PingFrame3
      );
      assert.equal(mErrs.length, 1);
      assert.match(mErrs[0], /exceeded 16KB/);
      assert.deepEqual(
        mMsgs,
        [
          { id: 1, mode: "ndjson" },
          { id: 3, mode: "content-length" },
        ],
        "Mixed-mode >16KB X_Bad + Content-Length must reject id:2 and resync id:3"
      );
    }

    // 2. Chunk-split >16KB X_Bad (no \\n -> \\r\\nContent-Length, and \\r\\n -> Content-Length) rejects & discards id:2
    for (const [tailFirst, secondHead] of [
      [`X_Bad: ${"a".repeat(17_000)}`, "\r\n"],
      [`X_Bad: ${"a".repeat(17_000)}\r\n`, ""],
    ]) {
      for (const priorNdjson of [false, true]) {
        const sMsgs = [];
        const sErrs = [];
        const sReader = createFrameReader((m, mode) => sMsgs.push({ id: m.id, mode }), (e) => sErrs.push(e.message));
        if (priorNdjson) sReader(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
        sReader(tailFirst);
        sReader(`${secondHead}Content-Length: ${Buffer.byteLength(r22Ping2)}\r\n\r\n${r22Ping2}${r22PingFrame3}`);
        assert.equal(sErrs.length, 1, `Chunk-split >16KB X_Bad (priorNdjson=${priorNdjson}) must emit 1 error`);
        assert.match(sErrs[0], /exceeded 16KB/);
        assert.deepEqual(
          sMsgs,
          priorNdjson
            ? [
                { id: 1, mode: "ndjson" },
                { id: 3, mode: "content-length" },
              ]
            : [{ id: 3, mode: "content-length" }]
        );
      }
    }

    // 3. dsaf_doctor validates target/scope/dsCss BEFORE reading/writing update cache or spawning update-check
    const r22MissingCache = join(scratch, "r22-never-created-cache.json");
    try {
      process.env.DSAF_UPDATE_CACHE = r22MissingCache;
      delete process.env.DSAF_NO_UPDATE_CHECK;
      const badDocTarget = dispatch({
        jsonrpc: "2.0",
        id: 945,
        method: "tools/call",
        params: { name: "dsaf_doctor", arguments: { target: join(scratch, "no-such-dir"), offline: false } },
      });
      assert.equal(badDocTarget.result.isError, true);
      assert.match(badDocTarget.result.content[0].text, /Target directory not found/);
      assert.equal(existsSync(r22MissingCache), false, "Invalid target in dsaf_doctor must reject before spawning update-check");
    } finally {
      if (prevUpCache === undefined) delete process.env.DSAF_UPDATE_CACHE;
      else process.env.DSAF_UPDATE_CACHE = prevUpCache;
      if (prevNoUp === undefined) delete process.env.DSAF_NO_UPDATE_CHECK;
      else process.env.DSAF_NO_UPDATE_CHECK = prevNoUp;
    }

    // Round 23 regressions (#1-#5, #7, #9):
    const r23Ping = JSON.stringify({ jsonrpc: "2.0", id: 23, method: "ping" });
    const r23Frame = formatMcpResponse({ jsonrpc: "2.0", id: 23, method: "ping" }, "content-length");
    for (const ws of ["\r", "\v"]) {
      const m = [], e = [];
      const rdr = createFrameReader((msg) => m.push(msg), (err) => e.push(err.message));
      rdr(`Content-Length: ${Buffer.byteLength(r23Ping)}\r\nContent-Length${ws}: 999\r\n\r\n${r23Ping}`);
      assert.equal(m.length, 0);
      assert.equal(e.length > 0, true);
    }
    for (const badChunks of [
      [`Bad Header: ${"a".repeat(17000)}`, `\r\n${r23Frame}`],
      [`X_Bad: 1\r\n`, r23Frame],
    ]) {
      const m = [], e = [];
      const rdr = createFrameReader((msg) => m.push(msg), (err) => e.push(err.message));
      badChunks.forEach((c) => rdr(c));
      assert.equal(m.length, 0);
      assert.equal(e.length > 0, true);
    }
    for (const recChunks of [
      [`Content-Length: 7\r\nContent-Length: 999\r\n\r\n{"a":1}${r23Frame}`],
      [`Content-Length: 5\r\nContent-Length: 999\r\n\r\nhello\r\n${r23Frame}`],
      [`Content-Length: 7\r\nX-Huge: ${"a".repeat(17000)}\r\n\r\n{"a":1}`, r23Frame],
      [`Content-Length: 5\r\nX-Huge: ${"a".repeat(17000)}\r\nhello\r\n`, r23Frame],
    ]) {
      const m = [], e = [];
      const rdr = createFrameReader((msg) => m.push(msg.id), (err) => e.push(err.message));
      recChunks.forEach((c) => rdr(c));
      assert.deepEqual(m, [23]);
    }

    const r23FdDir = join(scratch, "r23-figmadiff");
    mkdirSync(join(r23FdDir, "dir"), { recursive: true });
    writeFileSync(join(r23FdDir, "tok.css"), ":root { --a: #111; }\n");
    writeFileSync(join(r23FdDir, "null.json"), "null");
    writeFileSync(join(r23FdDir, "arr.json"), "[]");
    for (const badFdArgs of [
      { tokens: join(r23FdDir, "tok.css"), figma: join(r23FdDir, "null.json") },
      { tokens: join(r23FdDir, "tok.css"), figma: join(r23FdDir, "arr.json") },
      { tokens: join(r23FdDir, "tok.css"), figma: join(r23FdDir, "dir") },
      { tokens: join(r23FdDir, "tok.css"), runtime: join(r23FdDir, "null.json") },
    ]) {
      const fdCall = dispatch({ jsonrpc: "2.0", id: 2304, method: "tools/call", params: { name: "dsaf_figma_diff", arguments: badFdArgs } });
      assert.equal(fdCall.result.isError, true);
    }

    const r23CiCache = join(scratch, "r23-ci-cache.json");
    try {
      process.env.CI = "true";
      delete process.env.DSAF_NO_UPDATE_CHECK;
      process.env.DSAF_UPDATE_CACHE = r23CiCache;
      const docCi = JSON.parse(
        dispatch({ jsonrpc: "2.0", id: 2305, method: "tools/call", params: { name: "dsaf_doctor", arguments: { target: docSubDir, offline: false } } }).result.content[0].text
      );
      assert.doesNotMatch(docCi.checks.find((c) => c.id === "cli_update_freshness").detail, /\(online\)/);
      assert.equal(existsSync(r23CiCache), false);
    } finally {
      if (prevUpCache === undefined) delete process.env.DSAF_UPDATE_CACHE;
      else process.env.DSAF_UPDATE_CACHE = prevUpCache;
      if (prevNoUp === undefined) delete process.env.DSAF_NO_UPDATE_CHECK;
      else process.env.DSAF_NO_UPDATE_CHECK = prevNoUp;
      if (prevCi === undefined) delete process.env.CI;
      else process.env.CI = prevCi;
    }

    const r23EscRepo = join(scratch, "r23-esc-mcp");
    mkdirSync(r23EscRepo, { recursive: true });
    const r23OutMcp = join(scratch, "r23-out-mcp.json");
    writeFileSync(r23OutMcp, '{"keep":1}');
    symlinkSync(r23OutMcp, join(r23EscRepo, ".mcp.json"));
    assert.throws(() => installMcpConfig({ cwd: r23EscRepo, scope: "project", agent: "claude", dryRun: false }), /escapes/i);
    assert.equal(readFileSync(r23OutMcp, "utf8"), '{"keep":1}');
    rmSync(join(r23EscRepo, ".mcp.json"));
    writeFileSync(join(r23EscRepo, ".mcp.json"), '{"mcpServers":[]}');
    assert.throws(() => installMcpConfig({ cwd: r23EscRepo, scope: "project", agent: "claude", dryRun: false }), /mcpServers/i);
    assert.equal(
      spawnSync(process.execPath, [fileURLToPath(import.meta.url), "install", "--dir", scratch, "--scope", "bogus", "--agent", "bogus", "--dry-run"], { encoding: "utf8" }).status,
      2
    );

    // Round 24 regressions (A1 H3, A1 M1, A4 M9):
    // 1. Chunk-split Content-Length / Content-Type / whitespace-prefixed inside >16KB rejected header stays rejected
    for (const [hdrPad, splitSecond] of [
      [`X-Pad: ${"a".repeat(17000)}\r\nContent-Len`, `gth: ${Buffer.byteLength(r23Ping)}\r\n\r\n${r23Ping}`],
      [`X-Pad: ${"a".repeat(17000)}\r\nContent-Ty`, `pe: application/vscode-jsonrpc\r\nContent-Length: ${Buffer.byteLength(r23Ping)}\r\n\r\n${r23Ping}`],
      [`X-Pad: ${"a".repeat(17000)}\r\n   `, `Content-Length: ${Buffer.byteLength(r23Ping)}\r\n\r\n${r23Ping}`],
    ]) {
      const m = [], e = [];
      const rdr = createFrameReader((msg) => m.push(msg.id), (err) => e.push(err.message));
      rdr(hdrPad);
      rdr(splitSecond);
      assert.equal(m.length, 0, "Smuggled split header inside >16KB block must never execute");
      assert.equal(e.length, 1);
    }

    // 2. Streamed >10MB NDJSON object emits 1 error; streamed >10MB array drops tail object
    {
      const m = [], e = [];
      const rdr = createFrameReader((msg) => m.push(msg.id), (err) => e.push(err.message));
      rdr(`{"jsonrpc":"2.0","id":1,"params":"${"a".repeat(10 * 1024 * 1024 + 64)}`);
      rdr("a".repeat(1024));
      rdr('"}\n');
      assert.equal(m.length, 0);
      assert.equal(e.length, 1, "Streamed >10MB NDJSON object must emit exactly 1 error");
    }
    {
      const m = [], e = [];
      const rdr = createFrameReader((msg) => m.push(msg.id), (err) => e.push(err.message));
      rdr(`[${" ".repeat(10 * 1024 * 1024 + 64)}`);
      rdr(`,\n{"jsonrpc":"2.0","id":77,"method":"tools/list"}\n]\n`);
      rdr(`{"jsonrpc":"2.0","id":78,"method":"ping"}\n`);
      assert.deepEqual(m, [78], "Array-tail frame smuggling must be blocked while subsequent valid NDJSON recovers");
      assert.equal(e.length, 1);
    }
    assert.equal(resolveMcpTargets({ agent: "claude", scope: "PROJECT", cwd: scratch })[0].scope, "project");

    // R29 (A1-M1): chunk-split malformed/oversized Content-Length header blocks before \r\n\r\n must reject and drop smuggled JSON body
    for (const [hdrChunk1, hdrChunk2] of [
      [`Content-Length: 999\r\nX-${"a".repeat(200)}: val`, `\r\n\r\n${r23Ping}`],
      ["Content-Length: 999\r\nfoo=bar", `\r\n\r\n${r23Ping}`],
      [`Content-Length: 999\r\n${"a".repeat(17000)}`, `\r\n\r\n${r23Ping}`],
    ]) {
      const m = [], e = [];
      const rdr = createFrameReader((msg) => m.push(msg.id), (err) => e.push(err.message));
      rdr(hdrChunk1);
      rdr(hdrChunk2);
      assert.equal(m.length, 0, "R29 A1-M1: chunk-split malformed Content-Length header must never execute smuggled JSON body");
      assert.ok(e.length >= 1, "R29 A1-M1: chunk-split malformed Content-Length header must emit rejection error");
    }

    // R30 (A1-M1): live leaf symlinks at MCP config targets must be rejected in project, user, and --dir scopes (both dryRun and apply)
    {
      const r30Proj = join(scratch, "r30-mcp-proj");
      const r30Home = join(scratch, "r30-mcp-home");
      const r30Dir = join(scratch, "r30-mcp-dir");
      mkdirSync(r30Proj, { recursive: true });
      mkdirSync(r30Home, { recursive: true });
      mkdirSync(r30Dir, { recursive: true });
      const r30Shared = join(r30Proj, "shared.json");
      const r30Outside = join(scratch, "r30-outside-secret.json");
      const r30DirVictim = join(scratch, "r30-dir-victim.json");
      writeFileSync(r30Shared, '{"keep":"shared"}\n');
      writeFileSync(r30Outside, '{"keep":"outside"}\n');
      writeFileSync(r30DirVictim, '{"keep":"dir"}\n');
      symlinkSync(r30Shared, join(r30Proj, ".mcp.json"));
      symlinkSync(r30Outside, join(r30Home, ".claude.json"));
      symlinkSync(r30DirVictim, join(r30Dir, "custom-mcp.json"));
      for (const dr of [true, false]) {
        assert.throws(
          () => installMcpConfig({ agent: "claude", scope: "project", cwd: r30Proj, dryRun: dr }),
          /symlinked MCP config target/i
        );
        assert.throws(
          () => installMcpConfig({ agent: "claude", scope: "user", home: r30Home, dryRun: dr }),
          /symlinked MCP config target/i
        );
        assert.throws(
          () => installMcpConfig({ dir: join(r30Dir, "custom-mcp.json"), dryRun: dr }),
          /symlinked MCP config target/i
        );
      }
      assert.equal(readFileSync(r30Shared, "utf8"), '{"keep":"shared"}\n');
      assert.equal(readFileSync(r30Outside, "utf8"), '{"keep":"outside"}\n');
      assert.equal(readFileSync(r30DirVictim, "utf8"), '{"keep":"dir"}\n');
    }

    // R31 (A1-L1): >16KB header blocks with colonless break line behave identically across 1-chunk and multi-chunk boundaries
    {
      const r31Msg = JSON.stringify({ jsonrpc: "2.0", id: 931, method: "ping" });
      const r31ValidFrame = `Content-Length: ${Buffer.byteLength(r31Msg, "utf8")}\r\n\r\n${r31Msg}`;
      const r31ColonlessPayload = `X-Pad: ${"a".repeat(17000)}\r\nBadColonless\r\n${r31ValidFrame}`;
      const cutBeforeBreak = r31ColonlessPayload.indexOf("BadColonless");
      const cutAfterBreak = r31ColonlessPayload.indexOf("\r\n", cutBeforeBreak) + 2;
      for (const chunks of [
        [r31ColonlessPayload],
        [r31ColonlessPayload.slice(0, cutBeforeBreak), r31ColonlessPayload.slice(cutBeforeBreak)],
        [r31ColonlessPayload.slice(0, cutAfterBreak), r31ColonlessPayload.slice(cutAfterBreak)],
      ]) {
        const m = [], e = [];
        const rdr = createFrameReader((msg) => m.push(msg.id), (err) => e.push(err.message));
        for (const ch of chunks) rdr(ch);
        assert.deepEqual(m, [931], "R31 A1-L1: colonless line after >16KB header must allow valid frame resync identically across chunk splits");
        assert.equal(e.length, 1);
      }

      const r31ContPayload = `X-Pad: ${"a".repeat(17000)}\r\n${r31ValidFrame}`;
      const contCut = 16500;
      for (const chunks of [
        [r31ContPayload],
        [r31ContPayload.slice(0, contCut), r31ContPayload.slice(contCut)],
      ]) {
        const m = [], e = [];
        const rdr = createFrameReader((msg) => m.push(msg.id), (err) => e.push(err.message));
        for (const ch of chunks) rdr(ch);
        assert.deepEqual(m, [], "R31 A1-L1: contiguous >16KB header without colonless break must still reject frame");
        assert.equal(e.length, 1);
      }
    }

    // R33 (A1-M1 & A1-L4): discarded \n-terminated header chunks must advance buf & reject invalid codeConnect/null tokens
    {
      const r33Msg = JSON.stringify({ jsonrpc: "2.0", id: 933, method: "ping" });
      const r33Valid = `Content-Length: ${Buffer.byteLength(r33Msg, "utf8")}\r\n\r\n${r33Msg}`;
      const r33Out = [], r33Errs = [];
      const r33Rdr = createFrameReader((msg) => r33Out.push(msg.id), (err) => r33Errs.push(err.message));
      r33Rdr(`X-Pad: ${"a".repeat(17000)}\r\n`);
      for (let ci = 0; ci < 25; ci++) {
        r33Rdr(`X-Chunk-${ci}: ${"b".repeat(40000)}\r\n`);
      }
      r33Rdr(`\r\n${r33Valid}`);
      assert.deepEqual(r33Out, [933], "R33 A1-M1: many \\r\\n-terminated oversized header chunks must drain cleanly and parse subsequent frame");
      assert.equal(r33Errs.length, 1);

      const nullTok = join(scratch, "null-tokens.json");
      const validRt = join(scratch, "valid-runtime.json");
      const notADir = join(scratch, "regular-cc.txt");
      writeFileSync(nullTok, "null\n");
      writeFileSync(validRt, JSON.stringify({ schema: "dsaf-pw/1", allPassed: true, files: [] }));
      writeFileSync(notADir, "not a directory\n");
      const ccFileRes = dispatch({
        jsonrpc: "2.0",
        id: 934,
        method: "tools/call",
        params: { name: "dsaf_figma_diff", arguments: { tokens: validRt, runtime: validRt, codeConnect: notADir } },
      });
      assert.equal(ccFileRes.result?.isError, true, "R33 A1-L4: dsaf_figma_diff must reject regular file for codeConnect");
      assert.match(ccFileRes.result?.content?.[0]?.text || "", /existing directory/i);
      const nullTokRes = dispatch({
        jsonrpc: "2.0",
        id: 935,
        method: "tools/call",
        params: { name: "dsaf_figma_diff", arguments: { tokens: nullTok, runtime: validRt } },
      });
      assert.equal(nullTokRes.result?.isError, true, "R33 A1-L4: dsaf_figma_diff must fail cleanly on JSON null tokens");
      assert.doesNotMatch(nullTokRes.result?.content?.[0]?.text || "", /Cannot read properties of null/i);
    }

    // R36 (R35-A1-M1): >128-char header names split before Content-Length must reject in both 1-chunk and multi-chunk delivery
    {
      const ping1 = JSON.stringify({ jsonrpc: "2.0", id: 936, method: "ping" });
      const tail1 = `\r\nContent-Length: ${Buffer.byteLength(ping1, "utf8")}\r\n\r\n${ping1}`;
      const longHdr = "X-" + "a".repeat(200) + ": " + "b".repeat(17000);
      const shortBadHdr = "X-" + "a".repeat(200) + ": v";
      const pingValidNext = JSON.stringify({ jsonrpc: "2.0", id: 937, method: "ping" });
      const validNextFrame = `Content-Length: ${Buffer.byteLength(pingValidNext, "utf8")}\r\n\r\n${pingValidNext}`;
      for (const chunks of [
        [longHdr + tail1],
        [longHdr, tail1, validNextFrame],
        [shortBadHdr + tail1],
        [shortBadHdr + "\r\n", `Content-Length: ${Buffer.byteLength(ping1, "utf8")}\r\n\r\n${ping1}`, validNextFrame],
      ]) {
        const outIds = [];
        const errs = [];
        const rdr = createFrameReader((msg) => outIds.push(msg.id), (err) => errs.push(err.message));
        for (const ch of chunks) rdr(ch);
        assert.equal(outIds.includes(936), false, "R36 A1-M1: malformed/oversized >128-char header must reject smuggled frame across chunks");
        assert.ok(errs.length >= 1, "R36 A1-M1: must emit header rejection error");
        if (chunks.length > 1) {
          assert.deepEqual(outIds, [937], "R36 A1-M1: subsequent clean Content-Length frame must recover");
        }
      }

      // Round 39 (R38-A1-M1 >16KB unterminated header followed by JSON line in same chunk must recover next Content-Length frame):
      for (const prefixHdr of [
        "Content-Length: 40\r\nX-Pad: " + "a".repeat(17000) + "\n",
        "X-Pad: " + "a".repeat(17000) + "\n",
        "X-Pad: " + "a".repeat(17000) + "\n  ",
      ]) {
        const outIds = [];
        const errs = [];
        const rdr = createFrameReader((msg) => outIds.push(msg.id), (err) => errs.push(err.message));
        rdr(prefixHdr + ping1 + "\n");
        rdr(validNextFrame);
        assert.ok(errs.length >= 1, "R39 A1-M1: oversized unterminated header + JSON line must emit error");
        assert.deepEqual(outIds, [937], "R39 A1-M1: subsequent valid Content-Length frame must be delivered cleanly");

        const outUnterm = [];
        const errUnterm = [];
        const rdr2 = createFrameReader((msg) => outUnterm.push(msg.id), (err) => errUnterm.push(err.message));
        rdr2(prefixHdr + ping1);
        rdr2("\n" + validNextFrame);
        assert.ok(errUnterm.length >= 1, "R39 A1-M1: unterminated JSON line after >16KB header must still emit error");
        assert.deepEqual(outUnterm, [937], "R39 A1-M1: subsequent valid Content-Length frame after unterminated JSON line must recover");
      }
    }

    // Round 40 (R39-A1-M1 custom/malformed header suffixes, R39-A1-M2 >10MB resync lock, R39-A1-L1 blank whitespace lines):
    {
      const p40 = JSON.stringify({ jsonrpc: "2.0", id: 9400, method: "ping" });
      const p40Ok = JSON.stringify({ jsonrpc: "2.0", id: 9401, method: "ping" });
      const okFrame40 = `Content-Length: ${Buffer.byteLength(p40Ok, "utf8")}\r\n\r\n${p40Ok}`;
      for (const hName of ["X-Content-Length", "X_BadContent-Length", "X-Original-Content-Length"]) {
        const m1 = [], e1 = [];
        const r1 = createFrameReader((m) => m1.push(m.id), (e) => e1.push(e.message));
        r1(Buffer.from(`X-Pad: ${"a".repeat(17000)}\r\n${hName}: ${Buffer.byteLength(p40)}\r\n\r\n${p40}`));
        r1(Buffer.from("\n" + okFrame40));
        assert.deepEqual(m1, [9401], `R40 M1 (1-chunk ${hName}): smuggled header must drop and trailing valid frame recover`);
        assert.equal(e1.length, 1);

        const m2 = [], e2 = [];
        const r2 = createFrameReader((m) => m2.push(m.id), (e) => e2.push(e.message));
        r2(Buffer.from(`X-Pad: ${"a".repeat(17000)}\r\n`));
        r2(Buffer.from(`${hName}: ${Buffer.byteLength(p40)}\r\n\r\n${p40}`));
        r2(Buffer.from("\n" + okFrame40));
        assert.deepEqual(m2, [9401], `R40 M1 (2-chunk ${hName}): smuggled header must drop and trailing valid frame recover`);
        assert.equal(e2.length, 1);

        const mE = [], eE = [];
        const rE = createFrameReader((m) => mE.push(m.id), (e) => eE.push(e.message));
        rE(Buffer.from("Content-Length: 20000000\r\n\r\n"));
        rE(Buffer.from(`garbage ${hName}: ${Buffer.byteLength(p40)}\r\n\r\n${p40}\n${okFrame40}`));
        assert.deepEqual(mE, [9401], `R40 M1 (resync ${hName}): inline spoofed header must drop and newline-aligned frame recover`);
        assert.equal(eE.length, 1);
      }

      const m10 = [], e10 = [];
      const r10 = createFrameReader((m) => m10.push(m.id), (e) => e10.push(e.message));
      r10(Buffer.from("Content-Length: 20000000\r\n\r\n", "utf8"));
      r10(Buffer.alloc(10 * 1024 * 1024 + 64, 0x61));
      r10(Buffer.from(`${p40}\n`, "utf8"));
      r10(Buffer.from(okFrame40, "utf8"));
      assert.deepEqual(m10, [9401], "R40 M2: >10MB discarded body must remain in header-resync so trailing NDJSON is dropped until Content-Length:");
      assert.equal(e10.length, 2);

      const mWsA = [], eWsA = [];
      const rWsA = createFrameReader((m) => mWsA.push(m.id), (e) => eWsA.push(e.message));
      rWsA(Buffer.from("  \n"));
      rWsA(Buffer.from(okFrame40));
      assert.deepEqual(mWsA, [9401]);
      assert.deepEqual(eWsA, []);

      const mWsB = [], eWsB = [];
      const rWsB = createFrameReader((m) => mWsB.push(m.id), (e) => eWsB.push(e.message));
      rWsB(Buffer.from(okFrame40));
      rWsB(Buffer.from("  \n"));
      rWsB(Buffer.from(okFrame40));
      assert.deepEqual(mWsB, [9401, 9401], "R40 L1: whitespace-only blank line after content-length frame must not break next frame");
      assert.deepEqual(eWsB, []);

      const mWsC = [], eWsC = [];
      const rWsC = createFrameReader((m) => mWsC.push(m.id), (e) => eWsC.push(e.message));
      rWsC(Buffer.from("  \n" + okFrame40));
      assert.deepEqual(mWsC, [9401], "R40 L1: leading whitespace-only blank line in single chunk must not break frame");
      assert.deepEqual(eWsC, []);

      const mWsBad = [], eWsBad = [];
      const rWsBad = createFrameReader((m) => mWsBad.push(m.id), (e) => eWsBad.push(e.message));
      rWsBad(Buffer.from("  " + okFrame40));
      assert.deepEqual(mWsBad, [], "Leading horizontal spaces on actual header line must still reject");
      assert.equal(eWsBad.length, 1);
    }

    console.log("DSAF_MCP_SELF_TEST_PASSED (8 tools + Content-Length & NDJSON framing + mcp install)");
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

const isEntrypoint = Boolean(process.argv[1]) && canonPath(process.argv[1]) === canonPath(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        agent: { type: "string" },
        scope: { type: "string" },
        dir: { type: "string" },
        cwd: { type: "string" },
        pin: { type: "boolean", default: false },
        tag: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "self-test": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (values.help) {
      console.log(
        [
          `DSAF v${MCP_SERVER_VERSION} — Stdio MCP Server & Installer`,
          "Usage:",
          "  dsaf mcp                          Run JSON-RPC 2.0 stdio MCP server (8 audit & dry-run tools)",
          "  dsaf mcp install [--agent claude|cursor|codex|antigravity|all] [--scope project|user] [--dir <path>] [--cwd <dir>] [--pin|--tag <ver>] [--dry-run] [--json] [--help]",
          "  dsaf mcp --self-test",
        ].join("\n")
      );
      process.exit(0);
    }
    if (values["self-test"]) {
      process.exit(runSelfTest());
    }
    if (positionals[0] === "install") {
      if (positionals.length > 1) {
        console.error(
          `Unexpected argument '${positionals[1]}' for 'dsaf mcp install'. Use --cwd <dir> for project scope or --dir <path> for custom config directory.`
        );
        process.exit(2);
      }
      if (values.tag !== undefined && values.tag.trim().length === 0) {
        throw new Error("Parameter '--tag' must be a non-empty version or dist-tag.");
      }
      const results = installMcpConfig({
        agent: values.agent ?? "claude",
        scope: values.scope ?? "project",
        dir: values.dir,
        cwd: values.cwd !== undefined ? values.cwd : process.cwd(),
        pin: Boolean(values.pin),
        packageTag: values.tag !== undefined ? values.tag : undefined,
        dryRun: values["dry-run"],
      });
      if (values.json) {
        process.stdout.write(JSON.stringify({ schema: "dsaf-mcp-install/1", results }, null, 2) + "\n");
      } else {
        for (const r of results) {
          console.log(`${r.dryRun ? "[DRY-RUN] " : ""}Configured DSAF MCP (${r.agent}/${r.scope}) -> ${r.path}`);
        }
        console.log("DSAF_MCP_INSTALL_COMPLETE");
      }
      process.exit(0);
    }
    if (positionals.length > 0) {
      console.error(`Unknown mcp subcommand '${positionals[0]}'. Run without arguments for stdio MCP, or 'dsaf mcp install'.`);
      process.exit(2);
    }
    const installOnlyFlags = [];
    if (values.agent !== undefined) installOnlyFlags.push("--agent");
    if (values.scope !== undefined) installOnlyFlags.push("--scope");
    if (values.dir !== undefined) installOnlyFlags.push("--dir");
    if (values.cwd !== undefined) installOnlyFlags.push("--cwd");
    if (values.pin) installOnlyFlags.push("--pin");
    if (values.tag !== undefined) installOnlyFlags.push("--tag");
    if (values["dry-run"]) installOnlyFlags.push("--dry-run");
    if (values.json) installOnlyFlags.push("--json");
    if (installOnlyFlags.length > 0) {
      console.error(
        `Install-only flag(s) (${installOnlyFlags.join(", ")}) require the 'install' subcommand: dsaf mcp install ...`
      );
      process.exit(2);
    }
    runStdioServer();
  } catch (err) {
    console.error("ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
