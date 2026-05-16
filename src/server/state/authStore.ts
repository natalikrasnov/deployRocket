export interface GitHubAuthState {
  accessToken: string;
  tokenType: string;
  scope: string;
  connectedAt: string;
  user: {
    login: string;
    id: number;
    htmlUrl: string;
    avatarUrl?: string;
  };
}
