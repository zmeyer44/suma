//! `fetch.public` — cloud-side download of a **public or presigned** URL
//! (§8.6, M-3 Lite).
//!
//! [`FetchSpec`] has a URL and a destination path and *nothing else*. There
//! is deliberately no field for headers, cookies, or credentials, and there
//! never will be: the v1.0 "sealed one-shot request" decrypted the user's
//! URL + Cookie header inside the VM the user can root, which made
//! "memory-only, single-use" an application property rather than a security
//! boundary. §8.6 removed it. If a fetch needs credentials, it does not
//! belong in the VM — full stop. Adding a header field to this type would
//! reopen that hole, which is why the absence is enforced by the type and
//! not by a code review convention.
//!
//! Three refusals hold that claim up, because "no header field" only makes
//! credentialed fetches impossible if the URL cannot smuggle one:
//!
//! 1. **No control characters anywhere in the URL.** The request line is built
//!    by interpolation, so a literal CR/LF in the path would append headers of
//!    the attacker's choosing and could terminate the head and smuggle a
//!    second request — reintroducing exactly the `Cookie:` header §8.6 deleted.
//!    Such a URL is rejected, never sanitized: a URL that needs repairing to be
//!    safe is not a URL the user meant to fetch.
//! 2. **No private, loopback, or link-local targets**, checked on the literal
//!    host *and* on every address DNS returns. Without it, `fetch.public`
//!    reaches cloud metadata (169.254.169.254) and anything else the VM's
//!    network can see, from a request the user can aim.
//! 3. **A size cap**, so a hostile or broken server cannot fill the volume.
//!
//! `https://` rides rustls (ring provider, webpki roots) — presigned URLs
//! are https by construction, so the fetcher would be decorative without it.
//! Redirects are followed to a small bound with every hop re-checked against
//! the target policy, and a downgrade hop (`https → http`) is refused: a
//! redirect is the server's suggestion, not an exemption from the rules the
//! first URL passed. Chunked transfer remains unsupported — a response
//! without Content-Length is refused, not guessed at.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context as TaskContext, Poll};

use anyhow::{bail, Context};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{lookup_host, TcpStream};
use tokio_rustls::TlsConnector;

use crate::chunker::{chunk_file, Manifest};
use crate::proto::AgentCtlResponse;

/// What a fetch is allowed to know. No headers — see module docs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchSpec {
    /// Stable caller-provided correlation id (normally the Files transfer id).
    pub fetch_id: String,
    pub url: String,
    /// Where the bytes land, as an already-confined host path. Nothing here
    /// re-checks it: `dispatch` builds every real spec from
    /// `VfsRoot::resolve_new_file`, so the path is inside `~/cloud` before it
    /// reaches this module. Construct one some other way and the create-new
    /// open below will write wherever you pointed it.
    pub dest_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchOutcome {
    pub path: PathBuf,
    pub bytes: u64,
    /// Content-defined chunks of what was downloaded, for the control plane to
    /// record (§8.6). Computed here rather than by whoever asked for the fetch
    /// because the bytes are already on this side of the network: shipping
    /// them somewhere else to be chunked would undo the point of fetching in
    /// the cloud.
    pub manifest: Manifest,
}

/// Emit progress roughly this often (bytes) so a 5 GB fetch does not spam a
/// frame per read.
const PROGRESS_STRIDE: u64 = 64 * 1024;

/// Ceiling on one fetch. This is a disk-exhaustion guard, not a quota — Files
/// quotas (Pro 100 GB, §8.6) live in the Files plane and are enforced there.
/// `$HOME` is a Fly volume with no swap (§8.5); a server that streams forever,
/// or lies about Content-Length, must not be able to fill it.
pub const MAX_FETCH_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Redirect hops one fetch will follow before refusing. Five covers every
/// real CDN chain; an endless loop is a server bug or a trap either way.
const MAX_REDIRECTS: u32 = 5;

/// Settings `fetch_public` fixes at their production values. Tests vary them
/// to exercise the refusal paths against a loopback server without weakening
/// what ships — the same split as `Policy::permissive_for_local` in
/// `services/egressgw/src/policy.rs`.
struct FetchOptions {
    max_bytes: u64,
    allow_private_targets: bool,
    /// TLS config override — tests inject one trusting a loopback test CA.
    /// `None` ships: the shared webpki-roots config.
    tls_config: Option<Arc<rustls::ClientConfig>>,
}

impl Default for FetchOptions {
    fn default() -> Self {
        FetchOptions {
            max_bytes: MAX_FETCH_BYTES,
            allow_private_targets: false,
            tls_config: None,
        }
    }
}

/// The production TLS client config: webpki roots, no client auth. Built
/// once — root parsing is not free and every fetch would repeat it.
fn shared_tls_config() -> Arc<rustls::ClientConfig> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    Arc::clone(CONFIG.get_or_init(|| {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        )
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scheme {
    Http,
    Https,
}

impl Scheme {
    fn default_port(self) -> u16 {
        match self {
            Scheme::Http => 80,
            Scheme::Https => 443,
        }
    }
}

/// One resolved fetch destination — the unit the redirect loop iterates.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Target {
    scheme: Scheme,
    host: String,
    port: u16,
    path: String,
}

impl Target {
    /// The Host header value: port included only when non-default, matching
    /// what browsers send and what virtual hosts expect.
    fn host_header(&self) -> String {
        if self.port == self.scheme.default_port() {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

/// A plain or TLS-wrapped connection, one read/write surface for the rest of
/// the fetcher. Both variants are `Unpin`, so delegation is direct.
enum MaybeTls {
    Plain(TcpStream),
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

impl AsyncRead for MaybeTls {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            MaybeTls::Plain(s) => Pin::new(s).poll_read(cx, buf),
            MaybeTls::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for MaybeTls {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            MaybeTls::Plain(s) => Pin::new(s).poll_write(cx, buf),
            MaybeTls::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            MaybeTls::Plain(s) => Pin::new(s).poll_flush(cx),
            MaybeTls::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            MaybeTls::Plain(s) => Pin::new(s).poll_shutdown(cx),
            MaybeTls::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
        }
    }
}

/// Download `spec.url` to `spec.dest_path`, emitting `fetch.progress` frames
/// through `emit`. Returns the outcome for the caller to turn into
/// `fetch.done`.
pub async fn fetch_public(
    spec: &FetchSpec,
    emit: &mut (dyn FnMut(AgentCtlResponse) + Send),
) -> anyhow::Result<FetchOutcome> {
    fetch_with(spec, &FetchOptions::default(), emit).await
}

async fn fetch_with(
    spec: &FetchSpec,
    options: &FetchOptions,
    emit: &mut (dyn FnMut(AgentCtlResponse) + Send),
) -> anyhow::Result<FetchOutcome> {
    let mut target = parse_url(&spec.url)?;
    let mut hops: u32 = 0;

    // The redirect loop. Every hop is a fresh URL from the SERVER, so every
    // hop re-earns what the first URL earned: control-character validation
    // (in `resolve_redirect`), the literal-host policy, and the post-DNS
    // private-address filter (both in `connect_target`).
    let (head, mut body_start, mut stream) = loop {
        let mut stream = connect_target(&target, options).await?;
        // Safe to interpolate: every component has been rejected for control
        // characters, so nothing can close this head or open a new one.
        let request = format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nUser-Agent: suma-agent\r\n\r\n",
            target.path,
            target.host_header(),
        );
        stream.write_all(request.as_bytes()).await?;

        let (head, body_start) = read_response_head(&mut stream).await?;
        let status = head
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .unwrap_or("")
            .to_string();
        match status.as_str() {
            "200" => break (head, body_start, stream),
            "301" | "302" | "303" | "307" | "308" => {
                hops += 1;
                if hops > MAX_REDIRECTS {
                    bail!("fetch refused: more than {MAX_REDIRECTS} redirects");
                }
                let location = header_value(&head, "location")
                    .context("redirect without a Location header")?;
                target = resolve_redirect(&target, &location)?;
            }
            other => bail!("fetch failed: upstream answered {other}"),
        }
    };
    let total =
        content_length(&head).context("fetcher requires Content-Length (no chunked transfer)")?;
    if total > options.max_bytes {
        bail!(
            "fetch refused: {total} bytes exceeds the {} byte limit for one fetch",
            options.max_bytes
        );
    }

    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&spec.dest_path)
        .await
        .with_context(|| format!("creating {}", spec.dest_path.display()))?;

    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut buf = [0u8; 16 * 1024];
    loop {
        if !body_start.is_empty() {
            file.write_all(&body_start).await?;
            received += body_start.len() as u64;
            body_start.clear();
        } else {
            let n = stream.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).await?;
            received += n as u64;
        }
        // Content-Length is the server's claim, not a promise. Enforce the cap
        // against bytes actually written, and take the partial file with us —
        // leaving it behind would hand the attacker the disk anyway.
        if received > options.max_bytes {
            drop(file);
            let _ = tokio::fs::remove_file(&spec.dest_path).await;
            bail!(
                "fetch aborted: body exceeded the {} byte limit for one fetch",
                options.max_bytes
            );
        }
        if received - last_emit >= PROGRESS_STRIDE || received >= total {
            last_emit = received;
            emit(AgentCtlResponse::FetchProgress {
                fetch_id: spec.fetch_id.clone(),
                url: spec.url.clone(),
                received,
                total,
            });
        }
        if received >= total {
            break;
        }
    }
    file.flush().await?;

    if received != total {
        bail!("fetch truncated: got {received} of {total} bytes");
    }

    // Chunk what landed, in a second pass over the file rather than alongside
    // the download. A fetch is network-bound for minutes and this pass is a
    // sequential read of a file still warm in page cache, so the simplicity of
    // "download, then chunk the finished bytes" costs little and keeps the two
    // failure modes (a truncated transfer, an unreadable volume) distinct.
    // `chunk_file` streams: an 8 GB `MAX_FETCH_BYTES` download is never held
    // in memory.
    let path = spec.dest_path.clone();
    let manifest = tokio::task::spawn_blocking(move || chunk_file(&path))
        .await
        .context("chunking the downloaded file")?
        .with_context(|| format!("chunking {}", spec.dest_path.display()))?;

    Ok(FetchOutcome {
        path: spec.dest_path.clone(),
        bytes: received,
        manifest,
    })
}

/// Resolve and dial, refusing private space at both steps; wraps in TLS for
/// https targets.
async fn connect_target(target: &Target, options: &FetchOptions) -> anyhow::Result<MaybeTls> {
    let stream = connect_permitted(&target.host, target.port, options).await?;
    match target.scheme {
        Scheme::Http => Ok(MaybeTls::Plain(stream)),
        Scheme::Https => {
            let config = options.tls_config.clone().unwrap_or_else(shared_tls_config);
            let name = rustls::pki_types::ServerName::try_from(target.host.clone())
                .with_context(|| format!("{} is not a valid TLS server name", target.host))?;
            let tls = TlsConnector::from(config)
                .connect(name, stream)
                .await
                .with_context(|| format!("TLS handshake with {}", target.host))?;
            Ok(MaybeTls::Tls(Box::new(tls)))
        }
    }
}

/// Resolve and dial, refusing private space at both steps.
async fn connect_permitted(
    host: &str,
    port: u16,
    options: &FetchOptions,
) -> anyhow::Result<TcpStream> {
    check_target_host(host, options)?;
    let addrs: Vec<SocketAddr> = lookup_host((host, port))
        .await
        .with_context(|| format!("resolving {host}"))?
        .filter(|a| options.allow_private_targets || !ip_is_private(a.ip()))
        .collect();
    if addrs.is_empty() {
        bail!("fetch refused: {host} did not resolve to a permitted public address");
    }
    for addr in &addrs {
        if let Ok(stream) = TcpStream::connect(addr).await {
            return Ok(stream);
        }
    }
    bail!("connecting to {host}:{port}")
}

/// Where a redirect points, against the hop it came from. A `Location` is
/// server-controlled input: it gets the same validation the original URL got,
/// plus the downgrade rule — a fetch that started encrypted must not be
/// talked into plaintext (`https → http` refused; `http → https` welcome).
fn resolve_redirect(from: &Target, location: &str) -> anyhow::Result<Target> {
    let next = if location.starts_with("http://") || location.starts_with("https://") {
        parse_url(location).context("redirect Location is not a fetchable URL")?
    } else if location.starts_with('/') && !location.starts_with("//") {
        // Root-relative: same scheme/host/port, new path. The path is
        // interpolated into the next request line, so it gets the same
        // control-character refusals a whole URL gets.
        if let Some(bad) = location
            .bytes()
            .find(|b| b.is_ascii_control() || *b == 0x7f)
        {
            bail!("redirect Location contains a control character (0x{bad:02x})");
        }
        if location.contains(' ') {
            bail!("redirect Location contains a space");
        }
        Target {
            path: location.to_string(),
            ..from.clone()
        }
    } else {
        // Protocol-relative (`//host/…`) and path-relative forms are refused:
        // rare from real CDNs, and ambiguity is not worth resolving here.
        bail!("redirect Location {location:?} is neither absolute http(s) nor root-relative");
    };
    if from.scheme == Scheme::Https && next.scheme == Scheme::Http {
        bail!("redirect refused: https must not downgrade to http");
    }
    Ok(next)
}

/// `http(s)://host[:port]/path` parser, with an explicit refusal (not a
/// silent downgrade) for anything else.
fn parse_url(url: &str) -> anyhow::Result<Target> {
    // First, before anything is split out and interpolated anywhere: a URL
    // carrying CR, LF, NUL, or any other control character is refused whole.
    if let Some(bad) = url.bytes().find(|b| b.is_ascii_control() || *b == 0x7f) {
        bail!("URL contains a control character (0x{bad:02x}); refusing to fetch it");
    }
    // A raw space is invalid in a URL (RFC 3986 wants it percent-encoded) and
    // the request line is space-delimited, so it can only confuse a server.
    if url.contains(' ') {
        bail!("URL contains a space; refusing to fetch it");
    }
    let (scheme, rest) = if let Some(rest) = url.strip_prefix("http://") {
        (Scheme::Http, rest)
    } else if let Some(rest) = url.strip_prefix("https://") {
        (Scheme::Https, rest)
    } else {
        bail!("fetch.public accepts http(s) URLs only");
    };
    let (authority, path) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    if authority.is_empty() {
        bail!("URL has no host");
    }
    // `[v6]:port` first: an IPv6 literal is full of colons, so splitting on
    // the last one would mangle it into an unparseable port — and a target
    // that errors out on its port never reaches the private-address check.
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (host, rest) = rest
            .split_once(']')
            .context("bracketed IPv6 host is not closed")?;
        let port = match rest.strip_prefix(':') {
            Some(p) => p.parse::<u16>().context("bad port in URL")?,
            None if rest.is_empty() => scheme.default_port(),
            None => bail!("unexpected characters after the IPv6 host"),
        };
        (host, port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h, p.parse::<u16>().context("bad port in URL")?),
            None => (authority, scheme.default_port()),
        }
    };
    if host.is_empty() {
        bail!("URL has no host");
    }
    Ok(Target {
        scheme,
        host: host.to_string(),
        port,
        path: path.to_string(),
    })
}

/// One header's value from a response head, case-insensitive.
fn header_value(head: &str, name: &str) -> Option<String> {
    head.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key.trim().eq_ignore_ascii_case(name) {
            Some(value.trim().to_string())
        } else {
            None
        }
    })
}

/* ------------------------------------------------------------------ *
 * Target policy
 * ------------------------------------------------------------------ */

// Mirrored from `services/egressgw/src/policy.rs` — the source of truth for
// "what a Suma-side fetcher may dial", including the v4-mapped IPv6 case
// that would otherwise smuggle every IPv4 refusal past the check. It is copied
// rather than imported on purpose: the agent runs on the compute plane and the
// gateway on the identity plane, and I-3 means neither crate depends on the
// other. If the refusals change there, change them here too.
//
// The address families matter concretely for this fetcher: 169.254.169.254 is
// link-local, i.e. cloud instance metadata, and `fetch.public` takes its URL
// from a request an attacker in the VM can craft.

fn check_target_host(host: &str, options: &FetchOptions) -> anyhow::Result<()> {
    if options.allow_private_targets {
        return Ok(());
    }
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = bare.parse::<IpAddr>() {
        if ip_is_private(ip) {
            bail!("fetch refused: {host} is a private or local address");
        }
        return Ok(());
    }
    let h = bare.to_ascii_lowercase();
    // `localhost` names and bare no-dot hostnames are LAN/mDNS names — they
    // can only resolve somewhere fetch.public must not go.
    if h == "localhost" || h.ends_with(".localhost") || !h.contains('.') {
        bail!("fetch refused: {host} is a private or local address");
    }
    Ok(())
}

fn ipv4_is_private(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || (a == 100 && (64..=127).contains(&b)) // CGNAT 100.64.0.0/10
}

fn ipv6_is_private(ip: Ipv6Addr) -> bool {
    if let Some(v4) = v4_mapped(ip) {
        return ipv4_is_private(v4);
    }
    let seg0 = ip.segments()[0];
    ip.is_loopback()
        || ip.is_unspecified()
        || (seg0 & 0xfe00) == 0xfc00 // unique-local fc00::/7
        || (seg0 & 0xffc0) == 0xfe80 // link-local fe80::/10
}

/// `::ffff:a.b.c.d` — judged as its embedded IPv4 address, or the mapped form
/// becomes a trivial bypass of every IPv4 refusal above.
fn v4_mapped(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let seg = ip.segments();
    if seg[..5] == [0, 0, 0, 0, 0] && seg[5] == 0xffff {
        let [_, _, _, _, _, _, s6, s7] = seg;
        Some(Ipv4Addr::new(
            (s6 >> 8) as u8,
            (s6 & 0xff) as u8,
            (s7 >> 8) as u8,
            (s7 & 0xff) as u8,
        ))
    } else {
        None
    }
}

fn ip_is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => ipv4_is_private(v4),
        IpAddr::V6(v6) => ipv6_is_private(v6),
    }
}

fn content_length(head: &str) -> Option<u64> {
    head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.trim().eq_ignore_ascii_case("content-length") {
            value.trim().parse().ok()
        } else {
            None
        }
    })
}

async fn read_response_head<S: AsyncRead + Unpin>(
    stream: &mut S,
) -> anyhow::Result<(String, Vec<u8>)> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).into_owned();
            let leftover = buf[end + 4..].to_vec();
            return Ok((head, leftover));
        }
        if buf.len() > 64 * 1024 {
            bail!("response head too large");
        }
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            bail!("connection closed before response head");
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn temp_file(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "suma-fetch-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    /// Loopback targets, which the shipped policy refuses — the same
    /// test-only relaxation as `Policy::permissive_for_local`.
    fn local_options() -> FetchOptions {
        FetchOptions {
            allow_private_targets: true,
            ..FetchOptions::default()
        }
    }

    /// One-shot HTTP server on an ephemeral port serving `body`. The request
    /// it received is returned through `seen`, so a test can assert what
    /// actually went on the wire.
    async fn serve_once(body: Vec<u8>) -> (std::net::SocketAddr, RequestLog) {
        serve_once_declaring(body, None).await
    }

    type RequestLog = std::sync::Arc<std::sync::Mutex<Vec<u8>>>;

    /// As [`serve_once`], but able to lie: `declared_length` overrides the
    /// advertised Content-Length while the real body is still sent.
    async fn serve_once_declaring(
        body: Vec<u8>,
        declared_length: Option<u64>,
    ) -> (std::net::SocketAddr, RequestLog) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: RequestLog = Default::default();
        let log = std::sync::Arc::clone(&seen);
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut req = [0u8; 2048];
            let n = stream.read(&mut req).await.unwrap();
            log.lock().unwrap().extend_from_slice(&req[..n]);
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n",
                declared_length.unwrap_or(body.len() as u64)
            );
            stream.write_all(head.as_bytes()).await.unwrap();
            // Two chunks, to exercise the head-leftover + streaming paths.
            let mid = body.len() / 2;
            stream.write_all(&body[..mid]).await.unwrap();
            stream.write_all(&body[mid..]).await.unwrap();
        });
        (addr, seen)
    }

    #[tokio::test]
    async fn downloads_and_reports_progress() {
        let body: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let (addr, _) = serve_once(body.clone()).await;
        let dest = temp_file("ok");
        let spec = FetchSpec {
            fetch_id: "fetch-test".into(),
            url: format!("http://127.0.0.1:{}/data.bin", addr.port()),
            dest_path: dest.clone(),
        };

        let mut progress: Vec<(u64, u64)> = Vec::new();
        let mut emit = |resp: AgentCtlResponse| {
            if let AgentCtlResponse::FetchProgress {
                received, total, ..
            } = resp
            {
                progress.push((received, total));
            }
        };
        let outcome = fetch_with(&spec, &local_options(), &mut emit)
            .await
            .unwrap();

        assert_eq!(outcome.bytes, body.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        // The manifest the control plane will record must describe exactly
        // what landed — same addresses the TS side computes for these bytes.
        assert_eq!(outcome.manifest, crate::chunker::build_manifest(&body));
        assert_eq!(outcome.manifest.total_bytes, body.len() as u64);
        assert!(!progress.is_empty(), "progress must be emitted");
        assert!(progress.windows(2).all(|w| w[0].0 <= w[1].0), "monotonic");
        let (last_received, last_total) = *progress.last().unwrap();
        assert_eq!(last_received, body.len() as u64);
        assert_eq!(last_total, body.len() as u64);
        std::fs::remove_file(&dest).unwrap();
    }

    #[test]
    fn parses_http_and_https_urls() {
        assert_eq!(
            parse_url("http://example.com/a/b?c=d").unwrap(),
            Target {
                scheme: Scheme::Http,
                host: "example.com".into(),
                port: 80,
                path: "/a/b?c=d".into()
            }
        );
        assert_eq!(
            parse_url("http://127.0.0.1:8080").unwrap(),
            Target {
                scheme: Scheme::Http,
                host: "127.0.0.1".into(),
                port: 8080,
                path: "/".into()
            }
        );
        // https defaults to 443, and the Host header hides default ports.
        let https = parse_url("https://cdn.example.com/big.bin").unwrap();
        assert_eq!(https.scheme, Scheme::Https);
        assert_eq!(https.port, 443);
        assert_eq!(https.host_header(), "cdn.example.com");
        assert_eq!(
            parse_url("https://cdn.example.com:8443/x")
                .unwrap()
                .host_header(),
            "cdn.example.com:8443"
        );
        assert!(parse_url("ftp://example.com/x").is_err());
        assert!(parse_url("http://").is_err());
        // Percent-encoded CRLF is *not* an injection — it stays three literal
        // characters in the path — so it must still be fetchable.
        assert_eq!(
            parse_url("http://example.com/a%0d%0ab").unwrap().path,
            "/a%0d%0ab"
        );
    }

    /// One-shot server answering a 302 to `location`.
    async fn serve_redirect_once(location: String) -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut req = [0u8; 2048];
            let _ = stream.read(&mut req).await;
            let head =
                format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n");
            stream.write_all(head.as_bytes()).await.unwrap();
        });
        addr
    }

    #[tokio::test]
    async fn follows_a_redirect_hop_to_the_real_body() {
        let body = b"the real payload".to_vec();
        let (final_addr, _) = serve_once(body.clone()).await;
        let hop =
            serve_redirect_once(format!("http://127.0.0.1:{}/real.bin", final_addr.port())).await;

        let dest = temp_file("redirected");
        let spec = FetchSpec {
            fetch_id: "fetch-test".into(),
            url: format!("http://127.0.0.1:{}/start", hop.port()),
            dest_path: dest.clone(),
        };
        let mut emit = |_resp: AgentCtlResponse| {};
        let outcome = fetch_with(&spec, &local_options(), &mut emit)
            .await
            .unwrap();
        assert_eq!(outcome.bytes, body.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        std::fs::remove_file(&dest).unwrap();
    }

    #[tokio::test]
    async fn refuses_endless_redirects_and_unpermitted_hops() {
        // A server that redirects to itself forever.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let mut req = [0u8; 2048];
                let _ = stream.read(&mut req).await;
                let head = format!(
                    "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{}/again\r\nContent-Length: 0\r\n\r\n",
                    addr.port()
                );
                let _ = stream.write_all(head.as_bytes()).await;
            }
        });
        let spec = FetchSpec {
            fetch_id: "fetch-test".into(),
            url: format!("http://127.0.0.1:{}/loop", addr.port()),
            dest_path: temp_file("loop"),
        };
        let mut emit = |_resp: AgentCtlResponse| {};
        let err = fetch_with(&spec, &local_options(), &mut emit)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("redirects"), "{err}");

        // Under the SHIPPED policy, a hop into private space is refused even
        // though the first URL would have been public: the hop's target is
        // checked exactly like a first URL. (The redirect server itself is
        // loopback, so point the test at the resolver instead: a private
        // Location must fail the same check_target_host the original passed.)
        let hop = serve_redirect_once("http://169.254.169.254/latest/meta-data".into()).await;
        let spec = FetchSpec {
            fetch_id: "fetch-test".into(),
            url: format!("http://127.0.0.1:{}/start", hop.port()),
            dest_path: temp_file("ssrf-hop"),
        };
        let options = FetchOptions {
            allow_private_targets: false,
            ..FetchOptions::default()
        };
        // The FIRST connect fails on loopback policy before any redirect —
        // which is itself the assertion that hops get no special treatment:
        // resolve_redirect + connect_target run the same policy, tested
        // directly below and in `redirects_resolve_strictly`.
        let err = fetch_with(&spec, &options, &mut emit)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("private or local"), "{err}");
        // And the hop-target check in isolation:
        let from = parse_url("http://example.com/a").unwrap();
        let hop_target = resolve_redirect(&from, "http://169.254.169.254/meta").unwrap();
        assert!(
            check_target_host(&hop_target.host, &options).is_err(),
            "metadata hop must be refused"
        );
    }

    #[tokio::test]
    async fn https_fetches_over_tls_against_an_injected_test_ca() {
        // A throwaway CA + a localhost server cert signed by it. The client
        // trusts ONLY this CA via FetchOptions.tls_config — the shipped
        // webpki-roots path is untouched.
        let ca_key = rcgen::KeyPair::generate().unwrap();
        let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let ca_cert = ca_params.self_signed(&ca_key).unwrap();

        let server_key = rcgen::KeyPair::generate().unwrap();
        let server_cert = rcgen::CertificateParams::new(vec!["localhost".to_string()])
            .unwrap()
            .signed_by(&server_key, &ca_cert, &ca_key)
            .unwrap();

        let server_config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![server_cert.der().clone()],
                rustls::pki_types::PrivateKeyDer::try_from(server_key.serialize_der()).unwrap(),
            )
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config));

        let body = b"encrypted payload".to_vec();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let served = body.clone();
        tokio::spawn(async move {
            // Serves every connection: the second fetch below must reach the
            // TLS handshake (and fail THERE), not a dead socket.
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                let Ok(mut tls) = acceptor.accept(tcp).await else {
                    continue; // handshake refused by an untrusting client
                };
                let mut req = [0u8; 2048];
                let _ = tls.read(&mut req).await;
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                    served.len()
                );
                let _ = tls.write_all(head.as_bytes()).await;
                let _ = tls.write_all(&served).await;
                tls.shutdown().await.ok();
            }
        });

        let mut roots = rustls::RootCertStore::empty();
        roots.add(ca_cert.der().clone()).unwrap();
        let client_config = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();

        let dest = temp_file("tls");
        let spec = FetchSpec {
            fetch_id: "fetch-test".into(),
            url: format!("https://localhost:{}/enc.bin", addr.port()),
            dest_path: dest.clone(),
        };
        let options = FetchOptions {
            allow_private_targets: true,
            tls_config: Some(Arc::new(client_config)),
            ..FetchOptions::default()
        };
        let mut emit = |_resp: AgentCtlResponse| {};
        let outcome = fetch_with(&spec, &options, &mut emit).await.unwrap();
        assert_eq!(outcome.bytes, body.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        std::fs::remove_file(&dest).unwrap();

        // The same server WITHOUT the injected trust is refused: the shipped
        // config does not know this CA.
        let spec2 = FetchSpec {
            fetch_id: "fetch-test-2".into(),
            url: format!("https://localhost:{}/enc.bin", addr.port()),
            dest_path: temp_file("tls-untrusted"),
        };
        let untrusting = FetchOptions {
            allow_private_targets: true,
            ..FetchOptions::default()
        };
        let err = fetch_with(&spec2, &untrusting, &mut emit)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("TLS"), "{err}");
    }

    #[test]
    fn redirects_resolve_strictly() {
        let from = parse_url("https://cdn.example.com/start").unwrap();

        // Absolute https and root-relative are accepted.
        let absolute = resolve_redirect(&from, "https://other.example.com/next").unwrap();
        assert_eq!(absolute.host, "other.example.com");
        let relative = resolve_redirect(&from, "/moved/here?sig=1").unwrap();
        assert_eq!(relative.host, "cdn.example.com");
        assert_eq!(relative.scheme, Scheme::Https);
        assert_eq!(relative.path, "/moved/here?sig=1");

        // A downgrade is refused; an upgrade is welcome.
        let err = resolve_redirect(&from, "http://cdn.example.com/plain").unwrap_err();
        assert!(err.to_string().contains("downgrade"), "{err}");
        let http_from = parse_url("http://example.com/a").unwrap();
        assert_eq!(
            resolve_redirect(&http_from, "https://example.com/a")
                .unwrap()
                .scheme,
            Scheme::Https
        );

        // Protocol-relative, path-relative, and injected forms are refused.
        for bad in [
            "//evil.example.com/x",
            "relative/path",
            "/a\r\nX: 1",
            "/a b",
        ] {
            assert!(resolve_redirect(&from, bad).is_err(), "{bad:?}");
        }
    }

    /// A literal CRLF in the URL is header injection and request smuggling
    /// against the fetcher's own request line — the concrete way a `Cookie:`
    /// header gets back into a type that deliberately has no header field.
    #[tokio::test]
    async fn a_literal_crlf_in_the_url_is_refused_not_sanitized() {
        let (addr, seen) = serve_once(b"unreachable".to_vec()).await;
        let smuggled = format!(
            "http://127.0.0.1:{}/a\r\nCookie: session=stolen\r\n\r\nGET /second HTTP/1.1\r\nHost: x\r\n\r\n",
            addr.port()
        );
        let spec = FetchSpec {
            fetch_id: "fetch-test".into(),
            url: smuggled,
            dest_path: temp_file("crlf"),
        };
        let mut emit = |_resp: AgentCtlResponse| {};
        let err = fetch_with(&spec, &local_options(), &mut emit)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("control character"), "{err}");
        // Nothing was sent: the refusal happens before the socket.
        assert!(seen.lock().unwrap().is_empty());

        // Every other control character is refused on the same rule, in the
        // host as well as the path.
        for url in [
            "http://example.com/a\nX: 1",
            "http://example.com/a\rX: 1",
            "http://exam\r\nple.com/",
            "http://example.com/\0",
            "http://example.com/\x7f",
            "http://example.com/a\tb",
        ] {
            assert!(parse_url(url).is_err(), "{url:?} must be refused");
        }
        assert!(parse_url("http://exa mple.com/").is_err());
    }

    #[tokio::test]
    async fn private_loopback_and_metadata_targets_are_refused() {
        let mut emit = |_resp: AgentCtlResponse| {};
        for host in [
            "127.0.0.1:8080",
            "localhost:8080",
            "dev.localhost",
            "10.0.0.1",
            "192.168.1.10",
            "172.16.4.4",
            "169.254.169.254", // cloud instance metadata
            "100.64.0.1",
            "0.0.0.0",
            "[::1]",
            "[fd12:3456::1]",
            "[fe80::1]",
            "[::ffff:10.0.0.1]", // v4-mapped smuggling
            "build-server",      // bare LAN name
        ] {
            let spec = FetchSpec {
                fetch_id: "fetch-test".into(),
                url: format!("http://{host}/latest/meta-data/"),
                dest_path: temp_file("private"),
            };
            let err = fetch_public(&spec, &mut emit)
                .await
                .unwrap_err()
                .to_string();
            assert!(
                err.contains("private or local address"),
                "{host} must be refused, got: {err}"
            );
        }

        // And the post-DNS re-check refuses a *name* that resolves into
        // private space, which the literal-host check above cannot see.
        assert!(!ip_is_private("8.8.8.8".parse().unwrap()));
        assert!(ip_is_private("127.0.0.1".parse().unwrap()));
        assert!(ip_is_private("::ffff:127.0.0.1".parse().unwrap()));
        let spec = FetchSpec {
            fetch_id: "fetch-test".into(),
            // `localhost.` has a dot, so only the resolved address gives it
            // away.
            url: "http://localhost./x".to_string(),
            dest_path: temp_file("rebind"),
        };
        let err = fetch_public(&spec, &mut emit)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("permitted public address") || err.contains("resolving"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn oversized_responses_are_refused_by_declared_and_by_actual_size() {
        let body: Vec<u8> = vec![7u8; 4096];
        let options = FetchOptions {
            max_bytes: 1024,
            ..local_options()
        };
        let mut emit = |_resp: AgentCtlResponse| {};

        // Honest Content-Length: refused before a byte is written.
        let (addr, _) = serve_once(body.clone()).await;
        let dest = temp_file("toobig");
        let spec = FetchSpec {
            fetch_id: "fetch-test".into(),
            url: format!("http://127.0.0.1:{}/big.bin", addr.port()),
            dest_path: dest.clone(),
        };
        let err = fetch_with(&spec, &options, &mut emit)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("exceeds the 1024 byte limit"), "{err}");
        assert!(!dest.exists(), "nothing must be written");

        // Lying Content-Length: a body that claims to fit and then keeps
        // coming. The cap is enforced against real bytes, and the partial file
        // does not survive.
        let (addr, _) = serve_once_declaring(body, Some(1024)).await;
        let dest = temp_file("liar");
        let spec = FetchSpec {
            fetch_id: "fetch-test".into(),
            url: format!("http://127.0.0.1:{}/big.bin", addr.port()),
            dest_path: dest.clone(),
        };
        let err = fetch_with(&spec, &options, &mut emit)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("exceeded the 1024 byte limit"), "{err}");
        assert!(!dest.exists(), "the partial file must be removed");

        // The shipped ceiling is the one the module documents.
        assert_eq!(FetchOptions::default().max_bytes, MAX_FETCH_BYTES);
        assert!(!FetchOptions::default().allow_private_targets);
    }
}
