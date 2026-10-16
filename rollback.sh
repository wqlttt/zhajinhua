#!/usr/bin/env bash
#
# 回滚到上一次部署的版本
#
#   ./rollback.sh        回滚并重启
#
# deploy.sh 每次部署前会把线上文件备份到 $SERVER_DIR/.backup，
# 这个脚本把备份恢复回去。只保留一份备份，即只能回退一步。

set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=".deploy.env"
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"

SERVER_HOST="${SERVER_HOST:-}"
SERVER_PORT="${SERVER_PORT:-22}"
SERVER_USER="${SERVER_USER:-root}"
SERVER_DIR="${SERVER_DIR:-/opt/jinhua}"
SERVICE="${SERVICE:-jinhua}"

C_OK=$'\033[32m'; C_ERR=$'\033[31m'; C_WARN=$'\033[33m'; C_DIM=$'\033[2m'; C_0=$'\033[0m'
ok()   { echo "${C_OK}✓${C_0} $*"; }
err()  { echo "${C_ERR}✗${C_0} $*" >&2; }
warn() { echo "${C_WARN}!${C_0} $*"; }
step() { echo; echo "${C_DIM}── $* ──${C_0}"; }
die()  { err "$*"; exit 1; }

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=12 -p "$SERVER_PORT")

[[ -n "$SERVER_HOST" ]] || die "未配置 SERVER_HOST（见 .deploy.env）"

if ssh -o BatchMode=yes "${SSH_OPTS[@]}" "$SERVER_USER@$SERVER_HOST" true 2>/dev/null; then
  SSH_CMD=(ssh "${SSH_OPTS[@]}")
else
  [[ -n "${SERVER_PASSWORD:-}" ]] || die "密钥登录失败，且无 SERVER_PASSWORD"
  command -v sshpass >/dev/null || die "需要 sshpass"
  export SSHPASS="$SERVER_PASSWORD"
  SSH_CMD=(sshpass -e ssh "${SSH_OPTS[@]}")
fi
rsh() { "${SSH_CMD[@]}" "$SERVER_USER@$SERVER_HOST" "$@"; }

step "检查备份"
LIST=$(rsh "ls -1 '$SERVER_DIR/.backup' 2>/dev/null" || true)
[[ -n "$LIST" ]] || die "服务器上没有备份（$SERVER_DIR/.backup 为空）"
echo "$LIST" | sed 's/^/  /'

step "恢复"
rsh "
  set -e
  cd '$SERVER_DIR'
  chmod -R u+w .
  cp -p .backup/* ./
  chown -R root:jinhua . 2>/dev/null || true
  chmod -R a-w .
" || die "恢复失败"
ok "文件已恢复"

step "重启服务"
rsh "systemctl restart '$SERVICE'" || die "重启失败"
sleep 3

STATUS=$(rsh "systemctl is-active '$SERVICE'" || true)
if [[ "$STATUS" != "active" ]]; then
  err "回滚后服务仍未启动，日志："
  rsh "journalctl -u '$SERVICE' --no-pager -n 20 --output=cat" || true
  exit 1
fi

HEALTH=$(rsh "curl -s -m 5 http://127.0.0.1:8080/health" || true)
if echo "$HEALTH" | grep -q '"ok":true'; then
  ok "健康检查：$HEALTH"
else
  warn "健康检查异常：$HEALTH"
fi

echo
echo "${C_OK}已回滚${C_0}"
warn "本地代码未改动，如要同步请 git revert 或手动改回"
