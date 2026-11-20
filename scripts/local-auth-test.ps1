$ErrorActionPreference = 'Stop'

function New-LabProcess { return [System.Diagnostics.Process]::new() }

function Write-LabError($Record, [string]$Stage, [string]$Category) {
    # Never interpolate exception messages, command output or arbitrary error IDs.
    $allowed = @('ConvertFromJsonInvalidJson', 'CommandNotFoundException', 'NativeCommandFailed')
    $id = if ($Record.FullyQualifiedErrorId -in $allowed) { $Record.FullyQualifiedErrorId } else { 'Other' }
    $line = [int]$Record.InvocationInfo.ScriptLineNumber
    [Console]::Out.WriteLine("${Stage}_ERROR_CATEGORY=$Category")
    [Console]::Out.WriteLine("${Stage}_ERROR_ID=$id")
    [Console]::Out.WriteLine("${Stage}_ERROR_LINE=$line")
}

function Invoke-LabNative([string[]]$Arguments, [string]$Stage, [string]$InputText = '') {
    $process = New-LabProcess
    $category = 'process_start'
    try {
        $info = [System.Diagnostics.ProcessStartInfo]::new()
        $info.FileName = $composeCommand
        $info.WorkingDirectory = $repoRoot
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.RedirectStandardInput = $true
        foreach ($argument in ($compose + $Arguments)) { $info.ArgumentList.Add($argument) }
        $process.StartInfo = $info
        if (-not $process.Start()) { throw 'Native process did not start' }
        $category = 'process_io'
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if ($InputText) { $process.StandardInput.WriteLine($InputText) }
        $process.StandardInput.Close()
        $process.WaitForExit()
        $exitCode = [int]$process.ExitCode
        [Console]::Out.WriteLine("${Stage}_EXIT_CODE=$exitCode")
        $category = 'process_output'
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $null = $stderrTask.GetAwaiter().GetResult()
        if ($exitCode -ne 0) {
            $category = 'native_exit'
            throw 'Native process returned failure'
        }
        return $stdout
    } catch {
        Write-LabError $_ $Stage $category
        throw
    } finally {
        $process.Dispose()
    }
}

function Convert-LabFixture([string]$OutputText, [string]$Stage) {
    try {
        $markers = @($OutputText -split '\r?\n' | Where-Object { $_ -like 'FIXTURE_JSON=*' })
        if ($markers.Count -ne 1) { throw 'Fixture response marker invalid' }
        $json = $markers[0].Substring('FIXTURE_JSON='.Length)
        $value = $json | ConvertFrom-Json -ErrorAction Stop
        if ($value.run_id -ne $runId) { throw 'Fixture run ID mismatch' }
        return @{ Json = $json; Value = $value }
    } catch {
        Write-LabError $_ $Stage 'response_invalid'
        throw
    }
}

$repoRoot = if ($env:JKH_RUNNER_COMPOSE_SNAPSHOT) { (Get-Location).Path } else { Split-Path -Parent $PSScriptRoot }
$envFile = Join-Path $repoRoot '.local-lab/runtime.env'
$composeFile = Join-Path $repoRoot 'docker-compose.local.yml'
if ($env:JKH_RUNNER_COMPOSE_SNAPSHOT) {
    $composeFile = $env:JKH_RUNNER_COMPOSE_SNAPSHOT
    $composeCommand = 'C:\Program Files\Docker\Docker\resources\cli-plugins\docker-compose.exe'
    $compose = @('--project-directory', $repoRoot, '-f', $composeFile, '-p', 'jkh_local_lab')
} else {
    $composeCommand = 'docker'
    $compose = @('compose', '--env-file', $envFile, '-f', $composeFile, '-p', 'jkh_local_lab')
}
$runId = if ($env:JKH_FIXTURE_RUN_ID) { $env:JKH_FIXTURE_RUN_ID.ToLowerInvariant() } else { [guid]::NewGuid().ToString('N') }
if ($runId -notmatch '^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$') {
    throw 'Invalid LOCAL LAB fixture run ID'
}
$created = $false
$createAttempted = $false
$testPassed = $false
$cleanupPassed = $false
$stage = 'FIXTURE_CREATE'
$stages = @{ FIXTURE_CREATE = 'NOT_RUN'; PLAYWRIGHT_AUTH = 'NOT_RUN'; PLAYWRIGHT_LOGOUT = 'NOT_RUN'; FIXTURE_CLEANUP = 'NOT_RUN'; RUN_REGISTRY_CLEANUP = 'NOT_RUN' }

Write-Output "FIXTURE_RUN_ID=$runId"
try {
    if (-not $env:JKH_RUNNER_COMPOSE_SNAPSHOT -and -not (Test-Path -LiteralPath $envFile)) { throw 'LOCAL_LAB runtime configuration is missing' }
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -TimeoutSec 10
    if ($health.status -ne 'ok' -or $health.env_type -ne 'LOCAL_LAB') {
        throw 'LOCAL_LAB health guard failed'
    }

    $createAttempted = $true
    $stages.FIXTURE_CREATE = 'BLOCKED'
    $createdOutput = Invoke-LabNative -Arguments @('exec', '-T', 'api', 'python', '-B', 'local_lab_fixture.py', 'create', '--run-id', $runId) -Stage 'FIXTURE_CREATE'
    $response = Convert-LabFixture $createdOutput 'FIXTURE_CREATE'
    $fixtureJson = $response.Json
    $created = $true
    $stages.FIXTURE_CREATE = 'PASS'
    Write-Output 'FIXTURE_CREATE=PASS'

    $stage = 'PLAYWRIGHT_AUTH'
    $stages.PLAYWRIGHT_AUTH = 'BLOCKED'
    $stages.PLAYWRIGHT_LOGOUT = 'BLOCKED'
    $null = Invoke-LabNative -Arguments @('run', '--rm', '-T', '--no-deps', 'playwright', 'node', './node_modules/@playwright/test/cli.js', 'test', '--config', './tests/auth.config.js') -Stage 'PLAYWRIGHT_AUTH' -InputText $fixtureJson
    $testPassed = $true
    $stages.PLAYWRIGHT_AUTH = 'PASS'
    $stages.PLAYWRIGHT_LOGOUT = 'PASS'
    Write-Output 'PLAYWRIGHT_AUTH=PASS'
} catch {
    Write-Output "FAILED_STAGE=$stage"
    # Exception text may include captured process output; do not risk printing credentials.
    Write-Output 'LOCAL_AUTH_TEST_ERROR=see non-secret status markers and run ID'
} finally {
    # Run even if creation succeeded but the browser test failed.
    if ($createAttempted) {
        $stages.FIXTURE_CLEANUP = 'BLOCKED'
        $stages.RUN_REGISTRY_CLEANUP = 'BLOCKED'
        try {
            $cleanupOutput = Invoke-LabNative -Arguments @('exec', '-T', 'api', 'python', '-B', 'local_lab_fixture.py', 'cleanup', '--run-id', $runId) -Stage 'FIXTURE_CLEANUP'
            $result = (Convert-LabFixture $cleanupOutput 'FIXTURE_CLEANUP').Value
                    if ($result.status -eq 'deleted' -or ($result.status -eq 'absent' -and -not $created)) {
                        if ($result.status -eq 'deleted') { $stages.FIXTURE_CLEANUP = 'PASS' }
                        $statusOutput = Invoke-LabNative -Arguments @('exec', '-T', 'api', 'python', '-B', 'local_lab_fixture.py', 'status', '--run-id', $runId) -Stage 'RUN_REGISTRY_CLEANUP'
                        if ((Convert-LabFixture $statusOutput 'RUN_REGISTRY_CLEANUP').Value.status -eq 'absent') {
                            $cleanupPassed = $true
                            $stages.RUN_REGISTRY_CLEANUP = 'PASS'
                        }
                    }
        } catch {
            $cleanupPassed = $false
        }
    }
    $cleanupState = if (-not $createAttempted) { 'NOT_RUN' } elseif ($cleanupPassed) { 'PASS' } else { 'BLOCKED' }
    Write-Output "CLEANUP=$cleanupState"
    foreach ($name in @('FIXTURE_CREATE', 'PLAYWRIGHT_AUTH', 'PLAYWRIGHT_LOGOUT', 'FIXTURE_CLEANUP', 'RUN_REGISTRY_CLEANUP')) {
        Write-Output "$name=$($stages[$name])"
    }
}

if ($testPassed -and $cleanupPassed) {
    Write-Output 'LOCAL_AUTH_TEST_RESULT=PASS'
    exit 0
}
Write-Output 'LOCAL_AUTH_TEST_RESULT=FAIL'
exit 1
