#pragma once
#include "support.hpp"
#include <optional>

namespace aihider {
bool path_present(const fs::path& path);
void require_plain_path(const fs::path& path, bool directory);
void validate_prefix(const fs::path& prefix);
std::optional<Json> setup_metadata(const fs::path& prefix);
void validate_setup(const fs::path& prefix, const Json& metadata, bool upgrading);
void remove_setup(const fs::path& prefix, const Json& metadata);
void recover_setup(const fs::path& prefix);

class SetupTransaction {
    fs::path prefix_, stage_, profile_;
    std::optional<Json> previous_;
    Json next_;
    std::string profile_before_, profile_after_;
    bool profile_existed_ = false;
    bool extension_old_ = false, extension_new_ = false, profile_changed_ = false;
public:
    SetupTransaction(const fs::path& prefix, const fs::path& stage,
                     const fs::path& extension, const std::string& shell,
                     const fs::path& manifest_dir);
    void publish();
    void journal(const std::optional<fs::path>& previous_current, const fs::path& next_current,
                 const fs::path& registration, const std::optional<Json>& previous_manifest,
                 const Json& next_manifest, bool registering);
    void rollback();
    void finish();
    void clear_journal();
};
}
