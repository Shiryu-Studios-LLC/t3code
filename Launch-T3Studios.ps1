[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$ForceBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$stateDirectory = Join-Path $root ".t3-launcher"
$fingerprintPath = Join-Path $stateDirectory "desktop-build.fingerprint"
$logPath = Join-Path $stateDirectory "build.log"
$electronPath = Join-Path $root "apps\desktop\node_modules\electron\dist\electron.exe"
$desktopDirectory = Join-Path $root "apps\desktop"
$desktopLauncherPath = Join-Path $desktopDirectory "scripts\start-electron.mjs"
$desktopEntryPath = Join-Path $root "apps\desktop\dist-electron\main.cjs"
$desktopSourcePath = Join-Path $root "apps\desktop\src\main.ts"
$serverSourcePath = Join-Path $root "apps\server\src\bin.ts"
$lockfilePath = Join-Path $root "pnpm-lock.yaml"
$modulesManifestPath = Join-Path $root "node_modules\.modules.yaml"

function Show-LauncherError([string]$Message) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        $Message,
        "T3 Studio Launcher",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
}

function Get-PnpmPath {
    foreach ($name in @("pnpm.cmd", "pnpm.exe", "pnpm")) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($null -ne $command) { return $command.Source }
    }
    throw "pnpm is not installed or is not available on PATH."
}

function Get-NodePath {
    foreach ($name in @("node.exe", "node")) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($null -ne $command) { return $command.Source }
    }
    throw "Node.js is not installed or is not available on PATH."
}

function Get-DesktopInputFiles {
    $rootFiles = @(
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "tsconfig.base.json",
        "vite.config.ts"
    )
    foreach ($relativePath in $rootFiles) {
        $candidate = Join-Path $root $relativePath
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { Get-Item -LiteralPath $candidate }
    }

    foreach ($relativeRoot in @("apps\desktop", "apps\server", "apps\web", "packages", "patches")) {
        $directory = Join-Path $root $relativeRoot
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) { continue }
        Get-ChildItem -LiteralPath $directory -Recurse -File | Where-Object {
            $_.FullName -notmatch "[\\/](node_modules|dist|dist-electron|\.git|\.vite-plus|coverage)[\\/]" -and
            $_.Extension -in @(".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".jsonc", ".yaml", ".yml", ".css", ".html", ".rs", ".toml")
        }
    }
}

function Get-DesktopFingerprint {
    $lines = Get-DesktopInputFiles | ForEach-Object {
        $relativePath = $_.FullName.Substring($root.Length).TrimStart("\", "/").ToLowerInvariant()
        "$relativePath|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)"
    } | Sort-Object
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
}

function Get-RootPackageScripts {
    $manifest = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json
    return $manifest.scripts
}

try {
    if (-not (Test-Path -LiteralPath $desktopSourcePath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $serverSourcePath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $desktopLauncherPath -PathType Leaf)) {
        throw "The T3 Studio desktop/server source tree is incomplete. Restore apps\desktop and apps\server before building."
    }

    $pnpm = Get-PnpmPath
    $node = Get-NodePath
    $fingerprint = Get-DesktopFingerprint
    $hasElectron = Test-Path -LiteralPath $electronPath -PathType Leaf
    $hasDesktopBuild = Test-Path -LiteralPath $desktopEntryPath -PathType Leaf
    $savedFingerprint = if (Test-Path -LiteralPath $fingerprintPath -PathType Leaf) {
        (Get-Content -LiteralPath $fingerprintPath -Raw).Trim()
    } else {
        ""
    }

    $needsDependencies = -not $hasElectron -or -not (Test-Path -LiteralPath $modulesManifestPath)
    if (-not $needsDependencies -and (Test-Path -LiteralPath $lockfilePath)) {
        $needsDependencies = (Get-Item -LiteralPath $lockfilePath).LastWriteTimeUtc -gt
            (Get-Item -LiteralPath $modulesManifestPath).LastWriteTimeUtc
    }
    $needsBuild = $ForceBuild -or -not $hasDesktopBuild -or $savedFingerprint -ne $fingerprint

    # Adopt a pre-existing build on the first smart-launch if it is newer than
    # every build input. This avoids rebuilding a valid desktop installation
    # merely because the launcher has not written its fingerprint yet.
    if (-not $ForceBuild -and $hasDesktopBuild -and $savedFingerprint.Length -eq 0) {
        $newestInput = Get-DesktopInputFiles | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
        $desktopBuild = Get-Item -LiteralPath $desktopEntryPath
        if ($null -ne $newestInput -and $desktopBuild.LastWriteTimeUtc -ge $newestInput.LastWriteTimeUtc) {
            $needsBuild = $false
        }
    }

    if ($Check) {
        [pscustomobject]@{
            SourceComplete = $true
            ElectronPresent = $hasElectron
            DesktopBuildPresent = $hasDesktopBuild
            DependenciesNeeded = $needsDependencies
            BuildNeeded = $needsBuild
            Fingerprint = $fingerprint
        } | Format-List
        exit 0
    }

    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    if ($needsDependencies) {
        "[$(Get-Date -Format o)] Installing missing dependencies..." | Set-Content -LiteralPath $logPath
        & $pnpm install --frozen-lockfile *>> $logPath
        if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed. See $logPath" }
    }

    if ($needsBuild) {
        $scripts = Get-RootPackageScripts
        if ($null -eq $scripts -or -not ($scripts.PSObject.Properties.Name -contains "build:desktop")) {
            throw "package.json does not define the required build:desktop script. Restore the complete T3 Studio workspace before building."
        }
        "[$(Get-Date -Format o)] Building changed T3 Studio sources..." | Set-Content -LiteralPath $logPath
        & $pnpm run build:desktop *>> $logPath
        if ($LASTEXITCODE -ne 0) { throw "The desktop build failed. See $logPath" }
        if (-not (Test-Path -LiteralPath $desktopEntryPath -PathType Leaf)) {
            throw "The build completed without producing $desktopEntryPath"
        }
        Set-Content -LiteralPath $fingerprintPath -Value $fingerprint -NoNewline
    } elseif ($savedFingerprint -ne $fingerprint) {
        Set-Content -LiteralPath $fingerprintPath -Value $fingerprint -NoNewline
    }

    if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) {
        throw "Electron is missing after dependency installation: $electronPath"
    }

    # The custom Studio branch performs runtime repair and desktop setup in this
    # wrapper. Launching electron.exe directly can exit before a window appears.
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Start-Process -FilePath $node -ArgumentList $desktopLauncherPath -WorkingDirectory $desktopDirectory -WindowStyle Hidden
} catch {
    Show-LauncherError $_.Exception.Message
    exit 1
}
