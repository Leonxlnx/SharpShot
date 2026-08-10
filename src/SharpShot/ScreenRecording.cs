using System;
using System.Collections.Specialized;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace SharpShot
{
    internal enum RecordingVideoQuality
    {
        Automatic,
        Balanced,
        High,
        Maximum
    }

    internal sealed class RecordingVideoOptions
    {
        internal readonly int RequestedFrameRate;
        internal readonly RecordingVideoQuality Quality;

        internal RecordingVideoOptions(
            int requestedFrameRate,
            RecordingVideoQuality quality)
        {
            if (requestedFrameRate != 0 && requestedFrameRate != 30 && requestedFrameRate != 60)
                throw new ArgumentOutOfRangeException(
                    "requestedFrameRate", "Recording FPS must be 30 or 60.");
            if (quality < RecordingVideoQuality.Automatic ||
                quality > RecordingVideoQuality.Maximum)
                throw new ArgumentOutOfRangeException("quality");
            RequestedFrameRate = requestedFrameRate;
            Quality = quality;
        }
    }

    internal sealed class RecordingCursorPolicy
    {
        internal readonly bool IncludeInVideo;
        internal readonly bool CaptureEditableMetadata;

        internal RecordingCursorPolicy(
            bool includeInVideo,
            bool captureEditableMetadata)
        {
            IncludeInVideo = includeInVideo;
            CaptureEditableMetadata = captureEditableMetadata;
        }
    }

    internal static class RecordingPolicy
    {
        internal const int MinimumDimension = 48;
        internal const int MaximumWidth = 4096;
        internal const int MaximumHeight = 2304;
        private const long HardwareEncoderPixelThreshold = 640L * 360L;

        internal static Rectangle NormalizeSelection(Rectangle selection, Rectangle bounds)
        {
            Rectangle clipped = Rectangle.Intersect(selection, bounds);
            if (clipped.Width < MinimumDimension || clipped.Height < MinimumDimension)
                return Rectangle.Empty;

            return clipped;
        }

        internal static Size GetOutputSize(int sourceWidth, int sourceHeight)
        {
            if (sourceWidth < 1 || sourceHeight < 1) return Size.Empty;

            int width;
            int height;
            if (sourceWidth <= MaximumWidth && sourceHeight <= MaximumHeight)
            {
                width = sourceWidth & ~1;
                height = sourceHeight & ~1;
            }
            else if ((long)MaximumWidth * sourceHeight <=
                     (long)MaximumHeight * sourceWidth)
            {
                width = MaximumWidth & ~1;
                height = (int)Math.Min(Int32.MaxValue,
                    (long)sourceHeight * width / sourceWidth) & ~1;
            }
            else
            {
                height = MaximumHeight & ~1;
                width = (int)Math.Min(Int32.MaxValue,
                    (long)sourceWidth * height / sourceHeight) & ~1;
            }
            if (width < MinimumDimension || height < MinimumDimension)
                return Size.Empty;
            return new Size(width, height);
        }

        internal static int GetFrameRate(int width, int height)
        {
            long pixels = (long)Math.Max(1, width) * Math.Max(1, height);
            return pixels <= 1280L * 720L ? 60 : 30;
        }

        internal static int ResolveFrameRate(
            int width,
            int height,
            RecordingVideoOptions options)
        {
            return options != null && options.RequestedFrameRate != 0
                ? options.RequestedFrameRate
                : GetFrameRate(width, height);
        }

        internal static int GetBitRate(int width, int height, int framesPerSecond)
        {
            long calculated = (long)Math.Max(1, width) * Math.Max(1, height) *
                              Math.Max(1, framesPerSecond) * 14L / 100L;
            return (int)Math.Max(4000000L, Math.Min(50000000L, calculated));
        }

        internal static int GetBitRate(
            int width,
            int height,
            int framesPerSecond,
            RecordingVideoOptions options)
        {
            int balanced = GetBitRate(width, height, framesPerSecond);
            RecordingVideoQuality quality = options == null
                ? RecordingVideoQuality.Automatic
                : options.Quality;
            long scaled;
            switch (quality)
            {
                case RecordingVideoQuality.High:
                    scaled = balanced * 3L / 2L;
                    break;
                case RecordingVideoQuality.Maximum:
                    scaled = balanced * 2L;
                    break;
                default:
                    scaled = balanced;
                    break;
            }
            return (int)Math.Min(50000000L, scaled);
        }

        internal static bool PreferHardwareEncoder(int width, int height)
        {
            return (long)Math.Max(1, width) * Math.Max(1, height) >=
                   HardwareEncoderPixelThreshold;
        }

        internal static string GetSelectionLabel(Rectangle selection, Rectangle bounds)
        {
            Rectangle normalized = NormalizeSelection(selection, bounds);
            if (normalized.IsEmpty)
                return selection.Width + " \u00D7 " + selection.Height + " px  \u00B7  minimum 48 \u00D7 48";
            Size output = GetOutputSize(normalized.Width, normalized.Height);
            if (output.IsEmpty)
                return normalized.Width + " \u00D7 " + normalized.Height +
                       " px  \u00B7  aspect ratio is not H.264 compatible";
            int fps = GetFrameRate(output.Width, output.Height);
            string dimensions = normalized.Width + " \u00D7 " + normalized.Height + " px";
            if (output.Width != normalized.Width || output.Height != normalized.Height)
                dimensions += "  \u2192  " + output.Width + " \u00D7 " + output.Height;
            return dimensions + "  \u00B7  " + fps + " FPS  \u00B7  H.264";
        }
    }

    internal sealed class RecordingFilePaths
    {
        internal readonly string PartialPath;
        internal readonly string FinalPath;

        internal RecordingFilePaths(string partialPath, string finalPath)
        {
            PartialPath = partialPath;
            FinalPath = finalPath;
        }
    }

    internal static class RecordingStorage
    {
        internal static RecordingFilePaths Reserve(Rectangle region)
        {
            string folder = ScreenshotStorage.GetFolder();
            Directory.CreateDirectory(folder);
            string stem = "Recording " + DateTime.Now.ToString("yyyy-MM-dd 'at' HH.mm.ss") +
                          " - " + region.Width + "x" + region.Height;
            string selectedStem = stem;
            string finalPath = Path.Combine(folder, selectedStem + ".mp4");
            string partialPath = Path.Combine(folder, selectedStem + ".partial.mp4");
            int suffix = 2;
            while (File.Exists(finalPath) || File.Exists(partialPath))
            {
                selectedStem = stem + " (" + suffix + ")";
                finalPath = Path.Combine(folder, selectedStem + ".mp4");
                partialPath = Path.Combine(folder, selectedStem + ".partial.mp4");
                suffix++;
            }
            return new RecordingFilePaths(partialPath, finalPath);
        }

        internal static void Commit(RecordingFilePaths paths)
        {
            if (!File.Exists(paths.PartialPath))
                throw new FileNotFoundException("The completed recording file is missing.", paths.PartialPath);
            File.Move(paths.PartialPath, paths.FinalPath);
        }

        internal static void DeletePartial(RecordingFilePaths paths)
        {
            try
            {
                if (paths != null && File.Exists(paths.PartialPath))
                    File.Delete(paths.PartialPath);
            }
            catch { }
        }
    }

    internal static class OptionalRecordingArtifact
    {
        internal static bool Try(Action action)
        {
            try
            {
                action();
                return true;
            }
            catch
            {
                return false;
            }
        }
    }

    internal sealed class RecordingResult
    {
        internal string Path;
        internal Exception Error;
        internal TimeSpan Duration;
        internal int SourceWidth;
        internal int SourceHeight;
        internal int Width;
        internal int Height;
        internal int TargetFramesPerSecond;
        internal int FramesCaptured;
        internal int FramesDropped;
        internal int BitRate;
        internal string CursorMetadataPath;
        internal string SystemAudioPath;
        internal string MicrophonePath;

        internal bool Succeeded { get { return Error == null && !String.IsNullOrEmpty(Path); } }
    }

    internal sealed class RecordingCompletedEventArgs : EventArgs
    {
        internal readonly RecordingResult Result;

        internal RecordingCompletedEventArgs(RecordingResult result)
        {
            Result = result;
        }
    }

    internal sealed class ScreenRecorderSession : IDisposable
    {
        private readonly Rectangle _region;
        private readonly Size _outputSize;
        private readonly RecordingFilePaths _paths;
        private readonly RecordingCursorPolicy _cursorPolicy;
        private readonly AudioCaptureOptions _audioOptions;
        private readonly RecordingVideoOptions _videoOptions;
        private readonly ManualResetEvent _stop = new ManualResetEvent(false);
        private Thread _thread;
        private int _disposed;

        internal event EventHandler Started;
        internal event EventHandler<RecordingCompletedEventArgs> Completed;

        internal ScreenRecorderSession(Rectangle region, RecordingFilePaths paths)
            : this(region, paths, true, false, null, null)
        {
        }

        internal ScreenRecorderSession(
            Rectangle region,
            RecordingFilePaths paths,
            bool captureEditableCursor)
            : this(
                region, paths, !captureEditableCursor, captureEditableCursor,
                null, null)
        {
        }

        internal ScreenRecorderSession(
            Rectangle region,
            RecordingFilePaths paths,
            bool captureEditableCursor,
            AudioCaptureOptions audioOptions)
            : this(
                region, paths, !captureEditableCursor, captureEditableCursor,
                audioOptions, null)
        {
        }

        internal ScreenRecorderSession(
            Rectangle region,
            RecordingFilePaths paths,
            bool captureEditableCursor,
            AudioCaptureOptions audioOptions,
            RecordingVideoOptions videoOptions)
            : this(
                region, paths, !captureEditableCursor, captureEditableCursor,
                audioOptions, videoOptions)
        {
        }

        internal ScreenRecorderSession(
            Rectangle region,
            RecordingFilePaths paths,
            bool includeCursorInVideo,
            bool captureEditableCursor,
            AudioCaptureOptions audioOptions,
            RecordingVideoOptions videoOptions)
        {
            _region = region;
            _outputSize = RecordingPolicy.GetOutputSize(region.Width, region.Height);
            if (_outputSize.IsEmpty)
                throw new InvalidOperationException(
                    "The selected area's aspect ratio cannot be encoded safely as H.264.");
            _paths = paths;
            _cursorPolicy = new RecordingCursorPolicy(
                includeCursorInVideo, captureEditableCursor);
            _audioOptions = audioOptions;
            _videoOptions = videoOptions;
        }

        internal void Start()
        {
            if (_thread != null) throw new InvalidOperationException("Recording has already started.");
            _thread = new Thread(Run);
            _thread.Name = "SharpShot video recorder";
            _thread.IsBackground = true;
            _thread.SetApartmentState(ApartmentState.MTA);
            _thread.Start();
        }

        internal void RequestStop()
        {
            _stop.Set();
        }

        private void Run()
        {
            RecordingResult result = new RecordingResult();
            result.SourceWidth = _region.Width;
            result.SourceHeight = _region.Height;
            result.Width = _outputSize.Width;
            result.Height = _outputSize.Height;
            result.TargetFramesPerSecond = RecordingPolicy.ResolveFrameRate(
                _outputSize.Width, _outputSize.Height, _videoOptions);
            result.BitRate = RecordingPolicy.GetBitRate(
                _outputSize.Width, _outputSize.Height,
                result.TargetFramesPerSecond, _videoOptions);

            bool comInitialized = false;
            bool timerResolutionRaised = false;
            bool backgroundMode = false;
            FramePacer pacer = null;
            CursorMetadataRecorder cursorMetadata = null;
            AudioCaptureGroup audioCapture = null;
            Stopwatch clock = new Stopwatch();
            try
            {
                int comResult = RecordingNative.CoInitializeEx(IntPtr.Zero, 0);
                if (comResult < 0)
                    throw new COMException("COM initialization failed.", comResult);
                comInitialized = true;
                backgroundMode = RecordingThreadPriority.Begin();

                pacer = new FramePacer(_stop);
                if (!pacer.UsesHighResolutionTimer)
                    timerResolutionRaised = RecordingNative.timeBeginPeriod(1) == 0;

                if (_cursorPolicy.CaptureEditableMetadata)
                {
                    CursorMetadataRecorder candidate = null;
                    if (OptionalRecordingArtifact.Try(delegate
                    {
                        candidate = new CursorMetadataRecorder(_region, _paths.FinalPath);
                    }))
                        cursorMetadata = candidate;
                }

                using (IRecordingFrameGrabber grabber = RecordingFrameGrabber.Create(
                    _region, _outputSize, _cursorPolicy.IncludeInVideo))
                using (MediaFoundationVideoWriter writer = new MediaFoundationVideoWriter(
                    _paths.PartialPath,
                    _outputSize.Width,
                    _outputSize.Height,
                    result.TargetFramesPerSecond,
                    result.BitRate,
                    (grabber as AdaptiveRecordingFrameGrabber) == null
                        ? IntPtr.Zero
                        : ((AdaptiveRecordingFrameGrabber)grabber).D3dDevice))
                {
                    if (_audioOptions != null && _audioOptions.HasAny)
                    {
                        RecordingAudioPaths audioPaths = RecordingAudioPaths.ForVideo(
                            _paths.FinalPath, _audioOptions);
                        audioCapture = new AudioCaptureGroup(_audioOptions, audioPaths);
                        audioCapture.Prepare();
                    }

                    EventHandler started = Started;
                    if (started != null) started(this, EventArgs.Empty);

                    if (audioCapture != null) audioCapture.Start();
                    long recordingStart100Nanoseconds = audioCapture == null
                        ? 0
                        : AudioTime.Monotonic100Nanoseconds();
                    clock.Start();
                    if (audioCapture != null)
                        audioCapture.AlignTimeline(recordingStart100Nanoseconds);
                    long frameIndex = 0;
                    long encodedDuration100Nanoseconds = 0;
                    long stopwatchFrequency = Stopwatch.Frequency;
                    int fps = result.TargetFramesPerSecond;

                    while (true)
                    {
                        if (audioCapture != null) audioCapture.ThrowIfFailed();
                        if (frameIndex > 0)
                        {
                            long targetTicks = frameIndex * stopwatchFrequency / fps;
                            if (!pacer.WaitUntil(clock, targetTicks) && result.FramesCaptured > 0)
                                break;
                        }

                        long elapsedFrame = clock.ElapsedTicks * fps / stopwatchFrequency;
                        if (elapsedFrame > frameIndex)
                        {
                            long skipped = elapsedFrame - frameIndex;
                            result.FramesDropped += skipped > Int32.MaxValue
                                ? Int32.MaxValue
                                : (int)skipped;
                            frameIndex = elapsedFrame;
                        }

                        long sampleTime = frameIndex * 10000000L / fps;
                        long nextSampleTime = (frameIndex + 1L) * 10000000L / fps;
                        if (cursorMetadata != null)
                        {
                            CursorMetadataRecorder current = cursorMetadata;
                            if (!OptionalRecordingArtifact.Try(delegate
                            {
                                current.Capture(sampleTime);
                            }))
                            {
                                current.Dispose();
                                cursorMetadata = null;
                            }
                        }
                        if (RecordingFrameSubmitter.Write(
                            writer, grabber, sampleTime, nextSampleTime - sampleTime))
                        {
                            result.FramesCaptured++;
                            encodedDuration100Nanoseconds = nextSampleTime;
                        }
                        else
                            result.FramesDropped++;
                        frameIndex++;

                        if (_stop.WaitOne(0) && result.FramesCaptured > 0)
                            break;
                    }

                    clock.Stop();
                    if (audioCapture != null)
                    {
                        TimeSpan encodedDuration = encodedDuration100Nanoseconds > 0
                            ? TimeSpan.FromTicks(encodedDuration100Nanoseconds)
                            : clock.Elapsed;
                        audioCapture.Complete(encodedDuration);
                    }
                    writer.FinalizeFile();
                }

                if (cursorMetadata != null)
                {
                    long duration = clock.ElapsedTicks * 10000000L / Stopwatch.Frequency;
                    CursorMetadataRecorder current = cursorMetadata;
                    if (!OptionalRecordingArtifact.Try(delegate
                    {
                        current.Prepare(duration);
                    }))
                    {
                        current.Dispose();
                        cursorMetadata = null;
                    }
                }
                if (audioCapture != null)
                {
                    audioCapture.Commit();
                    result.SystemAudioPath = audioCapture.SystemAudioPath;
                    result.MicrophonePath = audioCapture.MicrophonePath;
                }
                RecordingStorage.Commit(_paths);
                if (cursorMetadata != null)
                {
                    CursorMetadataRecorder current = cursorMetadata;
                    if (OptionalRecordingArtifact.Try(current.Commit))
                        result.CursorMetadataPath = current.FinalPath;
                    else
                    {
                        current.Dispose();
                        cursorMetadata = null;
                    }
                }
                result.Path = _paths.FinalPath;
                result.Duration = clock.Elapsed;
            }
            catch (Exception ex)
            {
                result.Error = ex;
                result.Duration = clock.Elapsed;
                if (audioCapture != null) audioCapture.DeleteArtifacts();
                RecordingStorage.DeletePartial(_paths);
            }
            finally
            {
                if (audioCapture != null) audioCapture.Dispose();
                if (cursorMetadata != null) cursorMetadata.Dispose();
                if (timerResolutionRaised) RecordingNative.timeEndPeriod(1);
                if (pacer != null) pacer.Dispose();
                if (backgroundMode) RecordingThreadPriority.End();
                if (comInitialized) RecordingNative.CoUninitialize();
            }

            EventHandler<RecordingCompletedEventArgs> completed = Completed;
            if (completed != null) completed(this, new RecordingCompletedEventArgs(result));
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
            _stop.Set();
            Thread thread = _thread;
            bool threadFinished = thread == null || !thread.IsAlive;
            if (!threadFinished && thread != Thread.CurrentThread)
                threadFinished = thread.Join(5000);
            // If shutdown catches an encoder inside a slow frame/finalize call,
            // keep this one kernel handle alive until process exit instead of
            // invalidating a wait handle the worker may still touch.
            if (threadFinished)
                _stop.Dispose();
        }
    }

    internal sealed class FramePacer : IDisposable
    {
        private const uint CreateWaitableTimerHighResolution = 0x00000002;
        private const uint TimerModifyState = 0x0002;
        private const uint Synchronize = 0x00100000;
        private const uint WaitObject0 = 0;
        private const uint WaitFailed = 0xFFFFFFFF;
        private const uint Infinite = 0xFFFFFFFF;

        private readonly ManualResetEvent _stop;
        private readonly IntPtr[] _waitHandles;
        private IntPtr _timer;

        internal bool UsesHighResolutionTimer { get; private set; }

        internal FramePacer(ManualResetEvent stop)
        {
            _stop = stop;
            _timer = RecordingNative.CreateWaitableTimerEx(
                IntPtr.Zero,
                null,
                CreateWaitableTimerHighResolution,
                TimerModifyState | Synchronize);
            UsesHighResolutionTimer = _timer != IntPtr.Zero;
            if (_timer == IntPtr.Zero)
            {
                _timer = RecordingNative.CreateWaitableTimerEx(
                    IntPtr.Zero,
                    null,
                    0,
                    TimerModifyState | Synchronize);
            }
            if (_timer != IntPtr.Zero)
            {
                _waitHandles = new IntPtr[]
                {
                    stop.SafeWaitHandle.DangerousGetHandle(),
                    _timer
                };
            }
        }

        internal bool WaitUntil(Stopwatch clock, long targetTicks)
        {
            long remaining = targetTicks - clock.ElapsedTicks;
            if (remaining <= 0) return true;

            if (_timer != IntPtr.Zero)
            {
                long dueTime = -Math.Max(1L,
                    (remaining * 10000000L + Stopwatch.Frequency - 1L) /
                    Stopwatch.Frequency);
                if (!RecordingNative.SetWaitableTimerEx(
                    _timer, ref dueTime, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Frame timer could not be armed.");
                uint wait = RecordingNative.WaitForMultipleObjects(
                    2, _waitHandles, false, Infinite);
                if (wait == WaitObject0) return false;
                if (wait == WaitObject0 + 1) return true;
                if (wait == WaitFailed)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Frame timer wait failed.");
                throw new InvalidOperationException("Frame timer returned an unexpected wait state.");
            }

            return WaitFallback(clock, targetTicks);
        }

        private bool WaitFallback(Stopwatch clock, long targetTicks)
        {
            while (true)
            {
                long remaining = targetTicks - clock.ElapsedTicks;
                if (remaining <= 0) return true;
                double remainingMilliseconds = remaining * 1000.0 / Stopwatch.Frequency;
                if (remainingMilliseconds > 2.0)
                {
                    int wait = Math.Max(1, (int)Math.Floor(remainingMilliseconds - 1.0));
                    if (_stop.WaitOne(wait)) return false;
                }
                else
                {
                    Thread.SpinWait(64);
                }
            }
        }

        public void Dispose()
        {
            if (_timer == IntPtr.Zero) return;
            RecordingNative.CloseHandle(_timer);
            _timer = IntPtr.Zero;
        }
    }

    internal interface IRecordingFrameGrabber : IDisposable
    {
        IntPtr Pixels { get; }
        int ByteCount { get; }
        void Capture();
    }

    internal sealed class GdiFrameGrabber : IRecordingFrameGrabber
    {
        private const int SourceCopy = 0x00CC0020;
        private const int CaptureBlt = unchecked((int)0x40000000);
        private const int StretchModeHalftone = 4;
        private const int DibRgbColors = 0;
        private const int CursorShowing = 0x00000001;
        private const int DrawIconNormal = 0x0003;

        private readonly Rectangle _region;
        private readonly Size _outputSize;
        private readonly bool _includeCursor;
        private IntPtr _screenDc;
        private IntPtr _memoryDc;
        private IntPtr _bitmap;
        private IntPtr _previousBitmap;
        private IntPtr _pixels;
        private IntPtr _lastCursor;
        private Point _cursorHotspot;
        private Size _cursorSize;

        internal IntPtr Pixels { get { return _pixels; } }
        internal int ByteCount { get { return checked(_outputSize.Width * _outputSize.Height * 4); } }
        IntPtr IRecordingFrameGrabber.Pixels { get { return Pixels; } }
        int IRecordingFrameGrabber.ByteCount { get { return ByteCount; } }

        internal GdiFrameGrabber(Rectangle region)
            : this(region, region.Size, true)
        {
        }

        internal GdiFrameGrabber(Rectangle region, bool includeCursor)
            : this(region, region.Size, includeCursor)
        {
        }

        internal GdiFrameGrabber(
            Rectangle region,
            Size outputSize,
            bool includeCursor)
        {
            _region = region;
            _outputSize = outputSize;
            _includeCursor = includeCursor;
            if (region.Width < 1 || region.Height < 1 ||
                outputSize.Width < 1 || outputSize.Height < 1)
                throw new ArgumentOutOfRangeException("region");
            try
            {
                _screenDc = RecordingNative.GetDC(IntPtr.Zero);
                if (_screenDc == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

                _memoryDc = RecordingNative.CreateCompatibleDC(_screenDc);
                if (_memoryDc == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

                BitmapInfo info = new BitmapInfo();
                info.Header.Size = Marshal.SizeOf(typeof(BitmapInfoHeader));
                info.Header.Width = outputSize.Width;
                info.Header.Height = -outputSize.Height;
                info.Header.Planes = 1;
                info.Header.BitCount = 32;
                info.Header.Compression = 0;
                _bitmap = RecordingNative.CreateDIBSection(
                    _screenDc, ref info, DibRgbColors, out _pixels, IntPtr.Zero, 0);
                if (_bitmap == IntPtr.Zero || _pixels == IntPtr.Zero)
                    throw new Win32Exception(Marshal.GetLastWin32Error());

                _previousBitmap = RecordingNative.SelectObject(_memoryDc, _bitmap);
                if (_previousBitmap == IntPtr.Zero || _previousBitmap == new IntPtr(-1))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (IsScaled && RecordingNative.SetStretchBltMode(
                        _memoryDc, StretchModeHalftone) == 0)
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                Point previousBrushOrigin;
                if (IsScaled && !RecordingNative.SetBrushOrgEx(
                        _memoryDc, 0, 0, out previousBrushOrigin))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        internal void Capture()
        {
            bool captured = IsScaled
                ? RecordingNative.StretchBlt(
                    _memoryDc,
                    0,
                    0,
                    _outputSize.Width,
                    _outputSize.Height,
                    _screenDc,
                    _region.Left,
                    _region.Top,
                    _region.Width,
                    _region.Height,
                    SourceCopy | CaptureBlt)
                : RecordingNative.BitBlt(
                    _memoryDc,
                    0,
                    0,
                    _outputSize.Width,
                    _outputSize.Height,
                    _screenDc,
                    _region.Left,
                    _region.Top,
                    SourceCopy | CaptureBlt);
            if (!captured)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Desktop frame capture failed.");
            if (_includeCursor) DrawCursor();
        }

        void IRecordingFrameGrabber.Capture()
        {
            Capture();
        }

        private void DrawCursor()
        {
            CursorInfo cursor = new CursorInfo();
            cursor.Size = Marshal.SizeOf(typeof(CursorInfo));
            if (!RecordingNative.GetCursorInfo(ref cursor) ||
                (cursor.Flags & CursorShowing) == 0 || cursor.Handle == IntPtr.Zero)
                return;

            if (cursor.Handle != _lastCursor)
            {
                UpdateCursorMetrics(cursor.Handle);
            }

            int x = cursor.ScreenPosition.X - _region.Left - _cursorHotspot.X;
            int y = cursor.ScreenPosition.Y - _region.Top - _cursorHotspot.Y;
            int width = 0;
            int height = 0;
            if (IsScaled)
            {
                x = ScaleCoordinate(x, _region.Width, _outputSize.Width);
                y = ScaleCoordinate(y, _region.Height, _outputSize.Height);
                width = ScaleLength(_cursorSize.Width, _region.Width, _outputSize.Width);
                height = ScaleLength(_cursorSize.Height, _region.Height, _outputSize.Height);
            }
            RecordingNative.DrawIconEx(
                _memoryDc, x, y, cursor.Handle, width, height,
                0, IntPtr.Zero, DrawIconNormal);
        }

        private bool IsScaled
        {
            get
            {
                return _region.Width != _outputSize.Width ||
                       _region.Height != _outputSize.Height;
            }
        }

        private static int ScaleCoordinate(int value, int sourceLength, int outputLength)
        {
            return (int)((long)value * outputLength / sourceLength);
        }

        private static int ScaleLength(int value, int sourceLength, int outputLength)
        {
            if (value < 1) return 0;
            return Math.Max(1, (int)(((long)value * outputLength + sourceLength - 1) /
                                     sourceLength));
        }

        private void UpdateCursorMetrics(IntPtr cursorHandle)
        {
            _cursorHotspot = Point.Empty;
            _cursorSize = Size.Empty;
            IconInfo icon;
            if (RecordingNative.GetIconInfo(cursorHandle, out icon))
            {
                try
                {
                    _cursorHotspot = new Point((int)icon.HotspotX, (int)icon.HotspotY);
                    NativeBitmap bitmap;
                    if (icon.ColorBitmap != IntPtr.Zero &&
                        GetObjectBitmap(icon.ColorBitmap, Marshal.SizeOf(typeof(NativeBitmap)),
                            out bitmap) > 0)
                    {
                        _cursorSize = new Size(Math.Abs(bitmap.Width), Math.Abs(bitmap.Height));
                    }
                    else if (icon.MaskBitmap != IntPtr.Zero &&
                             GetObjectBitmap(icon.MaskBitmap, Marshal.SizeOf(typeof(NativeBitmap)),
                                 out bitmap) > 0)
                    {
                        _cursorSize = new Size(
                            Math.Abs(bitmap.Width), Math.Abs(bitmap.Height) / 2);
                    }
                }
                finally
                {
                    if (icon.MaskBitmap != IntPtr.Zero) RecordingNative.DeleteObject(icon.MaskBitmap);
                    if (icon.ColorBitmap != IntPtr.Zero) RecordingNative.DeleteObject(icon.ColorBitmap);
                }
            }
            _lastCursor = cursorHandle;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeBitmap
        {
            internal int Type;
            internal int Width;
            internal int Height;
            internal int WidthBytes;
            internal ushort Planes;
            internal ushort BitsPixel;
            internal IntPtr Bits;
        }

        [DllImport("gdi32.dll", EntryPoint = "GetObjectW", ExactSpelling = true)]
        private static extern int GetObjectBitmap(
            IntPtr value,
            int byteCount,
            out NativeBitmap bitmap);

        public void Dispose()
        {
            if (_memoryDc != IntPtr.Zero && _previousBitmap != IntPtr.Zero &&
                _previousBitmap != new IntPtr(-1))
                RecordingNative.SelectObject(_memoryDc, _previousBitmap);
            if (_bitmap != IntPtr.Zero) RecordingNative.DeleteObject(_bitmap);
            if (_memoryDc != IntPtr.Zero) RecordingNative.DeleteDC(_memoryDc);
            if (_screenDc != IntPtr.Zero) RecordingNative.ReleaseDC(IntPtr.Zero, _screenDc);
            _previousBitmap = IntPtr.Zero;
            _bitmap = IntPtr.Zero;
            _memoryDc = IntPtr.Zero;
            _screenDc = IntPtr.Zero;
            _pixels = IntPtr.Zero;
        }
    }

    internal static class MediaFoundationRuntime
    {
        private const int MfVersion = 0x00020070;
        private static readonly object Sync = new object();
        private static bool _started;
        private static bool _exitHooked;

        internal static void EnsureStarted()
        {
            lock (Sync)
            {
                if (_started) return;
                int result = RecordingNative.MFStartup(MfVersion, 0);
                if (result < 0)
                    throw new COMException(
                        "MFStartup failed (0x" + result.ToString("X8") + ").", result);
                _started = true;
                if (!_exitHooked)
                {
                    AppDomain.CurrentDomain.ProcessExit += delegate { Shutdown(); };
                    _exitHooked = true;
                }
            }
        }

        private static void Shutdown()
        {
            lock (Sync)
            {
                if (!_started) return;
                RecordingNative.MFShutdown();
                _started = false;
            }
        }
    }

    internal sealed partial class MediaFoundationVideoWriter : IDisposable
    {
        private IMfAttributes _writerAttributes;
        private IMfMediaType _outputType;
        private IMfMediaType _inputType;
        private IMfSinkWriter _writer;
        private IMfDxgiDeviceManager _dxgiManager;
        private IntPtr _d3dDevice;
        private IntPtr _d3dContext;
        private int _streamIndex;
        private bool _finalized;

        internal MediaFoundationVideoWriter(
            string path,
            int width,
            int height,
            int framesPerSecond,
            int bitRate)
            : this(path, width, height, framesPerSecond, bitRate, IntPtr.Zero)
        {
        }

        internal MediaFoundationVideoWriter(
            string path,
            int width,
            int height,
            int framesPerSecond,
            int bitRate,
            IntPtr sharedD3dDevice)
        {
            _surfaceByteCount = checked(width * height * 4);
            MediaFoundationRuntime.EnsureStarted();
            try
            {
                bool preferredHardware = RecordingPolicy.PreferHardwareEncoder(width, height);
                COMException lastError = null;
                for (int encoderChoice = 0; encoderChoice < 2; encoderChoice++)
                {
                    bool useHardware = encoderChoice == 0
                        ? preferredHardware
                        : !preferredHardware;
                    for (int profileChoice = 0; profileChoice < 2; profileChoice++)
                    {
                        try
                        {
                            Initialize(path, width, height, framesPerSecond, bitRate,
                                profileChoice == 0, useHardware, sharedD3dDevice);
                            return;
                        }
                        catch (COMException ex)
                        {
                            lastError = ex;
                            ReleaseWriterObjects();
                            try { if (File.Exists(path)) File.Delete(path); }
                            catch { }
                        }
                    }
                }
                throw lastError ?? new COMException("Windows did not provide an H.264 encoder.");
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        private void Initialize(
            string path,
            int width,
            int height,
            int framesPerSecond,
            int bitRate,
            bool highProfile,
            bool useHardware,
            IntPtr sharedD3dDevice)
        {
            MfCheck(RecordingNative.MFCreateAttributes(out _writerAttributes, 3),
                "MFCreateAttributes");
            if (useHardware)
            {
                _supportsGpuSurfaceInput = sharedD3dDevice != IntPtr.Zero &&
                    TryAttachSharedDxgiManager(_writerAttributes, sharedD3dDevice);
                if (!_supportsGpuSurfaceInput)
                    TryAttachDxgiManager(_writerAttributes);
            }
            MfSetUInt32(_writerAttributes, MfGuids.ReadWriteEnableHardwareTransforms,
                useHardware ? 1 : 0);
            MfSetUInt32(_writerAttributes, MfGuids.LowLatency, 1);
            MfSetGuid(_writerAttributes, MfGuids.TranscodeContainerType,
                MfGuids.TranscodeContainerTypeMpeg4);

            MfCheck(RecordingNative.MFCreateSinkWriterFromURL(
                path, IntPtr.Zero, _writerAttributes, out _writer),
                "MFCreateSinkWriterFromURL");

            MfCheck(RecordingNative.MFCreateMediaType(out _outputType),
                "MFCreateMediaType(output)");
            MfSetGuid(_outputType, MfGuids.MajorType, MfGuids.MediaTypeVideo);
            MfSetGuid(_outputType, MfGuids.Subtype, MfGuids.VideoFormatH264);
            MfSetUInt32(_outputType, MfGuids.AverageBitRate, bitRate);
            MfSetUInt32(_outputType, MfGuids.InterlaceMode, 2);
            MfSetUInt32(_outputType, MfGuids.Mpeg2Profile, highProfile ? 100 : 77);
            MfSetUInt32(_outputType, MfGuids.MaximumKeyFrameSpacing, framesPerSecond * 2);
            MfSetRatio(_outputType, MfGuids.FrameSize, width, height);
            MfSetRatio(_outputType, MfGuids.FrameRate, framesPerSecond, 1);
            MfSetRatio(_outputType, MfGuids.PixelAspectRatio, 1, 1);
            MfCheck(_writer.AddStream(_outputType, out _streamIndex),
                "IMFSinkWriter.AddStream");

            MfCheck(RecordingNative.MFCreateMediaType(out _inputType),
                "MFCreateMediaType(input)");
            MfSetGuid(_inputType, MfGuids.MajorType, MfGuids.MediaTypeVideo);
            MfSetGuid(_inputType, MfGuids.Subtype, _supportsGpuSurfaceInput
                ? MfGuids.VideoFormatArgb32
                : MfGuids.VideoFormatRgb32);
            MfSetUInt32(_inputType, MfGuids.InterlaceMode, 2);
            MfSetUInt32(_inputType, MfGuids.FixedSizeSamples, 1);
            MfSetUInt32(_inputType, MfGuids.SampleSize, checked(width * height * 4));
            MfSetUInt32(_inputType, MfGuids.DefaultStride, checked(width * 4));
            MfSetRatio(_inputType, MfGuids.FrameSize, width, height);
            MfSetRatio(_inputType, MfGuids.FrameRate, framesPerSecond, 1);
            MfSetRatio(_inputType, MfGuids.PixelAspectRatio, 1, 1);
            MfCheck(_writer.SetInputMediaType(_streamIndex, _inputType, null),
                "IMFSinkWriter.SetInputMediaType");
            MfCheck(_writer.BeginWriting(), "IMFSinkWriter.BeginWriting");
        }

        internal void WriteFrame(IntPtr source, int byteCount, long timestamp, long duration)
        {
            IMfMediaBuffer buffer = null;
            IMfSample sample = null;
            IntPtr destination = IntPtr.Zero;
            bool locked = false;
            try
            {
                MfCheck(RecordingNative.MFCreateMemoryBuffer(byteCount, out buffer),
                    "MFCreateMemoryBuffer");
                int maximumLength;
                int currentLength;
                MfCheck(buffer.Lock(out destination, out maximumLength, out currentLength),
                    "IMFMediaBuffer.Lock");
                locked = true;
                RecordingNative.CopyMemory(destination, source, new UIntPtr((uint)byteCount));
                MfCheck(buffer.Unlock(), "IMFMediaBuffer.Unlock");
                locked = false;
                MfCheck(buffer.SetCurrentLength(byteCount), "IMFMediaBuffer.SetCurrentLength");

                MfCheck(RecordingNative.MFCreateSample(out sample), "MFCreateSample");
                MfCheck(sample.AddBuffer(buffer), "IMFSample.AddBuffer");
                MfCheck(sample.SetSampleTime(timestamp), "IMFSample.SetSampleTime");
                MfCheck(sample.SetSampleDuration(duration), "IMFSample.SetSampleDuration");
                MfCheck(_writer.WriteSample(_streamIndex, sample), "IMFSinkWriter.WriteSample");
            }
            finally
            {
                if (locked && buffer != null) buffer.Unlock();
                MfRelease(sample);
                MfRelease(buffer);
            }
        }

        internal void FinalizeFile()
        {
            if (_finalized) return;
            MfCheck(_writer.FinalizeWriter(), "IMFSinkWriter.Finalize");
            _finalized = true;
        }

        public void Dispose()
        {
            ReleaseWriterObjects();
        }

        private void ReleaseWriterObjects()
        {
            MfRelease(_writer);
            MfRelease(_inputType);
            MfRelease(_outputType);
            MfRelease(_writerAttributes);
            MfRelease(_dxgiManager);
            ReleaseUnknown(ref _d3dContext);
            ReleaseUnknown(ref _d3dDevice);
            _writer = null;
            _inputType = null;
            _outputType = null;
            _writerAttributes = null;
            _dxgiManager = null;
            _supportsGpuSurfaceInput = false;
        }

        private void TryAttachDxgiManager(IMfAttributes attributes)
        {
            const int D3dDriverTypeHardware = 1;
            const uint D3d11SdkVersion = 7;
            const uint D3d11CreateDeviceBgraSupport = 0x20;
            const uint D3d11CreateDeviceVideoSupport = 0x800;
            IMfDxgiDeviceManager manager = null;
            IntPtr device = IntPtr.Zero;
            IntPtr context = IntPtr.Zero;
            try
            {
                int featureLevel;
                int result = RecordingNative.D3D11CreateDevice(
                    IntPtr.Zero,
                    D3dDriverTypeHardware,
                    IntPtr.Zero,
                    D3d11CreateDeviceBgraSupport | D3d11CreateDeviceVideoSupport,
                    IntPtr.Zero,
                    0,
                    D3d11SdkVersion,
                    out device,
                    out featureLevel,
                    out context);
                if (result < 0 || device == IntPtr.Zero)
                    return;

                uint resetToken;
                result = RecordingNative.MFCreateDXGIDeviceManager(out resetToken, out manager);
                if (result < 0 || manager == null)
                    return;
                result = manager.ResetDevice(device, resetToken);
                if (result < 0)
                    return;

                Guid key = MfGuids.SinkWriterD3dManager;
                result = attributes.SetUnknown(ref key, manager);
                if (result < 0)
                    return;

                _d3dDevice = device;
                _d3dContext = context;
                _dxgiManager = manager;
                device = IntPtr.Zero;
                context = IntPtr.Zero;
                manager = null;
            }
            finally
            {
                MfRelease(manager);
                ReleaseUnknown(ref context);
                ReleaseUnknown(ref device);
            }
        }

        private static void MfSetGuid(IMfAttributes attributes, Guid key, Guid value)
        {
            MfCheck(attributes.SetGUID(ref key, ref value), "IMFAttributes.SetGUID");
        }

        private static void MfSetUInt32(IMfAttributes attributes, Guid key, int value)
        {
            MfCheck(attributes.SetUINT32(ref key, value), "IMFAttributes.SetUINT32");
        }

        private static void MfSetRatio(IMfAttributes attributes, Guid key, int high, int low)
        {
            ulong value = ((ulong)(uint)high << 32) | (uint)low;
            MfCheck(attributes.SetUINT64(ref key, value), "IMFAttributes.SetUINT64");
        }

        private static void MfCheck(int result, string operation)
        {
            if (result < 0)
                throw new COMException(operation + " failed (0x" + result.ToString("X8") + ").", result);
        }

        private static void MfRelease(object value)
        {
            if (value != null && Marshal.IsComObject(value))
                Marshal.FinalReleaseComObject(value);
        }

        private static void ReleaseUnknown(ref IntPtr value)
        {
            if (value == IntPtr.Zero) return;
            Marshal.Release(value);
            value = IntPtr.Zero;
        }
    }

    internal static class VideoClipboard
    {
        internal static bool TrySetFile(string path)
        {
            try
            {
                StringCollection files = new StringCollection();
                files.Add(path);
                DataObject data = new DataObject();
                data.SetFileDropList(files);
                Clipboard.SetDataObject(data, true, 6, 60);
                return true;
            }
            catch (ExternalException) { return false; }
        }
    }

    internal sealed class CountdownOverlay : Form
    {
        private const uint ExcludeFromCapture = 0x00000011;
        private readonly System.Windows.Forms.Timer _timer;
        private readonly Stopwatch _clock;
        private readonly Font _numberFont;
        private int _lastNumber = -1;

        internal CountdownOverlay(Rectangle recordingBounds)
        {
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ClientSize = new Size(82, 82);
            TopMost = true;
            ShowInTaskbar = false;
            KeyPreview = true;
            BackColor = Color.FromArgb(18, 20, 24);
            DoubleBuffered = true;
            Opacity = 0.82;

            Screen screen = Screen.FromRectangle(recordingBounds);
            Rectangle screenBounds = screen.Bounds;
            int x = recordingBounds.Left + (recordingBounds.Width - Width) / 2;
            int y = recordingBounds.Top + (recordingBounds.Height - Height) / 2;
            x = Math.Max(screenBounds.Left + 6, Math.Min(screenBounds.Right - Width - 6, x));
            y = Math.Max(screenBounds.Top + 6, Math.Min(screenBounds.Bottom - Height - 6, y));
            Location = new Point(x, y);

            using (GraphicsPath shape = new GraphicsPath())
            {
                shape.AddEllipse(new Rectangle(0, 0, Width, Height));
                Region = new Region(shape);
            }

            _clock = new Stopwatch();
            _timer = new System.Windows.Forms.Timer();
            _timer.Interval = 16;
            _timer.Tick += delegate
            {
                long elapsed = _clock.ElapsedMilliseconds;
                if (elapsed >= 3000)
                {
                    _timer.Stop();
                    DialogResult = DialogResult.OK;
                    Close();
                }
                else
                {
                    int number = Math.Max(1, 3 - (int)(elapsed / 1000));
                    int withinSecond = (int)(elapsed % 1000);
                    if (number != _lastNumber || withinSecond < 190)
                    {
                        _lastNumber = number;
                        Invalidate();
                    }
                    _timer.Interval = withinSecond < 210 ? 16 : 48;
                    if (elapsed < 150)
                    {
                        double progress = Math.Min(1.0, elapsed / 150.0);
                        double eased = 1.0 - Math.Pow(1.0 - progress, 3.0);
                        Opacity = Math.Min(0.98, 0.82 + 0.16 * eased);
                    }
                }
            };
            _numberFont = new Font("Segoe UI Semibold", 34.0f, FontStyle.Bold, GraphicsUnit.Pixel);
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams parameters = base.CreateParams;
                parameters.ClassStyle |= 0x00020000;
                parameters.ExStyle |= 0x00000080;
                return parameters;
            }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            RecordingNative.SetWindowDisplayAffinity(Handle, ExcludeFromCapture);
            Activate();
            Focus();
            _clock.Start();
            _timer.Start();
        }

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (keyData == Keys.Escape)
            {
                CancelCountdown();
                return true;
            }
            return base.ProcessCmdKey(ref msg, keyData);
        }

        internal void CancelCountdown()
        {
            if (IsDisposed) return;
            _timer.Stop();
            DialogResult = DialogResult.Cancel;
            Close();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            long milliseconds = _clock.ElapsedMilliseconds;
            int number = Math.Max(1, 3 - (int)(milliseconds / 1000));
            double withinSecond = milliseconds % 1000 / 1000.0;
            double progress = Math.Min(1.0, withinSecond / 0.28);
            double eased = 1.0 - Math.Pow(1.0 - progress, 3.0);
            float scale = (float)(1.06 - 0.06 * eased);

            Graphics graphics = e.Graphics;
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (Pen border = new Pen(Color.FromArgb(42, 255, 255, 255), 1.0f))
                graphics.DrawEllipse(border, 0, 0, Width - 1, Height - 1);

            string text = number.ToString();
            SizeF measured = graphics.MeasureString(text, _numberFont);
            graphics.TranslateTransform(ClientSize.Width / 2.0f, ClientSize.Height / 2.0f);
            graphics.ScaleTransform(scale, scale);
            using (SolidBrush foreground = new SolidBrush(Color.FromArgb(250, 250, 250)))
                graphics.DrawString(text, _numberFont, foreground,
                    -measured.Width / 2.0f,
                    -measured.Height / 2.0f - 2.0f);
            graphics.ResetTransform();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _timer.Dispose();
                _numberFont.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    internal sealed class RecordingControllerForm : Form
    {
        private const uint ExcludeFromCapture = 0x00000011;
        private readonly Rectangle _stopBounds = new Rectangle(133, 5, 36, 32);
        private readonly System.Windows.Forms.Timer _timer;
        private readonly Stopwatch _enterClock;
        private readonly Stopwatch _recordingClock;
        private readonly Font _timeFont;
        private Point _targetLocation;
        private bool _recordingStarted;
        private bool _stopping;
        private bool _stopHovered;
        private int _lastRenderedSecond = -1;

        internal event EventHandler StopRequested;

        internal RecordingControllerForm(Rectangle recordingRegion)
        {
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ClientSize = new Size(174, 42);
            TopMost = true;
            ShowInTaskbar = false;
            KeyPreview = true;
            BackColor = Color.FromArgb(18, 20, 24);
            DoubleBuffered = true;
            _timeFont = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold, GraphicsUnit.Point);
            _enterClock = new Stopwatch();
            _recordingClock = new Stopwatch();

            Screen screen = Screen.FromRectangle(recordingRegion);
            Rectangle work = screen.WorkingArea;
            int x = recordingRegion.Left + (recordingRegion.Width - Width) / 2;
            x = Math.Max(work.Left + 8, Math.Min(work.Right - Width - 8, x));
            int preferredY = recordingRegion.Top - Height - 10;
            int y = preferredY >= work.Top + 8
                ? preferredY
                : Math.Min(recordingRegion.Bottom - Height - 8, recordingRegion.Top + 10);
            y = Math.Max(work.Top + 8, y);
            y = Math.Min(work.Bottom - Height - 8, y);
            _targetLocation = new Point(x, y);
            Location = new Point(x, y - 6);
            Opacity = 0.74;

            using (GraphicsPath shape = RoundedRectangle(new Rectangle(Point.Empty, ClientSize), 21))
                Region = new Region(shape);

            _timer = new System.Windows.Forms.Timer();
            _timer.Interval = 16;
            _timer.Tick += OnTimerTick;
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams parameters = base.CreateParams;
                parameters.ClassStyle |= 0x00020000;
                parameters.ExStyle |= 0x00000080;
                return parameters;
            }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            RecordingNative.SetWindowDisplayAffinity(Handle, ExcludeFromCapture);
            _enterClock.Start();
            _timer.Start();
        }

        internal void MarkStarted()
        {
            if (_recordingStarted) return;
            _recordingStarted = true;
            _recordingClock.Start();
            _lastRenderedSecond = 0;
            Invalidate();
        }

        internal void MarkStopping()
        {
            if (_stopping) return;
            _stopping = true;
            Cursor = Cursors.WaitCursor;
            Invalidate();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            bool hovered = !_stopping && _stopBounds.Contains(e.Location);
            if (hovered != _stopHovered)
            {
                _stopHovered = hovered;
                Invalidate(_stopBounds);
            }
            Cursor = !_stopping && _stopBounds.Contains(e.Location) ? Cursors.Hand : Cursors.Default;
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (!_stopHovered) return;
            _stopHovered = false;
            Cursor = Cursors.Default;
            Invalidate(_stopBounds);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left && !_stopping && _stopBounds.Contains(e.Location))
            {
                MarkStopping();
                EventHandler handler = StopRequested;
                if (handler != null) handler(this, EventArgs.Empty);
            }
        }

        private void OnTimerTick(object sender, EventArgs e)
        {
            bool needsPaint = false;
            if (_enterClock.IsRunning && _enterClock.ElapsedMilliseconds < 180)
            {
                double progress = _enterClock.ElapsedMilliseconds / 180.0;
                double eased = 1.0 - Math.Pow(1.0 - progress, 3.0);
                Location = new Point(
                    _targetLocation.X,
                    _targetLocation.Y - 6 + (int)Math.Round(6.0 * eased));
                Opacity = Math.Min(0.98, 0.74 + 0.24 * eased);
                needsPaint = true;
            }
            else if (_enterClock.IsRunning)
            {
                _enterClock.Stop();
                Location = _targetLocation;
                Opacity = 0.98;
                _timer.Interval = 250;
                needsPaint = true;
            }
            int displayedSecond = _recordingStarted ? (int)_recordingClock.Elapsed.TotalSeconds : 0;
            if (displayedSecond != _lastRenderedSecond)
            {
                _lastRenderedSecond = displayedSecond;
                needsPaint = true;
            }
            if (needsPaint) Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics graphics = e.Graphics;
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (Pen border = new Pen(Color.FromArgb(46, 255, 255, 255), 1.0f))
                graphics.DrawRoundedRectangle(border, new Rectangle(0, 0, Width - 1, Height - 1), 20);

            Color dotColor = _stopping ? Color.FromArgb(255, 183, 84) : Color.FromArgb(255, 83, 86);
            using (SolidBrush dot = new SolidBrush(dotColor))
                graphics.FillEllipse(dot, 15, 17, 8, 8);

            string time = _stopping
                ? "Saving…"
                : (_recordingStarted ? FormatDuration(_recordingClock.Elapsed) : "00:00");
            TextRenderer.DrawText(graphics, time, _timeFont, new Rectangle(32, 0, 96, Height),
                Color.FromArgb(246, 248, 250), TextFormatFlags.Left | TextFormatFlags.VerticalCenter |
                TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);

            Color stopSurface = _stopping
                ? Color.FromArgb(26, 255, 255, 255)
                : (_stopHovered ? Color.FromArgb(34, 255, 255, 255) : Color.FromArgb(18, 255, 255, 255));
            using (GraphicsPath stopPath = RoundedRectangle(_stopBounds, 16))
            using (SolidBrush stopBrush = new SolidBrush(stopSurface))
                graphics.FillPath(stopBrush, stopPath);
            Rectangle stopIcon = new Rectangle(
                _stopBounds.Left + (_stopBounds.Width - 10) / 2,
                _stopBounds.Top + (_stopBounds.Height - 10) / 2,
                10,
                10);
            using (SolidBrush stopBrush = new SolidBrush(
                _stopping ? Color.FromArgb(170, 255, 255, 255) : Color.FromArgb(255, 91, 94)))
                graphics.FillRectangle(stopBrush, stopIcon);
        }

        private static string FormatDuration(TimeSpan elapsed)
        {
            int totalHours = (int)elapsed.TotalHours;
            return totalHours > 0
                ? totalHours.ToString("00") + ":" + elapsed.Minutes.ToString("00") + ":" + elapsed.Seconds.ToString("00")
                : elapsed.Minutes.ToString("00") + ":" + elapsed.Seconds.ToString("00");
        }

        private static GraphicsPath RoundedRectangle(Rectangle bounds, int radius)
        {
            int diameter = Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height));
            GraphicsPath path = new GraphicsPath();
            path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _timer.Dispose();
                _timeFont.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    internal static class RecordingGraphicsExtensions
    {
        internal static void DrawRoundedRectangle(this Graphics graphics, Pen pen, Rectangle bounds, int radius)
        {
            using (GraphicsPath path = new GraphicsPath())
            {
                int diameter = Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height));
                path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
                path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
                path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
                path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
                path.CloseFigure();
                graphics.DrawPath(pen, path);
            }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct BitmapInfoHeader
    {
        internal int Size;
        internal int Width;
        internal int Height;
        internal short Planes;
        internal short BitCount;
        internal int Compression;
        internal int SizeImage;
        internal int XPixelsPerMeter;
        internal int YPixelsPerMeter;
        internal int ColorsUsed;
        internal int ColorsImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct BitmapInfo
    {
        internal BitmapInfoHeader Header;
        internal uint Color;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct CursorInfo
    {
        internal int Size;
        internal int Flags;
        internal IntPtr Handle;
        internal Point ScreenPosition;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IconInfo
    {
        [MarshalAs(UnmanagedType.Bool)] internal bool IsIcon;
        internal uint HotspotX;
        internal uint HotspotY;
        internal IntPtr MaskBitmap;
        internal IntPtr ColorBitmap;
    }

    internal static class RecordingNative
    {
        [DllImport("ole32.dll", ExactSpelling = true)]
        internal static extern int CoInitializeEx(IntPtr reserved, int concurrencyModel);

        [DllImport("ole32.dll", ExactSpelling = true)]
        internal static extern void CoUninitialize();

        [DllImport("winmm.dll", ExactSpelling = true)]
        internal static extern int timeBeginPeriod(int period);

        [DllImport("winmm.dll", ExactSpelling = true)]
        internal static extern int timeEndPeriod(int period);

        [DllImport("kernel32.dll", EntryPoint = "CreateWaitableTimerExW", ExactSpelling = true,
            CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr CreateWaitableTimerEx(
            IntPtr timerAttributes,
            string timerName,
            uint flags,
            uint desiredAccess);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        internal static extern bool SetWaitableTimerEx(
            IntPtr timer,
            ref long dueTime,
            int period,
            IntPtr completionRoutine,
            IntPtr completionArgument,
            IntPtr wakeContext,
            uint tolerableDelay);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        internal static extern uint WaitForMultipleObjects(
            uint count,
            [In] IntPtr[] handles,
            [MarshalAs(UnmanagedType.Bool)] bool waitAll,
            uint milliseconds);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        internal static extern bool CloseHandle(IntPtr handle);

        [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
        internal static extern IntPtr GetDC(IntPtr window);

        [DllImport("user32.dll", ExactSpelling = true)]
        internal static extern int ReleaseDC(IntPtr window, IntPtr dc);

        [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)]
        internal static extern IntPtr CreateCompatibleDC(IntPtr dc);

        [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)]
        internal static extern bool DeleteDC(IntPtr dc);

        [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)]
        internal static extern IntPtr CreateDIBSection(
            IntPtr dc,
            ref BitmapInfo info,
            int usage,
            out IntPtr pixels,
            IntPtr section,
            int offset);

        [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)]
        internal static extern IntPtr SelectObject(IntPtr dc, IntPtr value);

        [DllImport("gdi32.dll", ExactSpelling = true)]
        internal static extern bool DeleteObject(IntPtr value);

        [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)]
        internal static extern bool BitBlt(
            IntPtr destination,
            int x,
            int y,
            int width,
            int height,
            IntPtr source,
            int sourceX,
            int sourceY,
            int operation);

        [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)]
        internal static extern bool StretchBlt(
            IntPtr destination,
            int x,
            int y,
            int width,
            int height,
            IntPtr source,
            int sourceX,
            int sourceY,
            int sourceWidth,
            int sourceHeight,
            int operation);

        [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)]
        internal static extern int SetStretchBltMode(IntPtr dc, int mode);

        [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)]
        internal static extern bool SetBrushOrgEx(
            IntPtr dc,
            int x,
            int y,
            out Point previousOrigin);

        [DllImport("user32.dll", ExactSpelling = true)]
        internal static extern bool GetCursorInfo(ref CursorInfo cursorInfo);

        [DllImport("user32.dll", ExactSpelling = true)]
        internal static extern short GetAsyncKeyState(int virtualKey);

        [DllImport("user32.dll", EntryPoint = "LoadCursorW", ExactSpelling = true)]
        internal static extern IntPtr LoadCursor(IntPtr instance, IntPtr cursorName);

        [DllImport("user32.dll", ExactSpelling = true)]
        internal static extern bool GetIconInfo(IntPtr icon, out IconInfo iconInfo);

        [DllImport("user32.dll", ExactSpelling = true)]
        internal static extern bool DrawIconEx(
            IntPtr dc,
            int x,
            int y,
            IntPtr icon,
            int width,
            int height,
            int step,
            IntPtr brush,
            int flags);

        [DllImport("user32.dll", ExactSpelling = true)]
        internal static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);

        [DllImport("kernel32.dll", EntryPoint = "RtlMoveMemory", ExactSpelling = true)]
        internal static extern void CopyMemory(IntPtr destination, IntPtr source, UIntPtr length);

        [DllImport("mfplat.dll", ExactSpelling = true)]
        internal static extern int MFStartup(int version, int flags);

        [DllImport("mfplat.dll", ExactSpelling = true)]
        internal static extern int MFShutdown();

        [DllImport("mfplat.dll", ExactSpelling = true)]
        internal static extern int MFCreateAttributes(out IMfAttributes attributes, int initialSize);

        [DllImport("mfplat.dll", ExactSpelling = true)]
        internal static extern int MFCreateMediaType(out IMfMediaType mediaType);

        [DllImport("mfplat.dll", ExactSpelling = true)]
        internal static extern int MFCreateMemoryBuffer(int maximumLength, out IMfMediaBuffer buffer);

        [DllImport("mfplat.dll", ExactSpelling = true)]
        internal static extern int MFCreateSample(out IMfSample sample);

        [DllImport("mfplat.dll", ExactSpelling = true)]
        internal static extern int MFCreateDXGIDeviceManager(
            out uint resetToken,
            out IMfDxgiDeviceManager deviceManager);

        [DllImport("d3d11.dll", ExactSpelling = true)]
        internal static extern int D3D11CreateDevice(
            IntPtr adapter,
            int driverType,
            IntPtr software,
            uint flags,
            IntPtr featureLevels,
            int featureLevelCount,
            uint sdkVersion,
            out IntPtr device,
            out int featureLevel,
            out IntPtr immediateContext);

        [DllImport("mfreadwrite.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
        internal static extern int MFCreateSinkWriterFromURL(
            [MarshalAs(UnmanagedType.LPWStr)] string outputUrl,
            IntPtr byteStream,
            IMfAttributes attributes,
            out IMfSinkWriter sinkWriter);
    }

    internal static class MfGuids
    {
        internal static readonly Guid MajorType = new Guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
        internal static readonly Guid Subtype = new Guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
        internal static readonly Guid FixedSizeSamples = new Guid("b8ebefaf-b718-4e04-b0a9-116775e3321b");
        internal static readonly Guid SampleSize = new Guid("dad3ab78-1990-408b-bce2-eba673dacc10");
        internal static readonly Guid FrameSize = new Guid("1652c33d-d6b2-4012-b834-72030849a37d");
        internal static readonly Guid FrameRate = new Guid("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
        internal static readonly Guid PixelAspectRatio = new Guid("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
        internal static readonly Guid InterlaceMode = new Guid("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
        internal static readonly Guid AverageBitRate = new Guid("20332624-fb0d-4d9e-bd0d-cbf6786c102e");
        internal static readonly Guid DefaultStride = new Guid("644b4e48-1e02-4516-b0eb-c01ca9d49ac6");
        internal static readonly Guid Mpeg2Profile = new Guid("ad76a80b-2d5c-4e0b-b375-64e520137036");
        internal static readonly Guid MaximumKeyFrameSpacing = new Guid("c16eb52b-73a1-476f-8d62-839d6a020652");
        internal static readonly Guid MediaTypeVideo = new Guid("73646976-0000-0010-8000-00aa00389b71");
        internal static readonly Guid VideoFormatH264 = new Guid("34363248-0000-0010-8000-00aa00389b71");
        internal static readonly Guid VideoFormatArgb32 = new Guid("00000015-0000-0010-8000-00aa00389b71");
        internal static readonly Guid VideoFormatRgb32 = new Guid("00000016-0000-0010-8000-00aa00389b71");
        internal static readonly Guid ReadWriteEnableHardwareTransforms = new Guid("a634a91c-822b-41b9-a494-4de4643612b0");
        internal static readonly Guid SinkWriterD3dManager = new Guid("ec822da2-e1e9-4b29-a0d8-563c719f5269");
        internal static readonly Guid LowLatency = new Guid("9c27891a-ed7a-40e1-88e8-b22727a024ee");
        internal static readonly Guid TranscodeContainerType = new Guid("150ff23f-4abc-478b-ac4f-e1916fba1cca");
        internal static readonly Guid TranscodeContainerTypeMpeg4 = new Guid("dc6cd05d-b9d0-40ef-bd35-fa622c1ab28a");
    }

    [ComImport, Guid("2cd2d921-c447-44a7-a13c-4adabfc247e3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMfAttributes
    {
        [PreserveSig] int GetItem();
        [PreserveSig] int GetItemType();
        [PreserveSig] int CompareItem();
        [PreserveSig] int Compare();
        [PreserveSig] int GetUINT32();
        [PreserveSig] int GetUINT64();
        [PreserveSig] int GetDouble();
        [PreserveSig] int GetGUID();
        [PreserveSig] int GetStringLength();
        [PreserveSig] int GetString();
        [PreserveSig] int GetAllocatedString();
        [PreserveSig] int GetBlobSize();
        [PreserveSig] int GetBlob();
        [PreserveSig] int GetAllocatedBlob();
        [PreserveSig] int GetUnknown();
        [PreserveSig] int SetItem();
        [PreserveSig] int DeleteItem();
        [PreserveSig] int DeleteAllItems();
        [PreserveSig] int SetUINT32([In] ref Guid key, int value);
        [PreserveSig] int SetUINT64([In] ref Guid key, ulong value);
        [PreserveSig] int SetDouble();
        [PreserveSig] int SetGUID([In] ref Guid key, [In] ref Guid value);
        [PreserveSig] int SetString();
        [PreserveSig] int SetBlob();
        [PreserveSig] int SetUnknown([In] ref Guid key, [MarshalAs(UnmanagedType.IUnknown)] object value);
        [PreserveSig] int LockStore();
        [PreserveSig] int UnlockStore();
        [PreserveSig] int GetCount();
        [PreserveSig] int GetItemByIndex();
        [PreserveSig] int CopyAllItems();
    }

    [ComImport, Guid("eb533d5d-2db6-40f8-97a9-494692014f07"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMfDxgiDeviceManager
    {
        [PreserveSig] int CloseDeviceHandle(IntPtr deviceHandle);
        [PreserveSig] int GetVideoService(IntPtr deviceHandle, [In] ref Guid interfaceId, out IntPtr service);
        [PreserveSig] int LockDevice(IntPtr deviceHandle, [In] ref Guid interfaceId, out IntPtr device, [MarshalAs(UnmanagedType.Bool)] bool block);
        [PreserveSig] int OpenDeviceHandle(out IntPtr deviceHandle);
        [PreserveSig] int ResetDevice(IntPtr device, uint resetToken);
        [PreserveSig] int TestDevice(IntPtr deviceHandle);
        [PreserveSig] int UnlockDevice(IntPtr deviceHandle, [MarshalAs(UnmanagedType.Bool)] bool saveState);
    }

    [ComImport, Guid("44ae0fa8-ea31-4109-8d2e-4cae4997c555"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMfMediaType : IMfAttributes
    {
        [PreserveSig] int GetMajorType();
        [PreserveSig] int IsCompressedFormat();
        [PreserveSig] int IsEqual();
        [PreserveSig] int GetRepresentation();
        [PreserveSig] int FreeRepresentation();
    }

    [ComImport, Guid("045fa593-8799-42b8-bc8d-8968c6453507"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMfMediaBuffer
    {
        [PreserveSig] int Lock(out IntPtr buffer, out int maximumLength, out int currentLength);
        [PreserveSig] int Unlock();
        [PreserveSig] int GetCurrentLength(out int currentLength);
        [PreserveSig] int SetCurrentLength(int currentLength);
        [PreserveSig] int GetMaxLength(out int maximumLength);
    }

    [ComImport, Guid("c40a00f2-b93a-4d80-ae8c-5a1c634f58e4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMfSample
    {
        [PreserveSig] int GetItem();
        [PreserveSig] int GetItemType();
        [PreserveSig] int CompareItem();
        [PreserveSig] int Compare();
        [PreserveSig] int GetUINT32();
        [PreserveSig] int GetUINT64();
        [PreserveSig] int GetDouble();
        [PreserveSig] int GetGUID();
        [PreserveSig] int GetStringLength();
        [PreserveSig] int GetString();
        [PreserveSig] int GetAllocatedString();
        [PreserveSig] int GetBlobSize();
        [PreserveSig] int GetBlob();
        [PreserveSig] int GetAllocatedBlob();
        [PreserveSig] int GetUnknown();
        [PreserveSig] int SetItem();
        [PreserveSig] int DeleteItem();
        [PreserveSig] int DeleteAllItems();
        [PreserveSig] int SetUINT32();
        [PreserveSig] int SetUINT64();
        [PreserveSig] int SetDouble();
        [PreserveSig] int SetGUID();
        [PreserveSig] int SetString();
        [PreserveSig] int SetBlob();
        [PreserveSig] int SetUnknown();
        [PreserveSig] int LockStore();
        [PreserveSig] int UnlockStore();
        [PreserveSig] int GetCount();
        [PreserveSig] int GetItemByIndex();
        [PreserveSig] int CopyAllItems();
        [PreserveSig] int GetSampleFlags();
        [PreserveSig] int SetSampleFlags();
        [PreserveSig] int GetSampleTime();
        [PreserveSig] int SetSampleTime(long time);
        [PreserveSig] int GetSampleDuration();
        [PreserveSig] int SetSampleDuration(long duration);
        [PreserveSig] int GetBufferCount();
        [PreserveSig] int GetBufferByIndex();
        [PreserveSig] int ConvertToContiguousBuffer();
        [PreserveSig] int AddBuffer(IMfMediaBuffer buffer);
        [PreserveSig] int RemoveBufferByIndex();
        [PreserveSig] int RemoveAllBuffers();
        [PreserveSig] int GetTotalLength();
        [PreserveSig] int CopyToBuffer();
    }

    [ComImport, Guid("3137f1cd-fe5e-4805-a5d8-fb477448cb3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMfSinkWriter
    {
        [PreserveSig] int AddStream(IMfMediaType targetMediaType, out int streamIndex);
        [PreserveSig] int SetInputMediaType(int streamIndex, IMfMediaType inputMediaType, IMfAttributes encodingParameters);
        [PreserveSig] int BeginWriting();
        [PreserveSig] int WriteSample(int streamIndex, IMfSample sample);
        [PreserveSig] int SendStreamTick();
        [PreserveSig] int PlaceMarker();
        [PreserveSig] int NotifyEndOfSegment();
        [PreserveSig] int Flush();
        [PreserveSig] int FinalizeWriter();
        [PreserveSig] int GetServiceForStream();
        [PreserveSig] int GetStatistics();
    }
}
