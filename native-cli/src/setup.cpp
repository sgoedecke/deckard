#include "setup.hpp"
#include <algorithm>
#include <fcntl.h>
#include <fstream>
#include <set>
#include <sys/stat.h>
#include <unistd.h>

namespace aihider {
namespace {
constexpr const char* begin_marker = "# >>> Deckard PATH >>>";
constexpr const char* end_marker = "# <<< Deckard PATH <<<";
void conflict(const std::string& message) { throw Error("setup_conflict", message + " No setup changes were made."); }
bool within(const fs::path& parent, const fs::path& child) {
    auto relative = child.lexically_relative(parent);
    return !relative.empty() && *relative.begin() != "..";
}
std::string quoted(const std::string& value) {
    std::string result = "'";
    for (char c : value) result += c == '\'' ? "'\\''" : std::string(1, c);
    return result + "'";
}
void safe_string(const std::string& value) {
    if (value.find_first_of("\r\n") != std::string::npos || value.find('\0') != std::string::npos)
        conflict("Setup paths cannot contain line breaks or NUL bytes.");
}
std::string strip_block(const std::string& contents, const std::string& block) {
    if (block.empty() || block.find(begin_marker) == std::string::npos || block.find(end_marker) == std::string::npos)
        conflict("Invalid PATH ownership metadata.");
    const auto offset = contents.find(block);
    if (offset == std::string::npos || contents.find(block, offset + block.size()) != std::string::npos)
        conflict("The owned PATH block was changed or removed; restore it before continuing.");
    auto result = contents;
    const auto end = offset + block.size();
    // The owned block may include the original file's missing final newline.
    // Keep a separator if the user subsequently appended another command.
    const bool separator = offset > 0 && end < contents.size() &&
        contents[offset - 1] != '\n' && contents[end] != '\n';
    result.replace(offset, block.size(), separator ? "\n" : "");
    if (result.find(begin_marker) != std::string::npos || result.find(end_marker) != std::string::npos)
        conflict("Conflicting Deckard PATH markers were found.");
    return result;
}
void atomic_text(const fs::path& path, const std::string& text) {
    require_plain_path(path, false);
    auto temporary = path.parent_path() / (".deckard-profile-" + std::to_string(getpid()));
    int descriptor = open(temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (descriptor < 0) throw Error("profile_write", "Cannot stage the shell profile.");
    try {
        struct stat previous {};
        if (path_present(path) && (stat(path.c_str(), &previous) || fchmod(descriptor, previous.st_mode & 0777)))
            throw Error("profile_write", "Cannot preserve shell profile permissions.");
        size_t offset = 0;
        while (offset < text.size()) {
            ssize_t count = write(descriptor, text.data() + offset, text.size() - offset);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) throw Error("profile_write", "Cannot write the shell profile.");
            offset += static_cast<size_t>(count);
        }
        if (fsync(descriptor)) throw Error("profile_write", "Cannot flush the shell profile.");
        int result = close(descriptor);
        descriptor = -1;
        if (result) throw Error("profile_write", "Cannot finish the shell profile.");
        fs::rename(temporary, path);
    } catch (...) {
        if (descriptor >= 0) close(descriptor);
        fs::remove(temporary);
        throw;
    }
}
void validate_inventory(const fs::path& prefix, const Json& files, bool upgrading) {
    if (!files.is_object()) conflict("Invalid extension ownership inventory.");
    require_plain_path(prefix / "extension", true);
    for (auto it = files.begin(); it != files.end(); ++it) {
        fs::path relative(it.key());
        if (relative.empty() || relative.is_absolute() || relative != relative.lexically_normal() ||
            !within("extension", relative) || relative == "extension" || !it.value().is_string() ||
            it.value().get<std::string>().size() != 64)
            conflict("Unsafe extension ownership inventory.");
        auto file = prefix / relative;
        require_plain_path(file, false);
        if (path_present(file) && sha256(file) != it.value().get<std::string>())
            conflict("An owned extension file has changed; preserve your edits before continuing.");
    }
    if (path_present(prefix / "extension")) {
        for (const auto& entry : fs::recursive_directory_iterator(prefix / "extension")) {
            if (entry.is_symlink()) conflict("The extension contains a redirected path.");
            if (!entry.is_directory() &&
                (entry.symlink_status().type() != fs::file_type::regular ||
                 (upgrading && !files.contains(entry.path().lexically_relative(prefix).generic_string()))))
                conflict("The extension contains unowned files; move them aside before upgrading.");
        }
    }
}
void path_command_conflict(const fs::path& prefix) {
    const char* environment = std::getenv("PATH");
    std::string paths = environment ? environment : "";
    size_t start = 0;
    do {
        auto end = paths.find(':', start);
        auto directory = paths.substr(start, end == std::string::npos ? end : end - start);
        auto candidate = fs::absolute(directory.empty() ? "." : directory) / "deckard";
        if (path_present(candidate) && fs::weakly_canonical(candidate) != fs::weakly_canonical(prefix / "current/bin/deckard"))
            conflict("Another deckard command exists on PATH. Resolve the conflict or choose --shell none.");
        if (end == std::string::npos) break;
        start = end + 1;
    } while (true);
}
}
bool path_present(const fs::path& path) {
    return fs::symlink_status(path).type() != fs::file_type::not_found;
}
void require_plain_path(const fs::path& path, bool directory) {
    auto absolute = fs::absolute(path).lexically_normal();
    fs::path current = absolute.root_path();
    for (const auto& part : absolute.relative_path()) {
        current /= part;
        if (!path_present(current)) continue;
        auto status = fs::symlink_status(current);
        if (current != absolute || directory) {
            if (status.type() != fs::file_type::directory) conflict("Setup requires real directories, not redirected paths.");
        } else {
            struct stat info {};
            if (status.type() != fs::file_type::regular || stat(current.c_str(), &info) || info.st_nlink != 1)
                conflict("Setup requires private regular files, not symlinks or hard links.");
        }
    }
}
void validate_prefix(const fs::path& prefix) {
    safe_string(prefix.string());
    if (prefix.string().find(':') != std::string::npos) conflict("The installation prefix cannot contain PATH separators (:).");
    require_plain_path(prefix, true);
    auto resolved = fs::weakly_canonical(prefix);
    if (resolved == resolved.root_path() || within(resolved, fs::weakly_canonical(user_home())) ||
        within(resolved, fs::weakly_canonical(fs::current_path())) || path_present(prefix / ".git"))
        conflict("--home must be a dedicated installation prefix, not a home, root, or workspace.");
    if (path_present(prefix / "install.json"))
        conflict("--home must name the prefix, not current or a release directory.");
}
std::optional<Json> setup_metadata(const fs::path& prefix) {
    if (!path_present(prefix / "setup.json")) return std::nullopt;
    require_plain_path(prefix / "setup.json", false);
    auto metadata = read_json(prefix / "setup.json");
    if (!metadata.is_object() || metadata.value("format", Json()) != 1 ||
        metadata.value("product", Json()) != "Deckard" ||
        metadata.value("prefix", Json()) != prefix.string() ||
        !metadata.value("manifest_dir", Json()).is_string() ||
        !metadata.value("profile", Json()).is_string() || !metadata.value("path_block", Json()).is_string() ||
        !metadata.value("profile_created", Json()).is_boolean() ||
        !metadata.value("extension_files", Json()).is_object())
        conflict("Unrecognized setup ownership metadata.");
    fs::path manifest_dir(metadata["manifest_dir"].get<std::string>());
    if (!manifest_dir.is_absolute() || manifest_dir != manifest_dir.lexically_normal())
        conflict("Invalid registered manifest directory.");
    return metadata;
}
void validate_setup(const fs::path& prefix, const Json& metadata, bool upgrading) {
    auto profile = fs::path(metadata.at("profile").get<std::string>());
    if (!profile.empty()) {
        if (profile != user_home() / ".zshrc" && profile != user_home() / ".bash_profile")
            conflict("The owned profile does not belong to this HOME.");
        require_plain_path(profile, false);
        strip_block(read_text(profile), metadata.at("path_block").get<std::string>());
    } else if (metadata.at("path_block") != "") conflict("Invalid empty profile ownership.");
    validate_inventory(prefix, metadata.at("extension_files"), upgrading);
}
SetupTransaction::SetupTransaction(const fs::path& prefix, const fs::path& stage,
                                   const fs::path& extension, const std::string& shell,
                                   const fs::path& manifest_dir) : prefix_(prefix), stage_(stage), previous_(setup_metadata(prefix)) {
    if (shell != "none" && shell != "zsh" && shell != "bash")
        throw Error("shell", "Choose --shell zsh, bash, or none. Only those shell profiles are supported.");
    const char* zdotdir = std::getenv("ZDOTDIR");
    if (shell == "zsh" && zdotdir && *zdotdir && fs::path(zdotdir) != user_home())
        throw Error("shell", "Custom ZDOTDIR is not managed. Choose --shell none and configure PATH manually.");
    if (previous_) {
        validate_setup(prefix_, *previous_, true);
        if ((*previous_)["manifest_dir"] != manifest_dir.string())
            conflict("This installation uses a different manifest directory.");
    } else if (path_present(prefix_ / "extension")) conflict("An unowned extension directory already exists.");
    profile_ = shell == "none" ? fs::path() : user_home() / (shell == "zsh" ? ".zshrc" : ".bash_profile");
    if (previous_ && (*previous_)["profile"] != profile_.string())
        conflict("Changing the managed shell requires uninstalling first.");
    next_ = {{"format", 1}, {"product", "Deckard"}, {"prefix", prefix_.string()},
             {"manifest_dir", manifest_dir.string()}, {"profile", profile_.string()},
             {"path_block", ""}, {"profile_created", false}, {"extension_files", Json::object()},
             {"transaction_id", stage_.filename().string()}};
    if (!profile_.empty()) {
        path_command_conflict(prefix_);
        require_plain_path(profile_, false);
        profile_existed_ = path_present(profile_);
        profile_before_ = profile_existed_ ? read_text(profile_) : "";
        auto original = previous_ ? strip_block(profile_before_, (*previous_)["path_block"]) : profile_before_;
        if (original.find(begin_marker) != std::string::npos || original.find(end_marker) != std::string::npos)
            conflict("An unowned Deckard PATH block already exists.");
        const auto bin = (prefix_ / "current/bin").string();
        auto block = (original.empty() || original.back() == '\n' ? std::string() : "\n") +
            begin_marker + "\ncase \":${PATH-}:\" in\n  *" + quoted(":" + bin + ":") +
            "*) ;;\n  *) export PATH=" + quoted(bin) + ":\"${PATH-}\" ;;\nesac\n" + end_marker + "\n";
        profile_after_ = original + block;
        next_["path_block"] = block;
        next_["profile_created"] = previous_ ? (*previous_)["profile_created"] : Json(!profile_existed_);
    }
    if (!extension.empty()) {
        if (!fs::is_directory(extension)) throw Error("missing_extension", "Pass --extension-dir with the packaged extension.");
        auto manifest = read_json(extension / "manifest.json");
        if (manifest.value("name", Json()) != "Deckard" || !manifest.value("key", Json()).is_string())
            throw Error("invalid_extension", "The Deckard extension must contain its stable public key.");
        fs::create_directory(stage_ / "extension");
        for (const auto& entry : fs::recursive_directory_iterator(extension)) {
            if (entry.is_symlink()) throw Error("invalid_extension", "Packaged extension symlinks are not permitted.");
            auto relative = entry.path().lexically_relative(extension);
            auto destination = stage_ / "extension" / relative;
            if (entry.is_directory()) fs::create_directory(destination);
            else if (entry.is_regular_file()) {
                fs::copy_file(entry.path(), destination);
                next_["extension_files"][(fs::path("extension") / relative).generic_string()] = sha256(destination);
            } else throw Error("invalid_extension", "The extension must contain only ordinary files.");
        }
    } else if (previous_ && !(*previous_)["extension_files"].empty())
        conflict("An installed extension cannot be dropped during upgrade; uninstall first.");
    write_json(stage_ / "setup.json", next_);
}
void SetupTransaction::publish() {
    if (previous_) validate_setup(prefix_, *previous_, true);
    if (!profile_.empty() && (path_present(profile_) != profile_existed_ ||
        (profile_existed_ && read_text(profile_) != profile_before_)))
        conflict("The shell profile changed while installation was being prepared.");
    if (path_present(prefix_ / "extension")) {
        fs::rename(prefix_ / "extension", stage_ / "previous-extension");
        extension_old_ = true;
    }
    if (path_present(stage_ / "extension")) {
        fs::rename(stage_ / "extension", prefix_ / "extension");
        extension_new_ = true;
    }
    if (!profile_.empty() && profile_before_ != profile_after_) {
        atomic_text(profile_, profile_after_);
        profile_changed_ = true;
    }
}
void SetupTransaction::journal(const std::optional<fs::path>& previous_current, const fs::path& next_current,
                               const fs::path& registration, const std::optional<Json>& previous_manifest,
                               const Json& next_manifest, bool registering) {
    Json journal = {{"format", 1}, {"product", "Deckard"}, {"prefix", prefix_.string()},
                    {"stage", stage_.filename().string()}, {"next_setup", next_},
                    {"previous_setup", previous_ ? *previous_ : Json()},
                    {"profile_before", profile_before_}, {"profile_after", profile_after_},
                    {"profile_existed", profile_existed_},
                    {"previous_current", previous_current ? Json(previous_current->generic_string()) : Json()},
                    {"next_current", next_current.generic_string()}, {"registration", registration.string()},
                    {"previous_manifest", previous_manifest ? *previous_manifest : Json()},
                    {"next_manifest", next_manifest}, {"registering", registering}};
    write_json(prefix_ / ".transaction.json", journal);
}
void SetupTransaction::finish() {
    fs::rename(stage_ / "setup.json", prefix_ / "setup.json");
}
void SetupTransaction::clear_journal() { fs::remove(prefix_ / ".transaction.json"); }
void SetupTransaction::rollback() {
    if (profile_changed_) {
        if (read_text(profile_) != profile_after_)
            throw Error("rollback_conflict", "Profile changed during rollback; review the installation before retrying.");
        if (profile_existed_) atomic_text(profile_, profile_before_);
        else fs::remove(profile_);
    }
    if (extension_new_) fs::rename(prefix_ / "extension", stage_ / "extension");
    if (extension_old_) fs::rename(stage_ / "previous-extension", prefix_ / "extension");
}
namespace {
void resume_uninstall_setup(const fs::path& prefix, const Json& journal) {
    auto metadata = journal.at("previous_setup");
    auto current = setup_metadata(prefix);
    if (!current || (*current != metadata && *current != journal.at("next_setup")))
        conflict("Setup changed during interrupted uninstall.");
    auto profile = fs::path(metadata.at("profile").get<std::string>());
    validate_inventory(prefix, metadata.at("extension_files"), false);
    if (!profile.empty()) {
        if (profile != user_home() / ".zshrc" && profile != user_home() / ".bash_profile")
            conflict("The uninstall profile does not belong to this HOME.");
        require_plain_path(profile, false);
        auto contents = path_present(profile) ? read_text(profile) : "";
        if (contents != journal.at("profile_before").get<std::string>() &&
            contents != journal.at("profile_after").get<std::string>())
            conflict("The profile changed during interrupted uninstall; recovery data was retained.");
    }
    if (!profile.empty()) {
        auto text = journal.at("profile_after").get<std::string>();
        if (text.empty() && metadata.at("profile_created") == true) fs::remove(profile);
        else atomic_text(profile, text);
    }
    std::set<fs::path> directories;
    for (auto it = metadata.at("extension_files").begin(); it != metadata.at("extension_files").end(); ++it) {
        fs::path relative(it.key());
        fs::remove(prefix / relative);
        for (auto directory = relative.parent_path(); !directory.empty(); directory = directory.parent_path())
            directories.insert(directory);
    }
    std::vector<fs::path> ordered(directories.begin(), directories.end());
    std::sort(ordered.begin(), ordered.end(), [](const auto& a, const auto& b) {
        return std::distance(a.begin(), a.end()) > std::distance(b.begin(), b.end());
    });
    for (const auto& directory : ordered)
        if (path_present(prefix / directory) && fs::is_empty(prefix / directory)) fs::remove(prefix / directory);
    write_json(prefix / "setup.json", journal.at("next_setup"));
    fs::remove(prefix / ".transaction.json");
}
}
void remove_setup(const fs::path& prefix, const Json& metadata) {
    if (metadata.value("uninstalling", false)) return;
    auto next = metadata;
    next["profile"] = "";
    next["path_block"] = "";
    next["profile_created"] = false;
    next["extension_files"] = Json::object();
    next["uninstalling"] = true;
    auto profile = fs::path(metadata.at("profile").get<std::string>());
    auto before = profile.empty() ? "" : read_text(profile);
    auto after = profile.empty() ? "" : strip_block(before, metadata.at("path_block").get<std::string>());
    Json journal = {{"format", 1}, {"product", "Deckard"}, {"prefix", prefix.string()},
                    {"operation", "uninstall"}, {"previous_setup", metadata}, {"next_setup", next},
                    {"profile_before", before}, {"profile_after", after}};
    write_json(prefix / ".transaction.json", journal);
    resume_uninstall_setup(prefix, journal);
}
void recover_setup(const fs::path& prefix) {
    auto journal_path = prefix / ".transaction.json";
    if (!path_present(journal_path)) return;
    require_plain_path(journal_path, false);
    auto journal = read_json(journal_path, 4 * 1024 * 1024);
    if (!journal.is_object() || journal.value("format", Json()) != 1 ||
        journal.value("product", Json()) != "Deckard" || journal.value("prefix", Json()) != prefix.string() ||
        !journal.value("next_setup", Json()).is_object())
        conflict("Unrecognized interrupted installation journal.");
    if (journal.value("operation", Json()) == "uninstall") {
        resume_uninstall_setup(prefix, journal);
        return;
    }
    if (!journal.value("stage", Json()).is_string()) conflict("Interrupted installation stage is missing.");
    fs::path stage_name(journal["stage"].get<std::string>());
    if (stage_name != stage_name.filename() || stage_name.string().rfind(".stage-", 0) != 0)
        conflict("Unsafe interrupted installation stage.");
    auto stage = prefix / stage_name;
    require_plain_path(stage, true);
    if (!path_present(stage)) conflict("Interrupted installation recovery files are missing.");
    auto next = journal.at("next_setup");
    auto previous = journal.at("previous_setup");
    auto current = prefix / "current";
    fs::path target(journal.at("next_current").get<std::string>());
    auto previous_target = journal.at("previous_current");
    auto valid_target = [](const fs::path& path) {
        return !path.is_absolute() && path == path.lexically_normal() && path.parent_path() == "releases";
    };
    if (!valid_target(target) || (!previous_target.is_null() &&
        (!previous_target.is_string() || !valid_target(previous_target.get<std::string>()))))
        conflict("Unsafe interrupted activation pointer.");
    if (path_present(current) && (!fs::is_symlink(current) ||
        (fs::read_symlink(current) != target &&
         (previous_target.is_null() || fs::read_symlink(current) != previous_target.get<std::string>()))))
        conflict("Activation changed since installation was interrupted.");
    fs::path registration(journal.at("registration").get<std::string>());
    if (registration != fs::path(next.at("manifest_dir").get<std::string>()) / (std::string(host_name) + ".json"))
        conflict("Unsafe interrupted registration path.");
    require_plain_path(registration, false);
    const bool registering = journal.at("registering").get<bool>();
    auto old_manifest = journal.at("previous_manifest");
    auto new_manifest = journal.at("next_manifest");
    auto actual_manifest = path_present(registration) ? read_json(registration) : Json();
    if (registering && actual_manifest != old_manifest && actual_manifest != new_manifest)
        conflict("Registration changed since installation was interrupted.");
    auto actual_setup = setup_metadata(prefix);
    const bool committed = actual_setup && *actual_setup == next &&
        path_present(current) && fs::read_symlink(current) == target &&
        (!registering || actual_manifest == new_manifest);
    if (committed) validate_setup(prefix, next, true);
    if (!committed) {
        if ((actual_setup ? *actual_setup : Json()) != previous)
            conflict("Setup metadata changed since installation was interrupted.");
        auto profile = fs::path(next.at("profile").get<std::string>());
        if (!profile.empty()) {
            if (profile != user_home() / ".zshrc" && profile != user_home() / ".bash_profile")
                conflict("Interrupted profile does not belong to this HOME.");
            require_plain_path(profile, false);
            auto contents = path_present(profile) ? read_text(profile) : "";
            const auto before = journal.at("profile_before").get<std::string>();
            const auto after = journal.at("profile_after").get<std::string>();
            if (contents != before && contents != after)
                conflict("Profile changed since installation was interrupted; recovery files were retained.");
        }
        const bool had_extension = !previous.is_null() && !previous.at("extension_files").empty();
        const bool swapped_old = path_present(stage / "previous-extension");
        if (swapped_old) {
            require_plain_path(stage / "previous-extension", true);
            // Validate the backup inventory without trusting an arbitrary filesystem target.
            auto backup = stage / "previous-extension";
            for (auto it = previous.at("extension_files").begin(); it != previous.at("extension_files").end(); ++it) {
                auto relative = fs::path(it.key()).lexically_relative("extension");
                if (relative.empty() || *relative.begin() == ".." || relative.is_absolute())
                    conflict("Unsafe interrupted extension backup.");
                require_plain_path(backup / relative, false);
                require_hash(backup / relative, it.value().get<std::string>());
            }
            for (const auto& entry : fs::recursive_directory_iterator(backup)) {
                if (entry.is_symlink() || (!entry.is_directory() &&
                    !previous.at("extension_files").contains(
                        (fs::path("extension") / entry.path().lexically_relative(backup)).generic_string())))
                    conflict("Interrupted extension backup contains unowned files.");
            }
        }
        const bool published_extension = path_present(prefix / "extension") && (swapped_old || !had_extension);
        if (published_extension) validate_inventory(prefix, next.at("extension_files"), true);
        else if (had_extension && !swapped_old) validate_inventory(prefix, previous.at("extension_files"), true);
        if (published_extension && path_present(stage / "extension"))
            conflict("Interrupted extension stage is inconsistent.");
        if (!profile.empty()) {
            const auto before = journal.at("profile_before").get<std::string>();
            if (journal.at("profile_existed") == true) atomic_text(profile, before);
            else if (path_present(profile)) fs::remove(profile);
        }
        if (published_extension) {
            fs::rename(prefix / "extension", stage / "extension");
        }
        if (swapped_old) fs::rename(stage / "previous-extension", prefix / "extension");
        if (path_present(current) && (previous_target.is_null() || fs::read_symlink(current) != previous_target.get<std::string>())) {
            if (previous_target.is_null()) fs::remove(current);
            else {
                auto pointer = stage / "restore-current";
                if (path_present(pointer)) {
                    if (!fs::is_symlink(pointer) || fs::read_symlink(pointer) != previous_target.get<std::string>())
                        conflict("The staged recovery pointer has changed.");
                } else fs::create_symlink(previous_target.get<std::string>(), pointer);
                fs::rename(pointer, current);
            }
        }
        if (registering && actual_manifest != old_manifest) {
            if (old_manifest.is_null()) fs::remove(registration);
            else write_json(registration, old_manifest);
        }
    }
    fs::remove(journal_path);
    fs::remove_all(stage);
}
}
