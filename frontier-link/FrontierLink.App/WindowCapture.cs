using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

namespace FrontierLink;

readonly record struct GameWindow(IntPtr Handle, bool Found, bool Minimized, int Width, int Height);

readonly record struct CapturedFrame(Bitmap? Image, bool Black);

static class WindowCapture
{
    public static GameWindow FindGameWindow()
    {
        GameWindow best = default;
        var bestArea = -1;
        EnumWindows((hwnd, _) =>
        {
            if (!IsWindowVisible(hwnd) && !IsIconic(hwnd)) return true;
            var builder = new StringBuilder(512);
            GetWindowText(hwnd, builder, builder.Capacity);
            if (!CapturePolicy.IsGameWindow(builder.ToString())) return true;
            var minimized = IsIconic(hwnd);
            var bounds = Measure(hwnd);
            var width = bounds.Right - bounds.Left;
            var height = bounds.Bottom - bounds.Top;
            var area = Math.Max(0, width) * Math.Max(0, height);
            if (!minimized && width > 0 && height > 0 && area > bestArea)
            {
                bestArea = area;
                best = new GameWindow(hwnd, true, false, width, height);
            }
            else if (bestArea < 0 && !best.Found)
            {
                best = new GameWindow(hwnd, true, minimized || width <= 0 || height <= 0, width, height);
            }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    public static CapturedFrame CopyWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || IsIconic(hwnd)) return new CapturedFrame(null, false);
        var bounds = Measure(hwnd);
        var width = bounds.Right - bounds.Left;
        var height = bounds.Bottom - bounds.Top;
        if (width < 32 || height < 32 || width > 7680 || height > 4320) return new CapturedFrame(null, false);
        Bitmap? frame = null;
        var sawBlack = false;
        try
        {
            foreach (var candidate in new Bitmap?[]
            {
                GraphicsFrame.TryCopy(hwnd, width, height),
                Print(hwnd, width, height),
                BlitScreen(bounds.Left, bounds.Top, width, height)
            })
            {
                frame = candidate;
                if (frame == null) continue;
                if (!IsBlack(frame)) return new CapturedFrame(frame, false);
                sawBlack = true;
                frame.Dispose();
                frame = null;
            }
            return new CapturedFrame(null, sawBlack);
        }
        catch (ArgumentException)
        {
            frame?.Dispose();
            return new CapturedFrame(null, sawBlack);
        }
    }

    public static bool IsBlack(Bitmap bitmap)
    {
        if (bitmap.Width < 1 || bitmap.Height < 1) return true;
        var samples = new List<byte>(256);
        var stepX = Math.Max(1, bitmap.Width / 16);
        var stepY = Math.Max(1, bitmap.Height / 16);
        for (var y = 0; y < bitmap.Height; y += stepY)
        {
            for (var x = 0; x < bitmap.Width; x += stepX)
            {
                var color = bitmap.GetPixel(x, y);
                samples.Add((byte)((color.R + color.G + color.B) / 3));
            }
        }
        return CaptureWindow.IsMostlyBlack(System.Runtime.InteropServices.CollectionsMarshal.AsSpan(samples));
    }

    public static string ToJpegDataUrl(Bitmap source, int maxSide = 640)
    {
        if (source.Width < 1 || source.Height < 1) return "";
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

    static Rect Measure(IntPtr hwnd)
    {
        if (DwmGetWindowAttribute(hwnd, DwmwaExtendedFrameBounds, out var rect, Marshal.SizeOf<Rect>()) == 0
            && rect.Right > rect.Left && rect.Bottom > rect.Top)
        {
            return rect;
        }
        if (!GetWindowRect(hwnd, out rect)) return default;
        return rect;
    }

    static Bitmap? Print(IntPtr hwnd, int width, int height)
    {
        Bitmap bitmap;
        try { bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb); }
        catch (ArgumentException) { return null; }
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

    static Bitmap? BlitScreen(int left, int top, int width, int height)
    {
        var screen = GetDC(IntPtr.Zero);
        var memory = CreateCompatibleDC(screen);
        var bits = CreateCompatibleBitmap(screen, width, height);
        var previous = SelectObject(memory, bits);
        var copied = BitBlt(memory, 0, 0, width, height, screen, left, top, Srccopy);
        SelectObject(memory, previous);
        Bitmap? bitmap = null;
        if (copied) bitmap = Image.FromHbitmap(bits);
        DeleteObject(bits);
        DeleteDC(memory);
        ReleaseDC(IntPtr.Zero, screen);
        return bitmap;
    }

    const int DwmwaExtendedFrameBounds = 9;
    const int Srccopy = 0x00CC0020;

    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hWnd, out Rect lpRect);

    [DllImport("user32.dll")]
    static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern int ReleaseDC(IntPtr hWnd, IntPtr hDc);

    [DllImport("gdi32.dll")]
    static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    static extern bool DeleteDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int width, int height);

    [DllImport("gdi32.dll")]
    static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);

    [DllImport("gdi32.dll")]
    static extern bool DeleteObject(IntPtr obj);

    [DllImport("gdi32.dll")]
    static extern bool BitBlt(IntPtr hdcDest, int x, int y, int width, int height, IntPtr hdcSrc, int xSrc, int ySrc, int rop);

    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect bounds, int size);

    [StructLayout(LayoutKind.Sequential)]
    struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
