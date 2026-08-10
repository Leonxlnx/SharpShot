using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

internal static class GenerateStudioIcon
{
    private static readonly int[] Sizes = new int[] { 16, 20, 24, 32, 40, 48, 64, 128, 256 };

    private static int Main(string[] args)
    {
        if (args.Length != 1) return 2;
        List<byte[]> frames = new List<byte[]>();
        foreach (int size in Sizes)
        {
            using (Bitmap bitmap = Draw(size))
            using (MemoryStream stream = new MemoryStream())
            {
                bitmap.Save(stream, ImageFormat.Png);
                frames.Add(stream.ToArray());
            }
        }

        using (FileStream file = File.Create(args[0]))
        using (BinaryWriter writer = new BinaryWriter(file))
        {
            writer.Write((ushort)0);
            writer.Write((ushort)1);
            writer.Write((ushort)Sizes.Length);
            int offset = 6 + Sizes.Length * 16;
            for (int i = 0; i < Sizes.Length; i++)
            {
                writer.Write((byte)(Sizes[i] == 256 ? 0 : Sizes[i]));
                writer.Write((byte)(Sizes[i] == 256 ? 0 : Sizes[i]));
                writer.Write((byte)0);
                writer.Write((byte)0);
                writer.Write((ushort)1);
                writer.Write((ushort)32);
                writer.Write(frames[i].Length);
                writer.Write(offset);
                offset += frames[i].Length;
            }
            foreach (byte[] frame in frames) writer.Write(frame);
        }
        return 0;
    }

    private static Bitmap Draw(int size)
    {
        Bitmap bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        float scale = size / 32f;
        using (Graphics graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = size <= 20 ? SmoothingMode.HighQuality : SmoothingMode.AntiAlias;
            graphics.Clear(Color.Transparent);

            RectangleF tile = new RectangleF(scale, scale, 30 * scale, 30 * scale);
            using (GraphicsPath shape = Rounded(tile, 7 * scale))
            using (SolidBrush fill = new SolidBrush(Color.FromArgb(13, 15, 18)))
            using (Pen border = new Pen(Color.FromArgb(38, 43, 52), Math.Max(1f, scale)))
            {
                graphics.FillPath(fill, shape);
                graphics.DrawPath(border, shape);
            }

            float line = Math.Max(1.5f, 2.3f * scale);
            using (Pen white = new Pen(Color.FromArgb(243, 245, 247), line))
            {
                white.StartCap = LineCap.Round;
                white.EndCap = LineCap.Round;
                white.LineJoin = LineJoin.Round;
                graphics.DrawLines(white, new PointF[] {
                    new PointF(8 * scale, 14 * scale),
                    new PointF(8 * scale, 8 * scale),
                    new PointF(15 * scale, 8 * scale)
                });
                graphics.DrawLines(white, new PointF[] {
                    new PointF(24 * scale, 18 * scale),
                    new PointF(24 * scale, 24 * scale),
                    new PointF(17 * scale, 24 * scale)
                });
            }

            using (Pen blue = new Pen(Color.FromArgb(143, 183, 255), Math.Max(1.2f, 1.65f * scale)))
            {
                blue.StartCap = LineCap.Round;
                blue.EndCap = LineCap.Round;
                graphics.DrawBezier(
                    blue,
                    new PointF(9 * scale, 21 * scale),
                    new PointF(13 * scale, 21 * scale),
                    new PointF(16 * scale, 14 * scale),
                    new PointF(23 * scale, 13 * scale));
            }

            float dot = Math.Max(2f, 3.1f * scale);
            using (SolidBrush blue = new SolidBrush(Color.FromArgb(143, 183, 255)))
                graphics.FillRoundedRectangle(new RectangleF(22 * scale, 6 * scale, dot, dot), Math.Max(0.8f, scale), blue);
        }
        return bitmap;
    }

    private static GraphicsPath Rounded(RectangleF bounds, float radius)
    {
        float diameter = radius * 2;
        GraphicsPath path = new GraphicsPath();
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }
}

internal static class GraphicsExtensions
{
    internal static void FillRoundedRectangle(
        this Graphics graphics,
        RectangleF bounds,
        float radius,
        Brush brush)
    {
        float diameter = radius * 2;
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
