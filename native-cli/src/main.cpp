#include "support.hpp"
#include "host.hpp"
#include "gradient.hpp"
#include "tokenizer.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <fcntl.h>
#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <thread>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

namespace aihider {
namespace {
struct Options {
    std::map<std::string, std::string> values;
    std::set<std::string> flags;
    std::string get(const std::string& key, const std::string& fallback = "") const {
        auto it = values.find(key);
        return it == values.end() ? fallback : it->second;
    }
    bool has(const std::string& key) const { return flags.count(key) || values.count(key); }
};
Options options(int argc, char** argv, int start) {
    const std::set<std::string> values{"--home", "--extension-id", "--manifest-dir", "--model-dir",
                                      "--file", "--model", "--fixtures", "--output", "--source"};
    const std::set<std::string> flags{"--replace", "--no-register", "--download", "--eager"};
    Options result;
    for (int i = start; i < argc; ++i) {
        std::string key = argv[i];
        if (result.has(key)) throw Error("arguments", "Duplicate option: " + key);
        if (values.count(key)) {
            if (++i == argc || !*argv[i]) throw Error("arguments", "Missing value for " + key);
            result.values[key] = argv[i];
        } else if (flags.count(key)) result.flags.insert(key);
        else throw Error("arguments", "Unknown option: " + key);
    }
    return result;
}
void allow_options(const Options& options, const std::set<std::string>& allowed) {
    for (const auto& item : options.values)
        if (!allowed.count(item.first)) throw Error("arguments", "Option not supported by this command: " + item.first);
    for (const auto& flag : options.flags)
        if (!allowed.count(flag)) throw Error("arguments", "Option not supported by this command: " + flag);
}
fs::path home_for(const Options& options) {
    fs::path home = options.has("--home") ? fs::absolute(options.get("--home")) : default_home();
    if (!fs::is_regular_file(home / "install.json") && fs::is_regular_file(home / "current/install.json"))
        home /= "current";
    return home;
}
void copy_checked(const fs::path& source, const fs::path& target) {
    if (!fs::is_regular_file(source)) throw Error("missing_bundle", "The native distribution is incomplete.");
    fs::copy_file(source, target, fs::copy_options::none);
}
struct Staging {
    fs::path path;
    explicit Staging(const fs::path& parent) {
        path = parent / (".stage-" + std::to_string(getpid()) + "-" +
                        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        if (!fs::create_directory(path)) throw Error("staging", "Cannot create a unique installation stage.");
        fs::permissions(path, fs::perms::owner_all);
    }
    ~Staging() {
        if (!path.empty()) {
            std::error_code error;
            fs::remove_all(path, error);
            if (error) std::cerr << "AI Hider: cannot remove owned staging directory: " << path << '\n';
        }
    }
};
struct InstallLock {
    int descriptor;
    explicit InstallLock(const fs::path& prefix) {
        descriptor = open((prefix / ".install.lock").c_str(), O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
        if (descriptor < 0) throw Error("install_lock", "Cannot open the installation lock.");
        struct stat info {};
        if (fstat(descriptor, &info) || !S_ISREG(info.st_mode) || info.st_nlink != 1) {
            close(descriptor);
            throw Error("install_lock", "The installation lock must be a private regular file.");
        }
        if (flock(descriptor, LOCK_EX | LOCK_NB)) {
            close(descriptor);
            throw Error("install_lock", "Another install or uninstall is using this destination.");
        }
    }
    ~InstallLock() { close(descriptor); }
};
std::string inferred_extension(const fs::path& registration) {
    if (!fs::is_regular_file(registration)) return "";
    auto old = read_json(registration);
    if (!old.is_object() || !old.contains("allowed_origins") || !old["allowed_origins"].is_array() ||
        old["allowed_origins"].size() != 1 || !old["allowed_origins"][0].is_string()) return "";
    std::string origin = old["allowed_origins"][0], prefix = "chrome-extension://";
    if (origin.size() != prefix.size() + 33 || origin.compare(0, prefix.size(), prefix) != 0 || origin.back() != '/')
        return "";
    std::string id = origin.substr(prefix.size(), 32);
    return extension_id_valid(id) ? id : "";
}
void install(const Options& options) {
    allow_options(options, {"--home", "--extension-id", "--manifest-dir", "--model-dir", "--replace", "--no-register", "--download"});
    if (options.has("--model-dir") && options.has("--download"))
        throw Error("arguments", "Use either --model-dir or --download, not both.");
    background();
    fs::path prefix = options.has("--home") ? fs::absolute(options.get("--home")) :
        user_home() / "Library/Application Support/AI Hider";
    fs::path manifest_dir = options.has("--manifest-dir") ? fs::absolute(options.get("--manifest-dir")) :
        user_home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts";
    auto registration = manifest_dir / (std::string(host_name) + ".json");
    std::string id = options.get("--extension-id");
    if (id.empty() && !options.has("--no-register")) id = inferred_extension(registration);
    if ((!options.has("--no-register") || !id.empty()) && !extension_id_valid(id))
        throw Error("extension_id", "Pass --extension-id with the 32-letter ID from chrome://extensions, or use --no-register.");
    Json manifest = {
        {"name", host_name}, {"description", "AI Hider native Gradient MLX (experimental marking)"},
        {"path", (prefix / "current/bin/ai-hider-host").string()}, {"type", "stdio"},
        {"allowed_origins", Json::array({"chrome-extension://" + id + "/"})},
    };
    fs::create_directories(prefix);
    fs::permissions(prefix, fs::perms::owner_all);
    InstallLock lock(prefix);
    if (!options.has("--no-register") && fs::exists(registration) && !options.has("--replace") && read_json(registration) != manifest)
        throw Error("registration_conflict", "An existing native host differs. Review it, then pass --replace to switch to Gradient.");
    auto current = prefix / "current";
    if (fs::exists(current) && !fs::is_symlink(current))
        throw Error("install_conflict", "The current installation pointer is not a symlink; no activation performed.");
    std::optional<fs::path> previous;
    if (fs::is_symlink(current)) previous = fs::read_symlink(current);
    fs::create_directories(prefix / "releases");
    Staging stage(prefix);
    fs::create_directory(stage.path / "bin");
    fs::create_directory(stage.path / "lib");
    fs::create_directory(stage.path / "models");
    auto executable = executable_path();
    auto distribution = executable.parent_path().parent_path();
    copy_checked(executable, stage.path / "bin/ai-hider");
    fs::permissions(stage.path / "bin/ai-hider", fs::perms::owner_all);
    fs::create_symlink("ai-hider", stage.path / "bin/ai-hider-host");
    copy_checked(distribution / "lib/libmlx.dylib", stage.path / "lib/libmlx.dylib");
    copy_checked(distribution / "lib/mlx.metallib", stage.path / "lib/mlx.metallib");
    if (!fs::is_directory(distribution / "share/licenses")) throw Error("missing_bundle", "Distribution license notices are missing.");
    fs::create_directory(stage.path / "share");
    fs::copy(distribution / "share/licenses", stage.path / "share/licenses", fs::copy_options::recursive);
    std::string tokenizer_digest;
    if (options.has("--model-dir")) {
        fs::path source = fs::absolute(options.get("--model-dir"));
        require_hash(source / "packed.safetensors", packed_sha);
        require_hash(source / "tokenizer.json", tokenizer_sha);
        copy_checked(source / "packed.safetensors", stage.path / "models/packed.safetensors");
        copy_checked(source / "tokenizer.json", stage.path / "models/tokenizer.json");
        tokenizer_digest = tokenizer_sha;
    } else {
        std::string base = std::string("https://huggingface.co/") + model_id + "/resolve/" + revision + "/";
        fs::create_directories(prefix / "downloads");
        auto source = prefix / "downloads/source.safetensors";
        auto tokenizer_source = prefix / "downloads/tokenizer.json";
        std::cerr << "Downloading the pinned public checkpoint (~1.74GB) for one-time native 4-bit conversion.\n";
        download(base + "model.safetensors", source, fp32_sha, 1800000000);
        download(base + "tokenizer.json", tokenizer_source, upstream_tokenizer_sha, 20000000);
        copy_checked(tokenizer_source, stage.path / "models/tokenizer.json");
        std::cerr << "Converting weights with native MLX; no Python is involved.\n";
        Gradient::quantize_checkpoint(source, stage.path / "models/packed.safetensors");
        fs::remove(source);
        tokenizer_digest = upstream_tokenizer_sha;
    }
    Tokenizer tokenizer(stage.path / "models/tokenizer.json");
    auto probe = tokenizer.wrap(tokenizer.encode("Native Gradient installation."));
    if (probe.size() < 3 || probe.front() != 1 || probe.back() != 2)
        throw Error("tokenizer_mismatch", "The tokenizer does not have Gradient's expected special tokens.");
    std::string weights_digest = sha256(stage.path / "models/packed.safetensors");
    if (options.has("--model-dir") && weights_digest != packed_sha)
        throw Error("asset_mismatch", "The copied packed weights do not match their pinned SHA256.");
    require_hash(stage.path / "models/tokenizer.json", tokenizer_digest);
    Json config = {
        {"format", 1}, {"version", "0.3.0"}, {"model", model_id}, {"revision", revision},
        {"policy", policy_id}, {"flag_threshold", flag_threshold}, {"experimental", true},
        {"extension_id", id}, {"weights_sha256", weights_digest}, {"tokenizer_sha256", tokenizer_digest},
        {"source", options.has("--model-dir") ? "verified-packed-export" : "verified-fp32-native-quantization"},
        {"binary_sha256", sha256(stage.path / "bin/ai-hider")},
        {"mlx_sha256", sha256(stage.path / "lib/libmlx.dylib")},
        {"metal_sha256", sha256(stage.path / "lib/mlx.metallib")},
        {"threshold_notice", "Retrospective benchmark threshold; <=1% browsing FPR is not independently validated."},
    };
    config["license_files"] = Json::array();
    for (const auto& entry : fs::recursive_directory_iterator(stage.path / "share/licenses"))
        if (entry.is_regular_file())
            config["license_files"].push_back(entry.path().lexically_relative(stage.path).generic_string());
    std::sort(config["license_files"].begin(), config["license_files"].end());
    write_json(stage.path / "install.json", config);
    auto release_name = "0.3.0-" + text_sha256(config.dump()).substr(0, 20);
    auto release = prefix / "releases" / release_name;
    if (fs::exists(release)) {
        if (installed_config(release, true) != config ||
            sha256(release / "bin/ai-hider") != config["binary_sha256"].get<std::string>() ||
            sha256(release / "lib/libmlx.dylib") != config["mlx_sha256"].get<std::string>() ||
            sha256(release / "lib/mlx.metallib") != config["metal_sha256"].get<std::string>())
            throw Error("release_conflict", "An existing release is inconsistent; it was not overwritten.");
    } else {
        fs::rename(stage.path, release);
        stage.path.clear();
    }
    std::unique_ptr<Staging> registration_stage;
    if (!options.has("--no-register")) {
        fs::create_directories(manifest_dir);
        registration_stage = std::make_unique<Staging>(manifest_dir);
        write_json(registration_stage->path / "manifest.json", manifest);
    }
    auto pointer = prefix / (".current-" + std::to_string(getpid()));
    fs::create_symlink(fs::path("releases") / release_name, pointer);
    fs::rename(pointer, current);
    try {
        if (registration_stage) fs::rename(registration_stage->path / "manifest.json", registration);
    } catch (...) {
        // Registration and activation cannot be one filesystem transaction.
        // Restore the previous release if publishing the manifest fails.
        if (previous) {
            fs::create_symlink(*previous, pointer);
            fs::rename(pointer, current);
        } else fs::remove(current);
        throw;
    }
    std::cout << "Installed native Gradient at " << current << "\n"
              << "CLI: " << current / "bin/ai-hider" << "\n";
    if (!options.has("--no-register"))
        std::cout << "Registered for extension " << id << ". Reload the updated extension, then toggle On.\n";
    std::cout << "Chrome starts the stdio host on demand. No Python or persistent server is needed.\n"
              << "Marking threshold is experimental; <=1% browsing false positives are not guaranteed.\n";
}
bool present(const fs::path& path) {
    return fs::symlink_status(path).type() != fs::file_type::not_found;
}
void uninstall_conflict(const std::string& message) {
    throw Error("uninstall_conflict", message + " Nothing has been removed.");
}
void plain_directory(const fs::path& path) {
    if (present(path) && fs::symlink_status(path).type() != fs::file_type::directory)
        uninstall_conflict("Expected a real directory, not a redirected path: " + path.string() + ".");
}
bool contains_path(const fs::path& parent, const fs::path& child) {
    auto relative = child.lexically_relative(parent);
    return !relative.empty() && *relative.begin() != "..";
}
struct Removal {
    fs::path release;
    std::set<fs::path> files;
    std::set<fs::path> directories;
};
Removal validate_release(const fs::path& release) {
    plain_directory(release);
    const auto metadata = release / "install.json";
    if (fs::symlink_status(metadata).type() != fs::file_type::regular)
        uninstall_conflict("Release ownership metadata is missing or redirected: " + release.string() + ".");
    auto config = read_json(metadata);
    if (!config.is_object() || config.value("format", Json()) != 1 ||
        (config.value("version", Json()) != "0.2.0" && config.value("version", Json()) != "0.3.0") ||
        config.value("model", Json()) != model_id || config.value("revision", Json()) != revision ||
        config.value("policy", Json()) != policy_id || config.value("flag_threshold", Json()) != flag_threshold ||
        config.value("experimental", Json()) != true ||
        !config.value("extension_id", Json()).is_string() ||
        (config.value("source", Json()) != "verified-packed-export" &&
         config.value("source", Json()) != "verified-fp32-native-quantization"))
        uninstall_conflict("Unrecognized native installation metadata: " + release.string() + ".");
    for (const auto* field : {"weights_sha256", "tokenizer_sha256", "binary_sha256", "mlx_sha256", "metal_sha256"}) {
        auto value = config.value(field, Json());
        if (!value.is_string() || value.get<std::string>().size() != 64 ||
            value.get<std::string>().find_first_not_of("0123456789abcdef") != std::string::npos)
            uninstall_conflict("Invalid installation digest: " + release.string() + ".");
    }
    const std::string expected = config["version"].get<std::string>() + "-" + text_sha256(config.dump()).substr(0, 20);
    if (release.filename() != expected)
        uninstall_conflict("Release name does not match its native ownership metadata: " + release.string() + ".");
    Removal removal{release, {
        "bin/ai-hider", "bin/ai-hider-host", "lib/libmlx.dylib", "lib/mlx.metallib",
        "models/packed.safetensors", "models/tokenizer.json",
    }, {"bin", "lib", "models", "share", "share/licenses"}};
    if (config.contains("license_files")) {
        if (!config["license_files"].is_array())
            uninstall_conflict("Invalid license inventory: " + release.string() + ".");
        for (const auto& value : config["license_files"]) {
            if (!value.is_string()) uninstall_conflict("Invalid license inventory.");
            fs::path file(value.get<std::string>());
            if (file.is_absolute() || file != file.lexically_normal() ||
                !contains_path("share/licenses", file) || file == "share/licenses")
                uninstall_conflict("Unsafe license inventory path.");
            removal.files.insert(file);
            for (auto parent = file.parent_path(); !parent.empty(); parent = parent.parent_path())
                removal.directories.insert(parent);
        }
    }
    // Never follow a release symlink, including one hidden beneath an unknown directory.
    for (const auto& entry : fs::recursive_directory_iterator(release)) {
        const auto relative = entry.path().lexically_relative(release);
        auto status = entry.symlink_status();
        if (fs::is_symlink(status)) {
            if (relative != "bin/ai-hider-host" || fs::read_symlink(entry.path()) != "ai-hider")
                uninstall_conflict("Unexpected release symlink: " + entry.path().string() + ".");
        } else if ((removal.files.count(relative) || relative == "install.json") && !fs::is_regular_file(status)) {
            uninstall_conflict("An owned file has an unexpected type: " + entry.path().string() + ".");
        } else if (removal.directories.count(relative) && !fs::is_directory(status)) {
            uninstall_conflict("An owned directory has an unexpected type: " + entry.path().string() + ".");
        }
    }
    return removal;
}
void uninstall(const Options& options) {
    allow_options(options, {"--home", "--manifest-dir"});
    fs::path prefix = (options.has("--home") ? fs::absolute(options.get("--home")) :
        user_home() / "Library/Application Support/AI Hider").lexically_normal();
    fs::path manifest_dir = (options.has("--manifest-dir") ? fs::absolute(options.get("--manifest-dir")) :
        user_home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts").lexically_normal();
    if (prefix != prefix.root_path() && prefix.filename().empty()) prefix = prefix.parent_path();
    if (manifest_dir != manifest_dir.root_path() && manifest_dir.filename().empty()) manifest_dir = manifest_dir.parent_path();
    plain_directory(prefix);
    auto resolved = fs::weakly_canonical(prefix);
    auto source_root = fs::weakly_canonical(fs::path(__FILE__).parent_path().parent_path().parent_path());
    if (resolved == resolved.root_path() || contains_path(resolved, fs::weakly_canonical(user_home())) ||
        contains_path(resolved, fs::current_path()) || contains_path(resolved, source_root))
        uninstall_conflict("--home must be an installation prefix, not a home, root, or workspace directory.");
    if (present(prefix / "install.json"))
        uninstall_conflict("--home must name the installation prefix, not current or a release directory.");
    plain_directory(manifest_dir);
    auto registration = manifest_dir / (std::string(host_name) + ".json");
    if (!present(prefix)) {
        if (present(registration)) uninstall_conflict("A registration exists but the installation prefix is absent.");
        std::cout << "AI Hider is not installed at " << prefix << ". Nothing to remove.\n";
        return;
    }
    if (!present(prefix / "current") && !present(prefix / "releases") &&
        !present(prefix / ".install.lock") && !present(registration)) {
        std::cout << "No native installation found at " << prefix << "; existing files were left untouched.\n";
        return;
    }
    InstallLock lock(prefix);
    plain_directory(prefix / "releases");
    plain_directory(prefix / "models");
    std::vector<Removal> removals;
    if (present(prefix / "releases")) {
        for (const auto& entry : fs::directory_iterator(prefix / "releases")) {
            const auto name = entry.path().filename().string();
            if (entry.is_symlink()) uninstall_conflict("A release entry is a symlink: " + entry.path().string() + ".");
            if ((entry.is_directory() && present(entry.path() / "install.json")) ||
                name.rfind("0.2.0-", 0) == 0 || name.rfind("0.3.0-", 0) == 0)
                removals.push_back(validate_release(entry.path()));
            else std::cout << "Retaining unrecognized release entry: " << entry.path() << '\n';
        }
    }
    const auto current = prefix / "current";
    if (present(current)) {
        if (!fs::is_symlink(fs::symlink_status(current)))
            uninstall_conflict("The current installation pointer is not a symlink.");
        auto target = fs::read_symlink(current);
        if (target.is_absolute() || target != target.lexically_normal() || target.parent_path() != "releases" ||
            std::none_of(removals.begin(), removals.end(), [&](const Removal& item) { return item.release == prefix / target; }))
            uninstall_conflict("The current symlink does not point to a validated owned release.");
    }
    if (present(registration)) {
        if (fs::symlink_status(registration).type() != fs::file_type::regular)
            uninstall_conflict("The native host registration is not a regular file.");
        auto manifest = read_json(registration);
        if (!manifest.is_object() || manifest.value("name", Json()) != host_name ||
            manifest.value("type", Json()) != "stdio" || !manifest.value("path", Json()).is_string())
            uninstall_conflict("The native host registration belongs to another installation.");
        fs::path registered_path(manifest["path"].get<std::string>());
        const auto expected = prefix / "current/bin/ai-hider-host";
        if (!registered_path.is_absolute() || registered_path.lexically_normal() != expected ||
            fs::weakly_canonical(registered_path) != fs::weakly_canonical(expected) || removals.empty() || !present(current))
            uninstall_conflict("The native host registration does not match this installation prefix.");
    }
    // All ownership checks precede teardown. Keep the lock inode permanently: unlinking it
    // would let a concurrent installer acquire a different lock for the same prefix.
    if (present(registration)) fs::remove(registration);
    if (present(current)) fs::remove(current);
    for (const auto& removal : removals) {
        for (const auto& file : removal.files) fs::remove(removal.release / file);
        std::vector<fs::path> directories(removal.directories.begin(), removal.directories.end());
        std::sort(directories.begin(), directories.end(), [](const fs::path& a, const fs::path& b) {
            return std::distance(a.begin(), a.end()) > std::distance(b.begin(), b.end());
        });
        for (const auto& directory : directories) {
            auto path = removal.release / directory;
            if (present(path) && fs::is_empty(path)) fs::remove(path);
        }
        if (std::distance(fs::directory_iterator(removal.release), fs::directory_iterator()) == 1) {
            fs::remove(removal.release / "install.json");
            fs::remove(removal.release);
        } else std::cout << "Retaining unrecognized files or legacy license notices and ownership metadata in " << removal.release << '\n';
    }
    for (const auto* directory : {"releases", "models"}) {
        auto path = prefix / directory;
        if (present(path) && fs::is_empty(path)) fs::remove(path);
    }
    std::cout << "Uninstalled AI Hider native registration, activation, and owned runtime/model files from " << prefix << ".\n"
              << "Retained the prefix and .install.lock for concurrency safety; other files and caches are untouched.\n"
              << "Chrome extension/settings and shell configuration were not changed. Reload Chrome to close any running host.\n";
}
void verify(const Options& options) {
    allow_options(options, {"--model", "--fixtures", "--output", "--eager"});
    if (!options.has("--model") || !options.has("--fixtures"))
        throw Error("arguments", "verify requires --model and --fixtures.");
    background();
    auto fixtures = read_json(options.get("--fixtures"), 4 * 1024 * 1024);
    if (!fixtures.is_object() || !fixtures.contains("cases") || !fixtures["cases"].is_array() || fixtures["cases"].empty())
        throw Error("fixtures", "Expected nonempty reference cases.");
    auto started = std::chrono::steady_clock::now();
    Gradient model(options.get("--model"), !options.has("--eager"));
    double load = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    Json rows = Json::array();
    double logit_error = 0, score_error = 0;
    for (const auto& item : fixtures["cases"]) {
        auto ids = item.at("feed").at("input_ids").get<std::vector<std::vector<uint32_t>>>();
        auto mask = item.at("feed").at("attention_mask").get<std::vector<std::vector<uint32_t>>>();
        if (ids.size() != 1 || mask.size() != 1) throw Error("fixtures", "Only batch-one fixtures are supported.");
        auto before = std::chrono::steady_clock::now();
        double value = model.logit(ids[0], mask[0]), score = sigmoid(value);
        double elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - before).count();
        double expected = item.at("logit").get<double>();
        logit_error = std::max(logit_error, std::abs(value - expected));
        score_error = std::max(score_error, std::abs(score - sigmoid(expected)));
        rows.push_back({{"name", item.at("name")}, {"logit", value}, {"score", score}, {"elapsed_ms", elapsed}});
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    bool passed = logit_error <= 0.03 && score_error <= 0.002;
    auto memory = model.memory();
    Json result = {{"status", passed ? "complete" : "failed"}, {"cases", rows},
                   {"max_logit_error", logit_error}, {"max_score_error", score_error}, {"load_ms", load},
                   {"mlx_active_bytes", memory.active_bytes}, {"mlx_cache_bytes", memory.cache_bytes},
                   {"mlx_peak_bytes", memory.peak_bytes}, {"compiled", memory.compiled},
                   {"weights_sha256", sha256(options.get("--model"))},
                   {"fixtures_sha256", sha256(options.get("--fixtures"))}};
    if (options.has("--output")) {
        if (fs::exists(options.get("--output"))) throw Error("output_exists", "Preserve the existing verification receipt.");
        write_json(options.get("--output"), result);
    }
    std::cout << result.dump(2) << '\n';
    if (!passed) throw Error("fidelity_failed", "Native outputs failed numerical screening.");
}
void help() {
    std::cout <<
        "AI Hider 0.3.0 - native Gradient/MLX for Apple Silicon macOS15+\n\n"
        "ai-hider install [--extension-id ID] [--replace] [--model-dir DIR]\n"
        "                [--home DIR] [--manifest-dir DIR] [--no-register] [--download]\n"
        "  Install a self-contained native runtime and Chrome registration.\n"
        "  Without --model-dir, download pinned public weights and quantize natively.\n"
        "  Reuses the extension ID from an existing registration when available.\n\n"
        "ai-hider uninstall [--home DIR] [--manifest-dir DIR]\n"
        "  Remove only validated native releases and their matching Chrome registration.\n"
        "  --home is the install prefix, not current or a release directory.\n"
        "  Retains unknown files, caches, legacy license notices, and the installation lock.\n"
        "  Does not modify your Chrome extension/settings or shell configuration.\n\n"
        "ai-hider start [--home DIR]\n"
        "  Serve Chrome native messaging on stdin/stdout; Chrome normally launches this.\n"
        "  This is not an HTTP daemon and should not be backgrounded manually.\n\n"
        "ai-hider status [--home DIR]\n"
        "ai-hider scan [--home DIR] [--file FILE|-]\n"
        "  Score UTF-8 text from a file or stdin and print JSON; no page text is logged.\n\n"
        "ai-hider verify --model FILE --fixtures FILE [--output FILE] [--eager]\n"
        "ai-hider self-test\n";
}
}
}

int main(int argc, char** argv) {
    using namespace aihider;
    std::ios::sync_with_stdio(false);
    try {
        if (fs::path(argv[0]).filename() == "ai-hider-host" ||
            (argc > 1 && std::string(argv[1]).rfind("chrome-extension://", 0) == 0)) {
            auto home = default_home();
            if (argc > 1) {
                auto config = installed_config(home, false);
                if (std::string(argv[1]) != "chrome-extension://" + config.at("extension_id").get<std::string>() + "/")
                    throw Error("origin_mismatch", "Native host origin does not match its installation.");
            }
            return serve(home);
        }
        if (argc < 2 || std::string(argv[1]) == "--help" || std::string(argv[1]) == "help") { help(); return 0; }
        std::string command = argv[1];
        auto args = options(argc, argv, 2);
        if (command == "install") install(args);
        else if (command == "uninstall") uninstall(args);
        else if (command == "start") {
            allow_options(args, {"--home"});
            return serve(home_for(args));
        } else if (command == "status") {
            allow_options(args, {"--home"});
            auto config = installed_config(home_for(args), true);
            std::cout << Json{{"status", "installed"}, {"home", home_for(args).string()}, {"installation", config}}.dump(2) << '\n';
        } else if (command == "scan") {
            allow_options(args, {"--home", "--file"});
            background();
            std::string text;
            if (args.get("--file", "-") == "-") {
                char buffer[4096];
                while (std::cin) {
                    std::cin.read(buffer, sizeof(buffer));
                    text.append(buffer, static_cast<size_t>(std::cin.gcount()));
                    if (text.size() > 80000) throw Error("invalid_text", "Text exceeds the byte limit.");
                }
            } else text = read_text(args.get("--file"), 80000);
            Analyzer analyzer(home_for(args));
            std::cout << analyzer.analyze(text).dump(2) << '\n';
        } else if (command == "verify") verify(args);
        else if (command == "self-test") {
            allow_options(args, {});
            self_test();
            std::cout << "Native self-test passed.\n";
        } else throw Error("arguments", "Unknown command. Run ai-hider --help.");
        return 0;
    } catch (const Error& error) {
        std::cerr << "AI Hider [" << error.code << "]: " << error.what() << '\n';
        return 1;
    } catch (const std::exception& error) {
        if (argc > 1 && (std::string(argv[1]) == "install" || std::string(argv[1]) == "uninstall" ||
                         std::string(argv[1]) == "verify"))
            std::cerr << "AI Hider: " << error.what() << '\n';
        else std::cerr << "AI Hider: native operation failed; check arguments, assets and installation permissions.\n";
        return 1;
    }
}
