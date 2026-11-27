#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Deterministic Multi-Axis Persona Matrix Generator (`dsaf personas`).
 * Derives uncapped, signal-driven orthogonal personas, merges unlimited custom
 * domain personas (`.dsaf/personas.custom.json` or `--custom <file>`), and binds
 * cognitive walkthrough checklists + T2 synthetic edge datasets from read-only recon.
 * Zero external dependencies.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertWritableOutputFile, isDirectCliEntry } from "./ci-report.mjs";
import { analyzeDirectory } from "./recon.mjs";

export const PERSONAS_VERSION = "0.9.3";

export const COGNITIVE_WALKTHROUGH_QUESTIONS = [
  "Does the persona know what to do next from visible cues alone?",
  "Can they notice and reach the primary control without source knowledge?",
  "Can they predict what the control does before activating it?",
  "After interacting, does immediate feedback match their expectation?",
  "If an error, delay, or empty state happens, can they recover safely?",
];

export const SYNTHETIC_EDGE_DATASETS = [
  { id: "empty_0", label: "Zero items / first-run empty state", verify: "Actionable guidance, zero broken chart/table frame" },
  { id: "minimal_1", label: "Single item baseline", verify: "Balanced spacing, no singular/plural grammar glitch" },
  { id: "heavy_100_plus", label: "100+ items / paginated dense load", verify: "Filter, sort, virtualize/paginate without UI freeze" },
  { id: "diacritics_long_strings", label: ">60-char tokens & stacked diacritics (e.g. Ổ, Ẫ)", verify: "No clipped line-height accents, ellipsis or wrap cleanly" },
  { id: "fault_injection_422_500_offline", label: "3s slow network, 401/422/500 & offline faults", verify: "Preserves unsaved input, clear recovery action" },
];

function buildBaselinePersonas(stackSummary) {
  return [
    {
      source: "signal:baseline",
      name: "First-Time Visitor (Cold Arrival)",
      axis: "Onboarding & Information Architecture",
      basis: "Zero prior domain/repo familiarity; arrives on initial entry view",
      device: "Desktop 1440x900",
      viewport: "1440x900",
      network: "Normal Broadband",
      assistive: "Standard pointer & eye scan",
      goal: "Understand core value within 15s and complete first meaningful action",
      expectations: ["Clear visual hierarchy", "Self-explanatory labels", "Safe undoable first action"],
      failureModes: ["Industry jargon in headings", "Hidden primary CTA below oversized chrome", "Dead-end empty states"],
    },
    {
      source: "signal:baseline",
      name: "Keyboard-Only Power User",
      axis: "Keyboard Navigation & Focus Discipline",
      basis: "Operates exclusively with Tab / Shift+Tab / Enter / Space / Escape / Arrows",
      device: `Desktop (${stackSummary})`,
      viewport: "1280x800",
      network: "Fast",
      assistive: "No mouse; relies on visible :focus-visible ring & skip links",
      goal: "Navigate, open dialogs/menus, submit forms, and escape overlays without trapping focus",
      expectations: ["Logical DOM tab order", "Visible >= 2px focus indicator", "Consistent Escape dismissal"],
      failureModes: ["outline: none without focus-visible", "Focus trapped or lost on dialog close", "Unclickable clickable <div>"],
    },
    {
      source: "signal:baseline",
      name: "Mobile Commuter (390px One-Handed + 3G)",
      axis: "Responsive Layout & Touch Ergonomics",
      basis: "Thumb-zone navigation on constrained smartphone width & high latency",
      device: "Mobile 390x844 (Touch)",
      viewport: "390x844",
      network: "Slow 3G (400ms RTT)",
      assistive: "Touchscreen tap >= 44px",
      goal: "Scan summary cards, switch tabs, and submit without pinching or horizontal scroll",
      expectations: ["Header under 32% viewport", "Touch targets >= 44px", "No horizontal overflow or truncated pills"],
      failureModes: ["Multi-row bloated mobile header", "Sub-44px icon controls", "Tables clipped on right edge"],
    },
    {
      source: "signal:baseline",
      name: "Low-Vision & Reduced-Motion Reader",
      axis: "Contrast, Zoom 200% & Motion Sensitivity",
      basis: "System Dark Mode + prefers-reduced-motion + browser 200% zoom",
      device: "Desktop 720p Effective Zoom",
      viewport: "720x900",
      network: "Normal",
      assistive: "High contrast needs (APCA Lc >= 65) + Reduced Motion",
      goal: "Read primary and secondary copy comfortably with zero strobe or zoom clipping",
      expectations: ["WCAG 2.2 AA & APCA contrast", "Zero text clipped on zoom", "Non-essential motion disabled"],
      failureModes: ["Muted grey failing dark mode contrast", "Low-contrast button borders (<3:1)", "Fixed sticky headers covering zoomed headings"],
    },
    {
      source: "signal:baseline",
      name: "International / Heavy-Data Stress User",
      axis: "Localization Diacritics & Scale Resilience",
      basis: "Tests >60-char identifiers, stacked Vietnamese/CJK diacritics, and large counts",
      device: "Desktop / Tablet Split",
      viewport: "768x1024",
      network: "Normal",
      assistive: "Standard",
      goal: "Review long names, dense tables, and multi-line labels with zero overlap or truncation bugs",
      expectations: ["Top diacritics (Ổ, Ẫ) unclipped", "Readable tabular numbers", "Graceful word wrapping"],
      failureModes: ["Crushed pill badges wrapping into narrow ovals", "Fixed-height containers clipping accents", "Unbounded table cell overflow"],
    },
  ];
}

function buildSignalPersonas(recon, depth) {
  const mode = recon.recommendedMode || "P";
  const surface = recon.surfaceMode || "persuade";
  const routesCount =
    typeof recon.counts?.appRoutes === "number"
      ? recon.counts.appRoutes
      : Array.isArray(recon.samples?.appRoutes)
      ? recon.samples.appRoutes.length
      : 0;
  const uiFiles =
    typeof recon.counts?.components === "number" || typeof recon.counts?.styleFiles === "number"
      ? (recon.counts?.components || 0) + (recon.counts?.styleFiles || 0)
      : Number(recon.filesScanned?.uiAndStyle || 0);
  const cssTokenFiles =
    typeof recon.counts?.cssTokenFiles === "number"
      ? recon.counts.cssTokenFiles
      : Number(recon.filesScanned?.cssTokenFiles || 0);
  const dtcgFiles =
    typeof recon.counts?.tokenJsonFiles === "number"
      ? recon.counts.tokenJsonFiles
      : Number(recon.filesScanned?.tokenJson || 0);
  const hasStorybook = Boolean(recon.stack?.hasStorybook) || Number(recon.counts?.stories || 0) > 0;
  const frameworks = (recon.stack?.frameworks || []).map((f) => String(f).toLowerCase());
  const isDeep = depth === "deep";
  const isAuto = depth === "auto";

  const out = [];
  const signalsMatched = [];
  const push = (signalTag, persona) => {
    signalsMatched.push(signalTag);
    out.push({ source: signalTag, ...persona });
  };

  if (mode === "S") {
    push("signal:mode_s_consumer", {
      name: "Downstream Product Engineer",
      axis: "DS Consumer DX & Copy-Paste Adoption",
      basis: "Installs package tokens/CSS and builds a form + table screen under deadline",
      device: "Desktop IDE + Docs",
      viewport: "1440x900",
      network: "Normal",
      assistive: "Standard",
      goal: "Copy install/token examples and compose components without style overrides",
      expectations: ["Accurate CLI/CSS imports", "Zero conflicting specificity", "Live theme switching in examples"],
      failureModes: ["Stale CLI commands in docs", "Orphan or undocumented semantic tokens", "Requires !important overrides"],
    });
    push("signal:mode_s_tokens", {
      name: "Design Token & Theme Maintainer",
      axis: "Token Architecture & Cross-Theme Parity",
      basis: `Audits ${dtcgFiles} DTCG / ${cssTokenFiles} token stylesheets against Storybook states`,
      device: "Desktop Dual Theme",
      viewport: "1440x900",
      network: "Normal",
      assistive: "Color-blind simulation & contrast checker",
      goal: "Verify Light/Dark symmetry and zero hardcoded color leaks",
      expectations: ["Matched Light/Dark keys", "Valid 3:1 control borders", "Zero primitive leaks"],
      failureModes: ["Border color below 3:1", "Theme drift between DTCG and runtime CSS", "Missing dark showcase"],
    });
    push("signal:mode_s_aria", {
      name: "Accessibility Compliance Auditor",
      axis: "ARIA Contract & Base Primitives",
      basis: "Verifies role/aria-pressed/aria-expanded states and screen-reader announcements",
      device: "Desktop + Screen Reader",
      viewport: "1280x800",
      network: "Normal",
      assistive: "Screen reader + axe-core",
      goal: "Confirm composite widgets (Combobox, Dialog, Tabs, Slider) announce state changes accurately",
      expectations: ["Every interactive control has accessible name", "Status banners use role=status/alert", "Scrollable code/tables keyboard-focusable"],
      failureModes: ["Scrollable <pre> missing tabindex=0", "Unnamed icon button", "Broken focus restoration"],
    });
  }

  if (mode === "C") {
    push("signal:mode_c_drift", {
      name: "DS Conformance & Drift Reviewer",
      axis: "Design System Conformance & Override Discipline",
      basis: "Detects N-of-1 custom buttons, raw hex literals, and !important drift against DS packages",
      device: "Desktop + DevTools",
      viewport: "1440x900",
      network: "Normal",
      assistive: "Standard",
      goal: "Replace ad-hoc styles with semantic DS tokens and canonical primitives",
      expectations: ["High token compliance", "Low N-of-1 variant sprawl", "Zero brittle CSS overrides"],
      failureModes: ["Hardcoded hex overrides breaking dark mode", "Inconsistent button radii/heights", "Shadowed focus styles"],
    });
  }

  if (recon.t2MockRequired || surface === "operate") {
    push("signal:operate_returning", {
      name: "Frequent Returning Operator",
      axis: "Repeat Workflow Speed & State Retention",
      basis: "Performs high-frequency create/filter/update loops daily",
      device: "Desktop 1440x900",
      viewport: "1440x900",
      network: "Normal",
      assistive: "Keyboard shortcuts + mouse",
      goal: "Filter records, inspect status deltas, and apply safe updates with minimal clicks",
      expectations: ["Predictable shortcuts", "Clear diff feedback", "Zero destructive surprise"],
      failureModes: ["Silent state resets", "Unrecoverable accidental submits", "Missing loading/disabled guard"],
    });
    push("signal:fault_resilience", {
      name: "Spotty-Network & Fault Recovery User",
      axis: "Error Tolerance & T2-Mock Resilience",
      basis: "Encounters 401/422 validation errors, timeouts, or offline drops mid-form",
      device: "Mobile 390x844",
      viewport: "390x844",
      network: "Intermittent Offline / 500s",
      assistive: "Touchscreen",
      goal: "Understand why an action failed and retry without re-typing everything",
      expectations: ["Inline field validation with min-height: 1lh", "Retained draft inputs", "Explicit retry path"],
      failureModes: ["Generic toast without guidance", "Layout shift on validation text", "Silently dropped mutations"],
    });
    push("signal:auth_boundary", {
      name: "Permission-Constrained / Guest Reviewer",
      axis: "Auth Boundary & Read-Only Safety",
      basis: "Visits protected routes or triggers actions without admin privileges",
      device: "Desktop 1280x800",
      viewport: "1280x800",
      network: "Normal",
      assistive: "Standard",
      goal: "Safely explore read-only views and receive clear guidance where elevation is needed",
      expectations: ["Clear read-only indicators", "Clean auth redirects", "Zero misleading editable affordances"],
      failureModes: ["Confusing 403 crashes", "Ambiguous disabled buttons with no reason"],
    });
  }

  if (routesCount >= 3 || isDeep) {
    push("signal:multi_route", {
      name: "Deep-Link & Browser Navigation User",
      axis: "URL State, Deep Links & Back/Forward Recovery",
      basis: `Navigates across ${routesCount || "multiple"} routes, reloads mid-flow, and shares filtered URLs`,
      device: "Desktop & Mobile Split",
      viewport: "1280x800",
      network: "Normal",
      assistive: "Browser Back/Forward + Bookmark URL",
      goal: "Land directly on a deep URL or refresh mid-workflow without losing context or filters",
      expectations: ["URL reflects active tab/filter/view", "Reload preserves state", "Predictable Back navigation"],
      failureModes: ["Ephemeral React state wiped on reload", "Broken anchor links", "Modal swallowing Back button"],
    });
  }

  if (mode !== "S" && (surface === "operate" || frameworks.length > 0 || isDeep)) {
    push("signal:forms_autofill", {
      name: "Form-Error & Browser Autofill User",
      axis: "Form Validation, Labels & Autofill Ergonomics",
      basis: "Fills multi-field flows using password managers, browser autofill, or mobile keyboards",
      device: "Mobile 390x844 / Desktop",
      viewport: "390x844",
      network: "Normal",
      assistive: "Browser Autofill + Virtual Keyboard",
      goal: "Complete inputs swiftly using correct semantic types and recover cleanly from invalid fields",
      expectations: ["Proper autocomplete & inputmode attributes", "Reserved inline error slot", "Summary focuses first invalid control"],
      failureModes: ["Button shifts down when error appears", "Blocked paste/autofill", "Ambiguous optional vs required markers"],
    });
  }

  if (uiFiles >= 25 || surface === "operate" || mode === "S" || isDeep) {
    push("signal:dense_tables", {
      name: "Dense-Data Table & Filter Analyst",
      axis: "Dense Information Scannability & Narrow-Container Adaptation",
      basis: "Inspects multi-column comparison tables, metrics, and code blocks across wide and narrow containers",
      device: "Desktop Split & Mobile",
      viewport: "768x1024",
      network: "Normal",
      assistive: "Standard",
      goal: "Compare columns side-by-side cleanly without clipped horizontal edges on narrow panes",
      expectations: ["Tabular numerals aligned", "Clean mobile card fallback or scroll hint", "Readable header hierarchy"],
      failureModes: ["Table clipped behind overflow: hidden", "Columns compressed into single-letter wraps", "Sticky header obscuring first rows"],
    });
  }

  if (surface === "read" || hasStorybook || isDeep) {
    push("signal:docs_scanner", {
      name: "Docs & Reference Scanner",
      axis: "Skimmability & Find-in-Page Searchability",
      basis: "Uses Ctrl+F / Tab panels / Storybook controls to jump directly to runnable snippets",
      device: "Desktop / Tablet",
      viewport: "1024x768",
      network: "Normal",
      assistive: "Find-in-page + Keyboard",
      goal: "Locate flags/APIs, copy snippet, and verify defaults in under 30s",
      expectations: ["Clean code blocks with working Copy", "Searchable collapsed panels (hidden=until-found)", "Consistent terminology"],
      failureModes: ["Unlabeled code blocks", "Unresponsive tab controls", "Broken anchor scroll"],
    });
  }

  if (surface === "persuade" || (!mode && isAuto) || isDeep) {
    push("signal:persuade_evaluator", {
      name: "Skeptical Technical Evaluator",
      axis: "Trust Signals & Technical Verification",
      basis: "Cross-checks marketing/docs claims against runnable commands, release notes, and real interactive demos",
      device: "Desktop 1440x900",
      viewport: "1440x900",
      network: "Normal",
      assistive: "Standard",
      goal: "Verify real reliability and preview behavior before adopting into workflows",
      expectations: ["Accurate copy-paste snippets", "Transparent metrics/changelog", "Working interactive demo across modes"],
      failureModes: ["Mismatched doc claims vs live demo", "Broken viewport switchers inside preview", "Generic placeholder copy"],
    });
  }

  if (cssTokenFiles > 0 || dtcgFiles > 0 || surface !== "operate" || isDeep) {
    push("signal:dark_mode", {
      name: "Night-Shift Dark-Mode Browser",
      axis: "Dark Surface Cohesion & Eye Strain",
      basis: "Forces system dark theme across main site, embedded screenshots, and interactive toggles",
      device: "Desktop Dark Theme",
      viewport: "1440x900",
      network: "Normal",
      assistive: "Prefers Dark Color Scheme",
      goal: "Read interfaces and visual showcases cleanly without harsh white boxes or invisible borders",
      expectations: ["Dark showcase matching dark mode", "Balanced card elevation contrast", "Zero low-contrast muted labels"],
      failureModes: ["Light-only image blasting bright white on dark page", "Collapsed dark surface contrast"],
    });
  }

  if (frameworks.some((f) => /capacitor|tauri|electron|expo|react-native/.test(f))) {
    push("signal:hybrid_shell", {
      name: "Hybrid Shell & Safe-Area User",
      axis: "Native Window Controls, Safe Areas & Offline Resume",
      basis: "Runs app inside native desktop window chrome or mobile WebView notch/home-indicator safe areas",
      device: "Native WebView / Mobile Notch",
      viewport: "390x844",
      network: "Offline / Sleep Resume",
      assistive: "Touch & OS Shortcuts",
      goal: "Operate core tools cleanly inside inset safe areas and resume safely after sleep",
      expectations: ["Respects env(safe-area-inset-*)", "Handles offline cache cleanly", "No clipped drag handles"],
      failureModes: ["Bottom CTA covered by home bar", "Desktop keyboard shortcut conflicts"],
    });
  }

  return { personas: out, signalsMatched };
}

function normalizeCustomEntry(item) {
  const name = item.name.trim();
  const toArray = (v) =>
    Array.isArray(v)
      ? v.map((x) => String(x || "").trim()).filter(Boolean)
      : typeof v === "string" && v.trim()
      ? [v.trim()]
      : [];
  return {
    ...item,
    name,
    source: typeof item.source === "string" && item.source.trim() ? item.source.trim() : "custom",
    axis: typeof item.axis === "string" && item.axis.trim() ? item.axis.trim() : `Custom: ${name}`,
    basis: typeof item.basis === "string" && item.basis.trim() ? item.basis.trim() : "Owner-supplied custom persona scenario",
    device: typeof item.device === "string" && item.device.trim() ? item.device.trim() : "Custom",
    viewport: typeof item.viewport === "string" && item.viewport.trim() ? item.viewport.trim() : "1440x900",
    network: typeof item.network === "string" && item.network.trim() ? item.network.trim() : "Normal",
    assistive: typeof item.assistive === "string" && item.assistive.trim() ? item.assistive.trim() : "Standard",
    goal: typeof item.goal === "string" && item.goal.trim() ? item.goal.trim() : `Validate ${name} primary workflow`,
    expectations: toArray(item.expectations),
    failureModes: toArray(item.failureModes),
  };
}

function loadCustomPersonas(absTarget, customPath) {
  const candidates = [];
  if (customPath !== undefined && customPath !== null) {
    if (typeof customPath !== "string" || customPath.trim().length === 0) {
      throw new Error("Parameter '--custom' must be a non-empty file path.");
    }
    const resolvedCustom = resolve(customPath);
    if (!existsSync(resolvedCustom) || !statSync(resolvedCustom).isFile()) {
      throw new Error(`Custom personas file not found: ${resolvedCustom}`);
    }
    candidates.push(resolvedCustom);
  } else {
    const defaultCustom = join(absTarget, ".dsaf/personas.custom.json");
    let lst = null;
    try {
      lst = lstatSync(defaultCustom);
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
    }
    if (lst) {
      if (lst.isSymbolicLink() && !existsSync(defaultCustom)) {
        throw new Error(`Custom personas path is a broken symlink: ${defaultCustom}`);
      }
      if (!statSync(defaultCustom).isFile()) {
        throw new Error(`Custom personas path is not a file: ${defaultCustom}`);
      }
      candidates.push(defaultCustom);
    }
  }
  const customList = [];
  for (const file of candidates) {
    if (!existsSync(file)) throw new Error(`Custom personas file not found: ${file}`);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray(parsed.personas)
      ? parsed.personas
      : null;
    if (!items) {
      throw new Error(`Invalid custom personas schema in ${file}: expected a JSON array or { "personas": [...] }.`);
    }
    for (const item of items) {
      if (!item || typeof item !== "object" || typeof item.name !== "string" || !item.name.trim()) continue;
      customList.push(normalizeCustomEntry(item));
    }
  }
  return customList;
}

export function generatePersonas(targetDir = ".", options = {}) {
  if (typeof targetDir !== "string" || targetDir.trim().length === 0) {
    throw new Error("Target directory must be a non-empty path.");
  }
  const absTarget = resolve(targetDir);
  if (!existsSync(absTarget) || !statSync(absTarget).isDirectory()) {
    throw new Error(`Target directory not found: ${absTarget}`);
  }
  const recon = options.recon || analyzeDirectory(absTarget);
  const rawDepth = options.depth === undefined ? "auto" : options.depth;
  if (typeof rawDepth !== "string" || !["auto", "quick", "deep"].includes(rawDepth.toLowerCase())) {
    throw new Error(`Invalid --depth '${rawDepth}'; expected auto|quick|deep.`);
  }
  const depth = rawDepth.toLowerCase();
  let maxCap = null;
  if (options.max !== undefined && options.max !== null) {
    if (options.max !== Infinity) {
      if (typeof options.max !== "number" || !Number.isSafeInteger(options.max) || options.max < 1) {
        throw new Error(`Invalid max cap '${options.max}'. Expected a finite integer >= 1.`);
      }
      maxCap = options.max;
    }
  }

  const stackParts = [...(recon.stack?.frameworks || [])];
  if (recon.stack?.hasTailwindTheme) stackParts.push("Tailwind v4");
  const stackSummary = stackParts.length > 0 ? stackParts.slice(0, 3).join(", ") : "Web UI";

  const seenAxes = new Set();
  const merged = [];
  const addUnique = (entry) => {
    const axisKey = String(entry.axis || entry.name).toLowerCase().trim();
    if (!axisKey || seenAxes.has(axisKey)) return;
    seenAxes.add(axisKey);
    merged.push(entry);
  };

  for (const p of buildBaselinePersonas(stackSummary)) addUnique(p);

  let signalsMatched = [];
  if (depth !== "quick") {
    const derived = buildSignalPersonas(recon, depth);
    signalsMatched = derived.signalsMatched;
    for (const p of derived.personas) addUnique(p);
  }

  const nonCustomCount = merged.length;
  const customItems = [
    ...loadCustomPersonas(absTarget, options.customPath),
    ...(Array.isArray(options.extraPersonas) ? options.extraPersonas.map((p) => ({ source: "custom", ...p })) : []),
  ];
  for (const c of customItems) {
    if (!c || typeof c.name !== "string" || !c.name.trim()) continue;
    merged.push(normalizeCustomEntry(c));
  }

  const bounded = maxCap ? merged.slice(0, maxCap) : merged;
  const customCount = Math.max(0, bounded.length - nonCustomCount);
  const usedIds = new Set();
  const personas = bounded.map((p, idx) => {
    let id = typeof p.id === "string" && p.id.trim() ? p.id.trim() : `P${String(idx + 1).padStart(2, "0")}`;
    let suffix = 1;
    while (usedIds.has(id)) id = `P${String(idx + 1).padStart(2, "0")}_${suffix++}`;
    usedIds.add(id);
    return { ...p, id };
  });

  const routeSamples = Array.isArray(recon.samples?.appRoutes) ? recon.samples.appRoutes.slice(0, 8) : [];
  const seededJourneys = [
    "First-60s orientation & primary CTA clarity",
    "Keyboard-only traversal & focus-visible verification",
    "Mobile 390px header, pill, and table resilience",
    "Light / Dark theme parity & reduced-motion check",
    ...(recon.recommendedMode === "S" ? ["Token/Component copy-paste adoption & docs parity"] : []),
    ...(recon.t2MockRequired ? ["Fault/offline error recovery & unsaved draft retention"] : []),
    ...routeSamples.map((r) => `Route inspection: ${r}`),
  ];

  const repoName = recon.target ? basename(String(recon.target)) : basename(absTarget);

  return {
    schema: "dsaf-personas/1",
    version: PERSONAS_VERSION,
    generated: new Date().toISOString(),
    target: options.relativeTarget || absTarget,
    repository: repoName || "workspace",
    depth,
    uncapped: !maxCap,
    maxCap,
    signalsMatched,
    customPersonaCount: customCount,
    recommendedMode: recon.recommendedMode,
    surfaceMode: recon.surfaceMode,
    t2MockRequired: Boolean(recon.t2MockRequired),
    personaCount: personas.length,
    personas,
    seededJourneys,
    cognitiveWalkthroughQuestions: COGNITIVE_WALKTHROUGH_QUESTIONS,
    syntheticEdgeDatasets: SYNTHETIC_EDGE_DATASETS,
    epistemicRules: {
      simulatedTagRequired: true,
      noSourceLeakage: true,
      conditionalFraming: true,
    },
  };
}

export function formatPersonasMarkdown(report) {
  const lines = [
    `# DSAF Multi-Axis Persona Matrix — ${report.repository}`,
    "",
    `- **Engine:** v${report.version} | **Depth:** ${report.depth} (${report.personaCount} personas, ${report.uncapped ? "uncapped signal-driven" : `capped at ${report.maxCap}`})`,
    `- **Detected Mode / Surface:** \`Mode ${report.recommendedMode}\` / \`${report.surfaceMode}\` | **T2-Mock:** ${report.t2MockRequired} | **Custom Personas Merged:** ${report.customPersonaCount || 0}`,
    "",
    "## Personas",
    "",
    "| ID | Persona | Axis | Source | Viewport / Context | Core Goal |",
    "|---|---|---|---|---|---|",
  ];
  const escCell = (s) => String(s || "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  for (const p of report.personas) {
    lines.push(
      `| \`${escCell(p.id)}\` | **${escCell(p.name)}** | ${escCell(p.axis)} | \`${escCell(p.source || "signal")}\` | ${escCell(p.viewport)} (${escCell(p.network)}) | ${escCell(p.goal)} |`
    );
  }
  lines.push("", "## Seeded Evaluation Journeys", "");
  for (const j of report.seededJourneys) lines.push(`- ${j}`);
  lines.push("", "## 5 Cognitive Walkthrough Questions", "");
  report.cognitiveWalkthroughQuestions.forEach((q, idx) => lines.push(`${idx + 1}. ${q}`));
  lines.push("", "## Custom Personas Override", "");
  lines.push("- Add domain-specific roles (unlimited count) in `.dsaf/personas.custom.json` or pass `--custom <file>` — `dsaf personas` merges them cleanly without overwriting custom entries.");
  lines.push("");
  return lines.join("\n");
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-personas-test-"));
  try {
    // 1. Mode P quick (5 baseline) vs auto uncapped signal scaling
    const appDir = join(scratch, "web-app");
    mkdirSync(join(appDir, "app/dashboard"), { recursive: true });
    mkdirSync(join(appDir, "app/settings"), { recursive: true });
    mkdirSync(join(appDir, "app/billing"), { recursive: true });
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "sample-app", dependencies: { next: "^16.0.0", react: "^19.0.0" } }));
    writeFileSync(join(appDir, "app/page.tsx"), "export default function Page() { return <main>Hi</main>; }");
    writeFileSync(join(appDir, "app/dashboard/page.tsx"), "export default function Dash() { return <main>Dash</main>; }");
    writeFileSync(join(appDir, "app/settings/page.tsx"), "export default function Settings() { return <main>Settings</main>; }");
    writeFileSync(join(appDir, "app/billing/page.tsx"), "export default function Billing() { return <main>Billing</main>; }");

    const quickRes = generatePersonas(appDir, { depth: "quick" });
    assert.equal(quickRes.schema, "dsaf-personas/1");
    assert.equal(quickRes.personaCount, 5);
    assert.equal(quickRes.uncapped, true);

    const autoRes = generatePersonas(appDir, { depth: "auto" });
    assert.ok(autoRes.personaCount >= 8, `Expected uncapped auto personas >= 8, got ${autoRes.personaCount}`);
    assert.ok(autoRes.signalsMatched.includes("signal:multi_route"), "Multi-route Next app must trigger signal:multi_route");
    assert.ok(autoRes.seededJourneys.some((j) => j.startsWith("Route inspection:")), "Seeded journeys must include sampled routes");
    assert.equal(new Set(autoRes.personas.map((p) => p.axis)).size, autoRes.personaCount, "Every generated persona must occupy a distinct orthogonal axis");
    assert.equal(autoRes.cognitiveWalkthroughQuestions.length, 5);
    assert.equal(autoRes.syntheticEdgeDatasets.length, 5);

    // 2. Mode S monorepo + unlimited custom personas in .dsaf/personas.custom.json
    const dsDir = join(scratch, "ds-mono");
    mkdirSync(join(dsDir, "packages/design/tokens"), { recursive: true });
    mkdirSync(join(dsDir, "packages/design/src/components"), { recursive: true });
    mkdirSync(join(dsDir, ".dsaf"), { recursive: true });
    writeFileSync(join(dsDir, "packages/design/package.json"), JSON.stringify({ name: "@acme/ui", exports: { ".": "./dist/index.js" } }));
    writeFileSync(join(dsDir, "packages/design/tokens/color.json"), JSON.stringify({ light: { bg: { $type: "color", $value: "#F7F8FA" } } }));
    writeFileSync(join(dsDir, "packages/design/src/components/Button.stories.tsx"), "export default {};");
    writeFileSync(join(dsDir, "packages/design/src/components/Badge.stories.tsx"), "export default {};");
    const manyCustom = Array.from({ length: 6 }, (_, i) => ({
      ...(i === 0 ? { id: "P01", name: "Admin | Ops", expectations: "fast load" } : { name: `Custom Role ${i + 1}` }),
      axis: `Custom Axis ${i + 1}`,
      goal: `Validate custom workflow ${i + 1}`,
    }));
    writeFileSync(join(dsDir, ".dsaf/personas.custom.json"), JSON.stringify(manyCustom, null, 2));

    const dsPersonas = generatePersonas(dsDir, { depth: "deep", relativeTarget: "." });
    assert.equal(dsPersonas.recommendedMode, "S");
    assert.equal(dsPersonas.target, ".");
    assert.equal(dsPersonas.customPersonaCount, 6);
    assert.ok(dsPersonas.personaCount >= 16, `Expected uncapped deep + 6 custom >= 16, got ${dsPersonas.personaCount}`);
    const tokPersona = dsPersonas.personas.find((p) => /Token/.test(p.name));
    assert.ok(tokPersona && !/0 DTCG \/ 0 token/.test(tokPersona.basis), "Token maintainer persona must cite non-zero DTCG count");
    const dupIds = dsPersonas.personas.filter((p) => p.id === "P01");
    assert.equal(dupIds.length, 1, "Colliding custom P01 id must be deduplicated cleanly");
    const customAdmin = dsPersonas.personas.find((p) => p.name === "Admin | Ops");
    assert.ok(Array.isArray(customAdmin.expectations), "String expectations must coerce to array");
    assert.ok(dsPersonas.personas.some((p) => p.name === "Custom Role 6"));

    // 3. Explicit --max cap opt-in works cleanly when requested
    const capped = generatePersonas(dsDir, { depth: "deep", max: 4 });
    assert.equal(capped.uncapped, false);
    assert.equal(capped.personaCount, 4);
    assert.equal(capped.customPersonaCount, 0, "Capped persona list excluding custom entries must report customPersonaCount=0");

    // Round 2 regression: colliding custom ID (`P07_6` + duplicate `P01`) must not infinite-loop
    const noHang = generatePersonas(appDir, {
      depth: "quick",
      extraPersonas: [{ id: "P07_6", name: "Role A" }, { id: "P01", name: "Role B" }],
    });
    assert.equal(noHang.personaCount, 7);
    assert.equal(noHang.customPersonaCount, 2);
    assert.equal(new Set(noHang.personas.map((p) => p.id)).size, 7);

    const md = formatPersonasMarkdown(dsPersonas);
    assert.match(md, /uncapped signal-driven/);
    assert.match(md, /Admin \\\| Ops/, "Markdown pipes must be escaped");
    assert.match(md, /Custom Role 6/);

    // Round 5 regressions: malformed custom persona root rejects; whitespace/non-string extraPersonas names skipped cleanly
    const badCustomPath = join(scratch, "bad-custom.json");
    writeFileSync(badCustomPath, JSON.stringify({ personas: "bad" }));
    assert.throws(() => generatePersonas(appDir, { depth: "quick", customPath: badCustomPath }), /Invalid custom personas schema/);
    const cleanBlankRes = generatePersonas(appDir, {
      depth: "quick",
      extraPersonas: [{ name: "   " }, { name: { en: "Admin" } }, { name: "  Ops Lead  " }],
    });
    assert.equal(cleanBlankRes.customPersonaCount, 1);
    assert.equal(cleanBlankRes.personas[cleanBlankRes.personas.length - 1].name, "Ops Lead");
    assert.equal(cleanBlankRes.personas[cleanBlankRes.personas.length - 1].axis, "Custom: Ops Lead");

    // Round 8 / R23 #11 regressions: Infinity normalizes to uncapped; non-integer or < 1 max caps throw
    const infCap = generatePersonas(dsDir, { depth: "quick", max: Infinity });
    assert.equal(infCap.uncapped, true);
    assert.equal(infCap.maxCap, null);
    for (const badMax of [0.5, 0, -5, 1.5, Number.NaN]) {
      assert.throws(() => generatePersonas(dsDir, { depth: "quick", max: badMax }), /Invalid max cap/);
    }

    // Round 18 regressions (R18-A1-09, R18-A1-11): strict CLI args, literal spaces out/markdown rejection, integer --max, exit 2, and symlink entrypoint
    const gpSelfPath = fileURLToPath(import.meta.url);
    for (const cliBad of [
      [""],
      [appDir, appDir],
      [appDir, "--custom", ""],
      [appDir, "--depth", "bogus"],
      [appDir, "--depth", ""],
      [appDir, "--out", ""],
      [appDir, "--out", "   "],
      [appDir, "--markdown", ""],
      [appDir, "--markdown", "   "],
      [appDir, "--max", "1.5"],
      [appDir, "--unknown-flag"],
      [appDir, "--out", appDir],
    ]) {
      assert.equal(spawnSync(process.execPath, [gpSelfPath, ...cliBad], { encoding: "utf8" }).status, 2, `CLI must exit 2 for: ${JSON.stringify(cliBad)}`);
    }
    const r21FileParent = join(scratch, "r21-file-parent.txt");
    writeFileSync(r21FileParent, "not a dir\n");
    const r21EnotdirRun = spawnSync(process.execPath, [gpSelfPath, appDir, "--out", join(r21FileParent, "p.json")], { encoding: "utf8" });
    assert.equal(r21EnotdirRun.status, 2);
    assert.match(r21EnotdirRun.stderr, /is not a directory/);
    assert.doesNotMatch(r21EnotdirRun.stderr, /ENOTDIR/);
    const gpLink = join(scratch, "gp-link.mjs");
    symlinkSync(gpSelfPath, gpLink);
    const gpLinkRun = spawnSync(process.execPath, [gpLink, appDir, "--json"], { encoding: "utf8" });
    assert.equal(gpLinkRun.status, 0, "Symlink invocation must execute CLI entrypoint");
    assert.equal(JSON.parse(gpLinkRun.stdout).schema, "dsaf-personas/1");

    // Round 19 regression (R19-A1-04): nested --out / --markdown collision exits 2 before creating out file
    const gpCol = join(scratch, "gp-col-nest");
    assert.equal(spawnSync(process.execPath, [gpSelfPath, appDir, "--out", gpCol, "--markdown", join(gpCol, "p.md")], { encoding: "utf8" }).status, 2);
    assert.equal(existsSync(gpCol), false);

    // Round 20 regression (R20-A1-M2): symlink-aliased --out / --markdown must reject upfront
    const r20GpReal = join(scratch, "r20-gp-real");
    const r20GpLink = join(scratch, "r20-gp-link");
    mkdirSync(r20GpReal, { recursive: true });
    symlinkSync(r20GpReal, r20GpLink);
    assert.equal(
      spawnSync(process.execPath, [gpSelfPath, appDir, "--out", join(r20GpLink, "out.txt"), "--markdown", join(r20GpReal, "out.txt")], { encoding: "utf8" }).status,
      2
    );
    assert.equal(existsSync(join(r20GpReal, "out.txt")), false);

    // Round 23 regression (#11): broken default .dsaf/personas.custom.json symlink throws
    const r23BrokenCustom = join(scratch, "r23-broken-custom");
    mkdirSync(join(r23BrokenCustom, ".dsaf"), { recursive: true });
    symlinkSync(join(scratch, "nonexistent-custom.json"), join(r23BrokenCustom, ".dsaf/personas.custom.json"));
    assert.throws(() => generatePersonas(r23BrokenCustom), /broken symlink/);

    // Round 25 regressions (A4-H1 live leaf symlink on --out and --markdown, A4-L1 symlink CLI)
    const pSelfPath = fileURLToPath(import.meta.url);
    const r25PersOutSecret = join(scratch, "r25-pers-secret.json");
    const r25PersOutSym = join(scratch, "r25-pers-sym.json");
    const r25PersMdSecret = join(scratch, "r25-pers-secret.md");
    const r25PersMdSym = join(scratch, "r25-pers-sym.md");
    const r25PersCliSym = join(scratch, "r25-pers-cli-sym.mjs");
    writeFileSync(r25PersOutSecret, '{"untouched":true}');
    writeFileSync(r25PersMdSecret, "# untouched\n");
    symlinkSync(r25PersOutSecret, r25PersOutSym);
    symlinkSync(r25PersMdSecret, r25PersMdSym);
    symlinkSync(pSelfPath, r25PersCliSym);
    assert.equal(spawnSync(process.execPath, [pSelfPath, appDir, "--out", r25PersOutSym], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [pSelfPath, appDir, "--markdown", r25PersMdSym], { encoding: "utf8" }).status, 2);
    assert.equal(readFileSync(r25PersOutSecret, "utf8"), '{"untouched":true}');
    assert.equal(readFileSync(r25PersMdSecret, "utf8"), "# untouched\n");
    assert.equal(spawnSync(process.execPath, [r25PersCliSym, "--help"], { encoding: "utf8" }).status, 0);

    // Round 26 regression (A1-H1): intra-repo symlinked dir escaping target root must reject --out and --markdown
    const r26Proj = join(scratch, "r26-proj");
    const r26Outside = join(scratch, "r26-outside");
    mkdirSync(r26Proj, { recursive: true });
    mkdirSync(r26Outside, { recursive: true });
    symlinkSync(r26Outside, join(r26Proj, "linked-out"));
    assert.equal(
      spawnSync(process.execPath, [pSelfPath, r26Proj, "--out", join(r26Proj, "linked-out/personas.json")], { encoding: "utf8" }).status,
      2
    );
    assert.equal(
      spawnSync(process.execPath, [pSelfPath, r26Proj, "--markdown", join(r26Proj, "linked-out/personas.md")], { encoding: "utf8" }).status,
      2
    );
    assert.equal(existsSync(join(r26Outside, "personas.json")), false);
    assert.equal(existsSync(join(r26Outside, "personas.md")), false);

    console.log(`DSAF_PERSONAS_SELF_TEST_PASSED (uncapped signal scaling: quick=5, auto=${autoRes.personaCount}, deep+custom=${dsPersonas.personaCount})`);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isDirectCliEntry(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        depth: { type: "string", default: "auto" },
        custom: { type: "string" },
        max: { type: "string" },
        out: { type: "string" },
        markdown: { type: "string" },
        json: { type: "boolean", default: false },
        "self-test": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });

    if (values.help) {
      console.log(
        [
          `DSAF v${PERSONAS_VERSION} — Uncapped Signal-Driven Persona Generator`,
          "Usage:",
          "  dsaf personas [target] [--depth auto|quick|deep] [--custom <personas.custom.json>] [--max <n>] [--out <personas.json>] [--markdown <personas.md>] [--json] [--help]",
          "  dsaf personas --self-test",
        ].join("\n")
      );
      process.exit(0);
    }

    if (values["self-test"]) {
      process.exit(runSelfTest());
    }

    if (positionals.length > 1) {
      throw new Error(`Unexpected extra positional argument '${positionals[1]}'. Pass a single [target].`);
    }
    if (positionals.length > 0 && positionals[0].trim().length === 0) {
      throw new Error("Target directory must be a non-empty path.");
    }
    const target = positionals.length > 0 ? positionals[0] : ".";
    let maxCapArg = null;
    if (values.max !== undefined) {
      const cleanMax = values.max.trim();
      const parsedMax = /^\d+$/.test(cleanMax) ? Number(cleanMax) : Number.NaN;
      if (!Number.isSafeInteger(parsedMax) || parsedMax < 1) {
        console.error(`ERROR: Invalid --max '${values.max}'. Expected a finite integer >= 1.`);
        process.exit(2);
      }
      maxCapArg = parsedMax;
    }
    const canonicalizeOutputPath = (absPath) => {
      const resolved = resolve(absPath);
      const tail = [];
      let cur = resolved;
      while (true) {
        try {
          const real = (realpathSync.native || realpathSync)(cur);
          return tail.length ? join(real, ...tail.reverse()) : real;
        } catch {
          const parent = dirname(cur);
          if (parent === cur) return resolved;
          tail.push(basename(cur));
          cur = parent;
        }
      }
    };
    const absTargetRoot = resolve(target);
    const outPath = values.out === undefined ? null : assertWritableOutputFile(values.out, "--out", { rootDir: absTargetRoot });
    const mdPath = values.markdown === undefined ? null : assertWritableOutputFile(values.markdown, "--markdown", { rootDir: absTargetRoot });
    const canonOut = outPath ? canonicalizeOutputPath(outPath) : null;
    const canonMd = mdPath ? canonicalizeOutputPath(mdPath) : null;
    const normCmpPath = (p) => (process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p);
    const isSameOrUnder = (parentDir, childPath) => {
      const rel = relative(normCmpPath(parentDir), normCmpPath(childPath));
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    };
    if (canonOut && canonMd && (isSameOrUnder(canonOut, canonMd) || isSameOrUnder(canonMd, canonOut))) {
      throw new Error(`Output path collision between --out and --markdown: ${outPath}`);
    }
    const report = generatePersonas(target, {
      depth: values.depth,
      customPath: values.custom,
      max: maxCapArg,
    });
    const jsonStr = JSON.stringify(report, null, 2) + "\n";

    if (outPath) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, jsonStr, "utf8");
    }
    if (mdPath) {
      mkdirSync(dirname(mdPath), { recursive: true });
      writeFileSync(mdPath, formatPersonasMarkdown(report), "utf8");
    }

    if (values.json) {
      process.stdout.write(jsonStr);
    } else {
      console.log(
        `DSAF_PERSONAS v${PERSONAS_VERSION}: ${report.repository} [Mode ${report.recommendedMode}, ${report.surfaceMode}] -> ${report.personaCount} personas (${report.depth}, ${report.uncapped ? "uncapped" : `max=${report.maxCap}`})`
      );
      for (const p of report.personas) {
        console.log(`  - ${p.id} ${p.name} [${p.axis}] (${p.viewport})`);
      }
    }
  } catch (err) {
    console.error(`ERROR: ${err.message || err}`);
    process.exit(2);
  }
}
