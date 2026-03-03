# Bulk replace deletedAt: null -> isDeleted: false across all .ts files in backend/
$backendDir = "F:\MOBO\backend"
$files = Get-ChildItem -Path $backendDir -Recurse -Include "*.ts" -File | Where-Object {
    $_.FullName -notlike "*node_modules*" -and $_.FullName -notlike "*generated*"
}

$totalChanges = 0

foreach ($f in $files) {
    $content = [System.IO.File]::ReadAllText($f.FullName)
    $original = $content

    # deletedAt: null -> isDeleted: false
    $content = $content.Replace('deletedAt: null', 'isDeleted: false')
    
    # deletedAt: { not: null } -> isDeleted: true
    $content = $content.Replace('deletedAt: { not: null }', 'isDeleted: true')
    
    # deletedAt: new Date() -> isDeleted: true 
    $content = $content.Replace('deletedAt: new Date()', 'isDeleted: true')
    
    # deletedBy: ... patterns - replace { deletedAt: ..., deletedBy: ... } -> { isDeleted: true, updatedBy: ... }
    # This is done via regex to catch various patterns
    $content = [regex]::Replace($content, 'deletedAt:\s*new\s+Date\(\)', 'isDeleted: true')
    
    # Remove deletedBy standalone references (as the updatedBy already exists in update data)
    # Pattern: deletedBy: someVariable -> updatedBy: someVariable (but only in delete contexts)
    $content = [regex]::Replace($content, '(\s+)deletedBy:\s*([^,\r\n}]+)', '$1updatedBy: $2')
    
    # Fix double updatedBy (if updatedBy already exists nearby, the deletedBy->updatedBy causes duplicates)
    # We'll handle this case-by-case in manual fixes
    
    # Update any remaining deletedAt references
    $content = $content.Replace("deletedAt", "isDeleted")

    if ($content -ne $original) {
        [System.IO.File]::WriteAllText($f.FullName, $content)
        $changes = ($content.Length - $original.Length)
        $totalChanges++
        Write-Host "Updated: $($f.Name)"
    }
}

Write-Host "Total files updated: $totalChanges"
