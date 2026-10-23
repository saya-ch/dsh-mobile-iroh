//! Windows-only private profile creation. Existing ACLs are verified, never reset.

use std::ffi::c_void;
use std::fs::File;
use std::io::{self, Read as _};
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Component, Path, PathBuf, Prefix};
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{
    LocalFree, GENERIC_ALL, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetAce, GetTokenInformation, IsValidSid, TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER,
    DACL_SECURITY_INFORMATION, INHERIT_ONLY_ACE, OWNER_SECURITY_INFORMATION, SECURITY_ATTRIBUTES,
    TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    CREATE_NEW, DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA, OPEN_ALWAYS, OPEN_EXISTING,
    READ_CONTROL, WRITE_DAC, WRITE_OWNER,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

const SYSTEM: &str = "S-1-5-18";
const ADMINISTRATORS: &str = "S-1-5-32-544";
// This OS service owns the Windows volume root; it is not granted access to private files.
const TRUSTED_INSTALLER: &str = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const ALLOW_ACE: u8 = 0;
const DENY_ACE: u8 = 1;

fn denied(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}
fn checked(success: i32) -> io::Result<()> {
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn wide(path: &Path) -> io::Result<Vec<u16>> {
    let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
    if value.contains(&0) {
        return Err(denied("private path contains a null character"));
    }
    value.push(0);
    Ok(value)
}

struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

fn sid_text(sid: *mut c_void) -> io::Result<String> {
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(denied("invalid owner or ACL SID"));
    }
    let mut buffer = null_mut();
    unsafe {
        checked(ConvertSidToStringSidW(sid, &mut buffer))?;
    }
    let allocation = LocalAllocation(buffer.cast());
    let mut length = 0;
    unsafe {
        while *buffer.add(length) != 0 {
            length += 1;
        }
    }
    let text = String::from_utf16(unsafe { std::slice::from_raw_parts(buffer, length) })
        .map_err(|_| denied("invalid SID encoding"))?;
    drop(allocation);
    Ok(text)
}

fn process_token(access: u32) -> io::Result<OwnedHandle> {
    let mut handle = null_mut();
    unsafe {
        checked(OpenProcessToken(GetCurrentProcess(), access, &mut handle))?;
        Ok(OwnedHandle::from_raw_handle(handle))
    }
}

fn current_sid() -> io::Result<String> {
    let token = process_token(TOKEN_QUERY)?;
    let mut needed = 0;
    unsafe {
        GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut needed);
    }
    if needed == 0 || needed > 64 * 1024 {
        return Err(denied("cannot determine current user SID"));
    }
    // usize storage supplies alignment for TOKEN_USER and the embedded SID.
    let mut storage = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
    unsafe {
        checked(GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            storage.as_mut_ptr().cast(),
            needed,
            &mut needed,
        ))?;
        let user = &*storage.as_ptr().cast::<TOKEN_USER>();
        sid_text(user.User.Sid)
    }
}

struct Descriptor(LocalAllocation);
impl Descriptor {
    fn private(user: &str) -> io::Result<Self> {
        Self::from_sddl(&format!(
            "O:{user}D:P(A;OICI;FA;;;{user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
        ))
    }
    fn from_sddl(sddl: &str) -> io::Result<Self> {
        let input: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
        let mut descriptor = null_mut();
        unsafe {
            checked(ConvertStringSecurityDescriptorToSecurityDescriptorW(
                input.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            ))?;
        }
        Ok(Self(LocalAllocation(descriptor)))
    }
    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0 .0,
            bInheritHandle: 0,
        }
    }
}

fn trusted(sid: &str, user: &str, ancestor: bool) -> bool {
    sid == user || sid == SYSTEM || sid == ADMINISTRATORS || ancestor && sid == TRUSTED_INSTALLER
}

/// Ignore deny and inherit-only ACEs; reject unfamiliar granting ACE kinds.
/// Ancestors may be readable, but no untrusted SID may replace them or their children.
fn check_acl(file: &File, user: &str, ancestor: bool) -> io::Result<()> {
    let mut owner = null_mut();
    let mut dacl = null_mut();
    let mut descriptor = null_mut();
    let error = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if error != 0 {
        return Err(io::Error::from_raw_os_error(error as i32));
    }
    let _allocation = LocalAllocation(descriptor);
    if !trusted(&sid_text(owner)?, user, ancestor) || dacl.is_null() {
        return Err(denied(
            "private path has an untrusted owner or unrestricted DACL",
        ));
    }
    let count = unsafe { (*dacl).AceCount };
    for index in 0..u32::from(count) {
        let mut ace = null_mut();
        unsafe {
            checked(GetAce(dacl, index, &mut ace))?;
        }
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        if u32::from(header.AceFlags) & INHERIT_ONLY_ACE != 0 || header.AceType == DENY_ACE {
            continue;
        }
        if header.AceType != ALLOW_ACE
            || usize::from(header.AceSize) < offset_of!(ACCESS_ALLOWED_ACE, SidStart) + 8
        {
            return Err(denied("private path contains an unsupported granting ACE"));
        }
        let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        let sid = unsafe {
            ace.cast::<u8>()
                .add(offset_of!(ACCESS_ALLOWED_ACE, SidStart))
        };
        let sid_size = 8 + usize::from(unsafe { *sid.add(1) }) * 4;
        if offset_of!(ACCESS_ALLOWED_ACE, SidStart) + sid_size > usize::from(header.AceSize) {
            return Err(denied("private path contains a malformed SID"));
        }
        let sid = sid_text(sid.cast())?;
        if trusted(&sid, user, ancestor) {
            continue;
        }
        let mask = allowed.Mask;
        let unsafe_access = if ancestor {
            mask & (DELETE
                | FILE_DELETE_CHILD
                | WRITE_DAC
                | WRITE_OWNER
                | FILE_WRITE_DATA
                | FILE_WRITE_EA
                | FILE_WRITE_ATTRIBUTES
                | GENERIC_ALL
                | GENERIC_WRITE)
                != 0
        } else {
            mask != 0
        };
        if unsafe_access {
            return Err(denied(
                "private path ACL grants access or replacement rights to another principal",
            ));
        }
    }
    Ok(())
}

fn open_existing(path: &Path, read: bool) -> io::Result<File> {
    let value = wide(path)?;
    let handle = unsafe {
        CreateFileW(
            value.as_ptr(),
            READ_CONTROL | FILE_READ_ATTRIBUTES | if read { GENERIC_READ } else { 0 },
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_handle(handle) };
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    unsafe {
        checked(GetFileInformationByHandle(
            file.as_raw_handle(),
            &mut information,
        ))?;
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(denied("private path must not contain a reparse point"));
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        && information.nNumberOfLinks != 1
    {
        return Err(denied("private file must have exactly one hard link"));
    }
    if read && information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        return Err(denied("private state must be a regular file"));
    }
    Ok(file)
}

fn paths(path: &Path) -> io::Result<Vec<PathBuf>> {
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return Err(denied("private paths must be absolute local-drive paths"));
    };
    if !matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        || components.next() != Some(Component::RootDir)
    {
        return Err(denied("UNC and device private paths are unsupported"));
    }
    let mut current = PathBuf::from(prefix.as_os_str());
    current.push("\\");
    let mut result = vec![current.clone()];
    for component in components {
        let Component::Normal(part) = component else {
            return Err(denied("relative private path components are unsupported"));
        };
        // Reject alternate streams and Win32 spellings whose trailing characters are normalized.
        let text = part.to_string_lossy();
        let stem = text
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || stem
                .strip_prefix("COM")
                .or_else(|| stem.strip_prefix("LPT"))
                .is_some_and(|suffix| {
                    matches!(
                        suffix,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                });
        if text.contains(':') || text.ends_with(['.', ' ']) || reserved {
            return Err(denied("ambiguous private path component"));
        }
        current.push(part);
        result.push(current.clone());
    }
    Ok(result)
}

/// Hold non-delete-shared handles for all ancestors throughout creation/read.
/// Existing broad directories are never modified to make a path pass validation.
fn guard_directories(path: &Path, create: bool) -> io::Result<Vec<File>> {
    let paths = paths(path)?;
    let user = current_sid()?;
    let descriptor = Descriptor::private(&user)?;
    let mut handles = Vec::new();
    for (index, item) in paths.iter().enumerate() {
        let file = match open_existing(item, false) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound && create => {
                let value = wide(item)?;
                let attributes = descriptor.attributes();
                if unsafe { CreateDirectoryW(value.as_ptr(), &attributes) } == 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::AlreadyExists {
                        return Err(error);
                    }
                }
                open_existing(item, false)?
            }
            Err(error) => return Err(error),
        };
        if !file.metadata()?.is_dir() {
            return Err(denied("private path ancestor is not a directory"));
        }
        check_acl(&file, &user, index + 1 < paths.len())?;
        handles.push(file);
    }
    Ok(handles)
}

pub(super) fn ensure_directory(path: &Path) -> io::Result<()> {
    guard_directories(path, true).map(|_| ())
}

pub(super) fn verify_file(path: &Path) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| denied("private file requires a parent directory"))?;
    let _guards = guard_directories(parent, false)?;
    paths(path)?;
    let file = open_existing(path, false)?;
    if !file.metadata()?.is_file() {
        return Err(denied("private state must be a regular file"));
    }
    check_acl(&file, &current_sid()?, false)
}

pub(super) fn create_file(path: &Path) -> io::Result<File> {
    let parent = path
        .parent()
        .ok_or_else(|| denied("private file requires a parent directory"))?;
    let _guards = guard_directories(parent, false)?;
    paths(path)?;
    let descriptor = Descriptor::private(&current_sid()?)?;
    let attributes = descriptor.attributes();
    let value = wide(path)?;
    let handle = unsafe {
        CreateFileW(
            value.as_ptr(),
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
            FILE_SHARE_READ,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_handle(handle) };
    if let Err(error) = check_acl(&file, &current_sid()?, false) {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err(error);
    }
    Ok(file)
}

/// Open the private profile lease without FILE_SHARE_DELETE. Existing objects
/// are checked through this same non-reparse handle before the caller locks it.
pub(super) fn open_lock_file(path: &Path) -> io::Result<File> {
    let parent = path
        .parent()
        .ok_or_else(|| denied("profile lock requires a parent directory"))?;
    let _guards = guard_directories(parent, false)?;
    paths(path)?;
    let user = current_sid()?;
    let descriptor = Descriptor::private(&user)?;
    let attributes = descriptor.attributes();
    let value = wide(path)?;
    let handle = unsafe {
        CreateFileW(
            value.as_ptr(),
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &attributes,
            OPEN_ALWAYS,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_handle(handle) };
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    unsafe {
        checked(GetFileInformationByHandle(
            file.as_raw_handle(),
            &mut information,
        ))?;
    }
    if information.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0
        || information.nNumberOfLinks != 1
    {
        return Err(denied("profile lock must be a regular non-reparse file"));
    }
    check_acl(&file, &user, false)?;
    Ok(file)
}

pub(super) fn read_file(path: &Path, maximum: usize) -> io::Result<Vec<u8>> {
    let parent = path
        .parent()
        .ok_or_else(|| denied("private file requires a parent directory"))?;
    let _guards = guard_directories(parent, false)?;
    paths(path)?;
    let file = open_existing(path, true)?;
    check_acl(&file, &current_sid()?, false)?;
    if file.metadata()?.len() > maximum as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "private state exceeds byte limit",
        ));
    }
    let mut bytes = Vec::new();
    file.take(maximum as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "private state exceeds byte limit",
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
    use windows_sys::Win32::Security::{
        AccessCheck, CreateRestrictedToken, DuplicateTokenEx, GetSecurityDescriptorControl,
        SecurityImpersonation, TokenImpersonation, DISABLE_MAX_PRIVILEGE, GENERIC_MAPPING,
        GROUP_SECURITY_INFORMATION, PRIVILEGE_SET, PSECURITY_DESCRIPTOR, SID_AND_ATTRIBUTES,
        TOKEN_DUPLICATE, TOKEN_IMPERSONATE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ALL_ACCESS, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    };

    fn root(label: &str) -> PathBuf {
        // TEMP can intentionally be writable by other sandbox users. Use the
        // same verified constructor below the current user's profile instead.
        let root = PathBuf::from(std::env::var_os("USERPROFILE").unwrap())
            .join(format!(".iroh-acl-test-{}-{label}", std::process::id()));
        ensure_directory(&root).unwrap();
        root
    }

    fn access(file: &File, token: HANDLE) -> bool {
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let error = unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(error, 0);
        let _descriptor = LocalAllocation(descriptor);
        let mapping = GENERIC_MAPPING {
            GenericRead: FILE_GENERIC_READ,
            GenericWrite: FILE_GENERIC_WRITE,
            GenericExecute: 0,
            GenericAll: FILE_ALL_ACCESS,
        };
        let mut privileges: PRIVILEGE_SET = unsafe { std::mem::zeroed() };
        let mut length = size_of::<PRIVILEGE_SET>() as u32;
        let mut granted = 0;
        let mut allowed = 0;
        unsafe {
            checked(AccessCheck(
                descriptor,
                token,
                FILE_GENERIC_READ,
                &mapping,
                &mut privileges,
                &mut length,
                &mut granted,
                &mut allowed,
            ))
            .unwrap();
        }
        allowed != 0
    }

    #[test]
    fn creation_dacl_allows_current_user_and_denies_everyone_restricted_token() {
        use std::io::Write;
        let root = root("token");
        let path = root.join("secret");
        let mut file = create_file(&path).unwrap();
        file.write_all(b"private").unwrap();
        file.sync_all().unwrap();
        check_acl(&file, &current_sid().unwrap(), false).unwrap();
        let mut descriptor = null_mut();
        let mut dacl = null_mut();
        let error = unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(error, 0);
        let _descriptor = LocalAllocation(descriptor);
        let mut control = 0;
        let mut revision = 0;
        unsafe {
            checked(GetSecurityDescriptorControl(
                descriptor,
                &mut control,
                &mut revision,
            ))
            .unwrap();
            assert_eq!((*dacl).AceCount, 3);
        }
        assert_ne!(
            control & windows_sys::Win32::Security::SE_DACL_PROTECTED,
            0,
            "new secret DACL must be protected from inheritance"
        );
        let token = process_token(TOKEN_QUERY | TOKEN_DUPLICATE).unwrap();
        let mut impersonation = null_mut();
        unsafe {
            checked(DuplicateTokenEx(
                token.as_raw_handle(),
                TOKEN_QUERY | TOKEN_IMPERSONATE | TOKEN_DUPLICATE,
                null(),
                SecurityImpersonation,
                TokenImpersonation,
                &mut impersonation,
            ))
            .unwrap();
        }
        let impersonation = unsafe { OwnedHandle::from_raw_handle(impersonation) };
        assert!(access(&file, impersonation.as_raw_handle()));
        let text: Vec<u16> = "S-1-1-0".encode_utf16().chain(Some(0)).collect();
        let mut everyone = null_mut();
        unsafe {
            checked(ConvertStringSidToSidW(text.as_ptr(), &mut everyone)).unwrap();
        }
        let _everyone = LocalAllocation(everyone);
        let restriction = SID_AND_ATTRIBUTES {
            Sid: everyone,
            Attributes: 0,
        };
        let mut restricted = null_mut();
        unsafe {
            checked(CreateRestrictedToken(
                impersonation.as_raw_handle(),
                DISABLE_MAX_PRIVILEGE,
                0,
                null(),
                0,
                null(),
                1,
                &restriction,
                &mut restricted,
            ))
            .unwrap();
        }
        let restricted = unsafe { OwnedHandle::from_raw_handle(restricted) };
        assert!(!access(&file, restricted.as_raw_handle()));
        drop(file);
        assert_eq!(read_file(&path, 16).unwrap(), b"private");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_world_readable_secret_is_rejected_not_repaired_or_replaced() {
        use std::io::Write;
        let root = root("old-secret");
        let path = root.join("identity.key");
        let user = current_sid().unwrap();
        let descriptor =
            Descriptor::from_sddl(&format!("O:{user}D:P(A;;FA;;;{user})(A;;FR;;;WD)")).unwrap();
        let value = wide(&path).unwrap();
        let attrs = descriptor.attributes();
        let handle = unsafe {
            CreateFileW(
                value.as_ptr(),
                GENERIC_WRITE | READ_CONTROL,
                FILE_SHARE_READ,
                &attrs,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        };
        assert_ne!(handle, INVALID_HANDLE_VALUE);
        let mut file = unsafe { File::from_raw_handle(handle) };
        file.write_all(&[7u8; 32]).unwrap();
        file.sync_all().unwrap();
        drop(file);
        assert!(read_file(&path, 32).is_err());
        assert!(super::super::load_or_create_secret(&path).is_err());
        assert!(super::super::write_private(&path, b"replacement").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), [7u8; 32]);
        assert!(check_acl(&open_existing(&path, false).unwrap(), &user, false).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_junction_is_rejected_without_touching_its_target() {
        let root = root("junction");
        let target = root.join("target");
        ensure_directory(&target).unwrap();
        let sentinel = target.join("keep");
        super::super::write_private(&sentinel, b"unchanged").unwrap();
        let junction = root.join("junction");
        let status = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(
            status.success(),
            "creating a junction in the owned test directory failed"
        );
        assert!(ensure_directory(&junction).is_err());
        assert!(read_file(&junction.join("keep"), 32).is_err());
        assert!(super::super::write_private(&junction.join("new"), b"bad").is_err());
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"unchanged");
        assert!(!target.join("new").exists());
        // Remove only the junction itself, then the exact owned test root.
        std::fs::remove_dir(&junction).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hard_linked_private_files_and_locks_are_rejected_without_changing_bytes_or_acl() {
        let owned = root("hardlink");
        let sentinel = owned.join("sentinel");
        let linked = owned.join("linked");
        super::super::write_private(&sentinel, b"keep-private-sentinel").unwrap();
        std::fs::hard_link(&sentinel, &linked).unwrap();
        let icacls =
            PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/icacls.exe");
        let before = std::process::Command::new(&icacls)
            .arg(&sentinel)
            .output()
            .unwrap();
        assert!(before.status.success());
        assert!(read_file(&linked, 64).is_err());
        assert!(super::super::write_private(&linked, b"must-not-replace").is_err());
        assert!(open_lock_file(&linked).is_err());
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"keep-private-sentinel");
        assert_eq!(std::fs::read(&linked).unwrap(), b"keep-private-sentinel");
        let after = std::process::Command::new(&icacls)
            .arg(&sentinel)
            .output()
            .unwrap();
        assert!(after.status.success());
        assert_eq!(before.stdout, after.stdout);
        std::fs::remove_dir_all(owned).unwrap();
    }

    #[test]
    fn exclusive_creation_and_concurrent_replacements_never_truncate_another_file() {
        use std::io::Write;
        let root = root("atomic");
        let existing = root.join("existing");
        let mut file = create_file(&existing).unwrap();
        file.write_all(b"keep").unwrap();
        drop(file);
        assert_eq!(
            create_file(&existing).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read(&existing).unwrap(), b"keep");
        let state = root.join("paired.json");
        super::super::write_private(&state, &vec![0u8; 4096]).unwrap();
        let mut writers = Vec::new();
        for byte in 1u8..9 {
            let state = state.clone();
            writers.push(std::thread::spawn(move || {
                super::super::write_private(&state, &vec![byte; 4096])
            }));
        }
        for writer in writers {
            let _ = writer.join().unwrap();
        }
        let value = read_file(&state, 4096).unwrap();
        assert_eq!(value.len(), 4096);
        assert!(value.iter().all(|byte| *byte == value[0]));
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn broad_existing_acl_is_rejected_without_mutating_it() {
        let root = root("broad");
        let path = root.join("wide");
        let user = current_sid().unwrap();
        let descriptor =
            Descriptor::from_sddl(&format!("O:{user}D:P(A;OICI;FA;;;{user})(A;OICI;FA;;;WD)"))
                .unwrap();
        let value = wide(&path).unwrap();
        let attrs = descriptor.attributes();
        unsafe {
            checked(CreateDirectoryW(value.as_ptr(), &attrs)).unwrap();
        }
        assert!(ensure_directory(&path).is_err());
        assert!(ensure_directory(&path.join("child")).is_err());
        assert!(!path.join("child").exists());
        let file = open_existing(&path, false).unwrap();
        assert!(check_acl(&file, &user, false).is_err());
        drop(file);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ambiguous_and_relative_windows_paths_are_rejected() {
        for value in [
            "relative\\secret",
            "\\\\server\\share\\secret",
            "C:\\data\\..\\secret",
            "C:\\data\\secret:stream",
            "C:\\data\\trailing.",
            "C:\\data\\COM¹",
            "C:\\data\\COM².log",
            "C:\\data\\COM³.ext",
            "C:\\data\\LPT¹",
            "C:\\data\\LPT².log",
            "C:\\data\\LPT³.ext",
        ] {
            assert!(paths(Path::new(value)).is_err());
        }
    }
}
