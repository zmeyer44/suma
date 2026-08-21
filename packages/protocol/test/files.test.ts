import { describe, expect, it } from "vitest";
import {
  CLOUD_FETCH_MIN_BYTES,
  PRO_QUOTA_BYTES,
  checkQuota,
  cloudFetchEligibility,
  normalizeVfsPath,
  parseVfsRequest,
  parseVfsResponse,
  vfsRequestSchema,
  VFS_CAPABILITY,
  type DownloadContext,
} from "../src/index.js";

const ctx = (over: Partial<DownloadContext> = {}): DownloadContext => ({
  url: "https://cdn.example.com/dataset.tar",
  totalBytes: 5 * 1024 * 1024 * 1024,
  hasCookies: false,
  hasAuthHeader: false,
  usesClientCert: false,
  alwaysLocal: false,
  ...over,
});

describe("cloud-fetch eligibility (§8.6 — authenticated downloads stay local)", () => {
  it("accepts a large public download", () => {
    expect(cloudFetchEligibility(ctx())).toEqual({ eligible: true, reason: "public" });
  });

  it("accepts a presigned URL, whose authorization is already in the link", () => {
    const presigned = ctx({
      url: "https://bucket.s3.amazonaws.com/big.bin?X-Amz-Signature=abc&X-Amz-Credential=xyz",
    });
    expect(cloudFetchEligibility(presigned)).toEqual({ eligible: true, reason: "presigned" });
    const azure = ctx({ url: "https://acct.blob.core.windows.net/x/y?sv=2021&sig=deadbeef" });
    expect(cloudFetchEligibility(azure).eligible).toBe(true);
  });

  it("REFUSES anything carrying a credential — the deleted sealed-request case", () => {
    // Each of these would have required shipping a secret into a VM the user
    // can root. §8.6 removed that design; this is the enforcement.
    for (const over of [
      { hasCookies: true },
      { hasAuthHeader: true },
      { usesClientCert: true },
    ] as Array<Partial<DownloadContext>>) {
      const verdict = cloudFetchEligibility(ctx(over));
      expect(verdict.eligible).toBe(false);
      expect(verdict.eligible === false && verdict.reason).toBe("credentialed_request");
      expect(verdict.eligible === false && verdict.explanation).toContain(
        "never sends your credentials",
      );
    }
  });

  it("refuses credentials embedded in the URL itself", () => {
    const verdict = cloudFetchEligibility(ctx({ url: "https://user:pw@cdn.example.com/f.bin" }));
    expect(verdict.eligible === false && verdict.reason).toBe("userinfo_in_url");
  });

  it("refuses non-http schemes and unparseable URLs", () => {
    for (const url of ["file:///etc/passwd", "ftp://host/f", "data:text/plain,hi", "not a url"]) {
      const v = cloudFetchEligibility(ctx({ url }));
      expect(v.eligible, url).toBe(false);
      expect(v.eligible === false && v.reason).toBe("not_http");
    }
  });

  it("refuses private and loopback hosts the cloud machine could not reach anyway", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.5",
      "172.20.1.1",
      "169.254.169.254",
      "buildbox",
      "[fd00::1]",
    ]) {
      const v = cloudFetchEligibility(ctx({ url: `https://${host}/f.bin` }));
      expect(v.eligible, host).toBe(false);
      expect(v.eligible === false && v.reason).toBe("private_host");
    }
    // A public IPv6 literal is still fine.
    expect(cloudFetchEligibility(ctx({ url: "https://[2606:4700::1111]/f.bin" })).eligible).toBe(true);
  });

  it("keeps small downloads local, and treats unknown size as eligible", () => {
    expect(cloudFetchEligibility(ctx({ totalBytes: 1024 })).eligible).toBe(false);
    expect(cloudFetchEligibility(ctx({ totalBytes: CLOUD_FETCH_MIN_BYTES - 1 })).eligible).toBe(false);
    expect(cloudFetchEligibility(ctx({ totalBytes: CLOUD_FETCH_MIN_BYTES })).eligible).toBe(true);
    expect(cloudFetchEligibility(ctx({ totalBytes: null })).eligible).toBe(true);
  });

  it("REFUSES a bearer credential carried in the query string", () => {
    // The rule is about credentials, not about header shape: `?access_token=`
    // is how many APIs still accept an OAuth bearer. An earlier version read
    // `token`/`sig`/`signature` as evidence a link was a safe presigned URL,
    // which inverted the check for exactly this case.
    for (const q of [
      "access_token=eyJhbGciOi",
      "token=abc123",
      "api_key=k",
      "apikey=k",
      "auth=abc",
      "jwt=abc",
      "session=abc",
      "password=hunter2",
      "refresh_token=r",
      "id_token=i",
      "secret=s",
    ]) {
      const v = cloudFetchEligibility(ctx({ url: `https://api.example.com/export?${q}` }));
      expect(v.eligible, q).toBe(false);
      expect(v.eligible === false && v.reason).toBe("credentialed_request");
    }
  });

  it("still accepts genuine object-storage presigned links", () => {
    const s3 = "https://b.s3.amazonaws.com/o?X-Amz-Signature=a&X-Amz-Credential=b&X-Amz-Expires=60";
    expect(cloudFetchEligibility(ctx({ url: s3 })).eligible).toBe(true);
    const gcs = "https://storage.googleapis.com/b/o?X-Goog-Signature=a&X-Goog-Credential=b";
    expect(cloudFetchEligibility(ctx({ url: gcs })).eligible).toBe(true);
    // Azure SAS: sig only counts alongside the version and expiry that scope it.
    const sas = "https://acct.blob.core.windows.net/c/b?sv=2021-08-06&se=2030-01-01&sig=abc";
    expect(cloudFetchEligibility(ctx({ url: sas })).eligible).toBe(true);
    // A bare `sig=` with no SAS scoping is not a presigned link.
    const bare = cloudFetchEligibility(ctx({ url: "https://api.example.com/x?sig=abc" }));
    expect(bare.eligible).toBe(true); // `sig` alone is not in the bearer list
  });

  it("classifies the private space exactly as the agent does", () => {
    // These reach the same addresses as their plain-IPv4 forms; the agent
    // refuses them, so the browser-side check must too.
    for (const host of ["0.0.0.0", "[::ffff:169.254.169.254]", "[::ffff:127.0.0.1]", "[::]"]) {
      const v = cloudFetchEligibility(ctx({ url: `https://${host}/f.bin` }));
      expect(v.eligible, host).toBe(false);
      expect(v.eligible === false && v.reason).toBe("private_host");
    }
  });

  it("honors the always-local setting above everything else", () => {
    const v = cloudFetchEligibility(ctx({ alwaysLocal: true }));
    expect(v.eligible === false && v.reason).toBe("policy_local_only");
  });
});

describe("quota (§8.6 — Pro 100 GB, soft-block)", () => {
  it("allows writes under the limit", () => {
    const v = checkQuota({ usedBytes: 10, limitBytes: PRO_QUOTA_BYTES }, 100);
    expect(v.allowed).toBe(true);
    expect(v.softBlocked).toBe(false);
  });

  it("refuses a write that would exceed the limit, without hiding existing data", () => {
    const v = checkQuota({ usedBytes: PRO_QUOTA_BYTES - 10, limitBytes: PRO_QUOTA_BYTES }, 100);
    expect(v.allowed).toBe(false);
    expect(v.explanation).toContain("Existing files stay available");
  });

  it("reports soft-blocked once at or over the limit", () => {
    expect(checkQuota({ usedBytes: PRO_QUOTA_BYTES, limitBytes: PRO_QUOTA_BYTES }, 1).softBlocked).toBe(true);
    // Exactly filling the quota is allowed.
    expect(checkQuota({ usedBytes: 0, limitBytes: 100 }, 100).allowed).toBe(true);
  });
});

describe("vfs paths", () => {
  it("normalizes and refuses traversal out of the root", () => {
    expect(normalizeVfsPath("a/b/../c")).toBe("/a/c");
    expect(normalizeVfsPath("/a//b/./c")).toBe("/a/b/c");
    expect(normalizeVfsPath("../etc/passwd")).toBeNull();
    expect(normalizeVfsPath("a/../../etc")).toBeNull();
    expect(normalizeVfsPath("")).toBeNull();
    expect(normalizeVfsPath("a\0b")).toBeNull();
  });

  it("validates vfs requests", () => {
    expect(parseVfsRequest(JSON.stringify({ t: "vfs.list", path: "/" })).t).toBe("vfs.list");
    expect(() => parseVfsRequest(JSON.stringify({ t: "vfs.nope", path: "/" }))).toThrow();
    // A read cannot ask for an unbounded slab.
    expect(() =>
      parseVfsRequest(JSON.stringify({ t: "vfs.read", path: "/a", offset: 0, length: 1 << 30 })),
    ).toThrow();
  });

  it("parses the new ops, with delete's recursive flag optional", () => {
    expect(parseVfsRequest(JSON.stringify({ t: "vfs.tree", path: "/" })).t).toBe("vfs.tree");
    expect(parseVfsRequest(JSON.stringify({ t: "vfs.rename", from: "/a", to: "/b" })).t).toBe("vfs.rename");
    expect(parseVfsRequest(JSON.stringify({ t: "vfs.append", path: "/a", dataB64: "" })).t).toBe("vfs.append");
    expect(parseVfsRequest(JSON.stringify({
      t: "vfs.append",
      path: "/a",
      dataB64: "",
      expectedSizeBytes: 12,
    }))).toEqual({
      t: "vfs.append",
      path: "/a",
      dataB64: "",
      expectedSizeBytes: 12,
    });
    const bare = parseVfsRequest(JSON.stringify({ t: "vfs.delete", path: "/d" }));
    expect(bare).toEqual({ t: "vfs.delete", path: "/d" });
    const recursive = parseVfsRequest(JSON.stringify({ t: "vfs.delete", path: "/d", recursive: true }));
    expect(recursive).toEqual({ t: "vfs.delete", path: "/d", recursive: true });
  });
});

describe("vfs responses (wire shapes led by agent/src/vfs.rs)", () => {
  it("round-trips every response variant from agent wire JSON", () => {
    const entry = { name: "a.txt", path: "/a.txt", kind: "file", sizeBytes: 5, modifiedAtMs: 1 };
    const samples = [
      { t: "vfs.listing", path: "/", entries: [entry], truncated: false },
      { t: "vfs.info", entry },
      { t: "vfs.data", path: "/a.txt", offset: 0, dataB64: "aGk=", eof: true },
      { t: "vfs.wrote", path: "/a.txt", sizeBytes: 5 },
      { t: "vfs.deleted", path: "/a.txt" },
      { t: "vfs.created", path: "/d" },
      { t: "vfs.renamed", from: "/a", to: "/b" },
      { t: "vfs.paths", path: "/", paths: ["/a.txt", "/empty/"], truncated: false },
      { t: "error", code: "vfs_not_found", message: "no such path" },
    ];
    for (const sample of samples) {
      expect(parseVfsResponse(JSON.stringify(sample))).toEqual(sample);
    }
  });

  it("rejects an unknown response tag but accepts unknown error codes", () => {
    expect(() => parseVfsResponse(JSON.stringify({ t: "vfs.nope" }))).toThrow();
    const err = parseVfsResponse(JSON.stringify({ t: "error", code: "vfs_new_code", message: "m" }));
    expect(err.t).toBe("error");
  });

  it("VFS_CAPABILITY covers the whole request union, reads read and writes write", () => {
    for (const option of vfsRequestSchema.options) {
      const t = option.shape.t.value as keyof typeof VFS_CAPABILITY;
      expect(VFS_CAPABILITY[t], t).toMatch(/^fs\.(read|write)$/);
    }
    expect(VFS_CAPABILITY["vfs.tree"]).toBe("fs.read");
    expect(VFS_CAPABILITY["vfs.rename"]).toBe("fs.write");
    expect(VFS_CAPABILITY["vfs.append"]).toBe("fs.write");
  });
});
