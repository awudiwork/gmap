# gmap · 游戏地图同步聊天室

游戏里按热键截图 → 客户端裁掉地图以外的边框 → 推到这个网站 → 房间里其他人的网页**自动弹出大图**，相当于共享雷达。

同时它也是个正经聊天室：发文字、粘贴截图、上传图片/视频/文件、发代码块。

本仓库只包含**服务端 + 网页端**。截图与裁剪由你自己的客户端完成，通过下面的上传接口对接。

---

## 快速开始

```bash
pnpm install          # 会编译 better-sqlite3 原生模块
cp .env.example .env  # 然后务必修改 ADMIN_PASSWORD
pnpm start            # 默认 http://localhost:3000
```

首次启动会自动建库、建管理员账号，日志里会打印：

```
[db] 已应用迁移 v1
[db] 已应用迁移 v2
[gmap] 已按 .env 创建管理员账号：admin
[gmap] 已启动，浏览器打开：
[gmap]   本机  http://localhost:3000
[gmap]   局域网  http://192.168.1.10:3000
```

日志里的局域网地址就是发给队友的。注意 `HOST=0.0.0.0` 只是"监听所有网卡"，
它本身不是能在浏览器里打开的地址，所以这里展开成各网卡的实际 IP。
如果机器上有 Docker 或 WSL 的虚拟网卡，列表里会混进 `172.x` 这类地址，队友连不上，
挑 `192.168.x` 或 `10.x` 那个。

开发时用 `pnpm dev`（文件改动自动重启），跑测试用 `pnpm test`，
改过图标清单后用 `pnpm build:icons` 重新生成 sprite。

> Windows + pnpm 10/11 默认禁止依赖执行安装脚本，本仓库已在 `pnpm-workspace.yaml` 里放行
> `better-sqlite3`。若换机器后报 `Could not locate the bindings file`，执行 `pnpm install` 重跑一次构建即可。

---

## 账号体系

| 角色 | 怎么来 | 能做什么 |
| --- | --- | --- |
| 管理员 | `.env` 里的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`，**每次启动自动同步** | 聊天室全部功能 + 「用户管理」：开号、重置密码、注销账号 |
| 普通用户 | 管理员在页面上创建 | 聊天、上传、生成上传 Key、改自己的昵称和密码 |

设计取舍：`.env` 是管理员凭据的**唯一事实来源**。忘记管理员密码时，改 `.env` 重启即可找回；
代价是管理员密码不能在页面上改——页面和接口都会明确拒绝，而不是改了之后被下次重启悄悄覆盖。

### 账号操作的副作用

这几条都是刻意设计的，**改动前先理解原因**：

| 操作 | 谁能做 | 副作用 |
| --- | --- | --- |
| 改昵称 | 本人 | 历史消息里的署名一并变化（消息只存作者 id） |
| 改密码 | 本人（需验证当前密码） | 该账号**全部会话被吊销**，当前设备立刻补发新会话，其它设备被踢下线 |
| 重置密码 | 管理员 | 目标用户全部会话被吊销，必须用新密码重新登录；其 API Key **不受影响** |
| 注销账号 | 管理员 | 见下 |

**注销是软删除**，语义是「吊销凭据，保留历史」：

- 该账号的会话和全部 API Key 立即失效，无法再登录；
- 他发过的消息**留在聊天记录里**，昵称照常显示——硬删除会经外键级联带走他的全部消息，在历史里留下空洞；
- 登录名会被腾出来（库里改写成 `原名#deletedN`），之后可以重建同名账号；
- 管理员账号不能被注销，也不能注销自己。

默认 `ALLOW_REGISTRATION=false`，自助注册入口在登录页直接不显示。
如果你想开放注册，把它改成 `true`，并建议同时设一个 `REGISTRATION_CODE` 作为邀请码。

应急命令行开号（页面进不去时用）：

```bash
pnpm create-user ranger 游侠
```

---

## 客户端对接

这是整套系统里你需要对接的**唯一接口**。裁剪、热键、压缩都在客户端做完，服务端不碰图像内容。

### 1. 拿 Key

用账号登录网页 → 顶栏「上传 Key」→ 生成。明文只显示一次，形如：

```
gmap_6c78b26861d0f7c5d91c35c0b973c443a9de6b03
```

Key 存进客户端配置文件或环境变量，**不要写进源码**。丢了就在页面上删掉重建，删除立即生效。
删除是物理删除，列表里不留"已吊销"的历史行：Key 不像账号那样挂着聊天记录，留档只会让列表越来越长。

### 2. 取频道清单

客户端不要硬编码频道，从这里读，服务端加了新游戏你不用跟着改版本：

```
GET /api/rooms
Authorization: Bearer <你的Key>
```

```json
{
  "ok": true,
  "defaultRoom": "all",
  "rooms": [
    { "id": "all",     "name": "全部",    "short": "ALL", "icon": null,                  "hint": "没有单独频道的游戏都发这里" },
    { "id": "wardogs", "name": "Wardogs", "short": "WD",  "icon": "/games/wardogs.webp", "hint": "战狗" }
  ]
}
```

这个接口和上传用同一把 Key，不需要另外登录。

### 3. 上传

```
POST /api/upload
Authorization: Bearer <你的Key>          （或 X-API-Key: <你的Key>）
Content-Type: multipart/form-data
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `file` | 是 | 文件本体。图片/视频/任意文件都行 |
| `caption` | 否 | 附在图片下方的说明文字，最长 4000 字 |
| `room` | 否 | 频道 id，见上面的频道表。不填或填了不认识的值都落到 `all` |

成功返回 `201`：

```json
{
  "ok": true,
  "message": {
    "id": 1, "kind": "file", "body": "北区刷新", "source": "api",
    "createdAt": 1789529299680,
    "user": { "id": 2, "name": "侦察兵" },
    "file": { "id": 1, "name": "地图截图.png", "mime": "image/png",
              "category": "image", "size": 4449, "url": "/api/files/1",
              "expiresAt": 1789572499680, "expired": false }
  },
  "file": { "...": "同上" }
}
```

上传成功的同时，消息已经通过 WebSocket 推给所有在线网页，无需再调别的接口。

错误响应统一是 `{ "ok": false, "code": "...", "message": "..." }`，按 `code` 判断：

| HTTP | `code` | 含义 |
| --- | --- | --- |
| 429 | `upload_too_fast` | 两次上传之间不足 `UPLOAD_MIN_INTERVAL_MS`（默认 1 秒） |
| 401 | `missing_credentials` | 没带 Key |
| 401 | `invalid_api_key` | Key 错误、已被删除，或所属账号已注销 |
| 400 | `missing_file` | 没有名为 `file` 的表单字段 |
| 400 | `empty_file` | 文件是空的 |
| 413 | `file_too_large` | 超过 `MAX_UPLOAD_MB` |
| 429 | `upload_rate_limited` | 超过 `UPLOAD_RATE_PER_MINUTE`，响应里有建议等待秒数 |

### 4. 示例

**curl**

```bash
curl -X POST http://your-host:3000/api/upload \
  -H "Authorization: Bearer gmap_xxxxxxxx" \
  -F "file=@map.png" \
  -F "room=wardogs" \
  -F "caption=北区刷新"
```

**Python**（截图工具常用）

```python
import os
import requests

def push_map(image_path: str, room: str = "all", caption: str = "") -> dict:
    """把裁好的地图推到指定频道。失败时抛 requests.HTTPError。"""
    with open(image_path, "rb") as fp:
        response = requests.post(
            f"{os.environ['GMAP_URL']}/api/upload",
            headers={"Authorization": f"Bearer {os.environ['GMAP_KEY']}"},
            files={"file": (os.path.basename(image_path), fp, "image/png")},
            data={"room": room, "caption": caption},
            timeout=15,
        )
    if response.status_code == 429:
        # 两次上传至少隔 1 秒，这不是错误，等一下重发即可
        raise RuntimeError(response.json().get("message", "上传太快"))
    if not response.ok:
        detail = response.json().get("message", response.text)
        raise requests.HTTPError(f"上传失败 [{response.status_code}] {detail}")
    return response.json()
```

**C#**（.NET 截图工具）

```csharp
using var content = new MultipartFormDataContent();
content.Add(new ByteArrayContent(pngBytes), "file", "map.png");
content.Add(new StringContent(room), "room");
content.Add(new StringContent(caption), "caption");

using var http = new HttpClient();
http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", key);
var response = await http.PostAsync($"{baseUrl}/api/upload", content);
response.EnsureSuccessStatusCode();
```

### 5. 客户端侧建议

- **裁剪**：只保留地图区域。分辨率固定下来最好——网页端在新图和旧图**像素尺寸一致**时会保留当前的缩放和平移，
  你放大盯着某个角落时新图会在同一视角刷新；尺寸一变就只能重新适应窗口。
- **格式**：PNG 无损、适合像素级细节；地图颜色少，体积通常比 JPEG 还小。
- **节流**：服务端有两道闸，**两次上传至少隔 1 秒**（`UPLOAD_MIN_INTERVAL_MS`，挡热键连按），
  每分钟最多 30 次（`UPLOAD_RATE_PER_MINUTE`，挡持续刷屏）。客户端自己也做一下间隔判断，
  别把被拒的请求当成网络错误反复重试。收到 `upload_too_fast` 等一下再发即可。
- **重试**：网络抖动时重试 1~2 次即可；收到 401 不要重试，是 Key 的问题。

---

## 频道

按游戏分频道。最左边一竖排游戏图标，最上面是「全部」，没有单独频道的游戏都发那里。

| 频道 | id | 说明 |
| --- | --- | --- |
| 全部 | `all` | 兜底频道，也是默认频道 |
| Wardogs | `wardogs` | 战狗 |

消息按频道隔离，互相看不见。别的频道来新消息时，那个图标右上角会亮一个琥珀小方块，
切过去就消掉。上次待的频道记在浏览器本地，下次进来直接回到那里。

**加一个游戏**：把图标放进 `public/games/`，在 `server/lib/rooms.js` 的清单里加一条。
`tests/rooms.test.js` 会校验 id 合法、图标文件真的存在。

房间清单**硬编码而不是建表**，因为每个游戏迟早要带上自己的东西（地图画幅、坐标系、
裁剪提示、专属的客户端参数），那些逻辑写在代码里比塞进数据库好维护，
也让「加一个游戏」这件事有唯一的落点。

> 房间 id 会写进数据库，**定下来就不要改**，否则历史消息会落到一个不存在的频道里。

截图客户端推图时带上 `room` 字段就能指定频道，不带或者传了不认识的值都会落到 `all`：
老版本客户端推错地方，也好过把图推丢。

## 网页端布局

```
┌────┬──────────────┬────────────────────────────────────┐
│ALL │ GMAP         │ Wardogs  战狗   [▮══] RADAR  ● 已连接│
│────│──────────────┼────────────────────────────────────┤
│[WD]│ CHANNEL    3 │ 只保留最近 12 小时的消息，更早的已清除 │
│    │ ▌侦察兵    铃 │ ──────────── 今天 ────────────       │
│    │ ▌游侠      铃 │                                    │
│    │ ▌admin  本机 │ [游] 游侠  14:23  API               │
│    │              │ ┌────────────────┐                 │
│    │──────────────│ │   [地图截图]    │                 │
│    │ OPERATOR     │ └────────────────┘                 │
│    │ [侦] 侦察兵   │                                    │
│    │ scout        │              14:24  我  [侦]        │
│    │ 个人资料      │             ┌──────────┐           │
│    │ 上传 Key      │             │ 收到      │           │
│    │ 用户管理      │             └──────────┘           │
│    │ 设置         ├────────────────────────────────────┤
│    │ 退出         │ > 说点什么                   [发送]  │
└────┴──────────────┴────────────────────────────────────┘
```

**最左边是频道栏**，一竖排游戏图标，「全部」在最上面。别的频道有新消息时图标右上角亮一个小方块。

**中间是通道面板**：在线名单在上，每个名字右边一个铃铛（关掉这个人的自动展开），
本机操作员和操作入口在下，「用户管理」只对管理员显示。

**右边是消息流**：别人靠左、自己靠右，同一人 5 分钟内的连续发言并成一组。
顶栏那个拨钮就是雷达开关本身，拨一下即开关。
同一人 5 分钟内的连续发言不重复打呼号，但时间戳每行都留，因为这是日志。
窄屏（≤780px）下侧栏收成抽屉，≤640px 时时间列让位给内容。

## 界面与设计系统

视觉语言是**琥珀磷光终端**。参照物是机架式设备面板，不是聊天软件。
没有构建步骤，原生 ES modules + 原生 CSS。

| 层面 | 决定 | 在哪 |
| --- | --- | --- |
| 字体 | JetBrains Mono 可变字重，自托管 latin 子集 54KB。中文走系统 fallback，需要等宽对齐的部分（时间戳、文件名、数值）全是 ASCII | `public/fonts/` |
| 颜色 | 纯黑 `#000000` 打底，唯一强调色是 `#ffb000`（IBM 3279 琥珀磷光色）。灰阶刻意带琥珀色温，整体像磷光余辉 | `public/css/tokens.css` |
| 形状 | 全部直角。唯一的圆角是拨钮滑块那 2px，因为它代表一个物理零件 | 同上 |
| 图标 | Phosphor regular，13 个，打成一个 3.5KB sprite。界面里绝大多数动作用文字标签，只有图标更省地方或更准确的地方才用 | `public/vendor/icons.svg` |
| 动效 | 只回应操作。唯一的非用户触发动效是新日志行进入，因为那代表真实事件到达 | `public/css/style.css` |

三条不可妥协的规则写在 `tokens.css` 顶部：黑代表这里没有信息；琥珀只给活跃的东西；直角。

**日志列布局**是这套界面唯一的大胆之处，其余一律保持安静。消息按
`时间 · 呼号 · 内容` 三列对齐，不是为了好看：这个产品的实际用法就是在第二屏上扫一眼，
时间列和呼号列成列时，"谁刚推了图"一眼可见，不用逐行读。

**只有深色一个主题。** 琥珀磷光加纯黑是这套语言的本体，反色版本会变成土黄配米白，
那是另一个设计而不是同一个的另一面。真要日间模式得单独设计一套。

**改图标**：编辑 `scripts/build-icons.mjs` 顶部的清单，然后 `pnpm build:icons`。
那份清单是"界面用到哪些图标"的唯一来源，不要手工编辑 `icons.svg`。

`tests/assets.test.js` 守着几条"错了也不报错、只是悄悄变难看"的规则：
图标引用与 sprite 双向对齐、脚本取用的 id 在页面上真实存在、本地资源路径有效、
界面文案里没有 em-dash、单行不堆多个间隔号、没有装饰性箭头、不监听全局滚动。

## 雷达同步是怎么生效的

1. 客户端上传 → 服务端落库 → 通过 WebSocket 把消息广播给所有在线网页。
2. 网页收到 `kind: "file"` 且 `file.category === "image"` 的消息。
3. 按每个人自己的「设置」判断要不要自动弹图：

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| 收到新图自动展开 | 开 | 主开关，顶栏那个拨钮就是它 |
| 展开哪些来源 | 仅 API | `API` 指带 Key 调 `/api/upload` 推来的图，也就是你的截图客户端；在网页里粘贴或拖进来的算 `WEB` |
| 展开自己推送的图 | 关 | 自己从客户端推的图要不要在这块屏幕上展开。一个人用两块屏时才需要打开 |
| 展开时给一声提示 | 关 | 短促的一声，方便在游戏里察觉 |

**只展开你当前所在频道的图。** 切频道的意思就是"我现在只关心这个"，
别的频道有新图时只在频道栏上点个未读，不会抢过来占满屏幕。这条排在所有规则最前面，
别的条件设得再宽也盖不过它。

**你在网页里手动发的图一律不展开**，刚拖进去就在眼前，再弹一次是打扰。这条没有开关。
上面那个"展开自己推送的图"只管客户端推来的。

**还能按人关**：在线名单里，除你自己以外每个名字右边有一个铃铛开关，关掉之后这个人推的图不再自动展开，
消息照常收、照常显示在聊天里。你自己那行没有铃铛，自己的推送归上面那个"展开自己推送的图"管。

人一离线就从名单上消失，所以设置面板里另有一份"单独关掉的人"，可以在那里恢复。
名单会在每次有人上下线时把静音记录里的昵称对齐一遍，免得对方改了名之后两处对不上号。

看图器右上角还有三个开关，和设置面板里的是同一份状态：

| 开关 | 作用 |
| --- | --- |
| 缩放 | 下次打开或收到新图时沿用现在的缩放倍数 |
| 居中 | 沿用缩放时位置回到画面中心；关掉则连上次盯着的位置一起沿用 |
| 自己的 | 同上表的"展开自己推送的图" |

记住的位置存的是**归一化锚点**（画面中心落在图片的哪个位置，0 到 1），不是像素偏移。
视口大小变了、换一张尺寸不同的地图，都能还原到同一个角落。

设置存在浏览器本地（localStorage），跟设备走不跟账号走：游戏机上要弹图、手机上只想看消息，互不干扰。

**查看器的行为**：已经打开时收到新图**不会关窗重开**，而是原地换图；新旧图尺寸一致时保留你当前的缩放与平移。
滚轮缩放、拖拽平移、双击适应窗口、Esc 关闭。

图片占满整个视口，标题栏和提示条以半透明渐变浮在图片之上，所以「适应窗口」拿到的是整屏而不是被控件挤剩下的部分。
标题栏整条不拦截指针，只有里面的按钮可点，图片顶部区域照样能拖。

---

## 保留期与清理

**房间是一个滚动窗口。** 超过 `RETENTION_HOURS`（默认 12）的内容整条消失：
文字、代码块、图片、视频、文件一视同仁，磁盘上的附件同时删掉。
消息流顶部有一条提示说明这件事。

- **到期时间在消息发出那一刻就算好了。** 之后把保留期调短，只影响新消息，
  不会让已有历史当场蒸发。存量消息（升级前发的）没有这个字段，按「创建时间 + 当前配置」兜底。
- 清理任务每 `CLEANUP_INTERVAL_MINUTES` 分钟跑一轮，启动时也会立刻跑一次（覆盖停机期间到期的内容）。
- **先删库再删磁盘。** 库是事实来源；磁盘上删不掉的残留交给孤儿扫描兜底，
  不会出现「库里没了、磁盘还在」之外的第三种状态。
- 在线的客户端会收到 `messages_expired` 事件，页面上对应的消息当场移除，
  连带清掉因此变空的日期分隔线。
- 顺带清理孤儿文件（落盘后入库失败的残留）和过期会话。

> `FILE_RETENTION_HOURS` 已更名为 `RETENTION_HOURS`，因为它现在管的不只是文件。
> 旧名还留在 `.env` 里的话，服务会**拒绝启动**并提示改名，而不是默默退回默认值。

---

## 配置项

全部在 `.env`，非法值会让进程**启动失败**而不是带病运行。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | 监听地址 |
| `DATA_DIR` | `./data` | SQLite 库文件目录 |
| `UPLOAD_DIR` | `./uploads` | 上传文件目录 |
| `ADMIN_USERNAME` | `admin` | 管理员登录名 |
| `ADMIN_PASSWORD` | 空 | 管理员密码，**首次启动前必填** |
| `ALLOW_REGISTRATION` | `false` | 是否开放自助注册 |
| `REGISTRATION_CODE` | 空 | 注册邀请码，仅在开放注册时有意义 |
| `RETENTION_HOURS` | `12` | 保留期。超过这个时长的消息连同附件一起删除 |
| `CLEANUP_INTERVAL_MINUTES` | `10` | 清理任务间隔 |
| `MAX_UPLOAD_MB` | `25` | 单文件大小上限 |
| `HISTORY_LIMIT` | `80` | 首屏加载的历史消息条数 |
| `SESSION_TTL_DAYS` | `30` | 登录会话有效期 |
| `COOKIE_SECURE` | `false` | 用 HTTPS 部署时改成 `true` |
| `UPLOAD_MIN_INTERVAL_MS` | `1000` | 两次上传的最小间隔，挡热键连按。`0` 不限制，只对 API Key 生效 |
| `UPLOAD_RATE_PER_MINUTE` | `30` | 每分钟上传次数上限，挡持续刷屏 |

---

## 部署提示

- **单进程单机**设计：SQLite + 本地磁盘 + 内存限流，不支持多实例横向扩展。按用户规模这是刻意的取舍。
- 放公网请套一层 HTTPS 反向代理（Caddy / Nginx），并把 `COOKIE_SECURE` 改成 `true`。
  代理需要转发 WebSocket 升级头（`Upgrade` / `Connection`）。
- 反代后如果要按真实来源 IP 限流，需要在 `server/app.js` 里开 `app.set('trust proxy', 1)`——
  默认没开，因为在没有可信代理的情况下开启会让限流被伪造的 `X-Forwarded-For` 绕过。
- 备份只需要 `data/`（账号与聊天记录）；`uploads/` 反正 12 小时就清了。

---

## 安全边界

几处是有意设计的，改动前请先理解原因：

- **上传文件按魔数嗅探真实类型**，不信任客户端声明的 Content-Type 和扩展名。
  嗅探不出来的一律归为附件，下发时强制 `application/octet-stream` + `attachment`，杜绝在站内被渲染执行。
- **磁盘文件名是 32 位随机 hex 且不带扩展名**，原始文件名只存库。即使上传目录被误配成静态目录也不会被当脚本解析。
- **鉴权在 multer 之前**：未授权的上传请求不会在磁盘上留下任何东西。
- **CSP 不含 `script-src 'unsafe-inline'`**，前端所有脚本都在独立 `.js` 文件里。
- **前端一律用 `textContent` 渲染用户内容**，没有把用户数据拼进 `innerHTML` 的路径。
- **会话与 API Key 在库里都只存 SHA-256**；密码走 bcrypt；登录失败按 IP 限流。

---

## 目录结构

```
server/
  config.js            环境变量的唯一事实来源，启动时校验
  db.js                SQLite 连接与迁移（PRAGMA user_version）
  app.js               装配 express + 路由 + WebSocket
  index.js             进程入口：引导管理员、监听、优雅退出
  lib/                 机制层：错误语义、Cookie、限流、类型嗅探
  middleware/          策略层：鉴权、同源校验
  routes/              接口层：auth / admin / keys / messages
  services/            领域层：user / session / apikey / file / message / cleanup
                       依赖方向单向：user → session，会话层只认 token 不认用户表
  ws/hub.js            WebSocket 广播中心（单向下行）
public/                网页端，无构建步骤，原生 ES modules
tests/                 端到端回归测试（真实 HTTP + 真实 SQLite）
```

分层约定：`routes` 只做参数搬运与广播编排，业务规则一律在 `services`，
`lib` 里的东西不认识任何业务概念。WebSocket **不接受上行业务消息**——
写入只有 HTTP 这一条路径，校验、限流、事务不会在两套协议里漂移。
