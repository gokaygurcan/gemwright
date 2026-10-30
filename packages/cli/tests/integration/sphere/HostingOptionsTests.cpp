#include "graysvr.h"
#include <cassert>
#include <iostream>

int main()
{
    assert(!Gemwright::IsRailwayProxy(CSocketAddressIP("100.64.0.1")));
    Gemwright::RailwayProxy = true;
    for (const char *address : {"100.64.0.1", "100.127.255.255"})
        assert(Gemwright::IsRailwayProxy(CSocketAddressIP(address)));
    for (const char *address : {"100.63.255.255", "100.128.0.0", "127.0.0.1", "10.0.0.1"})
        assert(!Gemwright::IsRailwayProxy(CSocketAddressIP(address)));
    auto endpoint = Gemwright::ParseEndpoint("127.0.0.1:15993");
    assert(endpoint.GetPort() == 15993);
    assert(endpoint.GetAddrIP() == CSocketAddressIP("127.0.0.1").GetAddrIP());
    for (const char *value : {"127.0.0.1", ":2593", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:abc", "127.0.0.1:-1"})
    {
        bool rejected = false;
        try { Gemwright::ParseEndpoint(value); } catch (const std::exception &) { rejected = true; }
        assert(rejected);
    }
    char binary[] = "spheresvr", option[] = "--shutdown-file", invalid[] = "/missing/marker";
    char *args[] = {binary, option, invalid};
    bool rejected = false;
    try { Gemwright::Parse(3, args); } catch (const std::exception &) { rejected = true; }
    assert(rejected);
    std::cout << "Sphere hosting option checks passed.\n";
}
