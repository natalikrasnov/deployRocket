import fs from "node:fs/promises";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { config } from "../config.js";
import { AppError, setupHelp } from "../lib/errors.js";
import type { ProjectInputRecord, StructuredRequirements } from "../../shared/types.js";

const StructuredRequirementsSchema = z.object({
  projectName: z.string(),
  summary: z.string(),
  intent: z.string(),
  targetUsers: z.array(z.string()),
  coreFeatures: z.array(z.string()),
  screens: z.array(z.string()),
  designDirection: z.string(),
  constraints: z.array(z.string()),
  imageContext: z.array(z.string()),
  repositoryNameSuggestion: z.string()
});

export class InputProcessor {
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

  async process(input: ProjectInputRecord, signal: AbortSignal): Promise<StructuredRequirements> {
    const client = this.getClient();
    const content: Array<
      | { type: "input_text"; text: string }
      | { type: "input_image"; image_url: string; detail: "auto" }
    > = [
      {
        type: "input_text",
        text: [
          "Convert this raw mobile project request into structured software requirements.",
          "Infer a concise project name and summary.",
          "If images are present, use them as visual/product context.",
          "Do not invent credentials, external services, or impossible deployment capabilities.",
          "",
          `User text:\n${input.text || "(no text supplied; rely on images if present)"}`
        ].join("\n")
      }
    ];

    for (const image of input.images) {
      const buffer = await fs.readFile(image.path);
      content.push({
        type: "input_image",
        image_url: `data:${image.mimeType};base64,${buffer.toString("base64")}`,
        detail: "auto"
      });
    }

    const response = await client.responses.parse(
      {
        model: config.openaiModel,
        input: [
          {
            role: "system",
            content:
              "You are Agent 1, the Input Processor for a mobile-first Codex project orchestration product. Produce precise, implementation-ready requirements."
          },
          {
            role: "user",
            content
          }
        ],
        text: {
          format: zodTextFormat(StructuredRequirementsSchema, "structured_requirements")
        },
        reasoning: { effort: "low" },
        max_output_tokens: 2500
      },
      { signal }
    );

    if (!response.output_parsed) {
      throw new AppError("OpenAI returned no structured requirements.", {
        code: "OPENAI_MALFORMED_RESPONSE",
        statusCode: 502
      });
    }

    return response.output_parsed;
  }
}

export const inputProcessor = new InputProcessor();
