//! The trusted operator owns one fixed, versioned preference independently of
//! the active transport's profile lease. Existing private state is never repaired.

use std::io::ErrorKind;
use std::path::Path;

use anyhow::{bail, Context as _, Result};
use dsh_mobile_iroh_core::{
    create_private_directory, open_private_lock_file, read_private_file, write_private,
};
use serde::{Deserialize, Serialize};

const STATE_FILE: &str = "operator-state.json";
const LOCK_FILE: &str = "operator-state.lock";
const MAX_STATE_BYTES: usize = 256;

/// Startup preference only; no peer credentials or alternate paths are accepted.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Preference {
    version: u8,
    enabled: bool,
}

impl Preference {
    fn new(enabled: bool) -> Self {
        Self {
            version: 1,
            enabled,
        }
    }
}

fn lock(dir: &Path) -> Result<std::fs::File> {
    if !dir.is_absolute() {
        bail!("operator preference directory must be absolute");
    }
    create_private_directory(dir)?;
    let file = open_private_lock_file(&dir.join(LOCK_FILE))?;
    file.try_lock()
        .context("another operator preference operation is active")?;
    Ok(file)
}

fn read(dir: &Path) -> Result<Preference> {
    let bytes = match read_private_file(&dir.join(STATE_FILE), MAX_STATE_BYTES) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Preference::new(false)),
        Err(error) => return Err(error).context("cannot read private operator preference"),
    };
    let state: Preference =
        serde_json::from_slice(&bytes).context("invalid operator preference")?;
    if state.version != 1 {
        bail!("unsupported operator preference version");
    }
    Ok(state)
}

/// Load under the preference lease, not the active sidecar's host lease.
pub(crate) fn load(dir: &Path) -> Result<Preference> {
    let _lease = lock(dir)?;
    read(dir)
}

/// Save only after validating the existing preference and private permissions.
pub(crate) fn save(dir: &Path, enabled: bool) -> Result<Preference> {
    let _lease = lock(dir)?;
    read(dir)?;
    let state = Preference::new(enabled);
    write_private(&dir.join(STATE_FILE), &serde_json::to_vec(&state)?)?;
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct OwnedDirectory(PathBuf);

    impl OwnedDirectory {
        fn new() -> Self {
            #[cfg(windows)]
            let parent = PathBuf::from(std::env::var_os("USERPROFILE").unwrap());
            #[cfg(not(windows))]
            let parent = std::env::temp_dir();
            let dir = parent.join(format!(
                ".iroh-preference-{}-{}",
                std::process::id(),
                rand::random::<u64>()
            ));
            create_private_directory(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for OwnedDirectory {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn absent_preference_is_disabled_and_save_survives_reopening() {
        let owned = OwnedDirectory::new();
        assert_eq!(load(&owned.0).unwrap(), Preference::new(false));
        assert!(!owned.0.join(STATE_FILE).exists());
        save(&owned.0, true).unwrap();
        assert_eq!(load(&owned.0).unwrap(), Preference::new(true));
        save(&owned.0, false).unwrap();
        assert_eq!(load(&owned.0).unwrap(), Preference::new(false));
        assert!(!owned.0.join("identity.key").exists());
    }

    #[test]
    fn malformed_or_oversized_state_is_never_replaced() {
        let owned = OwnedDirectory::new();
        for bytes in [
            b"broken".to_vec(),
            br#"{"version":2,"enabled":true}"#.to_vec(),
            br#"{"version":1,"enabled":true,"other":1}"#.to_vec(),
            br#"{"version":1,"enabled":"yes"}"#.to_vec(),
            br#"{"version":1,"enabled":true,"enabled":false}"#.to_vec(),
            vec![b' '; MAX_STATE_BYTES + 1],
        ] {
            write_private(&owned.0.join(STATE_FILE), &bytes).unwrap();
            assert!(load(&owned.0).is_err());
            assert!(save(&owned.0, false).is_err());
            assert_eq!(std::fs::read(owned.0.join(STATE_FILE)).unwrap(), bytes);
        }
    }

    #[test]
    fn independent_lease_rejects_concurrent_mutation_without_changing_state() {
        let owned = OwnedDirectory::new();
        save(&owned.0, true).unwrap();
        let held = lock(&owned.0).unwrap();
        assert!(load(&owned.0).is_err());
        assert!(save(&owned.0, false).is_err());
        drop(held);
        assert_eq!(load(&owned.0).unwrap(), Preference::new(true));
        let host = open_private_lock_file(&owned.0.join("host.lock")).unwrap();
        host.try_lock().unwrap();
        assert_eq!(load(&owned.0).unwrap(), Preference::new(true));
        save(&owned.0, false).unwrap();
        drop(host);
    }

    #[test]
    fn non_file_save_failure_and_relative_directory_are_rejected() {
        let owned = OwnedDirectory::new();
        create_private_directory(&owned.0.join(STATE_FILE)).unwrap();
        assert!(save(&owned.0, true).is_err());
        assert!(owned.0.join(STATE_FILE).is_dir());
        assert!(load(Path::new("relative-profile")).is_err());
        assert!(save(Path::new("relative-profile"), true).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn unsafe_windows_acl_is_rejected_without_changing_permissions_or_bytes() {
        use std::process::Command;
        let owned = OwnedDirectory::new();
        let path = owned.0.join(STATE_FILE);
        save(&owned.0, true).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let icacls = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .join("icacls.exe");
        let grant = Command::new(&icacls)
            .arg(&path)
            .args(["/grant", "*S-1-1-0:(R)"])
            .output()
            .unwrap();
        assert!(grant.status.success());
        let before = Command::new(&icacls).arg(&path).output().unwrap();
        assert!(before.status.success());
        assert!(load(&owned.0).is_err());
        assert!(save(&owned.0, false).is_err());
        let after = Command::new(&icacls).arg(&path).output().unwrap();
        assert!(after.status.success());
        assert_eq!(after.stdout, before.stdout);
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }

    #[cfg(unix)]
    #[test]
    fn unsafe_modes_and_links_are_rejected_without_permission_repair() {
        use std::os::unix::fs::{symlink, PermissionsExt as _};
        let owned = OwnedDirectory::new();
        let path = owned.0.join(STATE_FILE);
        save(&owned.0, true).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load(&owned.0).is_err());
        assert!(save(&owned.0, false).is_err());
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644
        );
        std::fs::remove_file(&path).unwrap();
        let sentinel = owned.0.join("sentinel");
        write_private(&sentinel, b"unchanged").unwrap();
        symlink(&sentinel, &path).unwrap();
        assert!(load(&owned.0).is_err());
        assert!(save(&owned.0, false).is_err());
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"unchanged");
    }
}
