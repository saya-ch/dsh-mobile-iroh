param(
    [ValidateSet('Initialize', 'Inspect', 'UploadGitHub', 'Build')]
    [string]$Action = 'Inspect',
    [string]$Keytool = 'keytool',
    [string]$StateDirectory = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh-mobile-iroh-signing'),
    [ValidateSet('assembleRelease', 'assembleDebug')]
    [string]$BuildTask = 'assembleRelease',
    [string]$InitScript
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This local signer helper requires Windows current-user DPAPI.' }
$signingRoot = [IO.Path]::GetFullPath($StateDirectory)
$signingParent = [IO.Path]::GetDirectoryName($signingRoot)
$profileRoot = [IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile'))
if ($signingParent -ne $profileRoot -or [IO.Path]::GetFileName($signingRoot) -ne '.dsh-mobile-iroh-signing') {
    throw 'Signer state must use its dedicated directory directly under the current user profile.'
}
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if ((Get-Item -LiteralPath $profileRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Refusing a linked signing parent.'
}
if (-not (Test-Path -LiteralPath $signingRoot)) {
    if ($Action -ne 'Initialize') { throw 'Independent signing state is not initialized.' }
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetOwner($currentSid)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($currentSid, $systemSid)) {
        $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    [IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($signingRoot), $security)
}
$directoryInfo = Get-Item -LiteralPath $signingRoot
if (-not $directoryInfo.PSIsContainer -or $directoryInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Refusing linked or non-directory signing state.'
}
$directoryAcl = Get-Acl -LiteralPath $signingRoot
if (-not $directoryAcl.AreAccessRulesProtected -or $directoryAcl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $currentSid) {
    throw 'Existing signing ownership or ACL is not private; no permissions were changed.'
}
foreach ($rule in $directoryAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($currentSid.Value, $systemSid.Value)) {
        throw 'Existing signing ACL grants another principal access; refusing to repair it.'
    }
}
$keyPath = Join-Path $signingRoot 'iroh-release.p12'
$sealedPath = Join-Path $signingRoot 'credentials.dpapi.json'
$certificatePath = Join-Path $signingRoot 'signer.der'
foreach ($path in @($keyPath, $sealedPath, $certificatePath)) {
    if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Refusing linked signing material.'
    }
}

function Write-NewGeneratedFile([string]$Path, [string]$Text) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
}

function Invoke-Keytool([string[]]$Arguments, [string]$Password) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Keytool
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $start.Environment['IROH_LOCAL_SIGNING_PASSWORD'] = $Password
    $child = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $child.StandardOutput.ReadToEndAsync()
        $stderr = $child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit(60000)) {
            $child.Kill($true)
            $child.WaitForExit()
            throw 'Independent signer command timed out; any partial files were retained.'
        }
        [void]$stdout.GetAwaiter().GetResult()
        [void]$stderr.GetAwaiter().GetResult()
        if ($child.ExitCode -ne 0) { throw "Independent signer command failed with exit code $($child.ExitCode); material was retained." }
    } finally { $child.Dispose() }
}

if ($Action -eq 'Initialize') {
    if (@(Get-ChildItem -LiteralPath $signingRoot -Force).Count -ne 0) {
        throw 'Signer directory is not empty. Existing keys are never replaced or regenerated.'
    }
    $password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36))
    $alias = 'dsh-mobile-iroh-release'
    $sealed = ConvertFrom-SecureString (ConvertTo-SecureString $password -AsPlainText -Force)
    Write-NewGeneratedFile $sealedPath ((@{ version = 1; alias = $alias; passwordDpapi = $sealed } | ConvertTo-Json) + "`n")
    Invoke-Keytool @('-genkeypair', '-keystore', $keyPath, '-storetype', 'PKCS12', '-alias', $alias,
        '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
        '-dname', 'CN=DSH Mobile iroh, OU=Android Release, O=saya-ch',
        '-storepass:env', 'IROH_LOCAL_SIGNING_PASSWORD', '-keypass:env', 'IROH_LOCAL_SIGNING_PASSWORD') $password
    Invoke-Keytool @('-exportcert', '-keystore', $keyPath, '-alias', $alias, '-file', $certificatePath,
        '-storepass:env', 'IROH_LOCAL_SIGNING_PASSWORD') $password
    $password = $null
}

if (-not (Test-Path -LiteralPath $keyPath) -or -not (Test-Path -LiteralPath $sealedPath) -or -not (Test-Path -LiteralPath $certificatePath)) {
    throw 'Signer state is incomplete. Retain it for explicit recovery; do not generate another key.'
}
$signerFingerprint = (Get-FileHash -LiteralPath $certificatePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Action -in @('UploadGitHub', 'Build')) {
    $state = Get-Content -LiteralPath $sealedPath -Raw | ConvertFrom-Json
    if ($state.version -ne 1 -or $state.alias -ne 'dsh-mobile-iroh-release') { throw 'Unexpected signer metadata.' }
    $credential = [Management.Automation.PSCredential]::new('signer', (ConvertTo-SecureString $state.passwordDpapi))
    $password = $credential.GetNetworkCredential().Password
    if ($Action -eq 'UploadGitHub') {
        $login = & gh api user --jq .login
        if ($LASTEXITCODE -ne 0 -or $login.Trim() -ne 'saya-ch') { throw 'GitHub account must be saya-ch.' }
        $secrets = @{
            DSH_IROH_ANDROID_KEYSTORE_BASE64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($keyPath))
            DSH_IROH_ANDROID_KEYSTORE_PASSWORD = $password
            DSH_IROH_ANDROID_KEY_PASSWORD = $password
            DSH_IROH_ANDROID_KEY_ALIAS = $state.alias
        }
        foreach ($entry in $secrets.GetEnumerator()) {
            $start = [Diagnostics.ProcessStartInfo]::new((Get-Command gh).Source)
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $start.RedirectStandardInput = $true
            $start.RedirectStandardOutput = $true
            $start.RedirectStandardError = $true
            foreach ($argument in @('secret', 'set', $entry.Key, '--repo', 'saya-ch/dsh-mobile-iroh')) { $start.ArgumentList.Add($argument) }
            $child = [Diagnostics.Process]::Start($start)
            try {
                $stdout = $child.StandardOutput.ReadToEndAsync()
                $stderr = $child.StandardError.ReadToEndAsync()
                $child.StandardInput.Write($entry.Value)
                $child.StandardInput.Close()
                if (-not $child.WaitForExit(60000)) {
                    $child.Kill($true)
                    $child.WaitForExit()
                    throw "Upload of $($entry.Key) timed out; its remote outcome is unknown."
                }
                [void]$stdout.GetAwaiter().GetResult()
                [void]$stderr.GetAwaiter().GetResult()
                if ($child.ExitCode -ne 0) { throw "Failed to set $($entry.Key). No local key was replaced." }
            } finally { $child.Dispose() }
        }
        $secrets = $null
    } else {
        $values = @{
            DSH_IROH_ANDROID_KEYSTORE_FILE = $keyPath
            DSH_IROH_ANDROID_KEYSTORE_PASSWORD = $password
            DSH_IROH_ANDROID_KEY_PASSWORD = $password
            DSH_IROH_ANDROID_KEY_ALIAS = $state.alias
        }
        $previous = @{}
        foreach ($entry in $values.GetEnumerator()) {
            $previous[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
        }
        Push-Location (Join-Path $PSScriptRoot '../apps/mobile/android')
        try {
            $gradleArguments = @('--no-daemon', '-PirohNative=true', $BuildTask)
            if ($InitScript) { $gradleArguments += @('--init-script', [IO.Path]::GetFullPath($InitScript)) }
            & ./gradlew.bat @gradleArguments
            if ($LASTEXITCODE -ne 0) { throw 'Signed Android build failed.' }
        } finally {
            Pop-Location
            foreach ($entry in $previous.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }
            $values = $null
        }
    }
    $password = $null
    $credential = $null
}
[pscustomobject]@{ action = $Action; certificateSha256 = $signerFingerprint; privateState = $signingRoot; productionMobileSignerUsed = $false } | ConvertTo-Json -Compress
