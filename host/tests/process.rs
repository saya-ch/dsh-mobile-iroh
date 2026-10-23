//! Process ownership checks use only temporary profiles and loopback networking.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

struct Process {
    child: Child,
    events: mpsc::Receiver<String>,
    root: PathBuf,
    reader: Option<std::thread::JoinHandle<()>>,
    owns_root: bool,
}

impl Process {
    fn start(label: &str) -> Self {
        #[cfg(windows)]
        let parent = PathBuf::from(std::env::var_os("USERPROFILE").unwrap());
        #[cfg(not(windows))]
        let parent = std::env::temp_dir();
        let root = parent.join(format!(
            "iroh-process-{}-{label}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        dsh_mobile_iroh_core::create_private_directory(&root).unwrap();
        Self::spawn(root, true)
    }

    fn spawn(root: PathBuf, owns_root: bool) -> Self {
        let binary = std::env::var_os("DSH_IROH_TEST_HOST_BINARY")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_dsh-mobile-iroh-host")));
        assert!(
            binary.is_absolute() && binary.is_file(),
            "test host must be an absolute regular executable file"
        );
        let mut child = Command::new(binary)
            .args(["--lang", "en", "host", "--local-only", "--data-dir"])
            .arg(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, events) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if sender.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            child,
            events,
            root,
            reader: Some(reader),
            owns_root,
        }
    }

    fn event(&self, kind: &str) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let line = self
                .events
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("missing owned sidecar event");
            let event: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!(event["version"], 1);
            if event["type"] == kind {
                return event;
            }
        }
    }

    fn wait(&mut self) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(
                Instant::now() < deadline,
                "owned sidecar failed to exit within five seconds"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        if self.owns_root {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}

#[test]
fn parent_eof_stops_first_party_host_without_a_signal() {
    let mut process = Process::start("eof");
    let ready = process.event("ready");
    assert_eq!(ready["local_only"], true);
    assert!(!ready["direct_addresses"].as_array().unwrap().is_empty());
    drop(process.child.stdin.take());
    process.event("stopped");
    assert!(process.wait().success());
}

#[test]
fn explicit_shutdown_stops_first_party_host() {
    let mut process = Process::start("shutdown");
    process.event("ready");
    process
        .child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"{\"version\":1,\"type\":\"shutdown\"}\n")
        .unwrap();
    process.event("stopped");
    assert!(process.wait().success());
}

#[test]
fn unsupported_parent_message_stops_without_echoing_its_private_fields() {
    let mut process = Process::start("invalid");
    process.event("ready");
    process.child.stdin.as_mut().unwrap().write_all(b"{\"version\":1,\"type\":\"proxy-auth\",\"cookie\":\"private-diagnostic-sentinel\",\"authority\":\"wrong\"}\n").unwrap();
    let error = process.event("error");
    assert_eq!(error["code"], "invalid-command");
    assert!(!error.to_string().contains("private-diagnostic-sentinel"));
    process.event("stopped");
    assert!(!process.wait().success());
}

#[test]
fn oversized_unterminated_parent_message_exits_with_bounded_memory() {
    let mut process = Process::start("oversized");
    process.event("ready");
    let _ = process
        .child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&vec![b'x'; 16 * 1024 + 1]);
    process.event("stopped");
    assert!(!process.wait().success());
}

fn preference_command(root: &std::path::Path, enabled: Option<bool>) -> std::process::Output {
    let binary = std::env::var_os("DSH_IROH_TEST_HOST_BINARY")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_dsh-mobile-iroh-host")));
    let mut command = Command::new(binary);
    command.args([
        "--lang",
        "en",
        if enabled.is_some() {
            "preference-save"
        } else {
            "preference-load"
        },
        "--data-dir",
    ]);
    command.arg(root);
    if let Some(enabled) = enabled {
        command.args(["--enabled", if enabled { "true" } else { "false" }]);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("operator preference child did not close");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(output.stdout.len() <= 256);
    output
}

#[test]
fn preference_processes_persist_across_restart_without_waiting_for_active_host_lease() {
    let mut host = Process::start("durable-preference");
    let identity = host.event("ready")["endpoint_id"].clone();
    let initial = preference_command(&host.root, None);
    assert!(initial.status.success());
    assert_eq!(initial.stdout, b"{\"version\":1,\"enabled\":false}\n");
    let saved = preference_command(&host.root, Some(true));
    assert!(saved.status.success());
    assert_eq!(saved.stdout, b"{\"version\":1,\"enabled\":true}\n");
    drop(host.child.stdin.take());
    host.event("stopped");
    assert!(host.wait().success());
    assert_eq!(preference_command(&host.root, None).stdout, saved.stdout);
    let mut restarted = Process::spawn(host.root.clone(), false);
    assert_eq!(restarted.event("ready")["endpoint_id"], identity);
    let disabled = preference_command(&host.root, Some(false));
    assert!(disabled.status.success());
    assert_eq!(disabled.stdout, initial.stdout);
    drop(restarted.child.stdin.take());
    restarted.event("stopped");
    assert!(restarted.wait().success());
    assert_eq!(preference_command(&host.root, None).stdout, initial.stdout);
}

#[test]
fn corrupt_preference_and_held_operator_lease_fail_without_acknowledgement_or_repair() {
    let mut host = Process::start("invalid-preference");
    host.event("ready");
    let lock = dsh_mobile_iroh_core::open_private_lock_file(&host.root.join("operator-state.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    let blocked = preference_command(&host.root, Some(true));
    assert!(!blocked.status.success());
    assert!(blocked.stdout.is_empty());
    drop(lock);
    let path = host.root.join("operator-state.json");
    let sentinel = b"private-preference-sentinel";
    dsh_mobile_iroh_core::write_private(&path, sentinel).unwrap();
    for enabled in [None, Some(false)] {
        let rejected = preference_command(&host.root, enabled);
        assert!(!rejected.status.success());
        assert!(rejected.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&rejected.stderr).contains("private-preference-sentinel"));
        assert_eq!(std::fs::read(&path).unwrap(), sentinel);
    }
    drop(host.child.stdin.take());
    host.event("stopped");
    assert!(host.wait().success());
}

#[cfg(windows)]
#[test]
fn active_profile_lock_cannot_be_unlinked_or_renamed_and_restart_is_safe() {
    let mut first = Process::start("lock-path");
    let identity = first.event("ready")["endpoint_id"].clone();
    let path = first.root.join("host.lock");
    let renamed = first.root.join("renamed.lock");
    assert!(
        std::fs::remove_file(&path).is_err(),
        "active lock pathname was unlinked"
    );
    assert!(
        std::fs::rename(&path, &renamed).is_err(),
        "active lock pathname was renamed"
    );
    assert!(path.exists());
    assert!(!renamed.exists());
    let mut second = Process::spawn(first.root.clone(), false);
    assert!(
        !second.wait().success(),
        "concurrent host reused the active profile"
    );
    assert!(!second
        .events
        .try_iter()
        .any(|line| serde_json::from_str::<serde_json::Value>(&line)
            .is_ok_and(|event| event["type"] == "ready")));
    drop(second);
    drop(first.child.stdin.take());
    first.event("stopped");
    assert!(first.wait().success());
    let mut restarted = Process::spawn(first.root.clone(), false);
    assert_eq!(restarted.event("ready")["endpoint_id"], identity);
    drop(restarted.child.stdin.take());
    restarted.event("stopped");
    assert!(restarted.wait().success());
}
