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
  ),
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
              "Keep the project compact enough to build quickly while satisfying the request."
            ].join("\n")
          },
          {
            role: "user",
            content: [
              `Structured requirements:\n${JSON.stringify(requirements, null, 2)}`,
              "",
              `Prompt plan:\n${JSON.stringify(promptPlan, null, 2)}`,
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
              "- Do not include raw file content in any JSON field."
            ].join("\n")
          }
        ],
        text: {
          format: zodTextFormat(EncodedGeneratedProjectSchema, "generated_project")
        },
        reasoning: { effort: "high" },
        max_output_tokens: 22000
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
      throw new AppError("Codex returned no generated project files.", {
        code: "CODEX_MALFORMED_RESPONSE",
        statusCode: 502
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
