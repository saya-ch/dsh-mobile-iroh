package io.github.sayach.dshmobileiroh

import android.app.Application
import android.webkit.CookieManager

/** Owns complete platform cookie batches across Activity replacement. */
internal class MobileApplication : Application() {
    val sessionCookieInstaller = NativeSessionCookieInstaller<String, NativeSessionCookieWrite>(
        write = { _, cookie, done -> CookieManager.getInstance().setCookie(cookie.origin, cookie.value) { done(it) } },
        flush = { CookieManager.getInstance().flush() },
    )
}
