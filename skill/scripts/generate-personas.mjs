#!/usr/bin/env node
/**
 * DSAF v0.9.2 — Deterministic Multi-Axis Persona Matrix Generator (`dsaf personas`).
 * Derives uncapped, signal-driven orthogonal personas, merges unlimited custom
 * domain personas (`.dsaf/personas.custom.json` or `--custom <file>`), and binds
 * cognitive walkthrough checklists + T2 synthetic edge datasets from read-only recon.
 * Zero external dependencies.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyzeDirectory } from "./recon.mjs";

export const PERSONAS_VERSION = "0.9.2";

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
  const routesCount = Array.isArray(recon.samples?.appRoutes) ? recon.samples.appRoutes.length : 0;
  const uiFiles = Number(recon.filesScanned?.uiAndStyle || 0);
  const cssTokenFiles = Number(recon.filesScanned?.cssTokenFiles || 0);
  const dtcgFiles = Number(recon.filesScanned?.tokenJson || 0);
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

  if (surface === "read" || recon.stack?.hasStorybook || isDeep) {
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

function loadCustomPersonas(absTarget, customPath) {
  const candidates = [];
  if (customPath) {
    candidates.push(resolve(customPath));
  } else {
    const defaultCustom = join(absTarget, ".dsaf/personas.custom.json");
    if (existsSync(defaultCustom)) candidates.push(defaultCustom);
  }
  const customList = [];
  for (const file of candidates) {
    if (!existsSync(file)) throw new Error(`Custom personas file not found: ${file}`);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.personas) ? parsed.personas : [];
    for (const item of items) {
      if (!item || typeof item !== "object" || !item.name) continue;
      customList.push({
        source: "custom",
        axis: item.axis || `Custom: ${item.name}`,
        basis: item.basis || "Owner-supplied custom persona scenario",
        device: item.device || "Custom",
        viewport: item.viewport || "1440x900",
        network: item.network || "Normal",
        assistive: item.assistive || "Standard",
        expectations: Array.isArray(item.expectations) ? item.expectations : [],
        failureModes: Array.isArray(item.failureModes) ? item.failureModes : [],
        ...item,
      });
    }
  }
  return customList;
}

export function generatePersonas(targetDir = ".", options = {}) {
  const absTarget = resolve(targetDir);
  const recon = options.recon || analyzeDirectory(absTarget);
  const rawDepth = String(options.depth || "auto").toLowerCase();
  const depth = rawDepth === "quick" || rawDepth === "deep" ? rawDepth : "auto";
  const maxCap = typeof options.max === "number" && options.max > 0 ? Math.floor(options.max) : null;

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

  const customItems = [
    ...loadCustomPersonas(absTarget, options.customPath),
    ...(Array.isArray(options.extraPersonas) ? options.extraPersonas.map((p) => ({ source: "custom", ...p })) : []),
  ];
  let customCount = 0;
  for (const c of customItems) {
    if (!c || !c.name) continue;
    merged.push({
      source: c.source || "custom",
      axis: c.axis || `Custom: ${c.name}`,
      basis: c.basis || "Owner-supplied custom persona scenario",
      device: c.device || "Custom",
      viewport: c.viewport || "1440x900",
      network: c.network || "Normal",
      assistive: c.assistive || "Standard",
      goal: c.goal || `Validate ${c.name} primary workflow`,
      expectations: Array.isArray(c.expectations) ? c.expectations : [],
      failureModes: Array.isArray(c.failureModes) ? c.failureModes : [],
      ...c,
    });
    customCount++;
  }

  const bounded = maxCap ? merged.slice(0, maxCap) : merged;
  const usedIds = new Set();
  const personas = bounded.map((p, idx) => {
    let id = typeof p.id === "string" && p.id.trim() ? p.id.trim() : `P${String(idx + 1).padStart(2, "0")}`;
    while (usedIds.has(id)) id = `P${String(idx + 1).padStart(2, "0")}_${usedIds.size}`;
    usedIds.add(id);
    return { id, ...p };
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
  for (const p of report.personas) {
    lines.push(
      `| \`${p.id}\` | **${p.name}** | ${p.axis} | \`${p.source || "signal"}\` | ${p.viewport} (${p.network}) | ${p.goal} |`
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
      name: `Custom Role ${i + 1}`,
      axis: `Custom Axis ${i + 1}`,
      goal: `Validate custom workflow ${i + 1}`,
    }));
    writeFileSync(join(dsDir, ".dsaf/personas.custom.json"), JSON.stringify(manyCustom, null, 2));

    const dsPersonas = generatePersonas(dsDir, { depth: "deep", relativeTarget: "." });
    assert.equal(dsPersonas.recommendedMode, "S");
    assert.equal(dsPersonas.target, ".");
    assert.equal(dsPersonas.customPersonaCount, 6);
    assert.ok(dsPersonas.personaCount >= 16, `Expected uncapped deep + 6 custom >= 16, got ${dsPersonas.personaCount}`);
    assert.ok(dsPersonas.personas.some((p) => /Token/.test(p.name)));
    assert.ok(dsPersonas.personas.some((p) => p.name === "Custom Role 6"));

    // 3. Explicit --max cap opt-in works cleanly when requested
    const capped = generatePersonas(dsDir, { depth: "deep", max: 4 });
    assert.equal(capped.uncapped, false);
    assert.equal(capped.personaCount, 4);

    const md = formatPersonasMarkdown(dsPersonas);
    assert.match(md, /uncapped signal-driven/);
    assert.match(md, /Custom Role 6/);

    console.log(`DSAF_PERSONAS_SELF_TEST_PASSED (uncapped signal scaling: quick=5, auto=${autoRes.personaCount}, deep+custom=${dsPersonas.personaCount})`);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === resolve(decodeURIComponent(new URL(import.meta.url).pathname));
if (isEntrypoint) {
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
        "  dsaf personas [target] [--depth auto|quick|deep] [--custom <personas.custom.json>] [--max <n>] [--out <personas.json>] [--markdown <personas.md>] [--json]",
        "  dsaf personas --self-test",
      ].join("\n")
    );
    process.exit(0);
  }

  if (values["self-test"]) {
    process.exit(runSelfTest());
  }

  const target = positionals[0] || ".";
  const maxNum = values.max ? Number(values.max) : null;
  const report = generatePersonas(target, {
    depth: values.depth,
    customPath: values.custom,
    max: Number.isFinite(maxNum) && maxNum > 0 ? maxNum : null,
  });
  const jsonStr = JSON.stringify(report, null, 2) + "\n";

  if (values.out) {
    const outPath = resolve(values.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, jsonStr, "utf8");
  }
  if (values.markdown) {
    const mdPath = resolve(values.markdown);
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
}
