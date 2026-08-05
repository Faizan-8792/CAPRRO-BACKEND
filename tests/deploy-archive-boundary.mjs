import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = process.cwd();
const builderPath = resolve("tools/make-deploy-archive.ps1");
const gatePath = resolve("tools/run-gates.ps1");
const temporaryRoot = mkdtempSync(join(tmpdir(), "capro-deploy-boundary-"));
let passed = 0;
let failed = 0;

function run(file, args, options = {}) {
  return spawnSync(file, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
  });
}

function resultDetail(result) {
  return [result.error?.stack, result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function record(name, condition, result) {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
  const detail = resultDetail(result ?? {});
  if (detail) console.error(detail);
}

function requireSuccess(result, operation) {
  if (result.error || result.status !== 0) {
    throw new Error(`${operation} failed\n${resultDetail(result)}`);
  }
}

function copy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function git(fixtureRoot, args) {
  return run("git", args, { cwd: fixtureRoot, timeout: 120_000 });
}

function commitFixture(fixtureRoot, message, paths) {
  requireSuccess(
    git(fixtureRoot, ["-c", "core.autocrlf=false", "add", "--", ...paths]),
    `git add (${message})`,
  );
  requireSuccess(
    git(fixtureRoot, [
      "-c",
      "user.name=CA PRO Security Test",
      "-c",
      "user.email=security-test@example.invalid",
      "commit",
      "-q",
      "-m",
      message,
    ]),
    `git commit (${message})`,
  );
}

function addZipDigitalSignature(zipBytes) {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = zipBytes.lastIndexOf(endSignature);
  if (endOffset < 0 || endOffset + 22 > zipBytes.length) {
    throw new Error("ZIP fixture has no complete end record");
  }
  const commentLength = zipBytes.readUInt16LE(endOffset + 20);
  const centralSize = zipBytes.readUInt32LE(endOffset + 12);
  const centralOffset = zipBytes.readUInt32LE(endOffset + 16);
  if (
    endOffset + 22 + commentLength !== zipBytes.length ||
    centralOffset + centralSize !== endOffset
  ) {
    throw new Error("ZIP fixture central directory is not contiguous");
  }

  const signatureData = Buffer.from("capro-central-signature", "utf8");
  const signatureRecord = Buffer.alloc(6 + signatureData.length);
  signatureRecord.writeUInt32LE(0x05054b50, 0);
  signatureRecord.writeUInt16LE(signatureData.length, 4);
  signatureData.copy(signatureRecord, 6);
  const updatedEnd = Buffer.from(zipBytes.subarray(endOffset));
  updatedEnd.writeUInt32LE(centralSize + signatureRecord.length, 12);
  return Buffer.concat([
    zipBytes.subarray(0, endOffset),
    signatureRecord,
    updatedEnd,
  ]);
}

function addZipArchiveExtraData(zipBytes) {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = zipBytes.lastIndexOf(endSignature);
  if (endOffset < 0 || endOffset + 22 > zipBytes.length) {
    throw new Error("ZIP fixture has no complete end record");
  }
  const centralSize = zipBytes.readUInt32LE(endOffset + 12);
  const centralOffset = zipBytes.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize !== endOffset) {
    throw new Error("ZIP fixture central directory is not contiguous");
  }

  const extraData = Buffer.from("capro-archive-extra", "utf8");
  const extraRecord = Buffer.alloc(8 + extraData.length);
  extraRecord.writeUInt32LE(0x08064b50, 0);
  extraRecord.writeUInt32LE(extraData.length, 4);
  extraData.copy(extraRecord, 8);
  const updatedEnd = Buffer.from(zipBytes.subarray(endOffset));
  updatedEnd.writeUInt32LE(centralSize + extraRecord.length, 12);
  return Buffer.concat([
    zipBytes.subarray(0, centralOffset),
    extraRecord,
    zipBytes.subarray(centralOffset, endOffset),
    updatedEnd,
  ]);
}

function useZip64CentralSentinels(zipBytes) {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = zipBytes.lastIndexOf(endSignature);
  const centralOffset =
    endOffset >= 0 ? zipBytes.readUInt32LE(endOffset + 16) : -1;
  if (
    endOffset < 0 ||
    zipBytes.readUInt16LE(endOffset + 10) < 1 ||
    centralOffset < 0 ||
    zipBytes.readUInt32LE(centralOffset) !== 0x02014b50
  ) {
    throw new Error("ZIP64 sentinel fixture requires central entries");
  }
  const centralSize = zipBytes.readUInt32LE(endOffset + 12);
  const compressedSize = zipBytes.readUInt32LE(centralOffset + 20);
  const uncompressedSize = zipBytes.readUInt32LE(centralOffset + 24);
  const nameLength = zipBytes.readUInt16LE(centralOffset + 28);
  const extraLength = zipBytes.readUInt16LE(centralOffset + 30);
  const diskStart = zipBytes.readUInt16LE(centralOffset + 34);
  const localOffset = zipBytes.readUInt32LE(centralOffset + 42);
  const extraEnd = centralOffset + 46 + nameLength + extraLength;
  if (
    extraEnd > endOffset ||
    [compressedSize, uncompressedSize, localOffset].includes(0xffffffff) ||
    diskStart === 0xffff
  ) {
    throw new Error("ZIP fixture central entry is malformed");
  }

  const zip64Extra = Buffer.alloc(32);
  zip64Extra.writeUInt16LE(0x0001, 0);
  zip64Extra.writeUInt16LE(28, 2);
  zip64Extra.writeBigUInt64LE(BigInt(uncompressedSize), 4);
  zip64Extra.writeBigUInt64LE(BigInt(compressedSize), 12);
  zip64Extra.writeBigUInt64LE(BigInt(localOffset), 20);
  zip64Extra.writeUInt32LE(diskStart, 28);
  const prefix = Buffer.from(zipBytes.subarray(0, extraEnd));
  prefix.writeUInt16LE(extraLength + zip64Extra.length, centralOffset + 30);
  prefix.writeUInt32LE(0xffffffff, centralOffset + 20);
  prefix.writeUInt32LE(0xffffffff, centralOffset + 24);
  prefix.writeUInt16LE(0xffff, centralOffset + 34);
  prefix.writeUInt32LE(0xffffffff, centralOffset + 42);
  prefix.writeUInt16LE(
    Math.max(45, prefix.readUInt16LE(centralOffset + 6)),
    centralOffset + 6,
  );
  const updatedEnd = Buffer.from(zipBytes.subarray(endOffset));
  updatedEnd.writeUInt32LE(centralSize + zip64Extra.length, 12);
  return Buffer.concat([
    prefix,
    zip64Extra,
    zipBytes.subarray(extraEnd, endOffset),
    updatedEnd,
  ]);
}

function promoteZipToZip64(zipBytes) {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = zipBytes.lastIndexOf(endSignature);
  if (endOffset < 0 || endOffset + 22 > zipBytes.length) {
    throw new Error("ZIP fixture has no classic end record");
  }
  const entries = zipBytes.readUInt16LE(endOffset + 10);
  const centralSize = zipBytes.readUInt32LE(endOffset + 12);
  const centralOffset = zipBytes.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize !== endOffset) {
    throw new Error("ZIP fixture central directory is not contiguous");
  }

  const zip64End = Buffer.alloc(56);
  zip64End.writeUInt32LE(0x06064b50, 0);
  zip64End.writeBigUInt64LE(44n, 4);
  zip64End.writeUInt16LE(45, 12);
  zip64End.writeUInt16LE(45, 14);
  zip64End.writeUInt32LE(0, 16);
  zip64End.writeUInt32LE(0, 20);
  zip64End.writeBigUInt64LE(BigInt(entries), 24);
  zip64End.writeBigUInt64LE(BigInt(entries), 32);
  zip64End.writeBigUInt64LE(BigInt(centralSize), 40);
  zip64End.writeBigUInt64LE(BigInt(centralOffset), 48);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeUInt32LE(0, 4);
  locator.writeBigUInt64LE(BigInt(endOffset), 8);
  locator.writeUInt32LE(1, 16);

  const classicEnd = Buffer.from(zipBytes.subarray(endOffset));
  classicEnd.writeUInt16LE(0xffff, 8);
  classicEnd.writeUInt16LE(0xffff, 10);
  classicEnd.writeUInt32LE(0xffffffff, 12);
  classicEnd.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([
    zipBytes.subarray(0, endOffset),
    zip64End,
    locator,
    classicEnd,
  ]);
}

function runBuilder(fixtureRoot, outputRoot) {
  return run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      builderPath,
      "-RepoRoot",
      fixtureRoot,
      "-OutputDirectory",
      outputRoot,
      "-ValidateOnly",
    ],
    { cwd: fixtureRoot, timeout: 300_000 },
  );
}

try {
  const probeRoot = join(temporaryRoot, "process-probe");
  mkdirSync(probeRoot, { recursive: true });
  const exitedChildPidPath = join(probeRoot, "exited-parent-child.pid");
  const gateExitedChildPidPath = join(
    probeRoot,
    "gate-exited-parent-child.pid",
  );
  const timedChildPidPath = join(probeRoot, "timed-parent-child.pid");
  const builderAssignmentPidPath = join(
    probeRoot,
    "builder-assignment-failure-child.pid",
  );
  const gateAssignmentPidPath = join(
    probeRoot,
    "gate-assignment-failure-child.pid",
  );
  const parentScriptPath = join(probeRoot, "parent.ps1");
  const ioProbePath = join(probeRoot, "io-probe.ps1");
  const helperProbePath = join(probeRoot, "helper-probe.ps1");
  writeFileSync(
    parentScriptPath,
    [
      "param([Parameter(Mandatory = $true)][string]$PidFile, [switch]$ExitImmediately)",
      "$child = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30; Write-Output descendant-complete') -NoNewWindow -PassThru",
      "[System.IO.File]::WriteAllText($PidFile, [string]$child.Id)",
      "if ($ExitImmediately) { exit 0 }",
      "Start-Sleep -Seconds 30",
    ].join("\r\n"),
  );
  writeFileSync(
    ioProbePath,
    [
      "param([Parameter(Mandatory = $true)][ValidateSet('Binary', 'BinaryError', 'Text')][string]$Mode)",
      "$inputMemory = [System.IO.MemoryStream]::new()",
      "try { [Console]::OpenStandardInput().CopyTo($inputMemory); [byte[]]$inputBytes = $inputMemory.ToArray() } finally { $inputMemory.Dispose() }",
      "if ($Mode -eq 'Binary') {",
      "  [byte[]]$expectedInput = @(0, 1, 128, 255)",
      "  if ($inputBytes.Length -ne $expectedInput.Length) { throw 'binary stdin length mismatch' }",
      "  for ($index = 0; $index -lt $expectedInput.Length; $index++) { if ($inputBytes[$index] -ne $expectedInput[$index]) { throw 'binary stdin content mismatch' } }",
      "  [byte[]]$outputBytes = @(0, 1, 127, 128, 255)",
      "  [byte[]]$errorBytes = @(0, 128, 255)",
      "  [Console]::OpenStandardOutput().Write($outputBytes, 0, $outputBytes.Length)",
      "  [Console]::OpenStandardError().Write($errorBytes, 0, $errorBytes.Length)",
      "  exit 0",
      "}",
      "if ($Mode -eq 'BinaryError') {",
      "  if ($inputBytes.Length -ne 0) { throw 'binary error probe expected stdin EOF' }",
      "  [byte[]]$errorBytes = @(0, 128, 255)",
      "  [Console]::OpenStandardError().Write($errorBytes, 0, $errorBytes.Length)",
      "  exit 0",
      "}",
      "if ($inputBytes.Length -ne 0) { throw 'text probe expected stdin EOF' }",
      "[Console]::Out.Write(('O' * 1048576))",
      "[Console]::Error.Write(('E' * 1048576))",
    ].join("\r\n"),
  );

  const powerShellLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
  writeFileSync(
    helperProbePath,
    [
      "$ErrorActionPreference = 'Stop'",
      `$builderPath = ${powerShellLiteral(builderPath)}`,
      `$gatePath = ${powerShellLiteral(gatePath)}`,
      `$parentScriptPath = ${powerShellLiteral(parentScriptPath)}`,
      `$ioProbePath = ${powerShellLiteral(ioProbePath)}`,
      `$exitedChildPidPath = ${powerShellLiteral(exitedChildPidPath)}`,
      `$gateExitedChildPidPath = ${powerShellLiteral(gateExitedChildPidPath)}`,
      `$timedChildPidPath = ${powerShellLiteral(timedChildPidPath)}`,
      `$builderAssignmentPidPath = ${powerShellLiteral(builderAssignmentPidPath)}`,
      `$gateAssignmentPidPath = ${powerShellLiteral(gateAssignmentPidPath)}`,
      "function Assert-RecordedChildStopped {",
      "  param([Parameter(Mandatory = $true)][string]$PidPath, [Parameter(Mandatory = $true)][string]$Description)",
      "  $recordDeadline = [DateTime]::UtcNow.AddSeconds(3)",
      "  while (-not (Test-Path -LiteralPath $PidPath) -and [DateTime]::UtcNow -lt $recordDeadline) { Start-Sleep -Milliseconds 100 }",
      '  if (-not (Test-Path -LiteralPath $PidPath)) { throw "$Description child PID was not recorded" }',
      "  $childPid = [int]([System.IO.File]::ReadAllText($PidPath))",
      "  $exitDeadline = [DateTime]::UtcNow.AddSeconds(3)",
      "  $remaining = Get-Process -Id $childPid -ErrorAction SilentlyContinue",
      "  while ($null -ne $remaining -and [DateTime]::UtcNow -lt $exitDeadline) {",
      "    Start-Sleep -Milliseconds 100",
      "    $remaining = Get-Process -Id $childPid -ErrorAction SilentlyContinue",
      "  }",
      "  if ($null -ne $remaining) {",
      "    Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue",
      '    throw "$Description descendant remained alive"',
      "  }",
      "}",
      "function Assert-TargetNeverStarted {",
      "  param([Parameter(Mandatory = $true)][string]$PidPath, [Parameter(Mandatory = $true)][string]$Description)",
      "  Start-Sleep -Milliseconds 500",
      "  if (-not (Test-Path -LiteralPath $PidPath)) { return }",
      "  $childPid = [int]([System.IO.File]::ReadAllText($PidPath))",
      "  Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue",
      '  throw "$Description target started before Job assignment succeeded"',
      "}",
      "function Install-FailingJobFactory {",
      "  function global:New-KillOnCloseProcessJob {",
      "    $job = [pscustomobject]@{}",
      "    $job | Add-Member -MemberType ScriptMethod -Name Assign -Value { param([IntPtr]$processHandle) throw 'forced job assignment failure' }",
      "    $job | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }",
      "    return $job",
      "  }",
      "}",
      "$tokens = $null; $errors = $null",
      "$builderAst = [System.Management.Automation.Language.Parser]::ParseFile($builderPath, [ref]$tokens, [ref]$errors)",
      "if ($errors.Count -gt 0) { throw 'builder parse failed' }",
      "$magicDefinitions = foreach ($name in @('Get-Zip64CentralValues', 'Test-ZipCentralDirectoryRecords', 'Test-CoherentZipArchive', 'Test-NestedArchiveMagic')) {",
      "  $definition = $builderAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)",
      '  if ($null -eq $definition) { throw "missing archive detector function: $name" }',
      "  $definition.Extent.Text",
      "}",
      "$bytePreservingDecoder = [System.Text.Encoding]::GetEncoding(28591)",
      'Invoke-Expression ($magicDefinitions -join "`r`n`r`n")',
      "[byte[]]$png = @(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4)",
      "[byte[]]$fakeZipSignature = $png + [byte[]]@(0x50, 0x4B, 0x03, 0x04, 0, 0, 0, 0)",
      "if (Test-NestedArchiveMagic -Bytes $png) { throw 'benign PNG header was rejected' }",
      "if (Test-NestedArchiveMagic -Bytes $fakeZipSignature) { throw 'isolated ZIP signature was rejected' }",
      "Write-Output 'archive detector helper probes passed'",
      "$builderDefinitions = foreach ($name in @('ConvertTo-NativeArgument', 'Get-RemainingTimeout', 'Wait-TaskWithinTimeout', 'New-KillOnCloseProcessJob', 'Get-ContainedProcessLauncherCommand', 'Invoke-BoundedProcess')) {",
      "  $definition = $builderAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)",
      '  if ($null -eq $definition) { throw "missing builder function: $name" }',
      "  $definition.Extent.Text",
      "}",
      'Invoke-Expression ($builderDefinitions -join "`r`n`r`n")',
      "$utf8Encoder = [System.Text.UTF8Encoding]::new($false)",
      "[byte[]]$binaryInput = @(0, 1, 128, 255)",
      "$binaryResult = Invoke-BoundedProcess -FilePath powershell.exe -Arguments @('-NoProfile', '-NonInteractive', '-File', $ioProbePath, '-Mode', 'Binary') -WorkingDirectory (Split-Path -Parent $ioProbePath) -TimeoutMs 5000 -StandardInput $binaryInput -CaptureBinaryOutput",
      "if ($binaryResult.ExitCode -ne 0) { throw 'builder binary probe returned nonzero' }",
      "[byte[]]$expectedBinaryOutput = @(0, 1, 127, 128, 255)",
      "if (-not ($binaryResult.StandardOutput -is [byte[]]) -or $binaryResult.StandardOutput.Length -ne $expectedBinaryOutput.Length) { $resultTypes = @($binaryResult | ForEach-Object { $_.GetType().FullName }) -join ','; $outputType = if ($null -eq $binaryResult.StandardOutput) { '<null>' } else { $binaryResult.StandardOutput.GetType().FullName }; throw \"builder binary stdout shape mismatch resultTypes=$resultTypes outputType=$outputType outputLength=$($binaryResult.StandardOutput.Length)\" }",
      "for ($index = 0; $index -lt $expectedBinaryOutput.Length; $index++) { if ($binaryResult.StandardOutput[$index] -ne $expectedBinaryOutput[$index]) { throw 'builder binary stdout content mismatch' } }",
      "[byte[]]$expectedBinaryError = @(0, 128, 255)",
      "if (-not ($binaryResult.StandardErrorBytes -is [byte[]]) -or $binaryResult.StandardErrorBytes.Length -ne $expectedBinaryError.Length) { throw 'builder binary stderr shape mismatch' }",
      "for ($index = 0; $index -lt $expectedBinaryError.Length; $index++) { if ($binaryResult.StandardErrorBytes[$index] -ne $expectedBinaryError[$index]) { throw 'builder binary stderr content mismatch' } }",
      "Write-Output 'builder binary and stdin EOF probes passed'",
      "$builderExitedResult = Invoke-BoundedProcess -FilePath powershell.exe -Arguments @('-NoProfile', '-NonInteractive', '-File', $parentScriptPath, '-PidFile', $exitedChildPidPath, '-ExitImmediately') -WorkingDirectory (Split-Path -Parent $parentScriptPath) -TimeoutMs 3000",
      "if ($builderExitedResult.ExitCode -ne 0) { throw 'exited-parent builder probe returned nonzero' }",
      "Assert-RecordedChildStopped -PidPath $exitedChildPidPath -Description 'normal-return exited-parent builder probe'",
      "Install-FailingJobFactory",
      "$builderAssignmentFailed = $false",
      "try {",
      "  [void](Invoke-BoundedProcess -FilePath powershell.exe -Arguments @('-NoProfile', '-NonInteractive', '-File', $parentScriptPath, '-PidFile', $builderAssignmentPidPath) -WorkingDirectory (Split-Path -Parent $parentScriptPath) -TimeoutMs 2500)",
      "}",
      "catch {",
      "  if ($_.Exception.Message -notmatch 'forced job assignment failure') { throw }",
      "  $builderAssignmentFailed = $true",
      "}",
      "if (-not $builderAssignmentFailed) { throw 'builder assignment-failure probe did not fail' }",
      "Assert-TargetNeverStarted -PidPath $builderAssignmentPidPath -Description 'builder assignment-failure probe'",
      "$tokens = $null; $errors = $null",
      "$gateAst = [System.Management.Automation.Language.Parser]::ParseFile($gatePath, [ref]$tokens, [ref]$errors)",
      "if ($errors.Count -gt 0) { throw 'gate parse failed' }",
      "$gateDefinitions = foreach ($name in @('ConvertTo-NativeArgument', 'New-KillOnCloseProcessJob', 'Get-ContainedProcessLauncherCommand', 'Invoke-CapturedProcess', 'Get-GateSummary')) {",
      "  $definition = $gateAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)",
      '  if ($null -eq $definition) { throw "missing gate function: $name" }',
      "  $definition.Extent.Text",
      "}",
      'Invoke-Expression ($gateDefinitions -join "`r`n`r`n")',
      "$gateIoResult = Invoke-CapturedProcess -FilePath powershell.exe -Arguments @('-NoProfile', '-NonInteractive', '-File', $ioProbePath, '-Mode', 'Text') -WorkingDirectory (Split-Path -Parent $ioProbePath) -TimeoutMs 10000",
      "if ($gateIoResult.ExitCode -ne 0) { throw 'gate IO probe returned nonzero' }",
      "if ($gateIoResult.StandardOutput.Length -ne 1048576 -or $gateIoResult.StandardOutput -notmatch '^O+$') { throw 'gate stdout drainage mismatch' }",
      "if ($gateIoResult.StandardError.Length -ne 1048576 -or $gateIoResult.StandardError -notmatch '^E+$') { throw 'gate stderr drainage mismatch' }",
      "$gateBinaryResult = Invoke-CapturedProcess -FilePath powershell.exe -Arguments @('-NoProfile', '-NonInteractive', '-File', $ioProbePath, '-Mode', 'BinaryError') -WorkingDirectory (Split-Path -Parent $ioProbePath) -TimeoutMs 5000",
      "[byte[]]$expectedBinaryError = @(0, 128, 255)",
      "if (-not ($gateBinaryResult.StandardErrorBytes -is [byte[]]) -or $gateBinaryResult.StandardErrorBytes.Length -ne $expectedBinaryError.Length) { throw 'gate binary stderr shape mismatch' }",
      "for ($index = 0; $index -lt $expectedBinaryError.Length; $index++) { if ($gateBinaryResult.StandardErrorBytes[$index] -ne $expectedBinaryError[$index]) { throw 'gate binary stderr content mismatch' } }",
      "Write-Output 'gate concurrent output, binary stderr, and stdin EOF probes passed'",
      "$gateExitedResult = Invoke-CapturedProcess -FilePath powershell.exe -Arguments @('-NoProfile', '-NonInteractive', '-File', $parentScriptPath, '-PidFile', $gateExitedChildPidPath, '-ExitImmediately') -WorkingDirectory (Split-Path -Parent $parentScriptPath) -TimeoutMs 3000",
      "if ($gateExitedResult.ExitCode -ne 0) { throw 'exited-parent gate probe returned nonzero' }",
      "Assert-RecordedChildStopped -PidPath $gateExitedChildPidPath -Description 'normal-return exited-parent gate probe'",
      "$preCommitSummary = @(Get-GateSummary -FailureCount 0 -ArchiveValidationSkipped $true)",
      'if (($preCommitSummary -join "`n") -ne "===== SUMMARY =====`nfailing gates: 0`ndeployment ready: false`nPRE-COMMIT GATES GREEN - DEPLOY ARCHIVE NOT VALIDATED") { throw \'pre-commit summary semantics regressed\' }',
      "$releaseSummary = @(Get-GateSummary -FailureCount 0 -ArchiveValidationSkipped $false)",
      'if (($releaseSummary -join "`n") -ne "===== SUMMARY =====`nfailing gates: 0`ndeployment ready: true`nALL RELEASE GATES GREEN") { throw \'release summary semantics regressed\' }',
      "$failedSummary = @(Get-GateSummary -FailureCount 2 -ArchiveValidationSkipped $false)",
      'if (($failedSummary -join "`n") -ne "===== SUMMARY =====`nfailing gates: 2`ndeployment ready: false`nGATES FAILED - DO NOT DEPLOY") { throw \'failed summary semantics regressed\' }',
      "Write-Output 'gate summary probes passed'",
      "$timedOut = $false",
      "try {",
      "  [void](Invoke-CapturedProcess -FilePath powershell.exe -Arguments @('-NoProfile', '-NonInteractive', '-File', $parentScriptPath, '-PidFile', $timedChildPidPath) -WorkingDirectory (Split-Path -Parent $parentScriptPath) -TimeoutMs 1500)",
      "}",
      "catch {",
      "  if ($_.Exception.Message -notmatch 'timed out') { throw }",
      "  $timedOut = $true",
      "}",
      "if (-not $timedOut) { throw 'process probe did not time out' }",
      "Assert-RecordedChildStopped -PidPath $timedChildPidPath -Description 'timed gate probe'",
      "Install-FailingJobFactory",
      "$gateAssignmentFailed = $false",
      "try {",
      "  [void](Invoke-CapturedProcess -FilePath powershell.exe -Arguments @('-NoProfile', '-NonInteractive', '-File', $parentScriptPath, '-PidFile', $gateAssignmentPidPath) -WorkingDirectory (Split-Path -Parent $parentScriptPath) -TimeoutMs 2500)",
      "}",
      "catch {",
      "  if ($_.Exception.Message -notmatch 'forced job assignment failure') { throw }",
      "  $gateAssignmentFailed = $true",
      "}",
      "if (-not $gateAssignmentFailed) { throw 'gate assignment-failure probe did not fail' }",
      "Assert-TargetNeverStarted -PidPath $gateAssignmentPidPath -Description 'gate assignment-failure probe'",
      "Write-Output 'job-object lifecycle probes passed'",
      "Write-Output 'PowerShell helper probes passed'",
    ].join("\r\n"),
  );

  const helperProbe = run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helperProbePath,
    ],
    { cwd: probeRoot, timeout: 30_000 },
  );
  for (const [name, marker] of [
    [
      "embedded archive helper probes pass",
      "archive detector helper probes passed",
    ],
    [
      "builder binary output and stdin EOF probes pass",
      "builder binary and stdin EOF probes passed",
    ],
    [
      "gate concurrent output, binary stderr, and stdin EOF probes pass",
      "gate concurrent output, binary stderr, and stdin EOF probes passed",
    ],
    ["gate summary semantics probes pass", "gate summary probes passed"],
    [
      "guarded job-object lifecycle helpers pass",
      "job-object lifecycle probes passed",
    ],
  ]) {
    record(
      name,
      helperProbe.status === 0 &&
        !helperProbe.error &&
        helperProbe.stdout.includes(marker),
      helperProbe,
    );
  }

  const fixtureRoot = join(temporaryRoot, "fixture");
  const outputRoot = join(temporaryRoot, "output");
  mkdirSync(outputRoot, { recursive: true });
  copy(join(repositoryRoot, "package.json"), join(fixtureRoot, "package.json"));
  copy(
    join(repositoryRoot, "package-lock.json"),
    join(fixtureRoot, "package-lock.json"),
  );
  copy(
    join(repositoryRoot, "tools", "scan-deploy-secrets.mjs"),
    join(fixtureRoot, "tools", "scan-deploy-secrets.mjs"),
  );
  copy(
    join(repositoryRoot, "node_modules", "acorn", "dist", "acorn.mjs"),
    join(fixtureRoot, "node_modules", "acorn", "dist", "acorn.mjs"),
  );
  mkdirSync(join(fixtureRoot, "src"), { recursive: true });
  mkdirSync(join(fixtureRoot, "public"), { recursive: true });
  writeFileSync(
    join(fixtureRoot, "src", "server.js"),
    'console.log("deployment boundary fixture");\n',
    { flag: "wx" },
  );
  writeFileSync(
    join(fixtureRoot, "public", "index.html"),
    "<!doctype html>\n",
    {
      flag: "wx",
    },
  );

  requireSuccess(git(fixtureRoot, ["init", "-q"]), "git init");
  commitFixture(fixtureRoot, "baseline", [
    "package.json",
    "package-lock.json",
    "src/server.js",
    "public/index.html",
    "tools/scan-deploy-secrets.mjs",
  ]);

  const staleBuildPath = join(outputRoot, `.capro-build-${"a".repeat(32)}`);
  const stalePartialPath = join(
    outputRoot,
    `.capro-backend_20000101_000000.zip.partial-${"b".repeat(32)}`,
  );
  const freshBuildPath = join(outputRoot, `.capro-build-${"c".repeat(32)}`);
  const freshPartialPath = join(
    outputRoot,
    `.capro-backend_20990101_000000.zip.partial-${"d".repeat(32)}`,
  );
  const unrelatedOldPath = join(outputRoot, ".capro-build-not-owned");
  mkdirSync(staleBuildPath);
  writeFileSync(join(staleBuildPath, "candidate.zip"), "stale");
  writeFileSync(stalePartialPath, "stale");
  mkdirSync(freshBuildPath);
  writeFileSync(freshPartialPath, "fresh");
  writeFileSync(unrelatedOldPath, "unrelated");
  const staleTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000);
  utimesSync(staleBuildPath, staleTimestamp, staleTimestamp);
  utimesSync(stalePartialPath, staleTimestamp, staleTimestamp);
  utimesSync(unrelatedOldPath, staleTimestamp, staleTimestamp);

  const baseline = runBuilder(fixtureRoot, outputRoot);
  record(
    "clean commit-pinned archive validates end to end",
    baseline.status === 0 &&
      /validation only \(not published\)/i.test(baseline.stdout),
    baseline,
  );
  record(
    "only stale builder-owned artifacts are scavenged",
    baseline.status === 0 &&
      !existsSync(staleBuildPath) &&
      !existsSync(stalePartialPath) &&
      existsSync(freshBuildPath) &&
      existsSync(freshPartialPath) &&
      existsSync(unrelatedOldPath),
    baseline,
  );

  const inlineSecretPath = join(fixtureRoot, "public", "inline-secret.html");
  writeFileSync(
    inlineSecretPath,
    '<script>JWT_SECRET = "hardcoded-supersecret";</script>\n',
  );
  commitFixture(fixtureRoot, "inline HTML secret", [
    "public/inline-secret.html",
  ]);
  const inlineSecret = runBuilder(fixtureRoot, outputRoot);
  record(
    "non-JavaScript text hardcoded secret assignment is refused",
    inlineSecret.status !== 0 &&
      /hardcoded secret assignment: public\/inline-secret\.html/i.test(
        inlineSecret.stdout,
      ),
    inlineSecret,
  );
  writeFileSync(inlineSecretPath, "<!doctype html>\n");
  commitFixture(fixtureRoot, "remove inline HTML secret", [
    "public/inline-secret.html",
  ]);

  const fakeSignaturePath = join(
    fixtureRoot,
    "public",
    "fake-zip-signature.png",
  );
  writeFileSync(
    fakeSignaturePath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("benign-prefix"),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
    ]),
  );
  commitFixture(fixtureRoot, "isolated ZIP signature", [
    "public/fake-zip-signature.png",
  ]);
  const fakeSignature = runBuilder(fixtureRoot, outputRoot);
  record(
    "isolated ZIP signature does not create a false positive",
    fakeSignature.status === 0 &&
      /validation only \(not published\)/i.test(fakeSignature.stdout),
    fakeSignature,
  );

  const nestedZipPath = join(temporaryRoot, "nested.zip");
  requireSuccess(
    git(fixtureRoot, [
      "archive",
      "--format=zip",
      `--output=${nestedZipPath}`,
      "HEAD",
      "--",
      "public/index.html",
    ]),
    "create nested ZIP fixture",
  );
  requireSuccess(
    git(fixtureRoot, ["rm", "-q", "--", "public/fake-zip-signature.png"]),
    "git rm fake ZIP signature",
  );
  const polyglotPath = join(fixtureRoot, "public", "polyglot.png");
  writeFileSync(
    polyglotPath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("benign-prefix"),
      readFileSync(nestedZipPath),
    ]),
  );
  commitFixture(fixtureRoot, "real ZIP polyglot", ["public/polyglot.png"]);
  const polyglot = runBuilder(fixtureRoot, outputRoot);
  record(
    "PNG with an appended coherent ZIP is refused",
    polyglot.status !== 0 &&
      /nested archive bytes: public\/polyglot\.png/i.test(polyglot.stdout),
    polyglot,
  );

  requireSuccess(
    git(fixtureRoot, ["rm", "-q", "--", "public/polyglot.png"]),
    "git rm polyglot",
  );

  const signedZipPath = join(temporaryRoot, "central-signature.zip");
  writeFileSync(
    signedZipPath,
    addZipDigitalSignature(readFileSync(nestedZipPath)),
  );
  const signedZipCompatibility = run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName System.IO.Compression; $stream = [IO.File]::OpenRead($args[0]); try { $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false); try { if ($archive.Entries.Count -lt 1) { exit 2 } } finally { $archive.Dispose() } } finally { $stream.Dispose() }",
      signedZipPath,
    ],
    { cwd: temporaryRoot, timeout: 30_000 },
  );
  const signedPolyglotPath = join(fixtureRoot, "public", "signed-polyglot.png");
  writeFileSync(
    signedPolyglotPath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("signed-prefix"),
      readFileSync(signedZipPath),
    ]),
  );
  commitFixture(fixtureRoot, "signed ZIP polyglot", [
    "public/signed-polyglot.png",
  ]);
  const signedPolyglot = runBuilder(fixtureRoot, outputRoot);
  record(
    "standards-valid ZIP digital-signature polyglot is refused",
    signedZipCompatibility.status === 0 &&
      !signedZipCompatibility.error &&
      signedPolyglot.status !== 0 &&
      /nested archive bytes: public\/signed-polyglot\.png/i.test(
        signedPolyglot.stdout,
      ),
    signedPolyglot.status === 0 ? signedPolyglot : signedZipCompatibility,
  );

  requireSuccess(
    git(fixtureRoot, ["rm", "-q", "--", "public/signed-polyglot.png"]),
    "git rm signed polyglot",
  );

  const archiveExtraZipPath = join(temporaryRoot, "archive-extra.zip");
  writeFileSync(
    archiveExtraZipPath,
    addZipArchiveExtraData(readFileSync(nestedZipPath)),
  );
  const archiveExtraPolyglotPath = join(
    fixtureRoot,
    "public",
    "archive-extra-polyglot.png",
  );
  writeFileSync(
    archiveExtraPolyglotPath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("archive-extra-prefix"),
      readFileSync(archiveExtraZipPath),
    ]),
  );
  commitFixture(fixtureRoot, "archive-extra ZIP polyglot", [
    "public/archive-extra-polyglot.png",
  ]);
  const archiveExtraPolyglot = runBuilder(fixtureRoot, outputRoot);
  record(
    "ZIP archive-extra record polyglot is refused",
    archiveExtraPolyglot.status !== 0 &&
      /nested archive bytes: public\/archive-extra-polyglot\.png/i.test(
        archiveExtraPolyglot.stdout,
      ),
    archiveExtraPolyglot,
  );

  requireSuccess(
    git(fixtureRoot, ["rm", "-q", "--", "public/archive-extra-polyglot.png"]),
    "git rm archive-extra polyglot",
  );

  const signedZip64Path = join(temporaryRoot, "central-signature-zip64.zip");
  writeFileSync(
    signedZip64Path,
    promoteZipToZip64(
      useZip64CentralSentinels(
        addZipDigitalSignature(readFileSync(nestedZipPath)),
      ),
    ),
  );
  const signedZip64Compatibility = run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName System.IO.Compression; $stream = [IO.File]::OpenRead($args[0]); try { $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false); try { if ($archive.Entries.Count -lt 1) { exit 2 } } finally { $archive.Dispose() } } finally { $stream.Dispose() }",
      signedZip64Path,
    ],
    { cwd: temporaryRoot, timeout: 30_000 },
  );
  const signedZip64PolyglotPath = join(
    fixtureRoot,
    "public",
    "signed-zip64-polyglot.png",
  );
  writeFileSync(
    signedZip64PolyglotPath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("signed-zip64-prefix"),
      readFileSync(signedZip64Path),
    ]),
  );
  commitFixture(fixtureRoot, "signed ZIP64 polyglot", [
    "public/signed-zip64-polyglot.png",
  ]);
  const signedZip64Polyglot = runBuilder(fixtureRoot, outputRoot);
  record(
    "standards-valid ZIP64 full-sentinel polyglot is refused",
    signedZip64Compatibility.status === 0 &&
      !signedZip64Compatibility.error &&
      signedZip64Polyglot.status !== 0 &&
      /nested archive bytes: public\/signed-zip64-polyglot\.png/i.test(
        signedZip64Polyglot.stdout,
      ),
    signedZip64Polyglot.status === 0
      ? signedZip64Polyglot
      : signedZip64Compatibility,
  );

  requireSuccess(
    git(fixtureRoot, ["rm", "-q", "--", "public/signed-zip64-polyglot.png"]),
    "git rm signed ZIP64 polyglot",
  );
  const oversizedPath = join(fixtureRoot, "public", "oversized.png");
  writeFileSync(oversizedPath, Buffer.alloc(32 * 1024 * 1024 + 1));
  commitFixture(fixtureRoot, "oversized blob", ["public/oversized.png"]);
  const oversized = runBuilder(fixtureRoot, outputRoot);
  record(
    "oversized committed blob is refused before archive creation",
    oversized.status !== 0 &&
      /before archive creation: public\/oversized\.png/i.test(oversized.stdout),
    oversized,
  );
} catch (error) {
  record("boundary test setup completes", false, { error });
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
