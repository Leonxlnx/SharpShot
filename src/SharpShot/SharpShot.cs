using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("SharpShot")]
[assembly: AssemblyDescription("Fast, high-quality Windows region screenshots and H.264 screen recordings")]
[assembly: AssemblyProduct("SharpShot")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Leonxlnx")]
[assembly: AssemblyVersion("1.5.0.0")]
[assembly: AssemblyFileVersion("1.5.0.0")]

namespace SharpShot
{
    internal static class Program
    {
        private const string MutexName = "Local\\SharpShot_65A35D57_D5AF_48A8_91AF_65E78AB532C4";
        private static Mutex _singleInstance;

        [STAThread]
        private static int Main(string[] args)
        {
            DpiAwareness.Enable();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool silentStartup = false;
            for (int i = 0; i < args.Length; i++)
            {
                if (String.Equals(args[i], "--startup", StringComparison.OrdinalIgnoreCase))
                    silentStartup = true;
            }

            bool selfTest = args.Length > 0 && String.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase);
            bool liveSelfTest = args.Length > 0 && String.Equals(args[0], "--self-test-live", StringComparison.OrdinalIgnoreCase);
            if (selfTest || liveSelfTest)
            {
                string output = args.Length > 1 ? args[1] : Path.Combine(Path.GetTempPath(), "SharpShot-self-test");
                return SelfTest.Run(output, liveSelfTest);
            }

            if (StudioHotkeyHost.CanHandle(args))
                return StudioHotkeyHost.Run(args);

            // Studio launches the proven native picker/recorder as a short-lived
            // helper. One-shot commands deliberately bypass the tray singleton:
            // the Electron shell owns workflows while this process owns only the
            // selected capture and exits as soon as its result is durable.
            if (StudioOneShot.CanHandle(args))
                return StudioOneShot.Run(args);

            bool createdNew;
            _singleInstance = new Mutex(true, MutexName, out createdNew);
            if (!createdNew)
            {
                _singleInstance.Dispose();
                if (!silentStartup)
                {
                    MessageBox.Show(
                        "SharpShot is already running in the notification area.\n\nUse its active screenshot or recording shortcut, or open its tray menu.",
                        "SharpShot",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                }
                return 0;
            }

            try
            {
                Application.Run(new SharpShotContext(silentStartup));
                return 0;
            }
            finally
            {
                _singleInstance.ReleaseMutex();
                _singleInstance.Dispose();
            }
        }
    }

    internal static class DpiAwareness
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("shcore.dll")]
        private static extern int SetProcessDpiAwareness(int awareness);

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        internal static void Enable()
        {
            try
            {
                if (SetProcessDpiAwarenessContext(new IntPtr(-4)))
                    return;
            }
            catch (EntryPointNotFoundException) { }
            catch (DllNotFoundException) { }

            try
            {
                if (SetProcessDpiAwareness(2) == 0)
                    return;
            }
            catch (EntryPointNotFoundException) { }
            catch (DllNotFoundException) { }

            try { SetProcessDPIAware(); }
            catch (EntryPointNotFoundException) { }
        }
    }

    internal sealed class SharpShotContext : ApplicationContext
    {
        private readonly AppSettings _settings;
        private readonly NotifyIcon _tray;
        private readonly Icon _trayIcon;
        private readonly ContextMenuStrip _menu;
        private readonly HotkeyWindow _hotkeyWindow;
        private readonly Control _dispatcher;
        private readonly ToolStripMenuItem _captureItem;
        private readonly ToolStripMenuItem _recordItem;
        private readonly ToolStripMenuItem _autoItem;
        private readonly ToolStripMenuItem _nativeItem;
        private readonly ToolStripMenuItem _crispItem;
        private readonly ToolStripMenuItem _ultraItem;
        private readonly ToolStripMenuItem _maxItem;
        private readonly ToolStripMenuItem _pasteAtSelectionSizeItem;
        private readonly ToolStripMenuItem _autoSaveItem;
        private readonly ToolStripMenuItem _startupItem;
        private readonly ToolStripMenuItem _openLastItem;
        private bool _captureOpen;
        private bool _recordingFlowOpen;
        private bool _exitWhenRecordingStops;
        private CaptureOverlay _recordingOverlay;
        private CountdownOverlay _countdownOverlay;
        private ScreenRecorderSession _recordingSession;
        private RecordingControllerForm _recordingController;
        private bool _shuttingDown;
        private string _lastCapturePath;
        private string _hotkeyLabel;
        private string _recordingHotkeyLabel;

        internal SharpShotContext(bool silentStartup)
        {
            _settings = AppSettings.Load();
            _hotkeyLabel = "Win + Shift + D";
            _recordingHotkeyLabel = "Win + Shift + A";
            _dispatcher = new Control();
            _dispatcher.CreateControl();

            _menu = new ContextMenuStrip();
            _menu.Font = new Font("Segoe UI", 9.0f);
            _menu.ShowImageMargin = false;

            _captureItem = new ToolStripMenuItem("Capture now");
            _captureItem.ShortcutKeyDisplayString = "Win + Shift + D";
            _captureItem.Font = new Font("Segoe UI Semibold", 9.0f, FontStyle.Bold);
            _captureItem.Click += delegate { BeginCapture(); };
            _menu.Items.Add(_captureItem);

            _recordItem = new ToolStripMenuItem("Record screen area");
            _recordItem.ShortcutKeyDisplayString = "Win + Shift + A";
            _recordItem.Click += delegate { HandleRecordingHotkey(); };
            _menu.Items.Add(_recordItem);
            _menu.Items.Add(new ToolStripSeparator());

            ToolStripMenuItem qualityMenu = new ToolStripMenuItem("Output quality");
            _autoItem = new ToolStripMenuItem("Auto Crisp XXL - recommended");
            _nativeItem = new ToolStripMenuItem("Native - exact pixels (1\u00D7)");
            _crispItem = new ToolStripMenuItem("Crisp - enlarge 2\u00D7");
            _ultraItem = new ToolStripMenuItem("Ultra - enlarge 3\u00D7");
            _maxItem = new ToolStripMenuItem("Max - enlarge up to 6\u00D7 (micro crops)");
            _autoItem.Click += delegate { SetQuality(0); };
            _nativeItem.Click += delegate { SetQuality(1); };
            _crispItem.Click += delegate { SetQuality(2); };
            _ultraItem.Click += delegate { SetQuality(3); };
            _maxItem.Click += delegate { SetQuality(6); };
            qualityMenu.DropDownItems.Add(_autoItem);
            qualityMenu.DropDownItems.Add(new ToolStripSeparator());
            qualityMenu.DropDownItems.Add(_nativeItem);
            qualityMenu.DropDownItems.Add(_crispItem);
            qualityMenu.DropDownItems.Add(_ultraItem);
            qualityMenu.DropDownItems.Add(_maxItem);
            _menu.Items.Add(qualityMenu);

            _pasteAtSelectionSizeItem = new ToolStripMenuItem("Paste at selection size - best for chats");
            _pasteAtSelectionSizeItem.Checked = _settings.PasteAtSelectionSize;
            _pasteAtSelectionSizeItem.CheckOnClick = true;
            _pasteAtSelectionSizeItem.Click += delegate
            {
                _settings.PasteAtSelectionSize = _pasteAtSelectionSizeItem.Checked;
                _settings.Save();
            };
            _menu.Items.Add(_pasteAtSelectionSizeItem);

            _autoSaveItem = new ToolStripMenuItem("Automatically save lossless PNGs");
            _autoSaveItem.Checked = _settings.AutoSave;
            _autoSaveItem.CheckOnClick = true;
            _autoSaveItem.Click += delegate
            {
                _settings.AutoSave = _autoSaveItem.Checked;
                _settings.Save();
            };
            _menu.Items.Add(_autoSaveItem);
            _menu.Items.Add(new ToolStripSeparator());

            ToolStripMenuItem openFolderItem = new ToolStripMenuItem("Open captures folder");
            openFolderItem.Click += delegate { OpenScreenshotsFolder(); };
            _menu.Items.Add(openFolderItem);

            _openLastItem = new ToolStripMenuItem("Open last capture");
            _openLastItem.Enabled = false;
            _openLastItem.Click += delegate { OpenLastCapture(); };
            _menu.Items.Add(_openLastItem);

            _startupItem = new ToolStripMenuItem("Start with Windows");
            _startupItem.Checked = StartupManager.IsEnabled();
            _startupItem.CheckOnClick = true;
            _startupItem.Click += delegate { ToggleStartup(); };
            _menu.Items.Add(_startupItem);
            _menu.Items.Add(new ToolStripSeparator());

            ToolStripMenuItem aboutItem = new ToolStripMenuItem("About SharpShot");
            aboutItem.Click += delegate { ShowAbout(); };
            _menu.Items.Add(aboutItem);

            ToolStripMenuItem exitItem = new ToolStripMenuItem("Exit");
            exitItem.Click += delegate { Exit(); };
            _menu.Items.Add(exitItem);

            _tray = new NotifyIcon();
            _trayIcon = IconFactory.CreateTrayIcon();
            _tray.Icon = _trayIcon;
            _tray.Text = "SharpShot - Win+Shift+D capture, Win+Shift+A record";
            _tray.ContextMenuStrip = _menu;
            _tray.Visible = true;
            _tray.DoubleClick += delegate { BeginCapture(); };

            _hotkeyWindow = new HotkeyWindow();
            _hotkeyWindow.ScreenshotPressed += delegate { BeginCapture(); };
            _hotkeyWindow.RecordingPressed += delegate { HandleRecordingHotkey(); };
            bool primaryHotkeyReady = _hotkeyWindow.RegisterWinShiftD();
            bool recordingHotkeyReady = _hotkeyWindow.RegisterWinShiftA();
            if (!primaryHotkeyReady)
            {
                _hotkeyLabel = "Unavailable";
                _captureItem.ShortcutKeyDisplayString = String.Empty;
                _tray.ShowBalloonTip(5000, "SharpShot hotkey unavailable",
                    "Win + Shift + D could not be registered. Double-click the SharpShot tray icon to capture.",
                    ToolTipIcon.Warning);
            }

            if (!recordingHotkeyReady)
            {
                _recordingHotkeyLabel = "Unavailable";
                _recordItem.ShortcutKeyDisplayString = String.Empty;
                _tray.ShowBalloonTip(5000, "Recording hotkey unavailable",
                    "Win + Shift + A could not be registered. Use Record screen area from the SharpShot tray menu.",
                    ToolTipIcon.Warning);
            }

            if (!primaryHotkeyReady && !recordingHotkeyReady)
                _tray.Text = "SharpShot - open the tray menu";
            else if (!primaryHotkeyReady)
                _tray.Text = "SharpShot - Win+Shift+A record";
            else if (!recordingHotkeyReady)
                _tray.Text = "SharpShot - Win+Shift+D capture";

            if (primaryHotkeyReady && recordingHotkeyReady && !silentStartup)
            {
                _tray.ShowBalloonTip(2500, "SharpShot is ready",
                    "Win + Shift + D captures. Win + Shift + A records a screen area.",
                    ToolTipIcon.Info);
            }

            RefreshQualityChecks();
            RuntimeStatus.Write(_hotkeyLabel, _recordingHotkeyLabel);
        }

        private void SetQuality(int scale)
        {
            _settings.QualityScale = scale;
            _settings.Save();
            RefreshQualityChecks();
        }

        private void RefreshQualityChecks()
        {
            _autoItem.Checked = _settings.QualityScale == 0;
            _nativeItem.Checked = _settings.QualityScale == 1;
            _crispItem.Checked = _settings.QualityScale == 2;
            _ultraItem.Checked = _settings.QualityScale == 3;
            _maxItem.Checked = _settings.QualityScale == 6;
        }

        private void BeginCapture()
        {
            if (_captureOpen || _recordingFlowOpen || _recordingSession != null)
                return;

            _captureOpen = true;
            Bitmap desktop = null;
            Bitmap crop = null;
            Bitmap output = null;
            try
            {
                Rectangle desktopBounds;
                desktop = ScreenCapture.CaptureVirtualDesktop(out desktopBounds);
                Rectangle selected;
                using (CaptureOverlay overlay = new CaptureOverlay(
                    desktop,
                    desktopBounds,
                    _settings.QualityScale,
                    _settings.PasteAtSelectionSize,
                    _settings.AutoSave,
                    false))
                {
                    if (overlay.ShowDialog() != DialogResult.OK || overlay.SelectedRegion.Width < 1 || overlay.SelectedRegion.Height < 1)
                        return;
                    selected = overlay.SelectedRegion;
                }

                // Desktop pixels are opaque. Keeping the selected crop in 24-bit
                // RGB avoids carrying and resampling a redundant alpha channel.
                crop = desktop.Clone(selected, PixelFormat.Format24bppRgb);
                desktop.Dispose();
                desktop = null;

                int effectiveScale = QualityProcessor.ResolveScale(selected.Width, selected.Height, _settings.QualityScale);
                int outputWidth = selected.Width;
                int outputHeight = selected.Height;
                bool copied = false;
                string clipboardError = null;
                string savedPath = null;
                string saveError = null;

                if (_settings.PasteAtSelectionSize)
                {
                    // Chats and browsers generally ignore PNG DPI metadata and
                    // render raw pixel dimensions. Flush the exact-size crop to
                    // the clipboard first so a small selection stays small when
                    // pasted. The enlarged lossless PNG remains the auto-save.
                    PngPayload sourcePng = default(PngPayload);
                    bool sourcePngReady = false;
                    try
                    {
                        sourcePng = PngEncoder.Encode(crop);
                        sourcePngReady = true;
                        copied = ClipboardWriter.TrySetPng(crop, sourcePng);
                    }
                    catch (Exception ex)
                    {
                        clipboardError = ex.Message;
                    }

                    // Auto-save is a strict opt-in for disk persistence. If it
                    // is off, skip enlargement entirely after the compact paste.
                    if (_settings.AutoSave)
                    {
                        try
                        {
                            PngPayload savePng;
                            if (effectiveScale == 1)
                            {
                                if (!sourcePngReady)
                                {
                                    sourcePng = PngEncoder.Encode(crop);
                                    sourcePngReady = true;
                                }
                                savePng = sourcePng;
                            }
                            else
                            {
                                Bitmap ownedCrop = crop;
                                crop = null;
                                output = QualityProcessor.ProcessResolvedOwned(ownedCrop, effectiveScale);
                                outputWidth = output.Width;
                                outputHeight = output.Height;
                                savePng = PngEncoder.Encode(output);
                            }

                            savedPath = ScreenshotStorage.Save(savePng, outputWidth, outputHeight);
                            _lastCapturePath = savedPath;
                            _openLastItem.Enabled = true;
                        }
                        catch (Exception ex)
                        {
                            saveError = ex.Message;
                        }
                    }
                }
                else
                {
                    Bitmap ownedCrop = crop;
                    crop = null;
                    output = QualityProcessor.ProcessResolvedOwned(ownedCrop, effectiveScale);
                    outputWidth = output.Width;
                    outputHeight = output.Height;
                    PngPayload fullResolutionPng = PngEncoder.Encode(output);

                    try
                    {
                        copied = ClipboardWriter.TrySetPng(output, fullResolutionPng);
                    }
                    catch (Exception ex)
                    {
                        clipboardError = ex.Message;
                    }

                    if (_settings.AutoSave)
                    {
                        try
                        {
                            savedPath = ScreenshotStorage.Save(fullResolutionPng, outputWidth, outputHeight);
                            _lastCapturePath = savedPath;
                            _openLastItem.Enabled = true;
                        }
                        catch (Exception ex)
                        {
                            saveError = ex.Message;
                        }
                    }
                }

                if (output != null)
                {
                    output.Dispose();
                    output = null;
                }
                if (crop != null)
                {
                    crop.Dispose();
                    crop = null;
                }

                string title;
                ToolTipIcon notificationIcon;
                if (copied && saveError == null)
                {
                    title = _settings.PasteAtSelectionSize
                        ? "Screenshot copied at selection size"
                        : "Screenshot copied at full resolution";
                    notificationIcon = ToolTipIcon.Info;
                }
                else if (copied)
                {
                    title = "Copied, but could not auto-save";
                    notificationIcon = ToolTipIcon.Warning;
                }
                else if (savedPath != null)
                {
                    title = "Saved PNG; clipboard unavailable";
                    notificationIcon = ToolTipIcon.Warning;
                }
                else
                {
                    title = "Could not retain capture";
                    notificationIcon = ToolTipIcon.Error;
                }

                string detail;
                if (_settings.PasteAtSelectionSize)
                    detail = "Clipboard: " + selected.Width + " \u00D7 " + selected.Height +
                             " (selection size).";
                else
                    detail = "Clipboard: " + outputWidth + " \u00D7 " + outputHeight + "  " +
                             QualityProcessor.GetDecisionName(_settings.QualityScale, effectiveScale) + ".";

                if (savedPath != null)
                    detail += "\nSaved: " + outputWidth + " \u00D7 " + outputHeight + "  " +
                              QualityProcessor.GetDecisionName(_settings.QualityScale, effectiveScale) +
                              " lossless PNG.";
                else if (!_settings.AutoSave && copied)
                    detail += _settings.PasteAtSelectionSize
                        ? "\nAuto-save is off; enlargement was skipped."
                        : "\nAuto-save is off; clipboard only.";
                else if (saveError != null)
                    detail += "\nCould not save: " + saveError;

                if (!copied && savedPath != null)
                    detail += "\nClipboard was unavailable; the auto-saved PNG is safe.";
                else if (!copied && savedPath == null)
                    detail += "\nThe image could not be retained. Clipboard: " +
                              (clipboardError ?? "unavailable") + "; save: " +
                              (_settings.AutoSave ? (saveError ?? "unavailable") : "disabled") + ".";

                _tray.ShowBalloonTip(3500, title, detail, notificationIcon);
            }
            catch (Exception ex)
            {
                _tray.ShowBalloonTip(5000, "SharpShot could not capture", ex.Message, ToolTipIcon.Error);
            }
            finally
            {
                if (output != null) output.Dispose();
                if (crop != null) crop.Dispose();
                if (desktop != null) desktop.Dispose();
                _captureOpen = false;
            }
        }

        private void HandleRecordingHotkey()
        {
            if (_recordingSession != null)
            {
                StopRecording();
                return;
            }
            if (_countdownOverlay != null)
            {
                _countdownOverlay.CancelCountdown();
                return;
            }
            if (_recordingOverlay != null)
            {
                _recordingOverlay.CancelCapture();
                return;
            }
            if (_captureOpen || _recordingFlowOpen)
                return;
            BeginRecording();
        }

        private void BeginRecording()
        {
            _recordingFlowOpen = true;
            Bitmap desktop = null;
            RecordingFilePaths paths = null;
            try
            {
                Rectangle desktopBounds;
                desktop = ScreenCapture.CaptureVirtualDesktop(out desktopBounds);
                Rectangle selected;
                _recordingOverlay = new CaptureOverlay(
                    desktop,
                    desktopBounds,
                    1,
                    true,
                    true,
                    true);
                DialogResult selectionResult = _recordingOverlay.ShowDialog();
                if (selectionResult != DialogResult.OK || _recordingOverlay.SelectedRegion.IsEmpty)
                    return;
                selected = _recordingOverlay.SelectedRegion;

                Rectangle recordingRegion = new Rectangle(
                    desktopBounds.Left + selected.Left,
                    desktopBounds.Top + selected.Top,
                    selected.Width,
                    selected.Height);

                _recordingOverlay.Dispose();
                _recordingOverlay = null;
                desktop.Dispose();
                desktop = null;

                _countdownOverlay = new CountdownOverlay(recordingRegion);
                DialogResult countdownResult = _countdownOverlay.ShowDialog();
                if (countdownResult != DialogResult.OK)
                    return;
                _countdownOverlay.Dispose();
                _countdownOverlay = null;

                paths = RecordingStorage.Reserve(recordingRegion);
                ScreenRecorderSession session = new ScreenRecorderSession(recordingRegion, paths);
                RecordingControllerForm controller = new RecordingControllerForm(recordingRegion);
                _recordingSession = session;
                _recordingController = controller;

                controller.StopRequested += delegate { StopRecording(); };
                session.Started += delegate
                {
                    PostToUi(delegate
                    {
                        if (ReferenceEquals(_recordingSession, session) && _recordingController != null)
                            _recordingController.MarkStarted();
                    });
                };
                session.Completed += delegate(object sender, RecordingCompletedEventArgs e)
                {
                    RecordingResult result = e.Result;
                    PostToUi(delegate { FinishRecording(session, result); });
                };

                _captureItem.Enabled = false;
                _recordItem.Text = "Stop recording";
                _recordItem.ShortcutKeyDisplayString = _recordingHotkeyLabel == "Unavailable"
                    ? String.Empty
                    : "Win + Shift + A";
                controller.Show();
                session.Start();
                paths = null;
            }
            catch (Exception ex)
            {
                if (_recordingController != null)
                {
                    _recordingController.Close();
                    _recordingController.Dispose();
                    _recordingController = null;
                }
                if (_recordingSession != null)
                {
                    _recordingSession.Dispose();
                    _recordingSession = null;
                }
                RecordingStorage.DeletePartial(paths);
                ResetRecordingUi();
                _tray.ShowBalloonTip(5000, "SharpShot could not start recording",
                    ex.Message, ToolTipIcon.Error);
            }
            finally
            {
                if (_countdownOverlay != null)
                {
                    _countdownOverlay.Dispose();
                    _countdownOverlay = null;
                }
                if (_recordingOverlay != null)
                {
                    _recordingOverlay.Dispose();
                    _recordingOverlay = null;
                }
                if (desktop != null) desktop.Dispose();
                _recordingFlowOpen = false;
                if (_exitWhenRecordingStops && _recordingSession == null)
                    ExitNow();
            }
        }

        private void StopRecording()
        {
            ScreenRecorderSession session = _recordingSession;
            if (session == null) return;
            if (_recordingController != null) _recordingController.MarkStopping();
            _recordItem.Enabled = false;
            session.RequestStop();
        }

        private void FinishRecording(ScreenRecorderSession session, RecordingResult result)
        {
            if (!ReferenceEquals(_recordingSession, session))
            {
                session.Dispose();
                return;
            }

            _recordingSession = null;
            if (_recordingController != null)
            {
                _recordingController.Close();
                _recordingController.Dispose();
                _recordingController = null;
            }
            ResetRecordingUi();

            bool copied = false;
            string clipboardError = null;
            if (result.Succeeded)
            {
                try { copied = VideoClipboard.TrySetFile(result.Path); }
                catch (Exception ex) { clipboardError = ex.Message; }
                _lastCapturePath = result.Path;
                _openLastItem.Enabled = true;

                double megabytes = 0.0;
                try { megabytes = new FileInfo(result.Path).Length / 1048576.0; }
                catch { }
                string dimensions = result.Width + " \u00D7 " + result.Height;
                if (result.SourceWidth != result.Width || result.SourceHeight != result.Height)
                    dimensions = result.SourceWidth + " \u00D7 " + result.SourceHeight +
                                 "  \u2192  " + dimensions;
                string detail = dimensions + "  \u00B7  " +
                                result.TargetFramesPerSecond + " FPS  \u00B7  " +
                                FormatRecordingDuration(result.Duration) + "  \u00B7  " +
                                megabytes.ToString("0.0") + " MB\nSaved as " +
                                Path.GetFileName(result.Path) + ".";
                if (copied)
                    detail += "\nReady to paste as a video file.";
                else
                    detail += "\nClipboard unavailable" +
                              (String.IsNullOrEmpty(clipboardError) ? "." : ": " + clipboardError) +
                              " The saved MP4 is safe.";
                if (result.FramesDropped > 0)
                    detail += "\n" + result.FramesDropped + " late frame" +
                              (result.FramesDropped == 1 ? " was" : "s were") +
                              " skipped to keep timing smooth.";

                _tray.ShowBalloonTip(5000,
                    copied ? "Recording saved and copied" : "Recording saved",
                    detail,
                    copied ? ToolTipIcon.Info : ToolTipIcon.Warning);
            }
            else
            {
                string message = result.Error == null
                    ? "Windows did not return a completed video."
                    : result.Error.Message;
                _tray.ShowBalloonTip(6000, "SharpShot could not finish recording",
                    message, ToolTipIcon.Error);
            }

            session.Dispose();
            if (_exitWhenRecordingStops)
                ExitNow();
        }

        private void ResetRecordingUi()
        {
            _captureItem.Enabled = true;
            _recordItem.Enabled = true;
            _recordItem.Text = "Record screen area";
            _recordItem.ShortcutKeyDisplayString = _recordingHotkeyLabel == "Unavailable"
                ? String.Empty
                : "Win + Shift + A";
        }

        private void PostToUi(MethodInvoker action)
        {
            if (_dispatcher.IsDisposed || !_dispatcher.IsHandleCreated) return;
            try { _dispatcher.BeginInvoke(action); }
            catch (ObjectDisposedException) { }
            catch (InvalidOperationException) { }
        }

        private static string FormatRecordingDuration(TimeSpan value)
        {
            if (value.TotalHours >= 1.0)
                return ((int)value.TotalHours).ToString("00") + ":" +
                       value.Minutes.ToString("00") + ":" + value.Seconds.ToString("00");
            return value.Minutes.ToString("00") + ":" + value.Seconds.ToString("00");
        }

        private void OpenScreenshotsFolder()
        {
            try
            {
                string folder = ScreenshotStorage.GetFolder();
                Directory.CreateDirectory(folder);
                Process.Start(folder);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Could not open the captures folder.\n\n" + ex.Message,
                    "SharpShot", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void OpenLastCapture()
        {
            try
            {
                if (_lastCapturePath != null && File.Exists(_lastCapturePath))
                    Process.Start(_lastCapturePath);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Could not open the last capture.\n\n" + ex.Message,
                    "SharpShot", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void ToggleStartup()
        {
            try
            {
                StartupManager.SetEnabled(_startupItem.Checked);
                _startupItem.Checked = StartupManager.IsEnabled();
            }
            catch (Exception ex)
            {
                _startupItem.Checked = StartupManager.IsEnabled();
                MessageBox.Show("Could not update the Windows startup setting.\n\n" + ex.Message,
                    "SharpShot", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void ShowAbout()
        {
            MessageBox.Show(
                "SharpShot 1.5.0\n\n" +
                "A native-pixel Windows screenshot and screen-recording tool.\n\n" +
                "Auto Crisp XXL chooses the densest whole-number enlargement from 2\u00D7 through 12\u00D7 that fits its speed budget, or exact Native 1\u00D7 for already-large captures. Enlargement uses local-range-clamped Catmull-Rom resampling for clean edges without sharpening halos. It improves small-crop readability but cannot create missing source detail.\n\n" +
                "By default, pasted images keep the selection's pixel dimensions so they stay compact in chats. Auto-save can keep the enlarged lossless PNG separately. Disable the chat-sized paste option to put the full-resolution version on the clipboard.\n\n" +
                "Recordings use native H.264 MP4 at up to 60 FPS, include the pointer, and are always saved before being copied as a pasteable file. Press the recording shortcut again or use the floating Stop control to finish.\n\n" +
                "Screenshot shortcut: " + _hotkeyLabel + "\n" +
                "Recording shortcut: " + _recordingHotkeyLabel + "\n" +
                "You can also double-click the tray icon to capture.",
                "About SharpShot",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }

        private void Exit()
        {
            if (_recordingOverlay != null)
            {
                _exitWhenRecordingStops = true;
                _recordingOverlay.CancelCapture();
                return;
            }
            if (_countdownOverlay != null)
            {
                _exitWhenRecordingStops = true;
                _countdownOverlay.CancelCountdown();
                return;
            }
            if (_recordingSession != null)
            {
                _exitWhenRecordingStops = true;
                StopRecording();
                _tray.ShowBalloonTip(2500, "Finishing recording",
                    "SharpShot will exit after the MP4 is safely finalized.", ToolTipIcon.Info);
                return;
            }
            ExitNow();
        }

        private void ExitNow()
        {
            if (_shuttingDown) return;
            _shuttingDown = true;
            RuntimeStatus.Clear();
            _hotkeyWindow.Dispose();
            _tray.Visible = false;
            _tray.Dispose();
            _trayIcon.Dispose();
            _menu.Dispose();
            _dispatcher.Dispose();
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (!_shuttingDown)
                {
                    _shuttingDown = true;
                    RuntimeStatus.Clear();
                    if (_recordingSession != null)
                    {
                        _recordingSession.RequestStop();
                        _recordingSession.Dispose();
                        _recordingSession = null;
                    }
                    if (_recordingController != null)
                    {
                        _recordingController.Close();
                        _recordingController.Dispose();
                        _recordingController = null;
                    }
                    _hotkeyWindow.Dispose();
                    _tray.Dispose();
                    _trayIcon.Dispose();
                    _menu.Dispose();
                    _dispatcher.Dispose();
                }
            }
            base.Dispose(disposing);
        }
    }

    internal sealed class HotkeyWindow : NativeWindow, IDisposable
    {
        private const int WmHotkey = 0x0312;
        private const int WmDispatchScreenshot = 0x8001;
        private const int WmDispatchRecording = 0x8002;
        private const int ScreenshotHotkeyId = 0x5348;
        private const int RecordingHotkeyId = 0x5349;
        private const uint ModShift = 0x0004;
        private const uint ModWin = 0x0008;
        private const uint ModNoRepeat = 0x4000;
        private const int WhKeyboardLl = 13;
        private const int WmKeyDown = 0x0100;
        private const int WmKeyUp = 0x0101;
        private const int WmSysKeyDown = 0x0104;
        private const int WmSysKeyUp = 0x0105;
        private const int VkShift = 0x10;
        private const int VkLWin = 0x5B;
        private const int VkRWin = 0x5C;
        private bool _screenshotRegistered;
        private bool _recordingRegistered;
        private bool _screenshotPosted;
        private bool _recordingPosted;
        private bool _recordingChordActive;
        private IntPtr _keyboardHook;
        private LowLevelKeyboardProc _keyboardCallback;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint virtualKey);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool PostMessage(IntPtr hWnd, int message, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(
            int hookId, LowLevelKeyboardProc callback, IntPtr module, uint threadId);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnhookWindowsHookEx(IntPtr hook);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(
            IntPtr hook, int code, IntPtr message, IntPtr keyboardData);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int virtualKey);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr GetModuleHandle(string moduleName);

        internal event EventHandler ScreenshotPressed;
        internal event EventHandler RecordingPressed;

        internal HotkeyWindow()
        {
            CreateParams cp = new CreateParams();
            cp.Caption = "SharpShot.MessageWindow";
            CreateHandle(cp);
        }

        internal bool RegisterWinShiftD()
        {
            _screenshotRegistered = RegisterHotKey(
                Handle, ScreenshotHotkeyId, ModWin | ModShift | ModNoRepeat, (uint)Keys.D);
            return _screenshotRegistered;
        }

        internal bool RegisterWinShiftA()
        {
            _recordingRegistered = RegisterHotKey(
                Handle, RecordingHotkeyId, ModWin | ModShift | ModNoRepeat, (uint)Keys.A);
            if (_recordingRegistered) return true;

            // Current Windows builds reserve Win+Shift+A for focusing a Windows
            // tip, so RegisterHotKey can legitimately fail. A low-level hook is
            // the no-poll compatibility path: it examines only the requested
            // chord, never stores keys, and posts the same UI-thread message.
            _keyboardCallback = KeyboardHookCallback;
            _keyboardHook = SetWindowsHookEx(
                WhKeyboardLl, _keyboardCallback, GetModuleHandle(null), 0);
            return _keyboardHook != IntPtr.Zero;
        }

        private IntPtr KeyboardHookCallback(int code, IntPtr message, IntPtr keyboardData)
        {
            if (code >= 0)
            {
                int kind = message.ToInt32();
                uint virtualKey = unchecked((uint)Marshal.ReadInt32(keyboardData));
                bool isA = virtualKey == (uint)Keys.A;
                bool keyDown = kind == WmKeyDown || kind == WmSysKeyDown;
                bool keyUp = kind == WmKeyUp || kind == WmSysKeyUp;
                if (isA && keyDown && IsPressed(VkShift) &&
                    (IsPressed(VkLWin) || IsPressed(VkRWin)))
                {
                    if (!_recordingChordActive)
                    {
                        _recordingChordActive = true;
                        QueueRecordingPress();
                    }
                    return new IntPtr(1);
                }
                if (isA && keyUp && _recordingChordActive)
                {
                    _recordingChordActive = false;
                    return new IntPtr(1);
                }
            }
            return CallNextHookEx(_keyboardHook, code, message, keyboardData);
        }

        private static bool IsPressed(int virtualKey)
        {
            return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
        }

        private void QueueRecordingPress()
        {
            if (_recordingPosted) return;
            _recordingPosted = true;
            if (!PostMessage(Handle, WmDispatchRecording, IntPtr.Zero, IntPtr.Zero))
                _recordingPosted = false;
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WmHotkey && m.WParam.ToInt32() == ScreenshotHotkeyId)
            {
                // Queue capture after WM_HOTKEY returns instead of waiting for a
                // WinForms timer tick. This avoids re-entering a modal overlay
                // from WndProc while removing timer-resolution latency.
                if (!_screenshotPosted)
                {
                    _screenshotPosted = true;
                    if (!PostMessage(Handle, WmDispatchScreenshot, IntPtr.Zero, IntPtr.Zero))
                    {
                        _screenshotPosted = false;
                        RaiseScreenshotPressed();
                    }
                }
            }
            else if (m.Msg == WmHotkey && m.WParam.ToInt32() == RecordingHotkeyId)
            {
                QueueRecordingPress();
            }
            else if (m.Msg == WmDispatchScreenshot)
            {
                _screenshotPosted = false;
                RaiseScreenshotPressed();
            }
            else if (m.Msg == WmDispatchRecording)
            {
                _recordingPosted = false;
                RaiseRecordingPressed();
            }
            base.WndProc(ref m);
        }

        private void RaiseScreenshotPressed()
        {
            EventHandler handler = ScreenshotPressed;
            if (handler != null) handler(this, EventArgs.Empty);
        }

        private void RaiseRecordingPressed()
        {
            EventHandler handler = RecordingPressed;
            if (handler != null) handler(this, EventArgs.Empty);
        }

        public void Dispose()
        {
            if (_screenshotRegistered)
            {
                UnregisterHotKey(Handle, ScreenshotHotkeyId);
                _screenshotRegistered = false;
            }
            if (_recordingRegistered)
            {
                UnregisterHotKey(Handle, RecordingHotkeyId);
                _recordingRegistered = false;
            }
            if (_keyboardHook != IntPtr.Zero)
            {
                UnhookWindowsHookEx(_keyboardHook);
                _keyboardHook = IntPtr.Zero;
            }
            _keyboardCallback = null;
            if (Handle != IntPtr.Zero)
                DestroyHandle();
        }

        private delegate IntPtr LowLevelKeyboardProc(
            int code, IntPtr message, IntPtr keyboardData);

    }

    internal sealed class CaptureOverlay : Form
    {
        private readonly Bitmap _desktop;
        private readonly int _requestedScale;
        private readonly bool _pasteAtSelectionSize;
        private readonly bool _autoSave;
        private readonly bool _recordingMode;
        private readonly Font _instructionFont;
        private readonly Font _sizeFont;
        private Point _start;
        private Point _current;
        private bool _dragging;
        private Rectangle _selection;

        internal Rectangle SelectedRegion { get; private set; }

        internal CaptureOverlay(
            Bitmap desktop,
            Rectangle desktopBounds,
            int requestedScale,
            bool pasteAtSelectionSize,
            bool autoSave,
            bool recordingMode)
        {
            _desktop = desktop;
            _requestedScale = requestedScale;
            _pasteAtSelectionSize = pasteAtSelectionSize;
            _autoSave = autoSave;
            _recordingMode = recordingMode;
            _instructionFont = new Font("Segoe UI Semibold", 10.5f, FontStyle.Bold, GraphicsUnit.Point);
            _sizeFont = new Font("Segoe UI", 9.5f, FontStyle.Bold, GraphicsUnit.Point);

            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Bounds = desktopBounds;
            TopMost = true;
            ShowInTaskbar = false;
            KeyPreview = true;
            Cursor = Cursors.Cross;
            BackColor = Color.Black;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            Activate();
            Focus();
        }

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (keyData == Keys.Escape)
            {
                DialogResult = DialogResult.Cancel;
                Close();
                return true;
            }
            return base.ProcessCmdKey(ref msg, keyData);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Right)
            {
                DialogResult = DialogResult.Cancel;
                Close();
                return;
            }
            if (e.Button != MouseButtons.Left)
                return;
            _start = ClampPoint(e.Location);
            _current = _start;
            _selection = Rectangle.Empty;
            _dragging = true;
            Capture = true;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (!_dragging)
                return;
            _current = ClampPoint(e.Location);
            Rectangle next = Normalize(_start, _current);
            if (next != _selection)
            {
                Rectangle previous = _selection;
                _selection = next;
                InvalidateSelectionTransition(previous, next);
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (!_dragging || e.Button != MouseButtons.Left)
                return;
            Capture = false;
            _dragging = false;
            _current = ClampPoint(e.Location);
            Rectangle previous = _selection;
            _selection = Normalize(_start, _current);
            Rectangle accepted = _recordingMode
                ? RecordingPolicy.NormalizeSelection(_selection, ClientRectangle)
                : _selection;
            if ((!_recordingMode && accepted.Width >= 2 && accepted.Height >= 2) ||
                (_recordingMode && !accepted.IsEmpty))
            {
                SelectedRegion = accepted;
                DialogResult = DialogResult.OK;
                Close();
            }
            else
            {
                _selection = Rectangle.Empty;
                InvalidateSelectionTransition(previous, Rectangle.Empty);
            }
        }

        private void InvalidateSelectionTransition(Rectangle previous, Rectangle next)
        {
            InvalidateDifference(previous, next);
            InvalidateDifference(next, previous);
            InvalidateBorder(previous);
            InvalidateBorder(next);
            InvalidateBadgeArea(previous);
            InvalidateBadgeArea(next);
        }

        private void InvalidateDifference(Rectangle source, Rectangle overlapWith)
        {
            if (source.IsEmpty) return;
            Rectangle intersection = Rectangle.Intersect(source, overlapWith);
            if (intersection.IsEmpty)
            {
                InvalidateClipped(source);
                return;
            }

            InvalidateClipped(Rectangle.FromLTRB(source.Left, source.Top, source.Right, intersection.Top));
            InvalidateClipped(Rectangle.FromLTRB(source.Left, intersection.Bottom, source.Right, source.Bottom));
            InvalidateClipped(Rectangle.FromLTRB(source.Left, intersection.Top, intersection.Left, intersection.Bottom));
            InvalidateClipped(Rectangle.FromLTRB(intersection.Right, intersection.Top, source.Right, intersection.Bottom));
        }

        private void InvalidateBorder(Rectangle rect)
        {
            if (rect.IsEmpty) return;
            Rectangle dirty = rect;
            dirty.Inflate(4, 4);
            InvalidateClipped(Rectangle.FromLTRB(dirty.Left, dirty.Top, dirty.Right, rect.Top + 5));
            InvalidateClipped(Rectangle.FromLTRB(dirty.Left, rect.Bottom - 5, dirty.Right, dirty.Bottom));
            InvalidateClipped(Rectangle.FromLTRB(dirty.Left, rect.Top, rect.Left + 5, rect.Bottom));
            InvalidateClipped(Rectangle.FromLTRB(rect.Right - 5, rect.Top, dirty.Right, rect.Bottom));
        }

        private void InvalidateBadgeArea(Rectangle rect)
        {
            if (rect.IsEmpty) return;
            Rectangle box = GetDimensionBox(rect, BuildDimensionText(rect));
            box.Inflate(4, 4);
            InvalidateClipped(box);
        }

        private void InvalidateClipped(Rectangle rect)
        {
            Rectangle clipped = Rectangle.Intersect(ClientRectangle, rect);
            if (clipped.Width > 0 && clipped.Height > 0)
                Invalidate(clipped, false);
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            OverlayPainter.DrawPixelAlignedSnapshot(g, _desktop);
            g.CompositingMode = CompositingMode.SourceOver;
            using (SolidBrush shade = new SolidBrush(Color.FromArgb(142, 4, 7, 10)))
                g.FillRectangle(shade, ClientRectangle);

            if (!_selection.IsEmpty)
            {
                OverlayPainter.DrawUnscaledSelection(g, _desktop, _selection);
                DrawSelection(g, _selection);
                DrawDimensions(g, _selection);
            }

            DrawInstructions(g);
        }

        private void DrawInstructions(Graphics g)
        {
            string text = _recordingMode
                ? "Drag an area to record   /   Esc or right-click to cancel"
                : "Drag to capture   /   Esc or right-click to cancel";
            SizeF measured = g.MeasureString(text, _instructionFont);
            int width = (int)Math.Ceiling(measured.Width) + 34;
            int height = 38;
            int x = Math.Max(14, (ClientSize.Width - width) / 2);
            int y = 22;
            Rectangle box = new Rectangle(x, y, width, height);
            using (GraphicsPath path = RoundedRectangle(box, 12))
            using (SolidBrush background = new SolidBrush(Color.FromArgb(232, 12, 16, 20)))
            using (SolidBrush foreground = new SolidBrush(Color.FromArgb(245, 247, 248)))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.FillPath(background, path);
                g.DrawString(text, _instructionFont, foreground,
                    box.Left + 17, box.Top + (box.Height - measured.Height) / 2 - 1);
            }
        }

        private void DrawSelection(Graphics g, Rectangle rect)
        {
            Color accent = Color.FromArgb(202, 255, 70);
            using (Pen outline = new Pen(accent, 2.0f))
            {
                outline.Alignment = PenAlignment.Inset;
                g.DrawRectangle(outline, rect);
            }

            int arm = Math.Min(18, Math.Max(7, Math.Min(rect.Width, rect.Height) / 3));
            using (Pen corner = new Pen(Color.White, 2.0f))
            {
                corner.StartCap = LineCap.Square;
                corner.EndCap = LineCap.Square;
                g.DrawLine(corner, rect.Left, rect.Top, rect.Left + arm, rect.Top);
                g.DrawLine(corner, rect.Left, rect.Top, rect.Left, rect.Top + arm);
                g.DrawLine(corner, rect.Right - arm, rect.Top, rect.Right, rect.Top);
                g.DrawLine(corner, rect.Right, rect.Top, rect.Right, rect.Top + arm);
                g.DrawLine(corner, rect.Left, rect.Bottom, rect.Left + arm, rect.Bottom);
                g.DrawLine(corner, rect.Left, rect.Bottom - arm, rect.Left, rect.Bottom);
                g.DrawLine(corner, rect.Right - arm, rect.Bottom, rect.Right, rect.Bottom);
                g.DrawLine(corner, rect.Right, rect.Bottom - arm, rect.Right, rect.Bottom);
            }
        }

        private void DrawDimensions(Graphics g, Rectangle rect)
        {
            string text = BuildDimensionText(rect);
            Rectangle box = GetDimensionBox(rect, text);
            using (GraphicsPath path = RoundedRectangle(box, 9))
            using (SolidBrush background = new SolidBrush(Color.FromArgb(235, 12, 16, 20)))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.FillPath(background, path);
                TextRenderer.DrawText(g, text, _sizeFont, box, Color.FromArgb(202, 255, 70),
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter |
                    TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
            }
        }

        private string BuildDimensionText(Rectangle rect)
        {
            if (_recordingMode)
                return RecordingPolicy.GetSelectionLabel(rect, ClientRectangle);

            int effectiveScale = QualityProcessor.ResolveScale(rect.Width, rect.Height, _requestedScale);
            string text = rect.Width + " \u00D7 " + rect.Height + " px";
            if (_pasteAtSelectionSize)
            {
                if (_autoSave && effectiveScale > 1)
                    text += "  \u00B7  Paste 1\u00D7  \u00B7  Save " +
                            (rect.Width * effectiveScale) + " \u00D7 " + (rect.Height * effectiveScale) +
                            " (" + effectiveScale + "\u00D7)";
                else if (_autoSave)
                    text += "  \u00B7  Paste / save Native 1\u00D7";
                else
                    text += "  \u00B7  Paste 1\u00D7 chat-sized";
                return text;
            }

            if (effectiveScale > 1)
                text += "  \u2192  " + (rect.Width * effectiveScale) + " \u00D7 " + (rect.Height * effectiveScale) + "  " +
                        QualityProcessor.GetDecisionName(_requestedScale, effectiveScale);
            else
                text += "  /  " + QualityProcessor.GetDecisionName(_requestedScale, effectiveScale);
            return text;
        }

        internal void CancelCapture()
        {
            if (IsDisposed) return;
            DialogResult = DialogResult.Cancel;
            Close();
        }

        private Rectangle GetDimensionBox(Rectangle rect, string text)
        {
            Size measured = TextRenderer.MeasureText(text, _sizeFont, new Size(8192, 256),
                TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
            int width = measured.Width + 24;
            int height = 31;
            int x = rect.Right - width;
            int y = rect.Bottom + 10;
            if (y + height > ClientSize.Height - 8)
                y = rect.Top - height - 10;
            if (y < 8)
                y = Math.Min(ClientSize.Height - height - 8, rect.Bottom + 10);
            x = Math.Max(8, Math.Min(ClientSize.Width - width - 8, x));
            return new Rectangle(x, y, width, height);
        }

        private Point ClampPoint(Point point)
        {
            int x = Math.Max(0, Math.Min(ClientSize.Width, point.X));
            int y = Math.Max(0, Math.Min(ClientSize.Height, point.Y));
            return new Point(x, y);
        }

        private static Rectangle Normalize(Point a, Point b)
        {
            int left = Math.Min(a.X, b.X);
            int top = Math.Min(a.Y, b.Y);
            int right = Math.Max(a.X, b.X);
            int bottom = Math.Max(a.Y, b.Y);
            return Rectangle.FromLTRB(left, top, right, bottom);
        }

        private static GraphicsPath RoundedRectangle(Rectangle bounds, int radius)
        {
            int diameter = radius * 2;
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
                _instructionFont.Dispose();
                _sizeFont.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    internal static class OverlayPainter
    {
        internal static void DrawPixelAlignedSnapshot(Graphics graphics, Bitmap desktop)
        {
            GraphicsState state = graphics.Save();
            try
            {
                DrawPixelAlignedCore(graphics, desktop);
            }
            finally
            {
                graphics.Restore(state);
            }
        }

        internal static void DrawUnscaledSelection(Graphics graphics, Bitmap desktop, Rectangle selection)
        {
            GraphicsState state = graphics.Save();
            try
            {
                graphics.SetClip(selection, CombineMode.Intersect);
                DrawPixelAlignedCore(graphics, desktop);
            }
            finally
            {
                graphics.Restore(state);
            }
        }

        private static void DrawPixelAlignedCore(Graphics graphics, Bitmap desktop)
        {
            graphics.CompositingMode = CompositingMode.SourceCopy;
            graphics.PageUnit = GraphicsUnit.Pixel;
            graphics.PageScale = 1.0f;
            graphics.InterpolationMode = InterpolationMode.NearestNeighbor;
            graphics.PixelOffsetMode = PixelOffsetMode.Half;
            graphics.DrawImage(
                desktop,
                new Rectangle(0, 0, desktop.Width, desktop.Height),
                0, 0, desktop.Width, desktop.Height,
                GraphicsUnit.Pixel);
        }
    }

    internal static class ScreenCapture
    {
        private const uint SourceCopy = 0x00CC0020;
        private const uint CaptureBlt = 0x40000000;

        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr window);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr window, IntPtr dc);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool BitBlt(IntPtr destinationDc, int x, int y, int width, int height,
            IntPtr sourceDc, int sourceX, int sourceY, uint rasterOperation);

        internal static Bitmap CaptureVirtualDesktop(out Rectangle bounds)
        {
            Screen[] screens = Screen.AllScreens;
            if (screens.Length == 0)
                throw new InvalidOperationException("Windows reported no displays.");

            bounds = screens[0].Bounds;
            for (int i = 1; i < screens.Length; i++)
                bounds = Rectangle.Union(bounds, screens[i].Bounds);
            if (bounds.Width <= 0 || bounds.Height <= 0)
                throw new InvalidOperationException("Windows reported an empty desktop.");

            // A 24-bit destination guarantees opaque output. GDI BitBlt does not
            // define the alpha byte of a 32-bit DIB on every Windows/display path.
            Bitmap bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb);
            try
            {
                using (Graphics g = Graphics.FromImage(bitmap))
                {
                    g.Clear(Color.Black);
                    if (!TryCaptureWithLayeredWindows(g, bounds, screens))
                    {
                        // DWM normally includes composed windows in SourceCopy.
                        // This fallback also covers unusual DC access policies.
                        foreach (Screen screen in screens)
                        {
                            Rectangle monitor = screen.Bounds;
                            g.CopyFromScreen(
                                monitor.Left,
                                monitor.Top,
                                monitor.Left - bounds.Left,
                                monitor.Top - bounds.Top,
                                monitor.Size,
                                CopyPixelOperation.SourceCopy);
                        }
                    }
                }
                bitmap.SetResolution(96.0f, 96.0f);
                return bitmap;
            }
            catch
            {
                bitmap.Dispose();
                throw;
            }
        }

        private static bool TryCaptureWithLayeredWindows(Graphics graphics, Rectangle virtualBounds, Screen[] screens)
        {
            IntPtr sourceDc = IntPtr.Zero;
            IntPtr destinationDc = IntPtr.Zero;
            try
            {
                sourceDc = GetDC(IntPtr.Zero);
                if (sourceDc == IntPtr.Zero)
                    return false;

                destinationDc = graphics.GetHdc();
                foreach (Screen screen in screens)
                {
                    Rectangle monitor = screen.Bounds;
                    if (!BitBlt(
                        destinationDc,
                        monitor.Left - virtualBounds.Left,
                        monitor.Top - virtualBounds.Top,
                        monitor.Width,
                        monitor.Height,
                        sourceDc,
                        monitor.Left,
                        monitor.Top,
                        SourceCopy | CaptureBlt))
                        return false;
                }
                return true;
            }
            finally
            {
                if (destinationDc != IntPtr.Zero)
                    graphics.ReleaseHdc(destinationDc);
                if (sourceDc != IntPtr.Zero)
                    ReleaseDC(IntPtr.Zero, sourceDc);
            }
        }
    }

    internal static class QualityProcessor
    {
        private const long MaxOutputPixels = 16000000L;
        private const long MaxAutoMicroOutputPixels = 4000000L;
        private const long MaxAutoTwoXOutputPixels = 8500000L;
        private const int MaxOutputDimension = 32760;
        private const int MaxAutoOutputDimension = 4096;
        private const int MaxAutoScale = 12;
        private const int ParallelOutputPixelThreshold = 1500000;
        private const int MaxScaleWorkers = 4;

        private struct ScaleMap
        {
            internal int A;
            internal int B;
            internal int C;
            internal int D;
            internal float Wa;
            internal float Wb;
            internal float Wc;
            internal float Wd;
        }

        internal static string GetModeName(int scale)
        {
            if (scale >= 7) return "XXL " + scale + "\u00D7";
            if (scale >= 4) return "Max " + scale + "\u00D7";
            if (scale == 3) return "Ultra 3\u00D7";
            if (scale == 2) return "Crisp 2\u00D7";
            return "Native 1\u00D7";
        }

        internal static string GetDecisionName(int requestedMode, int effectiveScale)
        {
            string mode = GetModeName(effectiveScale);
            return requestedMode == 0 ? "Auto: " + mode : mode;
        }

        internal static int ResolveScale(int width, int height, int requestedMode)
        {
            return requestedMode == 0
                ? GetAutoScale(width, height)
                : GetSafeScale(width, height, requestedMode);
        }

        internal static int GetAutoScale(int width, int height)
        {
            if (width < 1 || height < 1)
                return 1;

            // Micro crops can use any whole-number scale up to 12x while their
            // output remains within the original fast 4 MP / 4096 px budget.
            // Trying every integer avoids large quality cliffs such as 6x -> 3x.
            for (int scale = MaxAutoScale; scale >= 3; scale--)
            {
                if (OutputFits(width, height, scale, MaxAutoMicroOutputPixels, MaxAutoOutputDimension))
                    return scale;
            }

            // Normal 1080p-class selections may become a 4K-class 2x image.
            // This separate ceiling keeps expensive high-factor micro outputs
            // tightly bounded while making ordinary screenshots denser.
            if (OutputFits(width, height, 2, MaxAutoTwoXOutputPixels, MaxAutoOutputDimension))
                return 2;
            return 1;
        }

        private static int GetSafeResolvedScale(int width, int height, int resolvedScale)
        {
            if (width < 1 || height < 1)
                return 1;

            int scale = Math.Max(1, Math.Min(MaxAutoScale, resolvedScale));
            while (scale > 1 && !OutputFits(width, height, scale, MaxOutputPixels, MaxOutputDimension))
                scale--;
            return scale;
        }

        internal static int GetSafeScale(int width, int height, int requestedScale)
        {
            if (width < 1 || height < 1)
                return 1;

            int scale = NormalizeScale(requestedScale);
            while (scale > 1 && !OutputFits(width, height, scale, MaxOutputPixels, MaxOutputDimension))
                scale = NextLowerScale(scale);
            return scale;
        }

        private static int NormalizeScale(int requestedScale)
        {
            if (requestedScale >= 6) return 6;
            if (requestedScale >= 3) return 3;
            if (requestedScale >= 2) return 2;
            return 1;
        }

        private static int NextLowerScale(int scale)
        {
            if (scale >= 6) return 3;
            if (scale >= 3) return 2;
            return 1;
        }

        private static bool OutputFits(
            int width,
            int height,
            int scale,
            long maximumPixels,
            int maximumDimension)
        {
            long outputWidth = (long)width * scale;
            long outputHeight = (long)height * scale;
            if (outputWidth < 1 || outputHeight < 1 ||
                outputWidth > maximumDimension || outputHeight > maximumDimension)
                return false;
            return outputWidth <= maximumPixels / outputHeight;
        }

        internal static Bitmap Process(Bitmap source, int scale)
        {
            scale = GetSafeScale(source.Width, source.Height, scale);
            if (scale == 1)
            {
                Bitmap exact = source.Clone(new Rectangle(0, 0, source.Width, source.Height), PixelFormat.Format32bppArgb);
                exact.SetResolution(96.0f, 96.0f);
                return exact;
            }

            return ResizeClampedCatmullRom(source, scale);
        }

        // The capture pipeline transfers ownership here so native, high-resolution
        // crops do not need a second full-size bitmap copy.
        internal static Bitmap ProcessOwned(Bitmap source, int scale)
        {
            scale = GetSafeScale(source.Width, source.Height, scale);
            return ProcessResolvedOwned(source, scale);
        }

        // The capture UI has already resolved Auto or a manual safety fallback.
        // Preserve that exact scale, including Auto's intermediate 4x..12x tiers.
        internal static Bitmap ProcessResolvedOwned(Bitmap source, int scale)
        {
            scale = GetSafeResolvedScale(source.Width, source.Height, scale);
            if (scale == 1)
            {
                try
                {
                    source.SetResolution(96.0f, 96.0f);
                    return source;
                }
                catch
                {
                    source.Dispose();
                    throw;
                }
            }

            try
            {
                return ResizeClampedCatmullRom(source, scale);
            }
            finally
            {
                source.Dispose();
            }
        }

        private static Bitmap ResizeClampedCatmullRom(Bitmap source, int scale)
        {
            int width = source.Width * scale;
            int height = source.Height * scale;
            ScaleMap[] mapX = BuildScaleMap(source.Width, width);
            ScaleMap[] mapY = BuildScaleMap(source.Height, height);
            PixelFormat workingFormat = source.PixelFormat == PixelFormat.Format24bppRgb
                ? PixelFormat.Format24bppRgb
                : PixelFormat.Format32bppArgb;
            int channels = workingFormat == PixelFormat.Format24bppRgb ? 3 : 4;
            Bitmap resized = new Bitmap(width, height, workingFormat);
            try
            {
                resized.SetResolution(96.0f * scale, 96.0f * scale);
                Rectangle sourceBounds = new Rectangle(0, 0, source.Width, source.Height);
                Rectangle targetBounds = new Rectangle(0, 0, width, height);
                BitmapData sourceData = source.LockBits(sourceBounds, ImageLockMode.ReadOnly, workingFormat);
                BitmapData targetData = null;
                try
                {
                    targetData = resized.LockBits(targetBounds, ImageLockMode.WriteOnly, workingFormat);
                    int sourceRowBytes = Math.Abs(sourceData.Stride);
                    int targetRowBytes = Math.Abs(targetData.Stride);
                    int workerCount = GetScaleWorkerCount((long)width * height);
                    if (workerCount == 1)
                    {
                        ProcessTargetRows(
                            0, height, sourceData, targetData, sourceRowBytes, targetRowBytes,
                            channels, mapX, mapY);
                    }
                    else
                    {
                        ParallelOptions options = new ParallelOptions();
                        options.MaxDegreeOfParallelism = workerCount;
                        Parallel.For(0, workerCount, options, delegate(int worker)
                        {
                            int firstRow = height * worker / workerCount;
                            int endRow = height * (worker + 1) / workerCount;
                            ProcessTargetRows(
                                firstRow, endRow, sourceData, targetData, sourceRowBytes, targetRowBytes,
                                channels, mapX, mapY);
                        });
                    }
                }
                finally
                {
                    try
                    {
                        if (targetData != null)
                            resized.UnlockBits(targetData);
                    }
                    finally
                    {
                        source.UnlockBits(sourceData);
                    }
                }
                return resized;
            }
            catch
            {
                resized.Dispose();
                throw;
            }
        }

        private static int GetScaleWorkerCount(long outputPixels)
        {
            if (outputPixels < ParallelOutputPixelThreshold || Environment.ProcessorCount < 2)
                return 1;
            return Math.Min(MaxScaleWorkers, Environment.ProcessorCount);
        }

        private static void ProcessTargetRows(
            int firstRow,
            int endRow,
            BitmapData sourceData,
            BitmapData targetData,
            int sourceRowBytes,
            int targetRowBytes,
            int channels,
            ScaleMap[] mapX,
            ScaleMap[] mapY)
        {
            int[] cacheKeys = new int[] { -1, -1, -1, -1 };
            byte[][] sourceRows = new byte[4][];
            float[][] horizontalRows = new float[4][];
            for (int slot = 0; slot < 4; slot++)
            {
                sourceRows[slot] = new byte[sourceRowBytes];
                horizontalRows[slot] = new float[mapX.Length * channels];
            }
            byte[] outputRow = new byte[targetRowBytes];

            for (int y = firstRow; y < endRow; y++)
            {
                ScaleMap vertical = mapY[y];
                int slotA = EnsureHorizontalRow(vertical.A, vertical, sourceData,
                    sourceRowBytes, channels, mapX, cacheKeys, sourceRows, horizontalRows);
                int slotB = EnsureHorizontalRow(vertical.B, vertical, sourceData,
                    sourceRowBytes, channels, mapX, cacheKeys, sourceRows, horizontalRows);
                int slotC = EnsureHorizontalRow(vertical.C, vertical, sourceData,
                    sourceRowBytes, channels, mapX, cacheKeys, sourceRows, horizontalRows);
                int slotD = EnsureHorizontalRow(vertical.D, vertical, sourceData,
                    sourceRowBytes, channels, mapX, cacheKeys, sourceRows, horizontalRows);

                for (int x = 0; x < mapX.Length; x++)
                {
                    ScaleMap horizontal = mapX[x];
                    int targetPixel = x * channels;
                    int sourceLeft = horizontal.B * channels;
                    int sourceRight = horizontal.C * channels;
                    for (int channel = 0; channel < channels; channel++)
                    {
                        int component = targetPixel + channel;
                        float value =
                            horizontalRows[slotA][component] * vertical.Wa +
                            horizontalRows[slotB][component] * vertical.Wb +
                            horizontalRows[slotC][component] * vertical.Wc +
                            horizontalRows[slotD][component] * vertical.Wd;

                        int topLeft = sourceRows[slotB][sourceLeft + channel];
                        int topRight = sourceRows[slotB][sourceRight + channel];
                        int bottomLeft = sourceRows[slotC][sourceLeft + channel];
                        int bottomRight = sourceRows[slotC][sourceRight + channel];
                        int minimum = Math.Min(Math.Min(topLeft, topRight), Math.Min(bottomLeft, bottomRight));
                        int maximum = Math.Max(Math.Max(topLeft, topRight), Math.Max(bottomLeft, bottomRight));
                        if (value <= minimum)
                        {
                            outputRow[component] = (byte)minimum;
                        }
                        else if (value >= maximum)
                        {
                            outputRow[component] = (byte)maximum;
                        }
                        else
                        {
                            // Inline midpoint-to-even rounding preserves Math.Round's
                            // pixels without its per-channel call overhead.
                            int floor = (int)value;
                            float fraction = value - floor;
                            int rounded = fraction > 0.5f ||
                                          (fraction == 0.5f && (floor & 1) != 0)
                                ? floor + 1
                                : floor;
                            outputRow[component] = (byte)rounded;
                        }
                    }
                }

                Marshal.Copy(outputRow, 0, GetRowPointer(targetData, y), targetRowBytes);
            }
        }

        private static int EnsureHorizontalRow(
            int sourceY,
            ScaleMap neededRows,
            BitmapData sourceData,
            int sourceRowBytes,
            int channels,
            ScaleMap[] mapX,
            int[] cacheKeys,
            byte[][] sourceRows,
            float[][] horizontalRows)
        {
            for (int slot = 0; slot < cacheKeys.Length; slot++)
            {
                if (cacheKeys[slot] == sourceY)
                    return slot;
            }

            int replacement = -1;
            for (int slot = 0; slot < cacheKeys.Length; slot++)
            {
                if (cacheKeys[slot] < 0 || !ContainsRow(neededRows, cacheKeys[slot]))
                {
                    replacement = slot;
                    break;
                }
            }
            if (replacement < 0)
                throw new InvalidOperationException("The scaling row cache could not advance.");

            byte[] sourceRow = sourceRows[replacement];
            float[] horizontalRow = horizontalRows[replacement];
            Marshal.Copy(GetRowPointer(sourceData, sourceY), sourceRow, 0, sourceRowBytes);
            for (int x = 0; x < mapX.Length; x++)
            {
                ScaleMap horizontal = mapX[x];
                int outputPixel = x * channels;
                int a = horizontal.A * channels;
                int b = horizontal.B * channels;
                int c = horizontal.C * channels;
                int d = horizontal.D * channels;
                for (int channel = 0; channel < channels; channel++)
                {
                    horizontalRow[outputPixel + channel] =
                        sourceRow[a + channel] * horizontal.Wa +
                        sourceRow[b + channel] * horizontal.Wb +
                        sourceRow[c + channel] * horizontal.Wc +
                        sourceRow[d + channel] * horizontal.Wd;
                }
            }
            cacheKeys[replacement] = sourceY;
            return replacement;
        }

        private static bool ContainsRow(ScaleMap map, int row)
        {
            return map.A == row || map.B == row || map.C == row || map.D == row;
        }

        private static ScaleMap[] BuildScaleMap(int sourceSize, int targetSize)
        {
            ScaleMap[] result = new ScaleMap[targetSize];
            double scale = targetSize / (double)sourceSize;
            for (int target = 0; target < targetSize; target++)
            {
                double position = (target + 0.5) / scale - 0.5;
                int left = (int)Math.Floor(position);
                double fraction = position - left;
                result[target] = new ScaleMap
                {
                    A = MirrorIndex(left - 1, sourceSize),
                    B = MirrorIndex(left, sourceSize),
                    C = MirrorIndex(left + 1, sourceSize),
                    D = MirrorIndex(left + 2, sourceSize),
                    Wa = CubicWeight((float)(1.0 + fraction)),
                    Wb = CubicWeight((float)fraction),
                    Wc = CubicWeight((float)(1.0 - fraction)),
                    Wd = CubicWeight((float)(2.0 - fraction))
                };
            }
            return result;
        }

        private static float CubicWeight(float distance)
        {
            float x = Math.Abs(distance);
            if (x < 1.0f)
                return 1.5f * x * x * x - 2.5f * x * x + 1.0f;
            if (x < 2.0f)
                return -0.5f * x * x * x + 2.5f * x * x - 4.0f * x + 2.0f;
            return 0.0f;
        }

        private static int MirrorIndex(int value, int size)
        {
            if (size <= 1)
                return 0;
            while (value < 0 || value >= size)
            {
                if (value < 0)
                    value = -value - 1;
                if (value >= size)
                    value = size * 2 - value - 1;
            }
            return value;
        }

        private static IntPtr GetRowPointer(BitmapData data, int row)
        {
            return new IntPtr(data.Scan0.ToInt64() + (long)row * data.Stride);
        }
    }

    internal struct PngPayload
    {
        internal readonly byte[] Buffer;
        internal readonly int Length;

        internal PngPayload(byte[] buffer, int length)
        {
            Buffer = buffer;
            Length = length;
        }

        internal void WriteTo(Stream destination)
        {
            destination.Write(Buffer, 0, Length);
        }
    }

    internal static class PngEncoder
    {
        internal static PngPayload Encode(Bitmap bitmap)
        {
            using (MemoryStream stream = new MemoryStream())
            {
                bitmap.Save(stream, ImageFormat.Png);
                return new PngPayload(stream.GetBuffer(), checked((int)stream.Length));
            }
        }
    }

    internal static class ClipboardWriter
    {
        internal static bool TrySetPng(Bitmap bitmap, PngPayload png)
        {
            try
            {
                using (MemoryStream pngStream = new MemoryStream(png.Buffer, 0, png.Length, false))
                using (MemoryStream mimePngStream = new MemoryStream(png.Buffer, 0, png.Length, false))
                {
                    DataObject data = new DataObject();
                    data.SetData("PNG", false, pngStream);
                    data.SetData("image/png", false, mimePngStream);
                    data.SetData(DataFormats.Bitmap, true, bitmap);
                    // This overload performs its own bounded clipboard-busy retries.
                    Clipboard.SetDataObject(data, true, 6, 60);
                }
                return true;
            }
            catch (ExternalException) { return false; }
        }
    }

    internal static class ScreenshotStorage
    {
        internal static string GetFolder()
        {
            string pictures = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
            if (String.IsNullOrEmpty(pictures))
                pictures = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            return Path.Combine(pictures, "SharpShot");
        }

        internal static string Save(PngPayload png, int width, int height)
        {
            string folder = GetFolder();
            Directory.CreateDirectory(folder);
            string baseName = "Screenshot " + DateTime.Now.ToString("yyyy-MM-dd 'at' HH.mm.ss") +
                              " - " + width + "x" + height;
            string path = Path.Combine(folder, baseName + ".png");
            int suffix = 2;
            while (File.Exists(path))
            {
                path = Path.Combine(folder, baseName + " (" + suffix + ").png");
                suffix++;
            }
            using (FileStream file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                png.WriteTo(file);
            return path;
        }
    }

    internal sealed class AppSettings
    {
        internal int QualityScale = 0;
        internal bool AutoSave = true;
        internal bool PasteAtSelectionSize = true;

        private static string SettingsPath
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "SharpShot",
                    "settings.ini");
            }
        }

        internal static AppSettings Load()
        {
            AppSettings settings = new AppSettings();
            try
            {
                if (!File.Exists(SettingsPath))
                    return settings;
                string[] lines = File.ReadAllLines(SettingsPath);
                foreach (string raw in lines)
                {
                    string line = raw.Trim();
                    int split = line.IndexOf('=');
                    if (split < 1) continue;
                    string key = line.Substring(0, split).Trim();
                    string value = line.Substring(split + 1).Trim();
                    if (String.Equals(key, "qualityScale", StringComparison.OrdinalIgnoreCase))
                    {
                        int parsed;
                        if (Int32.TryParse(value, out parsed) &&
                            ((parsed >= 0 && parsed <= 3) || parsed == 6))
                            settings.QualityScale = parsed;
                    }
                    else if (String.Equals(key, "autoSave", StringComparison.OrdinalIgnoreCase))
                    {
                        bool parsed;
                        if (Boolean.TryParse(value, out parsed))
                            settings.AutoSave = parsed;
                    }
                    else if (String.Equals(key, "pasteAtSelectionSize", StringComparison.OrdinalIgnoreCase))
                    {
                        bool parsed;
                        if (Boolean.TryParse(value, out parsed))
                            settings.PasteAtSelectionSize = parsed;
                    }
                }
            }
            catch { }
            return settings;
        }

        internal void Save()
        {
            try
            {
                string folder = Path.GetDirectoryName(SettingsPath);
                Directory.CreateDirectory(folder);
                File.WriteAllLines(SettingsPath, new string[]
                {
                    "qualityScale=" + QualityScale,
                    "autoSave=" + AutoSave,
                    "pasteAtSelectionSize=" + PasteAtSelectionSize
                });
            }
            catch { }
        }
    }

    internal static class StartupManager
    {
        private const string RunKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        private const string ValueName = "SharpShot";

        internal static bool IsEnabled()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKey, false))
                {
                    if (key == null) return false;
                    string value = key.GetValue(ValueName) as string;
                    if (String.IsNullOrEmpty(value)) return false;
                    string registeredPath = ExtractExecutablePath(value);
                    return String.Equals(
                        Path.GetFullPath(registeredPath),
                        Path.GetFullPath(Application.ExecutablePath),
                        StringComparison.OrdinalIgnoreCase);
                }
            }
            catch { return false; }
        }

        internal static void SetEnabled(bool enabled)
        {
            RegistryKey opened = enabled
                ? Registry.CurrentUser.CreateSubKey(RunKey)
                : Registry.CurrentUser.OpenSubKey(RunKey, true);
            using (RegistryKey key = opened)
            {
                if (key == null)
                    throw new InvalidOperationException("Windows would not open the current-user startup list.");
                if (enabled)
                    key.SetValue(ValueName, "\"" + Application.ExecutablePath + "\" --startup");
                else
                    key.DeleteValue(ValueName, false);
            }
        }

        private static string ExtractExecutablePath(string command)
        {
            string value = command.Trim();
            if (value.StartsWith("\"", StringComparison.Ordinal))
            {
                int closingQuote = value.IndexOf('"', 1);
                if (closingQuote > 1)
                    return value.Substring(1, closingQuote - 1);
            }
            int firstSpace = value.IndexOf(' ');
            return firstSpace > 0 ? value.Substring(0, firstSpace) : value;
        }
    }

    internal static class RuntimeStatus
    {
        private static string StatusPath
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "SharpShot",
                    "status.ini");
            }
        }

        internal static void Write(string screenshotHotkey, string recordingHotkey)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(StatusPath));
                File.WriteAllLines(StatusPath, new string[]
                {
                    "pid=" + Process.GetCurrentProcess().Id,
                    "hotkey=" + screenshotHotkey,
                    "recordingHotkey=" + recordingHotkey,
                    "startedUtc=" + DateTime.UtcNow.ToString("O"),
                    "mode=idle-message-loop"
                });
            }
            catch { }
        }

        internal static void Clear()
        {
            try
            {
                if (!File.Exists(StatusPath)) return;
                string expected = "pid=" + Process.GetCurrentProcess().Id;
                string[] lines = File.ReadAllLines(StatusPath);
                foreach (string line in lines)
                {
                    if (String.Equals(line.Trim(), expected, StringComparison.OrdinalIgnoreCase))
                    {
                        File.Delete(StatusPath);
                        return;
                    }
                }
            }
            catch { }
        }
    }

    internal static class IconFactory
    {
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool DestroyIcon(IntPtr handle);

        internal static Icon CreateTrayIcon()
        {
            using (Bitmap bitmap = new Bitmap(32, 32, PixelFormat.Format32bppArgb))
            using (Graphics g = Graphics.FromImage(bitmap))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (SolidBrush tile = new SolidBrush(Color.FromArgb(16, 20, 25)))
                    g.FillRoundedRectangle(tile, new Rectangle(1, 1, 30, 30), 7);
                using (Pen pen = new Pen(Color.FromArgb(202, 255, 70), 2.6f))
                {
                    pen.StartCap = LineCap.Square;
                    pen.EndCap = LineCap.Square;
                    g.DrawLine(pen, 8, 13, 8, 8);
                    g.DrawLine(pen, 8, 8, 13, 8);
                    g.DrawLine(pen, 19, 8, 24, 8);
                    g.DrawLine(pen, 24, 8, 24, 13);
                    g.DrawLine(pen, 8, 19, 8, 24);
                    g.DrawLine(pen, 8, 24, 13, 24);
                    g.DrawLine(pen, 19, 24, 24, 24);
                    g.DrawLine(pen, 24, 19, 24, 24);
                }
                using (SolidBrush dot = new SolidBrush(Color.White))
                    g.FillEllipse(dot, 14, 14, 4, 4);

                IntPtr handle = bitmap.GetHicon();
                try
                {
                    using (Icon temporary = Icon.FromHandle(handle))
                        return (Icon)temporary.Clone();
                }
                finally
                {
                    DestroyIcon(handle);
                }
            }
        }

        private static void FillRoundedRectangle(this Graphics graphics, Brush brush, Rectangle bounds, int radius)
        {
            int diameter = radius * 2;
            using (GraphicsPath path = new GraphicsPath())
            {
                path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
                path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
                path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
                path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
                path.CloseFigure();
                graphics.FillPath(brush, path);
            }
        }
    }

    internal static class SelfTest
    {
        internal static int Run(string outputFolder, bool includeLiveCapture)
        {
            List<string> report = new List<string>();
            report.Add("SharpShot self-test");
            report.Add("UTC: " + DateTime.UtcNow.ToString("O"));
            try
            {
                Directory.CreateDirectory(outputFolder);

                using (Bitmap pattern = CreatePattern())
                {
                    string nativePath = Path.Combine(outputFolder, "pattern-native.png");
                    PngPayload nativePng = PngEncoder.Encode(pattern);
                    using (FileStream nativeFile = new FileStream(nativePath, FileMode.Create, FileAccess.Write, FileShare.Read))
                        nativePng.WriteTo(nativeFile);
                    VerifyPng(nativePath);
                    using (Bitmap exact = QualityProcessor.Process(pattern, 1))
                    {
                        if (!PixelsEqual(pattern, exact))
                            throw new InvalidOperationException("Native 1x changed source pixels.");
                        report.Add("PASS: Native 1x is pixel-exact");
                    }
                    Bitmap ownedNative = pattern.Clone(
                        new Rectangle(0, 0, pattern.Width, pattern.Height),
                        PixelFormat.Format32bppArgb);
                    using (Bitmap ownedExact = QualityProcessor.ProcessOwned(ownedNative, 1))
                    {
                        if (!Object.ReferenceEquals(ownedNative, ownedExact) || !PixelsEqual(pattern, ownedExact))
                            throw new InvalidOperationException("Owned native processing made an unnecessary copy.");
                        report.Add("PASS: owned native processing reuses the exact crop bitmap");
                    }
                    using (Bitmap crisp = QualityProcessor.Process(pattern, 2))
                    {
                        if (crisp.Width != pattern.Width * 2 || crisp.Height != pattern.Height * 2)
                            throw new InvalidOperationException("2x output dimensions are wrong.");
                        string crispPath = Path.Combine(outputFolder, "pattern-crisp-2x.png");
                        crisp.Save(crispPath, ImageFormat.Png);
                        VerifyPng(crispPath);
                        if (Math.Abs(crisp.HorizontalResolution - 192.0f) > 1.0f)
                            throw new InvalidOperationException("2x DPI metadata is wrong.");
                        VerifyNoNewChannelExtrema(pattern, crisp, 2);
                        report.Add("PASS: native test pattern encoded as PNG");
                        report.Add("PASS: Crisp 2x produced " + crisp.Width + " x " + crisp.Height);
                    }

                    using (Bitmap ultra = QualityProcessor.Process(pattern, 3))
                    {
                        if (ultra.Width != pattern.Width * 3 || ultra.Height != pattern.Height * 3)
                            throw new InvalidOperationException("3x output dimensions are wrong.");
                        string ultraPath = Path.Combine(outputFolder, "pattern-ultra-3x.png");
                        ultra.Save(ultraPath, ImageFormat.Png);
                        VerifyPng(ultraPath);
                        VerifyNoNewChannelExtrema(pattern, ultra, 3);
                        report.Add("PASS: Ultra 3x produced " + ultra.Width + " x " + ultra.Height);
                    }

                    Bitmap ownedMaximum = pattern.Clone(
                        new Rectangle(0, 0, pattern.Width, pattern.Height),
                        PixelFormat.Format32bppArgb);
                    using (Bitmap maximum = QualityProcessor.ProcessOwned(ownedMaximum, 6))
                    {
                        if (maximum.Width != pattern.Width * 6 || maximum.Height != pattern.Height * 6)
                            throw new InvalidOperationException("6x output dimensions are wrong.");
                        string maximumPath = Path.Combine(outputFolder, "pattern-max-6x.png");
                        maximum.Save(maximumPath, ImageFormat.Png);
                        VerifyPng(maximumPath);
                        if (Math.Abs(maximum.HorizontalResolution - 576.0f) > 1.0f)
                            throw new InvalidOperationException("6x DPI metadata is wrong.");
                        VerifyNoNewChannelExtrema(pattern, maximum, 6);
                        report.Add("PASS: Max 6x produced " + maximum.Width + " x " + maximum.Height);
                    }

                    Bitmap ownedTiny = pattern.Clone(
                        new Rectangle(0, 0, 80, 48),
                        PixelFormat.Format32bppArgb);
                    using (Bitmap xxl = QualityProcessor.ProcessResolvedOwned(ownedTiny, 12))
                    {
                        if (xxl.Width != 960 || xxl.Height != 576)
                            throw new InvalidOperationException("12x output dimensions are wrong.");
                        string xxlPath = Path.Combine(outputFolder, "pattern-xxl-12x.png");
                        xxl.Save(xxlPath, ImageFormat.Png);
                        VerifyPng(xxlPath);
                        if (Math.Abs(xxl.HorizontalResolution - 1152.0f) > 1.0f)
                            throw new InvalidOperationException("12x DPI metadata is wrong.");
                        using (Bitmap tinySource = pattern.Clone(
                            new Rectangle(0, 0, 80, 48),
                            PixelFormat.Format32bppArgb))
                            VerifyNoNewChannelExtrema(tinySource, xxl, 12);
                        report.Add("PASS: Auto XXL 12x produced " + xxl.Width + " x " + xxl.Height);
                    }

                    VerifyOverlayPreviewIsUnscaled(pattern);
                    report.Add("PASS: overlay and selection stay pixel-aligned at 125% DPI");
                }

                VerifyFlatColorPreserved();
                report.Add("PASS: clamped enlargement preserves flat colors and introduces no channel halos");

                VerifyOpaque24BitPipeline();
                report.Add("PASS: opaque capture path preserves RGB while skipping redundant alpha work");

                VerifyIndependentPasteAndSavePayloads();
                report.Add("PASS: chat-sized paste and enlarged auto-save retain independent dimensions and DPI");

                if (!new AppSettings().PasteAtSelectionSize)
                    throw new InvalidOperationException("Chat-sized paste is not the default for new settings.");
                report.Add("PASS: chat-sized paste is enabled by default");

                VerifyAutoScaleBoundaries();
                report.Add("PASS: Auto Crisp scale boundaries are deterministic");

                VerifyStudioCommandReader();
                report.Add("PASS: Studio recording stops on command, parent stdin EOF, or stdin error");

                VerifyOptionalRecordingArtifactFailure(outputFolder);
                report.Add("PASS: optional cursor metadata failure preserves finalized recording media");

                VerifyRecordingPolicy(outputFolder);
                report.Add("PASS: recording source-to-output, cursor, and Studio clipboard policy is deterministic");
                StudioHotkeyHostSelfTest.Verify();
                report.Add("PASS: Studio hotkey host protocol and exact-chord policy are deterministic");
                VerifyDesktopDuplicationInterop();
                report.Add("PASS: Desktop Duplication interop layouts match the x64 Windows ABI");
                AudioRecordingSelfTest.Verify(outputFolder);
                report.Add("PASS: bounded audio timing and RIFF/RF64-ready WAV stems are deterministic");
                CursorMetadataProbeResult cursorProbe =
                    CursorMetadataRecorder.RunProbe(outputFolder, includeLiveCapture);
                report.Add(
                    "PASS: editable cursor metadata is atomic, normalized, and " +
                    (includeLiveCapture ? "live-sampled" : "synthetically sampled") + " at " +
                    cursorProbe.NanosecondsPerSample.ToString("0") +
                    " ns/frame probe overhead (" + cursorProbe.Iterations + " iterations)");

                if (QualityProcessor.GetSafeScale(4000, 3000, 6) != 1 ||
                    QualityProcessor.GetSafeScale(2000, 2000, 6) != 2 ||
                    QualityProcessor.GetSafeScale(667, 667, 6) != 3 ||
                    QualityProcessor.GetSafeScale(666, 666, 6) != 6 ||
                    QualityProcessor.GetSafeScale(5460, 1, 6) != 6 ||
                    QualityProcessor.GetSafeScale(5461, 1, 6) != 3 ||
                    QualityProcessor.GetSafeScale(Int32.MaxValue, Int32.MaxValue, 6) != 1 ||
                    QualityProcessor.GetSafeScale(0, 100, 6) != 1 ||
                    QualityProcessor.GetSafeScale(-1, 100, 6) != 1)
                    throw new InvalidOperationException("Large-output memory cap did not lower the scale.");
                if (QualityProcessor.ResolveScale(4000, 3000, 0) != 1)
                    throw new InvalidOperationException("Auto Crisp did not remain native for a large selection.");
                report.Add("PASS: large-output memory cap lowers unsafe scale");

                if (includeLiveCapture)
                {
                    Rectangle desktopBounds;
                    using (Bitmap desktop = ScreenCapture.CaptureVirtualDesktop(out desktopBounds))
                    {
                        if (desktop.Width < 1 || desktop.Height < 1)
                            throw new InvalidOperationException("Desktop capture is empty.");
                        int width = Math.Min(192, desktop.Width);
                        int height = Math.Min(128, desktop.Height);
                        if (desktop.GetPixel(width - 1, height - 1).A != 255)
                            throw new InvalidOperationException("Desktop capture has a non-opaque alpha channel.");
                        report.Add("PASS: virtual desktop capture returned " + desktop.Width + " x " + desktop.Height);
                    }
                    VerifyLiveRecordingCodec(outputFolder, desktopBounds);
                    report.Add("PASS: live desktop frames encoded and finalized as H.264 MP4");
                    AudioRecordingSelfTest.VerifyLive(outputFolder);
                    report.Add("PASS: live event-driven WASAPI loopback captured and finalized a WAV stem");
                }
                else
                {
                    report.Add("SKIP: live desktop capture was not requested");
                }

                report.Add("RESULT: PASS");
                File.WriteAllLines(Path.Combine(outputFolder, "self-test.txt"), report.ToArray());
                return 0;
            }
            catch (Exception ex)
            {
                report.Add("RESULT: FAIL");
                report.Add(ex.ToString());
                try
                {
                    Directory.CreateDirectory(outputFolder);
                    File.WriteAllLines(Path.Combine(outputFolder, "self-test.txt"), report.ToArray());
                }
                catch { }
                return 1;
            }
        }

        private static Bitmap CreatePattern()
        {
            Bitmap bitmap = new Bitmap(160, 96, PixelFormat.Format32bppArgb);
            bitmap.SetResolution(96.0f, 96.0f);
            using (Graphics g = Graphics.FromImage(bitmap))
            {
                g.Clear(Color.FromArgb(12, 16, 20));
                using (SolidBrush white = new SolidBrush(Color.White))
                using (SolidBrush lime = new SolidBrush(Color.FromArgb(202, 255, 70)))
                using (Font font = new Font("Segoe UI", 14.0f, FontStyle.Bold, GraphicsUnit.Pixel))
                {
                    g.FillRectangle(lime, 8, 8, 44, 30);
                    g.DrawString("1:1", font, white, 62, 11);
                    g.FillRectangle(white, 8, 50, 1, 32);
                    g.FillRectangle(white, 16, 50, 2, 32);
                    g.FillRectangle(white, 27, 50, 3, 32);
                    g.FillRectangle(lime, 42, 50, 70, 1);
                    g.FillRectangle(lime, 42, 60, 70, 2);
                    g.FillRectangle(lime, 42, 72, 70, 3);
                }
            }
            return bitmap;
        }

        private static void VerifyPng(string path)
        {
            byte[] data = File.ReadAllBytes(path);
            byte[] signature = new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 };
            byte[] endChunk = new byte[] { 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130 };
            if (data.Length < signature.Length)
                throw new InvalidDataException("PNG output is too short: " + path);
            for (int i = 0; i < signature.Length; i++)
            {
                if (data[i] != signature[i])
                    throw new InvalidDataException("PNG signature is invalid: " + path);
            }
            if (data.Length < endChunk.Length)
                throw new InvalidDataException("PNG output has no IEND chunk: " + path);
            for (int i = 0; i < endChunk.Length; i++)
            {
                if (data[data.Length - endChunk.Length + i] != endChunk[i])
                    throw new InvalidDataException("PNG output has trailing or invalid data: " + path);
            }
        }

        private static bool PixelsEqual(Bitmap left, Bitmap right)
        {
            if (left.Width != right.Width || left.Height != right.Height)
                return false;
            for (int y = 0; y < left.Height; y++)
            {
                for (int x = 0; x < left.Width; x++)
                {
                    if (left.GetPixel(x, y).ToArgb() != right.GetPixel(x, y).ToArgb())
                        return false;
                }
            }
            return true;
        }

        private static void VerifyAutoScaleBoundaries()
        {
            if (QualityProcessor.GetAutoScale(166, 167) != 12 ||
                QualityProcessor.GetAutoScale(167, 167) != 11 ||
                QualityProcessor.GetAutoScale(341, 1) != 12 ||
                QualityProcessor.GetAutoScale(342, 1) != 11 ||
                QualityProcessor.GetAutoScale(200, 150) != 11 ||
                QualityProcessor.GetAutoScale(320, 180) != 8 ||
                QualityProcessor.GetAutoScale(400, 300) != 5 ||
                QualityProcessor.GetAutoScale(640, 360) != 4 ||
                QualityProcessor.GetAutoScale(800, 600) != 2 ||
                QualityProcessor.GetAutoScale(1920, 1080) != 2 ||
                QualityProcessor.GetAutoScale(1967, 1080) != 2 ||
                QualityProcessor.GetAutoScale(1968, 1080) != 1 ||
                QualityProcessor.GetAutoScale(2048, 1) != 2 ||
                QualityProcessor.GetAutoScale(2049, 1) != 1 ||
                QualityProcessor.GetAutoScale(0, 100) != 1 ||
                QualityProcessor.GetAutoScale(Int32.MaxValue, Int32.MaxValue) != 1)
                throw new InvalidOperationException("Auto Crisp threshold behavior changed.");

            int[,] symmetricCases = new int[,]
            {
                { 1, 1 }, { 200, 150 }, { 640, 360 }, { 1920, 1080 }, { 2049, 1 }
            };
            for (int index = 0; index < symmetricCases.GetLength(0); index++)
            {
                int width = symmetricCases[index, 0];
                int height = symmetricCases[index, 1];
                if (QualityProcessor.GetAutoScale(width, height) != QualityProcessor.GetAutoScale(height, width))
                    throw new InvalidOperationException("Auto Crisp changed when width and height were swapped.");
            }
        }

        private static void VerifyRecordingPolicy(string outputFolder)
        {
            Rectangle bounds = new Rectangle(-3840, -2160, 15360, 8640);
            if (!RecordingPolicy.NormalizeSelection(new Rectangle(0, 0, 47, 80), bounds).IsEmpty)
                throw new InvalidOperationException("Recording accepted a selection below its minimum size.");

            Rectangle odd = RecordingPolicy.NormalizeSelection(new Rectangle(7, 9, 101, 99), bounds);
            if (odd != new Rectangle(7, 9, 101, 99) ||
                RecordingPolicy.GetOutputSize(odd.Width, odd.Height) != new Size(100, 98))
                throw new InvalidOperationException(
                    "Recording no longer preserves an odd source selection before encoding.");

            Rectangle fiveK = new Rectangle(100, 200, 5120, 2880);
            Rectangle eightK = new Rectangle(0, 0, 7680, 4320);
            Rectangle portrait = new Rectangle(0, 0, 2880, 5120);
            Rectangle multiMonitor = new Rectangle(-3840, 0, 7680, 2160);
            if (RecordingPolicy.NormalizeSelection(fiveK, bounds) != fiveK ||
                RecordingPolicy.NormalizeSelection(eightK, bounds) != eightK ||
                RecordingPolicy.NormalizeSelection(portrait, bounds) != portrait ||
                RecordingPolicy.NormalizeSelection(multiMonitor, bounds) != multiMonitor)
                throw new InvalidOperationException(
                    "Recording silently cropped an oversized source selection.");
            if (RecordingPolicy.GetOutputSize(fiveK.Width, fiveK.Height) !=
                    new Size(4096, 2304) ||
                RecordingPolicy.GetOutputSize(eightK.Width, eightK.Height) !=
                    new Size(4096, 2304) ||
                RecordingPolicy.GetOutputSize(portrait.Width, portrait.Height) !=
                    new Size(1296, 2304) ||
                RecordingPolicy.GetOutputSize(multiMonitor.Width, multiMonitor.Height) !=
                    new Size(4096, 1152) ||
                RecordingPolicy.GetOutputSize(1920, 1080) != new Size(1920, 1080))
                throw new InvalidOperationException(
                    "Oversized recording downscale dimensions changed.");
            if (!RecordingPolicy.GetOutputSize(Int32.MaxValue, 48).IsEmpty ||
                !RecordingPolicy.GetOutputSize(48, Int32.MaxValue).IsEmpty)
                throw new InvalidOperationException(
                    "An unencodable extreme aspect ratio was silently distorted.");

            string dimensionResultPath = Path.Combine(
                outputFolder, "recording-dimensions-result.ini");
            StudioOneShot.TryWriteResult(
                dimensionResultPath, "completed", "oversize.mp4", 4096, 2304,
                1000, false, null, null, null, null, 7680, 4320);
            string[] dimensionResult = File.ReadAllLines(dimensionResultPath);
            if (Array.IndexOf(dimensionResult, "sourceWidth=7680") < 0 ||
                Array.IndexOf(dimensionResult, "sourceHeight=4320") < 0 ||
                Array.IndexOf(dimensionResult, "width=4096") < 0 ||
                Array.IndexOf(dimensionResult, "height=2304") < 0)
                throw new InvalidDataException(
                    "Studio result omitted recording source-to-output dimensions.");

            if (RecordingPolicy.GetFrameRate(1280, 720) != 60 ||
                RecordingPolicy.GetFrameRate(1282, 720) != 30 ||
                RecordingPolicy.GetFrameRate(1920, 1080) != 30)
                throw new InvalidOperationException("Recording frame-rate policy changed.");

            if (RecordingPolicy.GetBitRate(48, 48, 60) != 4000000 ||
                RecordingPolicy.GetBitRate(10000, 10000, 60) != 50000000)
                throw new InvalidOperationException("Recording bitrate safety limits changed.");

            if (RecordingPolicy.PreferHardwareEncoder(638, 360) ||
                !RecordingPolicy.PreferHardwareEncoder(640, 360))
                throw new InvalidOperationException("Adaptive H.264 encoder threshold changed.");

            RecordingVideoOptions requested60 = new RecordingVideoOptions(
                60, RecordingVideoQuality.High);
            RecordingVideoOptions automatic = new RecordingVideoOptions(
                0, RecordingVideoQuality.Automatic);
            if (RecordingPolicy.ResolveFrameRate(4096, 2304, null) != 30 ||
                RecordingPolicy.ResolveFrameRate(4096, 2304, automatic) != 30 ||
                RecordingPolicy.ResolveFrameRate(4096, 2304, requested60) != 60)
                throw new InvalidOperationException("Explicit recording FPS was not honored.");

            int automaticBitRate = RecordingPolicy.GetBitRate(1920, 1080, 30);
            RecordingVideoOptions balanced = new RecordingVideoOptions(
                0, RecordingVideoQuality.Balanced);
            RecordingVideoOptions high = new RecordingVideoOptions(
                0, RecordingVideoQuality.High);
            RecordingVideoOptions maximumQuality = new RecordingVideoOptions(
                0, RecordingVideoQuality.Maximum);
            if (RecordingPolicy.GetBitRate(1920, 1080, 30, null) != automaticBitRate ||
                RecordingPolicy.GetBitRate(1920, 1080, 30, automatic) != automaticBitRate ||
                RecordingPolicy.GetBitRate(1920, 1080, 30, balanced) != automaticBitRate ||
                RecordingPolicy.GetBitRate(1920, 1080, 30, high) != automaticBitRate * 3 / 2 ||
                RecordingPolicy.GetBitRate(1920, 1080, 30, maximumQuality) != automaticBitRate * 2 ||
                RecordingPolicy.GetBitRate(4096, 2304, 60, maximumQuality) != 50000000)
                throw new InvalidOperationException("Recording quality bitrate policy changed.");

            bool invalidFrameRateRejected = false;
            try
            {
                new RecordingVideoOptions(24, RecordingVideoQuality.Balanced);
            }
            catch (ArgumentOutOfRangeException)
            {
                invalidFrameRateRejected = true;
            }
            if (!invalidFrameRateRejected)
                throw new InvalidOperationException("Unsupported recording FPS was accepted.");

            RecordingCursorPolicy defaultCursor =
                StudioOneShot.ResolveRecordingCursorPolicy(null, null);
            RecordingCursorPolicy hiddenCursor =
                StudioOneShot.ResolveRecordingCursorPolicy("false", "false");
            RecordingCursorPolicy visibleCursor =
                StudioOneShot.ResolveRecordingCursorPolicy("true", "false");
            RecordingCursorPolicy editableCursor =
                StudioOneShot.ResolveRecordingCursorPolicy("false", "true");
            RecordingCursorPolicy independentCursor =
                StudioOneShot.ResolveRecordingCursorPolicy("true", "true");
            if (!defaultCursor.IncludeInVideo || defaultCursor.CaptureEditableMetadata ||
                hiddenCursor.IncludeInVideo || hiddenCursor.CaptureEditableMetadata ||
                !visibleCursor.IncludeInVideo || visibleCursor.CaptureEditableMetadata ||
                editableCursor.IncludeInVideo || !editableCursor.CaptureEditableMetadata ||
                !independentCursor.IncludeInVideo || !independentCursor.CaptureEditableMetadata)
                throw new InvalidOperationException("Recording cursor policy changed.");

            StudioScreenshotClipboardPlan compactClipboard =
                StudioOneShot.ResolveScreenshotClipboardPlan(null, true);
            StudioScreenshotClipboardPlan processedClipboard =
                StudioOneShot.ResolveScreenshotClipboardPlan(null, false);
            StudioScreenshotClipboardPlan disabledCompactClipboard =
                StudioOneShot.ResolveScreenshotClipboardPlan("false", true);
            StudioScreenshotClipboardPlan disabledProcessedClipboard =
                StudioOneShot.ResolveScreenshotClipboardPlan("false", false);
            if (!compactClipboard.CopySelectionSize || compactClipboard.CopyProcessed ||
                processedClipboard.CopySelectionSize || !processedClipboard.CopyProcessed ||
                disabledCompactClipboard.CopySelectionSize ||
                disabledCompactClipboard.CopyProcessed ||
                disabledProcessedClipboard.CopySelectionSize ||
                disabledProcessedClipboard.CopyProcessed)
                throw new InvalidOperationException("Studio screenshot clipboard policy changed.");
        }

        private static void VerifyStudioCommandReader()
        {
            int requested = 0;
            using (StringReader commands = new StringReader("ignored\nstop\n"))
                StudioOneShot.ReadStopCommands(commands, delegate { requested++; });
            if (requested != 1)
                throw new InvalidOperationException("Studio stop command was not handled exactly once.");

            requested = 0;
            using (StringReader eof = new StringReader(String.Empty))
                StudioOneShot.ReadStopCommands(eof, delegate { requested++; });
            if (requested != 1)
                throw new InvalidOperationException("Studio stdin EOF did not stop recording exactly once.");

            requested = 0;
            using (TextReader failed = new FailingStudioCommandReader())
                StudioOneShot.ReadStopCommands(failed, delegate { requested++; });
            if (requested != 1)
                throw new InvalidOperationException("Studio stdin failure did not stop recording exactly once.");
        }

        private static void VerifyOptionalRecordingArtifactFailure(string outputFolder)
        {
            string recordingPath = Path.Combine(
                outputFolder, "optional-cursor-failure-preserves-recording.mp4");
            File.WriteAllBytes(recordingPath, new byte[] { 0, 0, 0, 24 });
            bool sidecarSucceeded = OptionalRecordingArtifact.Try(delegate
            {
                throw new IOException("synthetic cursor sidecar failure");
            });
            if (sidecarSucceeded || !File.Exists(recordingPath))
                throw new InvalidOperationException(
                    "An optional cursor metadata failure removed finalized recording media.");
            File.Delete(recordingPath);
        }

        private sealed class FailingStudioCommandReader : TextReader
        {
            public override string ReadLine()
            {
                throw new IOException("synthetic stdin failure");
            }
        }

        private static void VerifyDesktopDuplicationInterop()
        {
            if (IntPtr.Size != 8 ||
                Marshal.SizeOf(typeof(DxgiOutputDesc)) != 96 ||
                Marshal.SizeOf(typeof(DxgiOutduplFrameInfo)) != 48 ||
                Marshal.SizeOf(typeof(D3d11Texture2dDescription)) != 44 ||
                Marshal.SizeOf(typeof(D3d11MappedSubresource)) != 16 ||
                Marshal.SizeOf(typeof(D3d11Box)) != 24)
                throw new InvalidOperationException("Desktop Duplication interop layout changed.");
        }

        private static void VerifyLiveRecordingCodec(string outputFolder, Rectangle desktopBounds)
        {
            Screen primary = Screen.PrimaryScreen;
            Rectangle available = primary == null
                ? desktopBounds
                : Rectangle.Intersect(desktopBounds, primary.Bounds);
            int width = Math.Min(320, available.Width) & ~1;
            int height = Math.Min(180, available.Height) & ~1;
            if (width < RecordingPolicy.MinimumDimension || height < RecordingPolicy.MinimumDimension)
                throw new InvalidOperationException("The desktop is too small for the recording codec probe.");

            Rectangle region = new Rectangle(available.Left, available.Top, width, height);
            string path = Path.Combine(outputFolder, "recording-codec-probe.mp4");
            if (File.Exists(path)) File.Delete(path);
            try
            {
                const int framesPerSecond = 60;
                int bitRate = RecordingPolicy.GetBitRate(width, height, framesPerSecond);
                using (IRecordingFrameGrabber grabber = RecordingFrameGrabber.Create(region))
                using (MediaFoundationVideoWriter writer = new MediaFoundationVideoWriter(
                    path, width, height, framesPerSecond, bitRate))
                {
                    for (int frame = 0; frame < 30; frame++)
                    {
                        grabber.Capture();
                        long start = frame * 10000000L / framesPerSecond;
                        long end = (frame + 1L) * 10000000L / framesPerSecond;
                        writer.WriteFrame(grabber.Pixels, grabber.ByteCount, start, end - start);
                    }
                    writer.FinalizeFile();
                }

                byte[] file = File.ReadAllBytes(path);
                if (file.Length < 1024 || !ContainsAscii(file, "ftyp") ||
                    !ContainsAscii(file, "mdat") || !ContainsAscii(file, "moov"))
                    throw new InvalidDataException("Media Foundation did not create a complete MP4 container.");
            }
            finally
            {
                try { if (File.Exists(path)) File.Delete(path); }
                catch { }
            }
        }

        private static bool ContainsAscii(byte[] value, string text)
        {
            if (value == null || String.IsNullOrEmpty(text) || value.Length < text.Length)
                return false;
            for (int start = 0; start <= value.Length - text.Length; start++)
            {
                bool matches = true;
                for (int index = 0; index < text.Length; index++)
                {
                    if (value[start + index] != (byte)text[index])
                    {
                        matches = false;
                        break;
                    }
                }
                if (matches) return true;
            }
            return false;
        }

        private static void VerifyOpaque24BitPipeline()
        {
            using (Bitmap source = new Bitmap(37, 23, PixelFormat.Format24bppRgb))
            {
                using (Graphics graphics = Graphics.FromImage(source))
                {
                    graphics.Clear(Color.FromArgb(19, 27, 41));
                    using (SolidBrush lime = new SolidBrush(Color.FromArgb(202, 255, 70)))
                    using (SolidBrush white = new SolidBrush(Color.White))
                    {
                        graphics.FillRectangle(lime, 3, 4, 17, 9);
                        graphics.FillRectangle(white, 25, 2, 1, 18);
                    }
                }

                Bitmap ownedNative = source.Clone(
                    new Rectangle(0, 0, source.Width, source.Height),
                    PixelFormat.Format24bppRgb);
                using (Bitmap native = QualityProcessor.ProcessResolvedOwned(ownedNative, 1))
                {
                    if (!Object.ReferenceEquals(ownedNative, native) ||
                        native.PixelFormat != PixelFormat.Format24bppRgb || !PixelsEqual(source, native))
                        throw new InvalidOperationException("Opaque native capture was copied or converted.");
                }

                Bitmap ownedScaled = source.Clone(
                    new Rectangle(0, 0, source.Width, source.Height),
                    PixelFormat.Format24bppRgb);
                using (Bitmap scaled = QualityProcessor.ProcessResolvedOwned(ownedScaled, 12))
                {
                    if (scaled.PixelFormat != PixelFormat.Format24bppRgb ||
                        scaled.Width != source.Width * 12 || scaled.Height != source.Height * 12)
                        throw new InvalidOperationException("Opaque 12x capture did not stay on the 24-bit path.");
                    VerifyNoNewChannelExtrema(source, scaled, 12);
                    PngPayload png = PngEncoder.Encode(scaled);
                    using (MemoryStream stream = new MemoryStream(png.Buffer, 0, png.Length, false))
                    using (Bitmap decoded = new Bitmap(stream))
                    {
                        if (decoded.Width != scaled.Width || decoded.Height != scaled.Height)
                            throw new InvalidOperationException("Opaque PNG round-trip dimensions changed.");
                    }
                }
            }
        }

        private static void VerifyIndependentPasteAndSavePayloads()
        {
            using (Bitmap source = new Bitmap(20, 15, PixelFormat.Format24bppRgb))
            {
                source.SetResolution(96.0f, 96.0f);
                using (Graphics graphics = Graphics.FromImage(source))
                {
                    graphics.Clear(Color.FromArgb(18, 24, 32));
                    using (SolidBrush accent = new SolidBrush(Color.FromArgb(202, 255, 70)))
                        graphics.FillRectangle(accent, 3, 4, 11, 6);
                }

                PngPayload pastePng = PngEncoder.Encode(source);
                using (MemoryStream pasteStream = new MemoryStream(
                    pastePng.Buffer, 0, pastePng.Length, false))
                using (Bitmap decodedPaste = new Bitmap(pasteStream))
                {
                    if (decodedPaste.Width != 20 || decodedPaste.Height != 15 ||
                        Math.Abs(decodedPaste.HorizontalResolution - 96.0f) > 1.0f)
                        throw new InvalidOperationException("Chat-sized PNG dimensions or DPI changed.");
                }

                Bitmap saveSource = source.Clone(
                    new Rectangle(0, 0, source.Width, source.Height),
                    PixelFormat.Format24bppRgb);
                using (Bitmap enlarged = QualityProcessor.ProcessResolvedOwned(saveSource, 11))
                {
                    PngPayload savedPng = PngEncoder.Encode(enlarged);
                    using (MemoryStream saveStream = new MemoryStream(
                        savedPng.Buffer, 0, savedPng.Length, false))
                    using (Bitmap decodedSave = new Bitmap(saveStream))
                    {
                        if (decodedSave.Width != 220 || decodedSave.Height != 165 ||
                            Math.Abs(decodedSave.HorizontalResolution - 1056.0f) > 2.0f)
                            throw new InvalidOperationException("Enlarged saved PNG dimensions or DPI changed.");
                    }
                }
            }
        }

        private static void VerifyFlatColorPreserved()
        {
            Color flat = Color.FromArgb(255, 37, 91, 143);
            using (Bitmap source = new Bitmap(31, 19, PixelFormat.Format32bppArgb))
            {
                using (Graphics graphics = Graphics.FromImage(source))
                    graphics.Clear(flat);
                using (Bitmap enlarged = QualityProcessor.Process(source, 6))
                {
                    for (int y = 0; y < enlarged.Height; y++)
                    {
                        for (int x = 0; x < enlarged.Width; x++)
                        {
                            if (enlarged.GetPixel(x, y).ToArgb() != flat.ToArgb())
                                throw new InvalidOperationException("Flat-color enlargement introduced a false edge.");
                        }
                    }
                }
            }
        }

        private static void VerifyNoNewChannelExtrema(Bitmap source, Bitmap enlarged, int scale)
        {
            for (int y = 0; y < enlarged.Height; y++)
            {
                int sourceTop;
                int sourceBottom;
                GetCentralSourcePair(y, scale, source.Height, out sourceTop, out sourceBottom);
                for (int x = 0; x < enlarged.Width; x++)
                {
                    int sourceLeft;
                    int sourceRight;
                    GetCentralSourcePair(x, scale, source.Width, out sourceLeft, out sourceRight);
                    Color a = source.GetPixel(sourceLeft, sourceTop);
                    Color b = source.GetPixel(sourceRight, sourceTop);
                    Color c = source.GetPixel(sourceLeft, sourceBottom);
                    Color d = source.GetPixel(sourceRight, sourceBottom);
                    Color actual = enlarged.GetPixel(x, y);
                    VerifyChannelRange(actual.B, a.B, b.B, c.B, d.B);
                    VerifyChannelRange(actual.G, a.G, b.G, c.G, d.G);
                    VerifyChannelRange(actual.R, a.R, b.R, c.R, d.R);
                    VerifyChannelRange(actual.A, a.A, b.A, c.A, d.A);
                }
            }
        }

        private static void GetCentralSourcePair(int target, int scale, int sourceSize, out int first, out int second)
        {
            double position = (target + 0.5) / scale - 0.5;
            int left = (int)Math.Floor(position);
            first = MirrorTestIndex(left, sourceSize);
            second = MirrorTestIndex(left + 1, sourceSize);
        }

        private static int MirrorTestIndex(int value, int size)
        {
            if (size <= 1) return 0;
            while (value < 0 || value >= size)
            {
                if (value < 0) value = -value - 1;
                if (value >= size) value = size * 2 - value - 1;
            }
            return value;
        }

        private static void VerifyChannelRange(int actual, int a, int b, int c, int d)
        {
            int minimum = Math.Min(Math.Min(a, b), Math.Min(c, d));
            int maximum = Math.Max(Math.Max(a, b), Math.Max(c, d));
            if (actual < minimum || actual > maximum)
                throw new InvalidOperationException("Clamped enlargement created a channel halo.");
        }

        private static void VerifyOverlayPreviewIsUnscaled(Bitmap desktop)
        {
            Rectangle selection = new Rectangle(24, 18, 96, 56);
            Color untouched = Color.FromArgb(255, 23, 29, 37);
            using (Bitmap fullCanvas = new Bitmap(desktop.Width, desktop.Height, PixelFormat.Format32bppArgb))
            {
                fullCanvas.SetResolution(120.0f, 120.0f);
                using (Graphics graphics = Graphics.FromImage(fullCanvas))
                    OverlayPainter.DrawPixelAlignedSnapshot(graphics, desktop);
                if (!PixelsEqual(desktop, fullCanvas))
                    throw new InvalidOperationException("Full overlay was DPI-scaled at 125% display scaling.");
            }

            using (Bitmap canvas = new Bitmap(desktop.Width, desktop.Height, PixelFormat.Format32bppArgb))
            {
                canvas.SetResolution(120.0f, 120.0f);
                using (Graphics graphics = Graphics.FromImage(canvas))
                {
                    graphics.Clear(untouched);
                    OverlayPainter.DrawUnscaledSelection(graphics, desktop, selection);
                }

                for (int y = selection.Top; y < selection.Bottom; y++)
                {
                    for (int x = selection.Left; x < selection.Right; x++)
                    {
                        if (canvas.GetPixel(x, y).ToArgb() != desktop.GetPixel(x, y).ToArgb())
                            throw new InvalidOperationException("Selection preview was DPI-scaled at " + x + "," + y + ".");
                    }
                }

                if (canvas.GetPixel(0, 0).ToArgb() != untouched.ToArgb())
                    throw new InvalidOperationException("Selection preview escaped its clip rectangle.");
            }
        }
    }
}
