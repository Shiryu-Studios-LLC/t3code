Add-Type -AssemblyName System.Drawing

$sourcePath = Join-Path $PSScriptRoot "..\assets\t3-studio-logo.png"
$orig = [System.Drawing.Image]::FromFile($sourcePath)

function Resize-Image($image, $width, $height) {
    $destRect = New-Object System.Drawing.Rectangle(0, 0, $width, $height)
    $destImage = New-Object System.Drawing.Bitmap($width, $height)
    $destImage.SetResolution($image.HorizontalResolution, $image.VerticalResolution)
    $graphics = [System.Drawing.Graphics]::FromImage($destImage)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage($image, $destRect, 0, 0, $image.Width, $image.Height, [System.Drawing.GraphicsUnit]::Pixel)
    $graphics.Dispose()
    return $destImage
}

# 1. 1024x1024 PNGs
$png1024 = Resize-Image $orig 1024 1024
$png1024.Save("I:\t3code\assets\dev\blueprint-macos-1024.png", [System.Drawing.Imaging.ImageFormat]::Png)
$png1024.Save("I:\t3code\assets\dev\blueprint-universal-1024.png", [System.Drawing.Imaging.ImageFormat]::Png)
$png1024.Save("I:\t3code\assets\dev\blueprint-ios-1024.png", [System.Drawing.Imaging.ImageFormat]::Png)
$png1024.Save("I:\t3code\assets\prod\black-macos-1024.png", [System.Drawing.Imaging.ImageFormat]::Png)
$png1024.Save("I:\t3code\assets\prod\black-universal-1024.png", [System.Drawing.Imaging.ImageFormat]::Png)
$png1024.Save("I:\t3code\assets\prod\black-ios-1024.png", [System.Drawing.Imaging.ImageFormat]::Png)

# 2. Web Apple Touch 180x180
$png180 = Resize-Image $orig 180 180
$png180.Save("I:\t3code\assets\dev\blueprint-web-apple-touch-180.png", [System.Drawing.Imaging.ImageFormat]::Png)
$png180.Save("I:\t3code\assets\prod\t3-black-web-apple-touch-180.png", [System.Drawing.Imaging.ImageFormat]::Png)
$png180.Save("I:\t3code\apps\web\public\apple-touch-icon.png", [System.Drawing.Imaging.ImageFormat]::Png)

# Compact in-app sidebar mark; keep the full-resolution approved source in assets/.
$png128 = Resize-Image $orig 128 128
$png128.Save("I:\t3code\apps\web\src\assets\t3-studio-logo.png", [System.Drawing.Imaging.ImageFormat]::Png)

# 3. Favicon 32x32 and 16x16
$png32 = Resize-Image $orig 32 32
$png32.Save("I:\t3code\assets\dev\blueprint-web-favicon-32x32.png", [System.Drawing.Imaging.ImageFormat]::Png)
$png32.Save("I:\t3code\assets\prod\t3-black-web-favicon-32x32.png", [System.Drawing.Imaging.ImageFormat]::Png)
$png32.Save("I:\t3code\apps\web\public\favicon-32x32.png", [System.Drawing.Imaging.ImageFormat]::Png)

$png16 = Resize-Image $orig 16 16
$png16.Save("I:\t3code\assets\dev\blueprint-web-favicon-16x16.png", [System.Drawing.Imaging.ImageFormat]::Png)
$png16.Save("I:\t3code\assets\prod\t3-black-web-favicon-16x16.png", [System.Drawing.Imaging.ImageFormat]::Png)
$png16.Save("I:\t3code\apps\web\public\favicon-16x16.png", [System.Drawing.Imaging.ImageFormat]::Png)

Write-Host "PNG icons generated successfully."
