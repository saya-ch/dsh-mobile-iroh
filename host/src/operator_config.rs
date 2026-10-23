//! Fixed non-secret operator configuration. Authentication URLs never belong here.
use std::io::ErrorKind;
use std::path::Path;

use anyhow::{bail, Context as _, Result};
use dsh_mobile_iroh_core::{
    create_private_directory, open_private_lock_file, read_private_file, write_private,
};
use serde::{Deserialize, Serialize};

const FILE: &str = "operator-config.json";
const LOCK: &str = "operator-config.lock";
const MAX_BYTES: usize = 512;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Config {
    version: u8,
    upstream_origin: String,
    local_port: u16,
    local_only: bool,
}

fn valid_origin(origin: &str) -> bool {
    for (scheme, default_port) in [("http", 80), ("https", 443)] {
        for host in ["127.0.0.1", "[::1]"] {
            let base = format!("{scheme}://{host}");
            if origin == base {
                return true;
            }
            if let Some(port) = origin.strip_prefix(&format!("{base}:")) {
                if let Ok(number) = port.parse::<u16>() {
                    if number > 0 && number != default_port && number.to_string() == port {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn validate(config: &Config) -> Result<()> {
    if config.version != 1 || config.local_port < 1024 || !valid_origin(&config.upstream_origin) {
        bail!("invalid operator configuration");
    }
    Ok(())
}

fn lease(directory: &Path) -> Result<std::fs::File> {
    if !directory.is_absolute() {
        bail!("operator configuration directory must be absolute");
    }
    create_private_directory(directory)?;
    let lease = open_private_lock_file(&directory.join(LOCK))?;
    lease
        .try_lock()
        .context("another operator configuration operation is active")?;
    Ok(lease)
}

fn read(directory: &Path) -> Result<Option<Config>> {
    let bytes = match read_private_file(&directory.join(FILE), MAX_BYTES) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("cannot read private operator configuration"),
    };
    let config: Config =
        serde_json::from_slice(&bytes).context("invalid operator configuration")?;
    validate(&config)?;
    Ok(Some(config))
}

pub(crate) fn load(directory: &Path) -> Result<Option<Config>> {
    let _lease = lease(directory)?;
    read(directory)
}

pub(crate) fn save(directory: &Path, origin: &str, port: u16, local_only: bool) -> Result<Config> {
    let config = Config {
        version: 1,
        upstream_origin: origin.to_owned(),
        local_port: port,
        local_only,
    };
    validate(&config)?;
    let _lease = lease(directory)?;
    read(directory)?;
    write_private(&directory.join(FILE), &serde_json::to_vec(&config)?)?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Owned(PathBuf);
    impl Owned {
        fn new() -> Self {
            #[cfg(windows)]
            let parent = PathBuf::from(std::env::var_os("USERPROFILE").unwrap());
            #[cfg(not(windows))]
            let parent = std::env::temp_dir();
            let directory = parent.join(format!(
                ".iroh-operator-config-{}-{}",
                std::process::id(),
                rand::random::<u64>()
            ));
            create_private_directory(&directory).unwrap();
            Self(directory)
        }
    }
    impl Drop for Owned {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn absent_configuration_stays_absent_and_saved_nonsecret_settings_survive_reopening() {
        let owned = Owned::new();
        assert_eq!(load(&owned.0).unwrap(), None);
        assert!(!owned.0.join(FILE).exists());
        let expected = save(&owned.0, "http://127.0.0.1:3080", 25444, false).unwrap();
        assert_eq!(load(&owned.0).unwrap(), Some(expected));
        assert_eq!(
            serde_json::to_string(&save(&owned.0, "https://[::1]", 65535, true).unwrap()).unwrap(),
            r#"{"version":1,"upstreamOrigin":"https://[::1]","localPort":65535,"localOnly":true}"#
        );
    }

    #[test]
    fn origin_never_accepts_tokens_paths_noncanonical_ports_or_non_loopback_hosts() {
        let owned = Owned::new();
        for invalid in [
            "http://localhost:3080",
            "http://127.0.0.1:3080/?token=secret",
            "http://127.0.0.1/",
            "http://127.0.0.1.evil:3080",
            "http://user@127.0.0.1",
            "https://example.com",
            "http://127.0.0.1:080",
            "http://127.0.0.1:80",
            "http://127.0.0.1:0",
            "https://[::1]:443",
            "http://127.0.0.1:3080#secret",
            "http://127.0.0.1\\anything",
            "ftp://127.0.0.1",
            "HTTP://127.0.0.1",
        ] {
            assert!(save(&owned.0, invalid, 25443, false).is_err());
            assert!(!owned.0.join(FILE).exists());
        }
        assert!(save(&owned.0, "http://127.0.0.1", 1023, false).is_err());
    }

    #[test]
    fn corrupt_unknown_duplicate_and_oversized_state_are_not_replaced() {
        let owned = Owned::new();
        for bytes in [b"corrupt".to_vec(),
            br#"{"version":2,"upstreamOrigin":"http://127.0.0.1","localPort":25443,"localOnly":false}"#.to_vec(),
            br#"{"version":1,"upstreamOrigin":"http://127.0.0.1","localPort":25443,"localOnly":false,"token":"secret"}"#.to_vec(),
            br#"{"version":1,"upstreamOrigin":"http://127.0.0.1?token=secret","localPort":25443,"localOnly":false}"#.to_vec(),
            br#"{"version":1,"version":1,"upstreamOrigin":"http://127.0.0.1","localPort":25443,"localOnly":false}"#.to_vec(),
            vec![b' '; MAX_BYTES + 1]] {
            write_private(&owned.0.join(FILE), &bytes).unwrap();
            assert!(load(&owned.0).is_err());
            assert!(save(&owned.0, "http://127.0.0.1:3080", 25443, false).is_err());
            assert_eq!(std::fs::read(owned.0.join(FILE)).unwrap(), bytes);
        }
    }

    #[test]
    fn configuration_lease_is_independent_from_running_host_and_rejects_competing_writes() {
        let owned = Owned::new();
        save(&owned.0, "http://[::1]:3080", 25443, false).unwrap();
        let host = open_private_lock_file(&owned.0.join("host.lock")).unwrap();
        host.try_lock().unwrap();
        assert!(load(&owned.0).unwrap().is_some());
        let held = lease(&owned.0).unwrap();
        assert!(load(&owned.0).is_err());
        assert!(save(&owned.0, "http://127.0.0.1", 25443, false).is_err());
        drop(held);
        assert_eq!(load(&owned.0).unwrap().unwrap().local_port, 25443);
    }
}
