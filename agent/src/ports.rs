//! Listening-port discovery for the port-forwarding chips (§8.5).
//!
//! The snapshot source is behind [`PortSource`] so tests feed fixture text
//! instead of shelling out — the parser is the part with behaviour worth
//! pinning. Production uses `lsof -nP -iTCP -sTCP:LISTEN`; a /proc-based
//! source is a drop-in behind the same trait for minimal Linux images
//! without lsof.

use std::collections::BTreeMap;

use anyhow::Context;

use crate::proto::ListeningPort;

/// Where the raw listening-socket snapshot comes from.
pub trait PortSource: Send + Sync {
    fn snapshot(&self) -> anyhow::Result<String>;
}

/// Shells out to lsof. `-nP` keeps addresses and ports numeric so the parser
/// never depends on resolver state.
pub struct LsofSource;

impl PortSource for LsofSource {
    fn snapshot(&self) -> anyhow::Result<String> {
        let out = std::process::Command::new("lsof")
            .args(["-nP", "-iTCP", "-sTCP:LISTEN"])
            .output()
            .context("running lsof")?;
        // lsof exits non-zero when nothing matches; that is an empty list,
        // not an error.
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

/// Parse `lsof -nP -iTCP -sTCP:LISTEN` output. One entry per port; a port is
/// marked `loopback` only when **every** bind for it is loopback — that flag
/// means "safe to forward", and a port also reachable on a routable address
/// must not be presented as private.
pub fn parse_listening(output: &str) -> Vec<ListeningPort> {
    // port → (process, all binds loopback so far)
    let mut by_port: BTreeMap<u16, (String, bool)> = BTreeMap::new();

    for line in output.lines() {
        if !line.contains("(LISTEN)") {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        // COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME (LISTEN)
        if fields.len() < 3 {
            continue;
        }
        let process = fields[0];
        // NAME is the token before "(LISTEN)".
        let Some(name_idx) = fields.iter().position(|f| *f == "(LISTEN)") else {
            continue;
        };
        if name_idx == 0 {
            continue;
        }
        let name = fields[name_idx - 1];
        let Some((addr, port_str)) = name.rsplit_once(':') else {
            continue;
        };
        let Ok(port) = port_str.parse::<u16>() else {
            continue;
        };
        let loopback = is_loopback_bind(addr);

        by_port
            .entry(port)
            .and_modify(|(_, all_loopback)| *all_loopback &= loopback)
            .or_insert_with(|| (process.to_string(), loopback));
    }

    by_port
        .into_iter()
        .map(|(port, (process, loopback))| ListeningPort {
            port,
            process,
            loopback,
        })
        .collect()
}

fn is_loopback_bind(addr: &str) -> bool {
    addr == "[::1]" || addr == "localhost" || addr.starts_with("127.")
}

/// The `ports.list` implementation: snapshot, parse, report.
pub fn list_ports(source: &dyn PortSource) -> anyhow::Result<Vec<ListeningPort>> {
    Ok(parse_listening(&source.snapshot()?))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) const FIXTURE: &str = "\
COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node      48291 zach   23u  IPv4 0x9f9a1b2c      0t0  TCP 127.0.0.1:3000 (LISTEN)
node      48291 zach   24u  IPv6 0x9f9a1b2d      0t0  TCP [::1]:3000 (LISTEN)
postgres    512 zach    7u  IPv4 0x9f9a1b2e      0t0  TCP 127.0.0.1:5432 (LISTEN)
sshd        101 root    3u  IPv4 0x9f9a1b2f      0t0  TCP *:22 (LISTEN)
caddy       777 zach    9u  IPv6 0x9f9a1b30      0t0  TCP *:8443 (LISTEN)
vite       6021 zach   31u  IPv4 0x9f9a1b31      0t0  TCP 127.0.0.1:5173 (LISTEN)
mixed       900 zach   10u  IPv4 0x9f9a1b32      0t0  TCP 127.0.0.1:9000 (LISTEN)
mixed       900 zach   11u  IPv4 0x9f9a1b33      0t0  TCP *:9000 (LISTEN)
";

    /// A fixture source, so dispatch tests can run `ports.list` end-to-end
    /// without lsof.
    pub(crate) struct FixtureSource;

    impl PortSource for FixtureSource {
        fn snapshot(&self) -> anyhow::Result<String> {
            Ok(FIXTURE.to_string())
        }
    }

    #[test]
    fn parses_the_lsof_fixture() {
        let ports = parse_listening(FIXTURE);
        let expected = vec![
            ListeningPort {
                port: 22,
                process: "sshd".into(),
                loopback: false,
            },
            ListeningPort {
                port: 3000,
                process: "node".into(),
                loopback: true,
            },
            ListeningPort {
                port: 5173,
                process: "vite".into(),
                loopback: true,
            },
            ListeningPort {
                port: 5432,
                process: "postgres".into(),
                loopback: true,
            },
            ListeningPort {
                port: 8443,
                process: "caddy".into(),
                loopback: false,
            },
            // Bound on loopback AND wildcard → not loopback-only, so not
            // marked safe to forward.
            ListeningPort {
                port: 9000,
                process: "mixed".into(),
                loopback: false,
            },
        ];
        assert_eq!(ports, expected);
    }

    #[test]
    fn ignores_headers_garbage_and_non_listen_lines() {
        let noisy = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n\
                     node 1 u 1u IPv4 0x1 0t0 TCP 10.0.0.5:443->1.2.3.4:55555 (ESTABLISHED)\n\
                     broken line without markers\n";
        assert!(parse_listening(noisy).is_empty());
    }

    #[test]
    fn list_ports_uses_the_injected_source() {
        let ports = list_ports(&FixtureSource).unwrap();
        assert_eq!(ports.len(), 6);
    }
}
