# Shortcuts for the scripts and deckard commands in README.md and
# docs/LINUX.md; `make` lists them. Targets that run deckard build it first
# (BUILD) and use the build's binary (DECKARD); tests/makefile.test.mjs
# overrides those and EXPORT.
OS := $(shell uname -s)
DECKARD ?= native-cli/build/dist/bin/deckard
BUILD ?= build
EXPORT ?= export-onnx
# Where deckard install downloads the model and export-onnx writes model.onnx.
MODEL_CACHE ?= $(HOME)/.cache/deckard
LINUX_FIXTURES := native-cli/tests/fixtures/linux-reference.json

ifeq ($(OS),Linux)
# Linux tests and verifies both runtimes every time: Candle runs the
# checkpoint, ONNX Runtime model.onnx (exported once by export-onnx). They are
# hard-linked into a clean directory: MODEL_CACHE also holds the ONNX Runtime
# library, and verify refuses unpinned files in the model directory.
MODEL_DIR := native-cli/build/test-model
MODEL_FILES := config.json model.safetensors tokenizer.json model.onnx
MODEL := test-model
CANDLE_MODEL_DIR := native-cli/build/candle-model
CANDLE_FILES := config.json model.safetensors tokenizer.json
else
# macOS: the Core ML model of the active installation, when there is one.
MODEL_DIR ?= $(HOME)/Deckard/current/models
MODEL :=
endif

# Shell: recreates directory $(1) with hard links to files $(2) of the model
# cache (copies on another file system).
define link_model
rm -rf $(1) && mkdir -p $(1) && for file in $(2); do \
  [ -f "$(MODEL_CACHE)/$$file" ] || { echo "No $$file in $(MODEL_CACHE): make install-onnx downloads and exports the model." >&2; exit 1; }; \
  ln -f "$(MODEL_CACHE)/$$file" $(1)/ 2>/dev/null || cp "$(MODEL_CACHE)/$$file" $(1)/ || exit 1; \
done
endef

.DEFAULT_GOAL := help
.PHONY: help test test-js test-native build install install-candle install-onnx checkpoint export-onnx test-model verify verify-candle verify-onnx package clean

# Via http://marmelab.com/blog/2016/02/29/auto-documented-makefile.html
help: ## List the targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

test: test-js test-native ## Run every test suite this machine can run

test-js: ## Extension and script tests (npm test)
	npm test

# The native tests hard-link the model into TMPDIR, so it must be on the
# model's file system, which a tmpfs /tmp is not.
test-native: $(BUILD) $(MODEL) ## Native tests, with the model (Linux: Candle and ONNX Runtime)
	@mkdir -p native-cli/build/test-tmp
	@if [ -d "$(MODEL_DIR)" ]; then echo "Model tests use $(MODEL_DIR)."; \
	else echo "No model in $(MODEL_DIR): model tests are skipped (make install first)."; fi
	TMPDIR="$(CURDIR)/native-cli/build/test-tmp" \
	  DECKARD_BIN="$(abspath $(DECKARD))" $(if $(wildcard $(MODEL_DIR)),DECKARD_MODEL_DIR="$(abspath $(MODEL_DIR))") \
	  npm run test:native

# deckard is the native part (CLI and Chrome native-messaging host); the
# extension needs no build. The script builds for macOS (Core ML) and Linux.
build: ## Build deckard, the CLI and native host (scripts/build-native.sh; macOS and Linux)
	scripts/build-native.sh

ifeq ($(OS),Linux)
install: ## Install deckard and the extension (macOS); on Linux, choose install-candle or install-onnx
	@echo "Linux has two runtimes; install one of them:"
	@echo "  make install-candle  Candle: needs only the pinned 1.7 GB download; one CPU core, about 8 s per 512 tokens"
	@echo "  make install-onnx    ONNX Runtime: about 5x faster on several cores; exports model.onnx once (Python 3.14,"
	@echo "                       1.3 GB of packages, up to 10 GB memory, about 2 minutes on an i5-8500T) and uses 3.6 GB more disk"
	@echo "Switch any time by running the other one; both keep the downloaded files."
	@exit 1

# Without model.onnx in the model cache, a plain install is Candle (and
# downloads the checkpoint). With it, install from a directory that links only
# the checkpoint, so the export stays for install-onnx.
install-candle: $(BUILD) ## Install deckard with Candle (Linux)
	@if [ -f "$(MODEL_CACHE)/model.onnx" ]; then \
	  $(call link_model,$(CANDLE_MODEL_DIR),$(CANDLE_FILES)); \
	  echo "$(DECKARD) install --extension-dir extension --model-dir $(CANDLE_MODEL_DIR)"; \
	  $(DECKARD) install --extension-dir extension --model-dir $(CANDLE_MODEL_DIR); \
	else \
	  echo "$(DECKARD) install --extension-dir extension"; \
	  $(DECKARD) install --extension-dir extension; \
	fi

# The export reads the checkpoint, which only install downloads.
install-onnx: $(BUILD) checkpoint $(EXPORT) ## Install deckard with ONNX Runtime, exporting model.onnx first (Linux)
	$(DECKARD) install --extension-dir extension

checkpoint:
	@[ -f "$(MODEL_CACHE)/model.safetensors" ] || { echo "Downloading the checkpoint (deckard install, Candle until model.onnx is exported)."; \
	  $(DECKARD) install --extension-dir extension; }
else
install: $(BUILD)
	$(DECKARD) install --extension-dir extension
endif

export-onnx: ## Export the pinned model.onnx into the model cache (Linux; once, then a no-op; install-onnx runs it)
	scripts/export-onnx.sh "$(MODEL_CACHE)"

ifeq ($(OS),Linux)
test-model: $(EXPORT)
	@$(call link_model,$(MODEL_DIR),$(MODEL_FILES))

verify: verify-candle verify-onnx ## Check scores against the PyTorch reference on Candle and ONNX Runtime

verify-candle: $(BUILD) $(MODEL) ## verify on Candle (model.safetensors)
	$(DECKARD) verify --model $(MODEL_DIR) --fixtures $(LINUX_FIXTURES) --candle

verify-onnx: $(BUILD) $(MODEL) ## verify on ONNX Runtime (model.onnx)
	$(DECKARD) verify --model $(MODEL_DIR) --fixtures $(LINUX_FIXTURES) --onnx
else
verify:
	@echo "Nothing to verify on $(OS): the repository has reference logits only for the Linux model."
endif

package: $(BUILD) ## Package a macOS release (RELEASE_MODEL_DIR=<Core ML model>)
	@[ "$(OS)" = Darwin ] || { echo "make package builds the macOS release; it needs macOS." >&2; exit 1; }
	@[ -n "$(RELEASE_MODEL_DIR)" ] || { echo "Usage: make package RELEASE_MODEL_DIR=DIR" >&2; exit 1; }
	scripts/package-release.sh --model-dir "$(RELEASE_MODEL_DIR)"

clean: ## Remove build output (native-cli/build, dist, Candle's cargo test output)
	rm -rf native-cli/build dist native-cli/candle/target
