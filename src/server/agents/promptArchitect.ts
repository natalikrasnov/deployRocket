import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { getOpenAIClientForRequest } from "./openaiClient.js";
import type {
  CodexPromptPlan,
  GeneratedFile,
  StructuredRequirements
} from "../../shared/types.js";

const CodexPromptPlanSchema = z.object({
  title: z.string(),
  summary: z.string(),
  architectureInstructions: z.array(z.string()),
  frontendInstructions: z.array(z.string()),
  backendInstructions: z.array(z.string()),
  modificationInstructions: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  codexPrompt: z.string()
});

export class PromptArchitect {
  async createPromptPlan(
    requirements: StructuredRequirements,
    mode: "create" | "edit",
    previousFiles: GeneratedFile[],
    userText: string,
    signal: AbortSignal
  ): Promise<CodexPromptPlan> {
    const client = getOpenAIClientForRequest();
    const previousManifest = previousFiles.map((file) => file.path);

    const response = await client.responses.parse(
      {
        model: config.openaiModel,
        input: [
          {
            role: "system",
            content: [
              "You are Agent 2, the Prompt Architect.",
              "Turn product requirements into a high-quality Codex implementation prompt.",
              "The downstream project must be a static Vite React TypeScript application.",
              "The generated app must be serverless and browser-only so it can deploy to GitHub Pages.",
              "Do not request secrets, backend code, server-side services, serverless functions, databases, or private APIs in generated code.",
              "Represent any backend-like behavior with localStorage, in-memory state, or static sample data."
            ].join("\n")
          },
          {
            role: "user",
            content: [
              `Mode: ${mode}`,
              `Raw edit/create text:\n${userText || "(image-only request)"}`,
              `Structured requirements:\n${JSON.stringify(requirements, null, 2)}`,
              `Existing file paths:\n${previousManifest.length ? previousManifest.join("\n") : "(none)"}`,
              "",
              "Produce a prompt that tells Codex to return a complete replacement file set.",
              "The generated app should be production-oriented, mobile-first, accessible, and visually polished.",
              "The generated app must build into static assets that work on GitHub Pages, including repository subpath deployments.",
              "It must include buildable Vite React TypeScript files and avoid placeholder TODOs."
            ].join("\n")
          }
        ],
        text: {
          format: zodTextFormat(CodexPromptPlanSchema, "codex_prompt_plan")
        },
        reasoning: { effort: "medium" },
        max_output_tokens: 3500
      },
      { signal }
    );

    if (!response.output_parsed) {
      throw new AppError("OpenAI returned no Codex prompt plan.", {
        code: "OPENAI_MALFORMED_RESPONSE",
        statusCode: 502
      });
    }

    return response.output_parsed;
  }
}

export const promptArchitect = new PromptArchitect();
