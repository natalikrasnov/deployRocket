import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { config } from "../config.js";
import { AppError, setupHelp } from "../lib/errors.js";
import type {
  CodexPromptPlan,
  GeneratedFile,
  GeneratedProject,
  StructuredRequirements
} from "../../shared/types.js";

const EncodedGeneratedProjectSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      contentBase64: z.string()
    })
  ).min(1),
  implementationSummary: z.string(),
  setupNotes: z.array(z.string()),
  warnings: z.array(z.string())
});

type EncodedGeneratedProject = z.infer<typeof EncodedGeneratedProjectSchema>;

const blockedPathPatterns = [
  /^\/|^[a-zA-Z]:/,
  /\.\./,
  /^node_modules\//,
  /^\.git\//,
  /^dist\//,
  /^build\//,
  /^\.env/
];

export class CodexRunner {
  private client: OpenAI | null = null;

  private getClient() {
    if (!config.openaiApiKey) {
      throw new AppError("OpenAI is not configured.", {
        statusCode: 500,
        code: "OPENAI_NOT_CONFIGURED",
        setupInstructions: setupHelp.openai
      });
    }

    this.client ??= new OpenAI({ apiKey: config.openaiApiKey });
    return this.client;
  }

  async generateProject(
    requirements: StructuredRequirements,
    promptPlan: CodexPromptPlan,
    previousFiles: GeneratedFile[],
    signal: AbortSignal,
    continueContext?: string
  ): Promise<{ runId: string; generated: GeneratedProject }> {
    const client = this.getClient();

    let response: Awaited<ReturnType<typeof client.responses.parse>>;

    try {
      response = await client.responses.parse(
      {
        model: config.openaiCodexModel,
        input: [
          {
            role: "system",
            content: [
              "You are Agent 3, the Codex Runner.",
              "Generate or modify a deployable software project.",
              "Return only files through the required JSON schema.",
              "Every file content must be UTF-8 encoded as base64 in contentBase64.",
              "Never place raw source code, markdown, quotes, or multiline text directly in JSON string fields.",
              "All code must be real, cohesive, and buildable.",
              "The target deployment platform is GitHub Pages using GitHub Actions.",
              "The project must be a static Vite React TypeScript application.",
              "Do not include secrets, API keys, local absolute paths, package-lock.json, node_modules, binary files, or TODO placeholders.",
              "Keep the project compact enough to build quickly while satisfying the request.",
              "Prefer a complete compact v1 over a sprawling multi-file app that risks truncation.",
              "For broad product requests, implement the core flows in 6 to 14 source files using local browser state or localStorage.",
              "Do not include binary image assets; use CSS gradients, inline data objects, and generated visual treatments."
            ].join("\n")
          },
          {
            role: "user",
            content: [
              `Structured requirements:\n${JSON.stringify(compactRequirements(requirements), null, 2)}`,
              "",
              `Prompt plan:\n${JSON.stringify(compactPromptPlan(promptPlan), null, 2)}`,
              "",
              previousFiles.length
                ? `Existing files to modify. Return a complete replacement set, not a patch:\n${JSON.stringify(previousFiles, null, 2)}`
                : "This is a new project. Return the complete file set.",
              "",
              continueContext
                ? `Continuation context from a failed deployRocket run. Use this to fix the prior failure and continue, not restart blindly:\n${continueContext}`
                : "No failed-run continuation context is present.",
              "",
              "Required file expectations:",
              "- Return at least one real application file; a response with zero files is invalid.",
              "- package.json with dev, build, and preview scripts.",
              "- index.html.",
              "- src/main.tsx.",
              "- src/App.tsx and any small supporting files needed.",
              "- src/styles.css or equivalent CSS imported by main.tsx.",
              "- README.md with project-specific run notes.",
              "",
              "Do not generate backend code unless the user specifically requested a static client-side simulation of data. GitHub Pages cannot run a server.",
              "Important output rule:",
              "- For each file, set contentBase64 to base64(UTF-8 file content).",
              "- Do not wrap base64 text in markdown fences.",
              "- Do not include raw file content in any JSON field.",
              "- If the requested app is large, generate a compact complete v1 now; future edits can add depth."
            ].join("\n")
          }
        ],
        text: {
          format: zodTextFormat(EncodedGeneratedProjectSchema, "generated_project")
        },
        reasoning: { effort: "high" },
        max_output_tokens: 30000
      },
      { signal }
    );
    } catch (error) {
      throw new AppError("Codex returned malformed generated-file JSON.", {
        code: "CODEX_MALFORMED_RESPONSE",
        statusCode: 502,
        details: error instanceof Error ? error.message : String(error),
        setupInstructions: [
          "Use Edit Mission and retry the generation.",
          "If this repeats, request a smaller first version with fewer files or less visual complexity.",
          "deployRocket now asks Codex to encode file contents safely, so repeated failures usually mean the model response was truncated."
        ]
      });
    }

    const parsed = response.output_parsed as EncodedGeneratedProject | null;

    if (!parsed) {
      return {
        runId: response.id,
        generated: this.normalizeGeneratedProject(
          createRescueGeneratedProject(requirements, promptPlan, summarizeResponseText(response))
        )
      };
    }

    return {
      runId: response.id,
      generated: this.normalizeGeneratedProject(this.decodeGeneratedProject(parsed))
    };
  }

  private decodeGeneratedProject(encoded: EncodedGeneratedProject): GeneratedProject {
    return {
      implementationSummary: encoded.implementationSummary,
      setupNotes: encoded.setupNotes,
      warnings: encoded.warnings,
      files: encoded.files.map((file) => ({
        path: file.path,
        content: decodeBase64FileContent(file.path, file.contentBase64)
      }))
    };
  }

  private normalizeGeneratedProject(generated: GeneratedProject): GeneratedProject {
    const byPath = new Map<string, string>();

    for (const file of generated.files) {
      const normalizedPath = file.path.replace(/\\/g, "/").replace(/^\.\/+/, "");
      if (blockedPathPatterns.some((pattern) => pattern.test(normalizedPath))) {
        throw new AppError(`Codex generated an unsafe file path: ${file.path}`, {
          code: "CODEX_UNSAFE_FILE_PATH",
          statusCode: 502
        });
      }

      if (!file.content.trim()) {
        throw new AppError(`Codex generated an empty file: ${file.path}`, {
          code: "CODEX_EMPTY_FILE",
          statusCode: 502
        });
      }

      byPath.set(normalizedPath, file.content);
    }

    ensureDeploymentFiles(byPath);

    return {
      ...generated,
      files: [...byPath.entries()].map(([path, content]) => ({ path, content }))
    };
  }
}


function createRescueGeneratedProject(
  requirements: StructuredRequirements,
  promptPlan: CodexPromptPlan,
  reason: string
): GeneratedProject {
  const appTitle = requirements.projectName || promptPlan.title || "deployRocket Project";
  const slug = requirements.repositoryNameSuggestion || slugFromTitle(appTitle);
  const features = requirements.coreFeatures.slice(0, 7);
  const screens = requirements.screens.slice(0, 6);
  const moods = buildMoodSeeds(requirements);

  return {
    implementationSummary:
      "Codex did not return a structured generated_project payload, so deployRocket generated a compact static Vite React rescue build from the approved requirements.",
    setupNotes: [
      "Run npm install, then npm run dev for local development.",
      "The app is static and deploys to GitHub Pages with the included workflow.",
      "Use Edit Mission later to ask Codex for richer follow-up features."
    ],
    warnings: [
      "Codex response was not parseable as generated files; deployRocket committed a compact rescue implementation instead.",
      reason
    ],
    files: [
      { path: "package.json", content: rescuePackageJson(appTitle) },
      { path: "index.html", content: rescueIndexHtml(appTitle) },
      { path: "vite.config.ts", content: rescueViteConfig() },
      { path: "tsconfig.json", content: rescueTsconfig() },
      { path: "src/main.tsx", content: rescueMainTsx() },
      { path: "src/App.tsx", content: rescueAppTsx(appTitle, requirements.summary, features, screens, moods) },
      { path: "src/styles.css", content: rescueStylesCss() },
      { path: "README.md", content: rescueReadme(appTitle, requirements.summary, slug) }
    ]
  };
}

function rescuePackageJson(appTitle: string) {
  return JSON.stringify(
    {
      name: slugFromTitle(appTitle),
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: {
        dev: "vite --host 0.0.0.0",
        build: "tsc && vite build",
        preview: "vite preview --host 0.0.0.0"
      },
      dependencies: {
        "@vitejs/plugin-react": "^5.0.0",
        vite: "^7.0.0",
        typescript: "^5.9.0",
        react: "^19.0.0",
        "react-dom": "^19.0.0"
      },
      devDependencies: {
        "@types/react": "^19.0.0",
        "@types/react-dom": "^19.0.0"
      }
    },
    null,
    2
  );
}

function rescueIndexHtml(appTitle: string) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    <title>${escapeHtml(appTitle)}</title>`,
    "  </head>",
    "  <body>",
    '    <div id="root"></div>',
    '    <script type="module" src="/src/main.tsx"></script>',
    "  </body>",
    "</html>",
    ""
  ].join("\n");
}

function rescueViteConfig() {
  return `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repository = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "";
const base = repository && !repository.endsWith(".github.io") ? "/" + repository + "/" : "/";

export default defineConfig({
  base,
  plugins: [react()]
});
`;
}

function rescueTsconfig() {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        useDefineForClassFields: true,
        lib: ["DOM", "DOM.Iterable", "ES2022"],
        allowJs: false,
        skipLibCheck: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        strict: true,
        forceConsistentCasingInFileNames: true,
        module: "ESNext",
        moduleResolution: "Bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: "react-jsx"
      },
      include: ["src"]
    },
    null,
    2
  );
}

function rescueMainTsx() {
  return `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;
}

function rescueAppTsx(
  appTitle: string,
  summary: string,
  features: string[],
  screens: string[],
  moods: Array<{ id: string; name: string; palette: string; tags: string[] }>
) {
  return `import { type CSSProperties, type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";

type ClosetItem = {
  id: string;
  name: string;
  category: string;
  image: string;
  tags: string[];
};

const project = ${JSON.stringify({ appTitle, summary, features, screens }, null, 2)};
const moods = ${JSON.stringify(moods, null, 2)};
const categories = ["top", "bottom", "shoes", "outerwear", "accessory"];

export default function App() {
  const [selectedMood, setSelectedMood] = useState(moods[0]);
  const [closet, setCloset] = useStoredCloset();
  const [cameraStatus, setCameraStatus] = useState("Camera is off");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const suggestion = useMemo(() => buildSuggestion(closet, selectedMood), [closet, selectedMood]);

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraStatus("Live mirror is running on this device");
    } catch (error) {
      setCameraStatus(error instanceof Error ? error.message : "Camera permission was denied");
    }
  }

  function addClosetFiles(files: FileList | null) {
    if (!files?.length) return;
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const category = categories[closet.length % categories.length];
        const item: ClosetItem = {
          id: String(Date.now()) + Math.random().toString(16).slice(2),
          name: file.name.replace(/\\.[^.]+$/, ""),
          category,
          image: String(reader.result),
          tags: [selectedMood.id, category]
        };
        setCloset((current) => [item, ...current]);
      };
      reader.readAsDataURL(file);
    });
  }

  return (
    <main className="shell" style={{ "--mood-palette": selectedMood.palette } as CSSProperties}>
      <section className="hero">
        <div>
          <p className="eyebrow">Mood based virtual mirror</p>
          <h1>{project.appTitle}</h1>
          <p className="summary">{project.summary}</p>
          <div className="actions">
            <button onClick={startCamera}>Start mirror</button>
            <button className="secondary" onClick={() => fileRef.current?.click()}>Upload clothes</button>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(event) => addClosetFiles(event.target.files)} />
          </div>
        </div>
        <div className="mirror-card">
          <div className="video-frame">
            <video ref={videoRef} autoPlay playsInline muted />
            <div className="mood-overlay" />
            <span>{cameraStatus}</span>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>Mood backgrounds</h2>
          <p>Choose a mood. The mirror palette and outfit agent respond instantly.</p>
        </div>
        <div className="mood-grid">
          {moods.map((mood) => (
            <button key={mood.id} className={mood.id === selectedMood.id ? "mood active" : "mood"} onClick={() => setSelectedMood(mood)}>
              <span style={{ background: mood.palette }} />
              {mood.name}
            </button>
          ))}
        </div>
      </section>

      <section className="grid-two">
        <div className="panel">
          <div className="section-heading">
            <h2>Closet</h2>
            <p>{closet.length ? closet.length + " uploaded items" : "Upload clothing photos to start building looks."}</p>
          </div>
          <div className="closet-grid">
            {closet.map((item) => (
              <article key={item.id} className="closet-card">
                <img src={item.image} alt={item.name} />
                <div>
                  <strong>{item.name}</strong>
                  <small>{item.category} / {item.tags.join(", ")}</small>
                </div>
                <button aria-label="Remove item" onClick={() => setCloset((current) => current.filter((entry) => entry.id !== item.id))}>Remove</button>
              </article>
            ))}
          </div>
        </div>

        <div className="panel agent-panel">
          <div className="section-heading">
            <h2>Outfit agent</h2>
            <p>{suggestion.reason}</p>
          </div>
          <div className="suggestion-list">
            {suggestion.items.map((item) => (
              <div key={item.id} className="suggestion-row">
                <img src={item.image} alt="" />
                <span>{item.name}</span>
              </div>
            ))}
            {!suggestion.items.length ? <p className="empty">Add a few closet items and the agent will suggest a mood-matched look.</p> : null}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>Implemented v1 scope</h2>
          <p>This compact build is ready for GitHub Pages and can be expanded with future deployRocket edits.</p>
        </div>
        <div className="feature-grid">
          {project.features.map((feature) => <span key={feature}>{feature}</span>)}
        </div>
      </section>
    </main>
  );
}

function useStoredCloset(): [ClosetItem[], Dispatch<SetStateAction<ClosetItem[]>>] {
  const [items, setItems] = useState<ClosetItem[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("deployrocket.closet") ?? "[]") as ClosetItem[];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem("deployrocket.closet", JSON.stringify(items));
  }, [items]);

  return [items, setItems];
}

function buildSuggestion(items: ClosetItem[], mood: { id: string; name: string; tags: string[] }) {
  const scored = [...items]
    .map((item) => ({ item, score: item.tags.filter((tag) => mood.tags.includes(tag) || tag === mood.id).length }))
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item)
    .slice(0, 4);

  return {
    items: scored,
    reason: scored.length
      ? "Matched to " + mood.name + " using closet tags and categories."
      : "Waiting for closet uploads before styling this mood."
  };
}
`;
}

function rescueStylesCss() {
  return `:root {
  color: #f8fafc;
  background: #060811;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: #060811; }
button { font: inherit; }
.shell {
  min-height: 100vh;
  padding: 24px;
  background:
    radial-gradient(circle at 80% 0%, color-mix(in srgb, var(--mood-palette) 35%, transparent), transparent 36rem),
    linear-gradient(145deg, #060811 0%, #101522 55%, #08111b 100%);
}
.hero {
  display: grid;
  gap: 24px;
  align-items: stretch;
  max-width: 1180px;
  margin: 0 auto 24px;
}
.eyebrow { color: #67e8f9; text-transform: uppercase; letter-spacing: .16em; font-size: .75rem; font-weight: 700; }
h1 { margin: 0; font-size: clamp(2.25rem, 8vw, 5.5rem); line-height: .95; }
.summary { max-width: 680px; color: #cbd5e1; font-size: 1.08rem; line-height: 1.7; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 22px; }
.actions button, .closet-card button {
  border: 0;
  border-radius: 14px;
  padding: 12px 16px;
  color: #061018;
  background: #67e8f9;
  font-weight: 800;
  cursor: pointer;
}
.actions .secondary, .closet-card button { background: rgba(255,255,255,.1); color: #f8fafc; border: 1px solid rgba(255,255,255,.14); }
.mirror-card, .panel {
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 22px;
  background: rgba(8, 13, 24, .74);
  box-shadow: 0 24px 80px rgba(0,0,0,.35);
}
.mirror-card { padding: 14px; }
.video-frame { position: relative; min-height: 420px; overflow: hidden; border-radius: 18px; background: #020617; display: grid; place-items: center; }
.video-frame video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); }
.mood-overlay { position: absolute; inset: 0; background: var(--mood-palette); mix-blend-mode: screen; opacity: .32; }
.video-frame span { position: relative; z-index: 1; border-radius: 999px; background: rgba(0,0,0,.55); padding: 10px 14px; color: #e2e8f0; }
.panel { max-width: 1180px; margin: 0 auto 24px; padding: 18px; }
.section-heading { display: flex; gap: 12px; justify-content: space-between; align-items: end; margin-bottom: 16px; }
h2 { margin: 0; font-size: 1.25rem; }
.section-heading p, .empty { margin: 0; color: #94a3b8; line-height: 1.6; }
.mood-grid, .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.mood, .feature-grid span {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 14px;
  background: rgba(255,255,255,.04);
  color: #e2e8f0;
  padding: 12px;
}
.mood { cursor: pointer; text-align: left; }
.mood.active { border-color: #67e8f9; background: rgba(103,232,249,.12); }
.mood span { width: 26px; height: 26px; border-radius: 10px; }
.grid-two { max-width: 1180px; margin: 0 auto; display: grid; gap: 24px; }
.grid-two .panel { margin: 0; }
.closet-grid, .suggestion-list { display: grid; gap: 12px; }
.closet-card, .suggestion-row { display: grid; grid-template-columns: 64px 1fr auto; align-items: center; gap: 12px; border-radius: 16px; background: rgba(255,255,255,.045); padding: 10px; }
.closet-card img, .suggestion-row img { width: 64px; height: 64px; object-fit: cover; border-radius: 12px; background: #111827; }
.closet-card small { display: block; color: #94a3b8; margin-top: 4px; }
.agent-panel { border-color: color-mix(in srgb, var(--mood-palette) 55%, rgba(255,255,255,.1)); }
@media (min-width: 820px) {
  .hero, .grid-two { grid-template-columns: 1fr 1fr; }
  .shell { padding: 42px; }
}
@media (max-width: 560px) {
  .section-heading { display: block; }
  .closet-card { grid-template-columns: 56px 1fr; }
  .closet-card button { grid-column: 1 / -1; }
}
`;
}

function rescueReadme(appTitle: string, summary: string, slug: string) {
  return [
    "# " + appTitle,
    "",
    summary,
    "",
    "Generated by deployRocket as a compact static Vite React rescue build after Codex did not return a structured file payload.",
    "",
    "## Run locally",
    "",
    "```bash",
    "npm install",
    "npm run dev",
    "```",
    "",
    "## Build",
    "",
    "```bash",
    "npm run build",
    "npm run preview",
    "```",
    "",
    "## GitHub Pages",
    "",
    "This project includes a Pages workflow and Vite base-path config for repository `" + slug + "`.",
    ""
  ].join("\n");
}

function buildMoodSeeds(requirements: StructuredRequirements) {
  const source = [requirements.designDirection, ...requirements.coreFeatures, ...requirements.screens].join(" ").toLowerCase();
  const base = [
    { id: "cozy", name: "Cozy", palette: "linear-gradient(135deg, #f97316, #7c2d12)", tags: ["cozy", "warm", "casual", "outerwear"] },
    { id: "work", name: "Work", palette: "linear-gradient(135deg, #22d3ee, #1e3a8a)", tags: ["work", "formal", "top", "shoes"] },
    { id: "night", name: "Night Out", palette: "linear-gradient(135deg, #a855f7, #111827)", tags: ["night", "formal", "accessory", "black"] },
    { id: "sport", name: "Sport", palette: "linear-gradient(135deg, #84cc16, #0f766e)", tags: ["sport", "casual", "shoes"] },
    { id: "beach", name: "Beach", palette: "linear-gradient(135deg, #38bdf8, #facc15)", tags: ["beach", "summer", "light"] }
  ];
  if (source.includes("rain")) base.unshift({ id: "rain", name: "Rainy Day", palette: "linear-gradient(135deg, #64748b, #0f172a)", tags: ["rain", "outerwear", "boots"] });
  return base.slice(0, 6);
}

function slugFromTitle(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "deployrocket-project";
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function compactRequirements(requirements: StructuredRequirements) {
  return {
    projectName: requirements.projectName,
    summary: requirements.summary,
    intent: requirements.intent,
    coreFeatures: requirements.coreFeatures.slice(0, 8),
    screens: requirements.screens.slice(0, 8),
    designDirection: requirements.designDirection,
    constraints: requirements.constraints.slice(0, 6),
    repositoryNameSuggestion: requirements.repositoryNameSuggestion
  };
}

function compactPromptPlan(promptPlan: CodexPromptPlan) {
  return {
    title: promptPlan.title,
    summary: promptPlan.summary,
    architectureInstructions: promptPlan.architectureInstructions.slice(0, 5),
    frontendInstructions: promptPlan.frontendInstructions.slice(0, 8),
    backendInstructions: promptPlan.backendInstructions.slice(0, 3),
    deploymentInstructions: promptPlan.deploymentInstructions.slice(0, 4),
    acceptanceCriteria: promptPlan.acceptanceCriteria.slice(0, 8)
  };
}

function summarizeResponseText(response: unknown) {
  const maybeText = response && typeof response === "object" && "output_text" in response
    ? String((response as { output_text?: unknown }).output_text ?? "")
    : "";
  if (maybeText.trim()) return maybeText.slice(0, 4000);

  const id = response && typeof response === "object" && "id" in response
    ? String((response as { id?: unknown }).id ?? "unknown")
    : "unknown";
  return `OpenAI response ${id} did not contain a parsed generated_project payload.`;
}

function decodeBase64FileContent(path: string, contentBase64: string) {
  try {
    const normalized = contentBase64.replace(/\s+/g, "");
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    if (!decoded.trim()) {
      throw new Error("Decoded content is empty.");
    }
    return decoded;
  } catch (error) {
    throw new AppError(`Codex generated invalid base64 content for: ${path}`, {
      code: "CODEX_INVALID_FILE_ENCODING",
      statusCode: 502,
      details: error instanceof Error ? error.message : String(error)
    });
  }
}

function ensureDeploymentFiles(files: Map<string, string>) {
  if (!files.has("package.json")) {
    files.set(
      "package.json",
      JSON.stringify(
        {
          scripts: {
            dev: "vite --host 0.0.0.0",
            build: "tsc && vite build",
            preview: "vite preview --host 0.0.0.0"
          },
          dependencies: {
            "@vitejs/plugin-react": "^5.0.0",
            typescript: "^5.9.0",
            vite: "^7.0.0",
            react: "^19.0.0",
            "react-dom": "^19.0.0"
          },
          devDependencies: {}
        },
        null,
        2
      )
    );
  }

  if (!files.has("vite.config.ts")) {
    files.set(
      "vite.config.ts",
      `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repository = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "";
const base = repository && !repository.endsWith(".github.io") ? \`/\${repository}/\` : "/";

export default defineConfig({
  base,
  plugins: [react()]
});
`
    );
  }

  if (!files.has("tsconfig.json")) {
    files.set(
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            useDefineForClassFields: true,
            lib: ["DOM", "DOM.Iterable", "ES2022"],
            allowJs: false,
            skipLibCheck: true,
            esModuleInterop: true,
            allowSyntheticDefaultImports: true,
            strict: true,
            forceConsistentCasingInFileNames: true,
            module: "ESNext",
            moduleResolution: "Bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            noEmit: true,
            jsx: "react-jsx"
          },
          include: ["src"]
        },
        null,
        2
      )
    );
  }

  files.set(
    ".github/workflows/pages.yml",
    `name: Deploy to GitHub Pages

on:
  push:
    branches: ["main"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install dependencies
        run: npm install
      - name: Build
        run: npm run build
      - name: Configure Pages
        uses: actions/configure-pages@v5
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`
  );

  files.set(".nojekyll", "");
}

export const codexRunner = new CodexRunner();
