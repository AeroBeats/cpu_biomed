#!/usr/bin/env bash
# 国内服务器拉不动 Docker Hub 镜像时用这个脚本找一个能用的加速器。
#
#   bash fix-docker-mirror.sh --probe    只探测，不改系统
#   bash fix-docker-mirror.sh            探测 + 写入 /etc/docker/daemon.json + 重启 docker
#
# 如果你知道自己服务器的云厂商加速地址（阿里云控制台「镜像加速器」里那一串
# https://xxxxxxxx.mirror.aliyuncs.com），加到 EXTRA_MIRRORS 里，它排在最前面。

set -uo pipefail

EXTRA_MIRRORS="${EXTRA_MIRRORS:-}"

CANDIDATES=(
  # 云厂商内网加速器：只有在对应厂商的机器上才通，其余会自动被探测淘汰
  "https://mirror.ccs.tencentyun.com"
  # 公共加速器（2026-10 时点仍在提供服务，随时可能失效，所以靠探测筛）
  "https://docker.m.daocloud.io"
  "https://docker.1panel.live"
  "https://docker.1ms.run"
  "https://docker.xuanyuan.me"
  "https://dockerproxy.net"
  "https://free.hubfast.cn"
)

# 探针镜像：整个部署里最小的一个，拉成功就说明这条源真能用（不只是 /v2/ 活着）
CANARY="library/nginx:1.27-alpine"
PROBE_TIMEOUT=8
PULL_TIMEOUT=180

for m in $EXTRA_MIRRORS; do CANDIDATES=("$m" "${CANDIDATES[@]}"); done

say() { printf '%s\n' "$*"; }

command -v curl >/dev/null || { say "缺 curl，先装：apt install -y curl"; exit 1; }
command -v docker >/dev/null || { say "缺 docker"; exit 1; }

say "== 第一步：探测 ${#CANDIDATES[@]} 个候选源的 /v2/ 接口 =="
ALIVE=()
for m in "${CANDIDATES[@]}"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$PROBE_TIMEOUT" "$m/v2/" 2>/dev/null)
  # 200 = 开放；401/403 = 需要 token 流程但服务活着；000 = 连不上
  case "$code" in
    200|401|403) say "  活着  $m  (HTTP $code)"; ALIVE+=("$m") ;;
    *)           say "  不通  $m  (HTTP ${code:-000})" ;;
  esac
done

if [ "${#ALIVE[@]}" -eq 0 ]; then
  say ""
  say "没有任何候选源可达。可能是："
  say "  1. 服务器出网被安全组/防火墙限制 —— 检查能不能 curl -I https://www.baidu.com"
  say "  2. 这批公共源刚好都挂了 —— 去云厂商控制台拿内网加速地址，用 EXTRA_MIRRORS 传进来："
  say "     EXTRA_MIRRORS='https://xxxxxxxx.mirror.aliyuncs.com' bash $0"
  exit 1
fi

if [ "${1:-}" = "--probe" ]; then
  say ""
  say "只做探测，未改动系统。可达的源：${ALIVE[*]}"
  exit 0
fi

say ""
say "== 第二步：真实拉取 $CANARY 验证（最多 ${PULL_TIMEOUT}s/个）=="
WORKING=()
for m in "${ALIVE[@]}"; do
  say "  试 $m ..."
  if timeout "$PULL_TIMEOUT" docker pull "$m/$CANARY" >/dev/null 2>&1; then
    say "    成功"
    WORKING+=("$m")
    # 留一份本地 tag，后面 compose 直接命中缓存
    docker tag "$m/$CANARY" "nginx:1.27-alpine" 2>/dev/null
  else
    say "    失败"
  fi
  [ "${#WORKING[@]}" -ge 3 ] && break
done

if [ "${#WORKING[@]}" -eq 0 ]; then
  say ""
  say "所有源都连得上但拉不动镜像（典型的限流/未登录）。改用云厂商内网加速地址重试。"
  exit 1
fi

say ""
say "== 第三步：写入 /etc/docker/daemon.json =="
DAEMON_JSON=/etc/docker/daemon.json
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

if [ -f "$DAEMON_JSON" ]; then
  $SUDO cp "$DAEMON_JSON" "$DAEMON_JSON.bak.$(date +%s)"
  say "  已备份原文件"
fi

# 用 python3 合并，避免把已有的 log-opts / data-root 等配置覆盖掉
MIRRORS_JSON=$(printf '%s\n' "${WORKING[@]}" | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')

if ! command -v python3 >/dev/null; then
  say "  没有 python3，无法安全合并已有配置。请手动把下面这行加进 $DAEMON_JSON 的 registry-mirrors："
  say "    $MIRRORS_JSON"
  exit 1
fi

echo "$MIRRORS_JSON" | $SUDO python3 -c '
import json, os, sys
mirrors = json.load(sys.stdin)
path = "/etc/docker/daemon.json"
cfg = {}
if os.path.exists(path):
    with open(path) as f:
        txt = f.read().strip()
    cfg = json.loads(txt) if txt else {}
existing = cfg.get("registry-mirrors") or []
merged = list(dict.fromkeys(existing + mirrors))
cfg["registry-mirrors"] = merged
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
os.replace(tmp, path)
print("  registry-mirrors =", json.dumps(merged, ensure_ascii=False))
' || { say "  合并失败，已保留备份，未改动配置"; exit 1; }

say ""
say "== 第四步：重启 docker 并确认 =="
$SUDO systemctl restart docker && say "  docker 已重启"
$SUDO docker info 2>/dev/null | grep -A5 'Registry Mirrors' || true

say ""
say "现在回到部署目录继续："
say "  cd ~/cpubiomed/deploy && docker compose up -d --build"
