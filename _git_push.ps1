Set-Location F:\MOBO
$out = @()
$out += "=== GIT ADD ==="
git add -A 2>&1
$out += "=== GIT COMMIT ==="
$out += (git commit -m "fix: return window verification — use externalOrderId, hard-block orderID+product+seller only" 2>&1 | Out-String)
$out += "=== GIT PUSH ==="
$out += (git push origin develop 2>&1 | Out-String)
$out += "=== GIT LOG ==="
$out += (git log --oneline -3 2>&1 | Out-String)
$out += "=== GIT STATUS ==="
$out += (git status --short 2>&1 | Out-String)
$out += "=== DONE ==="
$out -join "`n" | Out-File -FilePath "F:\MOBO\_git_result.txt" -Encoding utf8
