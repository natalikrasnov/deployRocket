import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { getOpenAIClientForRequest, getResponseErrorDetails } from "./openaiClient.js";
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

const serverOnlyPathPatterns = [
  /^api\//,
  /^backend\//,
  /^server\//,
  /^src\/server\//,
  /^functions\//,
  /^netlify\/functions\//,
  /^\.vercel\//,
  /^vercel\.json$/,
  /^server\.[cm]?[jt]sx?$/,
  /^docker-compose\./,
  /^Dockerfile$/
];

export class CodexRunner {
  async generateProject(
    requirements: StructuredRequirements,
    promptPlan: CodexPromptPlan,
    previousFiles: GeneratedFile[],
    signal: AbortSignal,
    continueContext?: string
  ): Promise<{ runId: string; generated: GeneratedProject }> {
    const client = getOpenAIClientForRequest();

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
              "Generate or modify a buildable software project.",
              "Return only files through the required JSON schema.",
              "Every file content must be UTF-8 encoded as base64 in contentBase64.",
              "Never place raw source code, markdown, quotes, or multiline text directly in JSON string fields.",
              "All code must be real, cohesive, and buildable.",
              "The project must be a static Vite React TypeScript application.",
              "The project must be serverless and browser-only: no backend, no server runtime, no API routes, no serverless functions, no database service, and no required secrets.",
              "The built app must run from static files on GitHub Pages, including repository subpath deployments.",
              "Configure Vite with a GitHub Pages-safe relative asset base, such as base: \"./\".",
              "Use localStorage, in-memory state, static JSON, or client-side mock flows for persistence and backend-like behavior.",
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
                ? [
                    "This is an edit of an existing project.",
                    "Implement the requested modifications in the returned files.",
                    "Returning an identical file set is invalid.",
                    "Changing only README/setup notes is invalid for an edit; at least one runtime app file must change visibly.",
                    "Return a complete replacement set, not a patch:",
                    JSON.stringify(previousFiles, null, 2)
                  ].join("\n")
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
              "- vite.config.ts with a relative base so built assets work from a GitHub Pages project path.",
              "- README.md with project-specific run notes.",
              "",
              "Do not generate backend code, API routes, serverless functions, database clients, or server-only package scripts. If the user asks for those capabilities, implement a static client-side simulation instead. deployRocket saves the generated Vite build files to GitHub.",
              "Important output rule:",
              "- For each file, set contentBase64 to base64(UTF-8 file content).",
              "- Do not wrap base64 text in markdown fences.",
              "- Do not include raw file content in any JSON field.",
              previousFiles.length
                ? "- For edits, at least one app-impacting file such as src/*, public/*, index.html, package.json, vite.config.*, tailwind.config.*, postcss.config.*, or a CSS file must differ from the existing project."
                : "- If the requested app is large, generate a compact complete v1 now; future edits can add depth.",
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
      const quotaFailure = parseOpenAiQuotaFailure(error);

      if (quotaFailure) {
        throw new AppError("OpenAI quota exceeded for Codex generation.", {
          code: "OPENAI_QUOTA_EXCEEDED",
          statusCode: 402,
          details: quotaFailure.details,
          setupInstructions: [
            "Open deployRocket Settings and verify your OpenAI API key is correct.",
            "In OpenAI billing, add credits or increase your usage limits for the key you connected.",
            "After billing is fixed, click Continue Mission to retry generation."
          ]
        });
      }

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
      throw new AppError("Codex returned no generated files.", {
        code: "CODEX_EMPTY_RESPONSE",
        statusCode: 502,
        details: summarizeResponseText(response),
        setupInstructions: [
          "deployRocket will retry generation with a smaller repair brief.",
          "No files were committed."
        ]
      });
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
    const removedServerOnlyPaths: string[] = [];

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

      if (serverOnlyPathPatterns.some((pattern) => pattern.test(normalizedPath))) {
        removedServerOnlyPaths.push(normalizedPath);
        continue;
      }

      byPath.set(normalizedPath, file.content);
    }

    ensureBuildFiles(byPath);

    return {
      ...generated,
      warnings: removedServerOnlyPaths.length
        ? [
            ...generated.warnings,
            `Removed server-only files so the generated app remains GitHub Pages compatible: ${removedServerOnlyPaths.join(", ")}`
          ]
        : generated.warnings,
      files: [...byPath.entries()].map(([path, content]) => ({ path, content }))
    };
  }
}

function parseOpenAiQuotaFailure(error: unknown): { details: string } | null {
  if (!error || typeof error !== "object") return null;

  const candidate = error as {
    message?: unknown;
    status?: unknown;
    code?: unknown;
    error?: { code?: unknown; message?: unknown; type?: unknown };
  };

  const status = typeof candidate.status === "number" ? candidate.status : undefined;
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const nestedCode = typeof candidate.error?.code === "string" ? candidate.error.code : "";
  const topLevelCode = typeof candidate.code === "string" ? candidate.code : "";
  const text = [message, nestedCode, topLevelCode].join(" ").toLowerCase();
  const looksLikeQuota = status === 429 && (text.includes("quota") || text.includes("billing") || text.includes("rate_limit_exceeded"));

  if (!looksLikeQuota) return null;

  return {
    details: message || "OpenAI returned HTTP 429 due to quota/billing limits."
  };
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
    modificationInstructions: promptPlan.modificationInstructions.slice(0, 8),
    backendInstructions: [
      "No backend, server runtime, API routes, serverless functions, databases, secrets, or server-only package scripts. Simulate backend-like behavior in the browser only."
    ],
    acceptanceCriteria: promptPlan.acceptanceCriteria.slice(0, 8),
    codexPrompt: promptPlan.codexPrompt.slice(0, 6000)
  };
}

function summarizeResponseText(response: unknown) {
  const errorDetails = getResponseErrorDetails(response);
  if (errorDetails) return errorDetails;

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

function ensureBuildFiles(files: Map<string, string>) {
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

  if (!files.has("index.html")) {
    files.set("index.html", defaultIndexHtml());
  }

  if (!files.has("src/main.tsx")) {
    files.set("src/main.tsx", defaultMainTsx());
  }

  if (!files.has("src/App.tsx")) {
    files.set("src/App.tsx", defaultAppTsx());
  }

  if (!files.has("src/styles.css")) {
    files.set("src/styles.css", "");
  }

  ensureGithubPagesViteConfig(files);

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

  files.delete(".github/workflows/pages.yml");
  files.delete(".nojekyll");
}

function ensureGithubPagesViteConfig(files: Map<string, string>) {
  const configPath = files.has("vite.config.ts")
    ? "vite.config.ts"
    : files.has("vite.config.js")
      ? "vite.config.js"
      : "vite.config.ts";

  const current = files.get(configPath);
  if (!current) {
    files.set(configPath, defaultViteConfig());
    return;
  }

  if (/\bbase\s*:/.test(current)) return;

  const withBase = current.replace(/defineConfig\(\s*{/, 'defineConfig({\n  base: "./",');
  files.set(configPath, withBase === current ? defaultViteConfig() : withBase);
}

function defaultViteConfig() {
  return `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./"
});
`;
}

function defaultIndexHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>deployRocket Project</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

function defaultMainTsx() {
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

function defaultAppTsx() {
  return `export default function App() {
  return null;
}
`;
}

export const codexRunner = new CodexRunner();
