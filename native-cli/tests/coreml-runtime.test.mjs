import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const native = fileURLToPath(new URL("../", import.meta.url));
const dependencyCache = process.env.NATIVE_CACHE || path.join(native, "../cache/native-build");
const available = process.platform === "darwin" &&
  fs.existsSync(path.join(dependencyCache, "json/include/nlohmann/json.hpp"));

test("production Core ML target has no MLX or GPU configuration", () => {
  const cmake = fs.readFileSync(path.join(native, "CMakeLists.txt"), "utf8");
  const runtime = fs.readFileSync(path.join(native, "src/coreml_gradient.mm"), "utf8");
  const host = fs.readFileSync(path.join(native, "src/host.cpp"), "utf8");
  assert.doesNotMatch(cmake, /find_package\(MLX|src\/gradient\.cpp|libmlx|mlx\.metallib/);
  assert.match(cmake, /-fobjc-arc/);
  assert.match(cmake, /CMAKE_CONFIGURE_DEPENDS.*model-assets\.json/);
  assert.match(runtime, /configuration\.computeUnits = MLComputeUnitsCPUAndNeuralEngine;/);
  assert.doesNotMatch(runtime, /MLComputeUnitsAll|MLComputeUnitsCPUAndGPU|_ANE|dlsym|dlopen/);
  assert.match(host, /default_priority\(\)/);
  assert.doesNotMatch(host, /\bbackground\(\)/);
});

test("native tensor, cache integrity and source-verification contracts (no inference)", {
  skip: !available && "requires macOS and the existing native JSON dependency cache",
}, t => {
  fs.mkdirSync(path.join(native, "build"), { recursive: true });
  const root = fs.mkdtempSync(path.join(native, "build/coreml-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(native, "model-assets.json"), "utf8");
  const digest = createHash("sha256").update(source).digest("hex");
  fs.writeFileSync(path.join(root, "model_assets.hpp"),
    `namespace aihider { inline constexpr const char* model_assets_json = R"assets(${source})assets";
     inline constexpr const char* model_assets_sha256 = "${digest}"; }\n`);
  fs.writeFileSync(path.join(root, "contracts.mm"), String.raw`
#include "coreml_gradient.mm"
#include <fstream>
#include <iostream>
#include <functional>
#include <future>

@interface RuntimeTestShapeConstraint : NSObject
@property(nonatomic) MLMultiArrayShapeConstraintType type;
@property(nonatomic, strong) NSArray<NSValue*>* sizeRangeForDimension;
@property(nonatomic, strong) NSArray<NSArray<NSNumber*>*>* enumeratedShapes;
@end
@implementation RuntimeTestShapeConstraint
@end
@interface RuntimeTestArrayConstraint : NSObject
@property(nonatomic, strong) NSArray<NSNumber*>* shape;
@property(nonatomic, strong) RuntimeTestShapeConstraint* shapeConstraint;
@end
@implementation RuntimeTestArrayConstraint
@end

void require(bool value) { if (!value) throw std::runtime_error("contract failed"); }
void rejects(const std::function<void()>& action, const std::string& code) {
    try { action(); } catch (const aihider::Error& error) {
        require(error.code == code); return;
    }
    throw std::runtime_error("expected rejection: " + code);
}
int main(int argc, char** argv) {
    if (argc != 2) return 2;
    using namespace aihider;
    try { @autoreleasepool {
        fs::path root = argv[1];
        RuntimeTestArrayConstraint* feature = [[RuntimeTestArrayConstraint alloc] init];
        feature.shape = @[@1, @512];
        feature.shapeConstraint = [[RuntimeTestShapeConstraint alloc] init];
        feature.shapeConstraint.type = MLMultiArrayShapeConstraintTypeUnspecified;
        require(fixed_shape((MLMultiArrayConstraint*)feature, @[@1, @512]));
        feature.shapeConstraint.type = MLMultiArrayShapeConstraintTypeEnumerated;
        feature.shapeConstraint.enumeratedShapes = @[@[@1, @512]];
        require(fixed_shape((MLMultiArrayConstraint*)feature, @[@1, @512]));
        feature.shapeConstraint.enumeratedShapes = @[@[@1, @512], @[@2, @512]];
        require(!fixed_shape((MLMultiArrayConstraint*)feature, @[@1, @512]));
        feature.shapeConstraint.type = MLMultiArrayShapeConstraintTypeRange;
        feature.shapeConstraint.sizeRangeForDimension = @[
            [NSValue valueWithRange:NSMakeRange(1, 1)], [NSValue valueWithRange:NSMakeRange(512, 1)]];
        require(fixed_shape((MLMultiArrayConstraint*)feature, @[@1, @512]));
        feature.shapeConstraint.sizeRangeForDimension = @[
            [NSValue valueWithRange:NSMakeRange(1, 2)], [NSValue valueWithRange:NSMakeRange(512, 1)]];
        require(!fixed_shape((MLMultiArrayConstraint*)feature, @[@1, @512]));
        for (const auto& input : std::vector<std::pair<std::vector<uint32_t>, std::vector<uint32_t>>>{
                {{}, {}}, {{1}, {}}, {{128100}, {1}}, {{1}, {2}}, {{1}, {0}},
                {std::vector<uint32_t>(513, 1), std::vector<uint32_t>(513, 1)}})
            rejects([&] { validate_input(input.first, input.second); }, "invalid_model_input");
        validate_input({0, 128099, 2}, {1, 0, 1});
        validate_input(std::vector<uint32_t>(512, 1), std::vector<uint32_t>(512, 1));
        MLMultiArray* ids = new_array(MLMultiArrayDataTypeInt32);
        MLMultiArray* mask = new_array(MLMultiArrayDataTypeFloat32);
        fill_inputs({0, 128099, 2}, {1, 0, 1}, ids, mask);
        require([ids.shape isEqualToArray:@[@1, @512]] && [mask.shape isEqualToArray:@[@1, @512]]);
        for (size_t i = 0; i < 512; ++i) {
            require([ids[@[@0, @(i)]] unsignedIntValue] == (i == 1 ? 128099 : i == 2 ? 2 : 0));
            require([mask[@[@0, @(i)]] doubleValue] == (i == 0 || i == 2 ? 1.0 : 0.0));
        }
        auto tree = ordinary_directory(root / "compiled", true);
        std::ofstream(tree / "weights") << "verified bytes";
        auto first = inventory(tree, tree);
        require(first == inventory(tree, tree));
        std::ofstream(tree / "weights") << "corrupted bytes";
        require(first != inventory(tree, tree));
        fs::create_symlink(tree / "weights", tree / "link");
        rejects([&] { inventory(tree, tree); }, "coreml_cache_invalid");
        fs::remove(tree / "link");
        fs::create_hard_link(tree / "weights", tree / "hardlink");
        rejects([&] { inventory(tree, tree); }, "coreml_cache_invalid");
        fs::remove(tree / "hardlink");
        require(mkfifo((tree / "fifo").c_str(), 0600) == 0);
        rejects([&] { inventory(tree, tree); }, "coreml_cache_invalid");
        fs::remove(tree / "fifo");
        auto owned_stage = ordinary_directory(root / "owned-stage", true);
        std::ofstream(owned_stage / "partial") << "partial compilation";
        struct stat created {};
        require(lstat(owned_stage.c_str(), &created) == 0);
        require(cleanup_staging(owned_stage, created) && !fs::exists(owned_stage));
        auto replaced_stage = ordinary_directory(root / "replaced-stage", true);
        require(lstat(replaced_stage.c_str(), &created) == 0);
        fs::rename(replaced_stage, root / "original-stage");
        fs::create_directory(replaced_stage);
        require(!cleanup_staging(replaced_stage, created) && fs::exists(replaced_stage));
        auto unsafe_stage = ordinary_directory(root / "unsafe-stage", true);
        require(lstat(unsafe_stage.c_str(), &created) == 0);
        fs::create_symlink(tree / "weights", unsafe_stage / "link");
        require(!cleanup_staging(unsafe_stage, created) && fs::exists(unsafe_stage / "link"));
        fs::create_directory_symlink(tree, root / "directory-link");
        rejects([&] { ordinary_directory(root / "directory-link/child", true); }, "invalid_path");
        require(!fs::exists(tree / "child"));
        fs::create_symlink(tree / "weights", root / "unsafe.lock");
        rejects([&] { CacheLock lock(root / "unsafe.lock"); }, "coreml_cache_invalid");
        std::future<void> contender;
        {
            CacheLock lock(root / "safe.lock");
            std::promise<void> started;
            auto ready = started.get_future();
            contender = std::async(std::launch::async, [&] {
                started.set_value();
                CacheLock second(root / "safe.lock");
            });
            ready.wait();
            require(contender.wait_for(std::chrono::milliseconds(30)) == std::future_status::timeout);
        }
        require(contender.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
        contender.get();
        auto identity = cache_identity();
        require(identity.at("artifact") == model_assets_id() && !identity.at("os_build").empty());
        require(identity.at("compute_units") == "cpu-and-neural-engine");
        auto broken_cache = ordinary_directory(root / "broken-cache", true);
        auto entry = broken_cache / text_sha256(identity.dump());
        fs::create_directory(entry);
        rejects([&] { cached_model(root / "unused-package", broken_cache); }, "coreml_cache_invalid");
        write_json(entry / "receipt.json", {{"identity", identity}, {"compiled", Json::object()}});
        fs::create_directory(entry / "model.mlmodelc");
        rejects([&] { cached_model(root / "unused-package", broken_cache); }, "coreml_cache_invalid");
        fs::create_directory(root / "missing-source");
        rejects([&] { CoreMLGradient model(root / "missing-source", root / "unused-cache"); },
                "missing_assets");
        require(!fs::exists(root / "unused-cache"));
        std::cout << "Core ML contracts passed without compiling or predicting a model\n";
    }} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
`);
  const binary = path.join(root, "contracts");
  const compile = spawnSync("clang++", [
    "-std=c++20", "-fobjc-arc", "-mmacosx-version-min=15.0", "-Wno-deprecated-declarations",
    "-I", path.join(native, "src"), "-I", root, "-I", path.join(dependencyCache, "json/include"),
    path.join(root, "contracts.mm"), path.join(native, "src/support.cpp"),
    "-framework", "CoreML", "-framework", "Foundation", "-framework", "CoreFoundation",
    "-framework", "Security", "-lcurl", "-o", binary,
  ], { encoding: "utf8", timeout: 120000 });
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
  const run = spawnSync(binary, [root], { encoding: "utf8", timeout: 15000 });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  assert.match(run.stdout, /contracts passed/);
});
