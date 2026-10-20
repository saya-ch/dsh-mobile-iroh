//! Descriptor-relative POSIX private storage; existing ownership/modes are never changed.

use std::ffi::{CString, OsStr};
use std::fs::File;
use std::io::{self, Read as _, Write as _};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

fn denied(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}
fn name(value: &OsStr) -> io::Result<CString> {
    if value.as_bytes().contains(&b'/') || value == "." || value == ".." {
        return Err(denied("private file name must be a single component"));
    }
    CString::new(value.as_bytes()).map_err(|_| denied("private path contains a null character"))
}
fn checked_fd(fd: RawFd) -> io::Result<File> {
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
fn trusted_system(uid: u32) -> bool {
    uid == 0 || cfg!(target_os = "android") && uid == 1000
}
fn directory_flags() -> libc::c_int {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC
    }
    #[cfg(target_os = "macos")]
    {
        libc::O_SEARCH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC
    }
    #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
    {
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC
    }
}

fn check_directory(file: &File, private: bool) -> io::Result<()> {
    let metadata = file.metadata()?;
    let uid = unsafe { libc::geteuid() };
    if !metadata.is_dir() {
        return Err(denied(
            "private path contains a non-directory or symbolic link",
        ));
    }
    let mode = metadata.mode();
    if private {
        if metadata.uid() != uid || mode & 0o077 != 0 || mode & 0o500 != 0o500 || mode & 0o7000 != 0
        {
            return Err(denied(
                "existing private directory owner/mode is unsafe; choose a new private profile",
            ));
        }
    } else {
        if metadata.uid() != uid && !trusted_system(metadata.uid()) {
            return Err(denied("private directory has an untrusted ancestor owner"));
        }
        let sticky_system = trusted_system(metadata.uid()) && mode & 0o1000 != 0;
        let trusted_group =
            cfg!(target_os = "android") && (metadata.gid() == 1000 || metadata.gid() == uid);
        if !sticky_system && (mode & 0o002 != 0 || mode & 0o020 != 0 && !trusted_group) {
            return Err(denied(
                "private directory has a writable untrusted ancestor",
            ));
        }
    }
    Ok(())
}

fn check_file(file: &File) -> io::Result<()> {
    let metadata = file.metadata()?;
    let mode = metadata.mode();
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
        || mode & 0o077 != 0
        || mode & 0o400 == 0
        || mode & 0o7100 != 0
    {
        return Err(denied(
            "existing private file owner/mode or hard-link count is unsafe",
        ));
    }
    Ok(())
}

fn components(path: &Path) -> io::Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
    {
        return Err(denied(
            "private paths must be absolute and contain no parent traversal",
        ));
    }
    Ok(())
}

/// Only fixed system-owned aliases are expanded. The actual canonical target
/// is then walked with no-follow descriptor operations, never used as a trusted string alone.
fn resolve_system_alias(path: &Path) -> io::Result<PathBuf> {
    components(path)?;
    for alias in ["/var", "/tmp", "/home", "/data/data", "/data/user/0"] {
        let alias = Path::new(alias);
        if !path.starts_with(alias) {
            continue;
        }
        let metadata = match std::fs::symlink_metadata(alias) {
            Ok(value) => value,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if !metadata.file_type().is_symlink() {
            continue;
        }
        if !trusted_system(metadata.uid()) {
            return Err(denied("private path system alias has an untrusted owner"));
        }
        let _parent = walk_directories(alias.parent().unwrap_or(Path::new("/")), false, false)?;
        let canonical = std::fs::canonicalize(alias)?;
        return Ok(canonical.join(
            path.strip_prefix(alias)
                .map_err(|_| denied("invalid private path alias"))?,
        ));
    }
    Ok(path.to_path_buf())
}

fn walk_directories(path: &Path, create: bool, private_leaf: bool) -> io::Result<File> {
    components(path)?;
    let root = CString::new("/").expect("literal has no null");
    let mut current = checked_fd(unsafe { libc::open(root.as_ptr(), directory_flags()) })?;
    let pieces: Vec<_> = path
        .components()
        .filter_map(|part| {
            if let Component::Normal(value) = part {
                Some(value)
            } else {
                None
            }
        })
        .collect();
    check_directory(&current, private_leaf && pieces.is_empty())?;
    for (index, piece) in pieces.iter().enumerate() {
        let child = name(piece)?;
        let mut next =
            unsafe { libc::openat(current.as_raw_fd(), child.as_ptr(), directory_flags()) };
        if next < 0 && create && io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
            if unsafe { libc::mkdirat(current.as_raw_fd(), child.as_ptr(), 0o700) } != 0
                && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists
            {
                return Err(io::Error::last_os_error());
            }
            next = unsafe { libc::openat(current.as_raw_fd(), child.as_ptr(), directory_flags()) };
        }
        let next = checked_fd(next)?;
        check_directory(&next, private_leaf && index + 1 == pieces.len())?;
        current = next;
    }
    Ok(current)
}

fn directory(path: &Path, create: bool) -> io::Result<File> {
    let resolved = resolve_system_alias(path)?;
    let directory = walk_directories(&resolved, create, true)?;
    // Reopen the already verified private directory, not its pathname. Ancestors
    // use O_PATH/O_SEARCH so execute-only Android parents remain traversable.
    let dot = CString::new(".").expect("literal has no null");
    let writable_directory = checked_fd(unsafe {
        libc::openat(
            directory.as_raw_fd(),
            dot.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    })?;
    check_directory(&writable_directory, true)?;
    let before = directory.metadata()?;
    let after = writable_directory.metadata()?;
    if before.dev() != after.dev() || before.ino() != after.ino() {
        return Err(denied(
            "private directory changed while opening its sync handle",
        ));
    }
    Ok(writable_directory)
}

pub(super) fn ensure_directory(path: &Path) -> io::Result<()> {
    directory(path, true).map(|_| ())
}

fn parent(path: &Path, create: bool) -> io::Result<(File, CString)> {
    components(path)?;
    let file_name = path
        .file_name()
        .ok_or_else(|| denied("private file requires a basename"))?;
    Ok((
        directory(
            path.parent()
                .ok_or_else(|| denied("private file requires a parent"))?,
            create,
        )?,
        name(file_name)?,
    ))
}

fn open_file(parent: &File, name: &CString, flags: libc::c_int) -> io::Result<File> {
    let file = checked_fd(unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            0o600,
        )
    })?;
    check_file(&file)?;
    Ok(file)
}

pub(super) fn read_file(path: &Path, maximum: usize) -> io::Result<Vec<u8>> {
    let (parent, name) = parent(path, false)?;
    read_at(&parent, &name, maximum)
}

fn read_at(parent: &File, name: &CString, maximum: usize) -> io::Result<Vec<u8>> {
    let file = open_file(parent, name, libc::O_RDONLY)?;
    if file.metadata()?.len() > maximum as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "private state exceeds byte limit",
        ));
    }
    let mut bytes = Vec::new();
    file.take((maximum as u64).saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "private state exceeds byte limit",
        ));
    }
    Ok(bytes)
}

pub(super) fn open_lock_file(path: &Path) -> io::Result<File> {
    let (parent, name) = parent(path, true)?;
    open_file(&parent, &name, libc::O_RDWR | libc::O_CREAT)
}

pub(super) fn load_secret(path: &Path) -> io::Result<iroh::SecretKey> {
    let (parent, name) = parent(path, true)?;
    match read_at(&parent, &name, 32) {
        Ok(bytes) => {
            let bytes: [u8; 32] = bytes.try_into().map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "identity requires exactly 32 bytes",
                )
            })?;
            Ok(iroh::SecretKey::from_bytes(&bytes))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let key = iroh::SecretKey::generate();
            match open_file(
                &parent,
                &name,
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            ) {
                Ok(mut file) => {
                    file.write_all(&key.to_bytes())?;
                    file.sync_all()?;
                    parent.sync_all()?;
                    Ok(key)
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let bytes = read_at(&parent, &name, 32)?;
                    let bytes: [u8; 32] = bytes.try_into().map_err(|_| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            "identity requires exactly 32 bytes",
                        )
                    })?;
                    Ok(iroh::SecretKey::from_bytes(&bytes))
                }
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    }
}

pub(super) fn write_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let temporary = format!(
        ".iroh-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    replace_with_name(path, bytes, OsStr::new(&temporary))
}

pub(super) fn replace_with_name(path: &Path, bytes: &[u8], temporary: &OsStr) -> io::Result<()> {
    let (parent, target) = parent(path, true)?;
    let temporary = name(temporary)?;
    replace_at(&parent, &target, bytes, &temporary)
}

fn replace_at(
    parent: &File,
    target: &CString,
    bytes: &[u8],
    temporary: &CString,
) -> io::Result<()> {
    match open_file(parent, target, libc::O_RDONLY) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    // Do not remove a pre-existing temporary file, even when creation collides.
    let mut file = open_file(
        parent,
        temporary,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
    )?;
    let result = (|| -> io::Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if unsafe {
            libc::renameat(
                parent.as_raw_fd(),
                temporary.as_ptr(),
                parent.as_raw_fd(),
                target.as_ptr(),
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        parent.sync_all()
    })();
    if result.is_err() {
        unsafe {
            libc::unlinkat(parent.as_raw_fd(), temporary.as_ptr(), 0);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("iroh-posix-{}-{label}", std::process::id()));
        ensure_directory(&root).unwrap();
        root
    }
    #[test]
    fn rejects_broad_existing_directory_without_chmod_or_secret_creation() {
        let root = root("broad");
        let path = root.join("existing");
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(ensure_directory(&path).is_err());
        assert!(load_secret(&path.join("identity.key")).is_err());
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o755);
        assert!(!path.join("identity.key").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[cfg(not(target_os = "android"))]
    fn group_writable_ancestor_is_not_trusted_even_for_group_zero() {
        let root = root("group-ancestor");
        let ancestor = root.join("shared");
        std::fs::create_dir(&ancestor).unwrap();
        std::fs::set_permissions(&ancestor, std::fs::Permissions::from_mode(0o775)).unwrap();
        let result = ensure_directory(&ancestor.join("profile"));
        let mode = std::fs::metadata(&ancestor).unwrap().mode() & 0o777;
        std::fs::remove_dir_all(root).unwrap();
        assert!(
            result.is_err(),
            "a non-sticky group-writable parent is not a private namespace"
        );
        assert_eq!(mode, 0o775);
    }
    #[test]
    fn rejects_old_readable_identity_state_and_lock_without_chmod_or_overwrite() {
        let root = root("old");
        for basename in ["identity.key", "paired.json", "host.lock"] {
            let path = root.join(basename);
            std::fs::write(&path, [7u8; 32]).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(read_file(&path, 32).is_err());
            assert!(load_secret(&path).is_err());
            assert!(write_file(&path, b"new").is_err());
            assert!(open_lock_file(&path).is_err());
            assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o644);
            assert_eq!(std::fs::read(&path).unwrap(), [7u8; 32]);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn private_modes_round_trip_and_nofollow_parent_and_file() {
        let root = root("links");
        let key = root.join("identity.key");
        let first = load_secret(&key).unwrap();
        assert_eq!(load_secret(&key).unwrap().to_bytes(), first.to_bytes());
        assert_eq!(std::fs::metadata(&key).unwrap().mode() & 0o777, 0o600);
        let link = root.join("link");
        symlink(&key, &link).unwrap();
        assert!(read_file(&link, 32).is_err());
        assert!(write_file(&link, b"bad").is_err());
        let directory_link = root.join("dir-link");
        symlink(&root, &directory_link).unwrap();
        assert!(write_file(&directory_link.join("bad"), b"bad").is_err());
        assert!(!root.join("bad").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn exclusive_temporary_collision_and_concurrent_replace_are_safe() {
        let root = root("concurrent");
        let target = root.join("paired.json");
        write_file(&target, &[0; 4096]).unwrap();
        let collision = root.join("collision");
        write_file(&collision, b"keep").unwrap();
        assert!(replace_with_name(&target, b"bad", OsStr::new("collision")).is_err());
        assert_eq!(read_file(&collision, 16).unwrap(), b"keep");
        let mut workers = Vec::new();
        for byte in 1..8 {
            let target = target.clone();
            workers.push(std::thread::spawn(move || {
                write_file(&target, &[byte; 4096])
            }));
        }
        for worker in workers {
            worker.join().unwrap().unwrap();
        }
        let bytes = read_file(&target, 4096).unwrap();
        assert_eq!(bytes.len(), 4096);
        assert!(bytes.iter().all(|byte| *byte == bytes[0]));
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn descriptor_relative_write_does_not_follow_a_replaced_parent_pathname() {
        let root = root("parent-race");
        let original = root.join("original");
        ensure_directory(&original).unwrap();
        let target_path = original.join("paired.json");
        write_file(&target_path, b"old").unwrap();
        let (directory_fd, target_name) = parent(&target_path, false).unwrap();
        let moved = root.join("moved");
        std::fs::rename(&original, &moved).unwrap();
        ensure_directory(&original).unwrap();
        write_file(&original.join("paired.json"), b"replacement-directory").unwrap();
        replace_at(
            &directory_fd,
            &target_name,
            b"verified-directory",
            &CString::new("race.tmp").unwrap(),
        )
        .unwrap();
        assert_eq!(
            read_file(&moved.join("paired.json"), 64).unwrap(),
            b"verified-directory"
        );
        assert_eq!(
            read_file(&original.join("paired.json"), 64).unwrap(),
            b"replacement-directory"
        );
        drop(directory_fd);
        std::fs::remove_dir_all(root).unwrap();
    }
}
