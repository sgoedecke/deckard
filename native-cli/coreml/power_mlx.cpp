#include "../src/gradient.hpp"
#include "power_worker.hpp"
#include <nlohmann/json.hpp>
#include <fstream>
#include <vector>

int main(int argc, char** argv) {
    if (argc != 3 && argc != 4) {
        std::cerr << "Usage: deckard-power-mlx <packed.safetensors> <input.json> [prior-gpu-seconds]\n";
        return 2;
    }
    try {
        deckard_power::background();
        double prior = argc == 4 ? std::stod(argv[3]) : 0;
        if (!std::isfinite(prior) || prior < 0 || prior > 18)
            throw std::runtime_error("Invalid previous GPU allowance.");
        std::ifstream source(argv[2]);
        if (!source) throw std::runtime_error("Cannot open power benchmark input.");
        const auto input = nlohmann::json::parse(source);
        const auto ids = input.at("input_ids").get<std::vector<uint32_t>>();
        const auto mask = input.at("attention_mask").get<std::vector<uint32_t>>();
        // Bound initialization as well: constructing Gradient evaluates GPU
        // position projections before the first timed forward pass.
        std::signal(SIGALRM, deckard_power::deadline);
        alarm(static_cast<unsigned>(std::max(1.0, std::floor(19 - prior))));
        const auto start = deckard_power::Clock::now();
        aihider::Gradient model(argv[1]);
        alarm(0);
        const double preparation = std::chrono::duration<double>(
            deckard_power::Clock::now() - start).count();
        deckard_power::serve("mlx", [&] { return model.logit(ids, mask); }, preparation + prior);
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
