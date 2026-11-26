# MyGO Music 网易云 / QQ 音乐插件：能否换成「音源解析 + 官方回落」

调研日期：2026-11-26
调研范围：MyGO Music 官方插件列表、GitHub 上最活跃的网易云与 QQ 音乐插件源码、LX 音源接口实测。

---

## 结论摘要

1. **最成熟的网易云插件是 `sogud/mygo-music-netease`（127 star）**，其次是 `AkinoKaede/mygo-music-netease-cloud-music`（62 star）。两者都是纯 JS/TS、`"playback": "stream"`、不需要自建 API 服务端，`stream()` 直接返回网易云 CDN 直链。
2. **最成熟的 QQ 音乐插件是 `Amamiya23/mygo-music-qq-plugin`（12 star）**，同样 `"playback": "stream"`、直连 `u.y.qq.com`，`stream()` 用 songmid 换 vkey 得到直链。
3. **ID 天然对齐**：网易云插件的 `stream({id})` 收到的是数字 songId（插件内部 `trackIdentity` 直接返回数字），QQ 插件收到的就是 songmid 字符串。LX 音源接口的 `source=wy` 要数字 id、`source=tx` 要 songmid，**两者与插件现有 ID 完全一致，无需任何映射**。
4. **LX 接口实测可用**：`source=wy` 与 `source=tx` 均返回 `code=200` 且直链可解码（wy 为 FLAC/MP3，tx 为 FLAC/OGG 容器但返回 `audio/x-ogg`）。因此「LX 解析 + 官方回落」在技术上成立。
5. **主要风险不是 ID，而是会员权限与降档判定**：LX 接口在会员曲目上会直接返回 HTTP 500（实测 `wy/186016`《七里香》三档全 500），而不是 `code=500`；此外 tx 的 flac 直链 `Content-Type` 是 `audio/x-ogg`，按 MIME 判容器会误判。
6. **推荐做法**：只把「取直链」这一段替换，保留插件原有登录、歌单、歌词、封面逻辑；失败静默回落原 `stream()` 实现。这与汽水插件（开工卡 0002）的结构一致。

---

## 1. 候选插件清单与 star

来源：官方插件列表 <https://music.egoist.dev/zh/plugins>、GitHub 搜索 API（`mygo-music in:name`，按 star 排序）。

### 网易云音乐

| 仓库 | Star | 语言 | 最近推送 | 说明 |
| --- | --- | --- | --- | --- |
| [sogud/mygo-music-netease](https://github.com/sogud/mygo-music-netease) | 127 | JavaScript | 2026-11-19 | 网抑云：搜索、歌单、歌词、扫码登录；无额外服务 |
| [AkinoKaede/mygo-music-netease-cloud-music](https://github.com/AkinoKaede/mygo-music-netease-cloud-music) | 62 | TypeScript | 2026-11-20 | 纯 TS 实现，构建后单文件 |
| [SixWa12138/mygo-music-netease-music](https://github.com/SixWa12138/mygo-music-netease-music) | 21 | JavaScript | 2026-11-09 | 含云盘、播客；部分功能需补丁版 MyGo |
| [hubandad/mygo-music-netease](https://github.com/hubandad/mygo-music-netease) | 16 | JavaScript | 2026-11-06 | 无需额外 API 服务 |
| [VenusLuna/mygo-music-netease-plus](https://github.com/VenusLuna/mygo-music-netease-plus) | 4 | JavaScript | 2026-11-12 | 网易云音乐 Plus，功能最全但 star 低 |

### QQ 音乐

| 仓库 | Star | 语言 | 最近推送 | 说明 |
| --- | --- | --- | --- | --- |
| [Amamiya23/mygo-music-qq-plugin](https://github.com/Amamiya23/mygo-music-qq-plugin) | 12 | JavaScript | 2026-11-10 | QQ/微信扫码登录、无损播放 |
| [Lorpaves/mygo-music-qqmusic](https://github.com/Lorpaves/mygo-music-qqmusic) | 5 | JavaScript | 2026-11-14 | 微信扫码、歌单、歌词、无损 |
| [Guyu23/mygo-music-qqmusic](https://github.com/Guyu23/mygo-music-qqmusic) | 1 | JavaScript | 2026-11-07 | QQ 扫码登录 |

> star 数为 2026-11-26 通过 GitHub API 读取的实际值。

---

## 2. 实际读过的源码

| 文件 | 仓库 | 用途 |
| --- | --- | --- |
| `plugin.json` | AkinoKaede | 权限、`playback`、设置项 |
| `src/playback.ts` | AkinoKaede | `stream()` 与 `lyrics()` 实现 |
| `src/constants.ts` | AkinoKaede | 音质档位、UA、站点地址 |
| `plugin.json` | sogud | 权限、`minAppVersion` |
| `index.js`（50 KB） | sogud | `stream()` / `loadStream()` / `lyrics()` |
| `plugin.json` | Amamiya23 | 网络权限、登录方式设置 |
| `index.js`（72 KB） | Amamiya23 | `stream()`、vkey 取地址、歌词 |
| `README.md` | sogud / Amamiya23 | 功能与限制声明 |

---

## 3. 三个插件的播放实现

### 3.1 sogud/mygo-music-netease

`plugin.json`：

```json
{
  "id": "netease",
  "minAppVersion": "0.1.21",
  "playback": "stream",
  "permissions": { "network": ["music.163.com", "interfacepc.music.163.com"] }
}
```

`index.js` 的 `loadStream()` 关键逻辑：

- 档位映射：`standard→standard`、`high→exhigh`、`lossless→lossless`
- 请求 `eapi("/api/song/enhance/player/url/v1", { ids: [id], level, encodeType })`
- 遇到 `-460`（风控）**延迟 1 秒重试一次**，第二次仍失败就抛出，不降档
- 拒绝条件：无 `url`、`code !== 200`、`freeTrialInfo != null`
- **地址白名单**：`url.hostname` 必须匹配 `^(?:[a-z0-9-]+\.)*music\.126\.net$`，否则 `unavailable`
- 返回 `{ url, type, size, bitRate, quality, gain, peak, headers: { UA, Referer } }`

源码注释明确写着：*"Never retry account mutations or turn permission failures into a different source, a preview, or a lower-quality success."*

### 3.2 AkinoKaede/mygo-music-netease-cloud-music

`stream()` 更简洁：

- 档位：`host.setting("quality")` 优先，否则 `high→exhigh`
- 先试 v1 端点，失败（`transient`）才退到旧端点 `br=` 参数
- 同样拒绝 `freeTrialInfo != null`
- 校验 `https:` 协议
- 返回 `type`、`quality`（用 `item.level` 原值回填）

两者结构几乎相同，说明网易云插件的播放段是高度标准化的，替换点非常明确。

### 3.3 Amamiya23/mygo-music-qq-plugin

`stream({ id, quality })` 的 `id` 就是 **songmid**：

```js
const detail = await rpc("music.pf_song_detail_svr", "get_song_detail_yqq", { song_mid: id })
const media = t.file?.media_mid || t.strMediaMid || t.media_mid || id
const qualities = [{ prefix: "M500", type: "mp3", quality: "standard" }]
if (session && (quality === "high" || quality === "lossless")) qualities.unshift({ prefix: "M800", type: "mp3", quality: "high" })
if (session && quality === "lossless") qualities.unshift({ prefix: "F000", type: "flac", quality: "lossless" })
```

- 未登录只能用 `M500`（128k）
- 登录后才尝试 `M800`（320k）与 `F000`（flac）
- 逐档尝试，第一个拿到 `purl` 的就返回
- 返回 `{ url, type, quality, size, gain, peak, headers }`

README 明确：「歌曲能否完整播放由 QQ 音乐的版权、账号及地区限制决定，插件不会绕过权限。」

---

## 4. LX 音源对 wy / tx 的支持（实测）

接口：`GET https://source.shiqianjiang.cn/api/music/url?source=<wy|tx>&songId=<id>&quality=<128k|320k|flac>`，头 `X-API-Key`。

### 4.1 ID 形态

| 平台 | 插件里的 ID | LX 接口要的 ID | 是否一致 |
| --- | --- | --- | --- |
| 网易云 | 数字 songId（如 `347230`） | 数字 songId | **一致** |
| QQ 音乐 | songmid（如 `0039MnYb0qxYhV`） | songmid | **一致** |

### 4.2 实测结果（2026-11-26）

| 平台 | songId | 请求档位 | HTTP | code | 直链主机 | 容器魔数 |
| --- | --- | --- | --- | --- | --- | --- |
| wy | 347230 | 128k | 200 | 200 | m701.music.126.net | — |
| wy | 347230 | 320k | 200 | 200 | m801.music.126.net | `ID3`（MP3） |
| wy | 347230 | flac | 200 | 200 | m801.music.126.net | `fLaC`（FLAC） |
| tx | 0039MnYb0qxYhV | 128k | 200 | 200 | aqqmusic.tc.qq.com | — |
| tx | 0039MnYb0qxYhV | 320k | 200 | 200 | aqqmusic.tc.qq.com | `ID3`（MP3） |
| tx | 0039MnYb0qxYhV | flac | 200 | 200 | aqqmusic.tc.qq.com | `fLaC`（FLAC） |

抽样 7 首网易云曲目请求 `flac`，全部返回真实 `fLaC` 容器，未出现静默降档。

### 4.3 两个必须处理的差异

**（1）会员曲目失败是 HTTP 500，不是 `code=500`**

实测 `wy/186016`（周杰伦《七里香》）三档全部返回：

```
HTTP 500
{"code":500,"message":"local responded with status 500 or no URL"}
```

而汽水插件（0002）目前的实现是：`reply.status !== 200` 抛错 → 回落。这个分支能覆盖，但日志只能记 `failure`，无法区分「会员无权限」与「服务挂了」。

**（2）tx 的 flac 直链 `Content-Type` 是 `audio/x-ogg`**

```
tx/flac -> Content-Type: audio/x-ogg  len=55397039
wy/flac -> Content-Type: audio/mpeg    len=32511640
```

网易云连 flac 也报 `audio/mpeg`。**按 MIME 判容器会全错**，只能靠魔数或按请求档位回填。

---

## 5. 可行性结论

### 5.1 结构上成立

三个插件都是 `"playback": "stream"`，`stream()` 是唯一需要改的函数。改造方式与汽水插件完全一致：

```
stream({ id, quality })
  ├─ 开关开启且脚本可用？
  │   ├─ 是 → GET {API_URL}/music/url?source=wy|tx&songId=id&quality=…
  │   │        ├─ 成功且地址合规 → 返回 { url, type, quality }
  │   │        └─ 任一失败 → 回落原实现
  │   └─ 否 → 原实现
  └─ 原实现（登录 + 官方接口 + 会员校验）
```

### 5.2 需要改的地方（按插件）

| 插件 | 改动点 | 说明 |
| --- | --- | --- |
| sogud | `loadStream()` 前插一层 | 它已有 `pendingStreams` 合并逻辑，新分支要放在合并之外还是之内需要决策 |
| AkinoKaede | `stream()` 前插一层 | 结构最干净，改动最小 |
| Amamiya23 | `stream()` 前插一层 | 需要额外传 `source=tx`；它已有多档尝试逻辑 |

### 5.3 主要风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 会员/VIP 权限 | LX 接口在会员曲目上直接 500，可能拿到别人账号的直链 | 这是**预期收益**也是**预期争议点**：等于绕过会员限制。需负责人明确这是否是目的 |
| 服务稳定性 | 单点第三方服务，挂了就回落 | 已有回落语义，可接受 |
| 容器判定 | MIME 不可信，tx flac 报 `audio/x-ogg` | 沿用汽水的三级判定：响应字段 > 扩展名 > 请求档位 |
| 地址白名单冲突 | sogud 现在只允许 `music.126.net` | 换成音源直链后白名单必须放宽或跳过 |
| 歌词/封面 | 不走 `stream()`，不受影响 | 无需改动 |
| 登录态 | 音源分支不需要账号 | 但插件仍要求登录才能进主界面 |

### 5.4 一个需要负责人拍板的问题

**会员曲目**：LX 接口能拿到会员曲目的完整直链（实测《平凡之路》flac 302 秒完整）。这意味着非会员也能听 VIP 歌。

- 如果这是目的 → 改造有价值，且与汽水插件的「外部音源」定位一致。
- 如果这不是目的 → 应当在音源分支里**主动拒绝**会员曲目，只对免费曲目生效，否则等于帮用户绕过付费。

---

## 6. 未验证 / 未获取

- **未验证**：LX 接口对「地区限制」「下架」「试听片段」的处理，只测了正常曲目与一首 500 的会员曲目。
- **未验证**：QQ 音乐 songmid 与 LX 脚本 `tx` 音源是否对所有曲目一一对应；只抽样 4 首。
- **未获取**：`sogud` 与 `Amamiya23` 的完整测试文件（GitHub API 限流，只读了主源码）。
- **未获取**：`VenusLuna/mygo-music-netease-plus` 源码（star 低，功能描述最全，但未深入）。
- **未验证**：三个插件在音源分支介入后，`played()` 上报、`size` 字段、seek 行为是否受影响。

---

## 7. 建议的下一步

1. 负责人确认第 5.4 节的「会员曲目」定位。
2. 选定一个插件先做（建议 `AkinoKaede` 或 `sogud`，结构最干净）。
3. 复用汽水插件 0002 的 `helper/external-source.mjs`：`parseScript`、`loadScript`、`assertSafeURL` 可原样搬，只需把 `source` 从 `qs` 参数化。
4. 按开工卡流程写 0003，包含会员曲目策略、容器判定、白名单放宽的测试草稿。
