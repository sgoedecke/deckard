#import <Foundation/Foundation.h>
#import <CoreML/CoreML.h>
#import <dispatch/dispatch.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <stdexcept>
#include "power_worker.hpp"
#include "ane_trace.hpp"

using Clock = std::chrono::steady_clock;
static NSString *const SourceSHA256 =
    @"85a9e02ebdcbbe1dd84cdbf893b708e44ee4691cadc7e1a4780039e22097ac98";

static double Elapsed(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

[[noreturn]] static void Fail(NSString *message) {
    throw std::runtime_error(message.UTF8String ?: "Unknown error");
}

static NSString *ErrorMessage(NSString *context, NSError *error) {
    return [NSString stringWithFormat:@"%@: %@", context,
            error.description ?: @"Core ML returned no result"];
}

static NSDictionary *ReadJSON(NSURL *url) {
    NSError *error = nil;
    NSData *data = [NSData dataWithContentsOfURL:url options:0 error:&error];
    if (!data) Fail(ErrorMessage(url.path, error));
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    if (![value isKindOfClass:NSDictionary.class]) {
        Fail(ErrorMessage([NSString stringWithFormat:@"%@ must contain a JSON object", url.path],
                          error));
    }
    return value;
}

static bool IsInteger(id value, long long minimum, long long maximum) {
    if (![value isKindOfClass:NSNumber.class] ||
        CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return false;
    double number = [value doubleValue];
    return std::isfinite(number) && std::floor(number) == number &&
           number >= minimum && number <= maximum;
}

static NSInteger ValidateManifest(NSDictionary *manifest) {
    if (![manifest[@"source_sha256"] isEqual:SourceSHA256]) {
        Fail([NSString stringWithFormat:@"Invalid manifest source_sha256: expected %@", SourceSHA256]);
    }
    if ((![manifest[@"format"] isEqual:@"deckard-coreml-split-v1"] &&
         ![manifest[@"format"] isEqual:@"deckard-coreml-fused-v1"]) ||
        ![manifest[@"model"] isEqual:@"ShantanuT01/gradient-ai-text-detector"] ||
        ![manifest[@"revision"] isEqual:@"c2e8b6df87f8a211cbffb713fa9873a0c3a9713f"] ||
        !IsInteger(manifest[@"layers"], 24, 24) ||
        !IsInteger(manifest[@"sequence_length"], 1, 512)) {
        Fail(@"Invalid manifest: expected a split/fused Gradient bundle, pinned detector revision, "
             "24 layers, and sequence_length in 1..512");
    }
    return [manifest[@"sequence_length"] integerValue];
}

static MLMultiArray *NewArray(NSArray<NSNumber *> *shape, MLMultiArrayDataType type) {
    NSError *error = nil;
    MLMultiArray *array = [[MLMultiArray alloc] initWithShape:shape dataType:type error:&error];
    if (!array) Fail(ErrorMessage(@"Allocate tensor", error));
    return array;
}

static void ValidateArray(MLMultiArray *array, NSArray<NSNumber *> *shape,
                          MLMultiArrayDataType type, NSString *name) {
    if (!array || array.dataType != type || ![array.shape isEqualToArray:shape]) {
        Fail([NSString stringWithFormat:@"%@: expected tensor shape %@ and dtype %ld, got %@ / %ld",
              name, shape, (long)type, array.shape, (long)array.dataType]);
    }
}

static void ValidateFeatures(NSDictionary<NSString *, MLFeatureDescription *> *actual,
                             NSDictionary<NSString *, NSArray<NSNumber *> *> *expected,
                             NSString *stage) {
    if (actual.count != expected.count) {
        Fail([NSString stringWithFormat:@"%@: unexpected feature count", stage]);
    }
    for (NSString *name in expected) {
        MLFeatureDescription *feature = actual[name];
        MLMultiArrayDataType type = [name isEqual:@"input_ids"]
            ? MLMultiArrayDataTypeInt32 : MLMultiArrayDataTypeFloat32;
        if (!feature || feature.type != MLFeatureTypeMultiArray || feature.optional ||
            feature.multiArrayConstraint.dataType != type ||
            ![feature.multiArrayConstraint.shape isEqualToArray:expected[name]]) {
            Fail([NSString stringWithFormat:@"%@: invalid feature %@; expected %@ with dtype %ld",
                  stage, name, expected[name], (long)type]);
        }
    }
}

static NSString *DeviceName(id<MLComputeDeviceProtocol> device) {
    if ([device isKindOfClass:MLCPUComputeDevice.class]) return @"cpu";
    if ([device isKindOfClass:MLNeuralEngineComputeDevice.class]) return @"neural_engine";
    if (!device) return @"unknown";
    return NSStringFromClass([device class]);
}

static void CollectOperations(MLComputePlan *plan, MLModelStructureProgramBlock *block,
                              NSString *path, NSMutableArray *operations,
                              NSMutableDictionary *counts) {
    NSUInteger index = 0;
    for (MLModelStructureProgramOperation *operation in block.operations) {
        NSString *operationPath = [path stringByAppendingFormat:@"/%lu", (unsigned long)index++];
        MLComputePlanDeviceUsage *usage = [plan computeDeviceUsageForMLProgramOperation:operation];
        MLComputePlanCost *cost = [plan estimatedCostOfMLProgramOperation:operation];
        NSString *preferred = DeviceName(usage.preferredComputeDevice);
        counts[preferred] = @([counts[preferred] unsignedIntegerValue] + 1);
        NSMutableArray *supported = [NSMutableArray array];
        for (id<MLComputeDeviceProtocol> device in usage.supportedComputeDevices) {
            [supported addObject:DeviceName(device)];
        }
        NSMutableArray *outputs = [NSMutableArray array];
        for (MLModelStructureProgramNamedValueType *output in operation.outputs) {
            [outputs addObject:output.name];
        }
        [operations addObject:@{
            @"path": operationPath, @"operator": operation.operatorName,
            @"outputs": outputs, @"preferred_device": preferred,
            @"estimated_cost_weight": cost ? @(cost.weight) : NSNull.null,
            @"supported_devices": supported
        }];
        NSUInteger blockIndex = 0;
        for (MLModelStructureProgramBlock *nested in operation.blocks) {
            CollectOperations(plan, nested,
                [operationPath stringByAppendingFormat:@"/block-%lu", (unsigned long)blockIndex++],
                operations, counts);
        }
    }
}

static NSDictionary *Placement(NSURL *url, MLModelConfiguration *configuration) {
    @autoreleasepool {
        dispatch_semaphore_t ready = dispatch_semaphore_create(0);
        __block MLComputePlan *plan = nil;
        __block NSError *error = nil;
        [MLComputePlan loadContentsOfURL:url configuration:configuration
                     completionHandler:^(MLComputePlan *result, NSError *failure) {
            plan = result;
            error = failure;
            dispatch_semaphore_signal(ready);
        }];
        dispatch_semaphore_wait(ready, DISPATCH_TIME_FOREVER);
        if (!plan) Fail(ErrorMessage(@"Load MLComputePlan", error));
        if (!plan.modelStructure.program) Fail(@"MLComputePlan: expected an ML Program model");
        NSMutableArray *operations = [NSMutableArray array];
        NSMutableDictionary *counts = [NSMutableDictionary dictionary];
        NSDictionary *functions = plan.modelStructure.program.functions;
        for (NSString *name in [[functions allKeys] sortedArrayUsingSelector:@selector(compare:)]) {
            MLModelStructureProgramFunction *function = functions[name];
            CollectOperations(plan, function.block, name, operations, counts);
        }
        return @{
            @"source": @"MLComputePlan",
            @"measured_execution": @NO,
            @"interpretation": @"Preferred devices are compiler predictions, not measured execution.",
            @"preferred_device_operation_counts": counts,
            @"operation_count": @(operations.count),
            @"operations": operations
        };
    }
}

static NSURL *Compile(NSURL *package) {
    dispatch_semaphore_t ready = dispatch_semaphore_create(0);
    __block NSURL *compiled = nil;
    __block NSError *error = nil;
    [MLModel compileModelAtURL:package completionHandler:^(NSURL *result, NSError *failure) {
        compiled = result;
        error = failure;
        dispatch_semaphore_signal(ready);
    }];
    dispatch_semaphore_wait(ready, DISPATCH_TIME_FOREVER);
    if (!compiled) Fail(ErrorMessage([NSString stringWithFormat:@"Compile %@", package.path], error));
    return compiled;
}

// Own the tensor storage independently of the prediction provider/model before unloading a stage.
static MLMultiArray *CopyHidden(MLMultiArray *source, NSInteger length) {
    MLMultiArray *copy = NewArray(@[@1, @(length), @1024], MLMultiArrayDataTypeFloat32);
    if ([source.strides isEqualToArray:copy.strides]) {
        std::memcpy(copy.dataPointer, source.dataPointer, (size_t)copy.count * sizeof(float));
    } else {
        for (NSInteger i = 0; i < length; ++i) {
            for (NSInteger j = 0; j < 1024; ++j) {
                NSArray *index = @[@0, @(i), @(j)];
                copy[index] = source[index];
            }
        }
    }
    return copy;
}

static MLMultiArray *Predict(MLModel *model, NSString *stage, MLMultiArray *tokenIDs,
                            MLMultiArray *attentionMask, MLMultiArray *hidden, NSInteger length) {
    BOOL embedding = [stage isEqual:@"embedding"] || [stage isEqual:@"model"];
    BOOL head = [stage isEqual:@"head"] || [stage isEqual:@"model"];
    NSString *outputName = head ? @"logit" : embedding ? @"hidden" : @"hidden_out";
    NSDictionary *values = embedding ? @{@"input_ids": tokenIDs, @"attention_mask": attentionMask}
        : head ? @{@"hidden": hidden} : @{@"hidden": hidden, @"attention_mask": attentionMask};
    NSError *error = nil;
    MLDictionaryFeatureProvider *features =
        [[MLDictionaryFeatureProvider alloc] initWithDictionary:values error:&error];
    if (!features) Fail(ErrorMessage([stage stringByAppendingString:@" inputs"], error));
    id<MLFeatureProvider> prediction = [model predictionFromFeatures:features error:&error];
    if (!prediction) Fail(ErrorMessage([stage stringByAppendingString:@" prediction"], error));
    if (![prediction.featureNames isEqualToSet:[NSSet setWithObject:outputName]])
        Fail([stage stringByAppendingString:@": unexpected prediction output names"]);
    MLFeatureValue *value = [prediction featureValueForName:outputName];
    if (value.type != MLFeatureTypeMultiArray) Fail([stage stringByAppendingString:@": output is not a tensor"]);
    MLMultiArray *output = value.multiArrayValue;
    ValidateArray(output, head ? @[@1, @1] : @[@1, @(length), @1024], MLMultiArrayDataTypeFloat32, stage);
    return output;
}

static NSDictionary *ProfileLayer(NSURL *package, const char *lengthText, NSString *units, NSString *scheduling,
                                 int repeats) {
    char *end = nullptr;
    long length = std::strtol(lengthText, &end, 10);
    if (!end || *end || length < 1 || length > 512 ||
        (![units isEqual:@"cpu"] && ![units isEqual:@"cpu-ane"]) ||
        (![scheduling isEqual:@"default"] && ![scheduling isEqual:@"background"]))
        Fail(@"Profile requires length 1..512, cpu|cpu-ane, and default|background.");
    MLModelConfiguration *configuration = [[MLModelConfiguration alloc] init];
    configuration.computeUnits = [units isEqual:@"cpu"] ? MLComputeUnitsCPUOnly : MLComputeUnitsCPUAndNeuralEngine;
    NSURL *compiled = Compile(package);
    @try {
        NSDictionary *placement = Placement(compiled, configuration);
        NSError *error = nil;
        MLModel *model = [MLModel modelWithContentsOfURL:compiled configuration:configuration error:&error];
        if (!model) Fail(ErrorMessage(@"Load profiling layer", error));
        NSArray *shape = @[@1, @(length), @1024], *maskShape = @[@1, @(length)];
        ValidateFeatures(model.modelDescription.inputDescriptionsByName,
                         @{@"hidden": shape, @"attention_mask": maskShape}, @"profile");
        ValidateFeatures(model.modelDescription.outputDescriptionsByName, @{@"hidden_out": shape}, @"profile");
        MLMultiArray *hidden = NewArray(shape, MLMultiArrayDataTypeFloat32);
        MLMultiArray *mask = NewArray(maskShape, MLMultiArrayDataTypeFloat32);
        uint32_t random = 1;
        for (NSInteger i = 0; i < hidden.count; ++i) {
            random ^= random << 13; random ^= random >> 17; random ^= random << 5;
            hidden[i] = @((float)(random & 65535) / 32768.0f - 1.0f);
        }
        for (NSInteger i = 0; i < length; ++i) mask[i] = @1;
        if ([scheduling isEqual:@"background"]) deckard_power::background();
        (void)Predict(model, @"layer", nil, mask, hidden, length);
        NSMutableArray *times = [NSMutableArray array];
        MLMultiArray *output = nil;
        for (int i = 0; i < repeats; ++i) {
            @autoreleasepool {
                const auto start = Clock::now();
                output = Predict(model, @"layer", nil, mask, hidden, length);
                [times addObject:@(Elapsed(start))];
            }
        }
        double squares = 0;
        for (NSInteger i = 0; i < output.count; ++i) {
            double value = [output[i] doubleValue];
            if (!std::isfinite(value)) Fail(@"Profiling layer returned non-finite output.");
            squares += value * value;
        }
        return @{@"compute_units": units, @"scheduling": scheduling, @"sequence_length": @(length),
                 @"prediction_ms": times, @"output_rms": @(std::sqrt(squares / output.count)),
                 @"input": @"deterministic synthetic hidden states; not a classification fixture",
                 @"placement": placement};
    } @finally {
        NSError *error = nil;
        if (![[NSFileManager defaultManager] removeItemAtURL:compiled error:&error])
            Fail(ErrorMessage(@"Remove compiled profiling layer", error));
    }
}

static NSDictionary *Run(NSURL *bundle, NSURL *inputURL, bool powerWorker, bool inspectPlan = true,
                         bool fastPrediction = false) {
    auto totalStart = Clock::now();
    NSDictionary *manifest = ReadJSON([bundle URLByAppendingPathComponent:@"manifest.json"]);
    NSInteger length = ValidateManifest(manifest);
    BOOL fused = [manifest[@"format"] isEqual:@"deckard-coreml-fused-v1"];
    NSDictionary *input = ReadJSON(inputURL);
    NSArray *ids = input[@"input_ids"];
    NSArray *mask = input[@"attention_mask"];
    if (![ids isKindOfClass:NSArray.class] || ![mask isKindOfClass:NSArray.class] ||
        ids.count < 1 || ids.count > (NSUInteger)length || ids.count != mask.count) {
        Fail(@"Input input_ids and attention_mask must be equal-length arrays with 1..sequence_length entries");
    }
    for (NSUInteger i = 0; i < ids.count; ++i) {
        if (!IsInteger(ids[i], 0, 128099) || !IsInteger(mask[i], 0, 1)) {
            Fail([NSString stringWithFormat:@"Invalid input at index %lu: ids must be integers in "
                  "0..128099; mask must contain integer 0 or 1 (not booleans)", (unsigned long)i]);
        }
    }

    NSMutableArray<NSString *> *stages = [NSMutableArray arrayWithObject:fused ? @"model" : @"embedding"];
    if (!fused) {
        for (int i = 0; i < 24; ++i) [stages addObject:[NSString stringWithFormat:@"layer-%02d", i]];
        [stages addObject:@"head"];
    }
    for (NSString *stage in stages) {
        NSURL *package = [bundle URLByAppendingPathComponent:[stage stringByAppendingString:@".mlpackage"]];
        BOOL directory = NO;
        if (![[NSFileManager defaultManager] fileExistsAtPath:package.path isDirectory:&directory] ||
            !directory) {
            Fail([NSString stringWithFormat:@"Missing model package: %@ (unchecked .mlmodelc caches are never reused)",
                  package.path]);
        }
    }

    NSArray *tokenShape = @[@1, @(length)];
    NSArray *hiddenShape = @[@1, @(length), @1024];
    MLMultiArray *tokenIDs = NewArray(tokenShape, MLMultiArrayDataTypeInt32);
    MLMultiArray *attentionMask = NewArray(tokenShape, MLMultiArrayDataTypeFloat32);
    for (NSInteger i = 0; i < length; ++i) {
        tokenIDs[@[@0, @(i)]] = (NSUInteger)i < ids.count ? ids[i] : @0;
        attentionMask[@[@0, @(i)]] = (NSUInteger)i < mask.count ? mask[i] : @0;
    }

    MLModelConfiguration *configuration = [[MLModelConfiguration alloc] init];
    configuration.computeUnits = MLComputeUnitsCPUAndNeuralEngine;
    if (fastPrediction) {
        MLOptimizationHints *hints = [[MLOptimizationHints alloc] init];
        hints.reshapeFrequency = MLReshapeFrequencyHintInfrequent;
        hints.specializationStrategy = MLSpecializationStrategyFastPrediction;
        configuration.optimizationHints = hints;
    }
    NSMutableArray *timings = [NSMutableArray array];
    NSMutableArray<NSURL *> *compiledModels = [NSMutableArray array];
    MLModel *residentModel = nil;
    NSUInteger plannedANEOperations = 0;
    MLMultiArray *hidden = nil;
    double logit = NAN;
    @try {
    for (NSString *stage in stages) {
        @autoreleasepool {
            auto stageStart = Clock::now();
            NSURL *package = [bundle URLByAppendingPathComponent:[stage stringByAppendingString:@".mlpackage"]];
            auto compileStart = Clock::now();
            double compileCPUStart = deckard_power::cpu_seconds();
            if (powerWorker) std::fprintf(stderr, "Preparing %s: compile\n", stage.UTF8String);
            // Compile afresh: never trust an unverified compiled sibling after export changes.
            NSURL *compiled = Compile(package);
            double compileMS = Elapsed(compileStart);
            double compileCPUMS = (deckard_power::cpu_seconds() - compileCPUStart) * 1000;
            if (powerWorker && inspectPlan) std::fprintf(stderr, "Preparing %s: inspect plan (compiled in %.0f ms)\n",
                                          stage.UTF8String, compileMS);
            @try {
                @autoreleasepool {
                    auto planStart = Clock::now();
                    NSDictionary *placement = inspectPlan ? Placement(compiled, configuration) : @{};
                    plannedANEOperations += [placement[@"preferred_device_operation_counts"][@"neural_engine"]
                                             unsignedIntegerValue];
                    double planMS = Elapsed(planStart);
                    if (powerWorker && inspectPlan) std::fprintf(stderr, "Preparing %s: load (plan inspected in %.0f ms)\n",
                                                  stage.UTF8String, planMS);
                    if (powerWorker && !inspectPlan)
                        std::fprintf(stderr, "Preparing %s: load without static plan inspection; "
                                     "runtime ANE evidence required\n", stage.UTF8String);
                    auto loadStart = Clock::now();
                    double loadCPUStart = deckard_power::cpu_seconds();
                    NSError *error = nil;
                    MLModel *model = [MLModel modelWithContentsOfURL:compiled configuration:configuration error:&error];
                    if (!model) Fail(ErrorMessage([stage stringByAppendingString:@" load"], error));
                    double loadMS = Elapsed(loadStart);
                    double loadCPUMS = (deckard_power::cpu_seconds() - loadCPUStart) * 1000;
                    if (powerWorker && !inspectPlan) {
                        std::fprintf(stderr, "PROFILE {\"stage\":\"%s\",\"compile_ms\":%.6f,"
                                     "\"compile_process_cpu_ms\":%.6f,\"load_ms\":%.6f,"
                                     "\"load_process_cpu_ms\":%.6f}\n", stage.UTF8String,
                                     compileMS, compileCPUMS, loadMS, loadCPUMS);
                        std::fflush(stderr);
                    }
                    BOOL embedding = fused || [stage isEqual:@"embedding"];
                    BOOL head = fused || [stage isEqual:@"head"];
                    NSString *outputName = head ? @"logit" : embedding ? @"hidden" : @"hidden_out";
                    NSDictionary *inputShapes = embedding
                        ? @{@"input_ids": tokenShape, @"attention_mask": tokenShape}
                        : head ? @{@"hidden": hiddenShape}
                        : @{@"hidden": hiddenShape, @"attention_mask": tokenShape};
                    NSArray *outputShape = head ? @[@1, @1] : hiddenShape;
                    ValidateFeatures(model.modelDescription.inputDescriptionsByName, inputShapes, stage);
                    ValidateFeatures(model.modelDescription.outputDescriptionsByName,
                                     @{outputName: outputShape}, stage);
                    if (powerWorker) {
                        if (fused) residentModel = model;
                        [compiledModels addObject:compiled];
                        continue;
                    }
                    auto predictionStart = Clock::now();
                    MLMultiArray *output = Predict(model, stage, tokenIDs, attentionMask, hidden, length);
                    double predictionMS = Elapsed(predictionStart);
                    if (head) {
                        logit = [output[@[@0, @0]] doubleValue];
                        if (!std::isfinite(logit)) Fail(@"head: logit must be a finite scalar");
                    } else {
                        hidden = CopyHidden(output, length);
                    }
                    [timings addObject:@{
                        @"stage": stage, @"compile_ms": @(compileMS), @"load_ms": @(loadMS),
                        @"compute_plan_ms": @(planMS), @"prediction_ms": @(predictionMS),
                        @"total_ms": @(Elapsed(stageStart)), @"placement": placement
                    }];
                }
            } @finally {
                NSError *error = nil;
                if (![compiledModels containsObject:compiled] &&
                    ![[NSFileManager defaultManager] removeItemAtURL:compiled error:&error]) {
                    Fail(ErrorMessage(@"Remove compiled stage", error));
                }
            }
        }
    }
    if (powerWorker) {
            if (compiledModels.count != stages.count) Fail(@"Not all power benchmark stages were compiled.");
            if (inspectPlan && !plannedANEOperations)
                Fail(@"No Neural Engine execution plan was produced; refusing an ANE-labelled power comparison.");
            deckard_power::background();
            std::fprintf(stderr, "Preparation complete; warming under background scheduling\n");
            deckard_power::serve("coreml", [&]() -> float {
                MLMultiArray *state = nil;
                for (NSUInteger i = 0; i < stages.count; ++i) {
                    @autoreleasepool {
                        NSError *error = nil;
                        MLModel *model = residentModel ?: [MLModel modelWithContentsOfURL:compiledModels[i]
                                                         configuration:configuration error:&error];
                        if (!model) Fail(ErrorMessage(@"Load streaming power stage", error));
                        MLMultiArray *output = Predict(model, stages[i], tokenIDs, attentionMask, state, length);
                        if (i + 1 == stages.count) return [output[@[@0, @0]] floatValue];
                        state = CopyHidden(output, length);
                    }
                }
                Fail(@"Missing classifier stage.");
            }, 0, !inspectPlan, deckard_ane_trace::command);
        return nil;
    }
    double score = logit >= 0 ? 1.0 / (1.0 + std::exp(-logit))
                             : std::exp(logit) / (1.0 + std::exp(logit));
    return @{
        @"experimental": @YES, @"compute_units": @"cpu_and_neural_engine",
        @"model": @"ShantanuT01/gradient-ai-text-detector",
        @"revision": @"c2e8b6df87f8a211cbffb713fa9873a0c3a9713f",
        @"source_sha256": SourceSHA256,
        @"sequence_length": @(length), @"input_length": @(ids.count),
        @"logit": @(logit), @"score": @(score),
        @"timings": @{@"total_ms": @(Elapsed(totalStart)), @"stages": timings}
    };
    } @finally {
        residentModel = nil;
        for (NSURL *url in compiledModels) {
            NSError *error = nil;
            if (![[NSFileManager defaultManager] removeItemAtURL:url error:&error])
                Fail(ErrorMessage(@"Remove compiled power stage", error));
        }
    }
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        bool fastPrediction = argc == 5 && std::strcmp(argv[3], "--benchmark-worker") == 0 &&
                              std::strcmp(argv[4], "--fast-prediction") == 0;
        bool waitForProfiler = argc == 5 && std::strcmp(argv[3], "--benchmark-worker") == 0 &&
                               std::strcmp(argv[4], "--wait-for-profiler") == 0;
        bool benchmarkWorker = fastPrediction || waitForProfiler ||
                               (argc == 4 && std::strcmp(argv[3], "--benchmark-worker") == 0);
        bool powerWorker = benchmarkWorker || (argc == 4 && std::strcmp(argv[3], "--power-worker") == 0);
        bool profile = (argc == 6 || argc == 7) && std::strcmp(argv[3], "--profile-layer") == 0;
        if (argc != 3 && !powerWorker && !profile) {
            std::fprintf(stderr, "Usage: %s <bundle-directory> <input.json> [--power-worker|--benchmark-worker [--fast-prediction|--wait-for-profiler]]\n"
                         "       %s <layer.mlpackage> <length> --profile-layer cpu|cpu-ane default|background [repeats]\n"
                         "EXPERIMENTAL; CPU and Neural Engine only; macOS 15+ Apple Silicon.\n", argv[0], argv[0]);
            return 2;
        }
        try {
            @try {
                if (const char *trace = std::getenv("DECKARD_ANE_TRACE")) {
                    const bool timing = std::strcmp(trace, "timing") == 0;
                    if ((!timing && std::strcmp(trace, "observe")) || (!benchmarkWorker && !profile))
                        Fail(@"DECKARD_ANE_TRACE=observe|timing is supported only for diagnostic workers/layers.");
                    deckard_ane_trace::install(timing);
                }
                if (waitForProfiler) {
                    std::cout << "{\"profiler_waiting\":true}" << std::endl;
                    std::string command;
                    if (!std::getline(std::cin, command))
                        Fail(@"Expected prepare command after profiler attachment.");
                    if (command == "quit") return 0;
                    if (command != "prepare") Fail(@"Expected prepare command after profiler attachment.");
                }
                int repeats = 5;
                if (profile && argc == 7) {
                    char *end = nullptr;
                    long value = std::strtol(argv[6], &end, 10);
                    if (!end || *end || value < 1 || value > 1000) Fail(@"Profile repeats must be in 1..1000.");
                    repeats = static_cast<int>(value);
                }
                NSDictionary *result = profile ? ProfileLayer(
                    [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]] isDirectory:YES],
                    argv[2], [NSString stringWithUTF8String:argv[4]], [NSString stringWithUTF8String:argv[5]], repeats) : Run(
                    [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]] isDirectory:YES],
                    [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]]], powerWorker,
                    !benchmarkWorker, fastPrediction);
                if (powerWorker) return 0;
                NSError *error = nil;
                NSData *json = [NSJSONSerialization dataWithJSONObject:result
                    options:NSJSONWritingSortedKeys error:&error];
                if (!json) Fail(ErrorMessage(@"Serialize result", error));
                if (std::fwrite(json.bytes, 1, json.length, stdout) != json.length ||
                    std::fputc('\n', stdout) == EOF || std::fflush(stdout) != 0) {
                    Fail(@"Write JSON result to stdout failed");
                }
                return 0;
            } @catch (NSException *exception) {
                std::fprintf(stderr, "Experimental Core ML runner: %s: %s\n",
                             exception.name.UTF8String, exception.reason.UTF8String);
                return 1;
            }
        } catch (const std::exception &error) {
            std::fprintf(stderr, "Experimental Core ML runner: %s\n", error.what());
            return 1;
        }
    }
}
