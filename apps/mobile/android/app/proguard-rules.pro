# NativeBridge is reached through androidx.webkit's typed WebMessageListener;
# it exposes no reflection-addressed Java methods to page JavaScript.

# ZXing readers are selected dynamically through decode hints.
-keep class com.google.zxing.** { *; }

# Rust JNI exports bind this class and its native method names by symbol.
-keep class io.github.sayach.dshmobileiroh.IrohNative { *; }
-keep,includedescriptorclasses class org.rustls.platformverifier.** { *; }
