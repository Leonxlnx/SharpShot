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
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("SharpShot")]
[assembly: AssemblyDescription("Lossless, high-quality Windows region screenshots")]
[assembly: AssemblyProduct("SharpShot")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Leonxlnx")]
[assembly: AssemblyVersion("1.1.0.0")]
[assembly: AssemblyFileVersion("1.1.0.0")]

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

            bool createdNew;
            _singleInstance = new Mutex(true, MutexName, out createdNew);
            if (!createdNew)
            {
                _singleInstance.Dispose();
                if (!silentStartup)
                {
                    MessageBox.Show(
                        "SharpShot is already running in the notification area.\n\nUse its active keyboard shortcut or double-click its tray icon to capture.",
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
        private readonly ToolStripMenuItem _captureItem;
        private readonly ToolStripMenuItem _autoItem;
        private readonly ToolStripMenuItem _nativeItem;
        private readonly ToolStripMenuItem _crispItem;
        private readonly ToolStripMenuItem _ultraItem;
        private readonly ToolStripMenuItem _autoSaveItem;
        private readonly ToolStripMenuItem _startupItem;
        private readonly ToolStripMenuItem _openLastItem;
        private readonly System.Windows.Forms.Timer _hotkeyDispatchTimer;
        private bool _captureOpen;
        private string _lastCapturePath;
        private string _hotkeyLabel;

        internal SharpShotContext(bool silentStartup)
        {
            _settings = AppSettings.Load();
            _hotkeyLabel = "Win + Shift + D";

            _menu = new ContextMenuStrip();
            _menu.Font = new Font("Segoe UI", 9.0f);
            _menu.ShowImageMargin = false;

            _captureItem = new ToolStripMenuItem("Capture now");
            _captureItem.ShortcutKeyDisplayString = "Win + Shift + D";
            _captureItem.Font = new Font("Segoe UI Semibold", 9.0f, FontStyle.Bold);
            _captureItem.Click += delegate { BeginCapture(); };
            _menu.Items.Add(_captureItem);
            _menu.Items.Add(new ToolStripSeparator());

            ToolStripMenuItem qualityMenu = new ToolStripMenuItem("Output quality");
            _autoItem = new ToolStripMenuItem("Auto Crisp - recommended");
            _nativeItem = new ToolStripMenuItem("Native - exact pixels (1\u00D7)");
            _crispItem = new ToolStripMenuItem("Crisp - enlarge 2\u00D7");
            _ultraItem = new ToolStripMenuItem("Ultra - enlarge 3\u00D7");
            _autoItem.Click += delegate { SetQuality(0); };
            _nativeItem.Click += delegate { SetQuality(1); };
            _crispItem.Click += delegate { SetQuality(2); };
            _ultraItem.Click += delegate { SetQuality(3); };
            qualityMenu.DropDownItems.Add(_autoItem);
            qualityMenu.DropDownItems.Add(new ToolStripSeparator());
            qualityMenu.DropDownItems.Add(_nativeItem);
            qualityMenu.DropDownItems.Add(_crispItem);
            qualityMenu.DropDownItems.Add(_ultraItem);
            _menu.Items.Add(qualityMenu);

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

            ToolStripMenuItem openFolderItem = new ToolStripMenuItem("Open screenshots folder");
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
            _tray.Text = "SharpShot - Win + Shift + D";
            _tray.ContextMenuStrip = _menu;
            _tray.Visible = true;
            _tray.DoubleClick += delegate { BeginCapture(); };

            _hotkeyWindow = new HotkeyWindow();
            _hotkeyDispatchTimer = new System.Windows.Forms.Timer();
            _hotkeyDispatchTimer.Interval = 1;
            _hotkeyDispatchTimer.Tick += delegate
            {
                _hotkeyDispatchTimer.Stop();
                BeginCapture();
            };
            _hotkeyWindow.Pressed += delegate
            {
                if (!_hotkeyDispatchTimer.Enabled)
                    _hotkeyDispatchTimer.Start();
            };
            bool primaryHotkeyReady = _hotkeyWindow.RegisterWinShiftD();
            if (!primaryHotkeyReady)
            {
                _hotkeyLabel = "Unavailable";
                _captureItem.ShortcutKeyDisplayString = String.Empty;
                _tray.Text = "SharpShot - double-click to capture";
                _tray.ShowBalloonTip(5000, "SharpShot hotkey unavailable",
                    "Win + Shift + D could not be registered. Double-click the SharpShot tray icon to capture.",
                    ToolTipIcon.Warning);
            }

            if (primaryHotkeyReady && !silentStartup)
            {
                _tray.ShowBalloonTip(2500, "SharpShot is ready",
                    "Press Win + Shift + D, drag a region, and release to copy it.",
                    ToolTipIcon.Info);
            }

            RefreshQualityChecks();
            RuntimeStatus.Write(_hotkeyLabel);
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
        }

        private void BeginCapture()
        {
            if (_captureOpen)
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
                using (CaptureOverlay overlay = new CaptureOverlay(desktop, desktopBounds, _settings.QualityScale))
                {
                    if (overlay.ShowDialog() != DialogResult.OK || overlay.SelectedRegion.Width < 1 || overlay.SelectedRegion.Height < 1)
                        return;
                    selected = overlay.SelectedRegion;
                }

                crop = desktop.Clone(selected, PixelFormat.Format32bppArgb);
                desktop.Dispose();
                desktop = null;

                int effectiveScale = QualityProcessor.ResolveScale(selected.Width, selected.Height, _settings.QualityScale);
                output = QualityProcessor.Process(crop, effectiveScale);
                crop.Dispose();
                crop = null;

                int outputWidth = output.Width;
                int outputHeight = output.Height;
                byte[] png = PngEncoder.Encode(output);
                bool copied = false;
                string clipboardError = null;
                try
                {
                    copied = ClipboardWriter.TrySetPng(output, png);
                }
                catch (Exception ex)
                {
                    clipboardError = ex.Message;
                }
                output.Dispose();
                output = null;

                string savedPath = null;
                string saveError = null;
                // Auto-save is a strict opt-in for disk persistence. If it is
                // off and the clipboard is unavailable, report the loss rather
                // than writing a recovery file behind the user's back.
                if (_settings.AutoSave)
                {
                    try
                    {
                        savedPath = ScreenshotStorage.Save(png, outputWidth, outputHeight);
                        _lastCapturePath = savedPath;
                        _openLastItem.Enabled = true;
                    }
                    catch (Exception ex)
                    {
                        saveError = ex.Message;
                    }
                }

                string title;
                ToolTipIcon notificationIcon;
                if (copied && saveError == null)
                {
                    title = "Screenshot copied";
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
                string detail = selected.Width + " \u00D7 " + selected.Height + " source pixels";
                if (effectiveScale > 1)
                    detail += "  \u2192  " + outputWidth + " \u00D7 " + outputHeight + "  " +
                              QualityProcessor.GetDecisionName(_settings.QualityScale, effectiveScale);
                else
                    detail += "  \u2192  " + QualityProcessor.GetDecisionName(_settings.QualityScale, effectiveScale);

                if (savedPath != null)
                    detail += "\nSaved as lossless PNG.";
                else if (!_settings.AutoSave && copied)
                    detail += "\nAuto-save is off; clipboard only.";
                else if (saveError != null)
                    detail += "\nCould not save: " + saveError;

                if (!copied && savedPath != null)
                    detail += "\nClipboard was unavailable; the auto-saved PNG is safe.";
                else if (!copied && savedPath == null)
                    detail += "\nThe image could not be retained. Clipboard: " +
                              (clipboardError ?? "unavailable") + "; save: " + (saveError ?? "unavailable") + ".";

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
                MessageBox.Show("Could not open the screenshots folder.\n\n" + ex.Message,
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
                "SharpShot 1.1.0\n\n" +
                "A native-pixel Windows region capture tool.\n\n" +
                "Auto Crisp chooses Native 1\u00D7, Crisp 2\u00D7, or Ultra 3\u00D7 from the selection size. Enlargement uses local-range-clamped Catmull-Rom resampling for clean edges without sharpening halos. It improves small-crop readability but cannot create missing source detail.\n\n" +
                "Captures are copied as lossless PNG and saved when auto-save is enabled.\n\n" +
                "Keyboard shortcut: " + _hotkeyLabel + "\n" +
                "You can also double-click the tray icon to capture.",
                "About SharpShot",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }

        private void Exit()
        {
            RuntimeStatus.Clear();
            _hotkeyDispatchTimer.Stop();
            _hotkeyDispatchTimer.Dispose();
            _hotkeyWindow.Dispose();
            _tray.Visible = false;
            _tray.Dispose();
            _trayIcon.Dispose();
            _menu.Dispose();
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                RuntimeStatus.Clear();
                _hotkeyDispatchTimer.Dispose();
                _hotkeyWindow.Dispose();
                _tray.Dispose();
                _trayIcon.Dispose();
                _menu.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    internal sealed class HotkeyWindow : NativeWindow, IDisposable
    {
        private const int WmHotkey = 0x0312;
        private const int HotkeyId = 0x5348;
        private const uint ModShift = 0x0004;
        private const uint ModWin = 0x0008;
        private const uint ModNoRepeat = 0x4000;
        private bool _registered;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint virtualKey);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        internal event EventHandler Pressed;

        internal HotkeyWindow()
        {
            CreateParams cp = new CreateParams();
            cp.Caption = "SharpShot.MessageWindow";
            CreateHandle(cp);
        }

        internal bool RegisterWinShiftD()
        {
            _registered = RegisterHotKey(Handle, HotkeyId, ModWin | ModShift | ModNoRepeat, (uint)Keys.D);
            return _registered;
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WmHotkey && m.WParam.ToInt32() == HotkeyId)
            {
                EventHandler handler = Pressed;
                if (handler != null) handler(this, EventArgs.Empty);
            }
            base.WndProc(ref m);
        }

        public void Dispose()
        {
            if (_registered)
            {
                UnregisterHotKey(Handle, HotkeyId);
                _registered = false;
            }
            if (Handle != IntPtr.Zero)
                DestroyHandle();
        }
    }

    internal sealed class CaptureOverlay : Form
    {
        private readonly Bitmap _desktop;
        private readonly int _requestedScale;
        private readonly Font _instructionFont;
        private readonly Font _sizeFont;
        private Point _start;
        private Point _current;
        private bool _dragging;
        private Rectangle _selection;

        internal Rectangle SelectedRegion { get; private set; }

        internal CaptureOverlay(Bitmap desktop, Rectangle desktopBounds, int requestedScale)
        {
            _desktop = desktop;
            _requestedScale = requestedScale;
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
            if (_selection.Width >= 2 && _selection.Height >= 2)
            {
                SelectedRegion = _selection;
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
            string text = "Drag to capture   /   Esc or right-click to cancel";
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
            int effectiveScale = QualityProcessor.ResolveScale(rect.Width, rect.Height, _requestedScale);
            string text = rect.Width + " \u00D7 " + rect.Height + " px";
            if (effectiveScale > 1)
                text += "  \u2192  " + (rect.Width * effectiveScale) + " \u00D7 " + (rect.Height * effectiveScale) + "  " +
                        QualityProcessor.GetDecisionName(_requestedScale, effectiveScale);
            else
                text += "  /  " + QualityProcessor.GetDecisionName(_requestedScale, effectiveScale);
            return text;
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
            if (scale >= 3) return "Ultra 3\u00D7";
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
            int requestedScale = requestedMode == 0 ? GetAutoScale(width, height) : requestedMode;
            return GetSafeScale(width, height, requestedScale);
        }

        internal static int GetAutoScale(int width, int height)
        {
            if (width < 1 || height < 1)
                return 1;

            long area = (long)width * height;
            int longestEdge = Math.Max(width, height);
            if (area <= 200000L && longestEdge <= 640)
                return 3;
            if (area <= 625000L && longestEdge <= 1280)
                return 2;
            return 1;
        }

        internal static int GetSafeScale(int width, int height, int requestedScale)
        {
            int scale = Math.Max(1, Math.Min(3, requestedScale));
            while (scale > 1 &&
                  ((long)width * height * scale * scale > MaxOutputPixels ||
                   (long)width * scale > 32760L ||
                   (long)height * scale > 32760L))
                scale--;
            return scale;
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

        private static Bitmap ResizeClampedCatmullRom(Bitmap source, int scale)
        {
            int width = source.Width * scale;
            int height = source.Height * scale;
            ScaleMap[] mapX = BuildScaleMap(source.Width, width);
            ScaleMap[] mapY = BuildScaleMap(source.Height, height);
            Bitmap resized = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            try
            {
                resized.SetResolution(96.0f * scale, 96.0f * scale);
                Rectangle sourceBounds = new Rectangle(0, 0, source.Width, source.Height);
                Rectangle targetBounds = new Rectangle(0, 0, width, height);
                BitmapData sourceData = source.LockBits(sourceBounds, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                BitmapData targetData = null;
                try
                {
                    targetData = resized.LockBits(targetBounds, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                    int sourceRowBytes = Math.Abs(sourceData.Stride);
                    int targetRowBytes = Math.Abs(targetData.Stride);
                    int[] cacheKeys = new int[] { -1, -1, -1, -1 };
                    byte[][] sourceRows = new byte[4][];
                    float[][] horizontalRows = new float[4][];
                    for (int slot = 0; slot < 4; slot++)
                    {
                        sourceRows[slot] = new byte[sourceRowBytes];
                        horizontalRows[slot] = new float[width * 4];
                    }
                    byte[] outputRow = new byte[targetRowBytes];

                    for (int y = 0; y < height; y++)
                    {
                        ScaleMap vertical = mapY[y];
                        int slotA = EnsureHorizontalRow(vertical.A, vertical, sourceData,
                            sourceRowBytes, mapX, cacheKeys, sourceRows, horizontalRows);
                        int slotB = EnsureHorizontalRow(vertical.B, vertical, sourceData,
                            sourceRowBytes, mapX, cacheKeys, sourceRows, horizontalRows);
                        int slotC = EnsureHorizontalRow(vertical.C, vertical, sourceData,
                            sourceRowBytes, mapX, cacheKeys, sourceRows, horizontalRows);
                        int slotD = EnsureHorizontalRow(vertical.D, vertical, sourceData,
                            sourceRowBytes, mapX, cacheKeys, sourceRows, horizontalRows);

                        Array.Clear(outputRow, 0, outputRow.Length);
                        for (int x = 0; x < width; x++)
                        {
                            ScaleMap horizontal = mapX[x];
                            int targetPixel = x * 4;
                            int sourceLeft = horizontal.B * 4;
                            int sourceRight = horizontal.C * 4;
                            for (int channel = 0; channel < 4; channel++)
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
                                int rounded = (int)Math.Round(value);
                                outputRow[component] = (byte)Math.Max(minimum, Math.Min(maximum, rounded));
                            }
                        }

                        Marshal.Copy(outputRow, 0, GetRowPointer(targetData, y), targetRowBytes);
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

        private static int EnsureHorizontalRow(
            int sourceY,
            ScaleMap neededRows,
            BitmapData sourceData,
            int sourceRowBytes,
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
                int outputPixel = x * 4;
                int a = horizontal.A * 4;
                int b = horizontal.B * 4;
                int c = horizontal.C * 4;
                int d = horizontal.D * 4;
                for (int channel = 0; channel < 4; channel++)
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

    internal static class PngEncoder
    {
        internal static byte[] Encode(Bitmap bitmap)
        {
            using (MemoryStream stream = new MemoryStream())
            {
                bitmap.Save(stream, ImageFormat.Png);
                return stream.ToArray();
            }
        }
    }

    internal static class ClipboardWriter
    {
        internal static bool TrySetPng(Bitmap bitmap, byte[] png)
        {
            try
            {
                using (MemoryStream pngStream = new MemoryStream(png, false))
                using (MemoryStream mimePngStream = new MemoryStream(png, false))
                using (Bitmap clipboardBitmap = new Bitmap(bitmap))
                {
                    clipboardBitmap.SetResolution(bitmap.HorizontalResolution, bitmap.VerticalResolution);
                    DataObject data = new DataObject();
                    data.SetData("PNG", false, pngStream);
                    data.SetData("image/png", false, mimePngStream);
                    data.SetData(DataFormats.Bitmap, true, clipboardBitmap);
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

        internal static string Save(byte[] png, int width, int height)
        {
            string folder = GetFolder();
            Directory.CreateDirectory(folder);
            string baseName = "SharpShot_" + DateTime.Now.ToString("yyyy-MM-dd_HH-mm-ss-fff") +
                              "_" + width + "x" + height;
            string path = Path.Combine(folder, baseName + ".png");
            int suffix = 2;
            while (File.Exists(path))
            {
                path = Path.Combine(folder, baseName + "_" + suffix + ".png");
                suffix++;
            }
            File.WriteAllBytes(path, png);
            return path;
        }
    }

    internal sealed class AppSettings
    {
        internal int QualityScale = 0;
        internal bool AutoSave = true;

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
                        if (Int32.TryParse(value, out parsed) && parsed >= 0 && parsed <= 3)
                            settings.QualityScale = parsed;
                    }
                    else if (String.Equals(key, "autoSave", StringComparison.OrdinalIgnoreCase))
                    {
                        bool parsed;
                        if (Boolean.TryParse(value, out parsed))
                            settings.AutoSave = parsed;
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
                    "autoSave=" + AutoSave
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

        internal static void Write(string hotkey)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(StatusPath));
                File.WriteAllLines(StatusPath, new string[]
                {
                    "pid=" + Process.GetCurrentProcess().Id,
                    "hotkey=" + hotkey,
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
                    pattern.Save(nativePath, ImageFormat.Png);
                    VerifyPng(nativePath);
                    using (Bitmap exact = QualityProcessor.Process(pattern, 1))
                    {
                        if (!PixelsEqual(pattern, exact))
                            throw new InvalidOperationException("Native 1x changed source pixels.");
                        report.Add("PASS: Native 1x is pixel-exact");
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

                    VerifyOverlayPreviewIsUnscaled(pattern);
                    report.Add("PASS: overlay and selection stay pixel-aligned at 125% DPI");
                }

                VerifyFlatColorPreserved();
                report.Add("PASS: clamped enlargement preserves flat colors and introduces no channel halos");

                VerifyAutoScaleBoundaries();
                report.Add("PASS: Auto Crisp scale boundaries are deterministic");

                if (QualityProcessor.GetSafeScale(4000, 3000, 3) != 1)
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
            if (data.Length < signature.Length)
                throw new InvalidDataException("PNG output is too short: " + path);
            for (int i = 0; i < signature.Length; i++)
            {
                if (data[i] != signature[i])
                    throw new InvalidDataException("PNG signature is invalid: " + path);
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
            if (QualityProcessor.GetAutoScale(400, 500) != 3 ||
                QualityProcessor.GetAutoScale(401, 500) != 2 ||
                QualityProcessor.GetAutoScale(640, 300) != 3 ||
                QualityProcessor.GetAutoScale(641, 300) != 2 ||
                QualityProcessor.GetAutoScale(625, 1000) != 2 ||
                QualityProcessor.GetAutoScale(626, 1000) != 1 ||
                QualityProcessor.GetAutoScale(1280, 400) != 2 ||
                QualityProcessor.GetAutoScale(1281, 400) != 1)
                throw new InvalidOperationException("Auto Crisp threshold behavior changed.");
        }

        private static void VerifyFlatColorPreserved()
        {
            Color flat = Color.FromArgb(255, 37, 91, 143);
            using (Bitmap source = new Bitmap(31, 19, PixelFormat.Format32bppArgb))
            {
                using (Graphics graphics = Graphics.FromImage(source))
                    graphics.Clear(flat);
                using (Bitmap enlarged = QualityProcessor.Process(source, 3))
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
