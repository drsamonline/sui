# Run Sui from this checkout in PowerShell. No npm, no publish, no npx.
#
#   .\sui.ps1 doctor
#   .\sui.ps1 start
#
# If PowerShell says "running scripts is disabled on this system", either use
# .\sui.cmd instead (it is a batch file, not a script), or run this once:
#   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
param([Parameter(ValueFromRemainingArguments = $true)] $Rest)

# no arguments is valid: it means "first run", so make sure the splat has an array
if ($null -eq $Rest) { $Rest = @() }
& node "$PSScriptRoot/apps/cli/bin/sui.js" @Rest
exit $LASTEXITCODE
