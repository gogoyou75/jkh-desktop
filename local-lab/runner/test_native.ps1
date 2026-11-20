$ErrorActionPreference = 'Stop'
$path = Join-Path $PSScriptRoot '../../scripts/local-auth-test.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Syntax check failed' }
# Extract only function definitions; never execute the integration script.
foreach ($function in $ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] }) {
    . ([scriptblock]::Create($function.Extent.Text))
}
function Assert-Lab($Condition) { if (-not $Condition) { throw ('Isolated assertion failed at line ' + (Get-PSCallStack)[1].ScriptLineNumber) } }
$composeCommand = 'mock-only'; $compose = @('fixed'); $repoRoot = (Get-Location).Path
$runId = '0b05fccd8a824fb2bb327060ae0640ec'
$script:mode = 'success'
function New-LabProcess {
    $object = [pscustomobject]@{ StartInfo = $null; ExitCode = 0; StandardOutput = $null; StandardError = $null; StandardInput = [IO.StringWriter]::new() }
    $object.StandardOutput = [IO.StringReader]::new('synthetic-response')
    $object.StandardError = [IO.StringReader]::new('private-password-sentinel')
    if ($script:mode -eq 'nonzero') { $object.ExitCode = 7 }
    $object | Add-Member ScriptMethod Start { if ($script:mode -eq 'launch') { throw 'private-password-sentinel' }; return $true }
    $object | Add-Member ScriptMethod WaitForExit { }
    $object | Add-Member ScriptMethod Dispose { $script:disposed = $true }
    if ($script:mode -eq 'after') {
        $badReader = [pscustomobject]@{}
        $badReader | Add-Member ScriptMethod ReadToEndAsync {
            return [System.Threading.Tasks.Task[string]]::FromException([Exception]::new('private-password-sentinel'))
        }
        $object.StandardOutput = $badReader
    }
    return $object
}
$originalOut = [Console]::Out
$diagnostics = [IO.StringWriter]::new()
[Console]::SetOut($diagnostics)
try {
    foreach ($mode in @('success', 'nonzero', 'launch', 'after')) {
        $script:mode = $mode; $script:disposed = $false; $caught = $false
        try { $result = Invoke-LabNative -Arguments @('fixed') -Stage FIXTURE_CREATE } catch { $caught = $true }
        Assert-Lab ($caught -eq ($mode -ne 'success'))
        Assert-Lab $script:disposed
        if ($mode -eq 'success') { Assert-Lab ($result -eq 'synthetic-response') }
    }
    $caught = $false
    try { Convert-LabFixture 'FIXTURE_JSON={broken-private-password-sentinel' FIXTURE_CREATE } catch { $caught = $true }
    Assert-Lab $caught
    # Exercise the actual integration try/finally with mocked health/native calls.
    function Invoke-RestMethod { return @{ status = 'ok'; env_type = 'LOCAL_LAB' } }
    function Invoke-LabNative($Arguments, $Stage, $InputText) {
        $script:calls.Add($Stage)
        if ($Stage -eq 'FIXTURE_CREATE') { return 'FIXTURE_JSON={broken' }
        if ($script:cleanupFailure) { throw 'private-password-sentinel' }
        if ($Stage -eq 'FIXTURE_CLEANUP') { return ('FIXTURE_JSON={"run_id":"' + $runId + '","status":"deleted"}') }
        return ('FIXTURE_JSON={"run_id":"' + $runId + '","status":"absent"}')
    }
    $body = $ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.TryStatementAst] } | Select-Object -First 1
    $envFile = $path
    foreach ($cleanupFailure in @($false, $true)) {
        $script:cleanupFailure = $cleanupFailure
        $script:calls = [Collections.Generic.List[string]]::new()
        $createAttempted = $false; $created = $false; $testPassed = $false; $cleanupPassed = $false
        $stage = 'FIXTURE_CREATE'; $stages = @{}
        . ([scriptblock]::Create($body.Extent.Text)) | Out-Null
        Assert-Lab ($script:calls.Contains('FIXTURE_CLEANUP'))
        Assert-Lab (-not $script:calls.Contains('PLAYWRIGHT_AUTH'))
        Assert-Lab ($cleanupPassed -eq (-not $cleanupFailure))
    }
    Assert-Lab (-not $diagnostics.ToString().Contains('private-password-sentinel'))
    Assert-Lab ($diagnostics.ToString().Contains('FIXTURE_CREATE_EXIT_CODE=7'))
    Assert-Lab ($diagnostics.ToString().Contains('ERROR_CATEGORY=process_start'))
    Assert-Lab ($diagnostics.ToString().Contains('ERROR_CATEGORY=response_invalid'))
} finally { [Console]::SetOut($originalOut) }
Write-Output 'ISOLATED_NATIVE_TESTS=PASS'
