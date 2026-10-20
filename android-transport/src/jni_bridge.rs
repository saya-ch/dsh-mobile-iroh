use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;
use tokio::runtime::{Builder, Runtime};

use super::{connect, AndroidTransportSession};
use iroh::EndpointId;

struct NativeState {
    runtime: Runtime,
    session: Option<AndroidTransportSession>,
}

static STATE: OnceLock<Mutex<NativeState>> = OnceLock::new();

fn state() -> &'static Mutex<NativeState> {
    STATE.get_or_init(|| {
        let runtime = Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("Android iroh runtime must be constructible");
        Mutex::new(NativeState {
            runtime,
            session: None,
        })
    })
}

fn text(env: &mut JNIEnv<'_>, value: JString<'_>) -> Result<String, String> {
    env.get_string(&value)
        .map(|value| value.into())
        .map_err(|error| error.to_string())
}

fn throw(env: &mut JNIEnv<'_>, message: impl AsRef<str>) -> jstring {
    let _ = env.throw_new("java/io/IOException", message.as_ref());
    std::ptr::null_mut()
}

/// Connect and return the loopback URL. The caller must run this off the UI thread.
#[no_mangle]
pub extern "system" fn Java_io_github_sayach_dshmobileiroh_IrohNative_nativeConnect(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    peer: JString<'_>,
    code: JString<'_>,
    device_name: JString<'_>,
    data_dir: JString<'_>,
) -> jstring {
    let peer = match text(&mut env, peer).and_then(|value| {
        value
            .parse::<EndpointId>()
            .map_err(|error| error.to_string())
    }) {
        Ok(peer) => peer,
        Err(error) => return throw(&mut env, format!("invalid iroh peer: {error}")),
    };
    let code = match text(&mut env, code) {
        Ok(code) if code.trim().is_empty() => None,
        Ok(code) => Some(code),
        Err(error) => return throw(&mut env, error),
    };
    let device_name = match text(&mut env, device_name) {
        Ok(value) => value,
        Err(error) => return throw(&mut env, error),
    };
    let data_dir = match text(&mut env, data_dir) {
        Ok(value) => PathBuf::from(value),
        Err(error) => return throw(&mut env, error),
    };
    let mut guard = match state().lock() {
        Ok(guard) => guard,
        Err(_) => return throw(&mut env, "Android iroh state is poisoned"),
    };
    if let Some(previous) = guard.session.take() {
        guard.runtime.block_on(previous.close());
    }
    let session =
        match guard
            .runtime
            .block_on(connect(&data_dir, peer, code.as_deref(), &device_name))
        {
            Ok(session) => session,
            Err(error) => return throw(&mut env, format!("iroh connection failed: {error:#}")),
        };
    let url = session.local_url();
    guard.session = Some(session);
    match env.new_string(url) {
        Ok(value) => value.into_raw(),
        Err(error) => throw(&mut env, error.to_string()),
    }
}

/// Close the active iroh session and its loopback proxy.
#[no_mangle]
pub extern "system" fn Java_io_github_sayach_dshmobileiroh_IrohNative_nativeClose(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
) {
    if let Ok(mut guard) = state().lock() {
        if let Some(session) = guard.session.take() {
            guard.runtime.block_on(session.close());
        }
    }
}
