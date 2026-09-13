#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <csignal>
#include <functional>
#include <iomanip>
#include <iostream>
#include <pthread.h>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/resource.h>
#include <unistd.h>

namespace deckard_power {
using Clock = std::chrono::steady_clock;
inline double epoch() {
    return std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
}
inline double cpu_seconds() {
    struct rusage usage {};
    if (getrusage(RUSAGE_SELF, &usage))
        throw std::runtime_error("Cannot read benchmark process CPU time.");
    return usage.ru_utime.tv_sec + usage.ru_utime.tv_usec / 1e6 +
           usage.ru_stime.tv_sec + usage.ru_stime.tv_usec / 1e6;
}
inline void background() {
    if (setpriority(PRIO_DARWIN_PROCESS, 0, PRIO_DARWIN_BG) ||
        pthread_set_qos_class_self_np(QOS_CLASS_BACKGROUND, 0))
        throw std::runtime_error("Cannot set production-equivalent background scheduling.");
}
inline void deadline(int) {
    static constexpr char message[] = "Power worker exceeded its bounded inference deadline.\n";
    (void)!write(STDERR_FILENO, message, sizeof(message) - 1);
    _exit(124);
}

// The controller owns quiet idle windows and capture. The callback includes any
// streaming layer loads; GPU allowance includes initial preparation and warmup.
inline void serve(const std::string& backend, const std::function<float()>& infer,
                  double preparation_seconds = 0, bool profile_cpu = false,
                  const std::function<bool(const std::string&)>& control = {}) {
    const bool gpu = backend == "mlx";
    double used = preparation_seconds;
    std::signal(SIGALRM, deadline);
    auto execute = [&]() {
        double remaining = gpu ? 19.0 - used : 60.0;
        if (remaining <= 0) throw std::runtime_error("GPU inference allowance exhausted.");
        alarm(static_cast<unsigned>(std::max(1.0, std::floor(remaining))));
        const auto start = Clock::now();
        float value = infer();
        used += std::chrono::duration<double>(Clock::now() - start).count();
        alarm(0);
        if (!std::isfinite(value)) throw std::runtime_error("Non-finite power benchmark logit.");
        return value;
    };
    const double warmup_cpu_start = profile_cpu ? cpu_seconds() : 0;
    const float reference = execute();
    const double warmup_cpu = profile_cpu ? cpu_seconds() - warmup_cpu_start : 0;
    std::cout << std::setprecision(17) << "{\"ready\":true,\"backend\":\"" << backend
              << "\",\"logit\":" << reference << ",\"preparation_seconds\":" << used;
    if (profile_cpu) std::cout << ",\"warmup_process_cpu_seconds\":" << warmup_cpu;
    std::cout << "}\n" << std::flush;
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line == "quit") return;
        if (control && control(line)) continue;
        std::istringstream parser(line);
        std::string command, extra;
        int milliseconds = 0;
        if (!(parser >> command >> milliseconds) || command != "run" ||
            (parser >> extra) || milliseconds < 100 || milliseconds > 15000 ||
            (gpu && used + milliseconds / 1000.0 + 0.5 > 19.0))
            throw std::runtime_error("Invalid or over-budget benchmark command.");
        const double cpu_start = profile_cpu ? cpu_seconds() : 0;
        const double begin = epoch();
        const auto start = Clock::now();
        int count = 0;
        float value;
        do {
            value = execute();
            if (std::abs(value - reference) > 0.03f)
                throw std::runtime_error("Repeated inference logit changed.");
            ++count;
        } while (std::chrono::duration<double, std::milli>(Clock::now() - start).count() < milliseconds);
        const double end = epoch();
        const double cpu_used = profile_cpu ? cpu_seconds() - cpu_start : 0;
        std::cout << "{\"backend\":\"" << backend << "\",\"begin\":" << begin
                  << ",\"end\":" << end << ",\"requests\":" << count
                  << ",\"logit\":" << value << ",\"inference_seconds_used\":" << used;
        if (profile_cpu) std::cout << ",\"process_cpu_seconds\":" << cpu_used;
        std::cout << "}\n" << std::flush;
    }
}
}
