#include "support.hpp"
#include <CommonCrypto/CommonDigest.h>
#include <curl/curl.h>
#include <mach-o/dyld.h>
#include <sys/resource.h>
#include <pthread.h>
#include <unistd.h>
#include <array>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <fcntl.h>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>

namespace aihider {
namespace {
std::string hex(const unsigned char* bytes, size_t count) {
    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for (size_t i = 0; i < count; ++i) out << std::setw(2) << static_cast<unsigned>(bytes[i]);
    return out.str();
}
std::vector<uint32_t> codepoints(const std::string& value) {
    std::vector<uint32_t> result;
    for (size_t i = 0; i < value.size();) {
        auto lead = static_cast<unsigned char>(value[i++]);
        uint32_t cp = lead;
        unsigned more = 0;
        uint32_t minimum = 0;
        if (lead < 0x80) {}
        else if (lead >= 0xc2 && lead <= 0xdf) { cp = lead & 0x1f; more = 1; minimum = 0x80; }
        else if (lead >= 0xe0 && lead <= 0xef) { cp = lead & 0x0f; more = 2; minimum = 0x800; }
        else if (lead >= 0xf0 && lead <= 0xf4) { cp = lead & 7; more = 3; minimum = 0x10000; }
        else throw Error("invalid_text", "Text is not valid UTF-8.");
        if (more > value.size() - i) throw Error("invalid_text", "Text is not valid UTF-8.");
        for (unsigned j = 0; j < more; ++j) {
            auto next = static_cast<unsigned char>(value[i++]);
            if ((next & 0xc0) != 0x80) throw Error("invalid_text", "Text is not valid UTF-8.");
            cp = (cp << 6) | (next & 0x3f);
        }
        if (cp < minimum || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
            throw Error("invalid_text", "Text is not valid UTF-8.");
        result.push_back(cp);
    }
    return result;
}
bool whitespace(uint32_t cp) {
    return (cp >= 9 && cp <= 13) || (cp >= 0x1c && cp <= 0x20) || cp == 0x85 ||
        cp == 0xa0 || cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200a) ||
        cp == 0x2028 || cp == 0x2029 || cp == 0x202f || cp == 0x205f || cp == 0x3000;
}
struct Download {
    std::ofstream stream;
    uint64_t bytes = 0;
    uint64_t maximum;
};
size_t receive(char* data, size_t size, size_t count, void* pointer) {
    auto& state = *static_cast<Download*>(pointer);
    if (size && count > SIZE_MAX / size) return 0;
    size_t length = size * count;
    if (length > state.maximum - state.bytes) return 0;
    state.stream.write(data, static_cast<std::streamsize>(length));
    if (!state.stream) return 0;
    state.bytes += length;
    return length;
}
}

fs::path executable_path() {
    uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    std::vector<char> buffer(size);
    if (_NSGetExecutablePath(buffer.data(), &size)) throw Error("runtime_path", "Cannot locate the executable.");
    return fs::canonical(buffer.data());
}
fs::path user_home() {
    const char* home = std::getenv("HOME");
    if (!home || !*home || !fs::path(home).is_absolute()) throw Error("home_missing", "An absolute HOME is required.");
    return home;
}
fs::path default_home() {
    const char* override_path = std::getenv("DECKARD_HOME");
    if (override_path && *override_path) return fs::absolute(override_path);
    auto bundled = executable_path().parent_path().parent_path();
    if (fs::is_regular_file(bundled / "install.json")) return bundled;
    return user_home() / "Library/Application Support/Deckard/current";
}
std::string read_text(const fs::path& path, size_t limit) {
    if (!fs::is_regular_file(path) || fs::file_size(path) > limit)
        throw Error("invalid_file", "Required file is missing or exceeds its size limit.");
    std::ifstream stream(path, std::ios::binary);
    if (!stream) throw Error("file_read", "Cannot read a required file.");
    std::string data((std::istreambuf_iterator<char>(stream)), {});
    if (stream.bad() || data.size() > limit) throw Error("file_read", "Cannot read a required file.");
    return data;
}
Json read_json(const fs::path& path, size_t limit) {
    auto result = Json::parse(read_text(path, limit), nullptr, false);
    if (result.is_discarded()) throw Error("invalid_json", "Required JSON file is invalid.");
    return result;
}
void write_json(const fs::path& path, const Json& value) {
    auto temporary = path;
    temporary += ".writing-" + std::to_string(getpid()) + "-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    auto body = value.dump(2) + "\n";
    int descriptor = open(temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (descriptor < 0) throw Error("file_write", "Cannot create installation metadata.");
    try {
        size_t offset = 0;
        while (offset < body.size()) {
            ssize_t count = write(descriptor, body.data() + offset, body.size() - offset);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) throw Error("file_write", "Cannot write installation metadata.");
            offset += static_cast<size_t>(count);
        }
        if (fsync(descriptor)) throw Error("file_write", "Cannot flush installation metadata.");
        int closed = close(descriptor);
        descriptor = -1;
        if (closed) throw Error("file_write", "Cannot finish installation metadata.");
        fs::rename(temporary, path);
    } catch (...) {
        if (descriptor >= 0) close(descriptor);
        std::error_code error;
        fs::remove(temporary, error);
        if (error) std::cerr << "Deckard: metadata_cleanup_failed\n";
        throw;
    }
}
std::string sha256(const fs::path& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) throw Error("missing_assets", "Required asset is missing or unreadable.");
    CC_SHA256_CTX context;
    CC_SHA256_Init(&context);
    std::array<char, 65536> buffer{};
    while (stream) {
        stream.read(buffer.data(), buffer.size());
        CC_SHA256_Update(&context, buffer.data(), static_cast<CC_LONG>(stream.gcount()));
    }
    if (!stream.eof()) throw Error("asset_read", "Failed while reading an asset.");
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_Final(digest, &context);
    return hex(digest, sizeof(digest));
}
std::string text_sha256(const std::string& text) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(text.data(), static_cast<CC_LONG>(text.size()), digest);
    return hex(digest, sizeof(digest));
}
void require_hash(const fs::path& path, const std::string& expected) {
    if (expected.size() != 64 || sha256(path) != expected)
        throw Error("asset_mismatch", "An asset does not match its pinned SHA256.");
}
void download(const std::string& url, const fs::path& destination, const std::string& expected, uint64_t max_bytes) {
    if (fs::exists(destination)) { require_hash(destination, expected); return; }
    auto partial = destination;
    partial += ".download";
    uint64_t existing = fs::exists(partial) ? fs::file_size(partial) : 0;
    if (existing > max_bytes) throw Error("download_size", "The partial download exceeds its size limit.");
    if (existing && sha256(partial) == expected) {
        fs::rename(partial, destination);
        return;
    }
    Download state{std::ofstream(partial, std::ios::binary | std::ios::app), existing, max_bytes};
    if (!state.stream) throw Error("download_write", "Cannot create the download file.");
    CURL* handle = curl_easy_init();
    if (!handle) throw Error("download_init", "Cannot initialize HTTPS downloads.");
    curl_easy_setopt(handle, CURLOPT_URL, url.c_str());
    curl_easy_setopt(handle, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(handle, CURLOPT_PROTOCOLS_STR, "https");
    curl_easy_setopt(handle, CURLOPT_REDIR_PROTOCOLS_STR, "https");
    curl_easy_setopt(handle, CURLOPT_MAXREDIRS, 8L);
    curl_easy_setopt(handle, CURLOPT_CONNECTTIMEOUT, 30L);
    curl_easy_setopt(handle, CURLOPT_TIMEOUT, 1200L);
    curl_easy_setopt(handle, CURLOPT_FAILONERROR, 1L);
    if (existing) curl_easy_setopt(handle, CURLOPT_RESUME_FROM_LARGE, static_cast<curl_off_t>(existing));
    curl_easy_setopt(handle, CURLOPT_WRITEFUNCTION, receive);
    curl_easy_setopt(handle, CURLOPT_WRITEDATA, &state);
    CURLcode result = curl_easy_perform(handle);
    curl_easy_cleanup(handle);
    state.stream.close();
    if (result != CURLE_OK || !state.stream) throw Error("download_failed", "HTTPS download failed; no installation activated.");
    require_hash(partial, expected);
    fs::rename(partial, destination);
}
void background() {
    if (setpriority(PRIO_DARWIN_PROCESS, 0, PRIO_DARWIN_BG) != 0 ||
        pthread_set_qos_class_self_np(QOS_CLASS_BACKGROUND, 0) != 0)
        throw Error("scheduling_failed", "Cannot enable background scheduling.");
}
bool extension_id_valid(const std::string& id) {
    return id.size() == 32 && id.find_first_not_of("abcdefghijklmnop") == std::string::npos;
}
size_t characters(const std::string& text) { return codepoints(text).size(); }
size_t words(const std::string& text) {
    size_t count = 0;
    bool previous_space = true;
    for (auto cp : codepoints(text)) {
        bool space = whitespace(cp);
        if (!space && previous_space) ++count;
        previous_space = space;
    }
    return count;
}
double sigmoid(double value) {
    if (!std::isfinite(value)) throw Error("invalid_output", "The model returned a non-finite logit.");
    return value >= 0 ? 1 / (1 + std::exp(-value)) : std::exp(value) / (1 + std::exp(value));
}
std::vector<size_t> word_boundaries(const std::string& text) {
    std::vector<size_t> result;
    size_t offset = 0;
    bool previous_space = true;
    for (auto cp : codepoints(text)) {
        bool space = whitespace(cp) || cp == 0xfeff;
        if (!space && previous_space) result.push_back(offset);
        previous_space = space;
        offset += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    }
    if (!result.empty()) result[0] = 0;
    result.push_back(text.size());
    return result;
}
Json identity() {
    return {{"protocol_version", protocol_version}, {"model", model_id}, {"revision", revision},
            {"policy", policy_id}, {"flag_threshold", flag_threshold}, {"experimental", true},
            {"min_words", min_words}};
}
Json installed_config(const fs::path& home, bool verify) {
    auto config = read_json(home / "install.json");
    if (!config.is_object() || config.value("format", Json()) != 1 ||
        config.value("product", Json()) != "Deckard" || config.value("version", Json()) != app_version ||
        config.value("model", Json()) != model_id || config.value("revision", Json()) != revision ||
        config.value("policy", Json()) != policy_id || config.value("flag_threshold", Json()) != flag_threshold ||
        config.value("experimental", Json()) != true ||
        !config.value("weights_sha256", Json()).is_string() || !config.value("tokenizer_sha256", Json()).is_string())
        throw Error("invalid_installation", "Installation metadata is incompatible. Run deckard install.");
    if (!fs::is_regular_file(home / "models/packed.safetensors") ||
        !fs::is_regular_file(home / "models/tokenizer.json"))
        throw Error("missing_assets", "Model assets are missing. Run deckard install.");
    if (verify) {
        require_hash(home / "models/packed.safetensors", config.at("weights_sha256").get<std::string>());
        require_hash(home / "models/tokenizer.json", config.at("tokenizer_sha256").get<std::string>());
    }
    return config;
}
}
