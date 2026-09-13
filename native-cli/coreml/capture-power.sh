#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 || ! -d "$1" || -e "$1/power.plist" ]]; then
  echo "Usage: capture-power.sh <new comparison directory without power.plist>" >&2
  exit 1
fi
directory="$1"
samplers="tasks,cpu_power,gpu_power,ane_power,thermal"
echo "Authorize the bounded meter now; model preparation runs without administrator access."
sudo /usr/bin/powermetrics --samplers "$samplers" --show-process-gpu \
  --sample-rate 100 --sample-count 3 --buffer-size 0 --format plist \
  > "$directory/authorization-probe.plist"
echo "Authorized. Waiting for both models to be ready..."
for attempt in {1..300}; do
  if [[ -f "$directory/ready.json" ]]; then
    echo "Starting the three-minute capture. Please keep the Mac otherwise idle."
    sudo -n /usr/bin/powermetrics --samplers "$samplers" --show-process-gpu \
      --sample-rate 100 --sample-count 1800 --buffer-size 0 --format plist \
      > "$directory/power.plist"
    echo "Resident-model power capture complete."
    exit 0
  fi
  sleep 1
done
echo "Models were not ready within five minutes; no measurement capture started." >&2
exit 1
