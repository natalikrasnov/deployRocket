import fs from "node:fs/promises";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { getOpenAIClientForRequest } from "./openaiClient.js";
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
  async process(input: ProjectInputRecord, signal: AbortSignal): Promise<StructuredRequirements> {
    const client = getOpenAIClientForRequest();
    const content: Array<
      | { type: "input_text"; text: string }
      | { type: "input_image"; image_url: string; detail: "auto" }
    > = [
      {
        type: "input_text",
        text: [
          "Convert this raw mobile project request into structured software requirements.",
          "Infer a concise product name, summary, and repository name.",
          "repositoryNameSuggestion must be a clean GitHub slug based on the final product name, not raw instruction words like create/build/client/serverless.",
          "If images are present, use them as visual/product context.",
          "Do not invent credentials, external services, or impossible platform capabilities.",
          "All generated projects must be serverless browser-only web apps that can run from static files on GitHub Pages.",
          "If the user asks for backend, API, database, auth, or scheduled jobs, capture it as client-side simulated behavior using localStorage, in-memory state, or static sample data.",
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

    let response: Awaited<ReturnType<typeof client.responses.parse>>;

    try {
      response = await client.responses.parse(
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
    } catch (error) {
      throw new AppError("OpenAI returned malformed structured requirements JSON.", {
        code: "OPENAI_MALFORMED_RESPONSE",
        statusCode: 502,
        details: error instanceof Error ? error.message : String(error)
      });
    }

    if (!response.output_parsed) {
      throw new AppError("OpenAI returned no structured requirements.", {
        code: "OPENAI_MALFORMED_RESPONSE",
        statusCode: 502
      });
    }

    return response.output_parsed as StructuredRequirements;
  }
}

export const inputProcessor = new InputProcessor();
