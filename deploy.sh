#!/usr/bin/env bash
#
# 一键推送 + 部署
#
#   ./deploy.sh "提交说明"     提交改动、推 GitHub、部署到服务器
#   ./deploy.sh                沿用上次提交（无改动时只重新部署）
#   ./deploy.sh -n "说明"      只提交推送，不部署
#   ./deploy.sh -d             只部署当前代码，不碰 git
#
# 服务器连接信息从 .deploy.env 读取（见脚本末尾说明）。

set -euo pipefail

cd "$(dirname "$0")"

# ---------- 配置 ----------
ENV_FILE=".deploy.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

SERVER_HOST="${SERVER_HOST:-}"
SERVER_PORT="${SERVER_PORT:-22}"
SERVER_USER="${SERVER_USER:-root}"
SERVER_DIR="${SERVER_DIR:-/opt/jinhua}"
SERVICE="${SERVICE:-jinhua}"
HEALTH_URL="${HEALTH_URL:-}"

# 要部署的文件（node_modules 和测试不上传）
FILES=(cards.js table.js server.js index.html package.json package-lock.json README.md)

# ---------- 输出 ----------
C_OK=$'\033[32m'; C_ERR=$'\033[31m'; C_WARN=$'\033[33m'; C_DIM=$'\033[2m'; C_0=$'\033[0m'
ok()   { echo "${C_OK}✓${C_0} $*"; }
err()  { echo "${C_ERR}✗${C_0} $*" >&2; }
warn() { echo "${C_WARN}!${C_0} $*"; }
step() { echo; echo "${C_DIM}── $* ──${C_0}"; }
die()  { err "$*"; exit 1; }

# ---------- 参数 ----------
DO_GIT=1
DO_DEPLOY=1
MSG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--no-deploy) DO_DEPLOY=0; shift ;;
    -d|--deploy-only) DO_GIT=0; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \?//'; exit 0 ;;
    -*) die "未知参数 $1（-h 看用法）" ;;
    *) MSG="$1"; shift ;;
  esac
done

# ---------- SSH 封装 ----------
# 优先用密钥；没有密钥则用 .deploy.env 里的 SERVER_PASSWORD + sshpass
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=12 -p "$SERVER_PORT")
SCP_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=12 -P "$SERVER_PORT")

setup_auth() {
  [[ -n "$SERVER_HOST" ]] || die "未配置 SERVER_HOST，请先建 .deploy.env（运行 ./deploy.sh -h 看说明）"

  # 先试密钥登录
  if ssh -o BatchMode=yes "${SSH_OPTS[@]}" "$SERVER_USER@$SERVER_HOST" true 2>/dev/null; then
    SSH_CMD=(ssh "${SSH_OPTS[@]}")
    SCP_CMD=(scp "${SCP_OPTS[@]}")
    AUTH="密钥"
    return
  fi

  # 回退到密码
  [[ -n "${SERVER_PASSWORD:-}" ]] || die "密钥登录失败，且 .deploy.env 里没有 SERVER_PASSWORD"
  command -v sshpass >/dev/null || die "需要 sshpass：brew install sshpass（或改用 SSH 密钥）"
  export SSHPASS="$SERVER_PASSWORD"
  SSH_CMD=(sshpass -e ssh "${SSH_OPTS[@]}")
  SCP_CMD=(sshpass -e scp "${SCP_OPTS[@]}")
  AUTH="密码"
}

rsh() { "${SSH_CMD[@]}" "$SERVER_USER@$SERVER_HOST" "$@"; }

# ---------- 1. 本地检查 ----------
step "本地检查"

for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || die "缺少文件 $f"
done

# 语法检查，别把坏代码推上去
node --check server.js || die "server.js 语法错误"
node --check table.js  || die "table.js 语法错误"
node --check cards.js  || die "cards.js 语法错误"

# 客户端内嵌的 JS 也要查
node -e '
const fs=require("fs");
const html=fs.readFileSync("index.html","utf8");
const m=html.match(/<script>([\s\S]*?)<\/script>/);
if(!m){console.error("index.html 里找不到 script");process.exit(1)}
fs.writeFileSync(process.env.TMPDIR+"/jh_client.js",m[1]);
const ids=new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(x=>x[1]));
const refs=[...new Set([...m[1].matchAll(/\$\(.([^"\x27]+).\)/g)].map(x=>x[1]))];
const miss=refs.filter(r=>!ids.has(r)&&r!=="turnRing");
if(miss.length){console.error("index.html 引用了不存在的元素: "+miss.join(", "));process.exit(1)}
' || die "index.html 检查失败"
node --check "${TMPDIR:-/tmp}/jh_client.js" || die "index.html 内嵌 JS 语法错误"
rm -f "${TMPDIR:-/tmp}/jh_client.js"
ok "语法检查通过"

# 别把服务器凭证推到 public 仓库
if grep -rniE 'SERVER_PASSWORD=|ROOM_PASSWORD=[^$]' "${FILES[@]}" 2>/dev/null | grep -v 'process.env' | grep -q .; then
  die "代码里出现了明文凭证，先清掉再部署"
fi
ok "无明文凭证"

# 跑离线测试（不需要服务器）
if [[ -f test-bet.js ]]; then
  if node test-bet.js > /tmp/jh_test.log 2>&1; then
    ok "注额与加注测试通过（$(grep -o '通过 [0-9]*' /tmp/jh_test.log | tail -1)）"
  else
    tail -20 /tmp/jh_test.log
    die "测试未通过，部署中止"
  fi
fi

# ---------- 2. 提交并推送 ----------
if [[ $DO_GIT -eq 1 ]]; then
  step "提交并推送"

  if [[ -n "$(git status --porcelain)" ]]; then
    [[ -n "$MSG" ]] || die "有未提交的改动，请给出提交说明：./deploy.sh \"说明\""
    git add -A
    git commit -q -m "$MSG"
    ok "已提交：$MSG"
  else
    ok "工作区干净，沿用当前提交"
  fi

  if git remote get-url origin >/dev/null 2>&1; then
    if git push -q origin HEAD 2>/dev/null; then
      ok "已推送到 $(git remote get-url origin)"
    else
      warn "推送失败（继续部署本地代码）"
    fi
  else
    warn "未配置 git remote，跳过推送"
  fi
fi

COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

# ---------- 3. 部署 ----------
if [[ $DO_DEPLOY -eq 0 ]]; then
  echo; ok "完成（未部署）"
  exit 0
fi

step "连接服务器"
setup_auth
rsh true || die "无法连接 $SERVER_USER@$SERVER_HOST:$SERVER_PORT"
ok "已连接 ${SERVER_HOST}（${AUTH} 认证）"

# 记录当前线上版本，供回滚使用
step "备份当前版本"
rsh "
  set -e
  cd '$SERVER_DIR' 2>/dev/null || { echo 'NO_DIR'; exit 0; }
  rm -rf .backup
  mkdir -p .backup
  for f in $(printf '%s ' "${FILES[@]}"); do
    [ -f \"\$f\" ] && cp -p \"\$f\" .backup/ || true
  done
  echo 'BACKUP_OK'
" | grep -q BACKUP_OK && ok "已备份到 $SERVER_DIR/.backup" || warn "首次部署，无可备份内容"

step "上传文件"
# 目录是只读的（555），先放开写权限
rsh "mkdir -p '$SERVER_DIR' && chmod -R u+w '$SERVER_DIR'" >/dev/null
"${SCP_CMD[@]}" -q "${FILES[@]}" "$SERVER_USER@$SERVER_HOST:$SERVER_DIR/" \
  || die "上传失败"
ok "已上传 ${#FILES[@]} 个文件"

# 逐个比对校验和，确认传完整了
step "校验完整性"
LOCAL_SUM=$(for f in "${FILES[@]}"; do
  if command -v md5 >/dev/null; then echo "$(md5 -q "$f")  $f"; else md5sum "$f"; fi
done | sort)
REMOTE_SUM=$(rsh "cd '$SERVER_DIR' && md5sum $(printf '%s ' "${FILES[@]}")" | sort)

if [[ "$LOCAL_SUM" == "$REMOTE_SUM" ]]; then
  ok "${#FILES[@]} 个文件校验和一致"
else
  echo "--- 本地 ---"; echo "$LOCAL_SUM"
  echo "--- 远端 ---"; echo "$REMOTE_SUM"
  die "校验和不一致，上传可能不完整"
fi

step "安装依赖"
# 按 package-lock.json 的内容哈希判断，而不是时间戳——
# scp 每次都会刷新 mtime，用时间戳会导致每次都重装
DEPS=$(rsh "
  cd '$SERVER_DIR'
  SUM=\$(md5sum package-lock.json | cut -d' ' -f1)
  if [ ! -d node_modules ] || [ \"\$(cat .lock-sum 2>/dev/null)\" != \"\$SUM\" ]; then
    npm ci --omit=dev 2>&1 | tail -2
    chmod u+w . 2>/dev/null || true
    echo \"\$SUM\" > .lock-sum
    echo 'INSTALLED'
  else
    echo 'SKIPPED'
  fi
")
if echo "$DEPS" | grep -q INSTALLED; then
  ok "依赖已更新"
else
  ok "依赖无变化，跳过"
fi

step "重启服务"
rsh "
  chown -R root:jinhua '$SERVER_DIR' 2>/dev/null || true
  chmod -R a-w '$SERVER_DIR'
  systemctl restart '$SERVICE'
" || die "重启失败"
sleep 3

STATUS=$(rsh "systemctl is-active '$SERVICE'" || true)
if [[ "$STATUS" != "active" ]]; then
  err "服务未能启动，最近日志："
  rsh "journalctl -u '$SERVICE' --no-pager -n 15 --output=cat" || true
  echo
  warn "可用 ./rollback.sh 回滚到上一个版本"
  exit 1
fi
ok "服务运行中"

# ---------- 4. 验证 ----------
step "验证"

HEALTH=$(rsh "curl -s -m 5 http://127.0.0.1:8080/health" || true)
if echo "$HEALTH" | grep -q '"ok":true'; then
  ok "本机健康检查：$HEALTH"
else
  err "健康检查失败：$HEALTH"
  rsh "journalctl -u '$SERVICE' --no-pager -n 15 --output=cat" || true
  warn "可用 ./rollback.sh 回滚"
  exit 1
fi

# 外网可达性 + 真实开局（有配 HEALTH_URL 才测）
if [[ -n "$HEALTH_URL" ]]; then
  EXT=$(curl -s -m 10 "$HEALTH_URL" || true)
  if echo "$EXT" | grep -q '"ok":true'; then
    ok "外网可达：$HEALTH_URL"
  else
    warn "外网不可达（服务本身正常，可能是防火墙/安全组）"
  fi
fi

# 跑一局真实对局，确认不是只有 HTTP 活着
if [[ -f test-client.js ]]; then
  WS_URL="ws://${SERVER_HOST}:8080"
  # test-client.js 自带 30 秒兜底退出，macOS 没有 timeout 命令所以不外加
  if URL="$WS_URL" ROOM=9527 node test-client.js > /tmp/jh_e2e.log 2>&1; then
    ok "线上对局验证通过"
  else
    warn "线上对局验证未通过，日志：/tmp/jh_e2e.log"
    tail -6 /tmp/jh_e2e.log
  fi
fi

MEM=$(rsh "systemctl show -p MemoryCurrent --value '$SERVICE'" || echo 0)
[[ "$MEM" =~ ^[0-9]+$ ]] && ok "内存占用 $((MEM / 1048576))M"

echo
echo "${C_OK}部署完成${C_0}  提交 $COMMIT"
[[ -n "$HEALTH_URL" ]] && echo "${C_DIM}${HEALTH_URL%/health}${C_0}"
echo "${C_DIM}看日志: ssh $SERVER_USER@$SERVER_HOST journalctl -u $SERVICE -f${C_0}"
