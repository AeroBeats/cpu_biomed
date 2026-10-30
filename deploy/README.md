# 迁移到自己的云服务器

把「药大生医 · 初试复习台」从 Qoder Sites 搬到你自己租的服务器上。搬完之后以服务器为准，
Qoder 站点保留但不再更新，作为回退备份。

迁移范围：前端页面 + 题库后台接口 + 站内账号体系 + 数据库结构 + 现有内容（353 题 / 32 章 / 89 卡）。

> **两条部署路线，先选一条：**
>
> - **Docker Compose**（第 3–6 节）—— 一条命令起三个容器，最省事，但要从 Docker Hub
>   拉 `nginx` / `postgres` / `node` 三个镜像。**国内服务器经常拉不动**，见第 3b 节。
> - **原生部署**（第 3c 节）—— Node + 发行版 PostgreSQL + nginx + systemd，
>   **完全不碰 Docker Hub**，只需要 apt 和 npmmirror 能通。国内服务器建议直接走这条。
>
> 两条路线跑的是**同一份代码**（`deploy/server/`），前端一行都不用改，
> 数据迁移（第 7 节）、备份、加题目的方式也完全一样，只有起停命令不同。

---

## 1. 迁移后有什么变化

| | Qoder Sites（现在） | 你的服务器（迁移后） |
| --- | --- | --- |
| 前端 | 平台托管的静态文件 | nginx 反代 → Node 直接托管 `web/` |
| 题库接口 | Deno Function，路径 `/functions/v1/app` | Node 服务，**路径和 action 名都不变**，前端不用为迁移改任何东西 |
| 登录方式 | Qoder 账号，由平台网关判定身份 | 站内账号：`.env` 里的管理员 + 凭一次性邀请码注册的普通用户，登录页在 `#/account` |
| 数据库 | 平台托管的 PostgreSQL（`app` schema） | 你自己的 PostgreSQL（`public` schema），容器或系统服务均可 |
| 访问控制 | 站点设为私有，只有受邀者能进 | 页面和题库**公开可读**；只有「同步进度」「改内容」需要登录 |
| 学习进度 | 存在浏览器 localStorage，绑定 qoder.website 域名 | localStorage 为主，登录后再往服务器备一份快照，可跨设备找回 |
| 公式与配图 | 纯文本（那一侧已冻结，没有渲染公式的能力） | `$…$` / `$$…$$` / `\ce{}` 由自托管 KaTeX 渲染，管理员可在后台直接插图 |

**登录不是进站门槛。** 浏览、刷题、背卡片全都不需要账号；只有在「想把进度带到别的设备」
或「要改题库内容」时才需要登录。登录之后进度会自动同步到服务器，换设备登录同一个账号就能接着做。
旧的 Qoder 进度**不会自己跟过来**（它绑域名），一次性搬迁办法见第 7 节。

`functions/` 目录是 Qoder 那一侧的实现，迁移后冻结不再维护；服务器这一侧的实现在 `deploy/server/`。
两边对外的 action 名和错误码仍然一致（所以前端一行没改），但**账号体系是服务器独有的**：
Qoder 侧没有 `app_users`，身份由平台网关给。字段校验规则目前也一致，从此各改各的。

---

## 2. 目录结构

```
deploy/
├── docker-compose.yml      【Docker 路线】nginx + api + postgres 三个服务
├── schema.sql              建表语句（题库 / 考纲 / 背诵卡 / 账号 / 进度），两条路线共用
├── .env.example            口令模板，复制成 .env 后填写，两条路线共用
├── nginx/site.conf         【Docker 路线】反向代理配置，含 HTTPS 段落（默认注释）
├── native/                 【原生路线】不用 Docker 的安装套件
│   ├── install.sh          一键安装：Node + PostgreSQL + nginx + systemd
│   ├── cpubiomed.service   systemd 服务单元模板
│   └── nginx-site.conf     反向代理配置，upstream 指向 127.0.0.1:8080
├── server/                 Node 服务（认证 / 静态托管 / 题库接口 / 首启灌入），两条路线共用
│   ├── content.json        种子数据，由 tools/build-seed.mjs 生成
│   └── media.mjs           配图存储：文件头判类型、限 2 MB、拒 SVG
├── tools/
│   ├── build-seed.mjs      从 web/data 重新生成 content.json
│   ├── bank-template.json  批量导入模板，含公式与图片写法说明，照抄改内容即可
│   ├── check-bank.mjs      离线体检：导入前逐条报出编号、字段和原因
│   ├── export-from-qoder.js  在 Qoder 站点控制台里运行，导出云端题库 + 进度
│   ├── import-bundle.mjs   把导出文件转成 content.json 和进度恢复脚本
│   └── fix-docker-mirror.sh  【Docker 路线】探测可用的镜像加速器
└── migrate/                导出/恢复用的中间文件（运行工具后生成）
```

服务器上还有两个数据目录，**它们不在代码仓库里，备份时必须单独带上**（见第 9 节）：
PostgreSQL 数据本身，以及配图目录（原生部署 `/opt/cpubiomed/media`，Docker 的 `mediadata` 卷）。

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

也可以直接用你云厂商控制台给的加速地址（形如 `https://xxxxxxxx.mirror.aliyuncs.com`）：

```bash
EXTRA_MIRRORS='https://xxxxxxxx.mirror.aliyuncs.com' bash deploy/tools/fix-docker-mirror.sh
```

> **注意**：阿里云的「个人版」镜像加速器已经不再代理任意 Docker Hub 镜像了，
> 拉公共镜像会报 `not found`（不是超时，是它明确告诉你没有这个镜像）。
> 这不是你配错了，也换不掉。腾讯云 `mirror.ccs.tencentyun.com` 只在腾讯云内网可达，同样可能受限。

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

**上面这些都不行的话，别继续耗了，直接走第 3c 节。** 这个项目对容器没有任何真实依赖：
后端就是个原生 Node 应用、只有一个 `pg` 依赖，数据库用发行版自带的 PostgreSQL 就行。
Docker Hub 是这条路上唯一的死结，绕开它比打通它容易得多。

---

## 3c. 原生部署（不用 Docker，国内服务器推荐）

**适用条件**：Debian / Ubuntu，能访问 apt 源和 `registry.npmmirror.com`。先确认：

```bash
curl -s -o /dev/null -w 'apt 源     %{http_code}\n' --max-time 10 http://deb.debian.org/debian/
curl -s -o /dev/null -w 'npmmirror %{http_code}\n' --max-time 15 https://registry.npmmirror.com/pg
```

两个都不是 `000` 就能走这条路。

**安装脚本会做这些事**：从 npmmirror 下载 Node 20 官方二进制（带 sha256 校验）→
用发行版 PostgreSQL 建库建表 → 把 `web/` 和 `deploy/` 复制到 `/opt/cpubiomed` →
`npm install` 装 `pg` → 写 systemd 服务（专用低权限用户、只读运行、开机自启）→
装 nginx 反代并开 gzip → 自检（首页公开可读、未登录访问进度接口返回 401、管理员账号已落库、
题库条数）并打印结果。

```bash
# 1. 上传代码（在你自己电脑上执行）
scp -r web deploy <user>@<ip>:~/cpubiomed/

# 2. 登录服务器配口令（和第 5 节完全一样，两条路线共用这个 .env）
cd ~/cpubiomed
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
openssl rand -hex 24    # 跑两次，分别填 ADMIN_PASSWORD 和 POSTGRES_PASSWORD
                        # 想固定会话密钥就再跑一次 openssl rand -hex 32 填 SESSION_SECRET，否则留空
nano deploy/.env

# 3. 一键安装
sudo bash deploy/native/install.sh
```

装完脚本会自己跑一遍自检，看到 `✓ 题库 353 题 / 32 章节 / 89 卡` 就成了。
接着按第 6 节的验证清单在浏览器里过一遍（除了 `docker compose` 那几条，其余都适用）。

**几个要知道的点**：

- **幂等**：`install.sh` 可以重复执行，也是日后的更新方式。它只替换 `/opt/cpubiomed`
  下的代码，**不动已有数据**——你在后台加的题、改过的内容都还在。每次都会重跑一遍
  `schema.sql`，全是 `IF NOT EXISTS`，所以新版本加的表（`app_users`、`user_progress`）
  会自动补上。Docker 路线不一样：`schema.sql` 只在数据卷**第一次**初始化时执行，
  升级后要手动补一次，见第 9 节。
- **口令落盘位置**：`deploy/.env` 只在安装时用一次。脚本会生成
  `/etc/cpubiomed/cpubiomed.env`（权限 600，仅 root 可读）给 systemd 用，
  并**删掉复制进 `/opt` 的那份 `.env`**。
- **口令格式**：只允许字母和数字。脚本会拦下 base64 和带特殊字符的口令——
  它们要拼进 `DATABASE_URL` 连接串，特殊字符会被解析错。用 `openssl rand -hex 24`。
- **题库接口只监听 `127.0.0.1:8080`**，公网流量必须经 nginx。安全组仍只放行 22 和 80/443。
- **PostgreSQL 版本无所谓**：Debian 13 自带 17，`schema.sql` 全是基础类型和
  `IF NOT EXISTS`，16/17 都能跑；已有数据的实例不会被覆盖。
- **前端内容更新**：`web/` 是复制过去的，不像 Docker 那样挂载，所以改完要重跑
  `sudo bash deploy/native/install.sh`（或直接 `scp` 覆盖 `/opt/cpubiomed/web/`）。

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

> 第 4–6 节是 **Docker 路线**。走原生部署的话，上传和配口令已经在第 3c 节里做过了，
> 只需要看第 6 节的「验证清单」，日常维护看第 9 节的原生部分。

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

`.env` 里的值：

- `ADMIN_USER` / `ADMIN_PASSWORD` —— **管理员账号**，服务启动时会自动同步进 `app_users`
  表（`role = admin`）。用这个账号登录后，导航里会自动出现「内容管理」；普通用户看不到那一项。
  改这里的口令再重启就会重新同步，不会把自己锁在门外。**口令至少 8 位**，否则服务拒绝启动。
- `SESSION_SECRET`（可选）—— 会话 Cookie 的签名密钥，**至少 32 位字母数字**，
  用 `openssl rand -hex 32` 生成。**留空就自动从 `ADMIN_PASSWORD` 派生**，日常可以不管；
  代价是日后改管理员口令会让所有人重新登录一次。填了它，改口令就不影响已登录的会话。
- `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` —— 数据库口令，只在容器内网用，你不会直接碰。
- `HTTP_PORT` —— 对外端口，默认 80。
- `MEDIA_DIR` —— **不用填**。题库配图的存放目录两条路线都已经写死了：原生部署由
  `install.sh` 建成 `/opt/cpubiomed/media`，Docker 用 `mediadata` 卷挂到容器内 `/app/media`。
  只有手动 `node deploy/server/index.mjs` 起服务时才需要自己 `export MEDIA_DIR=/某个可写目录`；
  不设也能启动，只是插图接口会回 `upload_unavailable`。

普通用户不需要你建账号，但**需要你先发一个邀请码**：注册是邀请制的（`#/account` 页），
注册进来就是 `role = user`，只能同步自己的学习进度，碰不到题库内容。邀请码不需要在 `.env`
里配任何东西，发码流程见第 5b 节。要把某人提成管理员，在数据库里改 `app_users.role`
（见第 9 节）。

口令请用 `openssl rand -hex 24` 生成，**不要用 `base64`**：base64 会带出 `+` `/` `=`，
拼进 `DATABASE_URL` 连接串时会被解析错，表现为数据库连不上。

`.env` 是明文口令，`chmod 600`，不要提交进任何版本库、不要发给别人。

---

## 5b. 发邀请码，让别人注册进来

注册是邀请制的：没有码就注册不了。码由管理员在网页里生成，存在 `invite_codes` 表，
**一次性**——谁用过、什么时候用的都记在码上。

1. 用管理员账号登录 → 导航「内容管理」→ 顶部切到「注册邀请码」这一栏。
2. 备注框里写这个码是给谁的（例如「发给张三 · 药学一班」，只是给你自己看的，可以留空），
   点「生成一个」。列表里会多出一行，码显示成 `4T9K-M2XH` 这样每 4 位断一下，方便照着念、照着抄。
3. 把码发给对方。对方打开站点 → 左下角「登录 / 注册」→ 切到「注册新账号」→ 把码填进去，
   注册完直接就是登录状态。
4. 回到「注册邀请码」页点「重新读取」，那一行会变成「已用 · 日期 · 用户名」。

几个要知道的点：

- **一个码只能用一次。** 对方注册成功后码就作废，下一个人要重新生成一个。
- **手抄容错**：码里没有 `I` `L` `O` `U` 四个字母，`0`/`O`、`1`/`I`、`U`/`V` 看成哪个都认得，
  大小写和中间的横线也不影响。填错了会明确提示「邀请码不对」，不会静默失败。
- **发错人了或码泄露了**：那一行点「作废」，码立刻失效（已经注册好的账号不受影响）。
  用过的那条记录也能删，删的只是记录，不会把账号带走。
- **删掉账号不会让原来的码复活**，得再发一个新码让他重新注册（见第 9 节）。
- 猜码基本没用：8 位、32 个符号 = 2^40 种组合；而且同一个来源 IP 一小时内因为
  「码没填 / 填错 / 已被用过」失败超过 20 次之后，注册接口直接回 429（`too_many_trials`）
  ——用户名撞车、口令太短这类不算，新手填错几次不会被锁在门外。这个计数只在进程内存里，
  重启服务就清零，成功注册一次也会清零，所以一间机房共用出口 NAT 时不会互相连累。
  登录接口不受它影响。
- 后台列表最多显示最近 500 条。想批量发码就走命令行（接口除了 Cookie 也认 HTTP Basic）：

```bash
curl -s -u "$ADMIN_USER:$ADMIN_PASSWORD" -X POST \
  'http://localhost/functions/v1/app?action=create-invite' \
  -H 'Content-Type: application/json' -d '{"note":"发给李四"}'
# {"code":"VQ3K7HDM","note":"发给李四"}

curl -s -u "$ADMIN_USER:$ADMIN_PASSWORD" 'http://localhost/functions/v1/app?action=list-invites'
curl -s -u "$ADMIN_USER:$ADMIN_PASSWORD" -X POST \
  'http://localhost/functions/v1/app?action=delete-invite' \
  -H 'Content-Type: application/json' -d '{"code":"VQ3K7HDM"}'   # 作废
```

---

## 6. 启动与验证

```bash
cd ~/cpubiomed/deploy
docker compose up -d --build
docker compose ps            # 三个服务都应是 running / healthy
docker compose logs -f api   # 看到「复习台服务已启动」和「初始化灌入 474 条记录」
```

原生部署（第 3c 节）的对应命令，`install.sh` 已经替你跑完了，这里只是日后排查用：

```bash
systemctl status cpubiomed                       # active (running)
journalctl -u cpubiomed -f                       # 看到「复习台服务已启动」和「初始化灌入 474 条记录」
curl -s http://127.0.0.1:8080/healthz            # {"ok":true}
sudo systemctl restart cpubiomed                 # 改了 deploy/server/ 下的代码后
```

首次启动时数据库是空的，api 容器会自动把 `content.json` 灌进去（353 题 + 32 章 + 89 卡 = 474 条）。
**只在题库表为空时灌入**，之后重启不会覆盖你在后台改过的内容。

### 验证清单

打开 `http://<服务器IP>/`。**不该弹任何登录框**，页面直接就出来了：

- [ ] 首页正常显示，侧边栏四个科目都在
- [ ] 左下角写着「进度只存在这台设备上」和一个「登录 / 注册」按钮
- [ ] 「刷题训练」里生物化学 64 题、分析化学 132 题，章节筛选能看到「2025 年真题」等
- [ ] 「背诵卡」角标显示 89
- [ ] 「考纲速查」「复习计划」「费曼讲解」都能打开，全程没要求登录
- [ ] 导航里**没有**「内容管理」（还没登录）
- [ ] 随便做一组题 → 交卷后的成绩页底部出现「这组成绩目前只存在这台设备的浏览器里」的提示
- [ ] 点左下角「登录 / 注册」→ 用 `.env` 里的 `ADMIN_USER` / `ADMIN_PASSWORD` 登录
- [ ] 登录后左下角变成头像 + 用户名 + 「管理员」，导航里**自动多出「内容管理」**
- [ ] 「内容管理」直接就是编辑界面（自建部署不需要「启用后台管理」那一步，那是 Qoder 站点才有的）
- [ ] 在后台新增一道测试题 → 刷新页面 → 题还在 → 删掉它
- [ ] 测试题的题干里写 `$K_m$ 与 $\ce{H2SO4}$`，保存后到「刷题训练」里做这道题：
      公式排成了数学字体，不是原样的 `$…$`（KaTeX 是本地文件，不联网也要能显示）
- [ ] 后台编辑器顶部有「公式 / 配图」工具条 → 选中「题干」→「插入图片」选一张 png →
      输入框里自动出现 `![配图](/media/<年月>/<文件名>.png)`；点「预览效果」能看到渲染结果
- [ ] 浏览器直接打开刚才那个 `/media/…` 地址，图片能显示
- [ ] 后台「导入 JSON」选 `deploy/tools/bank-template.json` → 提示成功 8 条 →
      刷新后能看到 `demo-` 开头的那几道题（看完记得删掉）
- [ ] 登录状态下做完一组题，等几秒（改动有 3 秒防抖），左下角从「正在同步进度…」
      变成「进度已同步到服务器 · 时间」
- [ ] 「账号」页 → 点「从服务器恢复」→ 进度对得上
- [ ] 「账号」页 → 「退出登录」→ 导航里的「内容管理」消失；手输 `#/admin` 只看到
      「这一页只对管理员开放」，看不到题库条数、同步按钮这些管理信息
- [ ] 「内容管理」→ 顶部切到「注册邀请码」→ 备注写「测试用」→ 点「生成一个」→
      列表里多出一行，码显示成 `XXXX-XXXX` 的样子，状态是「未使用」
- [ ] 退出登录 → 「登录 / 注册」→ 切到「注册新账号」→ 表单里**多出「邀请码」一栏**；
      空着提交被浏览器拦下（`required`），乱填一个 8 位的码会提示「邀请码不对」
- [ ] 用刚才那个码注册（把横线去掉、或者全填小写都能过）→ 注册完直接就是登录状态，
      导航里同样**没有**「内容管理」；手输 `#/admin` 看到「当前账号没有管理权限」，同样没有任何管理数据
- [ ] 拿同一个码再注册一个 → 提示「这个邀请码已经被用过了」
- [ ] 回到管理员账号 →「注册邀请码」→「重新读取」→ 那一行变成「已用 · 日期 · 用户名」
- [ ] 再生成一个码、不发给任何人、直接点「作废」→ 确认后那一行消失，再用它注册也提示不对
- [ ] 直接访问 `http://<服务器IP>:8080/` 应该连不上（接口没暴露到公网）

命令行侧的检查：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/          # 200（页面公开可读）
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost/functions/v1/app?action=bank'   # 200
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost/functions/v1/app?action=progress'  # 401（没登录）
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost/functions/v1/app?action=list-invites'  # 401（邀请码只有管理员能看）
curl -s -u "$ADMIN_USER:$ADMIN_PASSWORD" 'http://localhost/functions/v1/app?action=bank' | head -c 200
```

最后一条是给脚本用的：接口除了 Cookie，也认 HTTP Basic（用的是同一套站内账号口令，
管理员和普通用户都可以），方便 `curl` 和 `install.sh` 自检，不用先去登录页拿 Cookie。

---

## 7. 内容与数据：搬过来、批量加进去

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

进度就回来了。这一步**只需要做一次**：新站点上登录账号之后，进度会自动同步到服务器，
以后换设备只要登同一个账号就能找回来，不用再碰控制台。这一步随时可以做，不影响网站先用起来。

> 顺序上建议：先在新站点登录（管理员直接用 `.env` 里的账号；普通用户要先拿到邀请码才能注册，
> 见第 5b 节）→ 再做上面这五步把旧进度灌进 localStorage →
> 灌完刷新页面，登录状态下改动会自动上传到服务器。

### 7b. 后台手动加过的题

第 4 步运行时脚本会打印差异。**如果「仅云端有」是 0**，说明云端内容和仓库里的
`web/data/*.js` 完全一致，`content.json` 已经是全的，什么都不用做。

**如果「仅云端有」大于 0**，说明你在后台加过题、这些内容只存在云端。
这时 `import-bundle.mjs` 已经把云端题库写进了 `deploy/server/content.json`，
把它重新传到服务器并重建镜像：

```bash
scp deploy/server/content.json <user>@<ip>:~/cpubiomed/deploy/server/

# Docker 路线
ssh <user>@<ip> 'cd ~/cpubiomed/deploy && docker compose up -d --build api'

# 原生路线：重跑安装脚本即可（幂等，不动数据库）
ssh <user>@<ip> 'cd ~/cpubiomed && sudo bash deploy/native/install.sh'
```

> 不想开控制台的话，网站「内容管理」里本来就有「导出全部内容 JSON」按钮，
> 下载的文件 `import-bundle.mjs` 也认（会自动识别 `format: cpu-biomed-bank/1`）。
> 区别是那个按钮只导内容、不含学习进度，而且不带 `built_in` 标记，
> 你手动加的题在新站点上会显示成「内置」。要用控制台脚本才能连进度一起带走。

注意：只有题库表**完全为空**时才会自动灌入。如果新库已经有数据了，改用后台的
「一键上传」按钮补，或者先清空再重启：

```bash
# 会删掉新服务器上所有题目和后台编辑，确认后再执行

# Docker 路线
docker compose exec db psql -U cpubiomed -d cpubiomed \
  -c 'TRUNCATE questions, syllabus_chapters, cards RESTART IDENTITY;'
docker compose restart api

# 原生路线
sudo -u postgres psql -d cpubiomed \
  -c 'TRUNCATE questions, syllabus_chapters, cards RESTART IDENTITY;'
sudo systemctl restart cpubiomed
```

---

### 7c. 批量加题：模板 + 离线体检 + 后台导入

后台一条一条手输适合零散补题。要一次加几十上百条（比如把一本习题册录进去），走这三步：

**1. 照模板写 JSON。** 模板在 `deploy/tools/bank-template.json`，里面有 6 道示例题
（覆盖单选/多选/判断/填空/简答全部五种题型）、1 个章节、1 张背诵卡，全部通过体检。
开头三段 `_说明` /
`_字段说明` / `_公式与图片写法` 就是给你看的注释，`_` 开头的键导入时会被忽略，
不用删。复制一份改名，把示例内容换掉即可。

**2. 导入前先在本地体检一遍。**

```bash
node deploy/tools/check-bank.mjs 我的题库.json
node deploy/tools/check-bank.mjs 我的题库.json --strict      # 警告也算不通过
node deploy/tools/check-bank.mjs 我的题库.json --json        # 机器可读，警告全量输出
node deploy/tools/check-bank.mjs 我的题库.json --no-builtin  # 不检查是否覆盖内置题
```

它用的是 `deploy/server/validate.mjs` 里**同一份规则**（直接 import，不是抄一遍），
所以「这里通过」就等于「接口会收下」。除了接口会拒的错误，它还会提醒几类
接口不管、但会让你白忙一场的写法：字段名拼错（`explain` 应写 `explain_text`）、
编号重复、编号撞上内置题（**导入是整条覆盖，不是合并**）、`$` 落单没配对、
`\ce{}` 写在公式外面、图片地址不在允许的前缀里、`demo-` 示例编号忘了改。
退出码：0 = 可以导入，1 = 有错误，2 = 文件读不了或不是合法 JSON。

**3. 后台「导入 JSON」。** 用管理员账号登录 → 内容管理 → 导入 JSON → 选文件。
它会分批提交并实时显示进度；万一还有条目被拒，界面会列出**失败清单**：
第几条、什么类型、编号、哪个字段、什么原因。照着改那几条，再导一次同一个文件就行
——已经成功的编号会按新内容更新，不会产生重复。

> **编号规则**：3–64 位，只能是小写字母、数字和短横线，且以字母或数字开头。
> 建议用「科目-章节-序号」这种能看懂的形式（`ana-ch3-014`），日后翻数据库好认。
> **长度按字节算**，一个汉字算 3 字节：题干上限 4000 字节 ≈ 1300 个汉字。

#### 公式与配图的写法

题干、选项、解析、参考答案、背诵卡正反面、考点清单都支持同一套标记，
由自托管的 KaTeX + mhchem 渲染（`web/vendor/katex/`，不走 CDN，服务器不联网也能显示）：

| 想要的效果 | 写法 |
| --- | --- |
| 行内公式 | `$K_m$`、`$\Delta G^\circ = -RT\ln K$` |
| 独立成行的公式 | `$$[\ce{H+}] = \sqrt{K_a c}$$` |
| 化学式 / 化学方程式 | `$\ce{H2SO4}$`、`$\ce{CH3COOH + H2O <=> CH3COO- + H3O+}$`（`\ce{}` 必须写在 `$` 里面） |
| 加粗 | `**这是重点**` |
| 图片 | `![说明文字](/media/202610/abc123.png)`，或完整的 `https://…` 地址 |

写错的公式**不会让页面白屏**：KaTeX 渲染失败时原样显示 TeX 源码，
所以看到一串 `$\frac{a}{b$` 就说明那个字段的 `$` 没配对。
不支持 LaTeX 的 `\includegraphics`、`\usepackage`、`tabular` 环境——
表格请用图片，或者拆成几行文字。

**配图从哪来：** 后台编辑器顶部有「公式 / 配图」工具条，选一个字段（题干 / 选项 A /
解析 / 背诵卡背面…）→「插入图片」选文件，上传完地址会自动写进那个字段的光标处；
「预览效果」按真实渲染的样子排版，公式和图片都能当场看到。
单张上限 2 MB，只收 png / jpg / gif / webp——**SVG 一律拒收**，它能内嵌脚本，
和页面同源就等于给了永久 XSS。

批量导入的 JSON 里只能写图片**地址**，图片文件本身不在 JSON 里。所以要么先在后台
一张张上传拿到地址，要么把文件直接放进服务器的配图目录（原生部署
`/opt/cpubiomed/media/<YYYYMM>/`，Docker 是 `mediadata` 卷），地址按
`/media/<YYYYMM>/<文件名>` 写。**换服务器或恢复备份时必须把这个目录一起带上**，
否则题目文字都在、图片全 404，详见第 9 节。

---

## 8. HTTPS（建议做）

现在是明文 HTTP，**登录口令和会话 Cookie 在网络上都是可被窃听的**——拿到 Cookie 就等于
拿到那个账号（有效期 30 天）。有域名的话按下面走；只有 IP 的话，至少把 `ADMIN_PASSWORD`
当成一次性口令，别和其他账号复用，也别在公共网络上登录管理员账号。

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

上面是 Docker 路线。**原生部署反而简单得多**——nginx 直接读 `/etc/letsencrypt`，
不用挂载、不用改 compose：

```bash
# 1. 域名 A 记录指向服务器 IP，等生效
sudo apt install -y certbot python3-certbot-nginx

# 2. 让 certbot 自己改 nginx 配置（会自动加 443 段和跳转）
sudo certbot --nginx -d your-domain.example --agree-tos -m you@example.com

# 续期由 certbot 的 systemd timer 自动处理，重载钩子它自己会加
sudo certbot renew --dry-run
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

# 备份题库配图（数据库里只存地址，图片文件在 mediadata 卷里，必须单独带）
docker compose cp api:/app/media ./media-$(date +%F)

# 恢复
gunzip -c backup-2026-10-16.sql.gz | docker compose exec -T db psql -U cpubiomed -d cpubiomed
docker compose cp ./media-2026-10-16/. api:/app/media/
```

原生部署（第 3c 节）的对应命令：

```bash
journalctl -u cpubiomed -f                      # 看接口日志
sudo tail -f /var/log/nginx/access.log          # 看 nginx 访问日志
sudo systemctl restart cpubiomed                # 改了 deploy/server/ 下的代码后
cd ~/cpubiomed && sudo bash deploy/native/install.sh   # 改了 package.json / content.json / web/ 后

# 备份数据库（建议配个 cron，每天一份，留最近 14 天）
sudo -u postgres pg_dump cpubiomed | gzip > backup-$(date +%F).sql.gz

# 备份题库配图
sudo tar czf media-$(date +%F).tar.gz -C /opt/cpubiomed media

# 恢复
gunzip -c backup-2026-10-19.sql.gz | sudo -u postgres psql cpubiomed
sudo tar xzf media-2026-10-19.tar.gz -C /opt/cpubiomed
```

> **`pg_dump` 不再等于完整备份。** 加了配图功能之后，一份完整备份是三样东西：
> 数据库导出（题库文字 + 账号 + 进度）、配图目录（`/opt/cpubiomed/media` 或
> `mediadata` 卷）、以及 `deploy/.env`（口令和 `SESSION_SECRET`，丢了就登不进去）。
> 只恢复数据库的话，题目文字都在，但里面引用的图片会全部 404。
> 配图目录只增不改，所以不用每天都全量备份——隔几天做一次、或者只在批量插图之后做一次也够。

**改前端内容**（`web/` 下的文件）：Docker 路线下 `web/` 是只读挂载进容器的，改完刷新页面
就生效；原生路线下 `web/` 是复制到 `/opt/cpubiomed/web` 的，要重跑一次 `install.sh`
（或直接覆盖那个目录下的文件）。两条路都不用碰数据库。

**加题目**有三条路：
- 在网站的「内容管理」里手动加 —— 立即生效，只进数据库；一次加几条时用这个；
- **批量导入 JSON** —— 一次几十上百条走这条，模板、离线体检脚本和公式/配图写法见第 7c 节；
- 改 `web/data/questions_extra.js` 之类的内容文件 —— 静态兜底数据变了，但**数据库不会自动跟着变**，
  需要在「内容管理」里点一次「一键上传」（只插不改，不会覆盖你已有的编辑）。

**改管理员口令**：编辑 `deploy/.env` 里的 `ADMIN_PASSWORD`，然后 Docker 路线跑
`docker compose up -d api`、原生路线重跑 `sudo bash deploy/native/install.sh`。
服务启动时会把它同步回 `app_users`，所以改口令不会把自己锁在门外。
**注意**：如果你没填 `SESSION_SECRET`（默认就是留空，从口令派生），改口令会让**所有人**
的会话失效，需要重新登录一次。想避免这个副作用，就在 `.env` 里固定一个 `SESSION_SECRET`。

**忘了口令 / 想直接改数据库里的账号**：

```bash
# Docker 路线
docker compose exec db psql -U cpubiomed -d cpubiomed

# 原生路线
sudo -u postgres psql -d cpubiomed
```

```sql
SELECT user_id, username, display_name, role, created_at FROM app_users ORDER BY created_at;

-- 把某个注册用户提成管理员（角色是每次请求现查数据库的，让他刷新一下页面就会出现「内容管理」）
UPDATE app_users SET role = 'admin', updated_at = now() WHERE username = '某人';

-- 删掉一个账号（user_progress 有 ON DELETE CASCADE，进度会一起删掉；
-- invite_codes.used_by 是 ON DELETE SET NULL，邀请码那行会留着，used_at 仍在）
DELETE FROM app_users WHERE username = '某人';

-- 看邀请码都发给谁、用没用（used_by 是空但 used_at 有值 = 用过之后账号被删了）
SELECT code, note, created_at, used_at,
       (SELECT username FROM app_users u WHERE u.user_id = i.used_by) AS used_by
FROM invite_codes i ORDER BY created_at DESC;
```

口令是 scrypt 散列存的，数据库里看不到原文、也没法直接改。**管理员**改 `.env` 再重启就能重置；
**普通用户没有找回密码的流程**（没接邮件服务），只能删掉账号让他重新注册——进度会跟着一起没，
所以删之前可以先 `SELECT data FROM user_progress WHERE user_id = '…'` 存一份。
删完还要**再发一个新的邀请码**：原来那个码不会因为账号被删就复活（见第 5b 节）。

**升级到带账号体系的新版本**：`schema.sql` 全是 `IF NOT EXISTS`，重复执行安全。

```bash
# 原生路线：重跑安装脚本就会自动补表
cd ~/cpubiomed && sudo bash deploy/native/install.sh

# Docker 路线：schema.sql 只在数据卷第一次初始化时执行，要手动补一次
docker compose exec -T db psql -U cpubiomed -d cpubiomed < schema.sql
docker compose restart api
```

老库里如果已经有 `site_settings` 表（更早版本的 Qoder 兼容遗留），它现在没人用了，
留着不影响运行，想清掉就 `DROP TABLE site_settings;`。

---

## 10. 回退到 Qoder 站点

Qoder 站点还在，随时可以用 https://cpu-biomed-q1r9t5025uh.qoder.website/ 顶回去。
但要注意：**服务器上新加的题不会自动同步回 Qoder 云端**，两边从此刻起各自独立。
如果打算长期以服务器为准，Qoder 那边就当成只读快照，别再在两边同时改内容。

账号体系也不会跟着回去：Qoder 那一侧的 `functions/` 已经冻结，没有 `app_users`、
没有登录页、没有进度同步，身份仍然由平台网关判定（在「内容管理」里点一次
「启用后台管理」来认领所有者）。服务器上的账号和进度快照只存在于你自己的数据库里。

---

## 11. 需要你知道的边界

- **本地验证做到哪一步**：接口逻辑用内存数据库替身跑过 251 项断言（注册/登录/会话签名、
  邀请码的生成·归一化·一次性消费·并发抢占只成一个·作废·删账号后的残留、按来源 IP 的注册失败限流、
  角色权限、HTTP Basic 兜底、路径穿越防护、全部 action、全部字段校验、进度快照读写与 1 MB 上限、
  353 条真实种子数据灌入、幂等性、后台编辑不被覆盖、图片上传的类型/大小/SVG 拒收与
  `/media/` 托管、离线体检脚本与导入模板自身），全部通过；前端也开着真浏览器把
  匿名浏览 → 注册 → 角色化导航 → 非管理员锁定页 → 管理员改题库 → 做完题后的登录提示 →
  清空 localStorage 后从服务器找回进度这条链子整个走了一遍。
  这一轮新加的富文本部分同样是**真浏览器实测**：后台工具条插图 → 上传 → 地址写回输入框 →
  保存 → `?action=bank` 原样返回 → 刷题页、判分那行、解析面板、错题本的展开区都渲染出
  KaTeX 与 `\ce{}` 化学式，图片取回 200。
  **邀请码这轮只做了接口级验证**：注册表单新加的「邀请码」栏和后台的「注册邀请码」标签页
  还没在真浏览器里点过，界面文字、按钮状态和复制码的手感要等你第一次上手时顺手核一下
  （第 6 节清单里已经列了这几条）。
  **但没有在真实 PostgreSQL / 真实 nginx 上跑过**，本机既没装 Docker 也没有 Linux 环境。
  第 6 节的验证清单第一次在服务器上执行时，才是真正的端到端确认。
- **公式渲染是 KaTeX，不是完整 LaTeX**：常用数学符号、上下标、分式、根号、矩阵、
  `\ce{}` 化学式都能排；`\includegraphics`、`\usepackage`、`tabular`、tikz 这类不行。
  排版细节（比如某些宏包的间距）和 Word/LaTeX 编译出来的样子会有出入。
  写错的公式**不会白屏**，会原样显示 TeX 源码——看到页面上一串 `$…$` 就是那里写错了。
- **配图只存文件路径，不进数据库**：JSON 导入不会上传图片，题库里的 `/media/…`
  地址指向服务器磁盘上的文件。所以备份、换服务器、恢复旧库时，配图目录必须一起带走
  （第 9 节），否则文字都在、图全 404。
- **原生安装脚本 `deploy/native/install.sh` 同样没有实机跑过**。本机验证到的是：
  bash 语法检查通过；`.env` 解析与 15 组输入逐个实测（10 组应被拦下的：模板占位文字、
  口令过短、base64 特殊字符、缺字段、非数字端口、用户名带空格、库名含引号或分号、
  角色名数字开头或含连字符；5 组应放行的：合法配置、CRLF 行尾、省略 HTTP_PORT、
  值里含等号、下划线加数字的库名）；npmmirror 的 Node 20 清单能解析出
  `node-v20.19.5-linux-x64.tar.xz` 与 arm64 对应包、sha256 校验行格式与 `sha256sum -c`
  兼容；systemd 单元与 nginx 配置的占位符替换无残留。
  这轮新加的 `SESSION_SECRET` 校验（留空放行、非 32 位字母数字拦下）**只做了语法检查，
  没有逐组实测**。
  **apt 安装、建库建表、systemd 启动、nginx 反代、末尾那几条自检也只有静态审查。**
- **nginx 与 TLS 配置未经实机验证**，证书路径和续期钩子可能要按你的发行版微调。
- **页面和题库现在是公开可读的**——这是「浏览做题不要求登录」的直接代价：
  静态文件、`web/data/*.js` 的内置题库、以及 `?action=bank` 接口都不再需要任何凭证，
  知道地址的人都能抓到全量题库（真题 + 商业习题册内容）。
  **这一条改变了运行中站点的暴露面，需要你明确认可**；如果不想这样，要么回到整站加口令
  的旧模型（那就等于恢复了进站拦路），要么用 nginx 的 `allow`/`deny` 或防火墙把
  80/443 限制到你自己的 IP。
  （代码仓库 `github.com/AeroBeats/cpu_biomed` 是公开的，里面含全量题库——这是你
  2026-10-18 明确选择的，与站点是否公开是两件事。）
- **注册改成邀请制了，但它挡不住题库被抓**：没有你发的码就注册不了，一个码只能用一次，
  所以「被人批量刷账号、往 `user_progress` 里塞垃圾」这条路基本堵住了（何况每个账号上限 1 MB）；
  猜码另有每小时 20 次失败的来源限流兜着。可是**浏览页面和 `?action=bank` 依然不要任何凭证**，
  邀请码只管「谁能建账号」，不管「谁能看内容」——想连内容一起锁上，还是得用上一条说的
  整站加口令或者 nginx / 防火墙限源 IP。
  另外两点：限流计数只在进程内存里，服务重启就清零（现在只跑一个 Node 进程，够用；
  将来要是多实例部署，各实例各算各的）；`X-Forwarded-For` 只在连接确实来自回环或内网
  （也就是我们自己那层 nginx）时才被采信，公网上伪造这个头改不了限流的归属。
- **退出登录不能吊销已签发的会话**：会话是无状态的 HMAC 签名 Cookie（有效期 30 天），
  「退出」只是清掉本机 Cookie，那串值本身在过期前仍然有效。想让所有已发出的会话立刻失效，
  唯一的办法是换掉 `SESSION_SECRET`（没填它的话，改 `ADMIN_PASSWORD` 也有同样效果，
  因为密钥是从口令派生的）——代价是所有人都要重新登录。
- **进度是整份覆盖，不是合并**：localStorage 始终是主存储，服务器只是一份快照，
  谁的 `savedAt` 新谁说了算。两台设备同时离线刷题、再先后联网，**后同步的那份会把先同步的整份盖掉**，
  被盖掉的那些答题记录找不回来。一个人一台设备用不会有这个问题。
- **口令强度**：明文 HTTP 上，登录口令和会话 Cookie 都等于直接发出去。上 HTTPS 之前，
  `ADMIN_PASSWORD` 请当成随时可换的临时口令，也别在公共网络上登录管理员账号。
