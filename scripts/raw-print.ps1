<#
  Sends a raw byte stream straight to a Windows printer queue via the winspool
  API (the standard "RAW" data type, bypassing the driver — exactly what an
  ESC/POS thermal printer needs). Prints "JOBID:<n>" so the caller can track it.

  Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File raw-print.ps1 `
            -PrinterName "POS-80" -Path C:\path\to\job.bin
#>
param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$Path
)
$ErrorActionPreference = "Stop"

$src = @"
using System;
using System.Runtime.InteropServices;
public static class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern int StartDocPrinter(IntPtr h, int level, ref DOCINFO di);
  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);

  public static int Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero))
      throw new Exception("OpenPrinter failed (" + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = "funprint";
      di.pDataType = "RAW";
      int job = StartDocPrinter(h, 1, ref di);
      if (job == 0) throw new Exception("StartDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");
      StartPagePrinter(h);
      int written;
      WritePrinter(h, bytes, bytes.Length, out written);
      EndPagePrinter(h);
      EndDocPrinter(h);
      return job;
    } finally {
      ClosePrinter(h);
    }
  }
}
"@

Add-Type -TypeDefinition $src -Language CSharp | Out-Null
$bytes = [System.IO.File]::ReadAllBytes($Path)
$job = [RawPrinter]::Send($PrinterName, $bytes)
Write-Output ("JOBID:" + $job)
