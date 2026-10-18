# 迁移到自己的云服务器

把「药大生医 · 初试复习台」从 Qoder Sites 搬到你自己租的服务器上。搬完之后以服务器为准，
Qoder 站点保留但不再更新，作为回退备份。

迁移范围：前端页面 + 题库后台接口 + 数据库结构 + 现有内容（353 题 / 32 章 / 89 卡）。

---

## 1. 迁移后有什么变化

| | Qoder Sites（现在） | 你的服务器（迁移后） |
| --- | --- | --- |
| 前端 | 平台托管的静态文件 | nginx 反代 → Node 直接托管 `web/` |
| 题库接口 | Deno Function，路径 `/functions/v1/app` | Node 服务，**路径不变**，所以前端一行没改 |
| 登录方式 | Qoder 账号，由平台网关判定身份 | HTTP Basic 口令，打开站点时浏览器弹窗输入一次 |
| 数据库 | 平台托管的 PostgreSQL（`app` schema） | 你自己的 PostgreSQL 16 容器（`public` schema） |
| 访问控制 | 站点设为私有，只有受邀者能进 | 整站（含静态文件）都在口令之后 |
| 学习进度 | 存在浏览器 localStorage，绑定 qoder.website 域名 | 存在浏览器 localStorage，绑定你的新域名 |

**进度数据不会自己跟过来**——它绑域名。搬迁办法见第 7 节。

`functions/` 目录是 Qoder 那一侧的实现，迁移后冻结不再维护；服务器这一侧的实现在 `deploy/server/`。
两边的字段校验规则目前是一致的，但从此各改各的。

---

## 2. 目录结构

```
deploy/
├── docker-compose.yml      nginx + api + postgres 三个服务
├── schema.sql              建表语句，数据库首次初始化时自动执行
├── .env.example            口令模板，复制成 .env 后填写
├── nginx/site.conf         反向代理配置，含 HTTPS 段落（默认注释）
├── server/                 Node 服务（认证 / 静态托管 / 题库接口 / 首启灌入）
│   └── content.json        种子数据，由 tools/build-seed.mjs 生成
├── tools/
│   ├── build-seed.mjs      从 web/data 重新生成 content.json
│   ├── export-from-qoder.js  在 Qoder 站点控制台里运行，导出云端题库 + 进度
│   └── import-bundle.mjs   把导出文件转成 content.json 和进度恢复脚本
└── migrate/                导出/恢复用的中间文件（运行工具后生成）
```

---

## 3. 服务器准备

需要一台能 SSH 登录的 Linux 服务器，1 核 1G 内存就够（Postgres + Node + nginx 都很轻）。

装 Docker 和 Compose 插件（Debian / Ubuntu）：

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # 重新登录后生效
docker compose version          # 能打印版本就行
```

其他发行版按官方文档装 `docker-ce` 与 `docker-compose-plugin`。

**安全组 / 防火墙**：只放行 22（SSH）和 80/443（HTTP/HTTPS）。
数据库和题库接口都没有映射到宿主机端口，不要在防火墙里额外开放 5432 或 8080。

---

## 3b. 拉不动镜像（国内服务器几乎必踩）

本项目要拉三个 Docker Hub 官方镜像：`nginx:1.27-alpine`、`postgres:16-alpine`、
`node:20-alpine`。国内服务器直连 Docker Hub 通常超时或被重置，表现是
`docker compose up --build` 卡在 `pulling ...` 或报 `i/o timeout` / `connection reset`。

配一个镜像加速器就行。公共加速源经常失效，所以用仓库里的探测脚本让服务器自己挑：

```bash
# 先看哪些源活着，不改系统
bash deploy/tools/fix-docker-mirror.sh --probe

# 确认后真正配置（会真实拉一次 nginx 验证，然后合并写入 daemon.json 并重启 docker）
bash deploy/tools/fix-docker-mirror.sh
```

脚本会用 python3 合并 `/etc/docker/daemon.json`，不会覆盖你已有的
`log-opts`、`data-root` 等配置，改之前自动备份成 `daemon.json.bak.<时间戳>`。

**最可靠的一条路**是用你云厂商自己的加速地址（腾讯云/阿里云/华为云控制台里都有，
形如 `https://xxxxxxxx.mirror.aliyuncs.com`），它走内网，不受公共源限流影响：

```bash
EXTRA_MIRRORS='https://xxxxxxxx.mirror.aliyuncs.com' bash deploy/tools/fix-docker-mirror.sh
```

如果连加速器都配不上，还有个不依赖 daemon 配置的笨办法——手动带前缀拉再改名，
compose 之后会直接命中本地缓存：

```bash
M=https://docker.m.daocloud.io
docker pull $M/library/nginx:1.27-alpine    && docker tag $M/library/nginx:1.27-alpine    nginx:1.27-alpine
docker pull $M/library/postgres:16-alpine   && docker tag $M/library/postgres:16-alpine   postgres:16-alpine
docker pull $M/library/node:20-alpine       && docker tag $M/library/node:20-alpine       node:20-alpine
```

> 装 Docker 本身如果也卡住（`get.docker.com` 拉不动），改用阿里云的 docker-ce 源，
> 或者先在能翻墙的机器上 `docker save` 出 tar 包再 `scp` 上去 `docker load`。

---

## 4. 上传代码

服务器上只需要 `web/` 和 `deploy/` 两个目录，且**必须保持同级**
（compose 里用 `../web` 挂载前端）。

```bash
# 在你自己电脑上执行，把 <user>@<ip> 换成你的服务器
scp -r web deploy <user>@<ip>:~/cpubiomed/
```

注意：`deploy/server/content.json` 是构建镜像时要打进包里的，别漏。
`.env` 不要上传，下一步在服务器上直接生成。

---

## 5. 配置口令

```bash
ssh <user>@<ip>
cd ~/cpubiomed/deploy
cp .env.example .env
chmod 600 .env

# 生成两段随机口令填进去（用 hex，不要用 base64）
openssl rand -hex 24   # 给 ADMIN_PASSWORD
openssl rand -hex 24   # 给 POSTGRES_PASSWORD
nano .env
```

`.env` 里四个值：

- `ADMIN_USER` / `ADMIN_PASSWORD` —— 打开网站时浏览器弹窗要填的账号口令。
  整站（页面和题库接口）都在这个口令后面。**口令至少 8 位**，否则服务会拒绝启动。
- `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` —— 数据库口令，只在容器内网用，你不会直接碰。
- `HTTP_PORT` —— 对外端口，默认 80。

口令请用 `openssl rand -hex 24` 生成，**不要用 `base64`**：base64 会带出 `+` `/` `=`，
拼进 `DATABASE_URL` 连接串时会被解析错，表现为数据库连不上。

`.env` 是明文口令，`chmod 600`，不要提交进任何版本库、不要发给别人。

---

## 6. 启动与验证

```bash
cd ~/cpubiomed/deploy
docker compose up -d --build
docker compose ps            # 三个服务都应是 running / healthy
docker compose logs -f api   # 看到「复习台服务已启动」和「初始化灌入 474 条记录」
```

首次启动时数据库是空的，api 容器会自动把 `content.json` 灌进去（353 题 + 32 章 + 89 卡 = 474 条）。
**只在题库表为空时灌入**，之后重启不会覆盖你在后台改过的内容。

### 验证清单

打开 `http://<服务器IP>/`，浏览器弹出登录框，填 `.env` 里的 `ADMIN_USER` / `ADMIN_PASSWORD`：

- [ ] 首页正常显示，侧边栏四个科目都在
- [ ] 「刷题训练」里生物化学 64 题、分析化学 132 题，章节筛选能看到「2025 年真题」等
- [ ] 「背诵卡」角标显示 89
- [ ] 「考纲速查」「复习计划」「费曼讲解」都能打开
- [ ] 「内容管理」→ 点「启用后台管理」→ 提示已启用（这一步把所有者身份写进新库）
- [ ] 在后台新增一道测试题 → 刷新页面 → 题还在
- [ ] 删掉那道测试题
- [ ] 退出登录（关掉所有该站点标签页再打开，或清一次站点数据）→ 会重新弹登录框
- [ ] 直接访问 `http://<服务器IP>:8080/` 应该连不上（接口没暴露到公网）

命令行侧的检查：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/          # 401（没带口令）
curl -s -o /dev/null -w '%{http_code}\n' -u "$ADMIN_USER:$ADMIN_PASSWORD" http://localhost/   # 200
curl -s -u "$ADMIN_USER:$ADMIN_PASSWORD" 'http://localhost/functions/v1/app?action=bank' | head -c 200
```

---

## 7. 把云端数据和学习进度带过来

### 7a. 学习进度（刷题记录、错题本、卡片进度、打卡天数）

进度存在浏览器 localStorage 里，**绑定域名**，换域名就看不到了。搬迁步骤：

1. 用你平时刷题的那个浏览器打开 https://cpu-biomed-q1r9t5025uh.qoder.website/ 并登录；
2. F12 → Console，把 `deploy/tools/export-from-qoder.js` 的**全部内容**粘贴进去回车；
3. 浏览器会下载一个 `qoder-export-YYYY-MM-DD.json`，控制台同时打印云端与本地内容的差异；
4. 把这个文件放到本地电脑的 `deploy/migrate/` 目录，运行：
   ```bash
   node deploy/tools/import-bundle.mjs deploy/migrate/qoder-export-2026-10-16.json
   ```
   它会生成 `deploy/migrate/restore-progress.js`；
5. 打开**新站点**，F12 → Console，把 `restore-progress.js` 全部内容粘贴运行，然后刷新页面。

进度就回来了。这一步随时可以做，不影响网站先用起来。

### 7b. 后台手动加过的题

第 4 步运行时脚本会打印差异。**如果「仅云端有」是 0**，说明云端内容和仓库里的
`web/data/*.js` 完全一致，`content.json` 已经是全的，什么都不用做。

**如果「仅云端有」大于 0**，说明你在后台加过题、这些内容只存在云端。
这时 `import-bundle.mjs` 已经把云端题库写进了 `deploy/server/content.json`，
把它重新传到服务器并重建镜像：

```bash
scp deploy/server/content.json <user>@<ip>:~/cpubiomed/deploy/server/
ssh <user>@<ip> 'cd ~/cpubiomed/deploy && docker compose up -d --build api'
```

> 不想开控制台的话，网站「内容管理」里本来就有「导出全部内容 JSON」按钮，
> 下载的文件 `import-bundle.mjs` 也认（会自动识别 `format: cpu-biomed-bank/1`）。
> 区别是那个按钮只导内容、不含学习进度，而且不带 `built_in` 标记，
> 你手动加的题在新站点上会显示成「内置」。要用控制台脚本才能连进度一起带走。

注意：只有题库表**完全为空**时才会自动灌入。如果新库已经有数据了，改用后台的
「一键上传」按钮补，或者先清空再重启：

```bash
# 会删掉新服务器上所有题目和后台编辑，确认后再执行
docker compose exec db psql -U cpubiomed -d cpubiomed \
  -c 'TRUNCATE questions, syllabus_chapters, cards RESTART IDENTITY;'
docker compose restart api
```

---

## 8. HTTPS（建议做）

现在是明文 HTTP，口令在网络上是可被窃听的。有域名的话按下面走；只有 IP 的话，
至少把 `ADMIN_PASSWORD` 当成一次性口令，别和其他账号复用。

```bash
# 1. 域名 A 记录指向服务器 IP，等生效
# 2. 在服务器上签证书（先用 webroot 方式，需要 80 端口可访问）
sudo apt install -y certbot
sudo mkdir -p ~/cpubiomed/deploy/nginx/certbot
# 临时把 nginx 的 certbot 目录挂上（docker-compose.yml 里已留好注释行，放开即可）
sudo certbot certonly --webroot -w ~/cpubiomed/deploy/nginx/certbot \
  -d your-domain.example --agree-tos -m you@example.com

# 3. 编辑 deploy/nginx/site.conf：
#    - 放开文件末尾整段 443 的 server 块，把 your-domain.example 换成你的域名
#    - 把 80 端口那个 server 里的 location / 换成：return 301 https://$host$request_uri;
#      （保留 /.well-known/acme-challenge/ 那段，续期要用）
# 4. 编辑 docker-compose.yml：放开 443 端口和 /etc/letsencrypt 挂载
# 5. 重启
docker compose restart web

# 续期（certbot 会自动续，但要让 nginx 重载证书）
sudo certbot renew --deploy-hook "docker compose -f ~/cpubiomed/deploy/docker-compose.yml restart web"
```

---

## 9. 日常维护

```bash
cd ~/cpubiomed/deploy

docker compose logs -f api          # 看接口日志
docker compose logs -f web          # 看 nginx 访问日志
docker compose restart api          # 改了 deploy/server/ 下的代码后
docker compose up -d --build api    # 改了 package.json 或 content.json 后

# 备份数据库（建议配个 cron，每天一份，留最近 14 天）
docker compose exec -T db pg_dump -U cpubiomed -d cpubiomed | gzip > backup-$(date +%F).sql.gz

# 恢复
gunzip -c backup-2026-10-16.sql.gz | docker compose exec -T db psql -U cpubiomed -d cpubiomed
```

**改前端内容**（`web/` 下的文件）：`web/` 是以只读方式挂进容器的，改完刷新页面就生效，
不用重启、不用重建镜像。

**加题目**有两条路：
- 在网站的「内容管理」里手动加 —— 立即生效，只进数据库；
- 改 `web/data/questions_extra.js` 之类的内容文件 —— 静态兜底数据变了，但**数据库不会自动跟着变**，
  需要在「内容管理」里点一次「一键上传」（只插不改，不会覆盖你已有的编辑）。

**改口令**：编辑 `.env` 里的 `ADMIN_PASSWORD`，然后 `docker compose up -d api`。
所有者身份固定记作 `admin`，改用户名或口令都不会把自己锁在门外。

---

## 10. 回退到 Qoder 站点

Qoder 站点还在，随时可以用 https://cpu-biomed-q1r9t5025uh.qoder.website/ 顶回去。
但要注意：**服务器上新加的题不会自动同步回 Qoder 云端**，两边从此刻起各自独立。
如果打算长期以服务器为准，Qoder 那边就当成只读快照，别再在两边同时改内容。

---

## 11. 需要你知道的边界

- **本地验证做到哪一步**：接口逻辑用内存数据库替身跑过 93 项断言（认证、路径穿越防护、
  全部 action、全部字段校验、353 条真实种子数据灌入、幂等性、后台编辑不被覆盖），全部通过。
  **但没有在真实 Docker / 真实 PostgreSQL / 真实 nginx 上跑过**，本机没装 Docker。
  第 6 节的验证清单第一次在服务器上执行时，才是真正的端到端确认。
- **nginx 与 TLS 配置未经实机验证**，证书路径和续期钩子可能要按你的发行版微调。
- **前端有一处文案对不上**：`web/api.js` 里 401 的提示写的是「需要先登录 Qoder 账号」。
  自建部署下浏览器在打开页面时就已经弹过口令框了，正常操作走不到这个分支；
  万一看到这句话，实际含义是「口令没填对或被清掉了」。
- **内容版权**：题库里有真题和商业习题册的题目，默认整站加口令、不对外开放。
  别把它做成公开站点，也别分享给不特定人群。
- **口令强度**：HTTP Basic 在明文 HTTP 上等于把口令直接发出去。上 HTTPS 之前，
  `ADMIN_PASSWORD` 请当成随时可换的临时口令。
