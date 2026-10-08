#include "support.hpp"
#include "model_assets.hpp"
#if defined(__APPLE__)
#include <CommonCrypto/CommonDigest.h>
#else
#include <openssl/evp.h>
#endif
#include <curl/curl.h>
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif
#include <sys/resource.h>
#include <pthread.h>
#include <unistd.h>
#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <fcntl.h>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <sstream>
#include <set>

namespace aihider {
namespace {
std::string hex(const unsigned char* bytes, size_t count) {
    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for (size_t i = 0; i < count; ++i) out << std::setw(2) << static_cast<unsigned>(bytes[i]);
    return out.str();
}
#if !defined(__APPLE__)
// Incremental SHA-256 through OpenSSL's EVP API; the raw SHA256_* functions
// are deprecated since OpenSSL 3.0.
class Sha256 {
public:
    Sha256() : context_(EVP_MD_CTX_new(), EVP_MD_CTX_free) {
        if (!context_ || EVP_DigestInit_ex(context_.get(), EVP_sha256(), nullptr) != 1)
            throw Error("digest_failed", "Cannot initialize the SHA-256 digest.");
    }
    void update(const char* data, size_t size) {
        if (EVP_DigestUpdate(context_.get(), data, size) != 1)
            throw Error("digest_failed", "Cannot compute the SHA-256 digest.");
    }
    std::string hex_digest() {
        unsigned char digest[EVP_MAX_MD_SIZE];
        unsigned int size = 0;
        if (EVP_DigestFinal_ex(context_.get(), digest, &size) != 1)
            throw Error("digest_failed", "Cannot compute the SHA-256 digest.");
        return hex(digest, size);
    }
private:
    std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> context_;
};
#endif
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
    std::string label;
    uint64_t resumed_from = 0;
    int shown_percent = -1;
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
// curl's progress callback. Model files are hundreds of MiB, so install
// repaints one "label: done / total MiB (P%)" line in place, only when the
// percentage changes. curl counts a resumed transfer from the resume offset;
// the offset is added back so the line describes the whole file. Returning
// nonzero would abort the transfer.
int report_progress(void* pointer, curl_off_t remaining_total, curl_off_t remaining_done, curl_off_t, curl_off_t) {
    auto& state = *static_cast<Download*>(pointer);
    if (remaining_total <= 0) return 0;
    const uint64_t total = state.resumed_from + static_cast<uint64_t>(remaining_total);
    const uint64_t done = state.resumed_from + static_cast<uint64_t>(remaining_done);
    const int percent = static_cast<int>(std::min<uint64_t>(100, done * 100 / total));
    if (percent == state.shown_percent) return 0;
    state.shown_percent = percent;
    constexpr uint64_t mib = 1024 * 1024;
    std::cout << '\r' << state.label << ": " << done / mib << " / " << total / mib << " MiB (" << percent << "%)"
              << std::flush;
    return 0;
}
}

fs::path executable_path() {
#if defined(__APPLE__)
    uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    std::vector<char> buffer(size);
    if (_NSGetExecutablePath(buffer.data(), &size)) throw Error("runtime_path", "Cannot locate the executable.");
    return fs::canonical(buffer.data());
#elif defined(__linux__)
    std::error_code error;
    auto resolved = fs::canonical("/proc/self/exe", error);
    if (error) throw Error("runtime_path", "Cannot locate the executable.");
    return resolved;
#endif
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
#if defined(__APPLE__)
    return user_home() / "Deckard/current";
#elif defined(__linux__)
    return user_home() / ".local/share/deckard/current";
#endif
}
fs::path default_manifest_dir() {
#if defined(__APPLE__)
    return user_home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts";
#elif defined(__linux__)
    return user_home() / ".config/google-chrome/NativeMessagingHosts";
#endif
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
#if defined(__APPLE__)
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
#else
    Sha256 context;
    std::array<char, 65536> buffer{};
    while (stream) {
        stream.read(buffer.data(), buffer.size());
        context.update(buffer.data(), static_cast<size_t>(stream.gcount()));
    }
    if (!stream.eof()) throw Error("asset_read", "Failed while reading an asset.");
    return context.hex_digest();
#endif
}
std::string text_sha256(const std::string& text) {
#if defined(__APPLE__)
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(text.data(), static_cast<CC_LONG>(text.size()), digest);
    return hex(digest, sizeof(digest));
#else
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int size = 0;
    if (EVP_Digest(text.data(), text.size(), digest, &size, EVP_sha256(), nullptr) != 1)
        throw Error("digest_failed", "Cannot compute the SHA-256 digest.");
    return hex(digest, size);
#endif
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
    Download state{std::ofstream(partial, std::ios::binary | std::ios::app), existing, max_bytes,
                   destination.filename().string(), existing};
    if (!state.stream) throw Error("download_write", "Cannot create the download file.");
    CURL* handle = curl_easy_init();
    if (!handle) throw Error("download_init", "Cannot initialize HTTPS downloads.");
    curl_easy_setopt(handle, CURLOPT_URL, url.c_str());
    curl_easy_setopt(handle, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(handle, CURLOPT_PROTOCOLS_STR, "https");
    curl_easy_setopt(handle, CURLOPT_REDIR_PROTOCOLS_STR, "https");
    curl_easy_setopt(handle, CURLOPT_MAXREDIRS, 8L);
    curl_easy_setopt(handle, CURLOPT_CONNECTTIMEOUT, 30L);
    curl_easy_setopt(handle, CURLOPT_TIMEOUT, 7200L);
    curl_easy_setopt(handle, CURLOPT_FAILONERROR, 1L);
    if (existing) curl_easy_setopt(handle, CURLOPT_RESUME_FROM_LARGE, static_cast<curl_off_t>(existing));
    curl_easy_setopt(handle, CURLOPT_WRITEFUNCTION, receive);
    curl_easy_setopt(handle, CURLOPT_WRITEDATA, &state);
    // Surface live progress instead of a silent multi-hundred-MiB transfer; the
    // progress line is terminated below so it does not run into later messages.
    curl_easy_setopt(handle, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(handle, CURLOPT_XFERINFOFUNCTION, report_progress);
    curl_easy_setopt(handle, CURLOPT_XFERINFODATA, &state);
    CURLcode result = curl_easy_perform(handle);
    curl_easy_cleanup(handle);
    // Close the \r-updating progress line whether the transfer succeeded or not.
    if (state.shown_percent >= 0) std::cout << '\n' << std::flush;
    state.stream.close();
    if (result != CURLE_OK || !state.stream) throw Error("download_failed", "HTTPS download failed; no installation activated.");
    require_hash(partial, expected);
    fs::rename(partial, destination);
}
void background() {
#if defined(__APPLE__)
    if (setpriority(PRIO_DARWIN_PROCESS, 0, PRIO_DARWIN_BG) != 0 ||
        pthread_set_qos_class_self_np(QOS_CLASS_BACKGROUND, 0) != 0)
        throw Error("scheduling_failed", "Cannot enable background scheduling.");
#elif defined(__linux__)
    if (setpriority(PRIO_PROCESS, 0, 10) != 0)
        throw Error("scheduling_failed", "Cannot enable background scheduling.");
#endif
}
void default_priority() {
#if defined(__APPLE__)
    if (setpriority(PRIO_DARWIN_PROCESS, 0, 0) != 0 ||
        pthread_set_qos_class_self_np(QOS_CLASS_DEFAULT, 0) != 0)
        throw Error("scheduling_failed", "Cannot enable default-priority inference.");
#elif defined(__linux__)
    // Unprivileged processes may not lower their nice value, so a deckard
    // started niced (for example by a niced launcher) keeps that priority.
    if (setpriority(PRIO_PROCESS, 0, 0) != 0 && errno != EACCES && errno != EPERM)
        throw Error("scheduling_failed", "Cannot enable default-priority inference.");
#endif
}
const Json& model_assets() {
    static const auto assets = Json::parse(model_assets_json);
    return assets;
}
std::string model_assets_id() { return model_assets_sha256; }
fs::path model_cache() {
#if defined(__APPLE__)
    return user_home() / "Library/Caches/Deckard/coreml";
#elif defined(__linux__)
    return user_home() / ".cache/deckard";
#endif
}
void verify_model_assets(const fs::path& directory, bool verify_hashes, bool allow_unpinned) {
    std::error_code error;
    const auto root = fs::canonical(directory, error);
    const std::string missing = std::string(model_assets_name) + " are missing. " + reinstall_hint;
    if (error) throw Error("missing_assets", missing);
    std::set<fs::path> directories;
    const auto& files = model_assets().at("files");
    for (auto it = files.begin(); it != files.end(); ++it) {
        const fs::path relative(it.key());
        fs::path current = root;
        for (const auto& part : relative) {
            current /= part;
            const auto status = fs::symlink_status(current);
            if (status.type() == fs::file_type::not_found)
                throw Error("missing_assets", missing);
            const bool leaf = current == root / relative;
            if (leaf ? !fs::is_regular_file(status) : !fs::is_directory(status))
                throw Error("asset_mismatch", "Model assets must be ordinary files and directories, not links.");
            if (!leaf) directories.insert(current.lexically_relative(root));
        }
        if (verify_hashes) require_hash(root / relative, it.value().get<std::string>());
    }
    // The runtime must never consume extra, unpinned files hidden inside the
    // package (Core ML) or the model directory itself (Candle, no package).
    if (allow_unpinned) return;
    const auto package = root / model_assets().value("model_package", std::string());
    for (const auto& entry : fs::recursive_directory_iterator(package)) {
        const auto relative = entry.path().lexically_relative(root);
        const auto status = entry.symlink_status();
        if ((fs::is_directory(status) && directories.count(relative)) ||
            (fs::is_regular_file(status) && files.contains(relative.generic_string()))) continue;
        throw Error("asset_mismatch", "The " + std::string(model_package_name) + " contains unexpected assets.");
    }
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
        config.value("runtime", Json()) != runtime_id ||
        config.value("source", Json()) != native_source ||
        config.value("weights_sha256", Json()) != packed_sha ||
        config.value("tokenizer_sha256", Json()) != tokenizer_sha ||
        config.value("model_assets_sha256", Json()) != model_assets_id() ||
        config.value("model_files", Json()) != model_assets().at("files"))
        throw Error("invalid_installation", std::string("Installation metadata is incompatible. ") + reinstall_hint);
    const auto models = fs::canonical(home) / "models";
    if (!fs::is_directory(fs::symlink_status(models)))
        throw Error("missing_assets", "Model assets are missing or redirected. Run deckard install.");
    verify_model_assets(models, verify);
    return config;
}
}
