param(
  [ValidateRange(1, 60)]
  [int]$DurationSeconds = 2,
  [string]$OutputPath
)

$source = @'
using System;
using System.Runtime.InteropServices;

namespace GitCrest.Performance {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct UnsignedRatio {
    public uint Numerator;
    public uint Denominator;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct DwmTimingInfo {
    public uint Size;
    public UnsignedRatio RefreshRate;
    public ulong RefreshPeriodQpc;
    public UnsignedRatio ComposeRate;
    public ulong VBlankQpc;
    public ulong RefreshCount;
    public uint DxRefreshCount;
    public ulong ComposeQpc;
    public ulong FrameCount;
    public uint DxPresentCount;
    public ulong RefreshFrameCount;
    public ulong SubmittedFrameCount;
    public uint SubmittedDxPresentCount;
    public ulong ConfirmedFrameCount;
    public uint ConfirmedDxPresentCount;
    public ulong ConfirmedRefreshCount;
    public uint ConfirmedDxRefreshCount;
    public ulong FramesLate;
    public uint FramesOutstanding;
    public ulong DisplayedFrameCount;
    public ulong DisplayedFrameQpc;
    public ulong DisplayedRefreshFrameCount;
    public ulong CompleteFrameCount;
    public ulong CompleteFrameQpc;
    public ulong PendingFrameCount;
    public ulong PendingFrameQpc;
    public ulong FramesDisplayed;
    public ulong FramesComplete;
    public ulong FramesPending;
    public ulong FramesAvailable;
    public ulong FramesDropped;
    public ulong FramesMissed;
    public ulong NextDisplayedRefreshCount;
    public ulong NextPresentedRefreshCount;
    public ulong RefreshesDisplayed;
    public ulong RefreshesPresented;
    public ulong RefreshStarted;
    public ulong PixelsReceived;
    public ulong PixelsDrawn;
    public ulong EmptyBuffers;
  }

  public static class DwmTimingApi {
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetCompositionTimingInfo(IntPtr hwnd, ref DwmTimingInfo info);
  }
}
'@

Add-Type -TypeDefinition $source

function Get-DwmSnapshot {
  $info = New-Object GitCrest.Performance.DwmTimingInfo
  $info.Size = [uint32][Runtime.InteropServices.Marshal]::SizeOf([type][GitCrest.Performance.DwmTimingInfo])
  $result = [GitCrest.Performance.DwmTimingApi]::DwmGetCompositionTimingInfo([IntPtr]::Zero, [ref]$info)
  if ($result -ne 0) {
    throw ('DwmGetCompositionTimingInfo failed with HRESULT 0x{0:X8}.' -f $result)
  }

  [pscustomobject]@{
    refreshHz = if ($info.RefreshRate.Denominator) { $info.RefreshRate.Numerator / $info.RefreshRate.Denominator } else { $null }
    composeHz = if ($info.ComposeRate.Denominator) { $info.ComposeRate.Numerator / $info.ComposeRate.Denominator } else { $null }
    refreshPeriodQpc = $info.RefreshPeriodQpc
    refreshCount = $info.RefreshCount
    frameCount = $info.FrameCount
    framesLate = $info.FramesLate
    framesMissed = $info.FramesMissed
    framesDropped = $info.FramesDropped
  }
}

$before = Get-DwmSnapshot
Start-Sleep -Seconds $DurationSeconds
$after = Get-DwmSnapshot
$displayDevices = @(Get-CimInstance Win32_VideoController | ForEach-Object {
  [pscustomobject]@{
    name = $_.Name
    currentRefreshRateHz = $_.CurrentRefreshRate
    horizontalResolution = $_.CurrentHorizontalResolution
    verticalResolution = $_.CurrentVerticalResolution
  }
})
$report = [pscustomobject]@{
  sampledAt = [DateTime]::UtcNow.ToString('o')
  durationSeconds = $DurationSeconds
  windows = [Environment]::OSVersion.Version.ToString()
  dwm = [pscustomobject]@{
    refreshHz = $after.refreshHz
    composeHz = $after.composeHz
    refreshPeriodQpc = $after.refreshPeriodQpc
    refreshCountDelta = $after.refreshCount - $before.refreshCount
    frameCountDelta = $after.frameCount - $before.frameCount
    framesLate = $after.framesLate
    framesMissed = $after.framesMissed
    framesDropped = $after.framesDropped
  }
  measurementNotes = @(
    'DWM refreshHz and composeHz are system-level rates, not per-application presentation rates.'
    'Frame counters are point-in-time DWM values; an idle desktop may not advance them on every hardware refresh.'
  )
  displayDevices = $displayDevices
}
$json = $report | ConvertTo-Json -Depth 4
if ($OutputPath) {
  $json | Set-Content -LiteralPath $OutputPath -Encoding utf8
  Write-Output $json
} else {
  Write-Output $json
}
