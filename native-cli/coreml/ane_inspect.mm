#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include <dlfcn.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>

static bool CheckABI(Class cls, bool classMethod, const char *name, const char *encoding) {
    SEL selector = sel_registerName(name);
    Method method = classMethod ? class_getClassMethod(cls, selector) : class_getInstanceMethod(cls, selector);
    if (!method || std::strcmp(method_getTypeEncoding(method), encoding)) {
        std::fprintf(stderr, "Unsupported ANE runtime ABI: %s\n", name);
        return false;
    }
    return true;
}

int main() {
    @autoreleasepool {
        if (!dlopen("/System/Library/PrivateFrameworks/AppleNeuralEngine.framework/AppleNeuralEngine",
                    RTLD_NOW | RTLD_LOCAL)) {
            std::fprintf(stderr, "Cannot load AppleNeuralEngine: %s\n", dlerror());
            return 1;
        }
        NSMutableArray *classes = [NSMutableArray array];
        for (NSString *name in @[@"_ANEPerformanceStats", @"_ANEPerformanceStatsIOSurface",
                                @"_ANERequest", @"_ANEModel",
                                @"_ANEClient", @"_ANEDeviceInfo", @"_ANEQoSMapper",
                                @"_ANEPerformanceCounters"]) {
            Class cls = NSClassFromString(name);
            NSMutableArray *methods = [NSMutableArray array];
            if (cls) {
                for (NSNumber *classMethod in @[@NO, @YES]) {
                    unsigned count = 0;
                    Method *list = class_copyMethodList(classMethod.boolValue ? object_getClass(cls) : cls, &count);
                    for (unsigned i = 0; i < count; ++i) {
                        [methods addObject:@{
                            @"class_method": classMethod,
                            @"selector": NSStringFromSelector(method_getName(list[i])),
                            @"encoding": [NSString stringWithUTF8String:method_getTypeEncoding(list[i])]
                        }];
                    }
                    std::free(list);
                }
            }
            NSMutableDictionary *record = [@{@"name": name, @"found": @(cls != Nil),
                                              @"methods": methods} mutableCopy];
            if ([name isEqualToString:@"_ANEPerformanceStats"] && cls) {
                if (!CheckABI(cls, true, "statsWithHardwareExecutionNS:", "@24@0:8Q16") ||
                    !CheckABI(cls, true, "driverMaskForANEFMask:", "I20@0:8I16") ||
                    !CheckABI(cls, false, "stringForPerfCounter:", "@20@0:8i16")) return 1;
                id stats = reinterpret_cast<id (*)(id, SEL, unsigned long long)>(objc_msgSend)(
                    cls, sel_registerName("statsWithHardwareExecutionNS:"), 0);
                if (!stats) {
                    std::fprintf(stderr, "Cannot create a timing statistics object.\n");
                    return 1;
                }
                NSMutableArray *names = [NSMutableArray array], *masks = [NSMutableArray array];
                for (int i = 0; i < 24; ++i) {
                    id counter = reinterpret_cast<id (*)(id, SEL, int)>(objc_msgSend)(
                        stats, sel_registerName("stringForPerfCounter:"), i);
                    [names addObject:counter ?: [NSNull null]];
                }
                for (unsigned i = 0; i < 16; ++i) {
                    unsigned mask = reinterpret_cast<unsigned (*)(id, SEL, unsigned)>(objc_msgSend)(
                        cls, sel_registerName("driverMaskForANEFMask:"), i);
                    [masks addObject:@{@"framework_mask": @(i), @"driver_mask": @(mask)}];
                }
                record[@"counter_names"] = names;
                record[@"driver_masks"] = masks;
            }
            if ([name isEqualToString:@"_ANEQoSMapper"] && cls) {
                if (!CheckABI(cls, true, "programPriorityForQoS:", "i20@0:8I16") ||
                    !CheckABI(cls, true, "queueIndexForQoS:", "Q20@0:8I16")) return 1;
                NSMutableArray *mapping = [NSMutableArray array];
                for (NSNumber *qos in @[@9, @17, @21]) {
                    const unsigned value = qos.unsignedIntValue;
                    int priority = reinterpret_cast<int (*)(id, SEL, unsigned)>(objc_msgSend)(
                        cls, sel_registerName("programPriorityForQoS:"), value);
                    auto queue = reinterpret_cast<unsigned long long (*)(id, SEL, unsigned)>(objc_msgSend)(
                        cls, sel_registerName("queueIndexForQoS:"), value);
                    [mapping addObject:@{@"qos": qos, @"program_priority": @(priority), @"queue_index": @(queue)}];
                }
                record[@"qos_mapping"] = mapping;
            }
            [classes addObject:record];
        }
        NSError *error = nil;
        NSData *data = [NSJSONSerialization dataWithJSONObject:classes
                            options:NSJSONWritingPrettyPrinted error:&error];
        if (!data) {
            std::fprintf(stderr, "Cannot encode runtime inspection: %s\n", error.description.UTF8String);
            return 1;
        }
        if (std::fwrite(data.bytes, 1, data.length, stdout) != data.length) return 1;
        std::putchar('\n');
    }
}
