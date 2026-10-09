param(
  [ValidateRange(1, 30)][int]$DurationSecondsPerInterval = 5,
  [string]$OutputPath
)

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace GitCrest.Performance {
  public static class NativeTimerApi {
    [DllImport("winmm.dll", EntryPoint = "timeBeginPeriod")]
    public static extern uint TimeBeginPeriod(uint period);
    [DllImport("winmm.dll", EntryPoint = "timeEndPeriod")]
    public static extern uint TimeEndPeriod(uint period);
  }

  public static class VsyncSleepSampler {
    static Dictionary<string, object> Sample(int sleepMs, int durationSeconds) {
      var intervalsMs = new List<double>();
      var timer = Stopwatch.StartNew();
      long previous = 0;
      while (timer.Elapsed.TotalSeconds < durationSeconds) {
        Thread.Sleep(sleepMs);
        long timestamp = Stopwatch.GetTimestamp();
        if (previous != 0) intervalsMs.Add((timestamp - previous) * 1000.0 / Stopwatch.Frequency);
        previous = timestamp;
      }
      timer.Stop();
      return new Dictionary<string, object> {
        ["sleepRequestMs"] = sleepMs,
        ["durationSecondsMeasured"] = Math.Round(timer.Elapsed.TotalSeconds, 3),
        ["sampleCount"] = intervalsMs.Count,
        ["intervalsMs"] = intervalsMs,
      };
    }

    public static object Capture(int durationSeconds) {
      uint beginResult = NativeTimerApi.TimeBeginPeriod(1);
      if (beginResult != 0) throw new InvalidOperationException($"timeBeginPeriod failed: {beginResult}");
      try {
        return new Dictionary<string, object> {
          ["timerResolutionRequestMs"] = 1,
          ["measurements"] = new[] { Sample(16, durationSeconds), Sample(17, durationSeconds) },
        };
      } finally {
        uint endResult = NativeTimerApi.TimeEndPeriod(1);
        if (endResult != 0) throw new InvalidOperationException($"timeEndPeriod failed: {endResult}");
      }
    }
  }
}
'@

Add-Type -TypeDefinition $source
$capture = [GitCrest.Performance.VsyncSleepSampler]::Capture($DurationSecondsPerInterval)
$measurements = foreach ($measurement in $capture.measurements) {
  $intervals = @($measurement["intervalsMs"] | Sort-Object)
  $summary = $null
  $observedHz = $null
  if ($intervals.Count -gt 0) {
    $summary = [ordered]@{
      min = [math]::Round($intervals[0], 3)
      p50 = [math]::Round($intervals[[math]::Floor(($intervals.Count - 1) * 0.50)], 3)
      p95 = [math]::Round($intervals[[math]::Floor(($intervals.Count - 1) * 0.95)], 3)
      max = [math]::Round($intervals[-1], 3)
    }
    $observedHz = [math]::Round($measurement["sampleCount"] / $measurement["durationSecondsMeasured"], 3)
  }
  [pscustomobject]@{
    sleepRequestMs = $measurement["sleepRequestMs"]
    durationSecondsMeasured = $measurement["durationSecondsMeasured"]
    sampleCount = $measurement["sampleCount"]
    observedHz = $observedHz
    intervalSummaryMs = $summary
  }
}
$report = [pscustomobject]@{ timerResolutionRequestMs = 1; measurements = @($measurements) }
$json = $report | ConvertTo-Json -Depth 6
if ($OutputPath) { $json | Set-Content -LiteralPath $OutputPath -Encoding utf8 }
Write-Output $json
