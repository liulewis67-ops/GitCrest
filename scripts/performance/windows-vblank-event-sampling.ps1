param(
  [ValidateRange(1, 30)][int]$DurationSeconds = 10,
  [string]$OutputPath
)

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace GitCrest.Performance {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct Luid {
    public uint LowPart;
    public int HighPart;
    public override string ToString() => $"{HighPart:X8}:{LowPart:X8}";
  }
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct MonitorRect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential, Pack = 4, CharSet = CharSet.Unicode)]
  public struct MonitorInfoEx {
    public uint Size;
    public MonitorRect Monitor;
    public MonitorRect Work;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
  }
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct OpenAdapterFromHdc {
    public IntPtr Hdc;
    public uint AdapterHandle;
    public Luid AdapterLuid;
    public uint VidPnSourceId;
  }
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct CloseAdapter { public uint AdapterHandle; }
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct WaitForVerticalBlankEvent {
    public uint AdapterHandle;
    public uint DeviceHandle;
    public uint VidPnSourceId;
  }
  public static class NativeVblankApi {
    [DllImport("user32.dll", EntryPoint = "MonitorFromWindow")]
    public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetMonitorInfoW", CharSet = CharSet.Unicode)]
    public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfoEx info);
    [DllImport("gdi32.dll", EntryPoint = "CreateDCW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateDC(string driver, string device, string output, IntPtr initData);
    [DllImport("gdi32.dll", EntryPoint = "DeleteDC", SetLastError = true)]
    public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll", EntryPoint = "D3DKMTOpenAdapterFromHdc")]
    public static extern int OpenAdapterFromHdc(ref OpenAdapterFromHdc data);
    [DllImport("gdi32.dll", EntryPoint = "D3DKMTCloseAdapter")]
    public static extern int CloseAdapter(ref CloseAdapter data);
    [DllImport("gdi32.dll", EntryPoint = "D3DKMTWaitForVerticalBlankEvent")]
    public static extern int WaitForVerticalBlankEvent(ref WaitForVerticalBlankEvent data);
  }
  public static class VblankSampler {
    public static object Capture(int durationSeconds) {
      IntPtr monitor = NativeVblankApi.MonitorFromWindow(IntPtr.Zero, 1);
      var info = new MonitorInfoEx { Size = (uint)Marshal.SizeOf(typeof(MonitorInfoEx)), DeviceName = new string('\0', 32) };
      if (!NativeVblankApi.GetMonitorInfo(monitor, ref info)) throw new InvalidOperationException("GetMonitorInfo failed.");
      IntPtr hdc = NativeVblankApi.CreateDC(null, info.DeviceName, null, IntPtr.Zero);
      if (hdc == IntPtr.Zero) throw new InvalidOperationException("CreateDC failed.");
      var adapter = new OpenAdapterFromHdc { Hdc = hdc };
      bool opened = false;
      try {
        int result = NativeVblankApi.OpenAdapterFromHdc(ref adapter);
        if (result != 0) throw new InvalidOperationException($"D3DKMTOpenAdapterFromHdc failed: 0x{result:X8}");
        opened = true;
        var wait = new WaitForVerticalBlankEvent { AdapterHandle = adapter.AdapterHandle, DeviceHandle = 0, VidPnSourceId = adapter.VidPnSourceId };
        var intervalsMs = new List<double>();
        var events = new List<Dictionary<string, object>>();
        var timer = Stopwatch.StartNew();
        long previous = 0;
        int waitStatus = 0;
        while (timer.Elapsed.TotalSeconds < durationSeconds) {
          int waitResult = NativeVblankApi.WaitForVerticalBlankEvent(ref wait);
          long timestamp = Stopwatch.GetTimestamp();
          if (waitResult != 0) { waitStatus = waitResult; break; }
          double elapsedMs = timestamp * 1000.0 / Stopwatch.Frequency;
          double intervalMs = previous == 0 ? 0 : (timestamp - previous) * 1000.0 / Stopwatch.Frequency;
          if (previous != 0) intervalsMs.Add(intervalMs);
          events.Add(new Dictionary<string, object> { ["elapsedMs"] = Math.Round(elapsedMs, 3), ["intervalMs"] = Math.Round(intervalMs, 3) });
          previous = timestamp;
        }
        timer.Stop();
        return new Dictionary<string, object> {
          ["api"] = "D3DKMTWaitForVerticalBlankEvent",
          ["durationSecondsRequested"] = durationSeconds,
          ["durationSecondsMeasured"] = Math.Round(timer.Elapsed.TotalSeconds, 3),
          ["primaryMonitorDeviceName"] = info.DeviceName.TrimEnd('\0'),
          ["adapterLuid"] = adapter.AdapterLuid.ToString(),
          ["vidPnSourceId"] = adapter.VidPnSourceId,
          ["waitStatusHex"] = $"0x{waitStatus:X8}",
          ["waitStatusName"] = waitStatus == unchecked((int)0xC01E0006u) ? "STATUS_GRAPHICS_PRESENT_OCCLUDED" : waitStatus == 0 ? "STATUS_SUCCESS" : "OTHER_NTSTATUS",
          ["successfulWaitCount"] = events.Count,
          ["intervalSampleCount"] = intervalsMs.Count,
          ["intervalsMs"] = intervalsMs,
          ["events"] = events,
        };
      } finally {
        if (opened) { var close = new CloseAdapter { AdapterHandle = adapter.AdapterHandle }; NativeVblankApi.CloseAdapter(ref close); }
        NativeVblankApi.DeleteDC(hdc);
      }
    }
  }
}
'@

Add-Type -TypeDefinition $source
$report = [GitCrest.Performance.VblankSampler]::Capture($DurationSeconds)
$intervals = @($report.intervalsMs | Sort-Object)
if ($intervals.Count -gt 0) {
  $report | Add-Member -NotePropertyName intervalSummaryMs -NotePropertyValue ([ordered]@{
    min = [math]::Round($intervals[0], 3)
    p50 = [math]::Round($intervals[[math]::Floor(($intervals.Count - 1) * 0.50)], 3)
    p95 = [math]::Round($intervals[[math]::Floor(($intervals.Count - 1) * 0.95)], 3)
    max = [math]::Round($intervals[-1], 3)
  })
  $report | Add-Member -NotePropertyName observedHz -NotePropertyValue ([math]::Round($report.intervalSampleCount / $report.durationSecondsMeasured, 3))
}
$json = $report | ConvertTo-Json -Depth 8
if ($OutputPath) { $json | Set-Content -LiteralPath $OutputPath -Encoding utf8 }
Write-Output $json
