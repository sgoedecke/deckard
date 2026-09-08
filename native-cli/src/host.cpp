#include "host.hpp"
#include "gradient.hpp"
#include "tokenizer.hpp"
#include <algorithm>
#include <chrono>
#include <csignal>
#include <cstring>
#include <iostream>
#include <list>
#include <sstream>
#include <thread>
#include <unistd.h>

namespace aihider {
namespace {
constexpr size_t frame_limit = 4 * 1024 * 1024;
void deadline(int) {
    static constexpr char message[] = "Deckard: inference_deadline\n";
    (void)!write(STDERR_FILENO, message, sizeof(message) - 1);
    _exit(124);
}
Json failure(const Json& id, const std::string& code, const std::string& message) {
    return {{"id", id}, {"ok", false}, {"error", {{"code", code}, {"message", message}}}};
}
}
struct Analyzer::Impl {
    fs::path home;
    std::unique_ptr<Tokenizer> tokenizer;
    std::unique_ptr<Gradient> model;
    std::list<std::pair<std::string, Json>> cache;
};
Analyzer::Analyzer(fs::path home) : impl_(std::make_unique<Impl>()) { impl_->home = std::move(home); }
Analyzer::~Analyzer() = default;
Json Analyzer::ping() {
    installed_config(impl_->home, false);
    Json result = identity();
    result.update({{"status", "ready"}, {"model_loaded", bool(impl_->model)},
                   {"runtime", "native-mlx-0.32.2"}, {"scheduling", "background"},
                   {"max_chars", 20000}, {"max_chunks", 4}});
    return result;
}
std::vector<std::vector<uint32_t>> windows(const std::vector<uint32_t>& ids) {
    size_t length = std::min<size_t>(ids.size(), 2040);
    if (!length) return {};
    size_t count = (length + 509) / 510;
    size_t size = length / count, remainder = length % count, start = 0;
    std::vector<std::vector<uint32_t>> result;
    for (size_t index = 0; index < count; ++index) {
        size_t end = start + size + (index < remainder ? 1 : 0);
        result.emplace_back(ids.begin() + start, ids.begin() + end);
        start = end;
    }
    return result;
}
Json Analyzer::analyze(const std::string& text) {
    auto started = std::chrono::steady_clock::now();
    auto count = characters(text);
    if (!count || count > 20000) throw Error("invalid_text", "Text must contain 1..20000 Unicode characters.");
    size_t word_count = words(text);
    Json result = identity();
    result.update({{"words", word_count}, {"cached", false}});
    if (word_count < min_words) {
        result.update({{"status", "skipped"}, {"reason", "too_short"}});
        return result;
    }
    std::string key = text_sha256(text);
    for (auto it = impl_->cache.begin(); it != impl_->cache.end(); ++it) {
        if (it->first == key) {
            result = it->second;
            impl_->cache.splice(impl_->cache.begin(), impl_->cache, it);
            result["cached"] = true;
            result["duration_ms"] = std::chrono::duration<double, std::milli>(
                std::chrono::steady_clock::now() - started).count();
            return result;
        }
    }
    if (!impl_->tokenizer) {
        installed_config(impl_->home, true);
        impl_->tokenizer = std::make_unique<Tokenizer>(impl_->home / "models/tokenizer.json");
    }
    const auto ids = impl_->tokenizer->encode(text);
    const auto parts = windows(ids);
    Json chunks = Json::array();
    bool short_chunk = false;
    size_t analyzed = 0;
    double minimum = 1, maximum = 0;
    for (size_t index = 0; index < parts.size(); ++index) {
        size_t chunk_words = words(impl_->tokenizer->decode(parts[index]));
        if (chunk_words < min_words) { short_chunk = true; continue; }
        if (!impl_->model) impl_->model = std::make_unique<Gradient>(impl_->home / "models/packed.safetensors");
        auto tokens = impl_->tokenizer->wrap(parts[index]);
        double score = sigmoid(impl_->model->logit(tokens, std::vector<uint32_t>(tokens.size(), 1)));
        chunks.push_back({{"index", index}, {"score", score}, {"tokens", parts[index].size()}, {"words", chunk_words}});
        analyzed += parts[index].size();
        minimum = std::min(minimum, score);
        maximum = std::max(maximum, score);
        if (index + 1 < parts.size()) std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    if (chunks.empty()) {
        result.update({{"status", "skipped"}, {"reason", "too_short_after_chunking"}});
        return result;
    }
    bool truncated = ids.size() > 2040, partial = truncated || short_chunk;
    result.update({{"status", partial ? "partial" : "complete"}, {"score", maximum},
                   {"min_score", minimum}, {"max_score", maximum}, {"chunks", chunks},
                   {"total_tokens", ids.size()}, {"analyzed_tokens", analyzed}, {"truncated", truncated},
                   {"duration_ms", std::chrono::duration<double, std::milli>(
                       std::chrono::steady_clock::now() - started).count()}});
    if (partial) result["reason"] = truncated ? "chunk_limit" : "short_chunk";
    impl_->cache.emplace_front(key, result);
    if (impl_->cache.size() > 64) impl_->cache.pop_back();
    return result;
}
Json Analyzer::plan(const Json& texts) {
    if (!impl_->tokenizer) {
        installed_config(impl_->home, true);
        impl_->tokenizer = std::make_unique<Tokenizer>(impl_->home / "models/tokenizer.json");
    }
    Json groups = Json::array();
    size_t operations = 0;
    for (const auto& value : texts) {
        const auto& text = value.get_ref<const std::string&>();
        const auto boundaries = word_boundaries(text);
        auto tokens = [&](size_t a, size_t b) {
            if (++operations > 20000) throw Error("planning_limit", "Context planning operation limit reached.");
            return impl_->tokenizer->encode(text.substr(boundaries[a], boundaries[b] - boundaries[a]));
        };
        auto complete = [&](size_t a, size_t b) {
            auto ids = tokens(a, b);
            if (b - a < min_words || ids.empty() || ids.size() > 2040) return false;
            for (const auto& part : windows(ids))
                if (words(impl_->tokenizer->decode(part)) < min_words) return false;
            return true;
        };
        std::vector<std::pair<size_t, size_t>> spans;
        size_t i = 0, count = boundaries.size() - 1;
        while (i < count) {
            size_t lo = i + 1, hi = count, best = i + 1;
            while (lo <= hi) {
                size_t mid = (lo + hi) / 2;
                if (tokens(i, mid).size() <= 510) { best = mid; lo = mid + 1; }
                else hi = mid - 1;
            }
            spans.emplace_back(i, best);
            i = best;
        }
        // Match the frozen verbatim, word-boundary partition; never decode/re-encode input.
        if (spans.size() > 1 && !complete(spans.back().first, spans.back().second)) {
            size_t a = spans[spans.size() - 2].first, b = spans.back().second;
            size_t best = 0, difference = SIZE_MAX;
            for (size_t cut = a + 1; cut < b; ++cut) {
                size_t na = tokens(a, cut).size(), nb = tokens(cut, b).size();
                size_t delta = na > nb ? na - nb : nb - na;
                if (na <= 510 && nb <= 510 && delta < difference && complete(a, cut) && complete(cut, b)) {
                    best = cut; difference = delta;
                }
            }
            if (best) {
                spans[spans.size() - 2] = {a, best};
                spans.back() = {best, b};
            }
        }
        Json planned = Json::array();
        for (auto [a, b] : spans)
            planned.push_back({{"start_word", a}, {"end_word", b}, {"tokens", tokens(a, b).size()},
                               {"complete", complete(a, b)}});
        groups.push_back(planned);
    }
    Json result = identity();
    result.update({{"status", "planned"}, {"groups", groups}});
    return result;
}
Json validate_request(const Json& request) {
    if (!request.is_object() || !request.contains("id") || !request["id"].is_string() ||
        request["id"].get_ref<const std::string&>().empty() ||
        characters(request["id"].get_ref<const std::string&>()) > 128)
        throw Error("invalid_request", "A request needs a nonempty string id of at most128 characters.");
    if (!request.contains("protocol_version") || !request["protocol_version"].is_number_integer() ||
        request["protocol_version"] != protocol_version)
        throw Error("extension_update_required", "Reload the updated extension for the native Gradient protocol.");
    if (!request.contains("type") || !request["type"].is_string())
        throw Error("invalid_request", "Supported requests are ping, plan and analyze.");
    std::string type = request["type"];
    if ((type != "ping" && type != "analyze" && type != "plan") || request.size() != (type == "ping" ? 3 : 4))
        throw Error("invalid_request", "Unsupported request fields.");
    if (type == "analyze") {
        if (!request.contains("text") || !request["text"].is_string())
            throw Error("invalid_text", "Analyze requires text.");
        size_t count = characters(request["text"].get_ref<const std::string&>());
        if (!count || count > 20000) throw Error("invalid_text", "Text must contain 1..20000 Unicode characters.");
    }
    if (type == "plan") {
        if (!request.contains("texts") || !request["texts"].is_array() ||
            request["texts"].empty() || request["texts"].size() > 500)
            throw Error("invalid_text", "Plan requires 1..500 source texts.");
        size_t chars = 0, count = 0;
        for (const auto& text : request["texts"]) {
            if (!text.is_string() || text.get_ref<const std::string&>().empty())
                throw Error("invalid_text", "Invalid context source.");
            chars += characters(text.get_ref<const std::string&>());
            count += word_boundaries(text.get_ref<const std::string&>()).size() - 1;
            if (chars > 500000 || count > 25000)
                throw Error("invalid_text", "Plan exceeds 500000 characters or 25000 words.");
        }
    }
    return request;
}
bool read_frame(std::istream& stream, Json& message) {
    uint32_t length = 0;
    stream.read(reinterpret_cast<char*>(&length), sizeof(length));
    if (stream.gcount() == 0 && stream.eof()) return false;
    if (stream.gcount() != sizeof(length)) throw Error("truncated_message", "Truncated native message header.");
    if (!length || length > frame_limit) throw Error("message_too_large", "Native frame exceeds 4 MiB.");
    std::string body(length, '\0');
    stream.read(body.data(), static_cast<std::streamsize>(length));
    if (stream.gcount() != length) throw Error("truncated_message", "Truncated native message body.");
    message = Json::parse(body, nullptr, false);
    if (message.is_discarded()) throw Error("invalid_json", "Native message is not valid UTF-8 JSON.");
    return true;
}
void write_frame(std::ostream& stream, const Json& message) {
    auto body = message.dump(-1, ' ', true);
    if (body.size() > 1024 * 1024) throw Error("response_too_large", "Native response exceeds Chrome's 1 MiB limit.");
    uint32_t length = static_cast<uint32_t>(body.size());
    stream.write(reinterpret_cast<const char*>(&length), sizeof(length));
    stream.write(body.data(), static_cast<std::streamsize>(body.size()));
    stream.flush();
    if (!stream) throw Error("port_closed", "Native port closed.");
}
int serve(const fs::path& home) {
    background();
    std::signal(SIGPIPE, SIG_IGN);
    std::signal(SIGALRM, deadline);
    Analyzer analyzer(home);
    while (true) {
        Json request;
        try {
            if (!read_frame(std::cin, request)) return 0;
        } catch (const Error& error) {
            write_frame(std::cout, failure(nullptr, error.code, error.what()));
            return 2;
        }
        Json id = nullptr;
        if (request.is_object() && request.contains("id") && request["id"].is_string() &&
            !request["id"].get_ref<const std::string&>().empty() &&
            characters(request["id"].get_ref<const std::string&>()) <= 128) id = request["id"];
        try {
            validate_request(request);
            alarm(60);
            Json result = request["type"] == "ping" ? analyzer.ping() :
                request["type"] == "plan" ? analyzer.plan(request["texts"]) : analyzer.analyze(request["text"]);
            alarm(0);
            write_frame(std::cout, {{"id", id}, {"ok", true}, {"result", result}});
        } catch (const Error& error) {
            alarm(0);
            std::cerr << "Deckard: " << error.code << '\n';
            if (error.code == "port_closed") return 0;
            write_frame(std::cout, failure(id, error.code, error.what()));
        } catch (const std::exception&) {
            alarm(0);
            std::cerr << "Deckard: inference_failed\n";
            write_frame(std::cout, failure(id, "inference_failed", "Native inference failed. Check the installation."));
            return 3;
        }
    }
}
void self_test() {
    auto require = [](bool value) { if (!value) throw Error("self_test", "Native self-test failed."); };
    require(characters("a\xc3\xa9\xf0\x9f\x99\x82") == 3);
    require(words("one\xc2\xa0two\nthree") == 3);
    require(text_sha256("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    require(extension_id_valid(std::string(32, 'a')) && !extension_id_valid(std::string(32, 'q')));
    require(windows({}).empty());
    for (size_t count : {1, 510, 511, 2040, 2041}) {
        auto parts = windows(std::vector<uint32_t>(count, 7));
        size_t total = 0;
        for (const auto& part : parts) { require(part.size() <= 510); total += part.size(); }
        require(total == std::min<size_t>(2040, count) && parts.size() <= 4);
    }
    Json request = {{"id", "test"}, {"type", "ping"}, {"protocol_version", protocol_version}};
    require(validate_request(request) == request);
    std::stringstream stream;
    write_frame(stream, request);
    Json read;
    require(read_frame(stream, read) && read == request && !read_frame(stream, read));
    for (const auto& invalid : {Json(nullptr), Json::array(), Json{{"id", "x"}, {"type", "ping"}},
                                Json{{"id", "x"}, {"type", "ping"}, {"protocol_version", 2}, {"extra", true}}}) {
        bool rejected = false;
        try { validate_request(invalid); } catch (const Error&) { rejected = true; }
        require(rejected);
    }
    std::stringstream truncated(std::string(2, '\0'));
    bool rejected = false;
    try { read_frame(truncated, read); } catch (const Error&) { rejected = true; }
    require(rejected);
}
}
