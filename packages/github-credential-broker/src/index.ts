// GitHub App credential broker — short-lived tokens
export interface Repository {
  readonly owner: string;
  readonly name: string;
}

export interface TemporaryToken {
  readonly token: string;
  readonly expiresAt: string;
}

export interface GitHubCredentialBroker {
  getInstallationToken(repository: Repository): Promise<TemporaryToken>;
}

export interface GitHubCredentialBrokerPlaceholder {
  readonly kind: "github-credential-broker";
}

export const PLACEHOLDER_KIND = "github-credential-broker" as const;

export function createPlaceholder(): GitHubCredentialBrokerPlaceholder {
  return {
    kind: PLACEHOLDER_KIND,
  };
}
