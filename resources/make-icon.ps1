#requires -Version 5.1
<#
  OpenScene - resources/make-icon.ps1
  Generates resources/icon.ico (a multi-size friendly 256x256 PNG-compressed ICO)
  and resources/icon.png (512x512) for the web fallback, using only System.Drawing.
  Run:  powershell -ExecutionPolicy Bypass -File resources/make-icon.ps1
#>

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$res = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path $res)) { New-Item -ItemType Directory -Path $res | Out-Null }

function Add-RoundedRect {
  param(
    [System.Drawing.Drawing2D.GraphicsPath]$Path,
    [single]$X, [single]$Y, [single]$W, [single]$H, [single]$R
  )
  if ($R -lt 0.5) { $R = 0.5 }
  if ($R * 2 -gt $W) { $R = $W / 2 }
  if ($R * 2 -gt $H) { $R = $H / 2 }
  $d = $R * 2
  $Path.AddArc($X, $Y, $d, $d, 180, 90)
  $Path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
  $Path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
  $Path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
  $Path.CloseFigure()
}

function New-LogoBitmap {
  param([int]$Size)

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $s = $Size / 256.0

  # --- rounded gradient plate ---
  $pad = [single](10 * $s)
  $plate = New-Object System.Drawing.Drawing2D.GraphicsPath
  Add-RoundedRect $plate $pad $pad ([single]($Size - 2 * $pad)) ([single]($Size - 2 * $pad)) ([single](56 * $s))

  $p1 = New-Object System.Drawing.PointF 0, 0
  $p2 = New-Object System.Drawing.PointF $Size, $Size
  $c1 = [System.Drawing.Color]::FromArgb(255, 46, 158, 255)
  $c2 = [System.Drawing.Color]::FromArgb(255, 24, 62, 158)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($p1, $p2, $c1, $c2)
  $g.FillPath($grad, $plate)

  # --- inner dark plate ---
  $inset = [single](52 * $s)
  $inner = New-Object System.Drawing.Drawing2D.GraphicsPath
  Add-RoundedRect $inner $inset $inset ([single]($Size - 2 * $inset)) ([single]($Size - 2 * $inset)) ([single](32 * $s))
  $dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(232, 9, 13, 19))
  $g.FillPath($dark, $inner)

  # --- sprocket holes (filmstrip) ---
  $hole = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120, 210, 230, 255))
  $hw = [single](7 * $s)
  $hh = [single](12 * $s)
  foreach ($hy in @(78, 122, 166)) {
    $topY = [single]($hy * $s)
    $g.FillRectangle($hole, [single](34 * $s), $topY, $hw, $hh)
    $g.FillRectangle($hole, [single](($Size / $s - 34) * $s - $hw), $topY, $hw, $hh)
  }

  # --- play triangle ---
  $cx = [single]($Size / 2.0)
  $cy = [single]($Size / 2.0)
  $tri = New-Object System.Drawing.Drawing2D.GraphicsPath
  $pts = @(
    (New-Object System.Drawing.PointF ([single]($cx - 24 * $s)), ([single]($cy - 40 * $s))),
    (New-Object System.Drawing.PointF ([single]($cx + 44 * $s)), ([single]$cy)),
    (New-Object System.Drawing.PointF ([single]($cx - 24 * $s)), ([single]($cy + 40 * $s)))
  )
  $tri.AddPolygon($pts)
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 244, 249, 255))
  $g.FillPath($white, $tri)

  $g.Dispose()
  return $bmp
}

# ---------- render sizes ----------
$tmp = Join-Path $env:TEMP ('openscene-icon-' + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngs = @{}
foreach ($sz in $sizes) {
  $b = New-LogoBitmap -Size $sz
  $p = Join-Path $tmp ("icon-$sz.png")
  $b.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs[$sz] = $p
  $b.Dispose()
}

# ---------- 512 png for the web fallback ----------
$big = New-LogoBitmap -Size 512
$pngOut = Join-Path $res 'icon.png'
$big.Save($pngOut, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()

# ---------- assemble the ICO container ----------
$icoPath = Join-Path $res 'icon.ico'
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)

$bw.Write([UInt16]0)                  # reserved
$bw.Write([UInt16]1)                  # type = icon
$bw.Write([UInt16]$sizes.Count)       # image count

$offset = 6 + (16 * $sizes.Count)
foreach ($sz in $sizes) {
  $bytes = [System.IO.File]::ReadAllBytes($pngs[$sz])
  $dim = if ($sz -ge 256) { 0 } else { $sz }
  $bw.Write([Byte]$dim)               # width  (0 => 256)
  $bw.Write([Byte]$dim)               # height (0 => 256)
  $bw.Write([Byte]0)                  # palette colours
  $bw.Write([Byte]0)                  # reserved
  $bw.Write([UInt16]1)                # colour planes
  $bw.Write([UInt16]32)               # bits per pixel
  $bw.Write([UInt32]$bytes.Length)    # size of image data
  $bw.Write([UInt32]$offset)          # offset of image data
  $offset += $bytes.Length
}
foreach ($sz in $sizes) {
  $bw.Write([System.IO.File]::ReadAllBytes($pngs[$sz]))
}
$bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

Write-Host "Wrote $icoPath" -ForegroundColor Green
Write-Host "Wrote $pngOut" -ForegroundColor Green
