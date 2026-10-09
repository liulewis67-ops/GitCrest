param([string]$OutputPath)

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace GitCrest.Performance {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct Luid {
    public uint LowPart;
    public int HighPart;
    public override string ToString() => $"{HighPart:X8}:{LowPart:X8}";
    public bool SameAs(Luid other) => LowPart == other.LowPart && HighPart == other.HighPart;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct Rect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4, CharSet = CharSet.Unicode)]
  public struct MonitorInfoEx {
    public uint Size;
    public Rect Monitor;
    public Rect Work;
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
  public struct CloseAdapter {
    public uint AdapterHandle;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct Rational {
    public uint Numerator;
    public uint Denominator;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct DisplayConfigPathSourceInfo {
    public Luid AdapterId;
    public uint Id;
    public uint ModeInfoIndex;
    public uint StatusFlags;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct DisplayConfigPathTargetInfo {
    public Luid AdapterId;
    public uint Id;
    public uint ModeInfoIndex;
    public uint OutputTechnology;
    public uint Rotation;
    public uint Scaling;
    public Rational RefreshRate;
    public uint ScanLineOrdering;
    public int TargetAvailable;
    public uint StatusFlags;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct DisplayConfigPathInfo {
    public DisplayConfigPathSourceInfo Source;
    public DisplayConfigPathTargetInfo Target;
    public uint Flags;
  }

  [StructLayout(LayoutKind.Explicit, Size = 48, Pack = 4)]
  public struct DisplayConfigModeUnion { }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct DisplayConfigModeInfo {
    public uint InfoType;
    public uint Id;
    public Luid AdapterId;
    public DisplayConfigModeUnion Mode;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct DisplayConfigDeviceInfoHeader {
    public uint Type;
    public uint Size;
    public Luid AdapterId;
    public uint Id;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4, CharSet = CharSet.Unicode)]
  public struct DisplayConfigSourceDeviceName {
    public DisplayConfigDeviceInfoHeader Header;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string ViewGdiDeviceName;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4, CharSet = CharSet.Unicode)]
  public struct DisplayConfigTargetDeviceName {
    public DisplayConfigDeviceInfoHeader Header;
    public uint Flags;
    public uint OutputTechnology;
    public ushort EdidManufacturerId;
    public ushort EdidProductCodeId;
    public uint ConnectorInstance;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string MonitorFriendlyDeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string MonitorDevicePath;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4, CharSet = CharSet.Unicode)]
  public struct DisplayConfigAdapterName {
    public DisplayConfigDeviceInfoHeader Header;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string AdapterDevicePath;
  }

  public static class NativeDisplayApi {
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

    [DllImport("user32.dll")]
    public static extern int GetDisplayConfigBufferSizes(uint flags, out uint pathCount, out uint modeCount);

    [DllImport("user32.dll")]
    public static extern int QueryDisplayConfig(uint flags, ref uint pathCount, [In, Out] DisplayConfigPathInfo[] paths,
      ref uint modeCount, [In, Out] DisplayConfigModeInfo[] modes, IntPtr currentTopologyId);

    [DllImport("user32.dll")]
    public static extern int DisplayConfigGetDeviceInfo(ref DisplayConfigSourceDeviceName packet);

    [DllImport("user32.dll")]
    public static extern int DisplayConfigGetDeviceInfo(ref DisplayConfigTargetDeviceName packet);

    [DllImport("user32.dll")]
    public static extern int DisplayConfigGetDeviceInfo(ref DisplayConfigAdapterName packet);
  }

  public static class VsyncDisplayPathProbe {
    static string GetSourceName(DisplayConfigPathSourceInfo source) {
      var packet = new DisplayConfigSourceDeviceName {
        Header = new DisplayConfigDeviceInfoHeader {
          Type = 1,
          Size = (uint)Marshal.SizeOf(typeof(DisplayConfigSourceDeviceName)),
          AdapterId = source.AdapterId,
          Id = source.Id,
        },
        ViewGdiDeviceName = new string('\0', 32),
      };
      int result = NativeDisplayApi.DisplayConfigGetDeviceInfo(ref packet);
      return result == 0 ? packet.ViewGdiDeviceName.TrimEnd('\0') : $"error:{result}";
    }

    static DisplayConfigTargetDeviceName GetTargetName(DisplayConfigPathTargetInfo target) {
      var packet = new DisplayConfigTargetDeviceName {
        Header = new DisplayConfigDeviceInfoHeader {
          Type = 2,
          Size = (uint)Marshal.SizeOf(typeof(DisplayConfigTargetDeviceName)),
          AdapterId = target.AdapterId,
          Id = target.Id,
        },
        MonitorFriendlyDeviceName = new string('\0', 64),
        MonitorDevicePath = new string('\0', 128),
      };
      int result = NativeDisplayApi.DisplayConfigGetDeviceInfo(ref packet);
      if (result != 0) throw new InvalidOperationException($"DisplayConfigGetDeviceInfo(target) failed: {result}");
      return packet;
    }

    static string GetAdapterPath(Luid adapterId) {
      var packet = new DisplayConfigAdapterName {
        Header = new DisplayConfigDeviceInfoHeader {
          Type = 4,
          Size = (uint)Marshal.SizeOf(typeof(DisplayConfigAdapterName)),
          AdapterId = adapterId,
          Id = 0,
        },
        AdapterDevicePath = new string('\0', 128),
      };
      int result = NativeDisplayApi.DisplayConfigGetDeviceInfo(ref packet);
      return result == 0 ? packet.AdapterDevicePath.TrimEnd('\0') : $"error:{result}";
    }

    static DisplayConfigPathInfo[] GetActivePaths() {
      const uint OnlyActivePaths = 0x2;
      for (int attempt = 0; attempt < 3; attempt++) {
        uint pathCount;
        uint modeCount;
        int sizeResult = NativeDisplayApi.GetDisplayConfigBufferSizes(OnlyActivePaths, out pathCount, out modeCount);
        if (sizeResult != 0) throw new InvalidOperationException($"GetDisplayConfigBufferSizes failed: {sizeResult}");
        var paths = new DisplayConfigPathInfo[Math.Max(pathCount, 1)];
        var modes = new DisplayConfigModeInfo[Math.Max(modeCount, 1)];
        uint requestedPaths = pathCount;
        uint requestedModes = modeCount;
        int result = NativeDisplayApi.QueryDisplayConfig(OnlyActivePaths, ref requestedPaths, paths, ref requestedModes, modes, IntPtr.Zero);
        if (result == 122) continue;
        if (result != 0) throw new InvalidOperationException($"QueryDisplayConfig failed: {result}");
        var active = new DisplayConfigPathInfo[requestedPaths];
        Array.Copy(paths, active, requestedPaths);
        return active;
      }
      throw new InvalidOperationException("QueryDisplayConfig buffers changed repeatedly.");
    }

    public static Dictionary<string, object> Capture() {
      const uint MonitorDefaultToPrimary = 1;
      IntPtr monitor = NativeDisplayApi.MonitorFromWindow(IntPtr.Zero, MonitorDefaultToPrimary);
      var monitorInfo = new MonitorInfoEx {
        Size = (uint)Marshal.SizeOf(typeof(MonitorInfoEx)),
        DeviceName = new string('\0', 32),
      };
      if (!NativeDisplayApi.GetMonitorInfo(monitor, ref monitorInfo)) throw new InvalidOperationException("GetMonitorInfo failed.");

      IntPtr hdc = NativeDisplayApi.CreateDC(null, monitorInfo.DeviceName, null, IntPtr.Zero);
      if (hdc == IntPtr.Zero) throw new InvalidOperationException("CreateDC failed for the primary monitor.");
      OpenAdapterFromHdc opened = new OpenAdapterFromHdc { Hdc = hdc };
      bool adapterOpened = false;
      try {
        int openResult = NativeDisplayApi.OpenAdapterFromHdc(ref opened);
        if (openResult != 0) throw new InvalidOperationException($"D3DKMTOpenAdapterFromHdc failed: 0x{openResult:X8}");
        adapterOpened = true;
        var paths = GetActivePaths();
        var pathReports = new List<Dictionary<string, object>>();
        var matchedPaths = new List<Dictionary<string, object>>();
        foreach (var path in paths) {
          var targetName = GetTargetName(path.Target);
          string adapterPath = GetAdapterPath(path.Target.AdapterId);
          var report = new Dictionary<string, object> {
            ["sourceAdapterLuid"] = path.Source.AdapterId.ToString(),
            ["sourceId"] = path.Source.Id,
            ["sourceDeviceName"] = GetSourceName(path.Source),
            ["targetAdapterLuid"] = path.Target.AdapterId.ToString(),
            ["targetAdapterDevicePath"] = adapterPath,
            ["targetId"] = path.Target.Id,
            ["targetName"] = targetName.MonitorFriendlyDeviceName.TrimEnd('\0'),
            ["targetDevicePath"] = targetName.MonitorDevicePath.TrimEnd('\0'),
            ["outputTechnology"] = path.Target.OutputTechnology,
            ["refreshRate"] = new Dictionary<string, object> {
              ["numerator"] = path.Target.RefreshRate.Numerator,
              ["denominator"] = path.Target.RefreshRate.Denominator,
            },
            ["targetAvailable"] = path.Target.TargetAvailable != 0,
            ["sourceStatusFlags"] = path.Source.StatusFlags,
            ["targetStatusFlags"] = path.Target.StatusFlags,
            ["pathFlags"] = path.Flags,
          };
          pathReports.Add(report);
          if (path.Source.AdapterId.SameAs(opened.AdapterLuid) && path.Source.Id == opened.VidPnSourceId) matchedPaths.Add(report);
        }
        return new Dictionary<string, object> {
          ["primaryMonitorDeviceName"] = monitorInfo.DeviceName.TrimEnd('\0'),
          ["primaryMonitorBounds"] = new Dictionary<string, object> {
            ["left"] = monitorInfo.Monitor.Left,
            ["top"] = monitorInfo.Monitor.Top,
            ["right"] = monitorInfo.Monitor.Right,
            ["bottom"] = monitorInfo.Monitor.Bottom,
          },
          ["d3dkmtAdapterLuid"] = opened.AdapterLuid.ToString(),
          ["d3dkmtVidPnSourceId"] = opened.VidPnSourceId,
          ["matchingActivePaths"] = matchedPaths,
          ["allActivePaths"] = pathReports,
        };
      } finally {
        if (adapterOpened) {
          var close = new CloseAdapter { AdapterHandle = opened.AdapterHandle };
          NativeDisplayApi.CloseAdapter(ref close);
        }
        NativeDisplayApi.DeleteDC(hdc);
      }
    }
  }
}
'@

Add-Type -TypeDefinition $source
$report = [GitCrest.Performance.VsyncDisplayPathProbe]::Capture()
$json = $report | ConvertTo-Json -Depth 8
if ($OutputPath) {
  $json | Set-Content -LiteralPath $OutputPath -Encoding utf8
}
Write-Output $json
