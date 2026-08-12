/** Human device labels: stable enough to recognize, never raw UUID-first. */

const LOCAL_SUFFIX = /\.local$/i;
const SEPARATOR_RUN = /[-_]+/g;

export function suggestedDeviceName(args: {
  computerName?: string | null;
  hostname?: string | null;
  platform: NodeJS.Platform;
}): string {
  const computerName = args.computerName?.trim();
  if (computerName !== undefined && computerName.length > 0)
    return computerName;

  const hostname = args.hostname?.trim().replace(LOCAL_SUFFIX, "");
  if (
    hostname !== undefined &&
    hostname.length > 0 &&
    hostname !== "localhost"
  ) {
    return hostname.replace(SEPARATOR_RUN, " ");
  }

  return args.platform === "darwin" ? "My Mac" : "My device";
}

export function friendlyPlatform(platform: string): string {
  switch (platform.toLowerCase()) {
    case "darwin":
    case "macos":
      return "macOS";
    case "win32":
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform.length > 0 ? platform : "Device";
  }
}
