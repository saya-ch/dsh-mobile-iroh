//! 报错与状态文案的中英两种写法。App 与 sidecar 共用。
//!
//! 语言由各自那侧报进来:App 里 Android 取系统语言要走 JNI,为几十条文案引一套 JNI 调用不划算,
//! 所以由 WebView 启动时把 `navigator.language` 报进来(在 WebView 里它就是系统语言);sidecar 侧
//! 由插件按电脑的语言传 --lang,自己手跑时看环境。设定之前默认中文,与旧版一致。
//! 不建 key 表:调用点就近写两种说法,读代码时能直接看到用户会看到什么,也不会有 key 对不上的漂移。
use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

/// 由界面在启动时报进来的语言标签,如 `zh-CN` / `en-GB`
pub fn set_from_tag(tag: &str) {
    ENGLISH.store(
        !tag.trim().to_ascii_lowercase().starts_with("zh"),
        Ordering::Relaxed,
    );
}

/// 同一句话的两种写法,按当前语言取一个
pub fn t(zh: &'static str, en: &'static str) -> &'static str {
    if ENGLISH.load(Ordering::Relaxed) {
        en
    } else {
        zh
    }
}
