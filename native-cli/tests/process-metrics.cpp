#include <charconv>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <string_view>
#if defined(__linux__)
#include <unistd.h>
#elif defined(__APPLE__)
#include <libproc.h>
#endif

int main(int argc, char** argv) {
    int pid = 0;
    if (argc != 2) return 2;
    std::string_view argument(argv[1]);
    auto parsed = std::from_chars(argument.data(), argument.data() + argument.size(), pid);
    if (parsed.ec != std::errc() || parsed.ptr != argument.data() + argument.size() || pid <= 0) return 2;
#if defined(__APPLE__)
    rusage_info_v4 usage {};
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, reinterpret_cast<rusage_info_t*>(&usage))) {
        std::cerr << "Cannot read native process physical footprint.\n";
        return 1;
    }
    std::cout << "{\"physical_footprint_bytes\":" << usage.ri_phys_footprint
              << ",\"peak_physical_footprint_bytes\":" << usage.ri_lifetime_max_phys_footprint
              << ",\"user_time_ns\":" << usage.ri_user_time
              << ",\"system_time_ns\":" << usage.ri_system_time << "}\n";
#elif defined(__linux__)
    uint64_t resident_bytes = 0, peak_bytes = 0, utime_ticks = 0, stime_ticks = 0;
    bool status_read = false, stat_read = false;
    std::ifstream status("/proc/" + std::to_string(pid) + "/status");
    std::string line;
    while (std::getline(status, line)) {
        std::istringstream stream(line);
        std::string key;
        if (!(stream >> key)) continue;
        if (key == "VmRSS:") { uint64_t kib; if (stream >> kib) { resident_bytes = kib * 1024; status_read = true; } }
        else if (key == "VmHWM:") { uint64_t kib; if (stream >> kib) { peak_bytes = kib * 1024; status_read = true; } }
    }
    std::ifstream stat("/proc/" + std::to_string(pid) + "/stat");
    std::string rest;
    if (stat >> rest) {
        std::getline(stat, rest, ')');
        if (rest.empty() || stat.peek() != ' ') return 1;
        stat.get();
        for (int field_number = 3; field_number <= 15; ++field_number) {
            if (!(stat >> rest)) return 1;
            if (field_number == 14) utime_ticks = std::stoull(rest);
            else if (field_number == 15) stime_ticks = std::stoull(rest);
        }
        stat_read = true;
    }
    if (!status_read || !stat_read || !(status && stat)) {
        std::cerr << "Cannot read native process memory metrics.\n";
        return 1;
    }
    long ticks_per_second = sysconf(_SC_CLK_TCK);
    const double tick_ns = ticks_per_second > 0 ? 1e9 / static_cast<double>(ticks_per_second) : 1e9;
    std::cout << "{\"physical_footprint_bytes\":" << resident_bytes
              << ",\"peak_physical_footprint_bytes\":" << peak_bytes
              << ",\"user_time_ns\":" << static_cast<uint64_t>(utime_ticks * tick_ns)
              << ",\"system_time_ns\":" << static_cast<uint64_t>(stime_ticks * tick_ns) << "}\n";
#endif
}
