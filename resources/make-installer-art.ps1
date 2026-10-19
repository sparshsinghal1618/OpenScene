#requires -Version 5.1
<#
  OpenScene - resources/make-installer-art.ps1
  Renders the NSIS installer header strip (150x57, 24-bit BMP) from the same
  brand recipe as the app icon: a blue/navy gradient plate, the dark inner
  panel, the white playhead triangle and the wordmark. NSIS cannot read the
  PNG icon directly, so this produces the bitmap it needs.
  Run:  powershell -ExecutionPolicy Bypass -File resources/make-installer-art.ps1
#>

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$res = Split-Path -Parent $MyInvocation.MyCommand.Path

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

$W = 150; $H = 57
$bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

# --- full-bleed brand gradient ---
$p1 = New-Object System.Drawing.PointF 0, 0
$p2 = New-Object System.Drawing.PointF $W, $H
$c1 = [System.Drawing.Color]::FromArgb(255, 46, 158, 255)
$c2 = [System.Drawing.Color]::FromArgb(255, 24, 62, 158)
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($p1, $p2, $c1, $c2)
$g.FillRectangle($grad, 0, 0, $W, $H)

# --- dark inner panel ---
$inner = New-Object System.Drawing.Drawing2D.GraphicsPath
Add-RoundedRect $inner 4 4 142 49 9
$dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 12, 17, 26))
$g.FillPath($dark, $inner)

# --- violet playhead line ---
$violet = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 139, 92, 246))
$g.FillRectangle($violet, 130, 13, 3, 31)

# --- white play triangle ---
$tri = New-Object System.Drawing.Drawing2D.GraphicsPath
$pts = @(
  (New-Object System.Drawing.PointF 19, 16),
  (New-Object System.Drawing.PointF 41, 28.5),
  (New-Object System.Drawing.PointF 19, 41)
)
$tri.AddPolygon($pts)
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 244, 249, 255))
$g.FillPath($white, $tri)

# --- wordmark ---
$font = New-Object System.Drawing.Font('Segoe UI', 15, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Near
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$g.DrawString('OpenScene', $font, $white, (New-Object System.Drawing.RectangleF 50, 4, 78, 49), $sf)

$g.Dispose()

$out = Join-Path $res 'installer-header.bmp'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Bmp)
$bmp.Dispose()
Write-Host "Wrote $out" -ForegroundColor Green
