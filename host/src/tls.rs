//! Fixed private TLS state. An atomic write-ahead record retains the old leaf
//! until all three public-Gateway material files have been replaced and verified.
//! Recovery accepts only exact recorded bytes; unknown material is never repaired.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use ::time::{Duration, OffsetDateTime};
use anyhow::{bail, Context as _, Result};
use dsh_mobile_iroh_core::{
    create_private_directory, load_or_create_secret, open_private_lock_file, read_private_file,
    write_private,
};
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use x509_parser::extensions::GeneralName;
use x509_parser::prelude::{parse_x509_certificate, X509Certificate};

const STATE: &str = "tls-state.json";
const LOCK: &str = "tls.lock";
const MATERIAL_DIRECTORY: &str = "tls";
const CA: &str = "ca.pem";
const CERT: &str = "server.pem";
const KEY: &str = "server-key.pem";
const MAX_STATE_BYTES: usize = 32 * 1024;
const MAX_PEM_BYTES: usize = 8 * 1024;
const CA_VALIDITY_DAYS: i64 = 3650;
const CLOCK_ALLOWANCE_SECONDS: i64 = 300;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Leaf {
    certificate: String,
    private_key: String,
}

#[derive(Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    Initial,
    Renewing,
    Stable,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u8,
    endpoint_id: String,
    ca_certificate: String,
    ca_private_key: String,
    leaf: Leaf,
    phase: Phase,
    previous_leaf: Option<Leaf>,
}

/// Only public fingerprints, expiry and fixed paths cross the native stdio API.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Metadata {
    version: u8,
    endpoint_id: String,
    hostname: String,
    instance_id: String,
    ca_fingerprint256: String,
    leaf_fingerprint256: String,
    ca_valid_to: i64,
    leaf_valid_to: i64,
    tls: MaterialPaths,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MaterialPaths {
    ca_file: PathBuf,
    cert_file: PathBuf,
    key_file: PathBuf,
}

/// A leaf lifetime of at most one year and a strictly smaller renewal window.
#[derive(Clone, Copy)]
pub(crate) struct Policy {
    pub(crate) leaf_validity_days: u16,
    pub(crate) renew_before_days: u16,
}

impl Policy {
    fn validate(self) -> Result<()> {
        if !(2..=365).contains(&self.leaf_validity_days)
            || self.renew_before_days == 0
            || self.renew_before_days >= self.leaf_validity_days
        {
            bail!("invalid TLS lifetime policy");
        }
        Ok(())
    }
}

fn lock(dir: &Path) -> Result<std::fs::File> {
    if !dir.is_absolute() {
        bail!("TLS directory must be absolute");
    }
    create_private_directory(dir)?;
    let lease = open_private_lock_file(&dir.join(LOCK))?;
    lease
        .try_lock()
        .context("another TLS operation is active")?;
    Ok(lease)
}

fn hostname(endpoint_id: &str) -> String {
    format!(
        "{}.{}.iroh.localhost",
        &endpoint_id[..32],
        &endpoint_id[32..]
    )
}

fn read_optional(path: &Path, maximum: usize) -> Result<Option<Vec<u8>>> {
    match read_private_file(path, maximum) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).context("cannot read private TLS state"),
    }
}

fn read_state(dir: &Path) -> Result<Option<State>> {
    let Some(bytes) = read_optional(&dir.join(STATE), MAX_STATE_BYTES)? else {
        return Ok(None);
    };
    let state: State = serde_json::from_slice(&bytes).context("invalid TLS state")?;
    if state.version != 1 || serde_json::to_vec(&state)? != bytes {
        bail!("unsupported or noncanonical TLS state");
    }
    if !matches!(
        (state.phase, state.previous_leaf.is_some()),
        (Phase::Initial | Phase::Stable, false) | (Phase::Renewing, true)
    ) {
        bail!("invalid TLS transaction phase");
    }
    Ok(Some(state))
}

/// Resolve identity under the TLS writer lease without replacing an identity
/// already associated with durable CA state or orphaned material.
pub(crate) fn load_identity(dir: &Path) -> Result<iroh::SecretKey> {
    let _lease = lock(dir)?;
    let state = read_state(dir)?;
    if read_optional(&dir.join("identity.key"), 32)?.is_none() {
        let material = dir.join(MATERIAL_DIRECTORY);
        let has_material = match std::fs::symlink_metadata(&material) {
            Ok(_) => {
                create_private_directory(&material)?;
                std::fs::read_dir(&material)?.next().is_some()
            }
            Err(error) if error.kind() == ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        if state.is_some() || has_material {
            bail!("existing TLS identity is missing; refusing to generate a replacement");
        }
    }
    let secret = load_or_create_secret(&dir.join("identity.key"))?;
    if state.is_some_and(|state| state.endpoint_id != secret.public().to_string()) {
        bail!("existing identity does not match TLS state");
    }
    Ok(secret)
}

fn save_state(dir: &Path, state: &State) -> Result<()> {
    let bytes = serde_json::to_vec(state)?;
    if bytes.len() > MAX_STATE_BYTES {
        bail!("TLS state exceeds byte limit");
    }
    write_private(&dir.join(STATE), &bytes)
}

fn certificate_der(pem: &str) -> Result<Vec<u8>> {
    let normalized = pem.replace("\r\n", "\n");
    if pem.len() > MAX_PEM_BYTES
        || normalized.contains('\r')
        || !normalized.starts_with("-----BEGIN CERTIFICATE-----\n")
        || !normalized.ends_with("-----END CERTIFICATE-----\n")
    {
        bail!("invalid certificate PEM encoding");
    }
    let (remaining, parsed) = x509_parser::pem::parse_x509_pem(pem.as_bytes())
        .map_err(|_| anyhow::anyhow!("invalid certificate PEM"))?;
    if !remaining.is_empty() || parsed.label != "CERTIFICATE" {
        bail!("certificate must contain exactly one PEM block");
    }
    Ok(parsed.contents)
}

fn private_key(pem: &str) -> Result<KeyPair> {
    if pem.len() > MAX_PEM_BYTES {
        bail!("private key exceeds byte limit");
    }
    let key = KeyPair::from_pem(pem).context("invalid TLS private key")?;
    if key.serialize_pem() != pem || key.algorithm() != &rcgen::PKCS_ECDSA_P256_SHA256 {
        bail!("unsupported private key encoding or algorithm");
    }
    Ok(key)
}

fn parsed_certificate(der: &[u8]) -> Result<X509Certificate<'_>> {
    let (remaining, certificate) =
        parse_x509_certificate(der).map_err(|_| anyhow::anyhow!("invalid certificate DER"))?;
    if !remaining.is_empty() || certificate.version().0 != 2 {
        bail!("unsupported certificate DER");
    }
    certificate
        .extensions_map()
        .context("duplicate certificate extension")?;
    Ok(certificate)
}

fn validity(
    certificate: &X509Certificate<'_>,
    now: OffsetDateTime,
    allow_expired: bool,
) -> Result<i64> {
    let validity = certificate.validity();
    let from = validity.not_before.timestamp();
    let to = validity.not_after.timestamp();
    if from > now.unix_timestamp() || from >= to || (!allow_expired && to <= now.unix_timestamp()) {
        bail!("certificate is outside its validity period");
    }
    Ok(to)
}

fn validate_leaf(
    leaf: &Leaf,
    ca: &X509Certificate<'_>,
    name: &str,
    now: OffsetDateTime,
) -> Result<i64> {
    let der = certificate_der(&leaf.certificate)?;
    let certificate = parsed_certificate(&der)?;
    let key = private_key(&leaf.private_key)?;
    if certificate.is_ca()
        || certificate.issuer() != ca.subject()
        || certificate.public_key().subject_public_key.data.as_ref() != key.public_key_raw()
    {
        bail!("leaf issuer or private key does not match");
    }
    certificate
        .verify_signature(Some(ca.public_key()))
        .context("invalid leaf signature")?;
    let names = certificate
        .subject_alternative_name()?
        .context("leaf has no SAN")?;
    if names.value.general_names.as_slice() != [GeneralName::DNSName(name)] {
        bail!("leaf must have exactly the full endpoint DNS SAN");
    }
    let usage = certificate.key_usage()?.context("leaf has no key usage")?;
    let extended = certificate
        .extended_key_usage()?
        .context("leaf has no extended key usage")?;
    if !usage.value.digital_signature()
        || usage.value.key_cert_sign()
        || !extended.value.server_auth
        || extended.value.any
        || extended.value.client_auth
        || certificate.validity().not_after.timestamp() > ca.validity().not_after.timestamp()
    {
        bail!("invalid leaf purposes or issuer validity");
    }
    // An expired, otherwise intact leaf may be renewed under the same live CA.
    validity(&certificate, now, true)
}

fn validate(state: &State, endpoint_id: &str, now: OffsetDateTime) -> Result<(i64, i64)> {
    if state.endpoint_id != endpoint_id {
        bail!("TLS state belongs to a different endpoint identity");
    }
    let ca_der = certificate_der(&state.ca_certificate)?;
    let ca = parsed_certificate(&ca_der)?;
    let key = private_key(&state.ca_private_key)?;
    if !ca.is_ca()
        || ca.subject() != ca.issuer()
        || ca.public_key().subject_public_key.data.as_ref() != key.public_key_raw()
    {
        bail!("CA certificate or private key does not match");
    }
    ca.verify_signature(None)
        .context("invalid CA self-signature")?;
    let usage = ca.key_usage()?.context("CA has no key usage")?;
    let constraints = ca
        .basic_constraints()?
        .context("CA has no basic constraints")?;
    if !usage.value.key_cert_sign() || constraints.value.path_len_constraint != Some(0) {
        bail!("CA lacks its restricted signing purpose");
    }
    let ca_to = validity(&ca, now, false)?;
    let leaf_to = validate_leaf(&state.leaf, &ca, &hostname(endpoint_id), now)?;
    if let Some(previous) = &state.previous_leaf {
        validate_leaf(previous, &ca, &hostname(endpoint_id), now)?;
    }
    Ok((ca_to, leaf_to))
}

fn make_leaf(state: &State, policy: Policy, now: OffsetDateTime, ca_to: i64) -> Result<Leaf> {
    let key = KeyPair::generate()?;
    let mut params = CertificateParams::new(vec![hostname(&state.endpoint_id)])?;
    params.distinguished_name = rcgen::DistinguishedName::new();
    params.not_before = now - Duration::seconds(CLOCK_ALLOWANCE_SECONDS);
    params.not_after = std::cmp::min(
        now + Duration::days(i64::from(policy.leaf_validity_days)),
        OffsetDateTime::from_unix_timestamp(ca_to)?,
    );
    if params.not_after <= now + Duration::days(i64::from(policy.renew_before_days)) {
        bail!("CA expires inside the leaf renewal window; operator CA replacement required");
    }
    params.is_ca = IsCa::ExplicitNoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let issuer =
        Issuer::from_ca_cert_pem(&state.ca_certificate, private_key(&state.ca_private_key)?)?;
    let certificate = params.signed_by(&key, &issuer)?;
    Ok(Leaf {
        certificate: certificate.pem(),
        private_key: key.serialize_pem(),
    })
}

fn new_state(endpoint_id: String, policy: Policy, now: OffsetDateTime) -> Result<State> {
    let key = KeyPair::generate()?;
    let mut params = CertificateParams::new(Vec::<String>::new())?;
    params.distinguished_name = rcgen::DistinguishedName::new();
    params
        .distinguished_name
        .push(DnType::CommonName, "DSH Mobile iroh private CA");
    params.not_before = now - Duration::seconds(CLOCK_ALLOWANCE_SECONDS);
    params.not_after = now + Duration::days(CA_VALIDITY_DAYS);
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let ca = params.self_signed(&key)?;
    let mut state = State {
        version: 1,
        endpoint_id,
        ca_certificate: ca.pem(),
        ca_private_key: key.serialize_pem(),
        leaf: Leaf {
            certificate: String::new(),
            private_key: String::new(),
        },
        phase: Phase::Initial,
        previous_leaf: None,
    };
    state.leaf = make_leaf(&state, policy, now, params.not_after.unix_timestamp())?;
    Ok(state)
}

fn material_paths(dir: &Path) -> MaterialPaths {
    let material = dir.join(MATERIAL_DIRECTORY);
    MaterialPaths {
        ca_file: material.join(CA),
        cert_file: material.join(CERT),
        key_file: material.join(KEY),
    }
}

fn verify_material(
    path: &Path,
    current: &str,
    previous: Option<&str>,
    allow_absent: bool,
) -> Result<()> {
    match read_optional(path, MAX_PEM_BYTES)? {
        Some(bytes)
            if bytes == current.as_bytes()
                || previous.is_some_and(|old| bytes == old.as_bytes()) =>
        {
            Ok(())
        }
        None if allow_absent => Ok(()),
        _ => bail!("TLS material is missing or differs from its recorded transaction"),
    }
}

fn verify_materials(dir: &Path, state: &State) -> Result<()> {
    create_private_directory(&dir.join(MATERIAL_DIRECTORY))?;
    let paths = material_paths(dir);
    let initial = state.phase == Phase::Initial;
    verify_material(&paths.ca_file, &state.ca_certificate, None, initial)?;
    verify_material(
        &paths.cert_file,
        &state.leaf.certificate,
        state
            .previous_leaf
            .as_ref()
            .map(|leaf| leaf.certificate.as_str()),
        initial,
    )?;
    verify_material(
        &paths.key_file,
        &state.leaf.private_key,
        state
            .previous_leaf
            .as_ref()
            .map(|leaf| leaf.private_key.as_str()),
        initial,
    )
}

fn finish_transaction(dir: &Path, state: &mut State) -> Result<()> {
    verify_materials(dir, state)?;
    if state.phase == Phase::Stable {
        return Ok(());
    }
    let paths = material_paths(dir);
    write_private(&paths.ca_file, state.ca_certificate.as_bytes())?;
    write_private(&paths.cert_file, state.leaf.certificate.as_bytes())?;
    write_private(&paths.key_file, state.leaf.private_key.as_bytes())?;
    state.phase = Phase::Stable;
    state.previous_leaf = None;
    save_state(dir, state)?;
    verify_materials(dir, state)
}

fn metadata(dir: &Path, state: &State, ca_to: i64, leaf_to: i64) -> Result<Metadata> {
    let fingerprint = |pem: &str| -> Result<String> {
        Ok(Sha256::digest(certificate_der(pem)?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    };
    let ca_fingerprint = fingerprint(&state.ca_certificate)?;
    Ok(Metadata {
        version: 1,
        endpoint_id: state.endpoint_id.clone(),
        hostname: hostname(&state.endpoint_id),
        instance_id: ca_fingerprint.clone(),
        ca_fingerprint256: ca_fingerprint,
        leaf_fingerprint256: fingerprint(&state.leaf.certificate)?,
        ca_valid_to: ca_to * 1000,
        leaf_valid_to: leaf_to * 1000,
        tls: material_paths(dir),
    })
}

/// Prepare or explicitly renew fixed material without taking the running host's lease.
pub(crate) fn prepare(dir: &Path, policy: Policy, force: bool) -> Result<Metadata> {
    prepare_at(dir, policy, force, OffsetDateTime::now_utc())
}

/// Keep the independent lease until the trusted Gateway owner releases it after
/// installing the prepared material. Dropping the handle releases ownership.
pub(crate) fn prepare_held(
    dir: &Path,
    policy: Policy,
    force: bool,
) -> Result<(Metadata, std::fs::File)> {
    policy.validate()?;
    let lease = lock(dir)?;
    let metadata = prepare_locked(dir, policy, force, OffsetDateTime::now_utc())?;
    Ok((metadata, lease))
}

fn prepare_at(dir: &Path, policy: Policy, force: bool, now: OffsetDateTime) -> Result<Metadata> {
    policy.validate()?;
    let _lease = lock(dir)?;
    prepare_locked(dir, policy, force, now)
}

fn prepare_locked(
    dir: &Path,
    policy: Policy,
    force: bool,
    now: OffsetDateTime,
) -> Result<Metadata> {
    let existing = read_state(dir)?;
    if existing.is_none() {
        // No durable CA may be inferred from orphaned/legacy material.
        create_private_directory(&dir.join(MATERIAL_DIRECTORY))?;
        if std::fs::read_dir(dir.join(MATERIAL_DIRECTORY))?
            .next()
            .is_some()
        {
            bail!("orphaned TLS material requires operator action");
        }
    } else if read_optional(&dir.join("identity.key"), 32)?.is_none() {
        bail!("existing TLS identity is missing; refusing to generate a replacement");
    }
    let endpoint_id = load_or_create_secret(&dir.join("identity.key"))?
        .public()
        .to_string();
    let mut state = match existing {
        Some(state) => state,
        None => {
            let state = new_state(endpoint_id.clone(), policy, now)?;
            save_state(dir, &state)?;
            state
        }
    };
    let (ca_to, mut leaf_to) = validate(&state, &endpoint_id, now)?;
    finish_transaction(dir, &mut state)?;
    if force
        || leaf_to <= (now + Duration::days(i64::from(policy.renew_before_days))).unix_timestamp()
    {
        let leaf = make_leaf(&state, policy, now, ca_to)?;
        state.previous_leaf = Some(std::mem::replace(&mut state.leaf, leaf));
        state.phase = Phase::Renewing;
        save_state(dir, &state)?;
        (_, leaf_to) = validate(&state, &endpoint_id, now)?;
        finish_transaction(dir, &mut state)?;
    }
    metadata(dir, &state, ca_to, leaf_to)
}

/// Read only a complete live state; pending writes require explicit prepare/retry.
pub(crate) fn status(dir: &Path) -> Result<Metadata> {
    let _lease = lock(dir)?;
    let state = read_state(dir)?.context("TLS is not prepared")?;
    if state.phase != Phase::Stable {
        bail!("TLS transaction needs prepare recovery");
    }
    let bytes = read_private_file(&dir.join("identity.key"), 32)?;
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid identity"))?;
    let endpoint_id = iroh::SecretKey::from_bytes(&key).public().to_string();
    let (ca_to, leaf_to) = validate(&state, &endpoint_id, OffsetDateTime::now_utc())?;
    verify_materials(dir, &state)?;
    metadata(dir, &state, ca_to, leaf_to)
}

#[cfg(test)]
mod tests {
    use super::*;

    const POLICY: Policy = Policy {
        leaf_validity_days: 90,
        renew_before_days: 30,
    };

    struct OwnedDirectory(PathBuf);
    impl OwnedDirectory {
        fn new() -> Self {
            #[cfg(windows)]
            let parent = PathBuf::from(std::env::var_os("USERPROFILE").unwrap());
            #[cfg(not(windows))]
            let parent = std::env::temp_dir();
            let dir = parent.join(format!(
                ".iroh-tls-{}-{}",
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
    fn persistent_ca_endpoint_and_instance_survive_restarts_and_leaf_renewal() {
        let owned = OwnedDirectory::new();
        let first = prepare(&owned.0, POLICY, false).unwrap();
        let again = prepare(&owned.0, POLICY, false).unwrap();
        assert_eq!(first.leaf_fingerprint256, again.leaf_fingerprint256);
        let renewed = prepare(&owned.0, POLICY, true).unwrap();
        assert_ne!(first.leaf_fingerprint256, renewed.leaf_fingerprint256);
        assert_eq!(first.ca_fingerprint256, renewed.ca_fingerprint256);
        assert_eq!(first.instance_id, renewed.instance_id);
        assert_eq!(first.endpoint_id, renewed.endpoint_id);
        assert_eq!(first.hostname, hostname(&first.endpoint_id));
        let state = read_state(&owned.0).unwrap().unwrap();
        assert!(state.phase == Phase::Stable && state.previous_leaf.is_none());
        let leaf_der = certificate_der(&state.leaf.certificate).unwrap();
        let leaf = parsed_certificate(&leaf_der).unwrap();
        assert_eq!(
            leaf.subject_alternative_name()
                .unwrap()
                .unwrap()
                .value
                .general_names,
            [GeneralName::DNSName(first.hostname.as_str())]
        );
        let public = serde_json::to_string(&renewed).unwrap();
        assert!(!public.contains("PRIVATE KEY"));
        assert!(!public.contains(&state.ca_private_key));
        assert_eq!(
            status(&owned.0).unwrap().leaf_fingerprint256,
            renewed.leaf_fingerprint256
        );
    }

    #[test]
    fn intact_leaf_is_renewed_before_expiry_and_after_offline_expiry_without_rotating_ca() {
        let owned = OwnedDirectory::new();
        let now = OffsetDateTime::now_utc();
        let first = prepare_at(&owned.0, POLICY, false, now).unwrap();
        let early = prepare_at(&owned.0, POLICY, false, now + Duration::days(59)).unwrap();
        assert_eq!(first.leaf_fingerprint256, early.leaf_fingerprint256);
        let due = prepare_at(&owned.0, POLICY, false, now + Duration::days(61)).unwrap();
        assert_ne!(first.leaf_fingerprint256, due.leaf_fingerprint256);
        let offline = prepare_at(&owned.0, POLICY, false, now + Duration::days(300)).unwrap();
        assert_ne!(due.leaf_fingerprint256, offline.leaf_fingerprint256);
        assert_eq!(first.ca_fingerprint256, offline.ca_fingerprint256);
        let before = std::fs::read(owned.0.join(STATE)).unwrap();
        assert!(prepare_at(
            &owned.0,
            POLICY,
            false,
            now + Duration::days(CA_VALIDITY_DAYS + 1)
        )
        .is_err());
        assert_eq!(std::fs::read(owned.0.join(STATE)).unwrap(), before);
    }

    #[test]
    fn malformed_unknown_oversized_and_noncanonical_state_are_never_replaced() {
        let owned = OwnedDirectory::new();
        prepare(&owned.0, POLICY, false).unwrap();
        let path = owned.0.join(STATE);
        let original = std::fs::read(&path).unwrap();
        let mut unknown: serde_json::Value = serde_json::from_slice(&original).unwrap();
        unknown["unknown"] = true.into();
        let mut next_version: serde_json::Value = serde_json::from_slice(&original).unwrap();
        next_version["version"] = 2.into();
        for bytes in [
            b"broken".to_vec(),
            serde_json::to_vec(&unknown).unwrap(),
            serde_json::to_vec(&next_version).unwrap(),
            [original.clone(), vec![b'\n']].concat(),
            vec![b' '; MAX_STATE_BYTES + 1],
        ] {
            write_private(&path, &bytes).unwrap();
            assert!(prepare(&owned.0, POLICY, false).is_err());
            assert!(prepare(&owned.0, POLICY, true).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn missing_identity_and_mismatched_ca_key_fail_without_reset() {
        let owned = OwnedDirectory::new();
        prepare(&owned.0, POLICY, false).unwrap();
        let mut state = read_state(&owned.0).unwrap().unwrap();
        state.ca_private_key = KeyPair::generate().unwrap().serialize_pem();
        save_state(&owned.0, &state).unwrap();
        let before = std::fs::read(owned.0.join(STATE)).unwrap();
        assert!(prepare(&owned.0, POLICY, true).is_err());
        assert_eq!(std::fs::read(owned.0.join(STATE)).unwrap(), before);
        std::fs::remove_file(owned.0.join("identity.key")).unwrap();
        assert!(prepare(&owned.0, POLICY, false).is_err());
        assert!(!owned.0.join("identity.key").exists());
    }

    #[test]
    fn valid_but_wrong_leaf_key_identity_and_san_fail_closed() {
        let owned = OwnedDirectory::new();
        prepare(&owned.0, POLICY, false).unwrap();
        let original = std::fs::read(owned.0.join(STATE)).unwrap();
        let mut state = read_state(&owned.0).unwrap().unwrap();
        state.leaf.private_key = KeyPair::generate().unwrap().serialize_pem();
        save_state(&owned.0, &state).unwrap();
        assert!(prepare(&owned.0, POLICY, true).is_err());
        write_private(&owned.0.join(STATE), &original).unwrap();
        let mut state = read_state(&owned.0).unwrap().unwrap();
        let real_id = state.endpoint_id.clone();
        state.endpoint_id = iroh::SecretKey::generate().public().to_string();
        let (ca_to, _) = validate(
            &read_state(&owned.0).unwrap().unwrap(),
            &real_id,
            OffsetDateTime::now_utc(),
        )
        .unwrap();
        state.leaf = make_leaf(&state, POLICY, OffsetDateTime::now_utc(), ca_to).unwrap();
        state.endpoint_id = real_id;
        save_state(&owned.0, &state).unwrap();
        assert!(prepare(&owned.0, POLICY, false).is_err());
    }

    #[test]
    fn half_written_initial_and_renewal_transactions_recover_only_recorded_bytes() {
        let owned = OwnedDirectory::new();
        let now = OffsetDateTime::now_utc();
        let id = load_or_create_secret(&owned.0.join("identity.key"))
            .unwrap()
            .public()
            .to_string();
        let initial = new_state(id, POLICY, now).unwrap();
        save_state(&owned.0, &initial).unwrap();
        create_private_directory(&owned.0.join(MATERIAL_DIRECTORY)).unwrap();
        write_private(
            &material_paths(&owned.0).ca_file,
            initial.ca_certificate.as_bytes(),
        )
        .unwrap();
        let first = prepare(&owned.0, POLICY, false).unwrap();
        let mut state = read_state(&owned.0).unwrap().unwrap();
        let leaf = make_leaf(&state, POLICY, now, first.ca_valid_to / 1000).unwrap();
        state.previous_leaf = Some(std::mem::replace(&mut state.leaf, leaf));
        state.phase = Phase::Renewing;
        save_state(&owned.0, &state).unwrap();
        // Simulate a crash after cert replacement but before key replacement.
        write_private(
            &material_paths(&owned.0).cert_file,
            state.leaf.certificate.as_bytes(),
        )
        .unwrap();
        assert!(status(&owned.0).is_err());
        let recovered = prepare(&owned.0, POLICY, false).unwrap();
        assert_ne!(first.leaf_fingerprint256, recovered.leaf_fingerprint256);
        assert_eq!(first.instance_id, recovered.instance_id);
        assert_eq!(
            std::fs::read(material_paths(&owned.0).key_file).unwrap(),
            state.leaf.private_key.as_bytes()
        );
        let mut pending = read_state(&owned.0).unwrap().unwrap();
        let next = make_leaf(&pending, POLICY, now, first.ca_valid_to / 1000).unwrap();
        pending.previous_leaf = Some(std::mem::replace(&mut pending.leaf, next));
        pending.phase = Phase::Renewing;
        save_state(&owned.0, &pending).unwrap();
        let recorded = std::fs::read(owned.0.join(STATE)).unwrap();
        write_private(
            &material_paths(&owned.0).key_file,
            b"not-recorded-by-transaction",
        )
        .unwrap();
        assert!(prepare(&owned.0, POLICY, false).is_err());
        assert_eq!(std::fs::read(owned.0.join(STATE)).unwrap(), recorded);
    }

    #[test]
    fn orphaned_or_tampered_material_is_not_repaired_or_reinterpreted_as_first_install() {
        let owned = OwnedDirectory::new();
        create_private_directory(&owned.0.join(MATERIAL_DIRECTORY)).unwrap();
        write_private(&material_paths(&owned.0).ca_file, b"unknown CA").unwrap();
        assert!(prepare(&owned.0, POLICY, false).is_err());
        assert!(!owned.0.join(STATE).exists());
        assert!(!owned.0.join("identity.key").exists());
        let stable = OwnedDirectory::new();
        prepare(&stable.0, POLICY, false).unwrap();
        let before = std::fs::read(stable.0.join(STATE)).unwrap();
        write_private(&material_paths(&stable.0).key_file, b"unknown key").unwrap();
        assert!(prepare(&stable.0, POLICY, true).is_err());
        assert_eq!(std::fs::read(stable.0.join(STATE)).unwrap(), before);
        assert_eq!(
            std::fs::read(material_paths(&stable.0).key_file).unwrap(),
            b"unknown key"
        );
    }

    #[test]
    fn separate_tls_lease_rejects_concurrency_without_blocking_running_host() {
        let owned = OwnedDirectory::new();
        let host = open_private_lock_file(&owned.0.join("host.lock")).unwrap();
        host.try_lock().unwrap();
        let first = prepare(&owned.0, POLICY, false).unwrap();
        let lease = lock(&owned.0).unwrap();
        assert!(prepare(&owned.0, POLICY, true).is_err());
        assert!(status(&owned.0).is_err());
        drop(lease);
        assert_eq!(
            first.ca_fingerprint256,
            prepare(&owned.0, POLICY, false).unwrap().ca_fingerprint256
        );
        drop(host);
    }

    #[test]
    fn invalid_policy_and_relative_paths_do_not_create_tls_state() {
        let owned = OwnedDirectory::new();
        for policy in [
            Policy {
                leaf_validity_days: 0,
                renew_before_days: 0,
            },
            Policy {
                leaf_validity_days: 90,
                renew_before_days: 90,
            },
            Policy {
                leaf_validity_days: 366,
                renew_before_days: 30,
            },
        ] {
            assert!(prepare(&owned.0, policy, false).is_err());
        }
        assert!(!owned.0.join(STATE).exists());
        assert!(prepare(Path::new("relative-tls"), POLICY, false).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn unsafe_windows_acl_is_rejected_without_modification() {
        use std::process::Command;
        let owned = OwnedDirectory::new();
        prepare(&owned.0, POLICY, false).unwrap();
        let path = material_paths(&owned.0).key_file;
        let original = std::fs::read(&path).unwrap();
        let icacls =
            PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/icacls.exe");
        assert!(Command::new(&icacls)
            .arg(&path)
            .args(["/grant", "*S-1-1-0:(R)"])
            .output()
            .unwrap()
            .status
            .success());
        let before = Command::new(&icacls).arg(&path).output().unwrap();
        assert!(prepare(&owned.0, POLICY, true).is_err());
        assert!(status(&owned.0).is_err());
        let after = Command::new(&icacls).arg(&path).output().unwrap();
        assert_eq!(before.stdout, after.stdout);
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_and_broad_modes_are_rejected_without_repair() {
        use std::os::unix::fs::{symlink, PermissionsExt as _};
        let owned = OwnedDirectory::new();
        prepare(&owned.0, POLICY, false).unwrap();
        let path = material_paths(&owned.0).key_file;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(prepare(&owned.0, POLICY, true).is_err());
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644
        );
        std::fs::remove_file(&path).unwrap();
        symlink(&material_paths(&owned.0).cert_file, &path).unwrap();
        assert!(prepare(&owned.0, POLICY, true).is_err());
    }
}
