using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Runtime.InteropServices;

namespace SharpShot
{
    internal static class RecordingFrameGrabber
    {
        internal static IRecordingFrameGrabber Create(Rectangle region)
        {
            return Create(region, true);
        }

        internal static IRecordingFrameGrabber Create(Rectangle region, bool includeCursor)
        {
            return new AdaptiveRecordingFrameGrabber(region, region.Size, includeCursor);
        }

        internal static IRecordingFrameGrabber Create(
            Rectangle region,
            Size outputSize,
            bool includeCursor)
        {
            return new AdaptiveRecordingFrameGrabber(region, outputSize, includeCursor);
        }
    }

    internal sealed class AdaptiveRecordingFrameGrabber : IRecordingFrameGrabber
    {
        private readonly Rectangle _region;
        private readonly Size _outputSize;
        private readonly bool _includeCursor;
        private IRecordingFrameGrabber _active;
        private bool _usingDesktopDuplication;

        internal AdaptiveRecordingFrameGrabber(Rectangle region)
            : this(region, region.Size, true)
        {
        }

        internal AdaptiveRecordingFrameGrabber(Rectangle region, bool includeCursor)
            : this(region, region.Size, includeCursor)
        {
        }

        internal AdaptiveRecordingFrameGrabber(
            Rectangle region,
            Size outputSize,
            bool includeCursor)
        {
            _region = region;
            _outputSize = outputSize;
            _includeCursor = includeCursor;
            try
            {
                _active = new DesktopDuplicationFrameGrabber(
                    region, outputSize, includeCursor);
                _usingDesktopDuplication = true;
            }
            catch (Exception error)
            {
                if (!IsCompatibilityFailure(error)) throw;
                _active = new GdiFrameGrabber(region, outputSize, includeCursor);
            }
        }

        public IntPtr Pixels { get { return _active.Pixels; } }
        public int ByteCount { get { return _active.ByteCount; } }

        internal IntPtr D3dDevice
        {
            get
            {
                DesktopDuplicationFrameGrabber duplication =
                    _active as DesktopDuplicationFrameGrabber;
                return duplication == null ? IntPtr.Zero : duplication.D3dDevice;
            }
        }

        internal bool TryCaptureSurface(out IntPtr surface)
        {
            surface = IntPtr.Zero;
            DesktopDuplicationFrameGrabber duplication =
                _active as DesktopDuplicationFrameGrabber;
            if (duplication == null) return false;
            try
            {
                surface = duplication.CaptureSurface();
                return true;
            }
            catch (Exception error)
            {
                if (!IsCompatibilityFailure(error)) throw;
                _active.Dispose();
                _active = new GdiFrameGrabber(
                    _region, _outputSize, _includeCursor);
                _usingDesktopDuplication = false;
                return false;
            }
        }

        internal void ReturnSurface(IntPtr surface)
        {
            DesktopDuplicationFrameGrabber duplication =
                _active as DesktopDuplicationFrameGrabber;
            if (duplication != null) duplication.ReturnSurface(surface);
        }

        public void Capture()
        {
            try
            {
                _active.Capture();
            }
            catch (Exception error)
            {
                if (!_usingDesktopDuplication || !IsCompatibilityFailure(error)) throw;
                _active.Dispose();
                _active = new GdiFrameGrabber(
                    _region, _outputSize, _includeCursor);
                _usingDesktopDuplication = false;
                _active.Capture();
            }
        }

        private static bool IsCompatibilityFailure(Exception error)
        {
            return error is COMException || error is Win32Exception ||
                   error is PlatformNotSupportedException || error is EntryPointNotFoundException;
        }

        public void Dispose()
        {
            if (_active == null) return;
            _active.Dispose();
            _active = null;
        }
    }

    internal sealed class DesktopDuplicationFrameGrabber : IRecordingFrameGrabber
    {
        private const int D3dDriverTypeHardware = 1;
        private const uint D3d11SdkVersion = 7;
        private const uint D3d11CreateDeviceBgraSupport = 0x20;
        private const uint D3d11CreateDeviceVideoSupport = 0x800;
        private const int DxgiFormatB8G8R8A8Unorm = 87;
        private const int D3d11UsageDefault = 0;
        private const int D3d11UsageStaging = 3;
        private const uint D3d11BindRenderTarget = 0x20;
        private const uint D3d11CpuAccessRead = 0x00020000;
        private const uint D3d11ResourceMiscGdiCompatible = 0x200;
        private const int D3d11MapRead = 1;
        private const int StretchModeHalftone = 4;
        private const int SourceCopy = 0x00CC0020;
        private const int DxgiModeRotationIdentity = 1;
        private const int DxgiErrorNotFound = unchecked((int)0x887A0002);
        private const int DxgiErrorWaitTimeout = unchecked((int)0x887A0027);
        private const int DibRgbColors = 0;
        private const int CursorShowing = 0x00000001;
        private const int DrawIconNormal = 0x0003;
        private const int SurfacePoolLimit = 3;
        private const int HighFrameRateSurfacePoolLimit = 4;

        private static readonly Guid IdxgiDevice = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
        private static readonly Guid IdxgiOutput1 = new Guid("00cddea8-939b-4b83-a340-a685226666cc");
        private static readonly Guid IdxgiSurface1 = new Guid("4ae63092-6327-4c1b-80ae-bfe12ea32b86");
        private static readonly Guid Id3d11Texture2d = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
        private static readonly Guid Id3d10Multithread = new Guid("9b7e4e00-342c-4106-a19f-4f2704f689f0");

        private readonly Rectangle _region;
        private readonly Size _outputSize;
        private readonly bool _includeCursor;
        private readonly object _surfaceSync = new object();
        private readonly Queue<IntPtr> _freeSurfaces = new Queue<IntPtr>();
        private readonly HashSet<IntPtr> _allSurfaces = new HashSet<IntPtr>();
        private readonly HashSet<IntPtr> _rentedSurfaces = new HashSet<IntPtr>();
        private Rectangle _outputBounds;
        private IntPtr _device;
        private IntPtr _context;
        private IntPtr _duplication;
        private IntPtr _latestTexture;
        private IntPtr _stagingTexture;
        private IntPtr _screenDc;
        private IntPtr _memoryDc;
        private IntPtr _bitmap;
        private IntPtr _previousBitmap;
        private IntPtr _pixels;
        private IntPtr _lastCursor;
        private Point _cursorHotspot;
        private Size _cursorSize;
        private Point _pointerPosition;
        private bool _hasFrame;
        private bool _hasPointerState;
        private bool _pointerVisible;
        private bool _disposed;
        private AcquireNextFrameDelegate _acquireNextFrame;
        private ReleaseFrameDelegate _releaseFrame;
        private CreateTexture2dDelegate _createTexture2d;
        private CopySubresourceRegionDelegate _copySubresourceRegion;
        private CopyResourceDelegate _copyResource;
        private MapDelegate _map;
        private UnmapDelegate _unmap;

        public IntPtr Pixels
        {
            get
            {
                EnsureCpuResources();
                return _pixels;
            }
        }
        public int ByteCount { get { return checked(_outputSize.Width * _outputSize.Height * 4); } }
        internal IntPtr D3dDevice { get { return _device; } }

        internal DesktopDuplicationFrameGrabber(Rectangle region)
            : this(region, region.Size, true)
        {
        }

        internal DesktopDuplicationFrameGrabber(Rectangle region, bool includeCursor)
            : this(region, region.Size, includeCursor)
        {
        }

        internal DesktopDuplicationFrameGrabber(
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
                CreateDuplication();
                _latestTexture = CreateTexture(region.Size, IsScaled);
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        private void CreatePixelBuffer()
        {
            _screenDc = RecordingNative.GetDC(IntPtr.Zero);
            if (_screenDc == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            _memoryDc = RecordingNative.CreateCompatibleDC(_screenDc);
            if (_memoryDc == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

            BitmapInfo info = new BitmapInfo();
            info.Header.Size = Marshal.SizeOf(typeof(BitmapInfoHeader));
            info.Header.Width = _outputSize.Width;
            info.Header.Height = -_outputSize.Height;
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
        }

        private void CreateDuplication()
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
                out _device,
                out featureLevel,
                out _context);
            ThrowIfFailed(result, "D3D11CreateDevice");
            EnableMultithreadProtection();

            IntPtr dxgiDevice = IntPtr.Zero;
            IntPtr adapter = IntPtr.Zero;
            try
            {
                Guid deviceId = IdxgiDevice;
                ThrowIfFailed(Marshal.QueryInterface(_device, ref deviceId, out dxgiDevice),
                    "ID3D11Device.QueryInterface(IDXGIDevice)");
                TryLowerGpuPriority(dxgiDevice);
                GetAdapterDelegate getAdapter = ComMethod<GetAdapterDelegate>(dxgiDevice, 7);
                ThrowIfFailed(getAdapter(dxgiDevice, out adapter), "IDXGIDevice.GetAdapter");
                FindOutputAndDuplicate(adapter);
            }
            finally
            {
                ReleaseUnknown(ref adapter);
                ReleaseUnknown(ref dxgiDevice);
            }
            if (_duplication == IntPtr.Zero)
                throw new COMException("The selected area is not on an output owned by the primary graphics adapter.");
            _acquireNextFrame = ComMethod<AcquireNextFrameDelegate>(_duplication, 8);
            _releaseFrame = ComMethod<ReleaseFrameDelegate>(_duplication, 14);
            _createTexture2d = ComMethod<CreateTexture2dDelegate>(_device, 5);
            _copySubresourceRegion = ComMethod<CopySubresourceRegionDelegate>(_context, 46);
            _copyResource = ComMethod<CopyResourceDelegate>(_context, 47);
            _map = ComMethod<MapDelegate>(_context, 14);
            _unmap = ComMethod<UnmapDelegate>(_context, 15);
        }

        private void EnableMultithreadProtection()
        {
            IntPtr multithread = IntPtr.Zero;
            try
            {
                Guid interfaceId = Id3d10Multithread;
                ThrowIfFailed(Marshal.QueryInterface(_device, ref interfaceId, out multithread),
                    "ID3D11Device.QueryInterface(ID3D10Multithread)");
                SetMultithreadProtectedDelegate protect =
                    ComMethod<SetMultithreadProtectedDelegate>(multithread, 5);
                protect(multithread, true);
            }
            finally
            {
                ReleaseUnknown(ref multithread);
            }
        }

        private void FindOutputAndDuplicate(IntPtr adapter)
        {
            EnumOutputsDelegate enumOutputs = ComMethod<EnumOutputsDelegate>(adapter, 7);
            for (uint index = 0; ; index++)
            {
                IntPtr output = IntPtr.Zero;
                int result = enumOutputs(adapter, index, out output);
                if (result == DxgiErrorNotFound) break;
                ThrowIfFailed(result, "IDXGIAdapter.EnumOutputs");
                try
                {
                    GetOutputDescDelegate getDesc = ComMethod<GetOutputDescDelegate>(output, 7);
                    DxgiOutputDesc description;
                    ThrowIfFailed(getDesc(output, out description), "IDXGIOutput.GetDesc");
                    Rectangle bounds = Rectangle.FromLTRB(
                        description.DesktopCoordinates.Left,
                        description.DesktopCoordinates.Top,
                        description.DesktopCoordinates.Right,
                        description.DesktopCoordinates.Bottom);
                    if (!description.AttachedToDesktop || description.Rotation != DxgiModeRotationIdentity ||
                        !bounds.Contains(_region))
                        continue;

                    IntPtr output1 = IntPtr.Zero;
                    try
                    {
                        Guid outputId = IdxgiOutput1;
                        ThrowIfFailed(Marshal.QueryInterface(output, ref outputId, out output1),
                            "IDXGIOutput.QueryInterface(IDXGIOutput1)");
                        DuplicateOutputDelegate duplicateOutput = ComMethod<DuplicateOutputDelegate>(output1, 22);
                        ThrowIfFailed(duplicateOutput(output1, _device, out _duplication),
                            "IDXGIOutput1.DuplicateOutput");
                        _outputBounds = bounds;
                        return;
                    }
                    finally
                    {
                        ReleaseUnknown(ref output1);
                    }
                }
                finally
                {
                    ReleaseUnknown(ref output);
                }
            }
        }

        private bool IsScaled
        {
            get
            {
                return _region.Width != _outputSize.Width ||
                       _region.Height != _outputSize.Height;
            }
        }

        private IntPtr CreateTexture(Size size, bool gdiCompatible)
        {
            D3d11Texture2dDescription description = new D3d11Texture2dDescription();
            description.Width = (uint)size.Width;
            description.Height = (uint)size.Height;
            description.MipLevels = 1;
            description.ArraySize = 1;
            description.Format = DxgiFormatB8G8R8A8Unorm;
            description.SampleDescription.Count = 1;
            description.Usage = D3d11UsageDefault;
            if (gdiCompatible)
            {
                description.BindFlags = D3d11BindRenderTarget;
                description.MiscFlags = D3d11ResourceMiscGdiCompatible;
            }
            IntPtr texture;
            ThrowIfFailed(_createTexture2d(_device, ref description, IntPtr.Zero, out texture),
                "ID3D11Device.CreateTexture2D");
            return texture;
        }

        private void EnsureCpuResources()
        {
            if (_pixels == IntPtr.Zero) CreatePixelBuffer();
            if (IsScaled) return;
            if (_stagingTexture != IntPtr.Zero) return;
            D3d11Texture2dDescription description = new D3d11Texture2dDescription();
            description.Width = (uint)_region.Width;
            description.Height = (uint)_region.Height;
            description.MipLevels = 1;
            description.ArraySize = 1;
            description.Format = DxgiFormatB8G8R8A8Unorm;
            description.SampleDescription.Count = 1;
            description.Usage = D3d11UsageStaging;
            description.CpuAccessFlags = D3d11CpuAccessRead;
            ThrowIfFailed(_createTexture2d(
                _device, ref description, IntPtr.Zero, out _stagingTexture),
                "ID3D11Device.CreateTexture2D(staging)");
        }

        public void Capture()
        {
            EnsureCpuResources();
            AcquireLatestFrame();
            if (IsScaled)
                ScaleLatestToDc(_memoryDc, false);
            else
            {
                CopyLatestToPixels();
                if (_includeCursor && (!_hasPointerState || _pointerVisible))
                    DrawCursor(_memoryDc);
            }
        }

        internal IntPtr CaptureSurface()
        {
            // Do not acquire/copy a desktop frame that cannot enter the bounded
            // encoder queue. Under GPU pressure, dropping here protects the app
            // being recorded from work that would be discarded moments later.
            IntPtr surfaceTexture = RentSurface();
            if (surfaceTexture == IntPtr.Zero) return IntPtr.Zero;
            try
            {
                AcquireLatestFrame();
                if (IsScaled)
                    ScaleLatestToSurface(surfaceTexture);
                else
                {
                    _copyResource(_context, surfaceTexture, _latestTexture);
                    CursorDrawInfo cursor;
                    if (_includeCursor && (!_hasPointerState || _pointerVisible) &&
                        TryGetCursorDrawInfo(true, out cursor))
                        DrawCursorOnSurface(surfaceTexture, cursor);
                }
                Marshal.AddRef(surfaceTexture);
                return surfaceTexture;
            }
            catch
            {
                ReturnSurface(surfaceTexture);
                throw;
            }
        }

        private IntPtr RentSurface()
        {
            lock (_surfaceSync)
            {
                if (_disposed) throw new ObjectDisposedException(GetType().Name);
                IntPtr surface;
                if (_freeSurfaces.Count > 0)
                    surface = _freeSurfaces.Dequeue();
                else
                {
                    int limit = (long)_outputSize.Width * _outputSize.Height <= 1280L * 720L
                        ? HighFrameRateSurfacePoolLimit
                        : SurfacePoolLimit;
                    if (_allSurfaces.Count >= limit) return IntPtr.Zero;
                    surface = CreateTexture(_outputSize, true);
                    _allSurfaces.Add(surface);
                }
                _rentedSurfaces.Add(surface);
                return surface;
            }
        }

        internal void ReturnSurface(IntPtr surface)
        {
            if (surface == IntPtr.Zero) return;
            lock (_surfaceSync)
            {
                if (_disposed || !_rentedSurfaces.Remove(surface)) return;
                _freeSurfaces.Enqueue(surface);
            }
        }

        private void AcquireLatestFrame()
        {
            DxgiOutduplFrameInfo frameInfo;
            IntPtr desktopResource = IntPtr.Zero;
            int result = _acquireNextFrame(
                _duplication, _hasFrame ? 0u : 500u, out frameInfo, out desktopResource);
            if (result == DxgiErrorWaitTimeout)
            {
                if (_hasFrame) return;
                throw new COMException("Desktop Duplication did not provide an initial frame.", result);
            }
            ThrowIfFailed(result, "IDXGIOutputDuplication.AcquireNextFrame");
            try
            {
                if (!_hasFrame || frameInfo.LastPresentTime != 0)
                    CopyFrameToLatest(desktopResource);
                _hasFrame = true;
                if (frameInfo.LastMouseUpdateTime != 0)
                {
                    _hasPointerState = true;
                    _pointerVisible = frameInfo.PointerPosition.Visible;
                    if (_pointerVisible)
                        _pointerPosition = frameInfo.PointerPosition.Position;
                }
            }
            finally
            {
                ReleaseUnknown(ref desktopResource);
                int releaseResult = _releaseFrame(_duplication);
                ThrowIfFailed(releaseResult, "IDXGIOutputDuplication.ReleaseFrame");
            }
        }

        private void CopyFrameToLatest(IntPtr desktopResource)
        {
            IntPtr sourceTexture = IntPtr.Zero;
            try
            {
                Guid textureId = Id3d11Texture2d;
                ThrowIfFailed(Marshal.QueryInterface(desktopResource, ref textureId, out sourceTexture),
                    "IDXGIResource.QueryInterface(ID3D11Texture2D)");
                D3d11Box sourceBox = new D3d11Box();
                sourceBox.Left = (uint)(_region.Left - _outputBounds.Left);
                sourceBox.Top = (uint)(_region.Top - _outputBounds.Top);
                sourceBox.Front = 0;
                sourceBox.Right = sourceBox.Left + (uint)_region.Width;
                sourceBox.Bottom = sourceBox.Top + (uint)_region.Height;
                sourceBox.Back = 1;
                _copySubresourceRegion(
                    _context, _latestTexture, 0, 0, 0, 0, sourceTexture, 0, ref sourceBox);
            }
            finally
            {
                ReleaseUnknown(ref sourceTexture);
            }
        }

        private void CopyLatestToPixels()
        {
            bool mapped = false;
            try
            {
                _copyResource(_context, _stagingTexture, _latestTexture);
                D3d11MappedSubresource mappedFrame;
                ThrowIfFailed(_map(_context, _stagingTexture, 0, D3d11MapRead, 0, out mappedFrame),
                    "ID3D11DeviceContext.Map");
                mapped = true;
                int rowBytes = checked(_region.Width * 4);
                if (mappedFrame.RowPitch == (uint)rowBytes)
                {
                    RecordingNative.CopyMemory(_pixels, mappedFrame.Data,
                        new UIntPtr((uint)ByteCount));
                    return;
                }
                for (int row = 0; row < _region.Height; row++)
                {
                    IntPtr source = IntPtr.Add(mappedFrame.Data, checked((int)mappedFrame.RowPitch * row));
                    IntPtr destination = IntPtr.Add(_pixels, rowBytes * row);
                    RecordingNative.CopyMemory(destination, source, new UIntPtr((uint)rowBytes));
                }
            }
            finally
            {
                if (mapped) _unmap(_context, _stagingTexture, 0);
            }
        }

        private void ScaleLatestToSurface(IntPtr texture)
        {
            IntPtr surface = IntPtr.Zero;
            IntPtr dc = IntPtr.Zero;
            try
            {
                Guid surfaceId = IdxgiSurface1;
                ThrowIfFailed(Marshal.QueryInterface(texture, ref surfaceId, out surface),
                    "ID3D11Texture2D.QueryInterface(IDXGISurface1)");
                GetDcDelegate getDc = ComMethod<GetDcDelegate>(surface, 11);
                ThrowIfFailed(getDc(surface, false, out dc), "IDXGISurface1.GetDC");
                ScaleLatestToDc(dc, true);
                NativeRectangle dirty = new NativeRectangle();
                dirty.Right = _outputSize.Width;
                dirty.Bottom = _outputSize.Height;
                ReleaseDcDirtyDelegate releaseDc =
                    ComMethod<ReleaseDcDirtyDelegate>(surface, 12);
                ThrowIfFailed(releaseDc(surface, ref dirty), "IDXGISurface1.ReleaseDC");
                dc = IntPtr.Zero;
            }
            finally
            {
                if (dc != IntPtr.Zero)
                {
                    try { ComMethod<ReleaseDcDelegate>(surface, 12)(surface, IntPtr.Zero); }
                    catch { }
                }
                ReleaseUnknown(ref surface);
            }
        }

        private void ScaleLatestToDc(IntPtr destinationDc, bool frameSynchronized)
        {
            IntPtr sourceSurface = IntPtr.Zero;
            IntPtr sourceDc = IntPtr.Zero;
            try
            {
                Guid surfaceId = IdxgiSurface1;
                ThrowIfFailed(Marshal.QueryInterface(
                    _latestTexture, ref surfaceId, out sourceSurface),
                    "ID3D11Texture2D.QueryInterface(IDXGISurface1)");
                GetDcDelegate getDc = ComMethod<GetDcDelegate>(sourceSurface, 11);
                ThrowIfFailed(getDc(sourceSurface, false, out sourceDc),
                    "IDXGISurface1.GetDC");
                if (RecordingNative.SetStretchBltMode(
                        destinationDc, StretchModeHalftone) == 0)
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                Point previousBrushOrigin;
                if (!RecordingNative.SetBrushOrgEx(
                        destinationDc, 0, 0, out previousBrushOrigin))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (!RecordingNative.StretchBlt(
                    destinationDc,
                    0,
                    0,
                    _outputSize.Width,
                    _outputSize.Height,
                    sourceDc,
                    0,
                    0,
                    _region.Width,
                    _region.Height,
                    SourceCopy))
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(), "Desktop frame scaling failed.");

                CursorDrawInfo cursor;
                if (_includeCursor && (!_hasPointerState || _pointerVisible) &&
                    TryGetCursorDrawInfo(frameSynchronized, out cursor))
                    DrawScaledCursor(destinationDc, cursor);
            }
            finally
            {
                if (sourceDc != IntPtr.Zero)
                {
                    try
                    {
                        ComMethod<ReleaseDcDelegate>(sourceSurface, 12)(
                            sourceSurface, IntPtr.Zero);
                    }
                    catch { }
                }
                ReleaseUnknown(ref sourceSurface);
            }
        }

        private void DrawScaledCursor(IntPtr dc, CursorDrawInfo cursor)
        {
            int x = ScaleCoordinate(cursor.X, _region.Width, _outputSize.Width);
            int y = ScaleCoordinate(cursor.Y, _region.Height, _outputSize.Height);
            int width = ScaleLength(cursor.Width, _region.Width, _outputSize.Width);
            int height = ScaleLength(cursor.Height, _region.Height, _outputSize.Height);
            RecordingNative.DrawIconEx(
                dc, x, y, cursor.Handle, width, height,
                0, IntPtr.Zero, DrawIconNormal);
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

        private void DrawCursorOnSurface(IntPtr texture, CursorDrawInfo cursor)
        {
            IntPtr surface = IntPtr.Zero;
            IntPtr dc = IntPtr.Zero;
            try
            {
                Guid surfaceId = IdxgiSurface1;
                ThrowIfFailed(Marshal.QueryInterface(texture, ref surfaceId, out surface),
                    "ID3D11Texture2D.QueryInterface(IDXGISurface1)");
                GetDcDelegate getDc = ComMethod<GetDcDelegate>(surface, 11);
                ThrowIfFailed(getDc(surface, false, out dc), "IDXGISurface1.GetDC");
                RecordingNative.DrawIconEx(
                    dc, cursor.X, cursor.Y, cursor.Handle,
                    0, 0, 0, IntPtr.Zero, DrawIconNormal);
                ReleaseDcDirtyDelegate releaseDc =
                    ComMethod<ReleaseDcDirtyDelegate>(surface, 12);
                ThrowIfFailed(releaseDc(surface, ref cursor.DirtyBounds),
                    "IDXGISurface1.ReleaseDC");
                dc = IntPtr.Zero;
            }
            finally
            {
                if (dc != IntPtr.Zero)
                {
                    try { ComMethod<ReleaseDcDelegate>(surface, 12)(surface, IntPtr.Zero); }
                    catch { }
                }
                ReleaseUnknown(ref surface);
            }
        }

        private void DrawCursor(IntPtr targetDc)
        {
            CursorDrawInfo cursor;
            if (!TryGetCursorDrawInfo(false, out cursor)) return;
            RecordingNative.DrawIconEx(
                targetDc, cursor.X, cursor.Y, cursor.Handle,
                0, 0, 0, IntPtr.Zero, DrawIconNormal);
        }

        private bool TryGetCursorDrawInfo(
            bool frameSynchronized,
            out CursorDrawInfo drawInfo)
        {
            drawInfo = new CursorDrawInfo();
            CursorInfo cursor = new CursorInfo();
            cursor.Size = Marshal.SizeOf(typeof(CursorInfo));
            if (!RecordingNative.GetCursorInfo(ref cursor) ||
                (cursor.Flags & CursorShowing) == 0 || cursor.Handle == IntPtr.Zero)
                return false;
            if (cursor.Handle != _lastCursor)
                UpdateCursorMetrics(cursor.Handle);

            int x;
            int y;
            if (frameSynchronized && _hasPointerState)
            {
                x = _pointerPosition.X + _outputBounds.Left - _region.Left;
                y = _pointerPosition.Y + _outputBounds.Top - _region.Top;
            }
            else
            {
                x = cursor.ScreenPosition.X - _region.Left - _cursorHotspot.X;
                y = cursor.ScreenPosition.Y - _region.Top - _cursorHotspot.Y;
            }

            NativeRectangle dirty = new NativeRectangle();
            if (_cursorSize.Width > 0 && _cursorSize.Height > 0)
            {
                long right = (long)x + _cursorSize.Width;
                long bottom = (long)y + _cursorSize.Height;
                if (x >= _region.Width || y >= _region.Height || right <= 0 || bottom <= 0)
                    return false;
                dirty.Left = Math.Max(0, x);
                dirty.Top = Math.Max(0, y);
                dirty.Right = Math.Min(_region.Width, (int)right);
                dirty.Bottom = Math.Min(_region.Height, (int)bottom);
            }
            else
            {
                dirty.Right = _region.Width;
                dirty.Bottom = _region.Height;
            }

            drawInfo.Handle = cursor.Handle;
            drawInfo.X = x;
            drawInfo.Y = y;
            drawInfo.Width = _cursorSize.Width;
            drawInfo.Height = _cursorSize.Height;
            drawInfo.DirtyBounds = dirty;
            return true;
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
                    else if (icon.ColorBitmap == IntPtr.Zero &&
                             icon.MaskBitmap != IntPtr.Zero &&
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
        private struct CursorDrawInfo
        {
            internal IntPtr Handle;
            internal int X;
            internal int Y;
            internal int Width;
            internal int Height;
            internal NativeRectangle DirtyBounds;
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

        private static T ComMethod<T>(IntPtr instance, int slot) where T : class
        {
            IntPtr table = Marshal.ReadIntPtr(instance);
            IntPtr method = Marshal.ReadIntPtr(table, checked(slot * IntPtr.Size));
            return (T)(object)Marshal.GetDelegateForFunctionPointer(method, typeof(T));
        }

        private static void TryLowerGpuPriority(IntPtr dxgiDevice)
        {
            try
            {
                SetGpuThreadPriorityDelegate setPriority =
                    ComMethod<SetGpuThreadPriorityDelegate>(dxgiDevice, 10);
                // Leave interactive rendering ahead of capture work when the
                // adapter is saturated; the surface queue remains bounded.
                setPriority(dxgiDevice, -3);
            }
            catch { }
        }

        private static void ThrowIfFailed(int result, string operation)
        {
            if (result < 0)
                throw new COMException(operation + " failed (0x" + result.ToString("X8") + ").", result);
        }

        private static void ReleaseUnknown(ref IntPtr value)
        {
            if (value == IntPtr.Zero) return;
            Marshal.Release(value);
            value = IntPtr.Zero;
        }

        public void Dispose()
        {
            lock (_surfaceSync)
            {
                if (!_disposed)
                {
                    _disposed = true;
                    foreach (IntPtr surface in _allSurfaces) Marshal.Release(surface);
                    _freeSurfaces.Clear();
                    _rentedSurfaces.Clear();
                    _allSurfaces.Clear();
                }
            }
            ReleaseUnknown(ref _stagingTexture);
            ReleaseUnknown(ref _latestTexture);
            ReleaseUnknown(ref _duplication);
            ReleaseUnknown(ref _context);
            ReleaseUnknown(ref _device);
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
            _acquireNextFrame = null;
            _releaseFrame = null;
            _createTexture2d = null;
            _copySubresourceRegion = null;
            _copyResource = null;
            _map = null;
            _unmap = null;
        }

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetAdapterDelegate(IntPtr self, out IntPtr adapter);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int SetGpuThreadPriorityDelegate(IntPtr self, int priority);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int EnumOutputsDelegate(IntPtr self, uint outputIndex, out IntPtr output);

        [UnmanagedFunctionPointer(CallingConvention.StdCall, CharSet = CharSet.Unicode)]
        private delegate int GetOutputDescDelegate(IntPtr self, out DxgiOutputDesc description);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int DuplicateOutputDelegate(IntPtr self, IntPtr device, out IntPtr duplication);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int CreateTexture2dDelegate(
            IntPtr self,
            ref D3d11Texture2dDescription description,
            IntPtr initialData,
            out IntPtr texture);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private delegate bool SetMultithreadProtectedDelegate(
            IntPtr self,
            [MarshalAs(UnmanagedType.Bool)] bool protect);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int AcquireNextFrameDelegate(
            IntPtr self,
            uint timeoutMilliseconds,
            out DxgiOutduplFrameInfo frameInfo,
            out IntPtr desktopResource);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int ReleaseFrameDelegate(IntPtr self);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate void CopySubresourceRegionDelegate(
            IntPtr self,
            IntPtr destinationResource,
            uint destinationSubresource,
            uint destinationX,
            uint destinationY,
            uint destinationZ,
            IntPtr sourceResource,
            uint sourceSubresource,
            ref D3d11Box sourceBox);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate void CopyResourceDelegate(
            IntPtr self,
            IntPtr destinationResource,
            IntPtr sourceResource);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetDcDelegate(
            IntPtr self,
            [MarshalAs(UnmanagedType.Bool)] bool discard,
            out IntPtr dc);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int ReleaseDcDelegate(IntPtr self, IntPtr dirtyRectangle);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int ReleaseDcDirtyDelegate(
            IntPtr self,
            ref NativeRectangle dirtyRectangle);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int MapDelegate(
            IntPtr self,
            IntPtr resource,
            uint subresource,
            int mapType,
            uint mapFlags,
            out D3d11MappedSubresource mappedResource);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate void UnmapDelegate(IntPtr self, IntPtr resource, uint subresource);
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeRectangle
    {
        internal int Left;
        internal int Top;
        internal int Right;
        internal int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct DxgiOutputDesc
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        internal string DeviceName;
        internal NativeRectangle DesktopCoordinates;
        [MarshalAs(UnmanagedType.Bool)] internal bool AttachedToDesktop;
        internal int Rotation;
        internal IntPtr Monitor;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct DxgiOutduplPointerPosition
    {
        internal Point Position;
        [MarshalAs(UnmanagedType.Bool)] internal bool Visible;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct DxgiOutduplFrameInfo
    {
        internal long LastPresentTime;
        internal long LastMouseUpdateTime;
        internal uint AccumulatedFrames;
        [MarshalAs(UnmanagedType.Bool)] internal bool RectanglesCoalesced;
        [MarshalAs(UnmanagedType.Bool)] internal bool ProtectedContentMaskedOut;
        internal DxgiOutduplPointerPosition PointerPosition;
        internal uint TotalMetadataBufferSize;
        internal uint PointerShapeBufferSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct DxgiSampleDescription
    {
        internal uint Count;
        internal uint Quality;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct D3d11Texture2dDescription
    {
        internal uint Width;
        internal uint Height;
        internal uint MipLevels;
        internal uint ArraySize;
        internal int Format;
        internal DxgiSampleDescription SampleDescription;
        internal int Usage;
        internal uint BindFlags;
        internal uint CpuAccessFlags;
        internal uint MiscFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct D3d11Box
    {
        internal uint Left;
        internal uint Top;
        internal uint Front;
        internal uint Right;
        internal uint Bottom;
        internal uint Back;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct D3d11MappedSubresource
    {
        internal IntPtr Data;
        internal uint RowPitch;
        internal uint DepthPitch;
    }
}
