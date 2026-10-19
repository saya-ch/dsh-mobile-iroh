# NativeBridge is reached through androidx.webkit's typed WebMessageListener;
# it exposes no reflection-addressed Java methods to page JavaScript.

# ZXing readers are selected dynamically through decode hints.
-keep class com.google.zxing.** { *; }
