//! Request-scoped JNI ownership. No native state lock spans network I/O.

use std::future::Future;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use iroh::EndpointId;
#[cfg(target_os = "android")]
use jni::objects::{GlobalRef, JObject};
use jni::objects::{JClass, JString};
use jni::sys::{jint, jlong, jstring};
use jni::JNIEnv;
use tokio::runtime::{Builder, Runtime};
use tokio::sync::{oneshot, Mutex as AsyncMutex, OwnedMutexGuard};

use super::session_owner::SessionOwner;
use super::{
    connect_with_options_tracked, AndroidTransportSession, EndpointCleanup, TransportOptions,
    TransportStatus,
};

enum Resource {
    Pending(oneshot::Sender<()>),
    Connected(AndroidTransportSession, OwnedMutexGuard<()>),
}

struct NativeState {
    runtime: Runtime,
    owner: Mutex<SessionOwner<Resource>>,
    // The asynchronous lease remains with the active session through teardown.
    // Replacements cannot bind its fixed port before the previous listener is gone.
    lifetime: Arc<AsyncMutex<()>>,
}

static STATE: OnceLock<Result<NativeState, &'static str>> = OnceLock::new();
#[cfg(target_os = "android")]
static ANDROID_CONTEXT: OnceLock<GlobalRef> = OnceLock::new();
#[cfg(target_os = "android")]
static INITIALIZING: Mutex<()> = Mutex::new(());

/// Publish a process-lifetime Application Context before iroh DNS or HTTPS is used.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_io_github_sayach_dshmobileiroh_IrohNative_nativeInitialize(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    application: JObject<'_>,
) {
    let initialized = catch_unwind(AssertUnwindSafe(|| {
        let _guard = INITIALIZING.lock().map_err(|_| "initialization_failed")?;
        if ANDROID_CONTEXT.get().is_some() {
            return Ok(());
        }
        let context = env
            .new_global_ref(application)
            .map_err(|_| "initialization_failed")?;
        let vm = env.get_java_vm().map_err(|_| "initialization_failed")?;
        // Both JNI versions wrap the same current JNI frame. The verifier copies
        // its own global reference; ANDROID_CONTEXT retains the DNS reference.
        let mut unowned = unsafe {
            jni_verifier::EnvUnowned::from_raw(
                env.get_native_interface()
                    .cast::<jni_verifier::sys::JNIEnv>(),
            )
        };
        let verified = unowned
            .with_env(|verifier_env| {
                let object = unsafe {
                    jni_verifier::objects::JObject::from_raw(
                        verifier_env,
                        context.as_obj().as_raw(),
                    )
                };
                rustls_platform_verifier::android::init_with_env(verifier_env, object)
            })
            .into_outcome();
        if !matches!(verified, jni_verifier::Outcome::Ok(())) {
            return Err("initialization_failed");
        }
        // Safety: VM and the global Application Context remain alive until process exit.
        unsafe {
            iroh::dns::install_android_jni_context(
                vm.get_java_vm_pointer().cast(),
                context.as_obj().as_raw().cast(),
            );
        }
        ANDROID_CONTEXT
            .set(context)
            .map_err(|_| "initialization_failed")?;
        Ok::<_, &'static str>(())
    }));
    if !matches!(initialized, Ok(Ok(()))) {
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        throw(&mut env, "initialization_failed");
    }
}

fn state() -> Result<&'static NativeState, &'static str> {
    STATE
        .get_or_init(|| {
            let runtime = Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .map_err(|_| "runtime_unavailable")?;
            Ok(NativeState {
                runtime,
                owner: Mutex::new(SessionOwner::default()),
                lifetime: Arc::new(AsyncMutex::new(())),
            })
        })
        .as_ref()
        .map_err(|error| *error)
}

fn dispose(state: &NativeState, resource: Resource) {
    match resource {
        Resource::Pending(cancel) => {
            let _ = cancel.send(());
        }
        Resource::Connected(session, lifetime) => {
            state.runtime.spawn(async move {
                session.close().await;
                drop(lifetime);
            });
        }
    }
}

fn text(env: &mut JNIEnv<'_>, value: JString<'_>) -> Result<String, &'static str> {
    env.get_string(&value)
        .map(|value| value.into())
        .map_err(|_| "invalid_argument")
}

fn throw(env: &mut JNIEnv<'_>, code: &'static str) -> jstring {
    // Fixed codes only: no pairing code, endpoint identity or filesystem path in errors.
    let _ = env.throw_new("java/io/IOException", format!("iroh:{code}"));
    std::ptr::null_mut()
}

fn connect_request(
    id: u64,
    peer: EndpointId,
    code: Option<String>,
    device_name: String,
    data_dir: PathBuf,
    local_port: u16,
) -> Result<String, &'static str> {
    #[cfg(target_os = "android")]
    if ANDROID_CONTEXT.get().is_none() {
        return Err("not_initialized");
    }
    let state = state()?;
    let (start, started) = oneshot::channel();
    let (cancel, cancelled) = oneshot::channel();
    let lifetime = state.lifetime.clone();
    let task = state.runtime.spawn(supervise_connection(
        lifetime,
        started,
        cancelled,
        move |connect_cleanup| async move {
            connect_with_options_tracked(
                &data_dir,
                peer,
                code.as_deref(),
                &device_name,
                TransportOptions {
                    local_port,
                    ..TransportOptions::default()
                },
                Some(connect_cleanup),
            )
            .await
        },
    ));
    let pending = Resource::Pending(cancel);
    let previous = match state
        .owner
        .lock()
        .map_err(|_| "state_unavailable")?
        .begin(id, pending)
    {
        Ok(previous) => previous,
        Err(resource) => {
            dispose(state, resource);
            return Err("cancelled");
        }
    };
    if let Some(previous) = previous {
        dispose(state, previous);
    }
    let _ = start.send(());
    // The caller is a worker thread. Close can acquire owner independently and abort this task.
    let result = state.runtime.block_on(task);
    let (session, lifetime) = match result {
        Ok(NativeResult::Connected(session, lifetime)) => (session, lifetime),
        failure => {
            if let Some(resource) = state
                .owner
                .lock()
                .map_err(|_| "state_unavailable")?
                .cancel(id)
            {
                dispose(state, resource);
            }
            return Err(if matches!(failure, Ok(NativeResult::Cancelled)) {
                "cancelled"
            } else {
                "connection_failed"
            });
        }
    };
    if session.is_closed() {
        let pending = state
            .owner
            .lock()
            .map_err(|_| "state_unavailable")?
            .cancel(id);
        if let Some(pending) = pending {
            dispose(state, pending);
        }
        dispose(state, Resource::Connected(session, lifetime));
        return Err("connection_closed");
    }
    let url = session.connection_metadata();
    let published = state
        .owner
        .lock()
        .map_err(|_| "state_unavailable")?
        .replace(id, Resource::Connected(session, lifetime));
    match published {
        Ok(_) => Ok(url),
        Err(resource) => {
            dispose(state, resource);
            Err("cancelled")
        }
    }
}

enum NativeResult {
    Connected(AndroidTransportSession, OwnedMutexGuard<()>),
    Cancelled,
    Failed,
}

async fn supervise_connection<F, Start>(
    lifetime: Arc<AsyncMutex<()>>,
    started: oneshot::Receiver<()>,
    mut cancelled: oneshot::Receiver<()>,
    start: Start,
) -> NativeResult
where
    F: Future<Output = anyhow::Result<AndroidTransportSession>> + Send + 'static,
    Start: FnOnce(EndpointCleanup) -> F + Send + 'static,
{
    if started.await.is_err() {
        return NativeResult::Cancelled;
    }
    let lifetime = tokio::select! {
        _ = &mut cancelled => return NativeResult::Cancelled,
        lifetime = lifetime.lock_owned() => lifetime,
    };
    let cleanup = EndpointCleanup::default();
    let mut connection = tokio::spawn(start(cleanup.clone()));
    let result = tokio::select! {
        _ = &mut cancelled => {
            connection.abort();
            if let Ok(Ok(session)) = connection.await { session.close().await; }
            cleanup.finish().await;
            return NativeResult::Cancelled;
        },
        connected = &mut connection => connected,
    };
    cleanup.finish().await;
    match result {
        Ok(Ok(session)) => NativeResult::Connected(session, lifetime),
        _ => NativeResult::Failed,
    }
}

/// Return peer/port metadata on a worker thread. A positive monotonic id owns cancellation.
#[no_mangle]
pub extern "system" fn Java_io_github_sayach_dshmobileiroh_IrohNative_nativeConnect(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    request_id: jlong,
    peer: JString<'_>,
    code: JString<'_>,
    device_name: JString<'_>,
    data_dir: JString<'_>,
    local_port: jint,
) -> jstring {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let id = u64::try_from(request_id)
            .ok()
            .filter(|id| *id > 0)
            .ok_or("invalid_argument")?;
        let peer = text(&mut env, peer)?
            .parse::<EndpointId>()
            .map_err(|_| "invalid_argument")?;
        let code = text(&mut env, code)?;
        let code = if code.is_empty() { None } else { Some(code) };
        let device_name = text(&mut env, device_name)?;
        let data_dir = PathBuf::from(text(&mut env, data_dir)?);
        let local_port = u16::try_from(local_port)
            .ok()
            .filter(|port| *port >= 1024)
            .ok_or("invalid_argument")?;
        connect_request(id, peer, code, device_name, data_dir, local_port)
    }));
    match result {
        Ok(Ok(url)) => match env.new_string(url) {
            Ok(value) => value.into_raw(),
            Err(_) => {
                if let Ok(state) = state() {
                    if let Ok(mut owner) = state.owner.lock() {
                        if let Some(resource) = owner.cancel(request_id as u64) {
                            dispose(state, resource);
                        }
                    }
                }
                throw(&mut env, "response_unavailable")
            }
        },
        Ok(Err(code)) => throw(&mut env, code),
        Err(_) => throw(&mut env, "internal_failure"),
    }
}

/// Cancel only this owner, including requests not yet entered by a queued worker.
#[no_mangle]
pub extern "system" fn Java_io_github_sayach_dshmobileiroh_IrohNative_nativeClose(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    request_id: jlong,
) {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let id = u64::try_from(request_id)
            .ok()
            .filter(|id| *id > 0)
            .ok_or("invalid_argument")?;
        let state = state()?;
        let resource = state
            .owner
            .lock()
            .map_err(|_| "state_unavailable")?
            .cancel(id);
        if let Some(resource) = resource {
            dispose(state, resource);
        }
        Ok::<_, &'static str>(())
    }));
    match result {
        Ok(Ok(())) => {}
        Ok(Err(code)) => {
            throw(&mut env, code);
        }
        Err(_) => {
            throw(&mut env, "internal_failure");
        }
    }
}

/// Read one exact owner's local state; only authenticated QUIC revocation returns revoked.
#[no_mangle]
pub extern "system" fn Java_io_github_sayach_dshmobileiroh_IrohNative_nativeStatus(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    request_id: jlong,
) -> jstring {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let id = u64::try_from(request_id)
            .ok()
            .filter(|id| *id > 0)
            .ok_or("invalid_argument")?;
        let state = state()?;
        let owner = state.owner.lock().map_err(|_| "state_unavailable")?;
        Ok::<_, &'static str>(match owner.get(id) {
            Some(Resource::Connected(session, _)) => match session.status() {
                TransportStatus::Ready => "ready",
                TransportStatus::Revoked => "revoked",
                TransportStatus::Disconnected => "disconnected",
            },
            _ => "inactive",
        })
    }));
    match result {
        Ok(Ok(status)) => match env.new_string(status) {
            Ok(value) => value.into_raw(),
            Err(_) => throw(&mut env, "response_unavailable"),
        },
        Ok(Err(error)) => throw(&mut env, error),
        Err(_) => throw(&mut env, "internal_failure"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn cancelled_setup_keeps_its_lease_until_drop_cleanup_has_exited() {
        struct DeferredCleanup {
            tracker: EndpointCleanup,
            release: Option<oneshot::Receiver<()>>,
            entered: Option<oneshot::Sender<()>>,
        }
        impl Drop for DeferredCleanup {
            fn drop(&mut self) {
                let release = self.release.take().unwrap();
                let entered = self.entered.take().unwrap();
                let task = tokio::spawn(async move {
                    let _ = entered.send(());
                    let _ = release.await;
                });
                self.tracker.0.lock().unwrap().push(task);
            }
        }
        Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let lifetime = Arc::new(AsyncMutex::new(()));
                let (start, started) = oneshot::channel();
                let (cancel, cancelled) = oneshot::channel();
                let (connecting, connected) = oneshot::channel();
                let (cleanup_started, cleanup_seen) = oneshot::channel();
                let (release, released) = oneshot::channel();
                let supervisor = tokio::spawn(supervise_connection(
                    lifetime.clone(),
                    started,
                    cancelled,
                    move |tracker| async move {
                        let _cleanup = DeferredCleanup {
                            tracker,
                            release: Some(released),
                            entered: Some(cleanup_started),
                        };
                        let _ = connecting.send(());
                        std::future::pending::<anyhow::Result<AndroidTransportSession>>().await
                    },
                ));
                start.send(()).unwrap();
                tokio::time::timeout(Duration::from_secs(5), connected)
                    .await
                    .unwrap()
                    .unwrap();
                cancel.send(()).unwrap();
                tokio::time::timeout(Duration::from_secs(5), cleanup_seen)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(lifetime.try_lock().is_err());
                assert!(!supervisor.is_finished());
                release.send(()).unwrap();
                assert!(matches!(
                    tokio::time::timeout(Duration::from_secs(5), supervisor)
                        .await
                        .unwrap()
                        .unwrap(),
                    NativeResult::Cancelled
                ));
                assert!(lifetime.try_lock().is_ok());
            });
    }
}
