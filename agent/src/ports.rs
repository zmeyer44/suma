//! Listening-port discovery for the port-forwarding chips (§8.5).
//!
//! The source is behind [`PortSource`] so tests can inject deterministic
//! results. Production reads Linux's `/proc/net/tcp{,6}` directly. `lsof`
//! looks convenient, but it can omit a live Node/Next listener even while the
//! socket is present in `/proc` (observed on the Fly compute image).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::net::Ipv6Addr;
use std::path::Path;

use anyhow::{bail, Context};

use crate::proto::ListeningPort;

/// Where the listening-port snapshot comes from.
pub trait PortSource: Send + Sync {
    fn list(&self) -> anyhow::Result<Vec<ListeningPort>>;
}

/// Reads the kernel socket tables and associates their inodes with process
/// names through `/proc/<pid>/fd`. A socket is still reported as `unknown` if
/// its owner exits or moves the descriptor while the snapshot is collected.
pub struct ProcSource;

impl PortSource for ProcSource {
    fn list(&self) -> anyhow::Result<Vec<ListeningPort>> {
        list_proc_ports(Path::new("/proc"))
    }
}

#[derive(Debug, Eq, PartialEq)]
struct ProcListener {
    inode: u64,
    port: u16,
    loopback: bool,
}

fn list_proc_ports(proc_root: &Path) -> anyhow::Result<Vec<ListeningPort>> {
    let tcp_path = proc_root.join("net/tcp");
    let tcp6_path = proc_root.join("net/tcp6");
    let tcp = fs::read_to_string(&tcp_path).unwrap_or_default();
    let tcp6 = fs::read_to_string(&tcp6_path).unwrap_or_default();
    if tcp.is_empty() && tcp6.is_empty() {
        bail!(
            "reading listener tables {} and {}",
            tcp_path.display(),
            tcp6_path.display()
        );
    }

    let mut listeners = parse_proc_table(&tcp, false);
    listeners.extend(parse_proc_table(&tcp6, true));
    let wanted: HashSet<u64> = listeners.iter().map(|listener| listener.inode).collect();
    let processes = process_names_by_inode(proc_root, &wanted);
    Ok(merge_proc_listeners(&listeners, &processes))
}

/// Parse one Linux `/proc/net/tcp*` table. State `0A` is LISTEN; field 10 is
/// the socket inode used to associate the bind with its owning process.
fn parse_proc_table(output: &str, ipv6: bool) -> Vec<ProcListener> {
    output
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 10 || fields[3] != "0A" {
                return None;
            }
            let (address, port_hex) = fields[1].rsplit_once(':')?;
            let port = u16::from_str_radix(port_hex, 16).ok()?;
            let inode = fields[9].parse::<u64>().ok()?;
            let loopback = if ipv6 {
                is_proc_ipv6_loopback(address)
            } else {
                // IPv4 bytes are little-endian in `/proc/net/tcp`; the final
                // byte pair is therefore the first address octet.
                address.len() == 8 && address[6..].eq_ignore_ascii_case("7F")
            };
            Some(ProcListener {
                inode,
                port,
                loopback,
            })
        })
        .collect()
}

fn is_proc_ipv6_loopback(address: &str) -> bool {
    if address.len() != 32 {
        return false;
    }
    let mut octets = [0_u8; 16];
    for (index, chunk) in address.as_bytes().chunks_exact(8).enumerate() {
        let Ok(chunk) = std::str::from_utf8(chunk) else {
            return false;
        };
        let Ok(word) = u32::from_str_radix(chunk, 16) else {
            return false;
        };
        octets[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    Ipv6Addr::from(octets).is_loopback()
}

fn process_names_by_inode(proc_root: &Path, wanted: &HashSet<u64>) -> HashMap<u64, String> {
    let mut found = HashMap::new();
    let Ok(entries) = fs::read_dir(proc_root) else {
        return found;
    };

    'processes: for entry in entries.flatten() {
        let pid = entry.file_name();
        if !pid.as_encoded_bytes().iter().all(u8::is_ascii_digit) {
            continue;
        }
        let process_root = entry.path();
        let process = fs::read_to_string(process_root.join("comm"))
            .unwrap_or_else(|_| "unknown".into())
            .trim()
            .to_string();
        let Ok(fds) = fs::read_dir(process_root.join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(target) = fs::read_link(fd.path()) else {
                continue;
            };
            let target = target.to_string_lossy();
            let Some(inode) = target
                .strip_prefix("socket:[")
                .and_then(|value| value.strip_suffix(']'))
                .and_then(|value| value.parse::<u64>().ok())
            else {
                continue;
            };
            if wanted.contains(&inode) {
                found.entry(inode).or_insert_with(|| process.clone());
                if found.len() == wanted.len() {
                    break 'processes;
                }
            }
        }
    }
    found
}

fn merge_proc_listeners(
    listeners: &[ProcListener],
    processes: &HashMap<u64, String>,
) -> Vec<ListeningPort> {
    let mut by_port: BTreeMap<u16, (String, bool)> = BTreeMap::new();
    for listener in listeners {
        let process = processes
            .get(&listener.inode)
            .cloned()
            .unwrap_or_else(|| "unknown".into());
        by_port
            .entry(listener.port)
            .and_modify(|(existing_process, all_loopback)| {
                *all_loopback &= listener.loopback;
                if existing_process == "unknown" && process != "unknown" {
                    existing_process.clone_from(&process);
                }
            })
            .or_insert((process, listener.loopback));
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
    source.list().context("listing listening ports")
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
        fn list(&self) -> anyhow::Result<Vec<ListeningPort>> {
            Ok(parse_listening(FIXTURE))
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

    #[test]
    fn proc_tables_include_ipv6_wildcard_node_listener_missed_by_lsof() {
        let tcp = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 00000000:08AE 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1744 1\n";
        let tcp6 = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 13449 1\n\
   1: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 20000 1\n";
        let mut processes = HashMap::new();
        processes.insert(1744, "suma-agent".into());
        processes.insert(13449, "node".into());
        processes.insert(20000, "vite".into());

        let mut listeners = parse_proc_table(tcp, false);
        listeners.extend(parse_proc_table(tcp6, true));
        assert_eq!(
            merge_proc_listeners(&listeners, &processes),
            vec![
                ListeningPort {
                    port: 2222,
                    process: "suma-agent".into(),
                    loopback: false,
                },
                ListeningPort {
                    port: 3000,
                    process: "node".into(),
                    loopback: false,
                },
                ListeningPort {
                    port: 5173,
                    process: "vite".into(),
                    loopback: true,
                },
            ]
        );
    }
}
