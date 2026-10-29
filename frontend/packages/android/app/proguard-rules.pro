# R8 rules for the release build. Keep them narrow; every line is here for a reason.

# --- Diagnostics: crash stack traces stay readable.
-keepattributes SourceFile,LineNumberTable,*Annotation*,InnerClasses,EnclosingMethod,Signature,AnnotationDefault
-renamesourcefileattribute SourceFile

# --- kotlinx.serialization. The plugin generates `$$serializer` classes and `Companion.serializer()`; the JSON codec finds
# them through the companion, so they must survive with their members. Contract types are wire types and are kept whole
# (Contracts.generated.kt is generated, and a renamed field would break the JSON).
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep class io.github.nigelleong0703.juno.contract.** { *; }
-keep @kotlinx.serialization.Serializable class * { *; }
-keep,includedescriptorclasses class **$$serializer { *; }
-keepclassmembers @kotlinx.serialization.Serializable class * { static **$Companion Companion; *** Companion; }
-keepclasseswithmembers class * { kotlinx.serialization.KSerializer serializer(...); }

# --- OkHttp / Okio: the libraries ship consumer rules; these only silence optional platform references.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-dontwarn javax.annotation.**
-dontwarn org.codehaus.mojo.animal_sniffer.**

# --- Coil 3 (OkHttp network fetcher): keep what Coil instantiates by class name.
-keep class coil3.network.okhttp.** { *; }
-dontwarn coil3.**

# --- noVNC WebView bridge: the page calls these methods by name through addJavascriptInterface.
-keepclassmembers class io.github.nigelleong0703.juno.** {
    @android.webkit.JavascriptInterface <methods>;
}

# --- Enums are serialized by name and looked up with values()/valueOf().
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}
