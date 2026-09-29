#!/bin/sh
# Build the downloadable extension: docs/ubook-extension.zip
#
# The site offers the extension as a zip because there is no store listing,
# and a zip is the only thing a browser can be pointed at. It is committed
# rather than built by CI, so the download always matches the source in this
# repository at the same commit.
#
# The timestamps are fixed deliberately: zip records mtimes, so without this a
# rebuild of unchanged files produces a different archive every time and the
# repository churns a 60KB binary for nothing.
set -e
cd "$(dirname "$0")/.."

VER=$(node -p "require('./manifest.json').version")
TMP=$(mktemp -d)
D="$TMP/ubook-extension"
mkdir -p "$D"
cp manifest.json parse.js analyse.js content.js "$D/"

cat > "$D/INSTALL.txt" <<TXT
Ubook $VER — room search inside Ulster's Resource Booker

Chrome or Edge (111 or newer)
  1. Unzip this folder somewhere you will not delete by accident.
  2. Go to  chrome://extensions
  3. Turn on Developer mode, top right.
  4. Click "Load unpacked" and pick this folder — the one holding manifest.json.

Firefox (128 or newer)
  1. Go to  about:debugging#/runtime/this-firefox
  2. Click "Load Temporary Add-on" and pick manifest.json in this folder.
  Firefox clears temporary add-ons when it closes, so this needs redoing each session.

Using it
  Open Resource Booker and sign in as you normally do. Click something in the
  app — the room search box, or a calendar arrow — so it makes its first
  request. Then click "Find rooms", bottom right, and ask in plain words:

      rooms seating 45+ in BC or BD free 12:15-13:15 every Monday from 28 Sep to 7 Dec

It never submits a booking. It reads which rooms exist and when they are busy,
using the session you signed in with — no password, MFA code or token is read,
stored or sent anywhere, and it asks for no browser permissions at all.

Source: https://github.com/jjgerard/timetables
TXT

find "$D" -exec touch -t 202001010000 {} +
# named in a fixed order, because readdir order is not one
(cd "$TMP" && zip -q -X out.zip \
   ubook-extension/INSTALL.txt ubook-extension/analyse.js \
   ubook-extension/content.js ubook-extension/manifest.json \
   ubook-extension/parse.js)
mv "$TMP/out.zip" docs/ubook-extension.zip
rm -rf "$TMP"
ls -l docs/ubook-extension.zip | awk '{print "docs/ubook-extension.zip  " $5 " bytes  (extension " v ")"}' v="$VER"
