#pragma once

#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <chrono>
#include <atomic>
#include <cstring>
#include <dlfcn.h>
#include <mutex>
#include <stdexcept>
#include <string>
#include <iostream>
#include <cstdio>
#include <pthread.h>
#include <sys/resource.h>

namespace deckard_ane_trace {
using Evaluate = bool (*)(id, SEL, id, id, id, unsigned, NSError *__autoreleasing *);
inline Evaluate original = nullptr;
inline std::mutex output_mutex;
inline unsigned long long sequence = 0;
inline unsigned requested_mask = 0;
inline NSString *stats_option = nil;
inline bool enabled = false;
inline std::atomic<unsigned> qos_override{0};

inline bool command(const std::string &line) {
    if (!enabled) return false;
    const bool request = line == "ane-qos original" || line == "ane-qos default";
    const bool public_policy = line == "public-qos original" || line == "public-qos default";
    if (!request && !public_policy) return false;
    const bool use_default = line == "ane-qos default" || line == "public-qos default";
    if (public_policy) {
        if (setpriority(PRIO_DARWIN_PROCESS, 0, use_default ? 0 : PRIO_DARWIN_BG) ||
            pthread_set_qos_class_self_np(use_default ? QOS_CLASS_DEFAULT : QOS_CLASS_BACKGROUND, 0))
            throw std::runtime_error("Cannot change the diagnostic worker's public scheduling policy.");
    }
    qos_override.store(request && use_default ? static_cast<unsigned>(QOS_CLASS_DEFAULT) : 0);
    std::cout << "{\"" << (request ? "ane_qos" : "public_qos") << "\":\""
              << (use_default ? "default" : "original")
              << "\"}\n" << std::flush;
    if (!std::cout) throw std::runtime_error("Cannot acknowledge diagnostic QoS control.");
    return true;
}

inline void require_method(Class cls, const char *name, const char *encoding) {
    Method method = class_getInstanceMethod(cls, sel_registerName(name));
    if (!method || std::strcmp(method_getTypeEncoding(method), encoding))
        throw std::runtime_error(std::string("Unsupported ANE runtime method ABI: ") + name);
}

inline id object_value(id object, const char *name) {
    return reinterpret_cast<id (*)(id, SEL)>(objc_msgSend)(object, sel_registerName(name));
}

inline unsigned mask_value(id model) {
    return reinterpret_cast<unsigned (*)(id, SEL)>(objc_msgSend)(
        model, sel_registerName("perfStatsMask"));
}

inline bool evaluate(id client, SEL selector, id model, id options, id request, unsigned qos,
                     NSError *__autoreleasing *error) {
    if (requested_mask) {
        if (options && ![options isKindOfClass:NSDictionary.class])
            throw std::runtime_error("Unexpected ANE evaluation options type.");
        NSMutableDictionary *profile_options = options ? [options mutableCopy] : [NSMutableDictionary dictionary];
        profile_options[stats_option] = @(requested_mask);
        options = profile_options;
    }
    const unsigned override = qos_override.load();
    const unsigned effective_qos = override ? override : qos;
    const auto start = std::chrono::steady_clock::now();
    const bool success = original(client, selector, model, options, request, effective_qos, error);
    const double elapsed = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - start).count();
    id stats = object_value(request, "perfStats");
    id stats_array = object_value(request, "perfStatsArray");
    NSMutableDictionary *record = [@{
        @"call_ms": @(elapsed), @"qos": @(qos), @"effective_qos": @(effective_qos), @"success": @(success),
        @"perf_stats_mask": @(mask_value(model)),
        @"requested_mask": @(requested_mask),
        @"stats_present": @(stats != nil),
        @"stats_class": stats ? NSStringFromClass([stats class]) : @"",
        @"requested_stats_count": [stats_array isKindOfClass:NSArray.class]
            ? @([stats_array count]) : @0,
        @"option_keys": [options isKindOfClass:NSDictionary.class] ? [options allKeys] : @[],
        @"model_instance": [NSString stringWithFormat:@"%p", (__bridge void *)model],
    } mutableCopy];
    if (stats) {
        if (![stats isKindOfClass:NSClassFromString(@"_ANEPerformanceStats")])
            throw std::runtime_error("ANE returned an unexpected performance-statistics class.");
        auto hardware = reinterpret_cast<unsigned long long (*)(id, SEL)>(objc_msgSend)(
            stats, sel_registerName("hwExecutionTime"));
        id counters = object_value(stats, "perfCounterData");
        record[@"hardware_execution_ns"] = @(hardware);
        record[@"counter_bytes"] = [counters isKindOfClass:NSData.class] ? @([counters length]) : @0;
    }
    std::lock_guard<std::mutex> guard(output_mutex);
    record[@"sequence"] = @(++sequence);
    NSError *serialization_error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:record options:0 error:&serialization_error];
    if (!data) throw std::runtime_error("Cannot serialize ANE observation.");
    if (std::fprintf(stderr, "ANE_TRACE ") < 0 ||
        std::fwrite(data.bytes, 1, data.length, stderr) != data.length ||
        std::fputc('\n', stderr) == EOF || std::fflush(stderr))
        throw std::runtime_error("Cannot write ANE observation.");
    return success;
}

inline void install(bool timing) {
    if (enabled) throw std::runtime_error("ANE diagnostic observation is already installed.");
    void *framework = dlopen("/System/Library/PrivateFrameworks/AppleNeuralEngine.framework/AppleNeuralEngine",
                             RTLD_NOW | RTLD_LOCAL);
    if (!framework)
        throw std::runtime_error("Cannot load ANE framework for diagnostic observation.");
    if (timing) {
        void *symbol = dlsym(framework, "kANEFPerformanceStatsMaskKey");
        if (!symbol) throw std::runtime_error("ANE performance-statistics option is not exported.");
        stats_option = *reinterpret_cast<NSString *__unsafe_unretained *>(symbol);
        if (![stats_option isKindOfClass:NSString.class])
            throw std::runtime_error("Unexpected ANE performance-statistics option type.");
        requested_mask = 1;
    }
    Class client = NSClassFromString(@"_ANEClient");
    Class model = NSClassFromString(@"_ANEModel");
    Class request = NSClassFromString(@"_ANERequest");
    Class stats = NSClassFromString(@"_ANEPerformanceStats");
    require_method(client, "doEvaluateDirectWithModel:options:request:qos:error:", "B52@0:8@16@24@32I40^@44");
    require_method(model, "perfStatsMask", "I16@0:8");
    require_method(request, "perfStats", "@16@0:8");
    require_method(request, "perfStatsArray", "@16@0:8");
    require_method(stats, "hwExecutionTime", "Q16@0:8");
    require_method(stats, "perfCounterData", "@16@0:8");
    Method method = class_getInstanceMethod(client,
        sel_registerName("doEvaluateDirectWithModel:options:request:qos:error:"));
    original = reinterpret_cast<Evaluate>(method_setImplementation(method, reinterpret_cast<IMP>(evaluate)));
    enabled = true;
}
}
