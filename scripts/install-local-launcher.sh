#!/usr/bin/env bash
set -euo pipefail
# 将 oc-switch 薄包装安装到 ~/bin（需 bun 与本仓库）
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${HOME}/bin"
TARGET="${BIN_DIR}/oc-switch"
mkdir -p "${BIN_DIR}"
cat > "${TARGET}" <<EOF
#!/usr/bin/env bash
exec bun run "${ROOT}/packages/cli/src/index.ts" "\$@"
EOF
chmod +x "${TARGET}"
echo "Installed: ${TARGET}"
echo "Ensure ${BIN_DIR} is on PATH, then: oc-switch start (or restart/stop)"
