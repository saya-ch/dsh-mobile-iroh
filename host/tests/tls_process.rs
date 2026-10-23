//! Native TLS lease acceptance uses only fresh private fixture directories.

use std::io::{BufRead as _, BufReader, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

struct OwnedDirectory(PathBuf);
impl OwnedDirectory {
    fn new() -> Self {
        #[cfg(windows)]
        let parent = PathBuf::from(std::env::var_os("USERPROFILE").unwrap());
        #[cfg(not(windows))]
        let parent = std::env::temp_dir();
        let dir = parent.join(format!(
            ".iroh-tls-process-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        dsh_mobile_iroh_core::create_private_directory(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn command(directory: &Path, operation: &str) -> Command {
    let binary = std::env::var_os("DSH_IROH_TEST_HOST_BINARY")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_dsh-mobile-iroh-host")));
    assert!(
        binary.is_absolute() && binary.is_file(),
        "test host must be an absolute regular executable file"
    );
    let mut command = Command::new(binary);
    command
        .args(["--lang", "en", operation, "--data-dir"])
        .arg(directory);
    command
}

struct Held {
    child: Child,
    reader: Option<std::thread::JoinHandle<()>>,
    metadata: serde_json::Value,
}
impl Held {
    fn start(directory: &Path, lease_timeout: &str) -> Self {
        let mut child = command(directory, "tls-prepare")
            .args(["--hold", "--lease-timeout-ms", lease_timeout])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (send, receive) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut input = BufReader::new(stdout);
            let mut line = String::new();
            let result = input.read_line(&mut line);
            send.send((result, line)).unwrap();
            let mut remainder = String::new();
            assert_eq!(
                input.read_line(&mut remainder).unwrap(),
                0,
                "native TLS emitted another record"
            );
        });
        let (result, line) = receive.recv_timeout(Duration::from_secs(5)).unwrap();
        result.unwrap();
        assert!(!line.contains("PRIVATE KEY"));
        let metadata = serde_json::from_str(&line).unwrap();
        Self {
            child,
            reader: Some(reader),
            metadata,
        }
    }

    fn wait(&mut self) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                if let Some(reader) = self.reader.take() {
                    reader.join().unwrap();
                }
                return status;
            }
            assert!(Instant::now() < deadline, "TLS child did not close");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for Held {
    fn drop(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            self.child.kill().unwrap();
            self.child.wait().unwrap();
        }
        if let Some(reader) = self.reader.take() {
            reader.join().unwrap();
        }
    }
}

#[test]
fn lease_excludes_other_tls_writers_until_exact_release_and_retains_identity() {
    let owned = OwnedDirectory::new();
    let mut held = Held::start(&owned.0, "5000");
    let competing = command(&owned.0, "tls-renew").output().unwrap();
    assert!(!competing.status.success());
    assert!(competing.stdout.is_empty());
    assert_eq!(
        String::from_utf8(competing.stderr).unwrap().trim(),
        "Error: host TLS preparation failed"
    );
    held.child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"{\"version\":1,\"type\":\"tls-release\"}\n")
        .unwrap();
    assert!(held.wait().success());
    let status = command(&owned.0, "tls-status").output().unwrap();
    assert!(status.status.success());
    let metadata: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(metadata["instanceId"], held.metadata["instanceId"]);
    assert_eq!(metadata["endpointId"], held.metadata["endpointId"]);
    assert_eq!(
        metadata["leafFingerprint256"],
        held.metadata["leafFingerprint256"]
    );
}

#[test]
fn eof_timeout_unknown_fields_and_oversized_release_close_without_rolling_back_material() {
    for input in [
        None,
        Some(b"{\"version\":1,\"type\":\"tls-release\",\"other\":true}\n".as_slice()),
        Some(&[b'x'; 129]),
        Some(b"{\"version\":2,\"type\":\"tls-release\"}\n".as_slice()),
    ] {
        let owned = OwnedDirectory::new();
        let mut held = Held::start(&owned.0, "5000");
        if let Some(input) = input {
            held.child.stdin.as_mut().unwrap().write_all(input).unwrap();
        }
        drop(held.child.stdin.take());
        assert!(!held.wait().success());
        let next = command(&owned.0, "tls-prepare").output().unwrap();
        assert!(next.status.success());
        let metadata: serde_json::Value = serde_json::from_slice(&next.stdout).unwrap();
        assert_eq!(metadata["instanceId"], held.metadata["instanceId"]);
        assert_eq!(
            metadata["leafFingerprint256"],
            held.metadata["leafFingerprint256"]
        );
    }
    let owned = OwnedDirectory::new();
    let mut held = Held::start(&owned.0, "30");
    assert!(!held.wait().success());
    assert!(command(&owned.0, "tls-prepare")
        .output()
        .unwrap()
        .status
        .success());
}

#[test]
fn identity_resolution_and_host_start_never_replace_a_missing_tls_identity() {
    let owned = OwnedDirectory::new();
    let prepared = command(&owned.0, "tls-prepare").output().unwrap();
    assert!(prepared.status.success());
    let metadata: serde_json::Value = serde_json::from_slice(&prepared.stdout).unwrap();
    let ca_before = std::fs::read(owned.0.join("tls-state.json")).unwrap();
    std::fs::remove_file(owned.0.join("identity.key")).unwrap();
    for operation in ["id", "host"] {
        let result = command(&owned.0, operation).output().unwrap();
        assert!(!result.status.success());
        assert!(result.stdout.is_empty());
        assert!(!owned.0.join("identity.key").exists());
        assert_eq!(
            std::fs::read(owned.0.join("tls-state.json")).unwrap(),
            ca_before
        );
        assert_eq!(
            String::from_utf8(result.stderr).unwrap().trim(),
            "Error: host identity unavailable"
        );
    }
    let result = command(&owned.0, "phone-sim")
        .args([
            "--peer",
            metadata["endpointId"].as_str().unwrap(),
            "--local-only",
            "--peer-address",
            "127.0.0.1:1",
        ])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert!(!owned.0.join("identity.key").exists());
    assert_eq!(
        std::fs::read(owned.0.join("tls-state.json")).unwrap(),
        ca_before
    );
    assert_eq!(
        String::from_utf8(result.stderr).unwrap().trim(),
        "Error: host identity unavailable"
    );
}

#[test]
fn identity_resolution_rejects_orphaned_tls_material_without_creating_identity() {
    let owned = OwnedDirectory::new();
    dsh_mobile_iroh_core::create_private_directory(&owned.0.join("tls")).unwrap();
    dsh_mobile_iroh_core::write_private(&owned.0.join("tls/ca.pem"), b"orphaned").unwrap();
    let result = command(&owned.0, "id").output().unwrap();
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert!(!owned.0.join("identity.key").exists());
    assert_eq!(
        std::fs::read(owned.0.join("tls/ca.pem")).unwrap(),
        b"orphaned"
    );
}
