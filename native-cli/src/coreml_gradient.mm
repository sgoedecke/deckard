#include "coreml_gradient.hpp"
#include "support.hpp"

#import <CoreML/CoreML.h>
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstring>
#include <fcntl.h>
#include <mutex>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <unistd.h>

namespace aihider {
namespace {
constexpr size_t sequence_length = 512;
constexpr uint32_t vocabulary = 128100;

[[noreturn]] void cache_error(const fs::path& entry, const std::string& reason) {
    throw Error("coreml_cache_invalid", reason + " Cache entry: " + entry.string() +
                ". Quit Deckard hosts, remove only this entry, then retry to compile the verified model.");
}

[[noreturn]] void coreml_error(const std::string& context, NSError* error) {
    throw Error("coreml_failed", context + ": " +
                (error.localizedDescription.UTF8String ?: "Core ML returned no result"));
}

NSURL* file_url(const fs::path& path) {
    NSString* name = [[NSString alloc] initWithBytes:path.c_str() length:path.native().size()
                                           encoding:NSUTF8StringEncoding];
    if (!name) throw Error("invalid_path", "Core ML paths must be valid UTF-8.");
    return [NSURL fileURLWithPath:name];
}

// lstat every component: neither source nor cache may traverse a symlink.
fs::path ordinary_directory(const fs::path& input, bool create) {
    fs::path absolute = fs::absolute(input);
    for (const auto& component : absolute)
        if (component == "..") throw Error("invalid_path", "Core ML paths cannot contain '..'.");
    absolute = absolute.lexically_normal();
    fs::path current;
    for (const auto& component : absolute) {
        current /= component;
        struct stat status {};
        if (lstat(current.c_str(), &status) != 0) {
            if (!create || errno != ENOENT)
                throw Error("invalid_path", "Cannot inspect Core ML directory: " + current.string());
            if (mkdir(current.c_str(), 0700) != 0 && errno != EEXIST)
                throw Error("invalid_path", "Cannot create Core ML cache directory: " + current.string());
            if (lstat(current.c_str(), &status) != 0)
                throw Error("invalid_path", "Cannot inspect Core ML cache directory: " + current.string());
        }
        if (!S_ISDIR(status.st_mode))
            throw Error("invalid_path", "Core ML directory is not an ordinary directory: " + current.string());
    }
    return absolute;
}

void private_entry(const fs::path& path, bool directory, const fs::path& entry) {
    struct stat status {};
    if (lstat(path.c_str(), &status) != 0 ||
        (directory ? !S_ISDIR(status.st_mode) : !S_ISREG(status.st_mode)) ||
        status.st_uid != geteuid() || (status.st_mode & 0022) ||
        (!directory && status.st_nlink != 1))
        cache_error(entry, "Cache contains a missing, unowned, writable, linked, or special file: " + path.string());
}

class CacheLock {
 public:
    explicit CacheLock(const fs::path& path) {
        fd_ = open(path.c_str(), O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
        if (fd_ < 0) cache_error(path, "Cannot open the compilation cache lock");
        struct stat status {};
        if (fstat(fd_, &status) != 0 || !S_ISREG(status.st_mode) ||
            status.st_uid != geteuid() || (status.st_mode & 0022) || status.st_nlink != 1) {
            close(fd_);
            cache_error(path, "Unsafe compilation cache lock");
        }
        int result;
        do { result = flock(fd_, LOCK_EX); } while (result != 0 && errno == EINTR);
        if (result != 0) {
            close(fd_);
            cache_error(path, "Cannot lock the compilation cache");
        }
    }
    ~CacheLock() { close(fd_); }
    CacheLock(const CacheLock&) = delete;
    CacheLock& operator=(const CacheLock&) = delete;
 private:
    int fd_ = -1;
};

std::string system_string(const char* name) {
    size_t size = 0;
    if (sysctlbyname(name, nullptr, &size, nullptr, 0) != 0 || !size || size > 4096)
        throw Error("coreml_system_identity", std::string("Cannot read ") + name);
    std::string value(size, '\0');
    if (sysctlbyname(name, value.data(), &size, nullptr, 0) != 0)
        throw Error("coreml_system_identity", std::string("Cannot read ") + name);
    value.resize(size);
    while (!value.empty() && value.back() == '\0') value.pop_back();
    if (value.empty()) throw Error("coreml_system_identity", std::string("Empty ") + name);
    return value;
}

uint32_t cpu_family() {
    uint32_t value = 0;
    size_t size = sizeof(value);
    if (sysctlbyname("hw.cpufamily", &value, &size, nullptr, 0) != 0 || size != sizeof(value))
        throw Error("coreml_system_identity", "Cannot read hw.cpufamily.");
    return value;
}

Json cache_identity() {
    return {{"format", 1}, {"artifact", model_assets_id()}, {"os_build", system_string("kern.osversion")},
            {"hardware_model", system_string("hw.model")}, {"architecture", system_string("hw.machine")},
            {"cpu_family", cpu_family()}, {"compute_units", "cpu-and-neural-engine"}};
}

Json inventory(const fs::path& directory, const fs::path& entry) {
    private_entry(directory, true, entry);
    Json files = Json::object();
    for (const auto& item : fs::recursive_directory_iterator(directory)) {
        auto status = item.symlink_status();
        bool is_directory = fs::is_directory(status);
        private_entry(item.path(), is_directory, entry);
        std::string relative = item.path().lexically_relative(directory).generic_string();
        files[relative] = is_directory ? Json{{"directory", true}} :
            Json{{"size", fs::file_size(item.path())}, {"sha256", sha256(item.path())}};
    }
    if (files.empty()) cache_error(entry, "The compiled model is empty");
    return files;
}

bool cleanup_staging(const fs::path& staging, const struct stat& created) noexcept {
    try {
        struct stat current {};
        if (lstat(staging.c_str(), &current) != 0 ||
            current.st_dev != created.st_dev || current.st_ino != created.st_ino) return false;
        private_entry(staging, true, staging);
        for (const auto& item : fs::recursive_directory_iterator(staging))
            private_entry(item.path(), fs::is_directory(item.symlink_status()), staging);
        if (lstat(staging.c_str(), &current) != 0 ||
            current.st_dev != created.st_dev || current.st_ino != created.st_ino) return false;
        fs::remove_all(staging);
        return true;
    } catch (...) {
        return false;
    }
}

bool fixed_shape(MLMultiArrayConstraint* constraint, NSArray<NSNumber*>* expected) {
    if (![constraint.shape isEqualToArray:expected]) return false;
    MLMultiArrayShapeConstraint* allowed = constraint.shapeConstraint;
    switch (allowed.type) {
        case MLMultiArrayShapeConstraintTypeUnspecified: return true;
        case MLMultiArrayShapeConstraintTypeEnumerated:
            if (!allowed.enumeratedShapes.count) return false;
            for (NSArray<NSNumber*>* shape in allowed.enumeratedShapes)
                if (![shape isEqualToArray:expected]) return false;
            return true;
        case MLMultiArrayShapeConstraintTypeRange:
            if (allowed.sizeRangeForDimension.count != expected.count) return false;
            for (NSUInteger i = 0; i < expected.count; ++i) {
                NSRange range = allowed.sizeRangeForDimension[i].rangeValue;
                if (range.location != expected[i].unsignedIntegerValue || range.length != 1) return false;
            }
            return true;
    }
    return false;
}

void validate_features(NSDictionary<NSString*, MLFeatureDescription*>* features, bool input) {
    NSArray<NSString*>* names = input ? @[@"input_ids", @"attention_mask"] : @[@"logit"];
    if (features.count != names.count)
        throw Error("coreml_model_contract", "Unexpected Core ML feature count.");
    for (NSString* name in names) {
        MLFeatureDescription* feature = features[name];
        MLMultiArrayDataType type = [name isEqualToString:@"input_ids"] ?
            MLMultiArrayDataTypeInt32 : MLMultiArrayDataTypeFloat32;
        NSArray<NSNumber*>* shape = input ? @[@1, @512] : @[@1, @1];
        if (!feature || feature.type != MLFeatureTypeMultiArray || feature.optional ||
            feature.multiArrayConstraint.dataType != type ||
            !fixed_shape(feature.multiArrayConstraint, shape))
            throw Error("coreml_model_contract", std::string("Invalid Core ML feature: ") + name.UTF8String);
    }
}

MLModel* load_model(const fs::path& path) {
    MLModelConfiguration* configuration = [[MLModelConfiguration alloc] init];
    configuration.computeUnits = MLComputeUnitsCPUAndNeuralEngine;
    NSError* error = nil;
    MLModel* model = [MLModel modelWithContentsOfURL:file_url(path) configuration:configuration error:&error];
    if (!model) coreml_error("Load the compiled CPU/Neural Engine model", error);
    validate_features(model.modelDescription.inputDescriptionsByName, true);
    validate_features(model.modelDescription.outputDescriptionsByName, false);
    return model;
}

NSURL* compile_model(const fs::path& package) {
    dispatch_semaphore_t ready = dispatch_semaphore_create(0);
    __block NSURL* result = nil;
    __block NSError* error = nil;
    [MLModel compileModelAtURL:file_url(package)
            completionHandler:^(NSURL* compiled, NSError* failure) {
        result = compiled;
        error = failure;
        dispatch_semaphore_signal(ready);
    }];
    dispatch_semaphore_wait(ready, DISPATCH_TIME_FOREVER);
    if (!result) coreml_error("Compile the verified Core ML package", error);
    return result;
}

MLModel* cached_model(const fs::path& package, const fs::path& cache) {
    fs::path root = ordinary_directory(cache, true);
    struct stat root_status {};
    if (lstat(root.c_str(), &root_status) != 0 || !S_ISDIR(root_status.st_mode) ||
        root_status.st_uid != geteuid() || (root_status.st_mode & 0022))
        throw Error("coreml_cache_invalid", "Core ML cache root must be an ordinary directory owned by "
                    "the current user and not writable by other users: " + root.string() +
                    ". Correct its ownership/permissions or select a different cache directory.");
    Json identity = cache_identity();
    std::string key = text_sha256(identity.dump());
    fs::path entry = root / key;
    CacheLock lock(root / (key + ".lock"));
    std::error_code ec;
    auto status = fs::symlink_status(entry, ec);
    if (ec && ec != std::errc::no_such_file_or_directory)
        cache_error(entry, "Cannot inspect the compilation cache");
    if (fs::exists(status)) {
        try {
            private_entry(entry, true, entry);
            private_entry(entry / "receipt.json", false, entry);
            size_t children = 0;
            for (const auto& unused : fs::directory_iterator(entry)) { (void)unused; ++children; }
            Json receipt = read_json(entry / "receipt.json", 16 * 1024 * 1024);
            if (children != 2 || !receipt.is_object() || receipt.size() != 2 ||
                receipt.at("identity") != identity ||
                receipt.at("compiled") != inventory(entry / "model.mlmodelc", entry))
                cache_error(entry, "Compilation cache integrity check failed");
            return load_model(entry / "model.mlmodelc");
        } catch (const std::exception& error) {
            cache_error(entry, std::string("Cannot reuse the compiled model: ") + error.what());
        }
    }

    // Only a complete directory is published. Clean ordinary failures using the
    // exact directory we created; interrupted processes leave unused staging.
    fs::path staging = root / (key + ".building-" + NSUUID.UUID.UUIDString.UTF8String);
    if (mkdir(staging.c_str(), 0700) != 0) cache_error(staging, "Cannot create compilation staging directory");
    struct stat created {};
    if (lstat(staging.c_str(), &created) != 0) cache_error(staging, "Cannot inspect new compilation staging directory");
    try {
        NSURL* compiled = compile_model(package);
        NSError* error = nil;
        if (![NSFileManager.defaultManager copyItemAtURL:compiled
                                                  toURL:file_url(staging / "model.mlmodelc") error:&error])
            coreml_error("Persist the compiled model", error);
        // Validate before publication, but load the resident model from its final
        // location so Core ML's lazy resource reads never retain a staging path.
        @autoreleasepool { (void)load_model(staging / "model.mlmodelc"); }
        Json receipt = {{"identity", identity}, {"compiled", inventory(staging / "model.mlmodelc", staging)}};
        write_json(staging / "receipt.json", receipt);
        private_entry(staging / "receipt.json", false, staging);
        fs::rename(staging, entry);
    } catch (const std::exception& error) {
        if (cleanup_staging(staging, created))
            throw Error("coreml_compile_failed", std::string("Core ML compilation was not published; "
                        "its unpublished staging data was removed: ") + error.what());
        cache_error(staging, std::string("Core ML compilation was not published; unsafe or inaccessible "
                    "staging data was left untouched: ") + error.what());
    }
    try {
        return load_model(entry / "model.mlmodelc");
    } catch (const std::exception& error) {
        cache_error(entry, std::string("Cannot load the published model: ") + error.what());
    }
}

MLMultiArray* new_array(MLMultiArrayDataType type) {
    NSError* error = nil;
    MLMultiArray* array = [[MLMultiArray alloc] initWithShape:@[@1, @512] dataType:type error:&error];
    if (!array) coreml_error("Allocate Core ML input", error);
    return array;
}

void validate_input(const std::vector<uint32_t>& ids, const std::vector<uint32_t>& mask) {
    if (ids.empty() || ids.size() > sequence_length || ids.size() != mask.size() ||
        std::any_of(ids.begin(), ids.end(), [](uint32_t id) { return id >= vocabulary; }) ||
        std::any_of(mask.begin(), mask.end(), [](uint32_t value) { return value > 1; }) ||
        std::none_of(mask.begin(), mask.end(), [](uint32_t value) { return value == 1; }))
        throw Error("invalid_model_input", "Core ML requires 1..512 in-vocabulary token IDs and a matching, nonempty binary mask.");
}

void fill_inputs(const std::vector<uint32_t>& ids, const std::vector<uint32_t>& mask,
                 MLMultiArray* tokens, MLMultiArray* attention) {
    for (size_t i = 0; i < sequence_length; ++i) {
        NSArray<NSNumber*>* index = @[@0, @(i)];
        tokens[index] = @(i < ids.size() ? ids[i] : 0);
        attention[index] = @(i < mask.size() ? mask[i] : 0);
    }
}
}

struct CoreMLGradient::Impl {
    MLModel* model = nil;
    std::mutex prediction_mutex;
};

CoreMLGradient::CoreMLGradient(const fs::path& model_directory, const fs::path& cache_directory)
    : impl_(std::make_unique<Impl>()) {
    @autoreleasepool {
        fs::path source = ordinary_directory(model_directory, false);
        // Also verify for callers other than Analyzer, before looking at a cache.
        verify_model_assets(source);
        const Json& assets = model_assets();
        if (assets.at("sequence_length") != sequence_length || assets.at("model_package") != "model.mlpackage" ||
            assets.at("precision") != "fp16" || assets.at("runtime") != runtime_id)
            throw Error("coreml_model_contract", "Unsupported pinned Core ML artifact contract.");
        impl_->model = cached_model(source / "model.mlpackage", cache_directory);
    }
}

CoreMLGradient::~CoreMLGradient() {
    @autoreleasepool { impl_.reset(); }
}

double CoreMLGradient::logit(const std::vector<uint32_t>& ids, const std::vector<uint32_t>& mask) {
    validate_input(ids, mask);
    std::lock_guard<std::mutex> guard(impl_->prediction_mutex);
    @autoreleasepool {
        MLMultiArray* tokens = new_array(MLMultiArrayDataTypeInt32);
        MLMultiArray* attention = new_array(MLMultiArrayDataTypeFloat32);
        fill_inputs(ids, mask, tokens, attention);
        NSError* error = nil;
        MLDictionaryFeatureProvider* features = [[MLDictionaryFeatureProvider alloc]
            initWithDictionary:@{@"input_ids": tokens, @"attention_mask": attention} error:&error];
        if (!features) coreml_error("Create Core ML inputs", error);
        id<MLFeatureProvider> prediction = [impl_->model predictionFromFeatures:features error:&error];
        if (!prediction) coreml_error("Predict with CPU/Neural Engine", error);
        MLFeatureValue* value = [prediction featureValueForName:@"logit"];
        MLMultiArray* output = value.multiArrayValue;
        if (![prediction.featureNames isEqualToSet:[NSSet setWithObject:@"logit"]] ||
            value.type != MLFeatureTypeMultiArray || !output ||
            output.dataType != MLMultiArrayDataTypeFloat32 || ![output.shape isEqualToArray:@[@1, @1]])
            throw Error("coreml_model_contract", "Core ML returned an unexpected logit tensor.");
        double result = [output[@[@0, @0]] doubleValue];
        if (!std::isfinite(result)) throw Error("coreml_nonfinite_output", "Core ML returned a non-finite logit.");
        return result;
    }
}
}  // namespace aihider
