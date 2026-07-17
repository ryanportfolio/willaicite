# new-claude-project.ps1 - spin up a new project from the Agent Firmware template.
#
# What it does:
#   1. Prompts for a project name (or takes it as -Name).
#   2. Creates a PRIVATE GitHub repo from the claude-starter template (gh CLI).
#   3. Clones it into the destination folder.
#   4. Falls back to a local copy + printed manual steps if gh is unavailable.
#
# Usage:
#   .\new-claude-project.ps1                      # interactive prompt
#   .\new-claude-project.ps1 -Name my-app         # named
#   .\new-claude-project.ps1 -Name my-app -Dest D:\code

param(
    [string]$Name,
    [string]$Dest = "$HOME\code",
    [string]$Template = "ryanportfolio/claude-starter"
)

$ErrorActionPreference = 'Stop'

if (-not $Name) {
    $Name = Read-Host "New project name (kebab-case, becomes folder + repo name)"
}
if (-not $Name -or $Name -notmatch '^[a-zA-Z0-9._-]+$') {
    Write-Host "Invalid name '$Name' - letters, digits, dot, dash, underscore only." -ForegroundColor Red
    exit 1
}

$target = Join-Path $Dest $Name
if (Test-Path $target) {
    Write-Host "Folder already exists: $target" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Force $Dest | Out-Null }

$ghOk = $false
try {
    $null = Get-Command gh -ErrorAction Stop
    # cmd /c swallows gh's stderr without PS 5.1 wrapping it in ErrorRecords
    cmd /c "gh auth status >nul 2>&1"
    if ($LASTEXITCODE -eq 0) { $ghOk = $true }
} catch {}

if ($ghOk) {
    Write-Host "Creating private repo '$Name' from template $Template ..." -ForegroundColor Cyan
    gh repo create $Name --template $Template --private --clone
    if ($LASTEXITCODE -ne 0) {
        Write-Host "gh repo create failed - falling back to local copy." -ForegroundColor Yellow
        $ghOk = $false
    } else {
        # gh clones into .\$Name relative to cwd; move it to the destination if different
        $cloned = Join-Path (Get-Location) $Name
        if ($cloned -ne $target -and (Test-Path $cloned)) { Move-Item $cloned $target }
        # Strip template-only files, drop in a README stub
        Push-Location $target
        git rm -rq --ignore-unmatch bootstrap .claude-plugin .github/workflows/validate-template.yml
        if ($LASTEXITCODE -ne 0) { throw "Failed to remove template-only files." }
        git rm -q --ignore-unmatch README.md
        if ($LASTEXITCODE -ne 0) { throw "Failed to replace the template README." }
        if (Test-Path 'bootstrap') { Remove-Item -Recurse -Force bootstrap }
        if (Test-Path '.claude-plugin') { Remove-Item -Recurse -Force .claude-plugin }
        if (Test-Path '.github\workflows\validate-template.yml') { Remove-Item -Force '.github\workflows\validate-template.yml' }
        if (Test-Path 'README.md') { Remove-Item -Force README.md }
        [IO.File]::WriteAllText((Join-Path (Get-Location).Path 'README.md'), "# $Name`r`n", [Text.Encoding]::ASCII)
        git add README.md
        if ($LASTEXITCODE -ne 0) { throw "Failed to stage the replacement README." }
        $pendingChanges = git status --porcelain
        if ($LASTEXITCODE -ne 0) { throw "Failed to inspect template cleanup changes." }
        if (-not $pendingChanges) {
            Write-Host "Nothing to clean up." -ForegroundColor DarkGray
        } else {
            git commit -qm "Strip template files, add README stub"
            if ($LASTEXITCODE -ne 0) { throw "Failed to commit template cleanup." }
            git push -q
            if ($LASTEXITCODE -ne 0) { throw "Failed to push template cleanup." }
        }
        Pop-Location
        Write-Host ""
        Write-Host "DONE. Private repo created and cloned:" -ForegroundColor Green
        Write-Host "  Local:  $target"
        Write-Host "  Remote: https://github.com/$((gh api user --jq .login))/$Name"
        Write-Host ""
        Write-Host "Next: open the folder in Claude Code and run /init-project."
        Write-Host "Codex users: open the folder in Codex and select the init-project skill."
        exit 0
    }
}

# ---- Fallback: no gh / not authed / create failed -> local copy + manual steps ----
Write-Host "gh CLI unavailable - building the project locally instead." -ForegroundColor Yellow
$localTemplate = Split-Path -Parent $PSScriptRoot   # repo root containing this script

Write-Host "Copying template from $localTemplate ..." -ForegroundColor Cyan
robocopy $localTemplate $target /E /XD .git bootstrap .claude-plugin /XF README.md validate-template.yml | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host "Copy failed." -ForegroundColor Red; exit 1 }

Push-Location $target
[IO.File]::WriteAllText((Join-Path (Get-Location).Path 'README.md'), "# $Name`r`n", [Text.Encoding]::ASCII)
git init -b main | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to initialize the local repository." }
git add -A
if ($LASTEXITCODE -ne 0) { throw "Failed to stage the local template copy." }
git commit -qm "Initialize from claude-starter template"
if ($LASTEXITCODE -ne 0) { throw "Failed to commit the local template copy." }
Pop-Location

Write-Host ""
Write-Host "DONE (local only). Folder ready: $target" -ForegroundColor Green
Write-Host ""
Write-Host "To put it on GitHub manually:" -ForegroundColor Cyan
Write-Host "  1. Create a PRIVATE repo named '$Name' at https://github.com/new"
Write-Host "  2. Then run:"
Write-Host "       cd `"$target`""
Write-Host "       git remote add origin https://github.com/<your-username>/$Name.git"
Write-Host "       git push -u origin main"
Write-Host ""
Write-Host "Next: open the folder in Claude Code and run /init-project."
Write-Host "Codex users: open the folder in Codex and select the init-project skill."
