# 从 build/icon.png 生成多尺寸 ICO（PNG-in-ICO，Vista+ 支持），
# 规避 electron-builder icons 工具在 Windows 上的 EINVAL 兼容问题。
Add-Type -AssemblyName System.Drawing

$src = "build\icon.png"
$out = "build\icon.ico"
$sizes = 16, 24, 32, 48, 64, 128, 256

$source = [System.Drawing.Image]::FromFile((Resolve-Path $src))

# 收集各尺寸 PNG 字节
$entries = @()
$pngBytes = @{}
foreach ($size in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($source, 0, 0, $size, $size)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytes[$size] = $ms.ToArray()
  $bmp.Dispose()
  $ms.Dispose()
}
$source.Dispose()

$count = $sizes.Count
$headerSize = 6
$entrySize = 16
$dataOffset = $headerSize + ($entrySize * $count)

$fs = [System.IO.File]::Create($out)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)          # reserved
$bw.Write([UInt16]1)          # type: icon
$bw.Write([UInt16]$count)
$offset = $dataOffset
foreach ($size in $sizes) {
  $data = $pngBytes[$size]
  $bw.Write([Byte]($(if ($size -ge 256) { 0 } else { $size })))  # width
  $bw.Write([Byte]($(if ($size -ge 256) { 0 } else { $size })))  # height
  $bw.Write([Byte]0)          # palette
  $bw.Write([Byte]0)          # reserved
  $bw.Write([UInt16]1)        # planes
  $bw.Write([UInt16]32)       # bpp
  $bw.Write([UInt32]$data.Length)
  $bw.Write([UInt32]$offset)
  $offset += $data.Length
}
foreach ($size in $sizes) {
  $bw.Write($pngBytes[$size])
}
$bw.Flush()
$bw.Close()
$fs.Close()
Write-Output "generated $out ($(Get-Item $out).Length bytes, $count sizes)"
