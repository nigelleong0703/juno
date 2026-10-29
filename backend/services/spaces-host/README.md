# Spaces 托管（方案 B）

把 agent 做好的小应用（Space）发布到 Cloudflare 上长期在线，给出分享链接。
这个目录有两部分：

- **Worker**（`src/worker.ts`，部署用 `wrangler.toml`）：按域名找到发布，从 R2 读页面文件，从 D1 读写数据（`/api/<表>`），执行可见性与撤销。
- **发布器**（`src/publisher.ts`，由 API 使用）：把一个 Space 的页面和数据写进 R2 / D1。两种存储：Cloudflare REST（生产）和本地 `wrangler dev`（开发和测试）。

## 托管版是什么，不是什么

- 托管的是 **构建产物 + 数据快照**。`server.ts` **不执行**：共享的 Worker 只能跑固定的代码，不能为每个应用跑一份任意的 Bun 服务端。
- **有服务端代码的 Space 不能托管**：发布前，电脑上的服务端文件（根目录的 `.ts/.js` 等，以及根目录多出来的文件夹）必须与应用模板逐字节相同，否则 `publish-hosted` 答 409 `SPACE_HAS_SERVER_CODE`（「This Space runs its own server code; it can only be shared from your computer (option A)」），什么也不发布。这类 Space 只能在电脑上分享（方案 A）。`schema.ts`、`migrations/` 与客户端代码不算服务端代码。
- 数据接口是 `/api/<表>`：`GET` 列表（id 倒序，最多 500 行）、`POST` 新增、`GET/PATCH/DELETE /api/<表>/<id>`，行为 `{id, ...字段}`，字段名为驼峰。模板 `app` 的 notes 客户端不改即可用。
- 每次发布都**用电脑上的数据覆盖**托管上的数据（快照）。
- 上限：页面 10 MiB、500 个文件；每个发布 1 万行；单行 16 KiB；列表 500 行。
- 可见性：`link`（默认，拿到链接即可，不被搜索引擎收录）、`public`（同样不要登录，允许收录）、`private`（只有主人，经 `open-url` 进入，12 小时）。撤销后链接 404，数据与页面文件删除。
- **访客默认只能读**：`GET` 可以，写入答 403。`visitorWrites`（发布时或 `PATCH` 时设置，默认 `false`）为 `true` 时，访客也可以改数据。主人的会话总是可以读写。

## 主人需要提供

1. **Cloudflare 账号**，并在控制台启用 **R2**。D1 用免费额度即可。
2. **一个专用的内容域名**（例如 `juno-content.example`），与 app、API 的域名不同，并且 DNS 在这个 Cloudflare 账号的 zone 里（域名的 NS 指向 Cloudflare）。用一级子域（`*.juno-content.example`）：Universal SSL 就覆盖它。不要用二级子域（`*.spaces.juno-content.example`），那需要高级证书。Worker 路由需要一条代理开启（橙色云）的 `*` DNS 记录。
3. **两个 API token**（在控制台创建，权限名以创建页面为准，创建后核对一次）：
   - **部署 token**（只在主人的机器上用于 `wrangler deploy`，不写进服务器）：账号范围，`Workers Scripts: Edit`、`D1: Edit`、`Workers R2 Storage: Edit`；若用路由，再加该 zone 的 `Workers Routes: Edit` 与 `DNS: Edit`。
   - **运行时 token**（写进 API 的 `CF_API_TOKEN`，只做发布与撤销）：账号范围，`D1: Edit`、`Workers R2 Storage: Edit`。不要给 Workers 脚本权限。
4. **D1 数据库的 id** 与 **R2 桶名**（下面的命令会打印 id）。
5. **签名密钥** `SPACES_HOST_SIGNING_KEY`：`openssl rand -hex 32`。同一个值既是 Worker 的 secret，也是 API 的环境变量。

## 部署（主人执行；这里没有执行过任何部署命令）

```bash
cd services/spaces-host
pnpm install

# 1. 建 D1 数据库和 R2 桶；把打印出的 database_id 写进 wrangler.toml
pnpm exec wrangler d1 create juno-spaces
pnpm exec wrangler r2 bucket create juno-spaces-files

# 2. 改 wrangler.toml：[vars] 里的 CONTENT_DOMAIN，[[d1_databases]] 里的 database_id，
#    以及路由（见下面的示例）

# 3. 建表（D1 的迁移在 migrations/）
pnpm exec wrangler d1 migrations apply juno-spaces --remote

# 4. 签名密钥（与 API 的 SPACES_HOST_SIGNING_KEY 相同）
pnpm exec wrangler secret put SPACES_HOST_SIGNING_KEY

# 5. 部署 Worker
pnpm exec wrangler deploy
```

wrangler.toml 里的路由（把域名换成自己的）：

```toml
routes = [{ pattern = "*.juno-content.example/*", zone_name = "juno-content.example" }]
```

API 服务器的环境变量（重启 API 生效）：

```
CF_ACCOUNT_ID=<账号 id>
CF_API_TOKEN=<运行时 token>
SPACES_CONTENT_DOMAIN=juno-content.example        # 必须与 CONTENT_DOMAIN 相同
SPACES_CONTENT_SCHEME=https
SPACES_HOST_D1_DATABASE_ID=<database_id>
SPACES_HOST_R2_BUCKET=juno-spaces-files
SPACES_HOST_SIGNING_KEY=<与 Worker 相同的密钥>
```

缺少其中任何一项，托管接口都会返回 503 并写明缺哪些变量，其余功能不受影响。

## 第一次验收（主人，用一个真实的 Space）

1. 在 app 里对一个已发布的 Space 调用发布托管（`POST /v1/spaces/:id/publish-hosted`），打开返回的 `url`，页面应显示，notes 列表应可读；直接 `POST /api/notes` 应答 403（访客不能写）。
2. 改成 `private`，直接打开 URL 应为 403；用 `hosted/open-url` 返回的链接打开，应进入，并且可以写。
3. 撤销（`DELETE /v1/spaces/:id/hosted`），URL 应为 404。
4. 有服务端代码的 Space（改过 `server.ts`）发布应答 409 `SPACE_HAS_SERVER_CODE`。

**还没有对真实 Cloudflare 账号验证的部分**：REST 的 R2 列表与删除接口（`cloudflare-storage.ts` 的 `deletePrefix`）和 D1 查询接口的返回格式，是按文档写的，只用模拟的 fetch 测过。第一次部署时请用一个可以丢弃的 Space 先走一遍，尤其是撤销后 R2 里是否真的清空。

## 本地开发与测试

```bash
cd services/spaces-host
# 开发用的密钥（git 忽略）
printf 'ADMIN_TOKEN=local-admin-token-change-me\nSPACES_HOST_SIGNING_KEY=local-signing-key-change-me\n' > .dev.vars
pnpm dev          # wrangler dev --config wrangler.dev.toml，端口 8799
```

API 的本地发布（只在开发时设置，生产不设）：

```
SPACES_HOST_LOCAL_URL=http://127.0.0.1:8799
SPACES_HOST_LOCAL_ADMIN_TOKEN=local-admin-token-change-me
SPACES_HOST_SIGNING_KEY=local-signing-key-change-me
SPACES_CONTENT_DOMAIN=spaces-content.localhost:8799
SPACES_CONTENT_SCHEME=http
```

浏览器把 `*.localhost` 解析到本机，所以 `http://notes-<id>.spaces-content.localhost:8799/` 可以直接打开（Safari 不一定支持 `*.localhost`，用 Chrome 或 Firefox）。

测试：

```bash
pnpm test         # 单元测试 + 集成测试（wrangler 的 workerd，在随机端口，约 1 秒）
pnpm typecheck
```

注意：`wrangler.dev.toml` 的入口（`src/dev-entry.ts`）带有开发用的管理端点，**不要用它部署**。部署只用 `wrangler.toml`（入口 `src/worker.ts`）。

## 已知限制

- REST 模式下，一次发布的语句逐条执行，中途失败会留下半截数据（下次发布会覆盖）；本地 `wrangler dev` 模式下每批是一个原子批。D1 与 R2 之间没有事务。
- 没有配额与限流。打开了 `visitorWrites` 的发布，访客可以写满一个发布的 1 万行。
- 服务端代码的检查是整文件比较：改动再小也会拒绝（这是有意的）。
- 撤销后 `spaceHosted` 行保留（标记 `revokedAt`，没有 URL）。
- 产出物沙箱（`sandbox`）不用在托管页面上。
