using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

internal static class GenerateIcon
{
    private static int Main(string[] args)
    {
        if (args.Length != 1) return 2;
        int[] sizes = new int[] { 16, 24, 32, 48, 64, 128, 256 };
        List<byte[]> images = new List<byte[]>();
        foreach (int size in sizes)
        {
            using (Bitmap bitmap = DrawIcon(size))
            using (MemoryStream stream = new MemoryStream())
            {
                bitmap.Save(stream, ImageFormat.Png);
                images.Add(stream.ToArray());
            }
        }

        using (FileStream file = File.Create(args[0]))
        using (BinaryWriter writer = new BinaryWriter(file))
        {
            writer.Write((ushort)0);
            writer.Write((ushort)1);
            writer.Write((ushort)sizes.Length);
            int offset = 6 + sizes.Length * 16;
            for (int i = 0; i < sizes.Length; i++)
            {
                writer.Write((byte)(sizes[i] == 256 ? 0 : sizes[i]));
                writer.Write((byte)(sizes[i] == 256 ? 0 : sizes[i]));
                writer.Write((byte)0);
                writer.Write((byte)0);
                writer.Write((ushort)1);
                writer.Write((ushort)32);
                writer.Write(images[i].Length);
                writer.Write(offset);
                offset += images[i].Length;
            }
            foreach (byte[] image in images)
                writer.Write(image);
        }
        return 0;
    }

    private static Bitmap DrawIcon(int size)
    {
        Bitmap bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            float s = size / 32.0f;
            RectangleF tile = new RectangleF(1 * s, 1 * s, 30 * s, 30 * s);
            using (GraphicsPath path = Rounded(tile, 7 * s))
            using (SolidBrush brush = new SolidBrush(Color.FromArgb(16, 20, 25)))
                g.FillPath(brush, path);

            using (Pen pen = new Pen(Color.FromArgb(202, 255, 70), Math.Max(1.2f, 2.6f * s)))
            {
                pen.StartCap = LineCap.Square;
                pen.EndCap = LineCap.Square;
                DrawCorner(g, pen, 8 * s, 8 * s, 1, 1, s);
                DrawCorner(g, pen, 24 * s, 8 * s, -1, 1, s);
                DrawCorner(g, pen, 8 * s, 24 * s, 1, -1, s);
                DrawCorner(g, pen, 24 * s, 24 * s, -1, -1, s);
            }
            using (SolidBrush dot = new SolidBrush(Color.White))
                g.FillEllipse(dot, 14 * s, 14 * s, 4 * s, 4 * s);
        }
        return bitmap;
    }

    private static void DrawCorner(Graphics g, Pen pen, float x, float y, int horizontal, int vertical, float scale)
    {
        g.DrawLine(pen, x, y, x + horizontal * 5 * scale, y);
        g.DrawLine(pen, x, y, x, y + vertical * 5 * scale);
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
