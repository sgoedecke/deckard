#pragma once
#include "gradient_backend.hpp"
#include "support.hpp"
#include <iosfwd>
#include <memory>

namespace aihider {
class Analyzer {
public:
    explicit Analyzer(fs::path home, Backend backend = Backend::Auto);
    ~Analyzer();
    Json ping();
    Json analyze(const std::string& text);
    Json plan(const Json& texts);
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
std::vector<std::vector<uint32_t>> windows(const std::vector<uint32_t>& ids);
Json validate_request(const Json& request);
bool read_frame(std::istream& stream, Json& message);
void write_frame(std::ostream& stream, const Json& message);
int serve(const fs::path& home, Backend backend = Backend::Auto);
void self_test();
}
