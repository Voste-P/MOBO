$file = "F:\MOBO\backend\prisma\schema.prisma"
$content = [System.IO.File]::ReadAllText($file)

# Replace deletedAt + deletedBy pair (with varying whitespace)
$pattern1 = '  deletedAt DateTime\? @map\("deleted_at"\)\r?\n  deletedBy String\?   @map\("deleted_by"\) @db\.Uuid'
$replace1 = '  isDeleted Boolean @default(false) @map("is_deleted")'
$content = [regex]::Replace($content, $pattern1, $replace1)

# Replace standalone deletedAt with extra leading spaces (PendingConnection, OrderItem, PushSubscription)
$pattern2 = '  deletedAt\s+DateTime\? @map\("deleted_at"\)'
$replace2 = '  isDeleted Boolean @default(false) @map("is_deleted")'
$content = [regex]::Replace($content, $pattern2, $replace2)

# Update indexes: deletedAt -> isDeleted
$content = $content.Replace('deletedAt', 'isDeleted')

[System.IO.File]::WriteAllText($file, $content)
Write-Host "Schema updated"
