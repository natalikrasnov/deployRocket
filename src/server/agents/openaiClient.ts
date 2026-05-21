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
