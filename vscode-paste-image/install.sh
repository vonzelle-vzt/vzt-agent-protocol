#!/usr/bin/env bash
# Rebuild + reinstall the VZT paste-image extension.
#
# READ THIS FIRST: VS Code installs a COPY into ~/.vscode/extensions. Editing
# extension.js in this directory does NOTHING until you re-run this script. A plain
# symlink into ~/.vscode/extensions does not work reliably — VS Code 1.131 records a
# cache entry with no metadata and then refuses to reinstall over it ("Please restart
# VS Code before reinstalling"), so we package a real .vsix like every other extension.
#
# After running: reload the VS Code window (Cmd+Shift+P -> Developer: Reload Window).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd -P)"
NAME="vzt-paste-image"
VERSION="$(python3 -c "import json;print(json.load(open('$SRC/package.json'))['version'])")"
BUILD="$(mktemp -d)"
VSIX="$SRC/$NAME-$VERSION.vsix"
trap 'rm -rf "$BUILD"' EXIT

mkdir -p "$BUILD/extension"
# Every .js the extension requires must be listed here. `require('./classify')` resolves
# against the INSTALLED copy, so a file missing from this line does not fail the build —
# it throws on activate, in a window you then have to reload again to fix.
cp "$SRC/package.json" "$SRC/extension.js" "$SRC/classify.js" "$BUILD/extension/"

cat > "$BUILD/[Content_Types].xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="json" ContentType="application/json"/>
<Default Extension="js" ContentType="application/javascript"/>
<Default Extension="vsixmanifest" ContentType="text/xml"/>
</Types>
EOF

cat > "$BUILD/extension.vsixmanifest" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="$NAME" Version="$VERSION" Publisher="vzt"/>
    <DisplayName>VZT: Paste &amp; Drop Files into Terminal</DisplayName>
    <Description xml:space="preserve">Drop or Cmd+V a file, zip or screenshot into a Claude Code session in the VS Code integrated terminal.</Description>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.85.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
EOF

( cd "$BUILD" && zip -q -r "$VSIX" "[Content_Types].xml" extension.vsixmanifest extension )
code --install-extension "$VSIX" --force
echo
echo "Installed $NAME $VERSION. Now reload VS Code: Cmd+Shift+P -> Developer: Reload Window"
