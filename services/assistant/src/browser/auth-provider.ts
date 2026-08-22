export interface BrowserAuthProvider {
  /** Secrets returned here are injected below the model/tool boundary. */
  headersFor(url: URL): Promise<Record<string, string>>;
}

export interface BrowserAuthIntegration {
  origin: string;
  pathPrefix?: string;
  headers: Record<string, string>;
}

export class StaticBrowserAuthProvider implements BrowserAuthProvider {
  readonly #integrations: BrowserAuthIntegration[];

  constructor(integrations: BrowserAuthIntegration[]) {
    this.#integrations = integrations.map((integration) => ({
      ...integration,
      origin: new URL(integration.origin).origin,
      pathPrefix: integration.pathPrefix ?? "/",
      headers: { ...integration.headers },
    }));
  }

  headersFor(url: URL): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const integration of this.#integrations) {
      if (
        url.origin === integration.origin &&
        url.pathname.startsWith(integration.pathPrefix ?? "/")
      ) {
        Object.assign(result, integration.headers);
      }
    }
    return Promise.resolve(result);
  }
}

export class EmptyBrowserAuthProvider implements BrowserAuthProvider {
  headersFor(): Promise<Record<string, string>> {
    return Promise.resolve({});
  }
}
