#include <libproc.h>
#include <charconv>
#include <iostream>
#include <string_view>

int main(int argc, char** argv) {
    int pid = 0;
    if (argc != 2) return 2;
    std::string_view argument(argv[1]);
    auto parsed = std::from_chars(argument.data(), argument.data() + argument.size(), pid);
    if (parsed.ec != std::errc() || parsed.ptr != argument.data() + argument.size() || pid <= 0) return 2;
    rusage_info_v4 usage {};
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, reinterpret_cast<rusage_info_t*>(&usage))) {
        std::cerr << "Cannot read native process physical footprint.\n";
        return 1;
    }
    std::cout << "{\"physical_footprint_bytes\":" << usage.ri_phys_footprint
              << ",\"peak_physical_footprint_bytes\":" << usage.ri_lifetime_max_phys_footprint
              << ",\"user_time_ns\":" << usage.ri_user_time
              << ",\"system_time_ns\":" << usage.ri_system_time << "}\n";
}
