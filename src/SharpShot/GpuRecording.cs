using System;
using System.Runtime.InteropServices;

namespace SharpShot
{
    internal static class RecordingThreadPriority
    {
        private const int ThreadModeBackgroundBegin = 0x00010000;
        private const int ThreadModeBackgroundEnd = 0x00020000;

        internal static bool Begin()
        {
            return SetThreadPriority(GetCurrentThread(), ThreadModeBackgroundBegin);
        }

        internal static void End()
        {
            SetThreadPriority(GetCurrentThread(), ThreadModeBackgroundEnd);
        }

        [DllImport("kernel32.dll", ExactSpelling = true)]
        private static extern IntPtr GetCurrentThread();

        [DllImport("kernel32.dll", ExactSpelling = true)]
        private static extern bool SetThreadPriority(IntPtr thread, int priority);
    }

    internal static class RecordingFrameSubmitter
    {
        internal static bool Write(
            MediaFoundationVideoWriter writer,
            IRecordingFrameGrabber grabber,
            long timestamp,
            long duration)
        {
            AdaptiveRecordingFrameGrabber adaptive =
                grabber as AdaptiveRecordingFrameGrabber;
            IntPtr surface = IntPtr.Zero;
            bool surfaceWritten = false;
            bool callbackOwnsSurface = false;
            if (writer.SupportsGpuSurfaceInput && adaptive != null &&
                adaptive.TryCaptureSurface(out surface))
            {
                if (surface == IntPtr.Zero) return false;
                try
                {
                    writer.WriteSurfaceFrame(
                        surface, timestamp, duration, adaptive.ReturnSurface,
                        out callbackOwnsSurface);
                    surfaceWritten = true;
                }
                catch (Exception error)
                {
                    if (!MediaFoundationVideoWriter.IsSurfaceCompatibilityFailure(error))
                        throw;
                    if (!callbackOwnsSurface) adaptive.ReturnSurface(surface);
                    writer.DisableGpuSurfaceInput();
                }
                finally
                {
                    if (surface != IntPtr.Zero) Marshal.Release(surface);
                }
            }
            if (surfaceWritten) return true;
            grabber.Capture();
            writer.WriteFrame(grabber.Pixels, grabber.ByteCount, timestamp, duration);
            return true;
        }
    }

    internal sealed partial class MediaFoundationVideoWriter
    {
        private static readonly Guid D3d11Texture2d =
            new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
        private bool _supportsGpuSurfaceInput;
        private int _surfaceByteCount;

        internal bool SupportsGpuSurfaceInput
        {
            get { return _supportsGpuSurfaceInput; }
        }

        internal void WriteSurfaceFrame(
            IntPtr surface,
            long timestamp,
            long duration,
            Action<IntPtr> returnSurface,
            out bool callbackOwnsSurface)
        {
            callbackOwnsSurface = false;
            if (!_supportsGpuSurfaceInput)
                throw new InvalidOperationException("GPU surface input is not active.");
            IMfMediaBuffer buffer = null;
            IMfSample sample = null;
            IMfTrackedSample trackedSample = null;
            try
            {
                Guid textureId = D3d11Texture2d;
                MfCheck(RecordingGpuNative.MFCreateDXGISurfaceBuffer(
                    ref textureId, surface, 0, false, out buffer),
                    "MFCreateDXGISurfaceBuffer");
                MfCheck(buffer.SetCurrentLength(_surfaceByteCount),
                    "IMFMediaBuffer.SetCurrentLength(surface)");
                MfCheck(RecordingGpuNative.MFCreateTrackedSample(out trackedSample),
                    "MFCreateTrackedSample");
                sample = (IMfSample)trackedSample;
                MfCheck(trackedSample.SetAllocator(
                    new SurfaceReleaseCallback(surface, returnSurface), null),
                    "IMFTrackedSample.SetAllocator");
                callbackOwnsSurface = true;
                MfCheck(sample.AddBuffer(buffer), "IMFSample.AddBuffer");
                MfCheck(sample.SetSampleTime(timestamp), "IMFSample.SetSampleTime");
                MfCheck(sample.SetSampleDuration(duration), "IMFSample.SetSampleDuration");
                MfCheck(_writer.WriteSample(_streamIndex, sample),
                    "IMFSinkWriter.WriteSample(surface)");
            }
            finally
            {
                MfRelease(sample);
                trackedSample = null;
                MfRelease(buffer);
            }
        }

        internal void DisableGpuSurfaceInput()
        {
            _supportsGpuSurfaceInput = false;
        }

        internal static bool IsSurfaceCompatibilityFailure(Exception error)
        {
            return error is COMException || error is EntryPointNotFoundException ||
                   error is PlatformNotSupportedException;
        }

        private bool TryAttachSharedDxgiManager(
            IMfAttributes attributes,
            IntPtr sharedDevice)
        {
            IMfDxgiDeviceManager manager = null;
            bool deviceReferenceOwned = false;
            try
            {
                Marshal.AddRef(sharedDevice);
                deviceReferenceOwned = true;
                uint resetToken;
                int result = RecordingNative.MFCreateDXGIDeviceManager(
                    out resetToken, out manager);
                if (result < 0 || manager == null) return false;
                if (manager.ResetDevice(sharedDevice, resetToken) < 0) return false;
                Guid key = MfGuids.SinkWriterD3dManager;
                if (attributes.SetUnknown(ref key, manager) < 0) return false;

                _d3dDevice = sharedDevice;
                _dxgiManager = manager;
                deviceReferenceOwned = false;
                manager = null;
                return true;
            }
            finally
            {
                MfRelease(manager);
                if (deviceReferenceOwned) Marshal.Release(sharedDevice);
            }
        }
    }

    internal static class RecordingGpuNative
    {
        [DllImport("mfplat.dll", ExactSpelling = true)]
        internal static extern int MFCreateDXGISurfaceBuffer(
            [In] ref Guid interfaceId,
            IntPtr surface,
            uint subresourceIndex,
            [MarshalAs(UnmanagedType.Bool)] bool bottomUpWhenLinear,
            out IMfMediaBuffer buffer);

        [DllImport("mfplat.dll", ExactSpelling = true)]
        internal static extern int MFCreateTrackedSample(
            out IMfTrackedSample sample);
    }

    [ComImport, Guid("245bf8e9-0755-40f7-88a5-ae0f18d55e17"),
        InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMfTrackedSample
    {
        [PreserveSig]
        int SetAllocator(
            IMfAsyncCallback callback,
            [MarshalAs(UnmanagedType.IUnknown)] object state);
    }

    [ComVisible(true), Guid("a27003cf-2354-4f2a-8d6a-ab7cff15437e"),
        InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMfAsyncCallback
    {
        [PreserveSig] int GetParameters(out uint flags, out uint queue);
        [PreserveSig] int Invoke(IntPtr asyncResult);
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    internal sealed class SurfaceReleaseCallback : IMfAsyncCallback
    {
        private readonly IntPtr _surface;
        private readonly Action<IntPtr> _returnSurface;
        private int _returned;

        internal SurfaceReleaseCallback(
            IntPtr surface,
            Action<IntPtr> returnSurface)
        {
            _surface = surface;
            _returnSurface = returnSurface;
        }

        public int GetParameters(out uint flags, out uint queue)
        {
            flags = 0;
            queue = 0;
            return unchecked((int)0x80004001);
        }

        public int Invoke(IntPtr asyncResult)
        {
            if (System.Threading.Interlocked.Exchange(ref _returned, 1) == 0)
                _returnSurface(_surface);
            return 0;
        }
    }
}
