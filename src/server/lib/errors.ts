export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: string;
  readonly setupInstructions?: string[];

  constructor(
    message: string,
    options: {
      statusCode?: number;
      code?: string;
      details?: string;
      setupInstructions?: string[];
    } = {}
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? "APP_ERROR";
    this.details = options.details;
    this.setupInstructions = options.setupInstructions;
  }
}

export function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message.toLowerCase().includes("abort") ||
      error.message.toLowerCase().includes("cancel"))
  );
}

export function toReadableError(error: unknown) {
  if (error instanceof AppError) return error;

  if (error instanceof Error) {
    return new AppError(error.message, {
      code: "UNEXPECTED_ERROR",
      details: error.stack
    });
  }

  return new AppError("An unknown error occurred.", {
    code: "UNKNOWN_ERROR",
    details: String(error)
  });
}

export const setupHelp = {
  openai: [
    "Add OPENAI_API_KEY to .env.",
    "Restart the backend so the new environment variable is loaded.",
    "Make sure the key has access to the configured OpenAI model."
  ],
  githubOAuth: [
    "Create a GitHub OAuth App in GitHub Developer settings.",
    "Set the callback URL to the GITHUB_CALLBACK_URL value from .env.",
    "Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to .env, then restart the backend."
  ],
  githubToken: [
    "Use the Connect GitHub button in the app.",
    "Authorize repository, workflow, and Pages access.",
    "Return to the app and retry the project run."
  ],
  githubTokenInvalid: [
    "Disconnect GitHub from this app, then connect again.",
    "Confirm the OAuth app has repo and workflow permissions.",
    "Retry after the new token is stored."
  ]
};
