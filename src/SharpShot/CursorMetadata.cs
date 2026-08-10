using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace SharpShot
{
    /// <summary>
    /// Captures the pointer as edit-time data rather than painting it into the
    /// video. Sampling happens on the recorder thread at the same timestamp as
    /// each video frame. Only compact value types are retained on the hot path;
    /// JSON serialization and disk IO happen once recording has stopped.
    /// </summary>
    internal sealed class CursorMetadataRecorder : IDisposable
    {
        private const int CursorShowing = 0x00000001;
        private const int PartsPerMillion = 1000000;
        private const int VkLeftButton = 0x01;
        private const int VkRightButton = 0x02;
        private const int VkMiddleButton = 0x04;
        private const int VkXButton1 = 0x05;
        private const int VkXButton2 = 0x06;

        private readonly Rectangle _region;
        private readonly string _finalPath;
        private readonly List<CursorMetadataSample> _samples =
            new List<CursorMetadataSample>(4096);
        private readonly List<CursorShapeDescriptor> _shapes =
            new List<CursorShapeDescriptor>(8);
        private readonly Dictionary<IntPtr, int> _shapeIds =
            new Dictionary<IntPtr, int>();
        private string _temporaryPath;
        private CursorMetadataSample _lastSample;
        private bool _hasLastSample;
        private byte _buttons;
        private int _disposed;

        internal string FinalPath { get { return _finalPath; } }
        internal int SampleCount { get { return _samples.Count; } }

        internal CursorMetadataRecorder(Rectangle region, string videoPath)
        {
            if (region.Width < 1 || region.Height < 1)
                throw new ArgumentOutOfRangeException("region");
            _region = region;
            _finalPath = GetSidecarPath(videoPath);
            if (File.Exists(_finalPath))
                throw new IOException("The cursor metadata sidecar already exists.");
        }

        internal static string GetSidecarPath(string videoPath)
        {
            if (String.IsNullOrEmpty(videoPath))
                throw new ArgumentNullException("videoPath");
            string fullPath = Path.GetFullPath(videoPath);
            string folder = Path.GetDirectoryName(fullPath);
            string stem = Path.GetFileNameWithoutExtension(fullPath);
            return Path.Combine(folder, stem + ".cursor.jsonl");
        }

        internal void Capture(long timestamp100Nanoseconds)
        {
            CursorInfo cursor = new CursorInfo();
            cursor.Size = Marshal.SizeOf(typeof(CursorInfo));
            bool available = RecordingNative.GetCursorInfo(ref cursor);
            bool visible = available &&
                           (cursor.Flags & CursorShowing) != 0 &&
                           cursor.Handle != IntPtr.Zero;

            int screenX = available ? cursor.ScreenPosition.X : 0;
            int screenY = available ? cursor.ScreenPosition.Y : 0;
            int shapeId = visible ? ResolveShape(cursor.Handle) : 0;

            byte currentButtons;
            byte pressed;
            byte released;
            byte clicked;
            ReadButtons(out currentButtons, out pressed, out released, out clicked);

            CursorMetadataSample sample = new CursorMetadataSample();
            sample.Timestamp = Math.Max(0L, timestamp100Nanoseconds);
            sample.ScreenX = screenX;
            sample.ScreenY = screenY;
            sample.NormalizedX = Normalize(screenX - _region.Left, _region.Width);
            sample.NormalizedY = Normalize(screenY - _region.Top, _region.Height);
            sample.Visible = visible;
            sample.Inside = visible && _region.Contains(screenX, screenY);
            sample.ShapeId = shapeId;
            sample.Buttons = currentButtons;
            sample.Pressed = pressed;
            sample.Released = released;
            sample.Clicked = clicked;

            AppendSample(sample);
        }

        private void AppendSample(CursorMetadataSample sample)
        {
            // Stationary spans are reconstructed by holding the last sample.
            // Event samples are never coalesced.
            if (!_hasLastSample || !sample.SameState(_lastSample) ||
                sample.Pressed != 0 || sample.Released != 0 || sample.Clicked != 0)
            {
                _samples.Add(sample);
                _lastSample = sample;
                _hasLastSample = true;
            }
        }

        internal void Prepare(long duration100Nanoseconds)
        {
            ThrowIfDisposed();
            if (_temporaryPath != null)
                throw new InvalidOperationException("Cursor metadata was already prepared.");

            // A final state makes trim boundaries deterministic even when the
            // pointer stayed still for the last part of a recording.
            if (_hasLastSample && _lastSample.Timestamp < duration100Nanoseconds)
            {
                CursorMetadataSample finalSample = _lastSample;
                finalSample.Timestamp = Math.Max(0L, duration100Nanoseconds);
                finalSample.Pressed = 0;
                finalSample.Released = 0;
                finalSample.Clicked = 0;
                _samples.Add(finalSample);
            }

            string folder = Path.GetDirectoryName(_finalPath);
            if (!String.IsNullOrEmpty(folder)) Directory.CreateDirectory(folder);
            _temporaryPath = _finalPath + ".tmp-" + Guid.NewGuid().ToString("N");
            using (FileStream file = new FileStream(
                _temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read,
                65536, FileOptions.SequentialScan))
            using (StreamWriter writer = new StreamWriter(file, new UTF8Encoding(false), 65536))
            {
                WriteHeader(writer);
                for (int index = 0; index < _shapes.Count; index++)
                    WriteShape(writer, _shapes[index]);
                for (int index = 0; index < _samples.Count; index++)
                    WriteSample(writer, _samples[index]);
                writer.Write("{\"kind\":\"end\",\"t\":");
                writer.Write(Math.Max(0L, duration100Nanoseconds).ToString(CultureInfo.InvariantCulture));
                writer.Write(",\"samples\":");
                writer.Write(_samples.Count.ToString(CultureInfo.InvariantCulture));
                writer.WriteLine("}");
            }
        }

        internal void Commit()
        {
            ThrowIfDisposed();
            if (String.IsNullOrEmpty(_temporaryPath) || !File.Exists(_temporaryPath))
                throw new InvalidOperationException("Cursor metadata was not prepared.");
            if (File.Exists(_finalPath))
                throw new IOException("The cursor metadata sidecar already exists.");
            File.Move(_temporaryPath, _finalPath);
            _temporaryPath = null;
        }

        internal void Abort()
        {
            string temporary = _temporaryPath;
            _temporaryPath = null;
            try
            {
                if (!String.IsNullOrEmpty(temporary) && File.Exists(temporary))
                    File.Delete(temporary);
            }
            catch { }
        }

        private void ReadButtons(
            out byte current,
            out byte pressed,
            out byte released,
            out byte clicked)
        {
            current = 0;
            pressed = 0;
            released = 0;
            clicked = 0;
            ReadButton(VkLeftButton, 1, ref current, ref pressed, ref released, ref clicked);
            ReadButton(VkRightButton, 2, ref current, ref pressed, ref released, ref clicked);
            ReadButton(VkMiddleButton, 4, ref current, ref pressed, ref released, ref clicked);
            ReadButton(VkXButton1, 8, ref current, ref pressed, ref released, ref clicked);
            ReadButton(VkXButton2, 16, ref current, ref pressed, ref released, ref clicked);
            _buttons = current;
        }

        private void ReadButton(
            int virtualKey,
            byte bit,
            ref byte current,
            ref byte pressed,
            ref byte released,
            ref byte clicked)
        {
            short state = RecordingNative.GetAsyncKeyState(virtualKey);
            bool isDown = (state & unchecked((short)0x8000)) != 0;
            bool wasDown = (_buttons & bit) != 0;
            bool pressedSinceSample = (state & 0x0001) != 0;

            if (isDown) current |= bit;
            if (!wasDown && isDown)
                pressed |= bit;
            else if (wasDown && !isDown)
            {
                released |= bit;
                clicked |= bit;
            }
            else if (!wasDown && !isDown && pressedSinceSample)
            {
                // A fast click can begin and end between video frames. The low
                // transition bit preserves it without installing a global hook.
                pressed |= bit;
                released |= bit;
                clicked |= bit;
            }
        }

        private int ResolveShape(IntPtr handle)
        {
            int existing;
            if (_shapeIds.TryGetValue(handle, out existing)) return existing;

            CursorShapeDescriptor descriptor = new CursorShapeDescriptor();
            descriptor.Id = _shapes.Count + 1;
            descriptor.Name = GetSystemShapeName(handle);
            descriptor.Identity = descriptor.Name == "custom"
                ? "session:" + descriptor.Id.ToString(CultureInfo.InvariantCulture)
                : "system:" + descriptor.Name;
            descriptor.HotspotX = 0;
            descriptor.HotspotY = 0;
            descriptor.Width = 0;
            descriptor.Height = 0;

            IconInfo icon;
            if (RecordingNative.GetIconInfo(handle, out icon))
            {
                try
                {
                    descriptor.HotspotX = (int)icon.HotspotX;
                    descriptor.HotspotY = (int)icon.HotspotY;
                    CursorNativeBitmap bitmap;
                    if (icon.ColorBitmap != IntPtr.Zero &&
                        CursorMetadataNative.GetObjectBitmap(
                            icon.ColorBitmap,
                            Marshal.SizeOf(typeof(CursorNativeBitmap)),
                            out bitmap) > 0)
                    {
                        descriptor.Width = Math.Abs(bitmap.Width);
                        descriptor.Height = Math.Abs(bitmap.Height);
                    }
                    else if (icon.MaskBitmap != IntPtr.Zero &&
                             CursorMetadataNative.GetObjectBitmap(
                                 icon.MaskBitmap,
                                 Marshal.SizeOf(typeof(CursorNativeBitmap)),
                                 out bitmap) > 0)
                    {
                        descriptor.Width = Math.Abs(bitmap.Width);
                        descriptor.Height = Math.Abs(bitmap.Height) / 2;
                    }
                }
                finally
                {
                    if (icon.MaskBitmap != IntPtr.Zero)
                        RecordingNative.DeleteObject(icon.MaskBitmap);
                    if (icon.ColorBitmap != IntPtr.Zero)
                        RecordingNative.DeleteObject(icon.ColorBitmap);
                }
            }

            _shapeIds.Add(handle, descriptor.Id);
            _shapes.Add(descriptor);
            return descriptor.Id;
        }

        private static string GetSystemShapeName(IntPtr handle)
        {
            int[] identifiers = new int[]
            {
                32512, 32513, 32514, 32515, 32516,
                32640, 32641, 32642, 32643, 32644, 32645, 32646,
                32648, 32649, 32650, 32651, 32671, 32672
            };
            string[] names = new string[]
            {
                "arrow", "ibeam", "wait", "cross", "up",
                "size", "icon", "size-nwse", "size-nesw", "size-we", "size-ns", "size-all",
                "not-allowed", "hand", "app-starting", "help", "pin", "person"
            };
            for (int index = 0; index < identifiers.Length; index++)
            {
                IntPtr system = RecordingNative.LoadCursor(IntPtr.Zero, new IntPtr(identifiers[index]));
                if (system == handle) return names[index];
            }
            return "custom";
        }

        private void WriteHeader(StreamWriter writer)
        {
            writer.Write("{\"kind\":\"header\",\"format\":\"sharpshot-cursor\",\"version\":1,");
            writer.Write("\"timebase\":10000000,\"coordinateSpace\":\"physical-pixels\",");
            writer.Write("\"sampling\":\"video-frame-state-change\",\"buttonBits\":");
            writer.Write("{\"left\":1,\"right\":2,\"middle\":4,\"x1\":8,\"x2\":16},");
            writer.Write("\"region\":{\"left\":");
            writer.Write(_region.Left.ToString(CultureInfo.InvariantCulture));
            writer.Write(",\"top\":");
            writer.Write(_region.Top.ToString(CultureInfo.InvariantCulture));
            writer.Write(",\"width\":");
            writer.Write(_region.Width.ToString(CultureInfo.InvariantCulture));
            writer.Write(",\"height\":");
            writer.Write(_region.Height.ToString(CultureInfo.InvariantCulture));
            writer.WriteLine("}}");
        }

        private static void WriteShape(StreamWriter writer, CursorShapeDescriptor shape)
        {
            writer.Write("{\"kind\":\"shape\",\"id\":");
            writer.Write(shape.Id.ToString(CultureInfo.InvariantCulture));
            writer.Write(",\"name\":\"");
            writer.Write(shape.Name);
            writer.Write("\",\"identity\":\"");
            writer.Write(shape.Identity);
            writer.Write("\",\"hotspot\":{\"x\":");
            writer.Write(shape.HotspotX.ToString(CultureInfo.InvariantCulture));
            writer.Write(",\"y\":");
            writer.Write(shape.HotspotY.ToString(CultureInfo.InvariantCulture));
            writer.Write("},\"size\":{\"width\":");
            writer.Write(shape.Width.ToString(CultureInfo.InvariantCulture));
            writer.Write(",\"height\":");
            writer.Write(shape.Height.ToString(CultureInfo.InvariantCulture));
            writer.WriteLine("}}");
        }

        private static void WriteSample(StreamWriter writer, CursorMetadataSample sample)
        {
            writer.Write("{\"kind\":\"sample\",\"t\":");
            writer.Write(sample.Timestamp.ToString(CultureInfo.InvariantCulture));
            writer.Write(",\"screen\":{\"x\":");
            writer.Write(sample.ScreenX.ToString(CultureInfo.InvariantCulture));
            writer.Write(",\"y\":");
            writer.Write(sample.ScreenY.ToString(CultureInfo.InvariantCulture));
            writer.Write("},\"normalized\":{\"x\":");
            WriteNormalized(writer, sample.NormalizedX);
            writer.Write(",\"y\":");
            WriteNormalized(writer, sample.NormalizedY);
            writer.Write("},\"inside\":");
            writer.Write(sample.Inside ? "true" : "false");
            writer.Write(",\"visible\":");
            writer.Write(sample.Visible ? "true" : "false");
            writer.Write(",\"shape\":");
            writer.Write(sample.ShapeId.ToString(CultureInfo.InvariantCulture));
            writer.Write(",\"buttons\":");
            writer.Write(sample.Buttons.ToString(CultureInfo.InvariantCulture));
            writer.Write(",\"down\":");
            writer.Write(sample.Pressed.ToString(CultureInfo.InvariantCulture));
            writer.Write(",\"up\":");
            writer.Write(sample.Released.ToString(CultureInfo.InvariantCulture));
            writer.Write(",\"click\":");
            writer.Write(sample.Clicked.ToString(CultureInfo.InvariantCulture));
            writer.WriteLine("}");
        }

        private static void WriteNormalized(StreamWriter writer, int partsPerMillion)
        {
            bool negative = partsPerMillion < 0;
            long absolute = Math.Abs((long)partsPerMillion);
            if (negative) writer.Write('-');
            writer.Write((absolute / PartsPerMillion).ToString(CultureInfo.InvariantCulture));
            writer.Write('.');
            writer.Write((absolute % PartsPerMillion).ToString("D6", CultureInfo.InvariantCulture));
        }

        internal static int Normalize(int relativePixel, int dimension)
        {
            if (dimension < 1) return 0;
            long scaled = (long)relativePixel * PartsPerMillion;
            long rounded = scaled >= 0
                ? (scaled + dimension / 2) / dimension
                : (scaled - dimension / 2) / dimension;
            if (rounded > Int32.MaxValue) return Int32.MaxValue;
            if (rounded < Int32.MinValue) return Int32.MinValue;
            return (int)rounded;
        }

        internal static CursorMetadataProbeResult RunProbe(
            string outputFolder,
            bool sampleLiveInput)
        {
            Directory.CreateDirectory(outputFolder);
            string videoPath = Path.Combine(outputFolder, "cursor-probe.mp4");
            string sidecarPath = GetSidecarPath(videoPath);
            if (File.Exists(sidecarPath)) File.Delete(sidecarPath);

            Rectangle region = sampleLiveInput && Screen.PrimaryScreen != null
                ? Screen.PrimaryScreen.Bounds
                : new Rectangle(-960, -540, 1920, 1080);
            CursorMetadataRecorder recorder = new CursorMetadataRecorder(region, videoPath);
            const int iterations = 10000;
            Stopwatch clock = Stopwatch.StartNew();
            for (int index = 0; index < iterations; index++)
            {
                long timestamp = index * 166667L;
                if (sampleLiveInput)
                    recorder.Capture(timestamp);
                else
                {
                    int screenX = region.Left + index % region.Width;
                    int screenY = region.Top + index % region.Height;
                    CursorMetadataSample sample = new CursorMetadataSample();
                    sample.Timestamp = timestamp;
                    sample.ScreenX = screenX;
                    sample.ScreenY = screenY;
                    sample.NormalizedX = Normalize(screenX - region.Left, region.Width);
                    sample.NormalizedY = Normalize(screenY - region.Top, region.Height);
                    sample.Visible = false;
                    sample.Inside = false;
                    sample.ShapeId = 0;
                    recorder.AppendSample(sample);
                }
            }
            clock.Stop();
            recorder.Prepare(iterations * 166667L);
            recorder.Commit();

            string[] lines = File.ReadAllLines(sidecarPath);
            if (lines.Length < 3 || lines[0].IndexOf("\"sharpshot-cursor\"") < 0 ||
                lines[lines.Length - 1].IndexOf("\"kind\":\"end\"") < 0)
                throw new InvalidDataException("Cursor metadata probe produced an invalid sidecar.");
            if (Normalize(region.Width / 2, region.Width) != 500000 ||
                Normalize(-region.Width / 2, region.Width) != -500000)
                throw new InvalidOperationException("Cursor coordinate normalization changed.");

            string resultPath = Path.Combine(outputFolder, "cursor-result.ini");
            StudioOneShot.TryWriteResult(
                resultPath, "completed", videoPath, region.Width, region.Height,
                166667L, false, null, sidecarPath);
            string expectedResult = "cursorPath64=" + Convert.ToBase64String(
                Encoding.UTF8.GetBytes(sidecarPath));
            if (Array.IndexOf(File.ReadAllLines(resultPath), expectedResult) < 0)
                throw new InvalidDataException("Studio result omitted the cursor sidecar path.");

            CursorMetadataProbeResult result = new CursorMetadataProbeResult();
            result.Iterations = iterations;
            result.SamplesWritten = recorder.SampleCount;
            result.ElapsedTicks = clock.ElapsedTicks;
            result.NanosecondsPerSample = clock.ElapsedTicks * 1000000000.0 /
                                          Stopwatch.Frequency / iterations;
            recorder.Dispose();
            return result;
        }

        private void ThrowIfDisposed()
        {
            if (_disposed != 0) throw new ObjectDisposedException(GetType().Name);
        }

        public void Dispose()
        {
            if (System.Threading.Interlocked.Exchange(ref _disposed, 1) != 0) return;
            Abort();
        }
    }

    internal struct CursorMetadataProbeResult
    {
        internal int Iterations;
        internal int SamplesWritten;
        internal long ElapsedTicks;
        internal double NanosecondsPerSample;
    }

    internal struct CursorMetadataSample
    {
        internal long Timestamp;
        internal int ScreenX;
        internal int ScreenY;
        internal int NormalizedX;
        internal int NormalizedY;
        internal bool Visible;
        internal bool Inside;
        internal int ShapeId;
        internal byte Buttons;
        internal byte Pressed;
        internal byte Released;
        internal byte Clicked;

        internal bool SameState(CursorMetadataSample other)
        {
            return ScreenX == other.ScreenX &&
                   ScreenY == other.ScreenY &&
                   NormalizedX == other.NormalizedX &&
                   NormalizedY == other.NormalizedY &&
                   Visible == other.Visible &&
                   Inside == other.Inside &&
                   ShapeId == other.ShapeId &&
                   Buttons == other.Buttons;
        }
    }

    internal struct CursorShapeDescriptor
    {
        internal int Id;
        internal string Name;
        internal string Identity;
        internal int HotspotX;
        internal int HotspotY;
        internal int Width;
        internal int Height;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct CursorNativeBitmap
    {
        internal int Type;
        internal int Width;
        internal int Height;
        internal int WidthBytes;
        internal ushort Planes;
        internal ushort BitsPixel;
        internal IntPtr Bits;
    }

    internal static class CursorMetadataNative
    {
        [DllImport("gdi32.dll", EntryPoint = "GetObjectW", ExactSpelling = true)]
        internal static extern int GetObjectBitmap(
            IntPtr value,
            int byteCount,
            out CursorNativeBitmap bitmap);
    }
}
