param()

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$composeFile = Join-Path $repoRoot 'docker-compose.local.yml'
$runtimeDir = Join-Path $repoRoot '.local-lab'
$envFile = Join-Path $runtimeDir 'runtime.env'

function New-TestSecret {
    $bytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToHexString($bytes).ToLowerInvariant()
}

function Invoke-DockerChecked([string[]]$Arguments) {
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Docker step failed: $($Arguments[0])" }
}

Push-Location $repoRoot
try {
    if ($env:DOCKER_HOST) { throw 'DOCKER_HOST must be unset for LOCAL_LAB' }
    if ($env:DOCKER_CONTEXT -and $env:DOCKER_CONTEXT -ne 'desktop-linux') {
        throw 'DOCKER_CONTEXT must be desktop-linux for LOCAL_LAB'
    }
    $context = (& docker context show 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $context -ne 'desktop-linux') {
        throw 'LOCAL_LAB requires the local Docker Desktop context'
    }
    $endpoint = (& docker context inspect desktop-linux --format '{{.Endpoints.docker.Host}}' 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $endpoint -ne 'npipe:////./pipe/dockerDesktopLinuxEngine') {
        throw 'LOCAL_LAB refuses a non-local Docker endpoint'
    }
    $engineType = (& docker info --format '{{.OSType}}' 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $engineType -ne 'linux') {
        throw 'Local Docker Engine is unavailable; no permission workaround is attempted'
    }

    if (-not (Test-Path -LiteralPath $envFile)) {
        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
        @(
            'JKH_LOCAL_LAB_MARKER=LOCAL_LAB_ONLY'
            "JKH_LOCAL_DB_PASSWORD=$(New-TestSecret)"
            "JKH_LOCAL_ROOT_PASSWORD=$(New-TestSecret)"
            "JKH_LOCAL_SESSION_SECRET=$(New-TestSecret)"
        ) | Set-Content -LiteralPath $envFile -Encoding utf8
    }
    $envLines = Get-Content -LiteralPath $envFile
    if ($envLines -notcontains 'JKH_LOCAL_LAB_MARKER=LOCAL_LAB_ONLY') {
        throw 'LOCAL_LAB test credential file has no isolation marker'
    }
    foreach ($name in @('JKH_LOCAL_DB_PASSWORD', 'JKH_LOCAL_ROOT_PASSWORD', 'JKH_LOCAL_SESSION_SECRET')) {
        if (-not ($envLines | Where-Object { $_ -match "^$name=[0-9a-f]{64}$" })) {
            throw "LOCAL_LAB test credential file is missing $name"
        }
    }

    $compose = @('compose', '--env-file', $envFile, '-f', $composeFile, '-p', 'jkh_local_lab')
    Invoke-DockerChecked ($compose + @('config', '--quiet'))
    Invoke-DockerChecked ($compose + @('up', '-d', '--build', 'mysql', 'api', 'nginx'))

    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -TimeoutSec 10
    if ($health.status -ne 'ok' -or $health.env_type -ne 'LOCAL_LAB') {
        throw 'LOCAL_LAB health returned an unexpected environment'
    }

    $databaseCheck = @'
from app import app, db, ENV_TYPE
from sqlalchemy import text
if ENV_TYPE != 'LOCAL_LAB':
    raise SystemExit('LOCAL_LAB environment required')
with app.app_context():
    if db.engine.url.host != 'mysql' or db.engine.url.database != 'jkh_local_lab':
        raise SystemExit('LOCAL_LAB database target mismatch')
    db.create_all()
    with db.engine.connect() as connection:
        if connection.execute(text('SELECT DATABASE()')).scalar() != 'jkh_local_lab':
            raise SystemExit('LOCAL_LAB database mismatch')
        if connection.execute(text('SELECT 1')).scalar() != 1:
            raise SystemExit('LOCAL_LAB database query failed')
print('LOCAL_LAB_DB_OK')
'@
    Invoke-DockerChecked ($compose + @('exec', '-T', 'api', 'python', '-c', $databaseCheck))
    Invoke-DockerChecked ($compose + @('exec', '-T', 'api', 'python', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'))

    $jsTests = Get-ChildItem -LiteralPath (Join-Path $repoRoot 'scripts') -Filter 'test_*.js' -File
    foreach ($testFile in $jsTests) {
        & node $testFile.FullName
        if ($LASTEXITCODE -ne 0) { throw "JavaScript test failed: $($testFile.Name)" }
    }
    Invoke-DockerChecked ($compose + @('--profile', 'test', 'run', '--rm', '--no-deps', 'playwright'))
    Write-Output 'LOCAL_TEST_RESULT=PASS'
} catch {
    [Console]::Error.WriteLine("LOCAL TEST stopped: $($_.Exception.Message)")
    Write-Output 'LOCAL_TEST_RESULT=FAIL'
    exit 1
} finally {
    Pop-Location
}
