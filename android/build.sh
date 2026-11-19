#!/usr/bin/env bash
# Builds the Android app (public/downloads/jaabm-portal.apk) without Android Studio or Gradle.
# Needs: a JDK (javac, keytool, jar) and two Android SDK packages unpacked somewhere:
#   ANDROID_BUILD_TOOLS = folder with aapt, aapt2, d8, zipalign, apksigner (build-tools 34)
#   ANDROID_JAR         = android.jar of platform 34
# Signing key: android/release.keystore + android/keystore.properties (both git-ignored; keep a safe copy:
# Android only installs an update over the app if it is signed with the same key).
set -euo pipefail
cd "$(dirname "$0")"
: "${ANDROID_BUILD_TOOLS:?set ANDROID_BUILD_TOOLS}" "${ANDROID_JAR:?set ANDROID_JAR}"
BT="$ANDROID_BUILD_TOOLS"; EXE=""; [ -f "$BT/aapt2.exe" ] && EXE=".exe"
VERSION_CODE="${VERSION_CODE:-1}"; VERSION_NAME="${VERSION_NAME:-1.0}"
OUT=../public/downloads/jaabm-portal.apk
rm -rf build && mkdir -p build/classes build/dex

# Signing key (created once)
if [ ! -f release.keystore ]; then
  PASS=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")
  keytool -genkeypair -noprompt -keystore release.keystore -alias jaabm -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$PASS" -keypass "$PASS" -dname "CN=Jamia Arabia Abdullah Bin Masood, O=JAABM, L=Naushahro Feroze, C=PK"
  printf 'storePassword=%s\nkeyAlias=jaabm\n' "$PASS" > keystore.properties
fi
PASS=$(sed -n 's/^storePassword=//p' keystore.properties)

# Resources and manifest
"$BT/aapt2$EXE" compile --dir res -o build/res.zip
"$BT/aapt2$EXE" link -o build/base.apk -I "$ANDROID_JAR" --manifest AndroidManifest.xml \
  --min-sdk-version 24 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" build/res.zip

# Code
javac -nowarn --release 11 -classpath "$ANDROID_JAR" -d build/classes $(find src -name '*.java')
D8="$BT/d8"; [ -f "$BT/d8.bat" ] && D8="$BT/d8.bat"
"$D8" --release --min-api 24 --lib "$ANDROID_JAR" --output build/dex $(find build/classes -name '*.class')
(cd build/dex && "$BT/aapt$EXE" add ../base.apk classes.dex >/dev/null)

# Align and sign
"$BT/zipalign$EXE" -p -f 4 build/base.apk build/aligned.apk
SIGNER="$BT/apksigner"; [ -f "$BT/apksigner.bat" ] && SIGNER="$BT/apksigner.bat"
mkdir -p "$(dirname "$OUT")"
"$SIGNER" sign --v4-signing-enabled false --ks release.keystore --ks-key-alias jaabm --ks-pass "pass:$PASS" --key-pass "pass:$PASS" --out "$OUT" build/aligned.apk
"$SIGNER" verify "$OUT" && echo "Built $OUT ($(stat -c %s "$OUT") bytes)"
