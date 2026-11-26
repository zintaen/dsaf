#!/usr/bin/env node
/**
 * DSAF v0.9.0 — Deterministic Multi-Axis Persona Matrix Generator (`dsaf personas`).
 * Derives topology- and Surface-Mode-aware personas, cognitive walkthrough checklists,
 * and T2 synthetic edge dataset contracts from read-only repository recon.
 * Zero external dependencies.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyzeDirectory } from "./recon.mjs";

export const PERSONAS_VERSION = "0.9.0";

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

function buildCorePersonas(stackSummary) {
  return [
    {
      id: "P01",
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
      id: "P02",
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
      id: "P03",
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
      id: "P04",
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
      id: "P05",
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

function buildAdaptivePersonas(recon) {
  const mode = recon.recommendedMode || "P";
  const surface = recon.surfaceMode || "persuade";

  if (mode === "S") {
    return [
      {
        id: "P06",
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
      },
      {
        id: "P07",
        name: "Design Token & Theme Maintainer",
        axis: "Token Architecture & Cross-Theme Parity",
        basis: "Audits W3C DTCG JSON against Light/Dark CSS variables and Storybook states",
        device: "Desktop Dual Theme",
        viewport: "1440x900",
        network: "Normal",
        assistive: "Color-blind simulation & contrast checker",
        goal: "Verify Light/Dark symmetry and zero hardcoded color leaks",
        expectations: ["Matched Light/Dark keys", "Valid 3:1 control borders", "Zero primitive leaks"],
        failureModes: ["Border color below 3:1", "Theme drift between DTCG and runtime CSS", "Missing dark showcase"],
      },
      {
        id: "P08",
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
      },
    ];
  }

  if (recon.t2MockRequired || surface === "operate") {
    return [
      {
        id: "P06",
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
      },
      {
        id: "P07",
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
      },
      {
        id: "P08",
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
      },
    ];
  }

  return [
    {
      id: "P06",
      name: "Skeptical Technical Evaluator",
      axis: "Trust Signals & Technical Verification",
      basis: "Cross-checks claims against runnable commands, release notes, and real demos",
      device: "Desktop 1440x900",
      viewport: "1440x900",
      network: "Normal",
      assistive: "Standard",
      goal: "Verify tool reliability before adopting into CI/CD or agent workflows",
      expectations: ["Accurate copy-paste CLI snippets", "Transparent changelog/metrics", "Working interactive demo"],
      failureModes: ["Mismatched doc commands vs real CLI", "Broken badges or missing live demo preview"],
    },
    {
      id: "P07",
      name: "Docs & Reference Scanner",
      axis: "Skimmability & Searchability",
      basis: "Uses Ctrl+F / Tab panels to jump directly to specific subcommand references",
      device: "Desktop / Tablet",
      viewport: "1024x768",
      network: "Normal",
      assistive: "Find-in-page + Keyboard",
      goal: "Locate flags, copy snippet, and verify defaults in under 30s",
      expectations: ["Clean code blocks with working Copy", "Findable collapsed panels (hidden=until-found)", "Consistent terminology"],
      failureModes: ["Unlabeled code blocks", "Unresponsive tab controls", "Broken anchor scroll"],
    },
    {
      id: "P08",
      name: "Night-Shift Dark-Mode Browser",
      axis: "Dark Surface Cohesion & Eye Strain",
      basis: "Forces system dark theme across main site and embedded previews/images",
      device: "Desktop Dark Theme",
      viewport: "1440x900",
      network: "Normal",
      assistive: "Prefers Dark Color Scheme",
      goal: "Read documentation and visual showcases cleanly without harsh white boxes",
      expectations: ["Dark showcase matching dark mode", "Balanced card elevation contrast", "Zero glaring white borders"],
      failureModes: ["Light-only PNG blasting bright white on dark background", "Collapsed dark surface contrast"],
    },
  ];
}

export function generatePersonas(targetDir = ".", options = {}) {
  const absTarget = resolve(targetDir);
  const recon = options.recon || analyzeDirectory(absTarget);
  const depth = options.depth === "quick" ? "quick" : "deep";
  const stackParts = [...(recon.stack?.frameworks || [])];
  if (recon.stack?.hasTailwindTheme) stackParts.push("Tailwind v4");
  const stackSummary = stackParts.length > 0 ? stackParts.slice(0, 3).join(", ") : "Web UI";

  const core = buildCorePersonas(stackSummary);
  const adaptive = depth === "deep" ? buildAdaptivePersonas(recon) : [];
  const personas = [...core, ...adaptive];

  const routeSamples = Array.isArray(recon.samples?.appRoutes) ? recon.samples.appRoutes.slice(0, 5) : [];
  const seededJourneys = [
    "First-60s orientation & primary CTA clarity",
    "Keyboard-only traversal & focus-visible verification",
    "Mobile 390px header, pill, and table resilience",
    "Light / Dark theme parity & reduced-motion check",
    ...(recon.recommendedMode === "S" ? ["Token/Component copy-paste adoption & docs parity"] : []),
    ...(recon.t2MockRequired ? ["Fault/offline error recovery & unsaved draft retention"] : []),
    ...routeSamples.map((r) => `Route inspection: ${r}`),
  ];

  return {
    schema: "dsaf-personas/1",
    version: PERSONAS_VERSION,
    generated: new Date().toISOString(),
    target: absTarget,
    repository: recon.target ? recon.target.split("/").pop() : "workspace",
    depth,
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
    `- **Engine:** v${report.version} | **Depth:** ${report.depth} (${report.personaCount} personas)`,
    `- **Detected Mode / Surface:** \`Mode ${report.recommendedMode}\` / \`${report.surfaceMode}\` | **T2-Mock:** ${report.t2MockRequired}`,
    "",
    "## Personas",
    "",
    "| ID | Persona | Axis | Viewport / Context | Core Goal | Primary Failure Risks |",
    "|---|---|---|---|---|---|",
  ];
  for (const p of report.personas) {
    lines.push(
      `| \`${p.id}\` | **${p.name}** | ${p.axis} | ${p.viewport} (${p.network}) | ${p.goal} | ${p.failureModes.slice(0, 2).join("; ")} |`
    );
  }
  lines.push("", "## Seeded Evaluation Journeys", "");
  for (const j of report.seededJourneys) lines.push(`- ${j}`);
  lines.push("", "## 5 Cognitive Walkthrough Questions", "");
  report.cognitiveWalkthroughQuestions.forEach((q, idx) => lines.push(`${idx + 1}. ${q}`));
  lines.push("", "## Epistemic Guardrails", "");
  lines.push("- Prefix simulated thoughts/predictions with `(simulated)` and conditional language.");
  lines.push("- Personas observe ONLY rendered UI context (no source file paths, DOM class names, or storage keys).");
  lines.push("");
  return lines.join("\n");
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-personas-test-"));
  try {
    // 1. Mode P quick (5) vs deep (8)
    const appDir = join(scratch, "web-app");
    mkdirSync(join(appDir, "app"), { recursive: true });
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "sample-app", dependencies: { next: "^16.0.0", react: "^19.0.0" } }));
    writeFileSync(join(appDir, "app/page.tsx"), "export default function Page() { return <main>Hi</main>; }");

    const quickRes = generatePersonas(appDir, { depth: "quick" });
    assert.equal(quickRes.schema, "dsaf-personas/1");
    assert.equal(quickRes.personaCount, 5);
    assert.equal(quickRes.recommendedMode, "P");

    const deepRes = generatePersonas(appDir, { depth: "deep" });
    assert.equal(deepRes.personaCount, 8);
    assert.equal(new Set(deepRes.personas.map((p) => p.axis)).size, 8, "Every persona must occupy a distinct axis");
    assert.equal(deepRes.cognitiveWalkthroughQuestions.length, 5);
    assert.equal(deepRes.syntheticEdgeDatasets.length, 5);

    // 2. Mode S monorepo generates DS consumer & maintainer personas
    const dsDir = join(scratch, "ds-mono");
    mkdirSync(join(dsDir, "packages/design/tokens"), { recursive: true });
    mkdirSync(join(dsDir, "packages/design/src/components"), { recursive: true });
    writeFileSync(join(dsDir, "packages/design/package.json"), JSON.stringify({ name: "@acme/ui", exports: { ".": "./dist/index.js" } }));
    writeFileSync(join(dsDir, "packages/design/tokens/color.json"), JSON.stringify({ light: { bg: { $type: "color", $value: "#F7F8FA" } } }));
    writeFileSync(join(dsDir, "packages/design/src/components/Button.stories.tsx"), "export default {};");
    writeFileSync(join(dsDir, "packages/design/src/components/Badge.stories.tsx"), "export default {};");
    const dsPersonas = generatePersonas(dsDir, { depth: "deep" });
    assert.equal(dsPersonas.recommendedMode, "S");
    assert.equal(dsPersonas.personaCount, 8);
    assert.ok(dsPersonas.personas.some((p) => p.id === "P07" && /Token/.test(p.name)));

    const md = formatPersonasMarkdown(dsPersonas);
    assert.match(md, /DSAF Multi-Axis Persona Matrix/);
    assert.match(md, /`P08`/);

    console.log("DSAF_PERSONAS_SELF_TEST_PASSED (Mode P/S + quick 5 / deep 8 + orthogonal axes + cognitive checklist)");
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
      depth: { type: "string", default: "deep" },
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
        `DSAF v${PERSONAS_VERSION} — Deterministic Multi-Axis Persona Generator`,
        "Usage:",
        "  dsaf personas [target] [--depth quick|deep] [--out <personas.json>] [--markdown <personas.md>] [--json]",
        "  dsaf personas --self-test",
      ].join("\n")
    );
    process.exit(0);
  }

  if (values["self-test"]) {
    process.exit(runSelfTest());
  }

  const target = positionals[0] || ".";
  const report = generatePersonas(target, { depth: values.depth });
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
      `DSAF_PERSONAS v${PERSONAS_VERSION}: ${report.repository} [Mode ${report.recommendedMode}, ${report.surfaceMode}] -> ${report.personaCount} personas (${report.depth})`
    );
    for (const p of report.personas) {
      console.log(`  - ${p.id} ${p.name} [${p.axis}] (${p.viewport})`);
    }
  }
}
