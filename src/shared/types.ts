export const PROJECT_STATUSES = [
  "IDLE",
  "PROCESSING_INPUT",
  "GENERATING_PROMPT",
  "SENDING_TO_CODEX",
  "CODEX_WORKING",
  "SAVING_TO_GITHUB",
  "DEPLOYING",
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
  deploymentInstructions: string[];
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

export interface DeploymentRecord {
  id: string;
  at: string;
  status: string;
  conclusion?: string;
  workflowRunUrl?: string;
  pagesUrl?: string;
}

export interface Project {
  id: string;
  name: string;
  summary: string;
  status: ProjectStatus;
  currentStep: string;
  githubRepoUrl?: string;
  githubPagesUrl?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubDefaultBranch?: string;
  githubLastCommitSha?: string;
  githubWorkflowRunId?: number;
  codexRunId?: string;
  error: ProjectError | null;
  createdAt: string;
  updatedAt: string;
  actions: ProjectAction[];
  inputs: ProjectInputRecord[];
  deployments: DeploymentRecord[];
  lastCommittedPaths: string[];
}

export interface JsonDatabase {
  projects: Project[];
}

export interface SetupStatus {
  openaiConfigured: boolean;
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
}

export interface ApiListResponse<T> {
  data: T;
}
