#!/usr/bin/env bash
set -euo pipefail
base="$HOME/telecus-fiet"
repo="$base/TeleCUS"
cd -- "$repo"
for required in "$base/node24/bin/node" "$base/bin/cloudflared" "$base/ollama/bin/ollama" \
  "$base/node-red-runtime/node_modules/node-red/red.js" "$base/api.env" "$base/node-red.env" \
  "$repo/apps/backend/dist/main.js" "$repo/apps/frontend/dist/index.html"; do
  [[ -f "$required" ]] || { echo "Falta componente: $required" >&2; exit 1; }
done
"$base/node24/bin/node" --env-file="$base/api.env" scripts/check-agenda-readonly.cjs
mkdir -p "$HOME/.config/systemd/user" "$base/state/node-red"
for unit in telecus-app.service telecus-node-red.service telecus-ollama.service telecus-tunnel.service telecus-model-warmup.service telecus-model-warmup.timer; do
  install -m 0644 "deploy/linux-user/$unit" "$HOME/.config/systemd/user/$unit"
done
# Replace only the minimal probe and model services created for this FIET test.
systemctl --user stop telecus-fiet-ollama.service telecus-fiet-probe.service telecus-fiet-tunnel.service 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable telecus-app.service telecus-node-red.service telecus-ollama.service
systemctl --user enable --now telecus-model-warmup.timer
systemctl --user start telecus-app.service
echo 'Servicios locales instalados. Comprobar salud antes de iniciar telecus-tunnel.service.'
