using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace SharpShot
{
    /// <summary>
    /// Event-driven fallback host for Studio shortcuts which Electron could not
    /// register. The host knows binding IDs and chords only; Electron remains
    /// the authority for workflow lookup and capture execution.
    /// </summary>
    internal static class StudioHotkeyHost
    {
        internal const int ProtocolVersion = 1;
        internal const int MaximumBindings = 64;
        internal const int MaximumLineBytes = 65536;
        private const string Command = "--studio-hotkey-host";

        internal static bool CanHandle(string[] args)
        {
            return args != null && args.Length > 0 &&
                   String.Equals(args[0], Command, StringComparison.OrdinalIgnoreCase);
        }

        internal static int Run(string[] args)
        {
            int parentProcessId;
            if (!TryParseArguments(args, out parentProcessId))
            {
                WriteStartupError("INVALID_ARGUMENTS",
                    "Use --studio-hotkey-host --parent-pid <positive process id>.");
                return 2;
            }

            try
            {
                using (StudioHotkeyHostContext context =
                    new StudioHotkeyHostContext(parentProcessId))
                {
                    context.Start();
                    Application.Run(context);
                    return context.ExitCode;
                }
            }
            catch (ArgumentException error)
            {
                WriteStartupError("PARENT_UNAVAILABLE", error.Message);
                return 2;
            }
            catch (InvalidOperationException error)
            {
                WriteStartupError("PARENT_UNAVAILABLE", error.Message);
                return 2;
            }
            catch (Exception error)
            {
                WriteStartupError("STARTUP_FAILED", error.Message);
                return 1;
            }
        }

        private static bool TryParseArguments(string[] args, out int parentProcessId)
        {
            parentProcessId = 0;
            int currentProcessId;
            using (Process current = Process.GetCurrentProcess())
                currentProcessId = current.Id;
            if (args == null || args.Length != 3 ||
                !String.Equals(args[0], Command, StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(args[1], "--parent-pid", StringComparison.OrdinalIgnoreCase) ||
                !Int32.TryParse(args[2], out parentProcessId) || parentProcessId <= 0 ||
                parentProcessId == currentProcessId)
                return false;
            return true;
        }

        private static void WriteStartupError(string code, string message)
        {
            try
            {
                using (StreamWriter writer = new StreamWriter(
                    Console.OpenStandardOutput(), new UTF8Encoding(false), 1024))
                {
                    writer.WriteLine(HotkeyHostProtocol.BuildFatal(code, message));
                    writer.Flush();
                }
            }
            catch { }
        }
    }

    internal sealed class StudioHotkeyHostContext : ApplicationContext
    {
        private readonly Process _parent;
        private readonly HotkeyHostProtocolWriter _writer;
        private readonly HotkeyHostWindow _window;
        private Thread _readerThread;
        private int _exitRequested;

        internal int ExitCode { get; private set; }

        internal StudioHotkeyHostContext(int parentProcessId)
        {
            _parent = Process.GetProcessById(parentProcessId);
            if (_parent.HasExited)
                throw new InvalidOperationException("The Studio parent process has already exited.");

            _writer = new HotkeyHostProtocolWriter(delegate { RequestExit(1); });
            _window = new HotkeyHostWindow(_writer);
            _window.ExitRequested += delegate(object sender, HotkeyHostExitEventArgs args)
            {
                ExitCode = args.ExitCode;
                ExitThread();
            };
            _parent.Exited += ParentExited;
            _parent.EnableRaisingEvents = true;
            if (_parent.HasExited) RequestExit(0);
        }

        internal void Start()
        {
            if (!_writer.Enqueue(HotkeyHostProtocol.BuildReady()))
                throw new IOException("The Studio hotkey protocol output is unavailable.");

            _readerThread = new Thread(ReadCommands);
            _readerThread.Name = "SharpShot Studio hotkey command reader";
            _readerThread.IsBackground = true;
            _readerThread.Start();
        }

        private void ReadCommands()
        {
            try
            {
                using (StreamReader reader = new StreamReader(
                    Console.OpenStandardInput(), new UTF8Encoding(false, true),
                    false, 4096))
                {
                    while (true)
                    {
                        string line = ReadBoundedLine(reader);
                        if (line == null) break;
                        if (Encoding.UTF8.GetByteCount(line) >
                            StudioHotkeyHost.MaximumLineBytes)
                        {
                            _writer.Enqueue(HotkeyHostProtocol.BuildFatal(
                                "LINE_TOO_LARGE", "A protocol line exceeded 65536 bytes."));
                            RequestExit(1);
                            return;
                        }
                        if (!_window.QueueCommand(line))
                        {
                            _writer.Enqueue(HotkeyHostProtocol.BuildFatal(
                                "COMMAND_QUEUE_FULL", "The command queue is full."));
                            RequestExit(1);
                            return;
                        }
                    }
                }
                RequestExit(0);
            }
            catch (InvalidDataException error)
            {
                _writer.Enqueue(HotkeyHostProtocol.BuildFatal(
                    "LINE_TOO_LARGE", error.Message));
                RequestExit(1);
            }
            catch (Exception error)
            {
                _writer.Enqueue(HotkeyHostProtocol.BuildFatal(
                    "INPUT_FAILED", error.Message));
                RequestExit(1);
            }
        }

        private static string ReadBoundedLine(StreamReader reader)
        {
            StringBuilder line = new StringBuilder(256);
            while (true)
            {
                int next = reader.Read();
                if (next < 0) return line.Length == 0 ? null : line.ToString();
                if (next == '\n') return line.ToString();
                if (next == '\r')
                {
                    if (reader.Peek() == '\n') reader.Read();
                    return line.ToString();
                }
                if (line.Length >= StudioHotkeyHost.MaximumLineBytes)
                    throw new InvalidDataException(
                        "A protocol line exceeded 65536 characters.");
                line.Append((char)next);
            }
        }

        private void ParentExited(object sender, EventArgs e)
        {
            RequestExit(0);
        }

        private void RequestExit(int exitCode)
        {
            if (Interlocked.Exchange(ref _exitRequested, 1) != 0) return;
            _window.QueueExit(exitCode);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _parent.Exited -= ParentExited;
                _window.Dispose();
                _parent.Dispose();
                _writer.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    internal sealed class HotkeyHostExitEventArgs : EventArgs
    {
        internal readonly int ExitCode;

        internal HotkeyHostExitEventArgs(int exitCode)
        {
            ExitCode = exitCode;
        }
    }

    internal sealed class HotkeyHostProtocolWriter : IDisposable
    {
        private const int MaximumQueuedLines = 256;
        private readonly object _sync = new object();
        private readonly Queue<string> _lines = new Queue<string>();
        private readonly AutoResetEvent _ready = new AutoResetEvent(false);
        private readonly Action _failed;
        private readonly Thread _thread;
        private bool _stopping;
        private bool _disposed;

        internal HotkeyHostProtocolWriter(Action failed)
        {
            _failed = failed;
            _thread = new Thread(WriteLoop);
            _thread.Name = "SharpShot Studio hotkey protocol writer";
            _thread.IsBackground = true;
            _thread.Start();
        }

        internal bool Enqueue(string line)
        {
            lock (_sync)
            {
                if (_disposed || _stopping || _lines.Count >= MaximumQueuedLines)
                    return false;
                _lines.Enqueue(line);
            }
            _ready.Set();
            return true;
        }

        private void WriteLoop()
        {
            try
            {
                using (StreamWriter writer = new StreamWriter(
                    Console.OpenStandardOutput(), new UTF8Encoding(false), 4096))
                {
                    writer.AutoFlush = true;
                    while (true)
                    {
                        string line = null;
                        lock (_sync)
                        {
                            if (_lines.Count > 0)
                                line = _lines.Dequeue();
                            else if (_stopping)
                                break;
                        }
                        if (line == null)
                        {
                            _ready.WaitOne();
                            continue;
                        }
                        writer.WriteLine(line);
                    }
                }
            }
            catch
            {
                if (_failed != null) _failed();
            }
        }

        public void Dispose()
        {
            lock (_sync)
            {
                if (_disposed) return;
                _disposed = true;
                _stopping = true;
            }
            _ready.Set();
            bool stopped = _thread.Join(2000);
            if (stopped) _ready.Dispose();
        }
    }

    internal sealed class HotkeyHostWindow : NativeWindow, IDisposable
    {
        private const int WmHotkey = 0x0312;
        private const int WmCommandReady = 0x8040;
        private const int WmExit = 0x8041;
        private const int FirstHotkeyId = 0x6200;
        private const int LastHotkeyId = 0xBFFF;
        private const int MaximumQueuedCommands = 64;
        private const uint ModAlt = 0x0001;
        private const uint ModControl = 0x0002;
        private const uint ModShift = 0x0004;
        private const uint ModWin = 0x0008;
        private const uint ModNoRepeat = 0x4000;
        private const int WhKeyboardLl = 13;
        private const int WmKeyDown = 0x0100;
        private const int WmKeyUp = 0x0101;
        private const int WmSysKeyDown = 0x0104;
        private const int WmSysKeyUp = 0x0105;
        private const uint LlkhfLowerIlInjected = 0x00000002;
        private const uint LlkhfInjected = 0x00000010;

        private readonly object _commandSync = new object();
        private readonly Queue<string> _commands = new Queue<string>();
        private readonly HotkeyHostProtocolWriter _writer;
        private List<HotkeyHostBinding> _active = new List<HotkeyHostBinding>();
        private readonly Dictionary<int, HotkeyHostBinding> _registered =
            new Dictionary<int, HotkeyHostBinding>();
        private readonly Dictionary<uint, List<HotkeyHostBinding>> _hookBindings =
            new Dictionary<uint, List<HotkeyHostBinding>>();
        private readonly HashSet<uint> _pressedHookKeys = new HashSet<uint>();
        private static LowLevelKeyboardProc _failedUnhookRoot;
        private IntPtr _keyboardHook;
        private LowLevelKeyboardProc _keyboardCallback;
        private int _nextHotkeyId = FirstHotkeyId;
        private bool _disposed;

        internal event EventHandler<HotkeyHostExitEventArgs> ExitRequested;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterHotKey(
            IntPtr window, int id, uint modifiers, uint virtualKey);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnregisterHotKey(IntPtr window, int id);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool PostMessage(
            IntPtr window, int message, IntPtr wParam, IntPtr lParam);

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

        internal HotkeyHostWindow(HotkeyHostProtocolWriter writer)
        {
            _writer = writer;
            CreateParams parameters = new CreateParams();
            parameters.Caption = "SharpShot.StudioHotkeyHost";
            CreateHandle(parameters);
        }

        internal bool QueueCommand(string line)
        {
            lock (_commandSync)
            {
                if (_disposed || _commands.Count >= MaximumQueuedCommands)
                    return false;
                _commands.Enqueue(line);
            }
            return PostMessage(Handle, WmCommandReady, IntPtr.Zero, IntPtr.Zero);
        }

        internal void QueueExit(int exitCode)
        {
            if (_disposed) return;
            PostMessage(Handle, WmExit, new IntPtr(exitCode), IntPtr.Zero);
        }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == WmCommandReady)
            {
                ProcessQueuedCommands();
            }
            else if (message.Msg == WmExit)
            {
                EventHandler<HotkeyHostExitEventArgs> handler = ExitRequested;
                if (handler != null)
                    handler(this, new HotkeyHostExitEventArgs(message.WParam.ToInt32()));
            }
            else if (message.Msg == WmHotkey)
            {
                HotkeyHostBinding binding;
                if (_registered.TryGetValue(message.WParam.ToInt32(), out binding) &&
                    binding.Chord.MatchesHotkeyMessage(message.LParam))
                    EmitShortcut(binding.BindingId);
            }
            base.WndProc(ref message);
        }

        private void ProcessQueuedCommands()
        {
            string line;
            lock (_commandSync)
            {
                if (_commands.Count == 0) return;
                line = _commands.Dequeue();
            }
            ProcessCommand(line);
        }

        private void ProcessCommand(string line)
        {
            HotkeyHostRequest request;
            try
            {
                request = HotkeyHostRequest.Parse(line);
            }
            catch (HotkeyHostProtocolException error)
            {
                WriteProtocol(HotkeyHostProtocol.BuildError(
                    error.RequestId, error.Code, error.Message));
                return;
            }
            catch (Exception error)
            {
                WriteProtocol(HotkeyHostProtocol.BuildError(
                    null, "INVALID_REQUEST", error.Message));
                return;
            }

            if (request.Command == HotkeyHostCommand.Shutdown)
            {
                WriteProtocol(HotkeyHostProtocol.BuildSimpleResponse(
                    request.RequestId, true, "shutdown"));
                QueueExit(0);
                return;
            }
            if (request.Command == HotkeyHostCommand.Ping)
            {
                WriteProtocol(HotkeyHostProtocol.BuildSimpleResponse(
                    request.RequestId, true, "pong"));
                return;
            }

            HotkeyHostReplaceResult result = ReplaceBindings(
                request.Bindings, request.AllowHookFallback);
            WriteProtocol(HotkeyHostProtocol.BuildReplaceResponse(
                request.RequestId, result));
        }

        private HotkeyHostReplaceResult ReplaceBindings(
            List<HotkeyHostBinding> requested,
            bool allowHookFallback)
        {
            List<HotkeyHostBinding> previous = _active;
            UnregisterRegistered(previous);

            List<HotkeyHostBinding> candidates = new List<HotkeyHostBinding>();
            List<HotkeyHostBindingResult> results = new List<HotkeyHostBindingResult>();
            bool failed = false;
            for (int index = 0; index < requested.Count; index++)
            {
                HotkeyHostBinding binding = requested[index];
                binding.HotkeyId = AllocateHotkeyId();
                if (RegisterHotKey(
                    Handle, binding.HotkeyId,
                    binding.Chord.Modifiers | ModNoRepeat,
                    binding.Chord.VirtualKey))
                {
                    binding.Backend = HotkeyHostBackend.RegisterHotKey;
                    candidates.Add(binding);
                    results.Add(new HotkeyHostBindingResult(
                        binding.BindingId, true, "register-hot-key", null));
                    continue;
                }

                int nativeError = Marshal.GetLastWin32Error();
                if (allowHookFallback && binding.Chord.AllowsHookFallback)
                {
                    binding.Backend = HotkeyHostBackend.Hook;
                    candidates.Add(binding);
                    results.Add(new HotkeyHostBindingResult(
                        binding.BindingId, true, "hook",
                        "RegisterHotKey failed with Windows error " + nativeError +
                        "; the explicitly enabled exact-chord hook is active."));
                }
                else
                {
                    failed = true;
                    string reason = allowHookFallback
                        ? "Hook fallback is limited to Win+Shift+A and Win+Shift+D in protocol v1."
                        : "Windows or another app owns this shortcut (error " +
                          nativeError + ").";
                    results.Add(new HotkeyHostBindingResult(
                        binding.BindingId, false, null, reason));
                }
            }

            if (!failed && HasHookBinding(candidates) && !EnsureKeyboardHook())
            {
                failed = true;
                int nativeError = Marshal.GetLastWin32Error();
                for (int index = 0; index < results.Count; index++)
                {
                    if (results[index].Backend == "hook")
                        results[index] = new HotkeyHostBindingResult(
                            results[index].BindingId, false, null,
                            "The low-level hook could not start (error " + nativeError + ").");
                }
            }

            if (failed)
            {
                UnregisterRegistered(candidates);
                bool rollbackComplete = RestorePrevious(previous);
                for (int index = 0; index < results.Count; index++)
                {
                    if (results[index].Registered)
                        results[index] = new HotkeyHostBindingResult(
                            results[index].BindingId, false, null,
                            "The replacement was rolled back because another binding failed.");
                }
                return new HotkeyHostReplaceResult(
                    false, rollbackComplete, HasHookBinding(_active), results);
            }

            _active = candidates;
            RebuildLookups();
            if (!HasHookBinding(_active)) RemoveKeyboardHook();
            return new HotkeyHostReplaceResult(true, true, HasHookBinding(_active), results);
        }

        private bool RestorePrevious(List<HotkeyHostBinding> previous)
        {
            bool complete = true;
            List<HotkeyHostBinding> restored = new List<HotkeyHostBinding>();
            for (int index = 0; index < previous.Count; index++)
            {
                HotkeyHostBinding binding = previous[index];
                if (binding.Backend == HotkeyHostBackend.RegisterHotKey)
                {
                    if (RegisterHotKey(
                        Handle, binding.HotkeyId,
                        binding.Chord.Modifiers | ModNoRepeat,
                        binding.Chord.VirtualKey))
                        restored.Add(binding);
                    else
                        complete = false;
                }
                else if (binding.Backend == HotkeyHostBackend.Hook)
                {
                    restored.Add(binding);
                }
            }
            _active = restored;
            RebuildLookups();
            if (HasHookBinding(restored))
                complete = EnsureKeyboardHook() && complete;
            else
                RemoveKeyboardHook();
            return complete;
        }

        private int AllocateHotkeyId()
        {
            int result = _nextHotkeyId;
            _nextHotkeyId++;
            if (_nextHotkeyId > LastHotkeyId) _nextHotkeyId = FirstHotkeyId;
            return result;
        }

        private void RebuildLookups()
        {
            _registered.Clear();
            _hookBindings.Clear();
            _pressedHookKeys.Clear();
            for (int index = 0; index < _active.Count; index++)
            {
                HotkeyHostBinding binding = _active[index];
                if (binding.Backend == HotkeyHostBackend.RegisterHotKey)
                {
                    _registered[binding.HotkeyId] = binding;
                }
                else
                {
                    List<HotkeyHostBinding> bindings;
                    if (!_hookBindings.TryGetValue(binding.Chord.VirtualKey, out bindings))
                    {
                        bindings = new List<HotkeyHostBinding>();
                        _hookBindings.Add(binding.Chord.VirtualKey, bindings);
                    }
                    bindings.Add(binding);
                }
            }
        }

        private void UnregisterRegistered(List<HotkeyHostBinding> bindings)
        {
            for (int index = 0; index < bindings.Count; index++)
            {
                HotkeyHostBinding binding = bindings[index];
                if (binding.Backend == HotkeyHostBackend.RegisterHotKey)
                    UnregisterHotKey(Handle, binding.HotkeyId);
            }
        }

        private static bool HasHookBinding(List<HotkeyHostBinding> bindings)
        {
            for (int index = 0; index < bindings.Count; index++)
            {
                if (bindings[index].Backend == HotkeyHostBackend.Hook) return true;
            }
            return false;
        }

        private bool EnsureKeyboardHook()
        {
            if (_keyboardHook != IntPtr.Zero) return true;
            _keyboardCallback = KeyboardHookCallback;
            _keyboardHook = SetWindowsHookEx(
                WhKeyboardLl, _keyboardCallback, GetModuleHandle(null), 0);
            if (_keyboardHook != IntPtr.Zero) return true;
            _keyboardCallback = null;
            return false;
        }

        private bool RemoveKeyboardHook()
        {
            if (_keyboardHook != IntPtr.Zero)
            {
                if (!UnhookWindowsHookEx(_keyboardHook))
                {
                    _failedUnhookRoot = _keyboardCallback;
                    return false;
                }
                _keyboardHook = IntPtr.Zero;
            }
            if (Object.ReferenceEquals(_failedUnhookRoot, _keyboardCallback))
                _failedUnhookRoot = null;
            _keyboardCallback = null;
            _pressedHookKeys.Clear();
            return true;
        }

        private IntPtr KeyboardHookCallback(
            int code,
            IntPtr message,
            IntPtr keyboardData)
        {
            if (code >= 0)
            {
                int kind = message.ToInt32();
                bool keyDown = kind == WmKeyDown || kind == WmSysKeyDown;
                bool keyUp = kind == WmKeyUp || kind == WmSysKeyUp;
                if (keyDown || keyUp)
                {
                    uint virtualKey = unchecked((uint)Marshal.ReadInt32(keyboardData, 0));
                    uint flags = unchecked((uint)Marshal.ReadInt32(keyboardData, 8));
                    if ((flags & (LlkhfInjected | LlkhfLowerIlInjected)) == 0)
                    {
                        if (keyDown && HandleHookKeyDown(virtualKey))
                            return new IntPtr(1);
                        if (keyUp && _pressedHookKeys.Remove(virtualKey))
                            return new IntPtr(1);
                    }
                }
            }
            return CallNextHookEx(_keyboardHook, code, message, keyboardData);
        }

        private bool HandleHookKeyDown(uint virtualKey)
        {
            List<HotkeyHostBinding> bindings;
            if (!_hookBindings.TryGetValue(virtualKey, out bindings)) return false;
            for (int index = 0; index < bindings.Count; index++)
            {
                HotkeyHostBinding binding = bindings[index];
                if (!binding.Chord.MatchesCurrentModifiers()) continue;
                if (_pressedHookKeys.Add(virtualKey))
                    EmitShortcut(binding.BindingId);
                return true;
            }
            return false;
        }

        private void EmitShortcut(string bindingId)
        {
            WriteProtocol(HotkeyHostProtocol.BuildShortcut(bindingId));
        }

        private void WriteProtocol(string line)
        {
            if (!_writer.Enqueue(line)) QueueExit(1);
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            UnregisterRegistered(_active);
            _active.Clear();
            _registered.Clear();
            _hookBindings.Clear();
            RemoveKeyboardHook();
            if (Handle != IntPtr.Zero) DestroyHandle();
        }

        private delegate IntPtr LowLevelKeyboardProc(
            int code, IntPtr message, IntPtr keyboardData);
    }

    internal enum HotkeyHostBackend
    {
        None,
        RegisterHotKey,
        Hook
    }

    internal sealed class HotkeyHostBinding
    {
        internal readonly string BindingId;
        internal readonly HotkeyHostChord Chord;
        internal int HotkeyId;
        internal HotkeyHostBackend Backend;

        internal HotkeyHostBinding(string bindingId, HotkeyHostChord chord)
        {
            BindingId = bindingId;
            Chord = chord;
        }
    }

    internal sealed class HotkeyHostBindingResult
    {
        internal readonly string BindingId;
        internal readonly bool Registered;
        internal readonly string Backend;
        internal readonly string Reason;

        internal HotkeyHostBindingResult(
            string bindingId,
            bool registered,
            string backend,
            string reason)
        {
            BindingId = bindingId;
            Registered = registered;
            Backend = backend;
            Reason = reason;
        }
    }

    internal sealed class HotkeyHostReplaceResult
    {
        internal readonly bool Applied;
        internal readonly bool RollbackComplete;
        internal readonly bool HookActive;
        internal readonly List<HotkeyHostBindingResult> Bindings;

        internal HotkeyHostReplaceResult(
            bool applied,
            bool rollbackComplete,
            bool hookActive,
            List<HotkeyHostBindingResult> bindings)
        {
            Applied = applied;
            RollbackComplete = rollbackComplete;
            HookActive = hookActive;
            Bindings = bindings;
        }
    }

    internal sealed class HotkeyHostChord
    {
        private const uint ModAlt = 0x0001;
        private const uint ModControl = 0x0002;
        private const uint ModShift = 0x0004;
        private const uint ModWin = 0x0008;
        private const int VkShift = 0x10;
        private const int VkControl = 0x11;
        private const int VkAlt = 0x12;
        private const int VkLWin = 0x5B;
        private const int VkRWin = 0x5C;

        internal readonly uint Modifiers;
        internal readonly uint VirtualKey;
        internal readonly string Signature;
        internal bool AllowsHookFallback
        {
            get
            {
                return Modifiers == (ModWin | ModShift) &&
                       (VirtualKey == (uint)'A' || VirtualKey == (uint)'D');
            }
        }

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int virtualKey);

        private HotkeyHostChord(uint modifiers, uint virtualKey)
        {
            Modifiers = modifiers;
            VirtualKey = virtualKey;
            Signature = modifiers + ":" + virtualKey;
        }

        internal bool MatchesCurrentModifiers()
        {
            bool shift = IsPressed(VkShift);
            bool control = IsPressed(VkControl);
            bool alt = IsPressed(VkAlt);
            bool win = IsPressed(VkLWin) || IsPressed(VkRWin);
            return shift == ((Modifiers & ModShift) != 0) &&
                   control == ((Modifiers & ModControl) != 0) &&
                   alt == ((Modifiers & ModAlt) != 0) &&
                   win == ((Modifiers & ModWin) != 0);
        }

        internal bool MatchesHotkeyMessage(IntPtr value)
        {
            long packed = value.ToInt64();
            uint modifiers = (uint)packed & 0x000F;
            uint virtualKey = ((uint)packed >> 16) & 0xFFFF;
            return modifiers == Modifiers && virtualKey == VirtualKey;
        }

        private static bool IsPressed(int virtualKey)
        {
            return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
        }

        internal static bool TryParse(
            string accelerator,
            out HotkeyHostChord chord,
            out string error)
        {
            chord = null;
            error = null;
            if (String.IsNullOrEmpty(accelerator) || accelerator.Length > 64)
            {
                error = "An accelerator must contain 1 to 64 characters.";
                return false;
            }

            string[] tokens = accelerator.Split('+');
            uint modifiers = 0;
            uint virtualKey = 0;
            for (int index = 0; index < tokens.Length; index++)
            {
                string token = tokens[index].Trim();
                if (token.Length == 0)
                {
                    error = "An accelerator contains an empty token.";
                    return false;
                }
                uint modifier;
                if (TryGetModifier(token, out modifier))
                {
                    if ((modifiers & modifier) != 0)
                    {
                        error = "An accelerator repeats a modifier.";
                        return false;
                    }
                    modifiers |= modifier;
                    continue;
                }

                uint key;
                if (!TryGetVirtualKey(token, out key))
                {
                    error = "Unsupported accelerator key: " + token + ".";
                    return false;
                }
                if (virtualKey != 0)
                {
                    error = "An accelerator must contain exactly one non-modifier key.";
                    return false;
                }
                virtualKey = key;
            }

            if (modifiers == 0 || virtualKey == 0)
            {
                error = "An accelerator requires a modifier and one non-modifier key.";
                return false;
            }
            if (modifiers == ModWin && virtualKey == (uint)'L')
            {
                error = "Win+L is reserved by Windows.";
                return false;
            }
            if (modifiers == (ModControl | ModAlt) && virtualKey == 0x2E)
            {
                error = "Ctrl+Alt+Delete is reserved by Windows.";
                return false;
            }
            chord = new HotkeyHostChord(modifiers, virtualKey);
            return true;
        }

        private static bool TryGetModifier(string token, out uint modifier)
        {
            modifier = 0;
            if (String.Equals(token, "Win", StringComparison.OrdinalIgnoreCase) ||
                String.Equals(token, "Super", StringComparison.OrdinalIgnoreCase))
                modifier = ModWin;
            else if (String.Equals(token, "Shift", StringComparison.OrdinalIgnoreCase))
                modifier = ModShift;
            else if (String.Equals(token, "Ctrl", StringComparison.OrdinalIgnoreCase) ||
                     String.Equals(token, "Control", StringComparison.OrdinalIgnoreCase))
                modifier = ModControl;
            else if (String.Equals(token, "Alt", StringComparison.OrdinalIgnoreCase))
                modifier = ModAlt;
            return modifier != 0;
        }

        private static bool TryGetVirtualKey(string token, out uint virtualKey)
        {
            virtualKey = 0;
            if (token.Length == 1)
            {
                char value = Char.ToUpperInvariant(token[0]);
                if ((value >= 'A' && value <= 'Z') ||
                    (value >= '0' && value <= '9'))
                {
                    virtualKey = value;
                    return true;
                }
            }
            if (token.Length >= 2 && (token[0] == 'F' || token[0] == 'f'))
            {
                int functionKey;
                if (Int32.TryParse(token.Substring(1), out functionKey) &&
                    functionKey >= 1 && functionKey <= 24)
                {
                    virtualKey = (uint)(0x70 + functionKey - 1);
                    return true;
                }
            }

            string key = token.ToLowerInvariant();
            switch (key)
            {
                case "escape": virtualKey = 0x1B; break;
                case "enter": virtualKey = 0x0D; break;
                case "space": virtualKey = 0x20; break;
                case "tab": virtualKey = 0x09; break;
                case "backspace": virtualKey = 0x08; break;
                case "delete": virtualKey = 0x2E; break;
                case "insert": virtualKey = 0x2D; break;
                case "home": virtualKey = 0x24; break;
                case "end": virtualKey = 0x23; break;
                case "pageup": virtualKey = 0x21; break;
                case "pagedown": virtualKey = 0x22; break;
                case "left": virtualKey = 0x25; break;
                case "up": virtualKey = 0x26; break;
                case "right": virtualKey = 0x27; break;
                case "down": virtualKey = 0x28; break;
                case "printscreen": virtualKey = 0x2C; break;
                case "comma": virtualKey = 0xBC; break;
                case "period": virtualKey = 0xBE; break;
                case "slash": virtualKey = 0xBF; break;
                case "backslash": virtualKey = 0xDC; break;
                case "semicolon": virtualKey = 0xBA; break;
                case "quote": virtualKey = 0xDE; break;
                case "minus": virtualKey = 0xBD; break;
                case "plus":
                case "equal": virtualKey = 0xBB; break;
                case "bracketleft": virtualKey = 0xDB; break;
                case "bracketright": virtualKey = 0xDD; break;
                default: return false;
            }
            return true;
        }
    }

    internal enum HotkeyHostCommand
    {
        ReplaceBindings,
        Ping,
        Shutdown
    }

    internal sealed class HotkeyHostRequest
    {
        internal readonly string RequestId;
        internal readonly HotkeyHostCommand Command;
        internal readonly List<HotkeyHostBinding> Bindings;
        internal readonly bool AllowHookFallback;

        private HotkeyHostRequest(
            string requestId,
            HotkeyHostCommand command,
            List<HotkeyHostBinding> bindings,
            bool allowHookFallback)
        {
            RequestId = requestId;
            Command = command;
            Bindings = bindings;
            AllowHookFallback = allowHookFallback;
        }

        internal static HotkeyHostRequest Parse(string line)
        {
            Dictionary<string, object> root;
            try
            {
                root = HotkeyHostJson.ParseObject(line);
            }
            catch (Exception error)
            {
                throw new HotkeyHostProtocolException(
                    null, "INVALID_JSON", error.Message);
            }

            string requestId = ReadString(root, "id", null, 128);
            long version = ReadInteger(root, "v", requestId);
            if (version != StudioHotkeyHost.ProtocolVersion)
                throw new HotkeyHostProtocolException(
                    requestId, "PROTOCOL_MISMATCH", "Only protocol version 1 is supported.");
            string command = ReadString(root, "cmd", requestId, 64);
            if (String.Equals(command, "ping", StringComparison.Ordinal))
            {
                RequireOnly(root, requestId, "v", "id", "cmd");
                return new HotkeyHostRequest(
                    requestId, HotkeyHostCommand.Ping,
                    new List<HotkeyHostBinding>(), false);
            }
            if (String.Equals(command, "shutdown", StringComparison.Ordinal))
            {
                RequireOnly(root, requestId, "v", "id", "cmd");
                return new HotkeyHostRequest(
                    requestId, HotkeyHostCommand.Shutdown,
                    new List<HotkeyHostBinding>(), false);
            }
            if (!String.Equals(command, "bindings.replace", StringComparison.Ordinal))
                throw new HotkeyHostProtocolException(
                    requestId, "UNKNOWN_COMMAND", "The command is not supported.");

            RequireOnly(root, requestId,
                "v", "id", "cmd", "bindings", "allowHookFallback");
            bool allowHookFallback = ReadBoolean(
                root, "allowHookFallback", requestId);
            List<object> values = ReadArray(root, "bindings", requestId);
            if (values.Count > StudioHotkeyHost.MaximumBindings)
                throw new HotkeyHostProtocolException(
                    requestId, "TOO_MANY_BINDINGS", "At most 64 bindings are accepted.");

            List<HotkeyHostBinding> bindings = new List<HotkeyHostBinding>();
            HashSet<string> bindingIds = new HashSet<string>(StringComparer.Ordinal);
            HashSet<string> chords = new HashSet<string>(StringComparer.Ordinal);
            for (int index = 0; index < values.Count; index++)
            {
                Dictionary<string, object> value = values[index] as Dictionary<string, object>;
                if (value == null)
                    throw new HotkeyHostProtocolException(
                        requestId, "INVALID_BINDING", "Each binding must be an object.");
                RequireOnly(value, requestId, "bindingId", "accelerator");
                string bindingId = ReadString(value, "bindingId", requestId, 128);
                string accelerator = ReadString(value, "accelerator", requestId, 64);
                if (!bindingIds.Add(bindingId))
                    throw new HotkeyHostProtocolException(
                        requestId, "DUPLICATE_BINDING_ID", "Binding IDs must be unique.");
                HotkeyHostChord chord;
                string error;
                if (!HotkeyHostChord.TryParse(accelerator, out chord, out error))
                    throw new HotkeyHostProtocolException(
                        requestId, "INVALID_ACCELERATOR", error);
                if (!chords.Add(chord.Signature))
                    throw new HotkeyHostProtocolException(
                        requestId, "DUPLICATE_ACCELERATOR",
                        "Two bindings resolve to the same Windows chord.");
                bindings.Add(new HotkeyHostBinding(bindingId, chord));
            }
            return new HotkeyHostRequest(
                requestId, HotkeyHostCommand.ReplaceBindings,
                bindings, allowHookFallback);
        }

        private static string ReadString(
            Dictionary<string, object> value,
            string key,
            string requestId,
            int maximumLength)
        {
            object raw;
            string text;
            if (!value.TryGetValue(key, out raw) || (text = raw as string) == null ||
                text.Length < 1 || text.Length > maximumLength)
                throw new HotkeyHostProtocolException(
                    requestId, "INVALID_FIELD", key + " must be a non-empty string.");
            return text;
        }

        private static long ReadInteger(
            Dictionary<string, object> value,
            string key,
            string requestId)
        {
            object raw;
            if (!value.TryGetValue(key, out raw) || !(raw is long))
                throw new HotkeyHostProtocolException(
                    requestId, "INVALID_FIELD", key + " must be an integer.");
            return (long)raw;
        }

        private static bool ReadBoolean(
            Dictionary<string, object> value,
            string key,
            string requestId)
        {
            object raw;
            if (!value.TryGetValue(key, out raw) || !(raw is bool))
                throw new HotkeyHostProtocolException(
                    requestId, "INVALID_FIELD", key + " must be a boolean.");
            return (bool)raw;
        }

        private static List<object> ReadArray(
            Dictionary<string, object> value,
            string key,
            string requestId)
        {
            object raw;
            List<object> items;
            if (!value.TryGetValue(key, out raw) || (items = raw as List<object>) == null)
                throw new HotkeyHostProtocolException(
                    requestId, "INVALID_FIELD", key + " must be an array.");
            return items;
        }

        private static void RequireOnly(
            Dictionary<string, object> value,
            string requestId,
            params string[] keys)
        {
            HashSet<string> accepted = new HashSet<string>(keys, StringComparer.Ordinal);
            foreach (string key in value.Keys)
            {
                if (!accepted.Contains(key))
                    throw new HotkeyHostProtocolException(
                        requestId, "UNKNOWN_FIELD", "Unknown field: " + key + ".");
            }
        }
    }

    internal sealed class HotkeyHostProtocolException : Exception
    {
        internal readonly string RequestId;
        internal readonly string Code;

        internal HotkeyHostProtocolException(
            string requestId,
            string code,
            string message)
            : base(message)
        {
            RequestId = requestId;
            Code = code;
        }
    }

    internal static class HotkeyHostProtocol
    {
        internal static string BuildReady()
        {
            return "{\"v\":1,\"type\":\"ready\",\"capabilities\":{" +
                   "\"registerHotKey\":true," +
                   "\"lowLevelHookFallback\":true," +
                   "\"hookFallbackAccelerators\":[\"Win+Shift+A\",\"Win+Shift+D\"]," +
                   "\"transactionalReplace\":true," +
                   "\"parentProcessWait\":true," +
                   "\"stdinEofShutdown\":true," +
                   "\"maxBindings\":" + StudioHotkeyHost.MaximumBindings + "," +
                   "\"maxLineBytes\":" + StudioHotkeyHost.MaximumLineBytes + "}}";
        }

        internal static string BuildFatal(string code, string message)
        {
            StringBuilder result = new StringBuilder(192);
            result.Append("{\"v\":1,\"type\":\"fatal\",\"code\":");
            AppendString(result, code);
            result.Append(",\"message\":");
            AppendString(result, Limit(message, 512));
            result.Append('}');
            return result.ToString();
        }

        internal static string BuildError(
            string requestId,
            string code,
            string message)
        {
            StringBuilder result = new StringBuilder(256);
            result.Append("{\"v\":1,\"type\":\"response\",\"id\":");
            AppendNullableString(result, requestId);
            result.Append(",\"ok\":false,\"error\":{\"code\":");
            AppendString(result, code);
            result.Append(",\"message\":");
            AppendString(result, Limit(message, 512));
            result.Append("}}");
            return result.ToString();
        }

        internal static string BuildSimpleResponse(
            string requestId,
            bool ok,
            string state)
        {
            StringBuilder result = new StringBuilder(160);
            result.Append("{\"v\":1,\"type\":\"response\",\"id\":");
            AppendString(result, requestId);
            result.Append(",\"ok\":");
            result.Append(ok ? "true" : "false");
            result.Append(",\"result\":{\"state\":");
            AppendString(result, state);
            result.Append("}}");
            return result.ToString();
        }

        internal static string BuildShortcut(string bindingId)
        {
            StringBuilder result = new StringBuilder(128);
            result.Append("{\"v\":1,\"type\":\"shortcut\",\"bindingId\":");
            AppendString(result, bindingId);
            result.Append('}');
            return result.ToString();
        }

        internal static string BuildReplaceResponse(
            string requestId,
            HotkeyHostReplaceResult replace)
        {
            StringBuilder result = new StringBuilder(512);
            result.Append("{\"v\":1,\"type\":\"response\",\"id\":");
            AppendString(result, requestId);
            result.Append(",\"ok\":true,\"result\":{\"applied\":");
            result.Append(replace.Applied ? "true" : "false");
            result.Append(",\"rollbackComplete\":");
            result.Append(replace.RollbackComplete ? "true" : "false");
            result.Append(",\"hookActive\":");
            result.Append(replace.HookActive ? "true" : "false");
            result.Append(",\"bindings\":[");
            for (int index = 0; index < replace.Bindings.Count; index++)
            {
                if (index > 0) result.Append(',');
                HotkeyHostBindingResult binding = replace.Bindings[index];
                result.Append("{\"bindingId\":");
                AppendString(result, binding.BindingId);
                result.Append(",\"registered\":");
                result.Append(binding.Registered ? "true" : "false");
                if (!String.IsNullOrEmpty(binding.Backend))
                {
                    result.Append(",\"backend\":");
                    AppendString(result, binding.Backend);
                }
                if (!String.IsNullOrEmpty(binding.Reason))
                {
                    result.Append(",\"reason\":");
                    AppendString(result, Limit(binding.Reason, 512));
                }
                result.Append('}');
            }
            result.Append("]}}");
            return result.ToString();
        }

        internal static void AppendString(StringBuilder output, string value)
        {
            output.Append('"');
            if (value != null)
            {
                for (int index = 0; index < value.Length; index++)
                {
                    char character = value[index];
                    switch (character)
                    {
                        case '"': output.Append("\\\""); break;
                        case '\\': output.Append("\\\\"); break;
                        case '\b': output.Append("\\b"); break;
                        case '\f': output.Append("\\f"); break;
                        case '\n': output.Append("\\n"); break;
                        case '\r': output.Append("\\r"); break;
                        case '\t': output.Append("\\t"); break;
                        default:
                            if (character < 0x20 || Char.IsSurrogate(character))
                            {
                                output.Append("\\u");
                                output.Append(((int)character).ToString("x4"));
                            }
                            else
                            {
                                output.Append(character);
                            }
                            break;
                    }
                }
            }
            output.Append('"');
        }

        private static void AppendNullableString(StringBuilder output, string value)
        {
            if (value == null) output.Append("null");
            else AppendString(output, value);
        }

        private static string Limit(string value, int maximumLength)
        {
            if (String.IsNullOrEmpty(value)) return String.Empty;
            return value.Length <= maximumLength
                ? value
                : value.Substring(0, maximumLength);
        }
    }

    internal static class HotkeyHostJson
    {
        internal static Dictionary<string, object> ParseObject(string text)
        {
            if (text == null) throw new FormatException("JSON input is missing.");
            Parser parser = new Parser(text);
            object value = parser.ParseValue(0);
            parser.SkipWhitespace();
            if (!parser.AtEnd)
                throw new FormatException("Unexpected data follows the JSON value.");
            Dictionary<string, object> result = value as Dictionary<string, object>;
            if (result == null) throw new FormatException("The JSON root must be an object.");
            return result;
        }

        private sealed class Parser
        {
            private const int MaximumDepth = 12;
            private readonly string _text;
            private int _position;

            internal bool AtEnd { get { return _position >= _text.Length; } }

            internal Parser(string text)
            {
                _text = text;
            }

            internal object ParseValue(int depth)
            {
                if (depth > MaximumDepth)
                    throw new FormatException("JSON nesting is too deep.");
                SkipWhitespace();
                if (AtEnd) throw new FormatException("JSON ended before a value.");
                char next = _text[_position];
                if (next == '{') return ParseObject(depth + 1);
                if (next == '[') return ParseArray(depth + 1);
                if (next == '"') return ParseString();
                if (next == 't') return ParseLiteral("true", true);
                if (next == 'f') return ParseLiteral("false", false);
                if (next == 'n') return ParseLiteral("null", null);
                if (next == '-' || Char.IsDigit(next)) return ParseInteger();
                throw new FormatException("Unexpected JSON token at character " + _position + ".");
            }

            internal void SkipWhitespace()
            {
                while (!AtEnd)
                {
                    char value = _text[_position];
                    if (value != ' ' && value != '\t' && value != '\r' && value != '\n')
                        return;
                    _position++;
                }
            }

            private Dictionary<string, object> ParseObject(int depth)
            {
                Expect('{');
                Dictionary<string, object> result = new Dictionary<string, object>(
                    StringComparer.Ordinal);
                SkipWhitespace();
                if (Consume('}')) return result;
                while (true)
                {
                    SkipWhitespace();
                    if (AtEnd || _text[_position] != '"')
                        throw new FormatException("A JSON object key must be a string.");
                    string key = ParseString();
                    SkipWhitespace();
                    Expect(':');
                    object value = ParseValue(depth);
                    if (result.ContainsKey(key))
                        throw new FormatException("A JSON object contains a duplicate key.");
                    result.Add(key, value);
                    SkipWhitespace();
                    if (Consume('}')) return result;
                    Expect(',');
                }
            }

            private List<object> ParseArray(int depth)
            {
                Expect('[');
                List<object> result = new List<object>();
                SkipWhitespace();
                if (Consume(']')) return result;
                while (true)
                {
                    result.Add(ParseValue(depth));
                    SkipWhitespace();
                    if (Consume(']')) return result;
                    Expect(',');
                }
            }

            private string ParseString()
            {
                Expect('"');
                StringBuilder result = new StringBuilder();
                while (!AtEnd)
                {
                    char value = _text[_position++];
                    if (value == '"') return result.ToString();
                    if (value < 0x20)
                        throw new FormatException("A JSON string contains a control character.");
                    if (value != '\\')
                    {
                        result.Append(value);
                        continue;
                    }
                    if (AtEnd) throw new FormatException("A JSON escape is incomplete.");
                    char escaped = _text[_position++];
                    switch (escaped)
                    {
                        case '"': result.Append('"'); break;
                        case '\\': result.Append('\\'); break;
                        case '/': result.Append('/'); break;
                        case 'b': result.Append('\b'); break;
                        case 'f': result.Append('\f'); break;
                        case 'n': result.Append('\n'); break;
                        case 'r': result.Append('\r'); break;
                        case 't': result.Append('\t'); break;
                        case 'u': result.Append(ParseUnicodeEscape()); break;
                        default: throw new FormatException("A JSON escape is invalid.");
                    }
                }
                throw new FormatException("A JSON string is not terminated.");
            }

            private char ParseUnicodeEscape()
            {
                if (_position + 4 > _text.Length)
                    throw new FormatException("A Unicode escape is incomplete.");
                int value = 0;
                for (int index = 0; index < 4; index++)
                {
                    int digit = HexValue(_text[_position++]);
                    if (digit < 0) throw new FormatException("A Unicode escape is invalid.");
                    value = value * 16 + digit;
                }
                return (char)value;
            }

            private static int HexValue(char value)
            {
                if (value >= '0' && value <= '9') return value - '0';
                if (value >= 'a' && value <= 'f') return value - 'a' + 10;
                if (value >= 'A' && value <= 'F') return value - 'A' + 10;
                return -1;
            }

            private long ParseInteger()
            {
                int start = _position;
                if (_text[_position] == '-') _position++;
                if (AtEnd || !Char.IsDigit(_text[_position]))
                    throw new FormatException("A JSON number is invalid.");
                if (_text[_position] == '0')
                {
                    _position++;
                    if (!AtEnd && Char.IsDigit(_text[_position]))
                        throw new FormatException("A JSON number has a leading zero.");
                }
                else
                {
                    while (!AtEnd && Char.IsDigit(_text[_position])) _position++;
                }
                if (!AtEnd && (_text[_position] == '.' || _text[_position] == 'e' ||
                               _text[_position] == 'E'))
                    throw new FormatException("Only integer JSON numbers are accepted.");
                long result;
                if (!Int64.TryParse(
                    _text.Substring(start, _position - start), out result))
                    throw new FormatException("A JSON integer is out of range.");
                return result;
            }

            private object ParseLiteral(string literal, object value)
            {
                if (_position + literal.Length > _text.Length ||
                    !String.Equals(
                        _text.Substring(_position, literal.Length), literal,
                        StringComparison.Ordinal))
                    throw new FormatException("A JSON literal is invalid.");
                _position += literal.Length;
                return value;
            }

            private bool Consume(char value)
            {
                if (AtEnd || _text[_position] != value) return false;
                _position++;
                return true;
            }

            private void Expect(char value)
            {
                if (!Consume(value))
                    throw new FormatException("Expected '" + value + "' at character " +
                                              _position + ".");
            }
        }
    }

    internal static class StudioHotkeyHostSelfTest
    {
        internal static void Verify()
        {
            const string replace =
                "{\"v\":1,\"id\":\"replace-1\",\"cmd\":\"bindings.replace\"," +
                "\"bindings\":[" +
                "{\"bindingId\":\"quick-video\",\"accelerator\":\"Win+Shift+A\"}," +
                "{\"bindingId\":\"editor-video\",\"accelerator\":\"Win+Shift+F24\"}]," +
                "\"allowHookFallback\":true}";
            HotkeyHostRequest request = HotkeyHostRequest.Parse(replace);
            if (request.Command != HotkeyHostCommand.ReplaceBindings ||
                request.RequestId != "replace-1" || request.Bindings.Count != 2 ||
                !request.AllowHookFallback ||
                request.Bindings[0].Chord.VirtualKey != (uint)'A' ||
                request.Bindings[1].Chord.VirtualKey != 0x87)
                throw new InvalidOperationException("Studio hotkey host request parsing changed.");

            HotkeyHostChord chord;
            string error;
            if (!HotkeyHostChord.TryParse("Ctrl+Alt+BracketLeft", out chord, out error) ||
                chord.VirtualKey != 0xDB ||
                !chord.MatchesHotkeyMessage(new IntPtr(
                    unchecked((int)((chord.VirtualKey << 16) | chord.Modifiers)))) ||
                chord.MatchesHotkeyMessage(new IntPtr(
                    unchecked((int)(((uint)'A' << 16) | chord.Modifiers)))) ||
                HotkeyHostChord.TryParse("Win+L", out chord, out error) ||
                HotkeyHostChord.TryParse("Ctrl+Alt+Delete", out chord, out error) ||
                HotkeyHostChord.TryParse("A", out chord, out error))
                throw new InvalidOperationException("Studio hotkey chord policy changed.");

            HotkeyHostChord hookA;
            HotkeyHostChord hookD;
            HotkeyHostChord hookE;
            if (!HotkeyHostChord.TryParse("Win+Shift+A", out hookA, out error) ||
                !HotkeyHostChord.TryParse("Win+Shift+D", out hookD, out error) ||
                !HotkeyHostChord.TryParse("Win+Shift+E", out hookE, out error) ||
                !hookA.AllowsHookFallback || !hookD.AllowsHookFallback ||
                hookE.AllowsHookFallback)
                throw new InvalidOperationException("Studio hook fallback allowlist changed.");

            bool duplicateRejected = false;
            try
            {
                HotkeyHostRequest.Parse(
                    "{\"v\":1,\"id\":\"duplicate\",\"cmd\":\"bindings.replace\"," +
                    "\"bindings\":[" +
                    "{\"bindingId\":\"one\",\"accelerator\":\"Ctrl+Plus\"}," +
                    "{\"bindingId\":\"two\",\"accelerator\":\"Ctrl+Equal\"}]," +
                    "\"allowHookFallback\":false}");
            }
            catch (HotkeyHostProtocolException exception)
            {
                duplicateRejected = exception.Code == "DUPLICATE_ACCELERATOR";
            }
            if (!duplicateRejected)
                throw new InvalidOperationException("Equivalent Windows chords were not rejected.");

            string ready = HotkeyHostProtocol.BuildReady();
            if (ready.IndexOf("\"transactionalReplace\":true", StringComparison.Ordinal) < 0 ||
                ready.IndexOf("\"parentProcessWait\":true", StringComparison.Ordinal) < 0 ||
                ready.IndexOf("\"hookFallbackAccelerators\":[\"Win+Shift+A\",\"Win+Shift+D\"]",
                    StringComparison.Ordinal) < 0 ||
                ready.IndexOf("\"maxBindings\":64", StringComparison.Ordinal) < 0)
                throw new InvalidOperationException("Studio hotkey host capabilities changed.");

            string shortcut = HotkeyHostProtocol.BuildShortcut("quote\"line\n");
            Dictionary<string, object> shortcutValue = HotkeyHostJson.ParseObject(shortcut);
            if (!String.Equals(shortcutValue["bindingId"] as string,
                    "quote\"line\n", StringComparison.Ordinal))
                throw new InvalidOperationException("Studio hotkey JSON escaping changed.");
        }
    }
}
