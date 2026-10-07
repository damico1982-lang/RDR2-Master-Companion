using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

namespace FrontierLink;

static class WindowCapture
{
    public static IntPtr FindGameWindow()
    {
        IntPtr found = IntPtr.Zero;
        var best = 0;
        EnumWindows((hwnd, _) =>
        {
            if (!IsWindowVisible(hwnd)) return true;
            var builder = new StringBuilder(512);
            GetWindowText(hwnd, builder, builder.Capacity);
            if (!CapturePolicy.IsGameWindow(builder.ToString())) return true;
            if (!GetWindowRect(hwnd, out var rect)) return true;
            var area = Math.Max(0, rect.Right - rect.Left) * Math.Max(0, rect.Bottom - rect.Top);
            if (area > best)
            {
                best = area;
                found = hwnd;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static Bitmap? CopyWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !GetWindowRect(hwnd, out var rect)) return null;
        var width = rect.Right - rect.Left;
        var height = rect.Bottom - rect.Top;
        if (width < 32 || height < 32 || width > 7680 || height > 4320) return null;
        var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        using var graphics = Graphics.FromImage(bitmap);
        var hdc = graphics.GetHdc();
        var copied = PrintWindow(hwnd, hdc, 2);
        graphics.ReleaseHdc(hdc);
        if (!copied)
        {
            bitmap.Dispose();
            return null;
        }
        return bitmap;
    }

    public static string ToJpegDataUrl(Bitmap source, int maxSide = 640)
    {
        var scale = Math.Min(1d, maxSide / (double)Math.Max(source.Width, source.Height));
        var width = Math.Max(1, (int)Math.Round(source.Width * scale));
        var height = Math.Max(1, (int)Math.Round(source.Height * scale));
        using var small = new Bitmap(width, height);
        using (var graphics = Graphics.FromImage(small)) graphics.DrawImage(source, 0, 0, width, height);
        using var stream = new MemoryStream();
        var codec = ImageCodecInfo.GetImageEncoders().First(item => item.FormatID == ImageFormat.Jpeg.Guid);
        using var parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(Encoder.Quality, 55L);
        small.Save(stream, codec, parameters);
        return "data:image/jpeg;base64," + Convert.ToBase64String(stream.ToArray());
    }

    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hWnd, out Rect lpRect);

    [DllImport("user32.dll")]
    static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

    [StructLayout(LayoutKind.Sequential)]
    struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
