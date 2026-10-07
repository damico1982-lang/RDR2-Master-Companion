using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

namespace FrontierLink;

static class GameOcr
{
    public static async Task<string> ReadAsync(Bitmap bitmap)
    {
        var engine = OcrEngine.TryCreateFromUserProfileLanguages();
        if (engine == null) return "";
        using var png = new MemoryStream();
        bitmap.Save(png, System.Drawing.Imaging.ImageFormat.Png);
        using var stream = new InMemoryRandomAccessStream();
        await stream.WriteAsync(png.ToArray().AsBuffer());
        stream.Seek(0);
        var decoder = await BitmapDecoder.CreateAsync(stream);
        using var software = await decoder.GetSoftwareBitmapAsync();
        var result = await engine.RecognizeAsync(software);
        return result?.Text ?? "";
    }
}
