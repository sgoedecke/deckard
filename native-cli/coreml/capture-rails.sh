#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 2 || ! -d "$1" || -e "$1/power.plist" || ! "$2" =~ ^[0-9]+$ ]]; then
  echo "Usage: capture-rails.sh <new measurement directory> <100ms sample count>" >&2
  exit 1
fi
if (( $2 < 100 || $2 > 2400 )); then
  echo "Sample count must be in 100..2400." >&2
  exit 1
fi
directory="$1"
count="$2"
samplers="cpu_power,gpu_power,ane_power,thermal"
echo "Authorize only the bounded power meter; model workers remain unprivileged."
sudo /usr/bin/powermetrics --samplers "$samplers" --sample-rate 100 \
  --sample-count 3 --buffer-size 0 --format plist > "$directory/authorization-probe.plist"
for attempt in {1..240}; do
  if [[ -f "$directory/ready.json" ]]; then
    echo "Recording power. Please keep the Mac idle and its power source unchanged."
    sudo -n /usr/bin/powermetrics --samplers "$samplers" --sample-rate 100 \
      --sample-count "$count" --buffer-size 0 --format plist > "$directory/power.plist"
    echo "Power capture complete."
    exit 0
  fi
  sleep 1
done
echo "Model readiness timed out; no measurement capture started." >&2
exit 1
