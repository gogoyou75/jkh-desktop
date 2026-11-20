$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot '.local-lab/runtime.env'
$composeFile = Join-Path $repoRoot 'docker-compose.local.yml'
$compose = @('compose', '--env-file', $envFile, '-f', $composeFile, '-p', 'jkh_local_lab')
$runId = [guid]::NewGuid().ToString('N')
$created = $false
$createAttempted = $false
$testPassed = $false
$cleanupPassed = $false

Write-Output "FIXTURE_RUN_ID=$runId"
try {
    if (-not (Test-Path -LiteralPath $envFile)) { throw 'LOCAL_LAB runtime configuration is missing' }
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -TimeoutSec 10
    if ($health.status -ne 'ok' -or $health.env_type -ne 'LOCAL_LAB') {
        throw 'LOCAL_LAB health guard failed'
    }

    $createAttempted = $true
    $createdOutput = & docker @compose exec -T api python -B local_lab_fixture.py create --run-id $runId
    if ($LASTEXITCODE -ne 0) { throw 'Fixture creation was blocked' }
    $marker = @($createdOutput | Where-Object { $_ -like 'FIXTURE_JSON=*' })
    if ($marker.Count -ne 1) { throw 'Fixture creation returned no unique result' }
    $fixtureJson = $marker[0].Substring('FIXTURE_JSON='.Length)
    $fixture = $fixtureJson | ConvertFrom-Json
    if ($fixture.run_id -ne $runId) { throw 'Fixture run ID mismatch' }
    $created = $true
    Write-Output 'FIXTURE_CREATE=PASS'

    $fixtureJson | & docker @compose run --rm -T --no-deps playwright `
        node ./node_modules/@playwright/test/cli.js test --config ./tests/auth.config.js
    if ($LASTEXITCODE -ne 0) { throw 'Playwright authentication test failed' }
    $testPassed = $true
    Write-Output 'PLAYWRIGHT_AUTH=PASS'
} catch {
    # Exception text may include captured process output; do not risk printing credentials.
    Write-Output 'LOCAL_AUTH_TEST_ERROR=see non-secret status markers and run ID'
} finally {
    # Run even if creation succeeded but the browser test failed.
    if ($createAttempted) {
        try {
            $cleanupOutput = & docker @compose exec -T api python -B local_lab_fixture.py cleanup --run-id $runId
            if ($LASTEXITCODE -eq 0) {
                $marker = @($cleanupOutput | Where-Object { $_ -like 'FIXTURE_JSON=*' })
                if ($marker.Count -eq 1) {
                    $result = $marker[0].Substring('FIXTURE_JSON='.Length) | ConvertFrom-Json
                    if ($result.status -eq 'deleted' -or ($result.status -eq 'absent' -and -not $created)) {
                        $statusOutput = & docker @compose exec -T api python -B local_lab_fixture.py status --run-id $runId
                        if ($LASTEXITCODE -eq 0 -and @($statusOutput | Where-Object { $_ -match '"status":"absent"' }).Count -eq 1) {
                            $cleanupPassed = $true
                        }
                    }
                }
            }
        } catch {
            $cleanupPassed = $false
        }
    }
    $cleanupState = if (-not $createAttempted) { 'NOT_RUN' } elseif ($cleanupPassed) { 'PASS' } else { 'BLOCKED' }
    Write-Output "CLEANUP=$cleanupState"
}

if ($testPassed -and $cleanupPassed) {
    Write-Output 'LOCAL_AUTH_TEST_RESULT=PASS'
    exit 0
}
Write-Output 'LOCAL_AUTH_TEST_RESULT=FAIL'
exit 1
