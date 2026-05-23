import { AppError } from "../lib/errors.js";
import { createId, nowIso } from "../lib/id.js";
import type {
  Project,
  ProjectAutoRepairAttempt,
  ProjectStatus
} from "../../shared/types.js";

type RepairKind = ProjectAutoRepairAttempt["kind"];

interface RepairPlan {
  attempt: ProjectAutoRepairAttempt;
  currentStep: string;
  actionMessage: string;
  details: string;
  continueContext?: string;
}

type RepairDecision =
  | { type: "repair"; plan: RepairPlan }
  | { type: "terminal"; error: AppError }
  | { type: "pass" };

const maxAttemptsByKind: Record<RepairKind, number> = {
  codex_generation: 2,
  github_conflict: 3,
  github_tree_state: 2,
  github_transient: 2,
  openai_structured_output: 2,
  generated_snapshot: 1
};

const codexRepairCodes = new Set([
  "CODEX_API_FAILURE",
  "CODEX_EMPTY_RESPONSE",
  "CODEX_INVALID_FILE_ENCODING",
  "CODEX_MALFORMED_RESPONSE",
  "CODEX_NO_CHANGES_GENERATED",
  "CODEX_NO_VISIBLE_CHANGES_GENERATED",
  "CODEX_UNSAFE_FILE_PATH",
  "CODEX_EMPTY_FILE"
]);

export class ErrorRepairAgent {
  plan(project: Project, error: AppError): RepairDecision {
    const kind = classifyRepairKind(project, error);
    if (!kind) return { type: "pass" };

    const inputId = project.activeInputId ?? project.inputs.at(-1)?.id;
    const usedAttempts = countAttempts(project, kind, inputId);
    const maxAttempts = maxAttemptsByKind[kind];

    if (usedAttempts >= maxAttempts) {
      return {
        type: "terminal",
        error: terminalRepairError(kind, error, maxAttempts)
      };
    }

    const nextStatus = nextStatusFor(kind, project);
    const attemptNumber = usedAttempts + 1;
    const attempt: ProjectAutoRepairAttempt = {
      id: createId("repair"),
      at: nowIso(),
      kind,
      inputId,
      fromStatus: project.status,
      nextStatus,
      code: error.code,
      message: error.message
    };

    return {
      type: "repair",
      plan: {
        attempt,
        currentStep: currentStepFor(kind),
        actionMessage: actionMessageFor(kind),
        details: [
          `Attempt ${attemptNumber} of ${maxAttempts}.`,
          `Original error: ${error.message}`,
          error.code ? `Code: ${error.code}` : null
        ].filter(Boolean).join("\n"),
        continueContext: continueContextFor(kind, project, error, attemptNumber)
      }
    };
  }
}

function classifyRepairKind(project: Project, error: AppError): RepairKind | null {
  const text = errorText(error);

  if (error.code === "CODEX_PROMPT_MISSING") {
    return "openai_structured_output";
  }

  if (error.code === "OPENAI_MALFORMED_RESPONSE") {
    return "openai_structured_output";
  }

  if (text.includes("unterminated string in json")) {
    return project.status === "GENERATING_PROMPT" || project.status === "PROCESSING_INPUT"
      ? "openai_structured_output"
      : "codex_generation";
  }

  if (codexRepairCodes.has(error.code)) {
    return "codex_generation";
  }

  if (error.code === "GITHUB_409" || isShaConflictText(text)) {
    return "github_conflict";
  }

  if (error.code === "GITHUB_422" && text.includes("badobjectstate")) {
    return "github_tree_state";
  }

  if (/^GITHUB_(429|5\d\d)$/.test(error.code)) {
    return "github_transient";
  }

  if (
    error.code === "UNEXPECTED_ERROR" &&
    project.status === "SAVING_TO_GITHUB" &&
    /\bjson\b/.test(text) &&
    (text.includes("unexpected end") || text.includes("unterminated") || text.includes("json.parse"))
  ) {
    return "generated_snapshot";
  }

  return null;
}

function countAttempts(project: Project, kind: RepairKind, inputId: string | undefined) {
  return (project.autoRepairAttempts ?? []).filter((attempt) => {
    return attempt.kind === kind && attempt.inputId === inputId;
  }).length;
}

function nextStatusFor(kind: RepairKind, project: Project): ProjectStatus {
  if (kind === "github_conflict" || kind === "github_tree_state" || kind === "github_transient") {
    return project.status === "PROCESSING_INPUT" ||
      project.status === "GENERATING_PROMPT" ||
      project.status === "SENDING_TO_CODEX" ||
      project.status === "CODEX_WORKING" ||
      project.status === "SAVING_TO_GITHUB"
      ? project.status
      : "SAVING_TO_GITHUB";
  }
  if (kind === "openai_structured_output") {
    return project.status === "PROCESSING_INPUT" ? "PROCESSING_INPUT" : "GENERATING_PROMPT";
  }
  return "CODEX_WORKING";
}

function currentStepFor(kind: RepairKind) {
  if (kind === "github_conflict" || kind === "github_tree_state" || kind === "github_transient") {
    return "Auto-fix agent retrying GitHub save";
  }
  if (kind === "openai_structured_output") {
    return "Auto-fix agent retrying planning";
  }
  return "Auto-fix agent repairing generated files";
}

function actionMessageFor(kind: RepairKind) {
  if (kind === "github_conflict") return "Auto-fix agent is retrying after a GitHub write conflict";
  if (kind === "github_tree_state") return "Auto-fix agent is retrying after stale Git tree state";
  if (kind === "github_transient") return "Auto-fix agent is retrying a temporary GitHub error";
  if (kind === "openai_structured_output") return "Auto-fix agent is retrying structured planning";
  if (kind === "generated_snapshot") return "Auto-fix agent is regenerating a damaged file snapshot";
  return "Auto-fix agent is retrying Codex with a smaller repair brief";
}

function continueContextFor(
  kind: RepairKind,
  project: Project,
  error: AppError,
  attemptNumber: number
) {
  if (kind !== "codex_generation" && kind !== "generated_snapshot") return undefined;

  const noChanges =
    error.code === "CODEX_NO_CHANGES_GENERATED" ||
    error.code === "CODEX_NO_VISIBLE_CHANGES_GENERATED";

  return JSON.stringify(
    {
      instruction:
        "Auto-repair this deployRocket run. Preserve the user's intent, but optimize for a compact successful static Vite React TypeScript project.",
      repairDirective: noChanges
        ? "The previous edit did not change the visible app. Apply the requested edit in runtime app files such as src/*, public/*, index.html, CSS, or config, and return a complete changed file set."
        : "The previous generated-file step failed. Return a smaller complete file set, avoid large data arrays and oversized CSS, and keep contentBase64 valid.",
      attemptNumber,
      project: {
        name: project.name,
        summary: project.summary,
        repository: project.githubRepoUrl
      },
      latestError: {
        message: error.message,
        code: error.code,
        details: error.details
      }
    },
    null,
    2
  );
}

function terminalRepairError(kind: RepairKind, error: AppError, maxAttempts: number) {
  return new AppError("Auto-fix agent needs user help to continue.", {
    statusCode: error.statusCode,
    code: "AUTO_REPAIR_NEEDS_USER",
    details: [
      `The auto-fix agent tried ${maxAttempts} ${maxAttempts === 1 ? "time" : "times"} for ${kind}.`,
      `Last error: ${error.message}`,
      error.details ? `Details: ${error.details}` : null
    ].filter(Boolean).join("\n\n"),
    setupInstructions: setupInstructionsFor(kind)
  });
}

function setupInstructionsFor(kind: RepairKind) {
  if (kind === "github_conflict" || kind === "github_tree_state" || kind === "github_transient") {
    return [
      "Close duplicate deployRocket tabs or stop duplicate project runs.",
      "Wait a few seconds, then click Continue Mission.",
      "If you edited the GitHub repository manually, refresh the project before continuing."
    ];
  }

  if (kind === "openai_structured_output") {
    return [
      "Click Continue Mission to retry planning.",
      "If it repeats, use Edit Mission with a shorter request.",
      "Confirm the configured OpenAI model is available for structured outputs."
    ];
  }

  return [
    "Use Edit Mission and ask for a smaller first version.",
    "Reduce large visual details, generated datasets, or file count.",
    "Click Continue Mission after adjusting the request."
  ];
}

function errorText(error: AppError) {
  return [error.code, error.message, error.details, ...(error.setupInstructions ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isShaConflictText(text: string) {
  return text.includes("is at") && text.includes("expected");
}

export const errorRepairAgent = new ErrorRepairAgent();
