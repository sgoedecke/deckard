#pragma once
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>

namespace aihider {
namespace fs = std::filesystem;
using Json = nlohmann::json;
inline constexpr const char* model_id = "ShantanuT01/gradient-ai-text-detector";
inline constexpr const char* revision = "c2e8b6df87f8a211cbffb713fa9873a0c3a9713f";
inline constexpr const char* host_name = "com.sgoedecke.deckard";
inline constexpr const char* app_version = "0.5.0";
inline constexpr const char* default_extension_id = "bkihjdkalohbkgnjjoobababhipefjdg";
inline constexpr const char* policy_id = "gradient-q4-two-scale-v1";
inline constexpr double flag_threshold = 0.97;
inline constexpr int protocol_version = 3;
inline constexpr size_t min_words = 50;
inline constexpr const char* packed_sha = "85a9e02ebdcbbe1dd84cdbf893b708e44ee4691cadc7e1a4780039e22097ac98";
inline constexpr const char* tokenizer_sha = "4b4f60231058db4b5794e7b124bb7945bc8ade6719282de4d2e0372ee527b929";
inline constexpr const char* upstream_tokenizer_sha = "2b37df34524d914c6f15ddccdb324c98d43358d5f68a52758fcc87721c3dd16d";
inline constexpr const char* fp32_sha = "87ecc3630d8dc2324c7a61e3448551cfa65732a3d27f24afbd2c94e0266b74b7";

struct Error : std::runtime_error {
    std::string code;
    Error(std::string code, const std::string& message) : std::runtime_error(message), code(std::move(code)) {}
};
fs::path executable_path();
fs::path user_home();
fs::path default_home();
std::string read_text(const fs::path& path, size_t limit = 1024 * 1024);
Json read_json(const fs::path& path, size_t limit = 1024 * 1024);
void write_json(const fs::path& path, const Json& value);
std::string sha256(const fs::path& path);
std::string text_sha256(const std::string& text);
void require_hash(const fs::path& path, const std::string& expected);
void download(const std::string& url, const fs::path& destination, const std::string& expected, uint64_t max_bytes);
void background();
bool extension_id_valid(const std::string& id);
size_t characters(const std::string& text);
size_t words(const std::string& text);
std::vector<size_t> word_boundaries(const std::string& text);
double sigmoid(double logit);
Json identity();
Json installed_config(const fs::path& home, bool verify);
}
