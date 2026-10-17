using System;
using System.Diagnostics;
using System.Collections.Generic;
using Server.Gumps;
using System.IO;
using System.Linq;
using System.Reflection;
using Server;
using Server.Misc;
using Server.Network;

public static class RuntimeTests
{
    public static void Main(string[] args)
    {
        Core.Assembly = typeof(Core).Assembly;
        byte[] source = System.Text.Encoding.ASCII.GetBytes(new string('x', 2048));
        byte[] packed = new byte[4096], unpacked = new byte[4096];
        int packedLength = packed.Length, unpackedLength = unpacked.Length;
        if (Compression.Pack(packed, ref packedLength, source, source.Length, ZLibQuality.Default) != ZLibError.Okay ||
            Compression.Unpack(unpacked, ref unpackedLength, packed, packedLength) != ZLibError.Okay ||
            !source.SequenceEqual(unpacked.Take(unpackedLength)))
            throw new Exception("Native compression round trip failed");
        Console.WriteLine("Native compression round trip passed.");
        var gump = new DisplayGumpPacked(new Gump(0, 0));
        gump.AppendLayout(Gump.StringToBuffer("{ page 0 }{ text 20 20 0 0 }"));
        gump.WriteStrings(new List<string> { "Compression regression test" });
        gump.Flush();
        Console.WriteLine("Packed gump layout and text compression passed.");

        for (int i = 0; i < args.Length; i++) HostingOptions.TryParse(args, ref i);
        if (HostingOptions.ShutdownFile == null) throw new Exception("Run through the shutdown wrapper");
        string state = Environment.GetEnvironmentVariable("GEMWRIGHT_TEST_STATE");
        if (File.Exists(Path.Combine(state, "crashed")))
        {
            if (File.ReadAllText(Path.Combine(state, "saved-world")) != "last completed save")
                throw new Exception("Saved state changed during crash recovery");
            Console.WriteLine("Recovery preserved saved state.");
            return;
        }
        File.WriteAllText(Path.Combine(state, "saved-world"), "last completed save");
        File.WriteAllText(Path.Combine(state, "crashed"), "");
        typeof(Core).GetProperty("Process").GetSetMethod(true).Invoke(null, new object[] { Process.GetCurrentProcess() });
        CrashGuard.Initialize();
        typeof(Core).GetMethod("CurrentDomain_UnhandledException", BindingFlags.NonPublic | BindingFlags.Static)
            .Invoke(null, new object[] { null, new UnhandledExceptionEventArgs(new Exception("Intentional recovery test"), true) });
        throw new Exception("Fatal crash handler returned without exiting");
    }
}
