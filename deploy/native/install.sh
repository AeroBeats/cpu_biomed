#!/usr/bin/env bash
# 不用 Docker 的原生部署：Node 20（npmmirror 下载）+ 发行版 PostgreSQL + nginx + systemd。
#
#   sudo bash deploy/native/install.sh
#
# 幂等，可以重复执行；重装只会更新 /opt/cpubiomed 下的代码，数据库里的题目和
# 后台编辑不受影响（schema.sql 全是 IF NOT EXISTS，灌种子也只在空库时发生）。
#
# 前置条件：deploy/.env 已按 deploy/.env.example 填好（口令用 openssl rand -hex 24 生成）。

set -euo pipefail

APP_DIR=/opt/cpubiomed
ENV_DIR=/etc/cpubiomed
ENV_FILE=$ENV_DIR/cpubiomed.env
SERVICE_USER=cpubiomed
SERVICE_NAME=cpubiomed

NPM_REGISTRY=https://registry.npmmirror.com
NODE_MIRROR=https://registry.npmmirror.com/-/binary/node
NODE_MAJOR=20

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
ENV_SRC="$SRC_ROOT/deploy/.env"

step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 脚本本身已是 root，用 runuser 降权到 postgres（util-linux 自带，不依赖 sudo）
as_postgres() { runuser -u postgres -- "$@"; }

# ---------- 0. 前置检查 ----------
step "检查前置条件"

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash $0"

if [ -f /etc/os-release ]; then . /etc/os-release; fi
case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) ok "${PRETTY_NAME:-未知发行版}" ;;
  *) die "这个脚本只支持 Debian / Ubuntu（apt）。当前：${PRETTY_NAME:-未知}" ;;
esac

[ -d "$SRC_ROOT/web" ]            || die "找不到 $SRC_ROOT/web，请在仓库根目录同级保留 web/ 和 deploy/"
[ -d "$SRC_ROOT/deploy/server" ]  || die "找不到 $SRC_ROOT/deploy/server"
[ -f "$SRC_ROOT/deploy/schema.sql" ] || die "找不到 deploy/schema.sql"
[ -f "$ENV_SRC" ] || die "缺少 $ENV_SRC —— 先执行：cp deploy/.env.example deploy/.env && chmod 600 deploy/.env，再填口令"

case "$(uname -m)" in
  x86_64)        NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *)             die "不支持的 CPU 架构：$(uname -m)" ;;
esac

# 读 .env：只取 KEY=VALUE，不 source，避免把口令文件当脚本执行
read_env() { sed -n "s/^$1=//p" "$ENV_SRC" | head -1 | tr -d '\r'; }

ADMIN_USER=$(read_env ADMIN_USER)
ADMIN_PASS=$(read_env ADMIN_PASSWORD)
DB_NAME=$(read_env POSTGRES_DB)
DB_USER=$(read_env POSTGRES_USER)
DB_PASS=$(read_env POSTGRES_PASSWORD)
HTTP_PORT=$(read_env HTTP_PORT); HTTP_PORT=${HTTP_PORT:-80}
# 可选：不填就从管理员口令派生会话密钥，代价是改口令会让所有人重新登录一次。
SESSION_SECRET=$(read_env SESSION_SECRET)

for pair in "ADMIN_USER:$ADMIN_USER" "ADMIN_PASSWORD:$ADMIN_PASS" \
            "POSTGRES_DB:$DB_NAME" "POSTGRES_USER:$DB_USER" "POSTGRES_PASSWORD:$DB_PASS"; do
  [ -n "${pair#*:}" ] || die ".env 里 ${pair%%:*} 是空的"
done

case "$ADMIN_PASS$DB_PASS" in
  *"openssl rand"*) die ".env 里的口令还是模板占位文字，先真正生成：openssl rand -hex 24" ;;
esac

[ "${#ADMIN_PASS}" -ge 8 ] || die "ADMIN_PASSWORD 至少 8 位，否则服务会拒绝启动"
[[ "$HTTP_PORT" =~ ^[0-9]+$ ]] || die "HTTP_PORT 必须是数字，当前：$HTTP_PORT"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9_.-]+$ ]] || die "ADMIN_USER 只能用字母数字和 . _ -"

# 库名和角色名会被拼进 SQL 标识符，限定成 Postgres 的普通标识符，
# 这样双引号包裹就足够安全，不用担心里面藏着引号。
[[ "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "POSTGRES_DB 只能是字母数字下划线、不以数字开头"
[[ "$DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "POSTGRES_USER 只能是字母数字下划线、不以数字开头"

# 口令只允许字母数字：它们要拼进 DATABASE_URL 连接串和 SQL 字面量，
# 特殊字符会被解析错，也可能破坏语句。openssl rand -hex 24 正好满足。
for pair in "ADMIN_PASSWORD:$ADMIN_PASS" "POSTGRES_PASSWORD:$DB_PASS"; do
  [[ "${pair#*:}" =~ ^[A-Za-z0-9]+$ ]] \
    || die "${pair%%:*} 只能是字母和数字（用 openssl rand -hex 24 生成，不要用 base64）"
done

if [ -n "$SESSION_SECRET" ]; then
  [[ "$SESSION_SECRET" =~ ^[A-Za-z0-9]+$ ]] && [ "${#SESSION_SECRET}" -ge 32 ] \
    || die "SESSION_SECRET 要是至少 32 位的字母数字（用 openssl rand -hex 32 生成），或者干脆留空"
fi

ok "配置读取完毕（站点端口 $HTTP_PORT，数据库 $DB_NAME，架构 $NODE_ARCH）"

export DEBIAN_FRONTEND=noninteractive

# ---------- 1. 系统依赖 ----------
step "安装系统依赖"
apt-get update -qq
apt-get install -y -qq curl ca-certificates xz-utils nginx >/dev/null
ok "nginx 已就位"

# ---------- 2. Node 20 ----------
step "准备 Node.js $NODE_MAJOR"
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge "$NODE_MAJOR" ]; then
  ok "已有 Node $(node -p process.versions.node)，跳过下载"
else
  curl -fsSL --max-time 60 -o "$TMP/SHASUMS256.txt" \
    "$NODE_MIRROR/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" \
    || die "拿不到 npmmirror 的 Node 版本清单，检查服务器出网"

  NODE_FILE=$(grep -oE "node-v${NODE_MAJOR}\.[0-9.]+-linux-${NODE_ARCH}\.tar\.xz" \
    "$TMP/SHASUMS256.txt" | head -1)
  [ -n "$NODE_FILE" ] || die "清单里没有 linux-${NODE_ARCH} 的 Node ${NODE_MAJOR} 包"

  printf '  下载 %s ...\n' "$NODE_FILE"
  curl -fsSL --max-time 600 -o "$TMP/$NODE_FILE" "$NODE_MIRROR/latest-v${NODE_MAJOR}.x/$NODE_FILE"

  # 装进 /usr/local 之前先校验，避免半截文件把系统 node 搞坏
  ( cd "$TMP" && grep " $NODE_FILE\$" SHASUMS256.txt | sha256sum -c - >/dev/null ) \
    || die "Node 安装包 sha256 校验失败，重新执行一次"

  tar -xJf "$TMP/$NODE_FILE" -C /usr/local --strip-components=1
  hash -r
  [ "$(node_major)" -ge "$NODE_MAJOR" ] || die "Node 安装后仍不可用"
  ok "Node $(node -p process.versions.node) 装到 /usr/local"
fi
NODE_BIN=$(command -v node)
command -v npm >/dev/null 2>&1 || die "找不到 npm。如果用发行版包装的 nodejs，请一并装 npm，或删掉系统 node 让脚本从 npmmirror 装完整版"

# ---------- 3. PostgreSQL ----------
step "准备 PostgreSQL"
if ! command -v pg_isready >/dev/null 2>&1; then
  apt-get install -y -qq postgresql >/dev/null
  ok "已安装 postgresql"
fi
systemctl enable --now postgresql >/dev/null 2>&1 || true

for _ in $(seq 1 30); do pg_isready -q && break; sleep 1; done
pg_isready -q || die "PostgreSQL 起不来，看 journalctl -u postgresql"
ok "$(psql --version 2>/dev/null || echo PostgreSQL) 正在监听"

# 角色与库都用「不存在才建」，口令每次同步一次，方便以后轮换。
# SQL 走 stdin 而不是 -c，避免明文口令出现在 ps 的命令行里。
if ! as_postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  as_postgres psql -q -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE "$DB_USER" WITH LOGIN PASSWORD '$DB_PASS';
SQL
  ok "已创建角色 $DB_USER"
else
  as_postgres psql -q -v ON_ERROR_STOP=1 <<SQL
ALTER ROLE "$DB_USER" WITH LOGIN PASSWORD '$DB_PASS';
SQL
  ok "角色 $DB_USER 已存在，口令已同步"
fi

if ! as_postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  as_postgres createdb -O "$DB_USER" "$DB_NAME"
  ok "已创建数据库 $DB_NAME"
else
  ok "数据库 $DB_NAME 已存在"
fi

# 必须以应用账号的身份建表：用 postgres 超级用户建的话表归 postgres 所有，
# 运行时应用连的是 $DB_USER，所有写操作都会 permission denied。
if ! PGPASSWORD="$DB_PASS" psql -q -v ON_ERROR_STOP=1 \
       -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -f "$SRC_ROOT/deploy/schema.sql"; then
  die "以 $DB_USER 身份建表失败。若报认证错误，检查 /etc/postgresql/*/main/pg_hba.conf
    是否允许 127.0.0.1 用 scram-sha-256 登录（Debian 默认允许）"
fi

# 兜底核对：public 下所有表都必须归应用账号
BAD_OWNER=$(as_postgres psql -tA -d "$DB_NAME" -c \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner <> '$DB_USER'")
[ "$BAD_OWNER" = 0 ] || die "public 下有 $BAD_OWNER 张表不归 $DB_USER 所有，执行：
    sudo -u postgres psql -d $DB_NAME -c 'REASSIGN OWNED BY postgres TO \"$DB_USER\";'"
ok "表结构已就绪，全部归 $DB_USER 所有（schema.sql 全是 IF NOT EXISTS，重复执行安全）"

# ---------- 4. 部署代码 ----------
step "部署代码到 $APP_DIR"
id -u "$SERVICE_USER" >/dev/null 2>&1 \
  || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"

mkdir -p "$APP_DIR"
# 整目录替换，避免上次部署的残留文件混进来。数据库内容不在这里，不会丢。
rm -rf "$APP_DIR/web" "$APP_DIR/deploy"
cp -a "$SRC_ROOT/web" "$APP_DIR/web"
cp -a "$SRC_ROOT/deploy" "$APP_DIR/deploy"
rm -f "$APP_DIR/deploy/.env"          # 明文口令只留在 /etc/cpubiomed，不复制到 /opt
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
ok "web/ 与 deploy/ 已就位，副本里的 .env 已删除"

cd "$APP_DIR/deploy/server"
npm install --omit=dev --no-audit --no-fund --registry "$NPM_REGISTRY" >/dev/null
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/deploy/server/node_modules"
ok "依赖已安装（pg）"

# ---------- 5. 服务配置 ----------
step "写入服务配置"
install -d -m 750 -o root -g root "$ENV_DIR"
( umask 077; cat > "$ENV_FILE" <<EOF
PORT=8080
HOST=127.0.0.1
SITE_ROOT=$APP_DIR/web
DATABASE_URL=postgres://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME
ADMIN_USER=$ADMIN_USER
ADMIN_PASSWORD=$ADMIN_PASS
EOF
  if [ -n "$SESSION_SECRET" ]; then echo "SESSION_SECRET=$SESSION_SECRET" >> "$ENV_FILE"; fi
)
chmod 600 "$ENV_FILE"
ok "$ENV_FILE（600，仅 root 可读）"

sed -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__USER__|$SERVICE_USER|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$SCRIPT_DIR/cpubiomed.service" > "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1
systemctl restart "$SERVICE_NAME"
ok "systemd 服务 $SERVICE_NAME 已启动并设为开机自启"

if [ -d /etc/nginx/sites-enabled ]; then
  sed "s|__HTTP_PORT__|$HTTP_PORT|g" "$SCRIPT_DIR/nginx-site.conf" \
    > /etc/nginx/sites-available/$SERVICE_NAME
  ln -sf "/etc/nginx/sites-available/$SERVICE_NAME" "/etc/nginx/sites-enabled/$SERVICE_NAME"
  rm -f /etc/nginx/sites-enabled/default      # 它默认占着 80，会和站点冲突
else
  sed "s|__HTTP_PORT__|$HTTP_PORT|g" "$SCRIPT_DIR/nginx-site.conf" \
    > "/etc/nginx/conf.d/$SERVICE_NAME.conf"
  rm -f /etc/nginx/conf.d/default.conf
fi
nginx -t >/dev/null
systemctl enable --now nginx >/dev/null 2>&1
systemctl reload nginx
ok "nginx 已监听 $HTTP_PORT 并反代到 127.0.0.1:8080"

# ---------- 6. 自检 ----------
step "自检"
sleep 2

if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager
  die "服务没起来，上面是最近 30 行日志"
fi
ok "systemd: active"

HEALTH=$(curl -fsS --max-time 10 http://127.0.0.1:8080/healthz || echo '')
[ "$HEALTH" = '{"ok":true}' ] || die "healthz 返回异常：${HEALTH:-无响应}"
ok "healthz: $HEALTH"

# 页面公开可读：浏览和做题都不需要登录，登录只在同步进度、管理内容时才要。
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$HTTP_PORT/")
[ "$CODE" = 200 ] || die "首页应返回 200（公开可读），实际 $CODE"
ok "首页公开可读，返回 200"

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  "http://127.0.0.1:$HTTP_PORT/functions/v1/app?action=progress")
[ "$CODE" = 401 ] || die "未登录读进度应返回 401，实际 $CODE"
ok "未登录访问进度接口返回 401，登录校验生效"

# 管理员由 .env 在启动时落库；这一步没成功的话谁都登不进去。
ADMIN_ROLE=$(as_postgres psql -tA -d "$DB_NAME" -c \
  "SELECT role FROM app_users WHERE username = lower('$ADMIN_USER')" 2>/dev/null || echo '')
[ "$ADMIN_ROLE" = admin ] || die "管理员账号 $ADMIN_USER 没有落库（当前：${ADMIN_ROLE:-查不到}），
    看 journalctl -u $SERVICE_NAME -n 30"
ok "管理员账号 $ADMIN_USER 已落库，角色 admin"

BANK=$(curl -fsS --max-time 30 -u "$ADMIN_USER:$ADMIN_PASS" \
  "http://127.0.0.1:$HTTP_PORT/functions/v1/app?action=bank" || echo '')
[ -n "$BANK" ] || die "题库接口无响应"
printf '%s' "$BANK" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const b=JSON.parse(s);
  console.log(`  ✓ 题库 ${b.questions.length} 题 / ${b.chapters.length} 章节 / ${b.cards.length} 卡`
    + (b.truncated ? "（截断！）" : ""));
});'

as_postgres psql -tA -d "$DB_NAME" -c \
  "SELECT '  ✓ 数据库 questions=' || count(*) FROM questions" 2>/dev/null || true

cat <<DONE

部署完成。

  站点        http://<服务器IP>$([ "$HTTP_PORT" = 80 ] || echo ":$HTTP_PORT")/
  管理员账号  $ADMIN_USER（口令见 $ENV_FILE）
  日志        journalctl -u $SERVICE_NAME -f
  重启        systemctl restart $SERVICE_NAME

下一步（在你自己电脑的浏览器里做）：
  1. 打开站点，右下角「登录 / 注册」里用上面的管理员账号登录，
     登录后导航里会自动出现「内容管理」
  2. 迁移学习进度：见 deploy/README.md 第 7a 节
  3. 配 HTTPS：见 deploy/README.md 第 8 节
DONE
