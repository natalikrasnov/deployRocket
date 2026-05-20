import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { config } from "../config.js";
import { AppError, setupHelp } from "../lib/errors.js";
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
  deploymentInstructions: z.array(z.string()),
  modificationInstructions: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  codexPrompt: z.string()
});

export class PromptArchitect {
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

  async createPromptPlan(
    requirements: StructuredRequirements,
    mode: "create" | "edit",
    previousFiles: GeneratedFile[],
    userText: string,
    signal: AbortSignal
  ): Promise<CodexPromptPlan> {
    const client = this.getClient();
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
              "The downstream project must be deployable to Vercel as a static Vite React TypeScript application.",
              "Do not request secrets or server-side services in generated code."
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
