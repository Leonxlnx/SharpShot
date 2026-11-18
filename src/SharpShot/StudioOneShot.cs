using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace SharpShot
{
    internal struct StudioScreenshotClipboardPlan
    {
        internal readonly bool CopySelectionSize;
        internal readonly bool CopyProcessed;

        private StudioScreenshotClipboardPlan(
            bool copySelectionSize,
            bool copyProcessed)
        {
            CopySelectionSize = copySelectionSize;
            CopyProcessed = copyProcessed;
        }

        internal static StudioScreenshotClipboardPlan Create(
            bool clipboardEnabled,
            bool pasteAtSelectionSize)
        {
            return new StudioScreenshotClipboardPlan(
                clipboardEnabled && pasteAtSelectionSize,
                clipboardEnabled && !pasteAtSelectionSize);
        }
    }

    /// <summary>
    /// Short-lived capture host used by SharpShot Studio. The protocol is kept
    /// intentionally tiny: arguments start an operation, stdin may request stop,
    /// and an atomically-written result file completes the handoff.
    /// </summary>
    internal static class StudioOneShot
    {
        private const string ScreenshotCommand = "--studio-screenshot";
        private const string RecordingCommand = "--studio-record";
        private const string ClipboardFileCommand = "--clipboard-file";

        internal static bool CanHandle(string[] args)
        {
            if (args == null || args.Length == 0) return false;
            return String.Equals(args[0], ScreenshotCommand, StringComparison.OrdinalIgnoreCase) ||
                   String.Equals(args[0], RecordingCommand, StringComparison.OrdinalIgnoreCase) ||
                   String.Equals(args[0], ClipboardFileCommand, StringComparison.OrdinalIgnoreCase);
        }

        internal static int Run(string[] args)
        {
            if (String.Equals(args[0], ClipboardFileCommand, StringComparison.OrdinalIgnoreCase))
            {
                if (args.Length != 2 || !File.Exists(args[1])) return 2;
                try { return VideoClipboard.TrySetFile(Path.GetFullPath(args[1])) ? 0 : 1; }
                catch { return 1; }
            }

            Dictionary<string, string> options = ParseOptions(args);
            string resultPath = GetOption(options, "--result");
            if (String.IsNullOrEmpty(resultPath))
                return 2;

            try
            {
                if (String.Equals(args[0], ScreenshotCommand, StringComparison.OrdinalIgnoreCase))
                    return RunScreenshot(options, resultPath);
                return RunRecording(options, resultPath);
            }
            catch (Exception ex)
            {
                TryWriteResult(resultPath, "failed", null, 0, 0, 0, false, ex.Message);
                return 1;
            }
        }

        private static int RunScreenshot(Dictionary<string, string> options, string resultPath)
        {
            Bitmap desktop = null;
            Bitmap crop = null;
            Bitmap output = null;
            try
            {
                Rectangle desktopBounds;
                desktop = ScreenCapture.CaptureVirtualDesktop(out desktopBounds);
                int requestedQuality = ParseInt(GetOption(options, "--quality"), 0, 0, 12);
                bool pasteAtSelectionSize = ParseBool(
                    GetOption(options, "--paste-selection-size"), true);
                StudioScreenshotClipboardPlan clipboardPlan =
                    ResolveScreenshotClipboardPlan(
                        GetOption(options, "--clipboard"), pasteAtSelectionSize);

                Rectangle selection;
                using (CaptureOverlay overlay = new CaptureOverlay(
                    desktop,
                    desktopBounds,
                    requestedQuality,
                    pasteAtSelectionSize,
                    true,
                    false))
                {
                    if (overlay.ShowDialog() != DialogResult.OK || overlay.SelectedRegion.IsEmpty)
                    {
                        TryWriteResult(resultPath, "cancelled", null, 0, 0, 0, false, null);
                        return 0;
                    }
                    selection = overlay.SelectedRegion;
                }

                crop = desktop.Clone(selection, PixelFormat.Format24bppRgb);
                desktop.Dispose();
                desktop = null;

                bool copied = false;
                PngPayload compact = default(PngPayload);
                bool compactReady = false;
                if (clipboardPlan.CopySelectionSize)
                {
                    compact = PngEncoder.Encode(crop);
                    compactReady = true;
                    copied = ClipboardWriter.TrySetPng(crop, compact);
                }

                int scale = QualityProcessor.ResolveScale(selection.Width, selection.Height, requestedQuality);
                Bitmap ownedCrop = crop;
                crop = null;
                output = QualityProcessor.ProcessResolvedOwned(ownedCrop, scale);
                PngPayload png = scale == 1 && compactReady
                    ? compact
                    : PngEncoder.Encode(output);

                string outputPath = GetOption(options, "--output");
                if (String.IsNullOrEmpty(outputPath))
                    outputPath = ReserveStudioPath(false, output.Width, output.Height);
                WritePayload(outputPath, png);

                if (clipboardPlan.CopyProcessed)
                    copied = ClipboardWriter.TrySetPng(output, png);

                TryWriteResult(
                    resultPath,
                    "completed",
                    outputPath,
                    output.Width,
                    output.Height,
                    0,
                    copied,
                    null,
                    null,
                    null,
                    null,
                    selection.Width,
                    selection.Height);
                return 0;
            }
            finally
            {
                if (output != null) output.Dispose();
                if (crop != null) crop.Dispose();
                if (desktop != null) desktop.Dispose();
            }
        }

        private static int RunRecording(Dictionary<string, string> options, string resultPath)
        {
            RecordingVideoOptions videoOptions = new RecordingVideoOptions(
                ParseRecordingFrameRate(GetOption(options, "--fps")),
                ParseRecordingVideoQuality(GetOption(options, "--video-quality")));
            Bitmap desktop = null;
            try
            {
                Rectangle desktopBounds;
                desktop = ScreenCapture.CaptureVirtualDesktop(out desktopBounds);
                Rectangle selected;
                using (CaptureOverlay overlay = new CaptureOverlay(
                    desktop, desktopBounds, 1, true, true, true))
                {
                    if (overlay.ShowDialog() != DialogResult.OK || overlay.SelectedRegion.IsEmpty)
                    {
                        TryWriteResult(resultPath, "cancelled", null, 0, 0, 0, false, null);
                        return 0;
                    }
                    selected = overlay.SelectedRegion;
                }

                Rectangle recordingRegion = new Rectangle(
                    desktopBounds.Left + selected.Left,
                    desktopBounds.Top + selected.Top,
                    selected.Width,
                    selected.Height);
                desktop.Dispose();
                desktop = null;

                int countdownMs = ParseInt(GetOption(options, "--countdown-ms"), 3000, 0, 10000);
                if (countdownMs > 0)
                {
                    // The existing overlay is a deliberately clean, capture-
                    // excluded 3-2-1 surface. Until custom durations are added,
                    // only the useful product defaults are accepted.
                    using (CountdownOverlay countdown = new CountdownOverlay(recordingRegion))
                    {
                        if (countdown.ShowDialog() != DialogResult.OK)
                        {
                            TryWriteResult(resultPath, "cancelled", null, 0, 0, 0, false, null);
                            return 0;
                        }
                    }
                }

                string finalPath = GetOption(options, "--output");
                if (String.IsNullOrEmpty(finalPath))
                {
                    Size outputSize = RecordingPolicy.GetOutputSize(
                        recordingRegion.Width, recordingRegion.Height);
                    finalPath = ReserveStudioPath(
                        true, outputSize.Width, outputSize.Height);
                }
                EnsureOutputIsAvailable(finalPath);
                string partialPath = Path.Combine(
                    Path.GetDirectoryName(finalPath),
                    Path.GetFileNameWithoutExtension(finalPath) + ".partial.mp4");
                RecordingFilePaths paths = new RecordingFilePaths(partialPath, finalPath);

                bool copyFile = ParseBool(GetOption(options, "--clipboard"), true);
                RecordingCursorPolicy cursorPolicy = ResolveRecordingCursorPolicy(
                    GetOption(options, "--include-cursor"),
                    GetOption(options, "--editable-cursor"));
                bool captureSystemAudio = ParseBool(
                    GetOption(options, "--system-audio"), false);
                string microphoneDeviceId = GetOption(options, "--microphone-device-id");
                if (String.IsNullOrEmpty(microphoneDeviceId) &&
                    ParseBool(GetOption(options, "--microphone"), false))
                    microphoneDeviceId = "default";
                if (String.Equals(microphoneDeviceId, "false", StringComparison.OrdinalIgnoreCase) ||
                    String.Equals(microphoneDeviceId, "none", StringComparison.OrdinalIgnoreCase) ||
                    String.Equals(microphoneDeviceId, "off", StringComparison.OrdinalIgnoreCase))
                    microphoneDeviceId = null;
                AudioCaptureOptions audioOptions = new AudioCaptureOptions(
                    captureSystemAudio, microphoneDeviceId);
                using (StudioRecordingContext context = new StudioRecordingContext(
                    recordingRegion, paths, resultPath, copyFile,
                    cursorPolicy.IncludeInVideo,
                    cursorPolicy.CaptureEditableMetadata,
                    audioOptions, videoOptions))
                {
                    Application.Run(context);
                    return context.ExitCode;
                }
            }
            finally
            {
                if (desktop != null) desktop.Dispose();
            }
        }

        private static Dictionary<string, string> ParseOptions(string[] args)
        {
            Dictionary<string, string> result = new Dictionary<string, string>(
                StringComparer.OrdinalIgnoreCase);
            for (int i = 1; i < args.Length; i++)
            {
                string key = args[i];
                if (!key.StartsWith("--", StringComparison.Ordinal)) continue;
                string value = "true";
                if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
                    value = args[++i];
                result[key] = value;
            }
            return result;
        }

        private static string GetOption(Dictionary<string, string> options, string key)
        {
            string value;
            return options.TryGetValue(key, out value) ? value : null;
        }

        private static int ParseInt(string text, int fallback, int minimum, int maximum)
        {
            int value;
            if (!Int32.TryParse(text, out value)) return fallback;
            return Math.Max(minimum, Math.Min(maximum, value));
        }

        private static bool ParseBool(string text, bool fallback)
        {
            if (String.IsNullOrEmpty(text)) return fallback;
            bool value;
            return Boolean.TryParse(text, out value) ? value : fallback;
        }

        internal static StudioScreenshotClipboardPlan ResolveScreenshotClipboardPlan(
            string clipboardOption,
            bool pasteAtSelectionSize)
        {
            return StudioScreenshotClipboardPlan.Create(
                ParseBool(clipboardOption, true), pasteAtSelectionSize);
        }

        internal static RecordingCursorPolicy ResolveRecordingCursorPolicy(
            string includeCursorOption,
            string editableCursorOption)
        {
            return new RecordingCursorPolicy(
                ParseBool(includeCursorOption, true),
                ParseBool(editableCursorOption, false));
        }

        internal static void ReadStopCommands(TextReader reader, Action requestStop)
        {
            while (true)
            {
                string line;
                try { line = reader.ReadLine(); }
                catch
                {
                    requestStop();
                    return;
                }
                if (line == null ||
                    String.Equals(line.Trim(), "stop", StringComparison.OrdinalIgnoreCase))
                {
                    requestStop();
                    return;
                }
            }
        }

        private static int ParseRecordingFrameRate(string text)
        {
            if (String.IsNullOrEmpty(text) ||
                String.Equals(text, "auto", StringComparison.OrdinalIgnoreCase))
                return 0;
            int value;
            if (!Int32.TryParse(text, out value) || (value != 30 && value != 60))
                throw new ArgumentException("Recording FPS must be 30 or 60.");
            return value;
        }

        private static RecordingVideoQuality ParseRecordingVideoQuality(string text)
        {
            if (String.IsNullOrEmpty(text) ||
                String.Equals(text, "auto", StringComparison.OrdinalIgnoreCase))
                return RecordingVideoQuality.Automatic;
            if (String.Equals(text, "balanced", StringComparison.OrdinalIgnoreCase))
                return RecordingVideoQuality.Balanced;
            if (String.Equals(text, "high", StringComparison.OrdinalIgnoreCase))
                return RecordingVideoQuality.High;
            if (String.Equals(text, "maximum", StringComparison.OrdinalIgnoreCase))
                return RecordingVideoQuality.Maximum;
            throw new ArgumentException(
                "Video quality must be balanced, high, or maximum.");
        }

        private static string ReserveStudioPath(bool video, int width, int height)
        {
            Environment.SpecialFolder root = video
                ? Environment.SpecialFolder.MyVideos
                : Environment.SpecialFolder.MyPictures;
            string baseFolder = Environment.GetFolderPath(root);
            if (String.IsNullOrEmpty(baseFolder))
                baseFolder = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string folder = Path.Combine(
                baseFolder,
                "SharpShot Studio",
                video ? "Recordings" : "Screenshots");
            Directory.CreateDirectory(folder);

            string kind = video ? "Recording" : "Screenshot";
            string extension = video ? ".mp4" : ".png";
            string stem = kind + " " + DateTime.Now.ToString("yyyy-MM-dd 'at' HH.mm.ss") +
                          " - " + width + "x" + height;
            string path = Path.Combine(folder, stem + extension);
            int suffix = 2;
            while (File.Exists(path) || File.Exists(Path.ChangeExtension(path, ".partial.mp4")))
                path = Path.Combine(folder, stem + " (" + suffix++ + ")" + extension);
            return path;
        }

        private static void EnsureOutputIsAvailable(string path)
        {
            string fullPath = Path.GetFullPath(path);
            string folder = Path.GetDirectoryName(fullPath);
            if (String.IsNullOrEmpty(folder))
                throw new InvalidOperationException("The output path has no parent folder.");
            Directory.CreateDirectory(folder);
            if (File.Exists(fullPath))
                throw new IOException("The selected output file already exists.");
        }

        private static void WritePayload(string path, PngPayload payload)
        {
            EnsureOutputIsAvailable(path);
            using (FileStream file = new FileStream(
                path, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                payload.WriteTo(file);
        }

        internal static void TryWriteResult(
            string resultPath,
            string status,
            string mediaPath,
            int width,
            int height,
            long durationMs,
            bool clipboard,
            string error)
        {
            TryWriteResult(
                resultPath, status, mediaPath, width, height, durationMs,
                clipboard, error, null, null, null);
        }

        internal static void TryWriteResult(
            string resultPath,
            string status,
            string mediaPath,
            int width,
            int height,
            long durationMs,
            bool clipboard,
            string error,
            string cursorMetadataPath)
        {
            TryWriteResult(
                resultPath, status, mediaPath, width, height, durationMs,
                clipboard, error, cursorMetadataPath, null, null);
        }

        internal static void TryWriteResult(
            string resultPath,
            string status,
            string mediaPath,
            int width,
            int height,
            long durationMs,
            bool clipboard,
            string error,
            string cursorMetadataPath,
            string systemAudioPath,
            string microphonePath)
        {
            TryWriteResult(
                resultPath, status, mediaPath, width, height, durationMs,
                clipboard, error, cursorMetadataPath, systemAudioPath,
                microphonePath, width, height);
        }

        internal static void TryWriteResult(
            string resultPath,
            string status,
            string mediaPath,
            int width,
            int height,
            long durationMs,
            bool clipboard,
            string error,
            string cursorMetadataPath,
            string systemAudioPath,
            string microphonePath,
            int sourceWidth,
            int sourceHeight)
        {
            try
            {
                string fullPath = Path.GetFullPath(resultPath);
                string folder = Path.GetDirectoryName(fullPath);
                if (!String.IsNullOrEmpty(folder)) Directory.CreateDirectory(folder);
                string temporary = fullPath + ".tmp-" + Guid.NewGuid().ToString("N");
                string[] lines = new string[]
                {
                    "protocol=1",
                    "status=" + status,
                    "path64=" + ToBase64(mediaPath),
                    "sourceWidth=" + sourceWidth,
                    "sourceHeight=" + sourceHeight,
                    "width=" + width,
                    "height=" + height,
                    "durationMs=" + durationMs,
                    "clipboard=" + (clipboard ? "true" : "false"),
                    "cursorPath64=" + ToBase64(cursorMetadataPath),
                    "systemAudioPath64=" + ToBase64(systemAudioPath),
                    "microphonePath64=" + ToBase64(microphonePath),
                    "error64=" + ToBase64(error)
                };
                File.WriteAllLines(temporary, lines, new UTF8Encoding(false));
                if (File.Exists(fullPath)) File.Delete(fullPath);
                File.Move(temporary, fullPath);
            }
            catch { }
        }

        private static string ToBase64(string value)
        {
            if (String.IsNullOrEmpty(value)) return String.Empty;
            return Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
        }
    }

    internal sealed class StudioRecordingContext : ApplicationContext
    {
        private readonly RecordingFilePaths _paths;
        private readonly string _resultPath;
        private readonly bool _copyFile;
        private readonly ScreenRecorderSession _session;
        private readonly RecordingControllerForm _controller;
        private int _stopping;
        private bool _completed;

        internal int ExitCode { get; private set; }

        internal StudioRecordingContext(
            Rectangle region,
            RecordingFilePaths paths,
            string resultPath,
            bool copyFile,
            bool includeCursor,
            bool editableCursor,
            AudioCaptureOptions audioOptions,
            RecordingVideoOptions videoOptions)
        {
            _paths = paths;
            _resultPath = resultPath;
            _copyFile = copyFile;
            _session = new ScreenRecorderSession(
                region, paths, includeCursor, editableCursor,
                audioOptions, videoOptions);
            _controller = new RecordingControllerForm(region);
            _controller.StopRequested += delegate { RequestStop(); };
            _controller.FormClosed += delegate
            {
                if (!_completed) RequestStop();
            };
            _session.Started += delegate { Post(delegate { _controller.MarkStarted(); }); };
            _session.Completed += delegate(object sender, RecordingCompletedEventArgs args)
            {
                Post(delegate { Complete(args.Result); });
            };

            _controller.Show();
            _session.Start();
            StartCommandReader();
        }

        private void StartCommandReader()
        {
            Thread reader = new Thread(delegate()
            {
                StudioOneShot.ReadStopCommands(Console.In, RequestStop);
            });
            reader.Name = "SharpShot Studio command reader";
            reader.IsBackground = true;
            reader.Start();
        }

        private void RequestStop()
        {
            if (Interlocked.Exchange(ref _stopping, 1) != 0) return;
            try { Post(delegate { _controller.MarkStopping(); }); }
            catch { }
            _session.RequestStop();
        }

        private void Complete(RecordingResult result)
        {
            if (_completed) return;
            _completed = true;

            bool copied = false;
            if (result.Succeeded && _copyFile)
            {
                try { copied = VideoClipboard.TrySetFile(result.Path); }
                catch { }
            }

            if (result.Succeeded)
            {
                StudioOneShot.TryWriteResult(
                    _resultPath,
                    "completed",
                    result.Path,
                    result.Width,
                    result.Height,
                    (long)result.Duration.TotalMilliseconds,
                    copied,
                    null,
                    result.CursorMetadataPath,
                    result.SystemAudioPath,
                    result.MicrophonePath,
                    result.SourceWidth,
                    result.SourceHeight);
                ExitCode = 0;
            }
            else
            {
                string message = result.Error == null
                    ? "Windows did not return a completed video."
                    : result.Error.Message;
                StudioOneShot.TryWriteResult(
                    _resultPath, "failed", null, result.Width, result.Height,
                    (long)result.Duration.TotalMilliseconds, false, message,
                    null, null, null, result.SourceWidth, result.SourceHeight);
                ExitCode = 1;
            }

            try { _controller.Close(); }
            catch { }
            ExitThread();
        }

        private void Post(MethodInvoker action)
        {
            if (_controller.IsDisposed) return;
            try
            {
                if (_controller.IsHandleCreated)
                    _controller.BeginInvoke(action);
            }
            catch (ObjectDisposedException) { }
            catch (InvalidOperationException) { }
        }

        protected override void ExitThreadCore()
        {
            if (!_completed)
            {
                StudioOneShot.TryWriteResult(
                    _resultPath, "failed", null, 0, 0, 0, false,
                    "The recording helper closed before finalization completed.");
                RecordingStorage.DeletePartial(_paths);
                ExitCode = 1;
            }
            base.ExitThreadCore();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                try { _session.Dispose(); }
                catch { }
                try { _controller.Dispose(); }
                catch { }
            }
            base.Dispose(disposing);
        }
    }
}
