# DSH Mobile iroh Android App

[Back to the project README](../../README.md)

This Android app starts from the DSH Mobile WebView experience: paired-device
management, LAN and remote pairing screens, cancellation, system Back behavior,
page scaling, file selection, camera capture, notifications, localization, and
accessibility remain the baseline for the iroh transport.

The package name is `io.github.sayach.dshmobileiroh`. It is intentionally
separate from the production DSH Mobile app and does not replace or migrate
that app's data.

## Current status

The WebView shell and its existing HTTPS transport baseline are imported and
build as a separate debug app. The native iroh transport is not wired into the
WebView yet. Do not treat this build as a usable iroh client or as an official
DSH Mobile release.

## Build the baseline app

Android SDK 36 and JDK 17 are required. The repository does not commit
`local.properties`; create it locally with your Android SDK path.

```powershell
Set-Location apps/mobile/android
./gradlew.bat :app:testDebugUnitTest :app:assembleDebug
```

The debug APK is `app/build/outputs/apk/debug/app-debug.apk`. It uses a
different application ID from DSH Mobile and must not be used as official
signer or production-device evidence.

## Planned transport integration

The iroh client will be added behind a transport abstraction. The WebView will
continue to see a restricted local origin, while the native layer owns endpoint
identity, pairing, QUIC streams, revocation, and cleanup. The page will not
receive private keys or unrestricted native commands.
