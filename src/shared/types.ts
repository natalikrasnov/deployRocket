export const PROJECT_STATUSES = [
  "IDLE",
  "PROCESSING_INPUT",
  "GENERATING_PROMPT",
  "SENDING_TO_CODEX",
  "CODEX_WORKING",
  "SAVING_TO_GITHUB",
  "LIVE",
  "FAILED",
  "STOPPED"
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export type ActionLevel = "info" | "success" | "warning" | "error";

export interface ProjectAction {
  id: string;
  at: string;
  message: string;
  level: ActionLevel;
  status?: ProjectStatus;
  details?: string;
}

export interface ProjectInputImage {
  id: string;
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
  path: string;
}

export interface ProjectInputRecord {
  id: string;
  kind: "create" | "edit";
  text: string;
  images: ProjectInputImage[];
  createdAt: string;
  structuredRequirements?: StructuredRequirements;
  codexPrompt?: CodexPromptPlan;
  generatedProject?: GeneratedProject;
}

export interface StructuredRequirements {
  projectName: string;
  summary: string;
  intent: string;
  targetUsers: string[];
  coreFeatures: string[];
  screens: string[];
  designDirection: string;
  constraints: string[];
  imageContext: string[];
  repositoryNameSuggestion: string;
}

export interface CodexPromptPlan {
  title: string;
  summary: string;
  architectureInstructions: string[];
  frontendInstructions: string[];
  backendInstructions: string[];
  modificationInstructions: string[];
  acceptanceCriteria: string[];
  codexPrompt: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GeneratedProject {
  files: GeneratedFile[];
  implementationSummary: string;
  setupNotes: string[];
  warnings: string[];
}

export interface ProjectError {
  message: string;
  code?: string;
  details?: string;
  at: string;
  setupInstructions?: string[];
}

export interface ProjectAutoRepairAttempt {
  id: string;
  at: string;
  kind:
    | "codex_generation"
    | "github_conflict"
    | "github_tree_state"
    | "github_transient"
    | "openai_structured_output"
    | "generated_snapshot";
  inputId?: string;
  fromStatus: ProjectStatus;
  nextStatus: ProjectStatus;
  code?: string;
  message: string;
}

export interface Project {
  id: string;
  name: string;
  summary: string;
  status: ProjectStatus;
  currentStep: string;
  githubRepoUrl?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubUserLogin?: string;
  githubDefaultBranch?: string;
  githubLastCommitSha?: string;
  githubWorkflowRunId?: number;
  githubPagesUrl?: string;
  githubPagesStatus?: string;
  githubPagesUpdatedAt?: string;
  codexRunId?: string;
  error: ProjectError | null;
  createdAt: string;
  updatedAt: string;
  actions: ProjectAction[];
  inputs: ProjectInputRecord[];
  lastCommittedPaths: string[];
  autoRepairAttempts?: ProjectAutoRepairAttempt[];
  activeInputId?: string;
  activeRunKind?: "create" | "edit";
  pagesDispatchRequestedAt?: string;
  continueContext?: string;
}

export interface JsonDatabase {
  projects: Project[];
}

export interface BillingPlan {
  currency: "USD";
  totalCents: number;
  openaiApiBudgetCents: number;
  platformCommissionCents: number;
}

export interface OpenAIConnectionStatus {
  connected: boolean;
  source: "user" | "platform" | "missing";
  connectedAt?: string;
  keyFingerprint?: string;
}

export interface BillingStatus {
  connected: boolean;
  mode: "mock" | "live";
  status: "inactive" | "mock_active" | "active";
  plan: BillingPlan;
  activatedAt?: string;
  lastIntentId?: string;
  commissionRecipientConfigured: boolean;
}

export interface SetupStatus {
  openaiConfigured: boolean;
  openaiConnection: OpenAIConnectionStatus;
  billing: BillingStatus;
  githubOAuthConfigured: boolean;
  githubConnected: boolean;
  githubUser?: {
    login: string;
    htmlUrl: string;
    avatarUrl?: string;
  };
  callbackUrl: string;
  defaultBranch: string;
  missing: string[];
  features?: {
    openaiClient: {
      ready: boolean;
      missing: string[];
    };
    githubAuth: {
      ready: boolean;
      missing: string[];
    };
    billing: {
      ready: boolean;
      missing: string[];
    };
    projectEditing: {
      ready: boolean;
      missing: string[];
    };
  };
}

export interface ApiListResponse<T> {
  data: T;
}
