# Fix duplicate updatedBy and isDeleted: now issues
$backendDir = "F:\MOBO\backend"
$files = Get-ChildItem -Path $backendDir -Recurse -Include "*.ts" -File | Where-Object {
    $_.FullName -notlike "*node_modules*" -and $_.FullName -notlike "*generated*"
}

$totalChanges = 0

foreach ($f in $files) {
    $content = [System.IO.File]::ReadAllText($f.FullName)
    $original = $content

    # Fix duplicate updatedBy: Remove second occurrence of "updatedBy: ..." in same object literal line
    # Pattern: updatedBy: X, updatedBy: Y -> updatedBy: X
    $content = [regex]::Replace($content, '(updatedBy:\s*[^,}\r\n]+),\s*updatedBy:\s*[^,}\r\n]+', '$1')

    # Fix isDeleted: now -> isDeleted: true (now was a Date variable, but isDeleted is Boolean)
    $content = [regex]::Replace($content, 'isDeleted:\s*now\b', 'isDeleted: true')

    if ($content -ne $original) {
        [System.IO.File]::WriteAllText($f.FullName, $content)
        $totalChanges++
        Write-Host "Fixed: $($f.Name)"
    }
}

Write-Host "Total files fixed: $totalChanges"
