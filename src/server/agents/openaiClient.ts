import OpenAI from "openai";
import { config } from "../config.js";
import { AppError, setupHelp } from "../lib/errors.js";
import { getCustomerAccountFromContext } from "../state/requestContext.js";

export function getOpenAIClientForRequest() {
  const credential = getOpenAICredentialForRequest();
  return new OpenAI({ apiKey: credential.apiKey });
}

export function getOpenAICredentialForRequest() {
  const account = getCustomerAccountFromContext();
  const customerApiKey = account?.openai?.apiKey?.trim();

  if (customerApiKey) {
    return {
      apiKey: customerApiKey,
      source: "user" as const
    };
  }

  if (config.allowPlatformOpenAIFallback && config.openaiApiKey) {
    return {
      apiKey: config.openaiApiKey,
      source: "platform" as const
    };
  }

  throw new AppError("OpenAI API key is not connected.", {
    statusCode: 401,
    code: "OPENAI_CLIENT_NOT_CONNECTED",
    setupInstructions: setupHelp.openaiCustomer
  });
}

export function getResponseErrorDetails(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const res = response as {
    error?: { code?: string; message?: string } | null;
    incomplete_details?: { reason?: string } | null;
  };
  const parts: string[] = [];
  if (res.error) {
    parts.push(`API Error: [${res.error.code ?? "unknown"}] ${res.error.message ?? ""}`);
  }
  if (res.incomplete_details?.reason) {
    parts.push(`Incomplete generation reason: ${res.incomplete_details.reason}`);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

