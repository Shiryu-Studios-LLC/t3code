[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$ForceBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$stateDirectory = Join-Path $root ".t3-launcher"
$fingerprintPath = Join-Path $stateDirectory "desktop-build.fingerprint"
$logPath = Join-Path $stateDirectory "build.log"
$launchOutputPath = Join-Path $stateDirectory "desktop-launch.out.log"
$launchErrorPath = Join-Path $stateDirectory "desktop-launch.err.log"
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

function Get-LaunchFailureDetails {
    $details = @()
    foreach ($path in @($launchErrorPath, $launchOutputPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $tail = Get-Content -LiteralPath $path -Tail 30 -ErrorAction SilentlyContinue
        if ($null -ne $tail -and $tail.Count -gt 0) {
            $details += "`n$path`n$($tail -join "`n")"
        }
    }
    return ($details -join "`n")
}

function Test-T3StudioWindow {
    $hasProcess = $null -ne (Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -like "$root*"
    } | Select-Object -First 1)
    if (-not $hasProcess) { return $false }

    if (Test-Path -LiteralPath $launchOutputPath -PathType Leaf) {
        $content = Get-Content -LiteralPath $launchOutputPath -Raw -ErrorAction SilentlyContinue
        if ($null -ne $content -and $content -match "main window created") {
            return $true
        }
    }

    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:3773/.well-known/t3/environment" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
        if ($response.StatusCode -eq 200) { return $true }
    } catch {}

    return $null -ne (Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object {
        $_.MainWindowHandle -ne 0 -and
        $_.Path -like "$root*"
    } | Select-Object -First 1)
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

function Import-ProviderEnvironmentVariables {
    foreach ($name in @(
        "GEMINI_API_KEY", "GOOGLE_API_KEY",
        "NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY", "NVAPI_KEY"
    )) {
        $current = [Environment]::GetEnvironmentVariable($name, "Process")
        if (-not [string]::IsNullOrWhiteSpace($current)) { continue }
        $userValue = [Environment]::GetEnvironmentVariable($name, "User")
        $machineValue = [Environment]::GetEnvironmentVariable($name, "Machine")
        $resolved = if (-not [string]::IsNullOrWhiteSpace($userValue)) { $userValue } else { $machineValue }
        if (-not [string]::IsNullOrWhiteSpace($resolved)) {
            [Environment]::SetEnvironmentVariable($name, $resolved, "Process")
        }
    }
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
    $git = Get-Command git.exe, git -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $git) { throw "Git is not installed or is not available on PATH." }

    $buildPaths = @(
        "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json",
        "vite.config.ts", "apps/desktop", "apps/server", "apps/web", "packages", "patches"
    )
    Push-Location $root
    try {
        $head = (& $git.Source rev-parse HEAD 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Could not read the T3 Studio Git revision." }
        $trackedChanges = (& $git.Source diff --no-ext-diff --binary HEAD -- @buildPaths | Out-String)
        $untrackedPaths = @(& $git.Source ls-files --others --exclude-standard -- @buildPaths)
    } finally {
        Pop-Location
    }

    $lines = @("git-v1", $head, $trackedChanges)
    foreach ($relativePath in ($untrackedPaths | Sort-Object)) {
        $candidate = Join-Path $root $relativePath
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $contentHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
            $lines += "untracked|$($relativePath.ToLowerInvariant())|$contentHash"
        }
    }

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
    Import-ProviderEnvironmentVariables
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
        $dependencyErrorPath = Join-Path $stateDirectory "dependencies.err.log"
        $dependencyProcess = Start-Process -FilePath $pnpm -ArgumentList @("install", "--frozen-lockfile") `
            -WorkingDirectory $root -WindowStyle Hidden -Wait -PassThru `
            -RedirectStandardOutput $logPath -RedirectStandardError $dependencyErrorPath
        if ($dependencyProcess.ExitCode -ne 0) {
            throw "Dependency installation failed. See $logPath and $dependencyErrorPath"
        }
    }

    if ($needsBuild) {
        $scripts = Get-RootPackageScripts
        if ($null -eq $scripts -or -not ($scripts.PSObject.Properties.Name -contains "build:desktop")) {
            throw "package.json does not define the required build:desktop script. Restore the complete T3 Studio workspace before building."
        }
        "[$(Get-Date -Format o)] Building changed T3 Studio sources..." | Set-Content -LiteralPath $logPath
        $buildErrorPath = Join-Path $stateDirectory "build.err.log"
        $buildProcess = Start-Process -FilePath $pnpm -ArgumentList @("run", "build:desktop") `
            -WorkingDirectory $root -WindowStyle Hidden -Wait -PassThru `
            -RedirectStandardOutput $logPath -RedirectStandardError $buildErrorPath
        if ($buildProcess.ExitCode -ne 0) {
            throw "The desktop build failed. See $logPath and $buildErrorPath"
        }
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

    # Clean up any stale electron processes from this workspace before launching
    Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -like "$root*"
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500

    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $launchOutputPath, $launchErrorPath -Force -ErrorAction SilentlyContinue

    $launchProcess = Start-Process -FilePath $node -ArgumentList $desktopLauncherPath `
        -WorkingDirectory $desktopDirectory -PassThru

    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if (Test-T3StudioWindow) { exit 0 }
        if ($launchProcess.HasExited) {
            throw "T3 Studio stopped before its window opened.$(Get-LaunchFailureDetails)"
        }
        Start-Sleep -Milliseconds 500
    }

    throw "T3 Studio is still running but did not create a visible window within 30 seconds.$(Get-LaunchFailureDetails)"
} catch {
    Show-LauncherError $_.Exception.Message
    exit 1
}
