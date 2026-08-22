export interface BrowserAuthProvider {
  /** Secrets returned here are injected below the model/tool boundary. */
  headersFor(url: URL): Promise<Record<string, string>>;
  /** Headers owned by integrations and stripped before each redirect hop. */
  managedHeaderNames(): readonly string[];
}

export interface BrowserAuthIntegration {
  origin: string;
  pathPrefix?: string;
  headers: Record<string, string>;
}

export class StaticBrowserAuthProvider implements BrowserAuthProvider {
  readonly #integrations: BrowserAuthIntegration[];
  readonly #managedHeaderNames: string[];

  constructor(integrations: BrowserAuthIntegration[]) {
    this.#integrations = integrations.map((integration) => ({
      ...integration,
      origin: new URL(integration.origin).origin,
      pathPrefix: normalizePathPrefix(integration.pathPrefix ?? "/"),
      headers: { ...integration.headers },
    }));
    this.#managedHeaderNames = [
      ...new Set(
        this.#integrations.flatMap((integration) =>
          Object.keys(integration.headers).map((name) => name.toLowerCase()),
        ),
      ),
    ];
  }

  headersFor(url: URL): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const integration of this.#integrations) {
      if (
        url.origin === integration.origin &&
        pathPrefixMatches(url.pathname, integration.pathPrefix ?? "/")
      ) {
        Object.assign(result, integration.headers);
      }
    }
    return Promise.resolve(result);
  }

  managedHeaderNames(): readonly string[] {
    return this.#managedHeaderNames;
  }
}

export class EmptyBrowserAuthProvider implements BrowserAuthProvider {
  headersFor(): Promise<Record<string, string>> {
    return Promise.resolve({});
  }

  managedHeaderNames(): readonly string[] {
    return [];
  }
}

function normalizePathPrefix(value: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new Error("browser auth pathPrefix must be an absolute URL path");
  }
  return value === "/" ? value : value.replace(/\/+$/u, "");
}

function pathPrefixMatches(pathname: string, prefix: string): boolean {
  return prefix === "/" || pathname === prefix || pathname.startsWith(`${prefix}/`);
}
