$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne $package.version) {
    throw 'manifest.json and package.json versions must match.'
}
if ($manifest.version -notmatch '^\d+\.\d+\.\d+$') {
    throw 'The release version must use the format X.Y.Z.'
}
if ($env:GITHUB_REF_TYPE -eq 'tag' -and $env:GITHUB_REF_NAME -ne "v$($manifest.version)") {
    throw 'The Git tag must match the manifest version.'
}
$pluginDir = Join-Path $root 'plugin/obsidian-html'
foreach ($file in @('main.js', 'manifest.json', 'templates/style.css', 'templates/hljs-dark.css', 'templates/hljs-light.css')) {
    if (-not (Test-Path -LiteralPath (Join-Path $pluginDir $file) -PathType Leaf)) {
        throw "Missing build output: $file. Run npm run build first."
    }
}
$releaseDir = Join-Path $root 'release'
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
$archive = Join-Path $releaseDir "obsidian-html-$($manifest.version).zip"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [System.IO.File]::Open($archive, [System.IO.FileMode]::Create)
$zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in Get-ChildItem -LiteralPath $pluginDir -Recurse -File) {
        $relative = $file.FullName.Substring($pluginDir.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, "obsidian-html/$relative") | Out-Null
    }
} finally {
    $zip.Dispose()
    $stream.Dispose()
}
Write-Output "Plugin package: $archive"
