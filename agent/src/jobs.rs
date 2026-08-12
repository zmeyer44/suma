//! Job Mode registry and the process-tree snapshot (§8.5).
//!
//! The suspend decision belongs to the control plane; the agent's only duty
//! is to report **truthfully** what is running. §8.5 replaced the old
//! output-silence rule precisely because silence is not idleness — so the
//! snapshot says "this PTY runs a non-shell workload" and "this PTY holds an
//! explicit Job Mode keep-awake", and never editorializes beyond that. An
//! agent that shaded the truth here would let the control plane suspend a
//! live training job — the exact failure §8.5 exists to prevent.

use std::collections::HashMap;

use serde::Serialize;

/// Per-PTY workload flags, set over ctl.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobState {
    /// Explicit "keep running" (Job Mode). Shows a cost meter client-side.
    pub job_mode: bool,
    pub label: Option<String>,
    /// The user opted this workload into suspend despite live processes.
    pub suspend_opt_in: bool,
}

#[derive(Default)]
pub struct JobRegistry {
    jobs: HashMap<String, JobState>,
}

impl JobRegistry {
    /// `job.set` — returns the (ptyId, enabled) pair echoed in `job.ack`.
    pub fn set_job_mode(
        &mut self,
        pty_id: &str,
        enabled: bool,
        label: Option<String>,
    ) -> (String, bool) {
        let state = self.jobs.entry(pty_id.to_string()).or_default();
        state.job_mode = enabled;
        state.label = label;
        (pty_id.to_string(), enabled)
    }

    pub fn set_suspend_opt_in(&mut self, pty_id: &str, opt_in: bool) {
        self.jobs
            .entry(pty_id.to_string())
            .or_default()
            .suspend_opt_in = opt_in;
    }

    pub fn get(&self, pty_id: &str) -> JobState {
        self.jobs.get(pty_id).cloned().unwrap_or_default()
    }
}

/// One PTY's entry in the snapshot the control plane reads to make the §8.5
/// suspend decision. Field names follow the protocol's camelCase convention.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessTreeInfo {
    pub pty_id: String,
    /// The spawn command, if any — `None` is an interactive shell.
    pub command: Option<String>,
    /// True when nothing but a shell is (believed to be) running. "Never
    /// auto-suspend while a non-shell user process tree is alive" keys on
    /// this being honest.
    pub shell_only: bool,
    pub suspend_opt_in: bool,
    pub job_mode: bool,
}

/// Conservative shell test: only a bare, argument-less invocation of a known
/// shell counts. Anything we cannot positively identify as a shell is
/// reported as a workload — the safe direction, since misreporting "shell"
/// suspends someone's job.
fn is_shell_command(command: Option<&str>) -> bool {
    let Some(command) = command else {
        // No command means the PTY spawned the user's login shell.
        return true;
    };
    let trimmed = command.trim();
    let basename = trimmed.rsplit('/').next().unwrap_or(trimmed);
    matches!(basename, "sh" | "bash" | "zsh" | "fish" | "dash")
}

/// Build the snapshot from the live PTY table plus the registry.
pub fn process_tree_snapshot(
    live: &[(String, Option<String>)],
    jobs: &JobRegistry,
) -> Vec<ProcessTreeInfo> {
    live.iter()
        .map(|(pty_id, command)| {
            let state = jobs.get(pty_id);
            ProcessTreeInfo {
                pty_id: pty_id.clone(),
                command: command.clone(),
                shell_only: is_shell_command(command.as_deref()),
                suspend_opt_in: state.suspend_opt_in,
                job_mode: state.job_mode,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_mode_set_and_ack_round_trip() {
        let mut reg = JobRegistry::default();
        assert_eq!(
            reg.set_job_mode("t1", true, Some("training".into())),
            ("t1".to_string(), true)
        );
        assert!(reg.get("t1").job_mode);
        assert_eq!(reg.get("t1").label.as_deref(), Some("training"));

        assert_eq!(
            reg.set_job_mode("t1", false, None),
            ("t1".to_string(), false)
        );
        assert!(!reg.get("t1").job_mode);
        assert!(reg.get("unseen").label.is_none());
    }

    #[test]
    fn snapshot_reports_workloads_job_mode_and_opt_ins() {
        let mut reg = JobRegistry::default();
        reg.set_job_mode("build", true, Some("nightly build".into()));
        reg.set_suspend_opt_in("optin", true);

        let live = vec![
            ("build".to_string(), Some("npm run build".to_string())),
            ("idle".to_string(), None),
            ("optin".to_string(), Some("python watch.py".to_string())),
            ("plain".to_string(), Some("/bin/zsh".to_string())),
        ];
        let snap = process_tree_snapshot(&live, &reg);
        assert_eq!(snap.len(), 4);

        let by_id = |id: &str| snap.iter().find(|p| p.pty_id == id).unwrap();
        // A real workload: not shell-only, job mode held.
        assert!(!by_id("build").shell_only);
        assert!(by_id("build").job_mode);
        // Interactive shell (no command): shell-only.
        assert!(by_id("idle").shell_only);
        assert!(!by_id("idle").job_mode);
        // Opted into suspend, still truthfully a workload.
        assert!(!by_id("optin").shell_only);
        assert!(by_id("optin").suspend_opt_in);
        // Bare shell invocation counts as a shell.
        assert!(by_id("plain").shell_only);
    }

    #[test]
    fn unknown_commands_are_reported_as_workloads_not_shells() {
        // The safe direction: when unsure, report a workload so the control
        // plane does not suspend it.
        assert!(!is_shell_command(Some("bash -c 'sleep 100'")));
        assert!(!is_shell_command(Some("mytool")));
        assert!(is_shell_command(Some("/usr/bin/fish")));
        assert!(is_shell_command(None));
    }

    #[test]
    fn snapshot_serializes_camel_case_for_the_control_plane() {
        let info = ProcessTreeInfo {
            pty_id: "t1".into(),
            command: Some("npm test".into()),
            shell_only: false,
            suspend_opt_in: false,
            job_mode: true,
        };
        let v = serde_json::to_value(info).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "ptyId": "t1",
                "command": "npm test",
                "shellOnly": false,
                "suspendOptIn": false,
                "jobMode": true
            })
        );
    }
}
