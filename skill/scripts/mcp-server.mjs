#!/usr/bin/env node
/**
 * DSAF v0.8.0 — Zero-Dependency Stdio MCP Server (`dsaf mcp`).
 * Exposes 8 read-only audit tools over JSON-RPC 2.0 stdio (supporting both
 * Content-Length LSP framing and newline-delimited JSON-RPC messages).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyzeDirectory } from "./recon.mjs";
import { scanTarget } from "./audit-tokens.mjs";
import { runDoctor } from "./doctor.mjs";
import { checkTarget } from "./dsaf-hook.mjs";
import { compareDefinedToShipped, compareVertices } from "./audit-figma-diff.mjs";
import { runAuditPipeline } from "./audit-pipeline.mjs";
import { planFloorFixes } from "./fix-floor.mjs";
import { readGovernanceStatus } from "./evolve-runner.mjs";

export const MCP_SERVER_VERSION = "0.8.0";
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
    description: "Run setup health diagnostics for hooks, guardrails, tokens, and DSAF prerequisites.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target workspace directory." },
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
        tier: { type: "string", enum: ["floor", "reflex", "all"], description: "Minimum severity tier." },
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
        maxFiles: { type: "number", description: "Optional maximum files budget." },
        ignoreProtected: { type: "boolean", description: "Include protectedFiles in preview." },
        dsCss: { type: "array", items: { type: "string" }, description: "Optional external DS stylesheet paths." },
      },
      required: ["target"],
    },
  },
  {
    name: "dsaf_evolve_status",
    description: "Read-only status check for .dsaf/ auto-evolution governance (kill switch, circuit breaker, budgets, and gates).",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target repository directory." },
      },
      required: ["target"],
    },
  },
];

function executeTool(name, args = {}) {
  switch (name) {
    case "dsaf_recon":
      return analyzeDirectory(resolve(args.target || "."));
    case "dsaf_tokens":
      return scanTarget(resolve(args.target || "."), {
        scope: args.scope || undefined,
        includeDemos: Boolean(args.includeDemos),
        reportUnusedIgnores: Boolean(args.reportUnusedIgnores),
      });
    case "dsaf_doctor":
      return runDoctor(resolve(args.target || "."));
    case "dsaf_hook_check":
      return checkTarget(resolve(args.target || "."), {
        tier: args.tier || "floor",
        reportUnusedIgnores: Boolean(args.reportUnusedIgnores),
      });
    case "dsaf_figma_diff": {
      if (!args.tokens) throw new Error("Parameter 'tokens' is required.");
      if (args.figma) {
        return compareVertices({
          figmaPath: args.figma,
          tokensArg: args.tokens,
          codeConnectDir: args.codeConnect || null,
          runtimePath: args.runtime || null,
          prefix: args.prefix || null,
        });
      }
      if (args.runtime) {
        return compareDefinedToShipped({
          tokensArg: args.tokens,
          runtimePath: args.runtime,
          codeConnectDir: args.codeConnect || null,
          prefix: args.prefix || null,
        });
      }
      throw new Error("Either 'figma' (3-vertex) or 'runtime' (2-vertex) must be supplied.");
    }
    case "dsaf_audit":
      return runAuditPipeline({
        target: args.target || ".",
        scope: args.scope || undefined,
        figmaPath: args.figmaPath || undefined,
        outDir: args.outDir || undefined,
      });
    case "dsaf_fix_preview": {
      const plan = planFloorFixes(resolve(args.target || "."), {
        rules: Array.isArray(args.rule) ? args.rule : undefined,
        maxFiles: typeof args.maxFiles === "number" ? args.maxFiles : undefined,
        ignoreProtected: Boolean(args.ignoreProtected),
        dsCss: Array.isArray(args.dsCss) ? args.dsCss : undefined,
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
    case "dsaf_evolve_status":
      return readGovernanceStatus(resolve(args.target || "."));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function createMcpDispatcher() {
  return function dispatchMessage(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || !msg.method) {
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
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: TOOL_DEFINITIONS },
      };
    }

    if (msg.method === "tools/call") {
      const toolName = msg.params?.name;
      const toolArgs = msg.params?.arguments || {};
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

export function createFrameReader(onMessage) {
  let buf = Buffer.alloc(0);
  let detectedMode = null;

  return function pushChunk(chunk) {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")]);
    while (buf.length > 0) {
      const strPrefix = buf.slice(0, Math.min(buf.length, 64)).toString("utf8");
      if (/^\s*Content-Length\s*:/i.test(strPrefix)) {
        detectedMode = "content-length";
        const sepIdx = buf.indexOf("\r\n\r\n");
        const lfSepIdx = sepIdx === -1 ? buf.indexOf("\n\n") : sepIdx;
        if (lfSepIdx === -1) break;
        const sepLen = sepIdx !== -1 ? 4 : 2;
        const headerText = buf.slice(0, lfSepIdx).toString("utf8");
        const lenMatch = headerText.match(/Content-Length\s*:\s*(\d+)/i);
        if (!lenMatch) {
          buf = buf.slice(lfSepIdx + sepLen);
          continue;
        }
        const bodyLen = Number.parseInt(lenMatch[1], 10);
        const totalNeed = lfSepIdx + sepLen + bodyLen;
        if (buf.length < totalNeed) break;
        const bodyStr = buf.slice(lfSepIdx + sepLen, totalNeed).toString("utf8");
        buf = buf.slice(totalNeed);
        onMessage(JSON.parse(bodyStr), "content-length");
        continue;
      }

      const nlIdx = buf.indexOf("\n");
      if (nlIdx === -1) break;
      const line = buf.slice(0, nlIdx).toString("utf8").trim();
      buf = buf.slice(nlIdx + 1);
      if (!line) continue;
      if (!detectedMode) detectedMode = "ndjson";
      onMessage(JSON.parse(line), "ndjson");
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

function runStdioServer() {
  const dispatch = createMcpDispatcher();
  const push = createFrameReader((msg, mode) => {
    const res = dispatch(msg);
    if (res) {
      process.stdout.write(formatMcpResponse(res, mode));
    }
  });
  process.stdin.on("data", (chunk) => {
    try {
      push(chunk);
    } catch (err) {
      const errResp = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: err instanceof Error ? err.message : "Parse error" },
      };
      process.stdout.write(formatMcpResponse(errResp, "ndjson"));
    }
  });
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
        JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "dsaf_doctor", arguments: { target: scratch } } }),
        JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "dsaf_figma_diff", arguments: { tokens: join(scratch, "src"), runtime: runtimeJson } } }),
        JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "dsaf_fix_preview", arguments: { target: join(scratch, "src") } } }),
        JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "dsaf_evolve_status", arguments: { target: scratch } } }),
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

    const evoRes = JSON.parse(JSON.parse(responses[7]).result.content[0].text);
    assert.equal(evoRes.initialized, false);
    assert.equal(evoRes.status, "uninitialized");

    const unknownRes = JSON.parse(responses[8]);
    assert.equal(unknownRes.error.code, -32601);

    console.log("DSAF_MCP_SELF_TEST_PASSED (8 tools + Content-Length & NDJSON framing)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === resolve(decodeURIComponent(new URL(import.meta.url).pathname));
if (isEntrypoint) {
  const { values } = parseArgs({
    options: {
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: dsaf mcp [--self-test]\nRuns the zero-dependency JSON-RPC 2.0 stdio MCP server exposing 8 read-only DSAF tools.");
    process.exit(0);
  }
  if (values["self-test"]) {
    process.exit(runSelfTest());
  }
  runStdioServer();
}
