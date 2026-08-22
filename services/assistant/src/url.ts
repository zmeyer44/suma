/** Resolve a service endpoint without discarding a path-mounted base URL. */
export function appendServicePath(base: string | URL, path: string): URL {
  const url = new URL(base);
  const basePath = url.pathname.endsWith("/")
    ? url.pathname
    : `${url.pathname}/`;
  url.pathname = `${basePath}${path.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";
  return url;
}
