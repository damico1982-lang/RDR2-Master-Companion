using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using WinRT;

namespace FrontierLink;

static class GraphicsFrame
{
    static IDirect3DDevice? _device;

    public static Bitmap? TryCopy(IntPtr hwnd, int width, int height)
    {
        if (hwnd == IntPtr.Zero || width < 1 || height < 1 || !GraphicsCaptureSession.IsSupported()) return null;
        GraphicsCaptureItem? item = null;
        Direct3D11CaptureFramePool? pool = null;
        GraphicsCaptureSession? session = null;
        try
        {
            item = CreateItem(hwnd);
            var device = Device();
            pool = Direct3D11CaptureFramePool.CreateFreeThreaded(
                device,
                DirectXPixelFormat.B8G8R8A8UIntNormalized,
                2,
                item.Size);
            Bitmap? image = null;
            var finished = false;
            var gate = new object();
            var done = new ManualResetEventSlim(false);
            pool.FrameArrived += (_, _) =>
            {
                Bitmap? next = null;
                try
                {
                    using var frame = pool.TryGetNextFrame();
                    if (frame != null) next = CopySurface(frame.Surface);
                }
                catch
                {
                    next = null;
                }
                lock (gate)
                {
                    if (finished) next?.Dispose();
                    else image = next;
                    done.Set();
                }
            };
            session = pool.CreateCaptureSession(item);
            try { session.IsCursorCaptureEnabled = false; } catch { /* older builds omit the switch */ }
            session.StartCapture();
            done.Wait(TimeSpan.FromSeconds(2));
            lock (gate)
            {
                finished = true;
                return image;
            }
        }
        catch
        {
            return null;
        }
        finally
        {
            session?.Dispose();
            pool?.Dispose();
            item?.Dispose();
        }
    }

    static GraphicsCaptureItem CreateItem(IntPtr hwnd)
    {
        var className = Marshal.StringToHGlobalUni("Windows.Graphics.Capture.GraphicsCaptureItem");
        try
        {
            var factoryId = typeof(IGraphicsCaptureItemInterop).GUID;
            var hr = RoGetActivationFactory(className, ref factoryId, out var factoryPtr);
            if (hr < 0 || factoryPtr == IntPtr.Zero) throw new InvalidOperationException();
            var factory = (IGraphicsCaptureItemInterop)Marshal.GetObjectForIUnknown(factoryPtr);
            Marshal.Release(factoryPtr);
            var itemId = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
            hr = factory.CreateForWindow(hwnd, ref itemId, out var itemPtr);
            if (hr < 0 || itemPtr == IntPtr.Zero) throw new InvalidOperationException();
            return GraphicsCaptureItem.FromAbi(itemPtr);
        }
        finally
        {
            Marshal.FreeHGlobal(className);
        }
    }

    static IDirect3DDevice Device()
    {
        if (_device != null) return _device;
        const uint bgra = 0x20;
        var hr = D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, bgra, IntPtr.Zero, 0, 7, out var device, out _, out var context);
        if (hr < 0) throw new InvalidOperationException();
        var dxgiId = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
        hr = Marshal.QueryInterface(device, ref dxgiId, out var dxgi);
        if (hr < 0) throw new InvalidOperationException();
        hr = CreateDirect3D11DeviceFromDXGIDevice(dxgi, out var graphics);
        Marshal.Release(dxgi);
        if (context != IntPtr.Zero) Marshal.Release(context);
        if (device != IntPtr.Zero) Marshal.Release(device);
        if (hr < 0) throw new InvalidOperationException();
        _device = MarshalInterface<IDirect3DDevice>.FromAbi(graphics);
        return _device;
    }

    static Bitmap? CopySurface(IDirect3DSurface surface)
    {
        var software = SoftwareBitmap.CreateCopyFromSurfaceAsync(surface).AsTask().GetAwaiter().GetResult();
        using (software)
        {
            using var bgra = SoftwareBitmap.Convert(software, BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
            var width = bgra.PixelWidth;
            var height = bgra.PixelHeight;
            if (width < 1 || height < 1) return null;
            var bytes = new byte[width * height * 4];
            bgra.CopyToBuffer(bytes.AsBuffer());
            var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            var data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try
            {
                for (var y = 0; y < height; y++)
                {
                    Marshal.Copy(bytes, y * width * 4, data.Scan0 + y * data.Stride, width * 4);
                }
            }
            finally
            {
                bitmap.UnlockBits(data);
            }
            return bitmap;
        }
    }

    [ComImport]
    [Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IGraphicsCaptureItemInterop
    {
        [PreserveSig]
        int CreateForWindow(IntPtr window, ref Guid iid, out IntPtr result);
    }

    [DllImport("combase.dll")]
    static extern int RoGetActivationFactory(IntPtr classId, ref Guid iid, out IntPtr factory);

    [DllImport("d3d11.dll")]
    static extern int D3D11CreateDevice(
        IntPtr adapter,
        int driverType,
        IntPtr software,
        uint flags,
        IntPtr featureLevels,
        uint featureLevelsCount,
        uint sdkVersion,
        out IntPtr device,
        out int featureLevel,
        out IntPtr immediateContext);

    [DllImport("d3d11.dll", EntryPoint = "CreateDirect3D11DeviceFromDXGIDevice")]
    static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);
}
