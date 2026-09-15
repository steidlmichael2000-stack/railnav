<#
    make-icons.ps1 - erzeugt die PWA-Icons aus icon.svg.
    Muss nur laufen, wenn sich das Motiv aendert - geaendert wird es in
    icon.svg, nicht hier.

    Rasterisiert wird mit dem headless Browser: icon.svg ist dieselbe
    Zeichnung wie das Kachel-Icon auf der Uebersichtsseite, und die soll
    Strich fuer Strich gleich bleiben.
#>
[CmdletBinding()] param()
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root   = $PSScriptRoot
$ground = "#07080d"   # gleicher Ton wie die Flaeche in icon.svg

$browser = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $browser) { throw "Weder Chrome noch Edge gefunden - ohne Browser keine Rasterisierung." }

# Gross rendern und danach herunterrechnen, das gibt saubere Kanten.
$render = 2048
$svg    = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $root "icon.svg")))
$tmp    = Join-Path ([IO.Path]::GetTempPath()) ("icons-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null

function New-Shot {
    param([string] $Name, [double] $Share)

    # $Share < 1 ist der maskable-Fall: icon.svg sitzt kleiner auf ganzflaechigem
    # Grund. Weil der Grund derselbe Ton ist, fallen die runden Ecken von
    # icon.svg dabei nicht auf - Android schneidet selbst zu.
    $inner = [int]($render * $Share)
    # Bei voller Groesse bleibt der Grund durchsichtig, sonst wuerden die
    # runden Ecken von icon.svg im gleichfarbigen Hintergrund verschwinden.
    $back  = if ($Share -ge 1.0) { "transparent" } else { $ground }
    $html  = Join-Path $tmp "$Name.html"
    @"
<!doctype html><meta charset=utf-8>
<style>html,body{margin:0;padding:0;background:transparent}
.b{width:${render}px;height:${render}px;background:$back;display:flex;align-items:center;justify-content:center}
img{width:${inner}px;height:${inner}px}</style>
<div class=b><img src="data:image/svg+xml;base64,$svg"></div>
"@ | Set-Content -Path $html -Encoding UTF8

    $out = Join-Path $tmp "$Name.png"
    $url = "file:///" + $html.Replace([char]92, "/")
    & $browser --headless=new --disable-gpu --hide-scrollbars `
        --default-background-color=00000000 --force-device-scale-factor=1 `
        "--window-size=$render,$render" "--screenshot=$out" $url | Out-Null
    if (-not (Test-Path $out)) { throw "Rasterisierung fehlgeschlagen: $Name" }
    return $out
}

function Save-Scaled {
    param([string] $Source, [int] $Size, [string] $Path)

    $dir = Split-Path -Parent $Path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

    $src = [System.Drawing.Image]::FromFile($Source)
    $bmp = [System.Drawing.Bitmap]::new($Size, $Size)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.PixelOffsetMode   = 'HighQuality'
    $g.SmoothingMode     = 'AntiAlias'
    $g.DrawImage($src, 0, 0, $Size, $Size)
    $g.Dispose()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose(); $src.Dispose()
    Write-Host "  $([IO.Path]::GetFileName($Path)) ($Size x $Size)"
}

Write-Host "Icons werden erzeugt:" -ForegroundColor Cyan
try {
    $any = New-Shot -Name "any" -Share 1.0
    Save-Scaled -Source $any -Size 512 -Path (Join-Path $root "icons/icon-512.png")
    Save-Scaled -Source $any -Size 192 -Path (Join-Path $root "icons/icon-192.png")
    Save-Scaled -Source $any -Size 180 -Path (Join-Path $root "icons/icon-180.png")

    # Mehr Luft, weil Android beim maskable-Icon die Raender wegschneidet.
    $mask = New-Shot -Name "maskable" -Share 0.78
    Save-Scaled -Source $mask -Size 512 -Path (Join-Path $root "icons/icon-512-maskable.png")
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
Write-Host "Fertig." -ForegroundColor Green
