using System;
using System.IO;
using System.Net;
using Server;

public static class Program
{
    private static int checks;
    private static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
        checks++;
    }

    private static void Parse(params string[] args)
    {
        for (int i = 0; i < args.Length; i++)
            Check(HostingOptions.TryParse(args, ref i), "Option recognized");
    }

    public static void Main()
    {
        Check(!HostingOptions.IsRailwayProxy(IPAddress.Parse("100.64.0.1")), "Proxy exemptions opt in");
        Parse("--public", "127.0.0.1:15140", "--railway-proxy");
        Check(HostingOptions.PublicEndpoint.Equals(new IPEndPoint(IPAddress.Loopback, 15140)), "External port preserved");
        foreach (var ip in new[] { "100.64.0.1", "100.127.255.255", "::ffff:100.64.0.1" })
            Check(HostingOptions.IsRailwayProxy(IPAddress.Parse(ip)), "Proxy range accepted");
        foreach (var ip in new[] { "100.63.255.255", "100.128.0.0", "10.0.0.1", "127.0.0.1", "::1" })
            Check(!HostingOptions.IsRailwayProxy(IPAddress.Parse(ip)), "Other addresses not exempt");
        foreach (var endpoint in new[] { "127.0.0.1", ":2593", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:abc", "[::1]:2593" })
        {
            bool rejected = false;
            try { HostingOptions.ParsePublicEndpoint(endpoint); }
            catch (ArgumentException) { rejected = true; }
            Check(rejected, "Invalid endpoint rejected: " + endpoint);
        }
        bool missing = false;
        try { Parse("--public"); }
        catch (ArgumentException) { missing = true; }
        Check(missing, "Missing option value rejected");

        var directory = Path.Combine(Path.GetTempPath(), "gemwright-hosting-" + Guid.NewGuid());
        Directory.CreateDirectory(directory);
        try
        {
            using (var stream = FileOperations.OpenSequentialStream(Path.Combine(directory, "parallel-save.bin"), FileMode.Create, FileAccess.Write, FileShare.None))
            {
                stream.WriteByte(42);
            }
            Check(File.ReadAllBytes(Path.Combine(directory, "parallel-save.bin"))[0] == 42, "Parallel save stream works without Kernel32 on Unix");
            var marker = Path.Combine(directory, "shutdown");
            Parse("--client-data", directory, "--shutdown-file", marker);
            Check(HostingOptions.ClientDataPath == directory, "Data path preserved");
            HostingOptions.WatchShutdown();
            Timer.Callback();
            Check(World.Saves == 0 && Core.Kills == 0, "Idle service keeps running");
            File.WriteAllText(marker, "");
            Timer.Callback();
            Check(World.Saves == 1 && World.Waits == 2 && Core.Kills == 1, "Shutdown saves and flushes before exit");
            Check(!File.Exists(marker), "Successful shutdown consumes marker");
            File.WriteAllText(marker, "");
            World.FailSave = true;
            try { Timer.Callback(); } catch (IOException) { }
            Check(Core.Kills == 1 && File.Exists(marker), "Save failure does not report successful shutdown");
        }
        finally { Directory.Delete(directory, true); }
        Console.WriteLine("Hosting options: " + checks + " checks passed.");
    }
}

// The harness runs the real patched options class without loading game data.
namespace Server
{
    public static class Timer
    {
        public static Action Callback;
        public static void DelayCall(TimeSpan delay, TimeSpan interval, Action callback) { Callback = callback; }
    }
    public static class World
    {
        public static int Saves, Waits;
        public static bool FailSave;
        public static void WaitForWriteCompletion() { Waits++; }
        public static void Save(bool message, bool background)
        {
            if (FailSave) throw new IOException("Simulated save failure");
            if (background) throw new Exception("Shutdown must wait for saves");
            Saves++;
        }
    }
    public static class Core
    {
        public static bool Windows = false;
        public static int Kills;
        public static void Kill()
        {
            if (World.Saves != 1 || World.Waits != 2) throw new Exception("Exit happened before save completed");
            Kills++;
        }
    }
}
