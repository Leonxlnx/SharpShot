using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace SharpShot
{
    /// <summary>
    /// Optional audio policy for a recording. Keeping this object null or empty
    /// preserves the video-only path: no endpoint enumeration, COM activation,
    /// worker thread, wait handle, or file is created.
    /// </summary>
    internal sealed class AudioCaptureOptions
    {
        internal readonly bool CaptureSystemAudio;
        internal readonly string MicrophoneDeviceId;

        internal bool HasAny
        {
            get
            {
                return CaptureSystemAudio || !String.IsNullOrEmpty(MicrophoneDeviceId);
            }
        }

        internal AudioCaptureOptions(bool captureSystemAudio, string microphoneDeviceId)
        {
            CaptureSystemAudio = captureSystemAudio;
            MicrophoneDeviceId = String.IsNullOrWhiteSpace(microphoneDeviceId)
                ? null
                : microphoneDeviceId.Trim();
        }
    }

    internal sealed class RecordingAudioPaths
    {
        internal readonly string SystemPartialPath;
        internal readonly string SystemFinalPath;
        internal readonly string MicrophonePartialPath;
        internal readonly string MicrophoneFinalPath;
        private bool _systemCommitted;
        private bool _microphoneCommitted;

        private RecordingAudioPaths(
            string systemPartialPath,
            string systemFinalPath,
            string microphonePartialPath,
            string microphoneFinalPath)
        {
            SystemPartialPath = systemPartialPath;
            SystemFinalPath = systemFinalPath;
            MicrophonePartialPath = microphonePartialPath;
            MicrophoneFinalPath = microphoneFinalPath;
        }

        internal static RecordingAudioPaths ForVideo(
            string videoPath,
            AudioCaptureOptions options)
        {
            if (String.IsNullOrEmpty(videoPath))
                throw new ArgumentException("A video path is required.", "videoPath");
            if (options == null || !options.HasAny)
                return new RecordingAudioPaths(null, null, null, null);

            string fullPath = Path.GetFullPath(videoPath);
            string folder = Path.GetDirectoryName(fullPath);
            string stem = Path.GetFileNameWithoutExtension(fullPath);
            string systemFinal = options.CaptureSystemAudio
                ? Path.Combine(folder, stem + ".system.wav")
                : null;
            string microphoneFinal = !String.IsNullOrEmpty(options.MicrophoneDeviceId)
                ? Path.Combine(folder, stem + ".microphone.wav")
                : null;
            string uniquePartial = ".partial-" + Guid.NewGuid().ToString("N");
            return new RecordingAudioPaths(
                systemFinal == null ? null : Path.Combine(
                    folder, stem + uniquePartial + ".system.wav"),
                systemFinal,
                microphoneFinal == null ? null : Path.Combine(
                    folder, stem + uniquePartial + ".microphone.wav"),
                microphoneFinal);
        }

        internal void EnsureAvailable()
        {
            EnsurePairAvailable(SystemPartialPath, SystemFinalPath);
            EnsurePairAvailable(MicrophonePartialPath, MicrophoneFinalPath);
        }

        internal void Commit()
        {
            if (!_systemCommitted)
                _systemCommitted = CommitPair(SystemPartialPath, SystemFinalPath);
            if (!_microphoneCommitted)
                _microphoneCommitted = CommitPair(
                    MicrophonePartialPath, MicrophoneFinalPath);
        }

        internal void DeleteArtifacts()
        {
            DeleteIfPresent(SystemPartialPath);
            DeleteIfPresent(MicrophonePartialPath);
            if (_systemCommitted) DeleteIfPresent(SystemFinalPath);
            if (_microphoneCommitted) DeleteIfPresent(MicrophoneFinalPath);
        }

        private static void EnsurePairAvailable(string partialPath, string finalPath)
        {
            if (String.IsNullOrEmpty(finalPath)) return;
            string folder = Path.GetDirectoryName(finalPath);
            if (!String.IsNullOrEmpty(folder)) Directory.CreateDirectory(folder);
            if (File.Exists(finalPath) || File.Exists(partialPath))
                throw new IOException("An audio stem already exists for the selected recording path.");
        }

        private static bool CommitPair(string partialPath, string finalPath)
        {
            if (String.IsNullOrEmpty(finalPath)) return false;
            if (!File.Exists(partialPath))
                throw new FileNotFoundException("The completed audio stem is missing.", partialPath);
            File.Move(partialPath, finalPath);
            return true;
        }

        private static void DeleteIfPresent(string path)
        {
            try
            {
                if (!String.IsNullOrEmpty(path) && File.Exists(path)) File.Delete(path);
            }
            catch { }
        }
    }

    /// <summary>
    /// Coordinates prepared WASAPI endpoints against one monotonic start time.
    /// Each endpoint writes a separate, edit-friendly WAV stem. The recorder can
    /// therefore mix, duck, mute, or replace microphone and system sound later
    /// without decoding a multiplexed source file.
    /// </summary>
    internal sealed class AudioCaptureGroup : IDisposable
    {
        private readonly List<WasapiStemCapture> _stems = new List<WasapiStemCapture>();
        private readonly RecordingAudioPaths _paths;
        private bool _completed;
        private bool _committed;

        internal string SystemAudioPath
        {
            get { return _completed ? _paths.SystemFinalPath : null; }
        }

        internal string MicrophonePath
        {
            get { return _completed ? _paths.MicrophoneFinalPath : null; }
        }

        internal AudioCaptureGroup(
            AudioCaptureOptions options,
            RecordingAudioPaths paths)
        {
            if (options == null || !options.HasAny)
                throw new ArgumentException("At least one audio endpoint is required.", "options");
            _paths = paths;
            _paths.EnsureAvailable();

            if (options.CaptureSystemAudio)
            {
                _stems.Add(new WasapiStemCapture(
                    WasapiEndpointKind.SystemLoopback,
                    null,
                    paths.SystemPartialPath));
            }
            if (!String.IsNullOrEmpty(options.MicrophoneDeviceId))
            {
                _stems.Add(new WasapiStemCapture(
                    WasapiEndpointKind.Microphone,
                    options.MicrophoneDeviceId,
                    paths.MicrophonePartialPath));
            }
        }

        internal void Prepare()
        {
            for (int index = 0; index < _stems.Count; index++)
                _stems[index].BeginPrepare();
            try
            {
                for (int index = 0; index < _stems.Count; index++)
                    _stems[index].WaitPrepared();
            }
            catch
            {
                AbortAll();
                throw;
            }
        }

        internal void Start()
        {
            for (int index = 0; index < _stems.Count; index++)
                _stems[index].BeginStart();
            try
            {
                for (int index = 0; index < _stems.Count; index++)
                    _stems[index].WaitStarted();
            }
            catch
            {
                AbortAll();
                throw;
            }
        }

        internal void AlignTimeline(long recordingStart100Nanoseconds)
        {
            for (int index = 0; index < _stems.Count; index++)
                _stems[index].AlignTimeline(recordingStart100Nanoseconds);
        }

        internal void ThrowIfFailed()
        {
            for (int index = 0; index < _stems.Count; index++)
                _stems[index].ThrowIfFailed();
        }

        internal void Complete(TimeSpan recordingDuration)
        {
            if (_completed) return;
            for (int index = 0; index < _stems.Count; index++)
                _stems[index].RequestStop();

            Exception firstFailure = null;
            for (int index = 0; index < _stems.Count; index++)
            {
                try { _stems[index].Complete(recordingDuration); }
                catch (Exception ex) { if (firstFailure == null) firstFailure = ex; }
            }
            if (firstFailure != null)
            {
                _paths.DeleteArtifacts();
                throw new IOException("Audio capture did not finalize cleanly.", firstFailure);
            }
            _completed = true;
        }

        internal void Commit()
        {
            if (!_completed)
                throw new InvalidOperationException("Audio stems must be completed before commit.");
            if (_committed) return;
            _paths.Commit();
            _committed = true;
        }

        internal void DeleteArtifacts()
        {
            _paths.DeleteArtifacts();
        }

        public void Dispose()
        {
            AbortAll();
            for (int index = 0; index < _stems.Count; index++)
                _stems[index].Dispose();
            if (!_committed) _paths.DeleteArtifacts();
        }

        private void AbortAll()
        {
            for (int index = 0; index < _stems.Count; index++)
                _stems[index].RequestStop();
        }
    }

    internal enum WasapiEndpointKind
    {
        SystemLoopback,
        Microphone
    }

    internal sealed class WasapiStemCapture : IDisposable
    {
        private const uint DeviceStateActive = 0x00000001;
        private const uint ClsctxAll = 23;
        private const int AudioClientShareModeShared = 0;
        private const uint StreamFlagLoopback = 0x00020000;
        private const uint StreamFlagNoPersist = 0x00080000;
        private const uint StreamFlagEventCallback = 0x00040000;
        private const uint BufferFlagDataDiscontinuity = 0x00000001;
        private const uint BufferFlagSilent = 0x00000002;
        private const uint BufferFlagTimestampError = 0x00000004;
        private const int EInvalidArgument = unchecked((int)0x80070057);

        private readonly WasapiEndpointKind _kind;
        private readonly string _deviceId;
        private readonly string _partialPath;
        private readonly ManualResetEvent _prepared = new ManualResetEvent(false);
        private readonly ManualResetEvent _startGate = new ManualResetEvent(false);
        private readonly ManualResetEvent _started = new ManualResetEvent(false);
        private readonly ManualResetEvent _timelineReady = new ManualResetEvent(false);
        private readonly ManualResetEvent _stop = new ManualResetEvent(false);
        private readonly AutoResetEvent _dataReady = new AutoResetEvent(false);
        private Thread _captureThread;
        private Thread _writerThread;
        private BoundedAudioBlockQueue _queue;
        private WaveStemWriter _waveWriter;
        private Exception _failure;
        private long _recordingStart100Nanoseconds;
        private int _sampleRate;
        private int _disposed;

        internal WasapiStemCapture(
            WasapiEndpointKind kind,
            string deviceId,
            string partialPath)
        {
            _kind = kind;
            _deviceId = deviceId;
            _partialPath = partialPath;
        }

        internal void BeginPrepare()
        {
            if (_captureThread != null)
                throw new InvalidOperationException("Audio capture has already been prepared.");
            _captureThread = new Thread(CaptureWorker);
            _captureThread.Name = _kind == WasapiEndpointKind.SystemLoopback
                ? "SharpShot system-audio capture"
                : "SharpShot microphone capture";
            _captureThread.IsBackground = true;
            _captureThread.SetApartmentState(ApartmentState.MTA);
            _captureThread.Start();
        }

        internal void WaitPrepared()
        {
            if (!_prepared.WaitOne(15000))
                throw new TimeoutException("Windows did not prepare the audio endpoint in time.");
            ThrowIfFailed();
        }

        internal void BeginStart()
        {
            _startGate.Set();
        }

        internal void AlignTimeline(long recordingStart100Nanoseconds)
        {
            if (recordingStart100Nanoseconds <= 0)
                throw new ArgumentOutOfRangeException("recordingStart100Nanoseconds");
            Interlocked.Exchange(ref _recordingStart100Nanoseconds, recordingStart100Nanoseconds);
            _timelineReady.Set();
        }

        internal void WaitStarted()
        {
            if (!_started.WaitOne(5000))
                throw new TimeoutException("Windows did not start the audio endpoint in time.");
            ThrowIfFailed();
        }

        internal void RequestStop()
        {
            _stop.Set();
            _startGate.Set();
            _timelineReady.Set();
            _dataReady.Set();
        }

        internal void ThrowIfFailed()
        {
            Exception failure = Interlocked.CompareExchange(
                ref _failure, null, null);
            if (failure != null)
                throw new IOException(
                    _kind == WasapiEndpointKind.SystemLoopback
                        ? "System-audio capture failed."
                        : "Microphone capture failed.",
                    failure);
        }

        internal void Complete(TimeSpan duration)
        {
            RequestStop();
            Thread thread = _captureThread;
            if (thread != null && thread.IsAlive && !thread.Join(10000))
                throw new TimeoutException("The audio endpoint did not stop in time.");
            Thread writerThread = _writerThread;
            if (writerThread != null && writerThread.IsAlive && !writerThread.Join(10000))
                throw new TimeoutException("The audio stem writer did not stop in time.");
            ThrowIfFailed();
            if (_waveWriter == null)
                throw new InvalidOperationException("The audio stem writer was not prepared.");
            long targetFrames = AudioTime.FramesForDuration(duration.Ticks, _sampleRate);
            _waveWriter.FinalizeExact(targetFrames);
            _waveWriter.Dispose();
            _waveWriter = null;
        }

        private void CaptureWorker()
        {
            IMMDeviceEnumerator enumerator = null;
            IMMDevice device = null;
            IAudioClient audioClient = null;
            IAudioCaptureClient captureClient = null;
            IntPtr mixFormatPointer = IntPtr.Zero;
            bool comInitialized = false;
            bool clientStarted = false;
            try
            {
                int comResult = AudioNative.CoInitializeEx(IntPtr.Zero, 0);
                if (comResult < 0)
                    throw new COMException("COM initialization failed for audio capture.", comResult);
                comInitialized = true;

                enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                int result;
                if (_kind == WasapiEndpointKind.SystemLoopback)
                {
                    result = enumerator.GetDefaultAudioEndpoint(0, 0, out device);
                }
                else if (String.Equals(_deviceId, "default", StringComparison.OrdinalIgnoreCase) ||
                         String.Equals(_deviceId, "default-console", StringComparison.OrdinalIgnoreCase))
                {
                    result = enumerator.GetDefaultAudioEndpoint(1, 0, out device);
                }
                else if (String.Equals(_deviceId, "default-communications", StringComparison.OrdinalIgnoreCase))
                {
                    result = enumerator.GetDefaultAudioEndpoint(1, 2, out device);
                }
                else
                {
                    result = enumerator.GetDevice(_deviceId, out device);
                }
                AudioNative.Check(result, "IMMDeviceEnumerator audio endpoint lookup");

                uint state;
                AudioNative.Check(device.GetState(out state), "IMMDevice.GetState");
                if ((state & DeviceStateActive) == 0)
                    throw new InvalidOperationException("The selected audio endpoint is not active.");

                Guid audioClientId = typeof(IAudioClient).GUID;
                object activated;
                AudioNative.Check(
                    device.Activate(ref audioClientId, ClsctxAll, IntPtr.Zero, out activated),
                    "IMMDevice.Activate(IAudioClient)");
                audioClient = (IAudioClient)activated;

                AudioNative.Check(audioClient.GetMixFormat(out mixFormatPointer),
                    "IAudioClient.GetMixFormat");
                WaveFormatDescriptor format = WaveFormatDescriptor.FromPointer(mixFormatPointer);
                _sampleRate = format.SampleRate;
                // Prefer event-driven capture for both endpoints. Some
                // USB/Bluetooth microphone drivers reject shared event mode
                // with E_INVALIDARG even for their own mix format; those inputs
                // are reactivated once and fall back to their reported device
                // period as a low-duty polling wait.
                bool eventDriven = _kind != WasapiEndpointKind.SystemLoopback ||
                                   AudioNative.SupportsEventDrivenLoopback();
                uint streamFlags = eventDriven ? StreamFlagEventCallback : 0;
                if (_kind == WasapiEndpointKind.SystemLoopback)
                    streamFlags |= StreamFlagLoopback | StreamFlagNoPersist;
                Guid sessionId = Guid.Empty;
                int initializeResult = audioClient.Initialize(
                        AudioClientShareModeShared,
                        streamFlags,
                        0,
                        0,
                        mixFormatPointer,
                        ref sessionId);
                if (_kind == WasapiEndpointKind.Microphone &&
                    initializeResult == EInvalidArgument)
                {
                    AudioNative.Release(audioClient);
                    audioClient = null;
                    object retryActivated;
                    AudioNative.Check(
                        device.Activate(
                            ref audioClientId,
                            ClsctxAll,
                            IntPtr.Zero,
                            out retryActivated),
                        "IMMDevice.Activate(IAudioClient fallback)");
                    audioClient = (IAudioClient)retryActivated;
                    eventDriven = false;
                    sessionId = Guid.Empty;
                    initializeResult = audioClient.Initialize(
                        AudioClientShareModeShared,
                        0,
                        0,
                        0,
                        mixFormatPointer,
                        ref sessionId);
                }
                AudioNative.Check(initializeResult, "IAudioClient.Initialize");
                int microphonePollMilliseconds = 10;
                if (eventDriven)
                {
                    AudioNative.Check(
                        audioClient.SetEventHandle(_dataReady.SafeWaitHandle.DangerousGetHandle()),
                        "IAudioClient.SetEventHandle");
                }
                else
                {
                    long defaultPeriod;
                    long minimumPeriod;
                    AudioNative.Check(
                        audioClient.GetDevicePeriod(out defaultPeriod, out minimumPeriod),
                        "IAudioClient.GetDevicePeriod");
                    microphonePollMilliseconds = Math.Max(2, Math.Min(20,
                        (int)Math.Max(1L, defaultPeriod / 20000L)));
                }

                uint bufferFrames;
                AudioNative.Check(audioClient.GetBufferSize(out bufferFrames),
                    "IAudioClient.GetBufferSize");
                int maximumPacketBytes = checked((int)bufferFrames * format.BlockAlign);
                if (maximumPacketBytes < 1 || maximumPacketBytes > 8 * 1024 * 1024)
                    throw new InvalidOperationException("The audio endpoint returned an unsafe buffer size.");
                int desiredQueueSlots = Math.Max(2, Math.Min(64,
                    (int)Math.Ceiling(format.SampleRate * 0.5 / Math.Max(1.0, bufferFrames))));
                int memoryBoundSlots = Math.Max(2,
                    (16 * 1024 * 1024) / maximumPacketBytes);
                int queueSlots = Math.Min(desiredQueueSlots, memoryBoundSlots);
                _queue = new BoundedAudioBlockQueue(queueSlots, maximumPacketBytes);
                _waveWriter = new WaveStemWriter(_partialPath, format);

                Guid captureClientId = typeof(IAudioCaptureClient).GUID;
                object service;
                AudioNative.Check(audioClient.GetService(ref captureClientId, out service),
                    "IAudioClient.GetService(IAudioCaptureClient)");
                captureClient = (IAudioCaptureClient)service;

                _writerThread = new Thread(WriterWorker);
                _writerThread.Name = _kind == WasapiEndpointKind.SystemLoopback
                    ? "SharpShot system-audio writer"
                    : "SharpShot microphone writer";
                _writerThread.Priority = ThreadPriority.BelowNormal;
                _writerThread.IsBackground = true;
                _writerThread.Start();

                _prepared.Set();
                _startGate.WaitOne();
                if (_stop.WaitOne(0)) return;

                AudioNative.Check(audioClient.Start(), "IAudioClient.Start");
                clientStarted = true;
                _started.Set();

                WaitHandle[] waits = eventDriven
                    ? new WaitHandle[] { _stop, _dataReady }
                    : null;
                while (true)
                {
                    if (eventDriven)
                    {
                        int signalled = WaitHandle.WaitAny(waits, 1000);
                        if (signalled == 0) break;
                    }
                    else if (_stop.WaitOne(microphonePollMilliseconds))
                    {
                        break;
                    }
                    DrainPackets(captureClient, format.BlockAlign);
                    if (_failure != null) break;
                }

                if (clientStarted)
                {
                    AudioNative.Check(audioClient.Stop(), "IAudioClient.Stop");
                    clientStarted = false;
                    DrainPackets(captureClient, format.BlockAlign);
                }
            }
            catch (Exception ex)
            {
                SetFailure(ex);
            }
            finally
            {
                if (clientStarted && audioClient != null)
                {
                    try { audioClient.Stop(); }
                    catch { }
                }
                _prepared.Set();
                _started.Set();
                if (_queue != null) _queue.Complete();
                Thread writer = _writerThread;
                if (writer != null && writer != Thread.CurrentThread)
                {
                    try
                    {
                        if (!writer.Join(10000))
                            SetFailure(new TimeoutException("The audio writer queue did not drain in time."));
                    }
                    catch (Exception ex) { SetFailure(ex); }
                }
                if (mixFormatPointer != IntPtr.Zero) Marshal.FreeCoTaskMem(mixFormatPointer);
                AudioNative.Release(captureClient);
                AudioNative.Release(audioClient);
                AudioNative.Release(device);
                AudioNative.Release(enumerator);
                if (comInitialized) AudioNative.CoUninitialize();
            }
        }

        private void DrainPackets(IAudioCaptureClient captureClient, int blockAlign)
        {
            while (true)
            {
                uint packetFrames;
                AudioNative.Check(captureClient.GetNextPacketSize(out packetFrames),
                    "IAudioCaptureClient.GetNextPacketSize");
                if (packetFrames == 0) return;

                IntPtr data;
                uint frames;
                uint flags;
                ulong devicePosition;
                ulong qpcPosition;
                AudioNative.Check(
                    captureClient.GetBuffer(
                        out data,
                        out frames,
                        out flags,
                        out devicePosition,
                        out qpcPosition),
                    "IAudioCaptureClient.GetBuffer");
                try
                {
                    int byteCount = checked((int)frames * blockAlign);
                    long qpc100Nanoseconds = (flags & BufferFlagTimestampError) != 0 ||
                                              qpcPosition > Int64.MaxValue
                        ? 0
                        : (long)qpcPosition;
                    bool silent = (flags & BufferFlagSilent) != 0 || data == IntPtr.Zero;
                    if (!_queue.TryEnqueue(
                        data,
                        byteCount,
                        frames,
                        flags,
                        qpc100Nanoseconds,
                        silent))
                    {
                        throw new IOException(
                            "The bounded audio queue overran; the foreground workload was not blocked.");
                    }
                }
                finally
                {
                    AudioNative.Check(captureClient.ReleaseBuffer(frames),
                        "IAudioCaptureClient.ReleaseBuffer");
                }
            }
        }

        private void WriterWorker()
        {
            try
            {
                _timelineReady.WaitOne();
                AudioBlock block;
                while (_queue.Acquire(out block))
                {
                    try
                    {
                        _waveWriter.AppendPacket(
                            block,
                            Interlocked.Read(ref _recordingStart100Nanoseconds),
                            BufferFlagDataDiscontinuity);
                    }
                    finally
                    {
                        _queue.ReleaseHead();
                    }
                }
            }
            catch (Exception ex)
            {
                SetFailure(ex);
                _stop.Set();
            }
        }

        private void SetFailure(Exception failure)
        {
            if (failure == null) return;
            Interlocked.CompareExchange(ref _failure, failure, null);
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
            RequestStop();
            Thread capture = _captureThread;
            bool captureFinished = capture == null || !capture.IsAlive;
            if (capture != null && capture.IsAlive && capture != Thread.CurrentThread)
            {
                try { captureFinished = capture.Join(5000); }
                catch { }
            }
            Thread writer = _writerThread;
            bool writerFinished = writer == null || !writer.IsAlive;
            if (writer != null && writer.IsAlive && writer != Thread.CurrentThread)
            {
                try { writerFinished = writer.Join(5000); }
                catch { }
            }
            // A broken driver can hold a COM call past shutdown. In that rare
            // case the process is already exiting; keep the worker-owned stream
            // and kernel handles valid rather than disposing them underneath a
            // live thread and risking an access violation.
            if (!captureFinished || !writerFinished) return;
            if (_waveWriter != null)
            {
                try { _waveWriter.Dispose(); }
                catch { }
                _waveWriter = null;
            }
            _prepared.Dispose();
            _startGate.Dispose();
            _started.Dispose();
            _timelineReady.Dispose();
            _stop.Dispose();
            _dataReady.Dispose();
        }
    }

    internal sealed class AudioBlock
    {
        internal readonly byte[] Buffer;
        internal int ByteCount;
        internal uint Frames;
        internal uint Flags;
        internal long Qpc100Nanoseconds;
        internal bool Silent;

        internal AudioBlock(int maximumBytes)
        {
            Buffer = new byte[maximumBytes];
        }
    }

    /// <summary>
    /// Single-producer/single-consumer fixed storage. Capture never waits for
    /// disk I/O. A full queue fails the requested audio capture instead of
    /// growing memory or stealing time from the application being recorded.
    /// </summary>
    internal sealed class BoundedAudioBlockQueue
    {
        private readonly object _sync = new object();
        private readonly AudioBlock[] _blocks;
        private int _head;
        private int _count;
        private bool _complete;

        internal BoundedAudioBlockQueue(int capacity, int maximumBlockBytes)
        {
            if (capacity < 1) throw new ArgumentOutOfRangeException("capacity");
            if (maximumBlockBytes < 1) throw new ArgumentOutOfRangeException("maximumBlockBytes");
            _blocks = new AudioBlock[capacity];
            for (int index = 0; index < capacity; index++)
                _blocks[index] = new AudioBlock(maximumBlockBytes);
        }

        internal bool TryEnqueue(
            IntPtr data,
            int byteCount,
            uint frames,
            uint flags,
            long qpc100Nanoseconds,
            bool silent)
        {
            lock (_sync)
            {
                if (_complete || _count == _blocks.Length) return false;
                int index = (_head + _count) % _blocks.Length;
                AudioBlock block = _blocks[index];
                if (byteCount < 0 || byteCount > block.Buffer.Length)
                    throw new InvalidOperationException("An audio packet exceeded the endpoint buffer size.");
                if (!silent && byteCount > 0)
                    Marshal.Copy(data, block.Buffer, 0, byteCount);
                block.ByteCount = byteCount;
                block.Frames = frames;
                block.Flags = flags;
                block.Qpc100Nanoseconds = qpc100Nanoseconds;
                block.Silent = silent;
                _count++;
                Monitor.PulseAll(_sync);
                return true;
            }
        }

        internal bool Acquire(out AudioBlock block)
        {
            lock (_sync)
            {
                while (_count == 0 && !_complete) Monitor.Wait(_sync);
                if (_count == 0)
                {
                    block = null;
                    return false;
                }
                block = _blocks[_head];
                return true;
            }
        }

        internal void ReleaseHead()
        {
            lock (_sync)
            {
                if (_count < 1) throw new InvalidOperationException("The audio queue is empty.");
                AudioBlock block = _blocks[_head];
                block.ByteCount = 0;
                block.Frames = 0;
                block.Flags = 0;
                block.Qpc100Nanoseconds = 0;
                block.Silent = false;
                _head = (_head + 1) % _blocks.Length;
                _count--;
                Monitor.PulseAll(_sync);
            }
        }

        internal void Complete()
        {
            lock (_sync)
            {
                _complete = true;
                Monitor.PulseAll(_sync);
            }
        }
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    internal struct WaveFormatEx
    {
        internal ushort FormatTag;
        internal ushort Channels;
        internal uint SamplesPerSecond;
        internal uint AverageBytesPerSecond;
        internal ushort BlockAlign;
        internal ushort BitsPerSample;
        internal ushort ExtraSize;
    }

    internal sealed class WaveFormatDescriptor
    {
        internal readonly byte[] Bytes;
        internal readonly int SampleRate;
        internal readonly int BlockAlign;
        internal readonly ushort FormatTag;

        internal WaveFormatDescriptor(byte[] bytes, int sampleRate, int blockAlign)
        {
            Bytes = bytes;
            SampleRate = sampleRate;
            BlockAlign = blockAlign;
            if (bytes == null || bytes.Length < 2)
                throw new ArgumentException("A WAVE format header is required.", "bytes");
            FormatTag = (ushort)(bytes[0] | (bytes[1] << 8));
        }

        internal static WaveFormatDescriptor FromPointer(IntPtr pointer)
        {
            if (pointer == IntPtr.Zero)
                throw new InvalidOperationException("The audio endpoint returned no mix format.");
            WaveFormatEx value = (WaveFormatEx)Marshal.PtrToStructure(
                pointer, typeof(WaveFormatEx));
            if (value.Channels < 1 || value.Channels > 32 ||
                value.SamplesPerSecond < 8000 || value.SamplesPerSecond > 384000 ||
                value.BlockAlign < 1 || value.BlockAlign > 256 ||
                value.AverageBytesPerSecond < value.BlockAlign)
                throw new InvalidOperationException("The audio endpoint returned an unsupported mix format.");
            int formatSize = (value.FormatTag == 1 || value.FormatTag == 3) && value.ExtraSize == 0
                ? 16
                : checked(18 + value.ExtraSize);
            if (formatSize < 16 || formatSize > 512)
                throw new InvalidOperationException("The audio endpoint mix format is too large.");
            byte[] bytes = new byte[formatSize];
            Marshal.Copy(pointer, bytes, 0, bytes.Length);
            return new WaveFormatDescriptor(bytes, (int)value.SamplesPerSecond, value.BlockAlign);
        }
    }

    /// <summary>
    /// Writes RIFF WAV for normal files and upgrades the reserved JUNK header to
    /// RF64/ds64 if a long recording crosses the 4 GiB RIFF limit.
    /// </summary>
    internal sealed class WaveStemWriter : IDisposable
    {
        private static readonly byte[] Zeroes = new byte[65536];
        private readonly FileStream _stream;
        private readonly WaveFormatDescriptor _format;
        private readonly long _dataSizeOffset;
        private readonly long _dataOffset;
        private readonly long _factSampleCountOffset;
        private long _framesWritten;
        private bool _timelineAnchored;
        private bool _finalized;

        internal WaveStemWriter(string path, WaveFormatDescriptor format)
        {
            _format = format;
            _stream = new FileStream(
                path,
                FileMode.CreateNew,
                FileAccess.ReadWrite,
                FileShare.Read,
                65536,
                FileOptions.SequentialScan);
            WriteAscii("RIFF");
            WriteUInt32(0);
            WriteAscii("WAVE");
            WriteAscii("JUNK");
            WriteUInt32(28);
            _stream.Write(Zeroes, 0, 28);
            WriteAscii("fmt ");
            WriteUInt32((uint)format.Bytes.Length);
            _stream.Write(format.Bytes, 0, format.Bytes.Length);
            if ((format.Bytes.Length & 1) != 0) _stream.WriteByte(0);
            if (format.FormatTag != 1)
            {
                WriteAscii("fact");
                WriteUInt32(4);
                _factSampleCountOffset = _stream.Position;
                WriteUInt32(0);
            }
            else
            {
                _factSampleCountOffset = -1;
            }
            WriteAscii("data");
            _dataSizeOffset = _stream.Position;
            WriteUInt32(0);
            _dataOffset = _stream.Position;
        }

        internal void AppendPacket(
            AudioBlock block,
            long recordingStart100Nanoseconds,
            uint discontinuityFlag)
        {
            if (_finalized) throw new InvalidOperationException("The WAV stem is finalized.");
            int skipFrames = 0;
            bool hasTimestamp = block.Qpc100Nanoseconds > 0 &&
                                recordingStart100Nanoseconds > 0;
            bool wasTimelineAnchored = _timelineAnchored;
            if ((!_timelineAnchored || (block.Flags & discontinuityFlag) != 0) && hasTimestamp)
            {
                long delta = block.Qpc100Nanoseconds - recordingStart100Nanoseconds;
                // A real packet timestamp cannot reasonably be a minute away
                // from this short-lived recorder's start. Treat larger values as
                // an unavailable/timestamp-error packet instead of allocating a
                // giant silent gap because of a buggy driver.
                if (delta > -600000000L && delta < 600000000L)
                {
                    long packetStart = AudioTime.FramesForSignedDuration(delta, _format.SampleRate);
                    if (packetStart > _framesWritten)
                        WriteSilenceFrames(packetStart - _framesWritten);
                    else if (packetStart < _framesWritten)
                        skipFrames = (int)Math.Min(
                            (long)block.Frames,
                            _framesWritten - packetStart);
                }
                // Audio clients are deliberately running before the video clock
                // starts. More than one buffered packet can therefore be wholly
                // pre-roll. Do not anchor on a fully discarded packet; the next
                // packet still needs its QPC timestamp to trim up to t=0.
                if (!wasTimelineAnchored && skipFrames >= (long)block.Frames)
                    return;
                _timelineAnchored = true;
            }
            else if (!_timelineAnchored)
            {
                _timelineAnchored = true;
            }

            int framesToWrite = checked((int)block.Frames - skipFrames);
            if (framesToWrite <= 0) return;
            int byteOffset = checked(skipFrames * _format.BlockAlign);
            int byteCount = checked(framesToWrite * _format.BlockAlign);
            if (byteOffset + byteCount > block.ByteCount)
                throw new InvalidDataException("The captured audio packet length is inconsistent.");
            if (block.Silent)
                WriteZeroBytes(byteCount);
            else
                _stream.Write(block.Buffer, byteOffset, byteCount);
            _framesWritten += framesToWrite;
        }

        internal void FinalizeExact(long targetFrames)
        {
            if (_finalized) return;
            if (targetFrames < 0) targetFrames = 0;
            if (_framesWritten < targetFrames)
                WriteSilenceFrames(targetFrames - _framesWritten);
            else if (_framesWritten > targetFrames)
            {
                long desiredLength = checked(_dataOffset + targetFrames * _format.BlockAlign);
                _stream.SetLength(desiredLength);
                _framesWritten = targetFrames;
            }

            long dataBytes = checked(_framesWritten * _format.BlockAlign);
            long dataEnd = checked(_dataOffset + dataBytes);
            _stream.SetLength(dataEnd);
            if ((dataBytes & 1L) != 0)
            {
                _stream.Position = dataEnd;
                _stream.WriteByte(0);
            }
            long riffSize = checked(_stream.Length - 8);
            if (riffSize <= UInt32.MaxValue && dataBytes <= UInt32.MaxValue)
            {
                _stream.Position = 0;
                WriteAscii("RIFF");
                _stream.Position = 4;
                WriteUInt32((uint)riffSize);
                _stream.Position = _dataSizeOffset;
                WriteUInt32((uint)dataBytes);
            }
            else
            {
                _stream.Position = 0;
                WriteAscii("RF64");
                WriteUInt32(UInt32.MaxValue);
                WriteAscii("WAVE");
                WriteAscii("ds64");
                WriteUInt32(28);
                WriteUInt64((ulong)riffSize);
                WriteUInt64((ulong)dataBytes);
                WriteUInt64((ulong)_framesWritten);
                WriteUInt32(0);
                _stream.Position = _dataSizeOffset;
                WriteUInt32(UInt32.MaxValue);
            }
            if (_factSampleCountOffset >= 0)
            {
                _stream.Position = _factSampleCountOffset;
                WriteUInt32((uint)Math.Min((long)UInt32.MaxValue, _framesWritten));
            }
            _stream.Position = _stream.Length;
            _stream.Flush(true);
            _finalized = true;
        }

        private void WriteSilenceFrames(long frames)
        {
            if (frames <= 0) return;
            long bytes = checked(frames * _format.BlockAlign);
            WriteZeroBytes(bytes);
            _framesWritten += frames;
        }

        private void WriteZeroBytes(long count)
        {
            while (count > 0)
            {
                int write = (int)Math.Min((long)Zeroes.Length, count);
                _stream.Write(Zeroes, 0, write);
                count -= write;
            }
        }

        private void WriteAscii(string value)
        {
            for (int index = 0; index < value.Length; index++)
                _stream.WriteByte((byte)value[index]);
        }

        private void WriteUInt32(uint value)
        {
            _stream.WriteByte((byte)value);
            _stream.WriteByte((byte)(value >> 8));
            _stream.WriteByte((byte)(value >> 16));
            _stream.WriteByte((byte)(value >> 24));
        }

        private void WriteUInt64(ulong value)
        {
            WriteUInt32((uint)value);
            WriteUInt32((uint)(value >> 32));
        }

        public void Dispose()
        {
            _stream.Dispose();
        }
    }

    internal static class AudioTime
    {
        internal static long Monotonic100Nanoseconds()
        {
            long counter;
            long frequency;
            if (!AudioNative.QueryPerformanceCounter(out counter) ||
                !AudioNative.QueryPerformanceFrequency(out frequency) || frequency <= 0)
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "The monotonic performance clock is unavailable.");
            long seconds = counter / frequency;
            long remainder = counter % frequency;
            return checked(seconds * 10000000L + remainder * 10000000L / frequency);
        }

        internal static long FramesForDuration(long duration100Nanoseconds, int sampleRate)
        {
            if (duration100Nanoseconds <= 0 || sampleRate <= 0) return 0;
            long seconds = duration100Nanoseconds / 10000000L;
            long remainder = duration100Nanoseconds % 10000000L;
            return checked(seconds * sampleRate +
                (remainder * sampleRate + 5000000L) / 10000000L);
        }

        internal static long FramesForSignedDuration(long duration100Nanoseconds, int sampleRate)
        {
            if (duration100Nanoseconds >= 0)
                return FramesForDuration(duration100Nanoseconds, sampleRate);
            if (duration100Nanoseconds == Int64.MinValue) return Int64.MinValue;
            return -FramesForDuration(-duration100Nanoseconds, sampleRate);
        }
    }

    internal static class AudioNative
    {
        [DllImport("ole32.dll", ExactSpelling = true)]
        internal static extern int CoInitializeEx(IntPtr reserved, int concurrencyModel);

        [DllImport("ole32.dll", ExactSpelling = true)]
        internal static extern void CoUninitialize();

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool QueryPerformanceCounter(out long value);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool QueryPerformanceFrequency(out long value);

        internal static void Check(int result, string operation)
        {
            if (result < 0)
                throw new COMException(operation + " failed (0x" + result.ToString("X8") + ").", result);
        }

        internal static void Release(object value)
        {
            try
            {
                if (value != null && Marshal.IsComObject(value))
                    Marshal.FinalReleaseComObject(value);
            }
            catch { }
        }

        internal static bool SupportsEventDrivenLoopback()
        {
            Version version = Environment.OSVersion.Version;
            return version.Major > 10 ||
                   (version.Major == 10 && version.Build >= 15063);
        }
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject
    {
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, uint stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceId,
            out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig] int Activate(
            [In] ref Guid interfaceId,
            uint classContext,
            IntPtr activationParameters,
            [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
        [PreserveSig] int OpenPropertyStore(uint storageMode, out IntPtr properties);
        [PreserveSig] int GetId(out IntPtr deviceId);
        [PreserveSig] int GetState(out uint state);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient
    {
        [PreserveSig] int Initialize(
            int shareMode,
            uint streamFlags,
            long bufferDuration,
            long periodicity,
            IntPtr format,
            [In] ref Guid audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint bufferFrames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint paddingFrames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr deviceFormat);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(
            [In] ref Guid interfaceId,
            [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(
            out IntPtr data,
            out uint frames,
            out uint flags,
            out ulong devicePosition,
            out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    internal static class AudioRecordingSelfTest
    {
        internal static void Verify(string outputFolder)
        {
            if (Marshal.SizeOf(typeof(WaveFormatEx)) != 18)
                throw new InvalidOperationException("WAVEFORMATEX interop layout changed.");
            if (AudioTime.FramesForDuration(10000000L, 48000) != 48000 ||
                AudioTime.FramesForSignedDuration(-5000000L, 48000) != -24000)
                throw new InvalidOperationException("Audio timestamp conversion changed.");

            byte[] formatBytes = new byte[]
            {
                1, 0, 2, 0,
                0x80, 0xBB, 0, 0,
                0, 0xEE, 2, 0,
                4, 0, 16, 0
            };
            WaveFormatDescriptor format = new WaveFormatDescriptor(
                formatBytes, 48000, 4);
            string path = Path.Combine(outputFolder, "audio-stem-self-test.wav");
            try
            {
                if (File.Exists(path)) File.Delete(path);
                using (WaveStemWriter writer = new WaveStemWriter(path, format))
                    writer.FinalizeExact(480);
                byte[] bytes = File.ReadAllBytes(path);
                if (bytes.Length != 80 + 1920 ||
                    ReadAscii(bytes, 0, 4) != "RIFF" ||
                    ReadAscii(bytes, 8, 4) != "WAVE" ||
                    ReadAscii(bytes, 12, 4) != "JUNK" ||
                    ReadAscii(bytes, 48, 4) != "fmt " ||
                    ReadAscii(bytes, 72, 4) != "data" ||
                    ReadUInt32(bytes, 76) != 1920)
                    throw new InvalidDataException("The synchronized WAV stem header is invalid.");
            }
            finally
            {
                try { if (File.Exists(path)) File.Delete(path); }
                catch { }
            }

            byte[] mono8Bytes = new byte[]
            {
                1, 0, 1, 0,
                0x40, 0x1F, 0, 0,
                0x40, 0x1F, 0, 0,
                1, 0, 8, 0
            };
            WaveFormatDescriptor mono8 = new WaveFormatDescriptor(mono8Bytes, 8000, 1);
            string oddPath = Path.Combine(outputFolder, "audio-odd-padding-self-test.wav");
            try
            {
                if (File.Exists(oddPath)) File.Delete(oddPath);
                using (WaveStemWriter writer = new WaveStemWriter(oddPath, mono8))
                    writer.FinalizeExact(1);
                byte[] bytes = File.ReadAllBytes(oddPath);
                if (bytes.Length != 82 || ReadUInt32(bytes, 76) != 1 || bytes[81] != 0)
                    throw new InvalidDataException("The WAV data chunk padding is invalid.");
            }
            finally
            {
                try { if (File.Exists(oddPath)) File.Delete(oddPath); }
                catch { }
            }

            byte[] floatBytes = new byte[]
            {
                3, 0, 1, 0,
                0x80, 0xBB, 0, 0,
                0, 0xEE, 2, 0,
                4, 0, 32, 0
            };
            WaveFormatDescriptor floatFormat = new WaveFormatDescriptor(
                floatBytes, 48000, 4);
            string floatPath = Path.Combine(outputFolder, "audio-float-self-test.wav");
            try
            {
                if (File.Exists(floatPath)) File.Delete(floatPath);
                using (WaveStemWriter writer = new WaveStemWriter(floatPath, floatFormat))
                    writer.FinalizeExact(100);
                byte[] bytes = File.ReadAllBytes(floatPath);
                if (bytes.Length != 492 ||
                    ReadAscii(bytes, 72, 4) != "fact" ||
                    ReadUInt32(bytes, 80) != 100 ||
                    ReadAscii(bytes, 84, 4) != "data" ||
                    ReadUInt32(bytes, 88) != 400)
                    throw new InvalidDataException("The IEEE-float WAV fact chunk is invalid.");
            }
            finally
            {
                try { if (File.Exists(floatPath)) File.Delete(floatPath); }
                catch { }
            }

            string prerollPath = Path.Combine(outputFolder, "audio-preroll-self-test.wav");
            try
            {
                if (File.Exists(prerollPath)) File.Delete(prerollPath);
                const long timelineStart = 1000000000L;
                AudioBlock earlyOne = new AudioBlock(960);
                AudioBlock earlyTwo = new AudioBlock(960);
                AudioBlock onTime = new AudioBlock(960);
                earlyOne.ByteCount = earlyTwo.ByteCount = onTime.ByteCount = 960;
                earlyOne.Frames = earlyTwo.Frames = onTime.Frames = 480;
                earlyOne.Qpc100Nanoseconds = timelineStart - 200000L;
                earlyTwo.Qpc100Nanoseconds = timelineStart - 100000L;
                onTime.Qpc100Nanoseconds = timelineStart;
                for (int index = 0; index < 960; index++)
                {
                    earlyOne.Buffer[index] = 1;
                    earlyTwo.Buffer[index] = 2;
                    onTime.Buffer[index] = 3;
                }
                byte[] mono16Bytes = new byte[]
                {
                    1, 0, 1, 0,
                    0x80, 0xBB, 0, 0,
                    0, 0x77, 1, 0,
                    2, 0, 16, 0
                };
                WaveFormatDescriptor mono16 = new WaveFormatDescriptor(
                    mono16Bytes, 48000, 2);
                using (WaveStemWriter writer = new WaveStemWriter(prerollPath, mono16))
                {
                    writer.AppendPacket(earlyOne, timelineStart, 1);
                    writer.AppendPacket(earlyTwo, timelineStart, 1);
                    writer.AppendPacket(onTime, timelineStart, 1);
                    writer.FinalizeExact(480);
                }
                byte[] bytes = File.ReadAllBytes(prerollPath);
                if (bytes.Length != 1040 || bytes[80] != 3 || bytes[bytes.Length - 1] != 3)
                    throw new InvalidDataException("Fully pre-roll audio leaked into the stem timeline.");
            }
            finally
            {
                try { if (File.Exists(prerollPath)) File.Delete(prerollPath); }
                catch { }
            }

            string resultPath = Path.Combine(outputFolder, "audio-result-self-test.ini");
            try
            {
                if (File.Exists(resultPath)) File.Delete(resultPath);
                string systemPath = Path.Combine(outputFolder, "system stem.wav");
                string microphonePath = Path.Combine(outputFolder, "microphone stem.wav");
                StudioOneShot.TryWriteResult(
                    resultPath,
                    "completed",
                    Path.Combine(outputFolder, "video.mp4"),
                    1280,
                    720,
                    1000,
                    false,
                    null,
                    null,
                    systemPath,
                    microphonePath);
                string result = File.ReadAllText(resultPath);
                string expectedSystem = "systemAudioPath64=" + Convert.ToBase64String(
                    System.Text.Encoding.UTF8.GetBytes(systemPath));
                string expectedMicrophone = "microphonePath64=" + Convert.ToBase64String(
                    System.Text.Encoding.UTF8.GetBytes(microphonePath));
                if (result.IndexOf(expectedSystem, StringComparison.Ordinal) < 0 ||
                    result.IndexOf(expectedMicrophone, StringComparison.Ordinal) < 0)
                    throw new InvalidDataException("Studio result omitted an audio stem path.");
            }
            finally
            {
                try { if (File.Exists(resultPath)) File.Delete(resultPath); }
                catch { }
            }
        }

        internal static void VerifyLive(string outputFolder)
        {
            VerifyLiveEndpoint(
                outputFolder,
                "audio-loopback-live-probe",
                new AudioCaptureOptions(true, null),
                true,
                false);
        }

        internal static void VerifyLiveMicrophone(string outputFolder)
        {
            VerifyLiveEndpoint(
                outputFolder,
                "audio-microphone-live-probe",
                new AudioCaptureOptions(false, "default"),
                false,
                true);
        }

        internal static void VerifyLiveCombined(string outputFolder)
        {
            VerifyLiveEndpoint(
                outputFolder,
                "audio-combined-live-probe",
                new AudioCaptureOptions(true, "default"),
                true,
                true);
        }

        private static void VerifyLiveEndpoint(
            string outputFolder,
            string probeName,
            AudioCaptureOptions options,
            bool verifySystemAudio,
            bool verifyMicrophone)
        {
            string videoPath = Path.Combine(outputFolder, probeName + ".mp4");
            RecordingAudioPaths paths = RecordingAudioPaths.ForVideo(videoPath, options);
            paths.DeleteArtifacts();
            try
            {
                Stopwatch clock = new Stopwatch();
                using (AudioCaptureGroup capture = new AudioCaptureGroup(options, paths))
                {
                    capture.Prepare();
                    capture.Start();
                    long start = AudioTime.Monotonic100Nanoseconds();
                    clock.Start();
                    capture.AlignTimeline(start);
                    Thread.Sleep(300);
                    clock.Stop();
                    capture.ThrowIfFailed();
                    capture.Complete(clock.Elapsed);
                    capture.Commit();
                }
                double systemDuration = 0;
                double microphoneDuration = 0;
                if (verifySystemAudio)
                    systemDuration = ReadWaveDurationSeconds(paths.SystemFinalPath);
                if (verifyMicrophone)
                    microphoneDuration = ReadWaveDurationSeconds(paths.MicrophoneFinalPath);
                if ((verifySystemAudio && (systemDuration < 0.25 || systemDuration > 0.75)) ||
                    (verifyMicrophone && (microphoneDuration < 0.25 || microphoneDuration > 0.75)))
                    throw new InvalidDataException("The live WASAPI stem duration is invalid.");
                if (verifySystemAudio && verifyMicrophone &&
                    Math.Abs(systemDuration - microphoneDuration) > 0.002)
                    throw new InvalidDataException("The live WASAPI stems are not time-aligned.");
            }
            finally
            {
                paths.DeleteArtifacts();
            }
        }

        private static string ReadAscii(byte[] value, int offset, int count)
        {
            char[] text = new char[count];
            for (int index = 0; index < count; index++)
                text[index] = (char)value[offset + index];
            return new String(text);
        }

        private static uint ReadUInt32(byte[] value, int offset)
        {
            return (uint)(value[offset] |
                (value[offset + 1] << 8) |
                (value[offset + 2] << 16) |
                (value[offset + 3] << 24));
        }

        private static double ReadWaveDurationSeconds(string path)
        {
            if (!File.Exists(path))
                throw new FileNotFoundException("The live WASAPI stem is missing.", path);
            byte[] value = File.ReadAllBytes(path);
            if (value.Length < 64 || ReadAscii(value, 0, 4) != "RIFF" ||
                ReadAscii(value, 8, 4) != "WAVE")
                throw new InvalidDataException("The live WASAPI stem is not a RIFF WAVE file.");

            int sampleRate = 0;
            int blockAlign = 0;
            long dataBytes = -1;
            int position = 12;
            while (position <= value.Length - 8)
            {
                string chunk = ReadAscii(value, position, 4);
                uint size = ReadUInt32(value, position + 4);
                long content = position + 8L;
                long next = content + size + (size & 1U);
                if (next > value.Length) throw new InvalidDataException("A WAV chunk is truncated.");
                if (chunk == "fmt " && size >= 16)
                {
                    sampleRate = (int)ReadUInt32(value, (int)content + 4);
                    blockAlign = value[(int)content + 12] |
                                 (value[(int)content + 13] << 8);
                }
                else if (chunk == "data")
                {
                    dataBytes = size;
                    break;
                }
                position = (int)next;
            }
            if (sampleRate < 1 || blockAlign < 1 || dataBytes < 1 ||
                dataBytes % blockAlign != 0)
                throw new InvalidDataException("The live WASAPI WAV format is invalid.");
            return (dataBytes / (double)blockAlign) / sampleRate;
        }

    }
}
